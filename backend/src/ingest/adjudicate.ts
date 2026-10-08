import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonResponse } from "../llm/client.js";
import type { RfxLine } from "../schemas.js";
import { cleanSnippet, locatorFor, num, passAUser, rfxContext, text, type PassADocument, type PassAOptions, type PassATrace } from "./extract_a.js";
import { RowSchema, type Row } from "./extraction.js";
import { screenInjection } from "./injection.js";
import type { Quote, Reading } from "./quotes.js";

/**
 * The adjudicator (spec 10.6 step 2, 11.4). Runs only on disputed lines: the passes disagree, or only one found an
 * offer. One call per document covers all its disputed lines. It may pick a reading, give a third one, say there is
 * no offer, or say it cannot tell. It never raises confidence by itself: a resolved line is HIGH_CONF at best, every
 * other rule still applies, and a third reading goes through the same provenance check as the passes' rows.
 */

export type AdjudicationDecision = "A" | "B" | "THIRD" | "NO_OFFER" | "UNRESOLVED";

export interface Adjudication {
  line_id: string;
  decision: AdjudicationDecision;
  reasoning: string;
  /** For THIRD only: the adjudicator's own reading, as a row to be verified like any other. */
  row: Row | null;
  model: string | null;
}

const PROMPTS = fileURLToPath(new URL("../../../prompts/", import.meta.url));

export function loadAdjudicatorPrompt(): { text: string; version: string } {
  const t = `${readFileSync(`${PROMPTS}adjudicate.md`, "utf8")}\n${readFileSync(`${PROMPTS}conventions.md`, "utf8")}`;
  return { text: t, version: `adjudicate@${createHash("sha256").update(t).digest("hex").slice(0, 8)}` };
}

const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const ADJUDICATE_SCHEMA = obj({
  decisions: {
    type: "array",
    items: obj({
      line_id: str,
      decision: { type: "string", enum: ["A", "B", "THIRD", "NO_OFFER", "UNRESOLVED"] },
      reasoning: str,
      rate_as_written: str,
      currency: str,
      unit_as_written: str,
      carried_over: str,
      snippet: str,
      locator: str,
    }),
  },
});

export interface Dispute {
  line: RfxLine;
  readings: Reading[];
}

/** The lines a built set of quotes leaves disputed. */
export function disputesOf(quotes: readonly Quote[], lines: readonly RfxLine[]): Dispute[] {
  return quotes
    .filter((q) => q.reconciliation && ["disagree", "a_only", "b_only"].includes(q.reconciliation.status))
    .map((q) => ({ line: lines.find((l) => l.line_id === q.line_id) as RfxLine, readings: q.reconciliation!.readings }));
}

function disputeText(d: Dispute): string {
  const missing = (["A", "B"] as const).filter((p) => !d.readings.some((r) => r.pass === p));
  const readings = d.readings.map((r) => `  Reading ${r.pass}: ${r.currency} ${r.value ?? "?"} ${r.unit ?? "(no unit)"}; snippet "${r.snippet}"`);
  return [
    `Line ${d.line.line_id}: ${d.line.description}; ${d.line.spec.dims_text}; priced per ${d.line.base_uom}.`,
    ...readings,
    ...missing.map((p) => `  Reading ${p}: found no offer for this line.`),
  ].join("\n");
}

export interface AdjudicatorResult {
  adjudications: Adjudication[];
  errors: string[];
  trace: Omit<PassATrace, "step"> & { step: "adjudicate" };
}

export function toAdjudications(json: Record<string, unknown>, disputes: readonly Dispute[], doc: PassADocument, model: string | null): Adjudication[] {
  const wanted = new Set(disputes.map((d) => d.line.line_id));
  const out: Adjudication[] = [];
  for (const d of json.decisions as Record<string, unknown>[]) {
    const line_id = d.line_id as string;
    if (!wanted.has(line_id) || out.some((x) => x.line_id === line_id)) continue; // only lines that were asked, once each
    let decision = d.decision as AdjudicationDecision;
    let row: Row | null = null;
    if (decision === "THIRD") {
      const snippet = cleanSnippet(d.snippet as string);
      const parsed = RowSchema.safeParse({
        row_id: `ADJ-${line_id}`,
        raw_text: snippet,
        mapped_line_candidates: [{ line_id, match_confidence: 1, reasons: ["adjudicator"] }],
        rate: { value: num(d.rate_as_written), currency: text(d.currency) ?? "", unit_as_written: text(d.unit_as_written) },
        carried_over: [...new Set(String(d.carried_over ?? "").toLowerCase().match(/\b(unit|currency)\b/g) ?? [])],
        locator: locatorFor(d.locator as string, snippet, doc),
        snippet,
      });
      if (parsed.success) row = parsed.data;
      else decision = "UNRESOLVED";
    }
    // A pick of a reading that does not exist is no decision at all.
    const dispute = disputes.find((x) => x.line.line_id === line_id) as Dispute;
    if ((decision === "A" || decision === "B") && !dispute.readings.some((r) => r.pass === decision)) decision = "UNRESOLVED";
    out.push({ line_id, decision, reasoning: String(d.reasoning ?? ""), row, model });
  }
  return out;
}

export async function runAdjudicator(doc: PassADocument, disputes: readonly Dispute[], opts: PassAOptions): Promise<AdjudicatorResult> {
  const prompt = loadAdjudicatorPrompt();
  const model = opts.config.models.adjudicator;
  const trace = (res: JsonResponse | null): AdjudicatorResult["trace"] => ({
    step: "adjudicate",
    vendor_id: doc.vendor_id,
    prompt_version: prompt.version,
    model_requested: model,
    model_used: res?.model ?? null,
    fallback_used: res?.fallback_used ?? false,
    stop_reason: res?.stop_reason ?? null,
    usage: res?.usage ?? null,
    cost_usd: res?.cost_usd ?? null,
    ms: res?.ms ?? 0,
    at: (opts.now ?? (() => new Date()))().toISOString(),
  });
  if (disputes.length === 0) return { adjudications: [], errors: [], trace: trace(null) };

  const screen = screenInjection(doc.text);
  const task = [`Disputed lines in this ${doc.kind} document from vendor ${doc.vendor_id}:`, ...disputes.map(disputeText)].join("\n");
  let res: JsonResponse;
  try {
    res = await opts.client.json({
      model,
      context: rfxContext(opts.lines, opts.questions),
      instructions: prompt.text,
      images: doc.images?.map(({ media_type, data }) => ({ media_type, data })),
      user: passAUser(doc, screen.clean_text, task),
      schema: ADJUDICATE_SCHEMA,
      effort: opts.effort ?? "high", // few lines, and the ones that matter most
      max_tokens: 16000,
    });
  } catch (err) {
    return { adjudications: [], errors: [`call failed: ${(err as Error).message}`], trace: trace(null) };
  }
  if (res.stop_reason === "refusal") return { adjudications: [], errors: ["the model declined"], trace: trace(res) };
  if (res.text === null || res.stop_reason === "max_tokens") return { adjudications: [], errors: ["no complete output"], trace: trace(res) };
  try {
    return { adjudications: toAdjudications(JSON.parse(res.text), disputes, doc, res.model), errors: [], trace: trace(res) };
  } catch (err) {
    return { adjudications: [], errors: [(err as Error).message], trace: trace(res) };
  }
}
