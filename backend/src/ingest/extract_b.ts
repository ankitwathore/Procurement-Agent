import type { JsonResponse } from "../llm/client.js";
import { ExtractionSchema, type Extraction } from "./extraction.js";
import { cleanSnippet, loadPrompt, locatorFor, num, passAUser, rfxContext, text, type PassADocument, type PassAOptions, type PassATrace } from "./extract_a.js";
import { screenInjection } from "./injection.js";

/**
 * Extraction pass B, RFx first (spec 10.5, 11.3, D18). For each RFx line: did the vendor offer it, and at what?
 * It never sees pass A's output, so the two readings fail independently and their agreement means something.
 * Pass B produces rows only; terms, extras and the questionnaire come from pass A.
 */

const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const PASS_B_SCHEMA = obj({
  lines: {
    type: "array",
    items: obj({
      line_id: str,
      // "unreadable": the vendor visibly quoted this line, but its price cannot be read. Never the same as not offered.
      status: { type: "string", enum: ["priced", "not_offered", "unreadable"] },
      rate_as_written: str,
      currency: str,
      unit_as_written: str,
      carried_over: str,
      line_total_as_written: str,
      ply: str,
      liner_gsm: str,
      bf: str,
      dims: str,
      print: str,
      struck_out_or_overwritten: { type: "boolean" },
      legibility: { type: "number" },
      snippet: str,
      locator: str,
      assumptions: { type: "array", items: str },
      not_found_reason: str,
    }),
  },
  notes: { type: "array", items: str },
});

type Raw = Record<string, unknown>;

/**
 * Pass B's answer as the extraction contract: one row per line it priced, and a row with no rate for each line it
 * saw but could not read (so that line goes to review, not to "not quoted"). Nothing for lines not offered.
 */
export function passBToExtraction(json: Raw, doc: PassADocument): Extraction {
  const rows = (json.lines as Raw[])
    .filter((l) => l.status === "priced" || l.status === "unreadable" || l.found === true)
    .map((l) => {
      const unreadable = l.status === "unreadable";
      const snippet = cleanSnippet(l.snippet as string);
      const spec_offered: Raw = {};
      for (const k of ["ply", "liner_gsm", "bf"] as const) {
        const n = num(l[k]);
        if (n !== null) spec_offered[k] = n;
      }
      const dims = text(l.dims);
      if (dims) spec_offered.dims_mm = (dims.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      const print = text(l.print);
      if (print) spec_offered.print = print;
      return {
        row_id: `B-${l.line_id as string}`,
        raw_text: unreadable ? `${snippet} (unreadable: ${String(l.not_found_reason ?? "")})` : snippet,
        mapped_line_candidates: [{ line_id: l.line_id, match_confidence: 1, reasons: [unreadable ? "pass B: the line is there, its price cannot be read" : "pass B: searched for this RFx line"] }],
        rate: { value: unreadable ? null : num(l.rate_as_written), currency: text(l.currency) ?? "", unit_as_written: text(l.unit_as_written) },
        line_total_as_written: num(l.line_total_as_written),
        spec_offered: Object.keys(spec_offered).length ? spec_offered : null,
        struck_out_or_overwritten: l.struck_out_or_overwritten,
        carried_over: [...new Set(String(l.carried_over ?? "").toLowerCase().match(/\b(unit|currency)\b/g) ?? [])],
        legibility: unreadable ? Math.min(0.2, Math.max(0, l.legibility as number)) : Math.min(1, Math.max(0, l.legibility as number)),
        locator: locatorFor(l.locator as string, snippet, doc),
        snippet,
        assumptions: l.assumptions,
      };
    });
  const parsed = ExtractionSchema.safeParse({ vendor_terms: {}, rows, notes: json.notes });
  if (!parsed.success) throw new Error(`pass B output does not fit the extraction contract: ${parsed.error.message}`);
  return parsed.data;
}

export interface PassBResult {
  extraction: Extraction | null;
  notes: string[];
  errors: string[];
  trace: Omit<PassATrace, "step"> & { step: "extract_b" };
}

export async function runPassB(doc: PassADocument, opts: PassAOptions): Promise<PassBResult> {
  const prompt = loadPrompt("extract_b");
  const screen = screenInjection(doc.text);
  const model = opts.config.models.extract_b;
  const trace = (res: JsonResponse | null): PassBResult["trace"] => ({
    step: "extract_b",
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

  let res: JsonResponse;
  try {
    res = await opts.client.json({
      model,
      context: rfxContext(opts.lines, opts.questions),
      instructions: prompt.text,
      images: doc.images?.map(({ media_type, data }) => ({ media_type, data })),
      user: passAUser(doc, screen.clean_text, `Check each RFx line against this ${doc.kind} document from vendor ${doc.vendor_id}.`),
      schema: PASS_B_SCHEMA,
      effort: opts.effort ?? "medium",
      max_tokens: 32000,
    });
  } catch (err) {
    return { extraction: null, notes: [], errors: [`call failed: ${(err as Error).message}`], trace: trace(null) };
  }

  const errors: string[] = [];
  if (res.stop_reason === "refusal") errors.push("the model declined this document");
  if (res.stop_reason === "max_tokens") errors.push("output was cut off at max_tokens");
  if (res.text === null || errors.length > 0) return { extraction: null, notes: [], errors: errors.length ? errors : ["no output"], trace: trace(res) };
  try {
    const json = JSON.parse(res.text) as Raw;
    return { extraction: passBToExtraction(json, doc), notes: json.notes as string[], errors, trace: trace(res) };
  } catch (err) {
    return { extraction: null, notes: [], errors: [(err as Error).message], trace: trace(res) };
  }
}
