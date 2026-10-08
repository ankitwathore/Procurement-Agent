import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { JsonResponse, LlmClient } from "../llm/client.js";
import { parseNumber } from "../normalize/parse.js";
import type { Question, RfxLine } from "../schemas.js";
import { ExtractionSchema, type Extraction } from "./extraction.js";
import { screenInjection, type InjectionFinding } from "./injection.js";

/**
 * Extraction pass A, document first (spec 10.4, 11.2). One structured-output call per document. The model reports
 * what is written; code then parses numbers, verifies every locator (validateRows), converts, checks and assigns
 * states. Vendor text is screened for AI-directed instructions before the call and wrapped as untrusted data.
 */

export type DocKind = "xlsx" | "pdf" | "docx" | "email" | "image";

const PROMPTS = fileURLToPath(new URL("../../../prompts/", import.meta.url));

/** A pass's own prompt followed by the conventions both passes share, versioned by the content of both. */
export function loadPrompt(name: "extract_a" | "extract_b"): { text: string; version: string } {
  const text = `${readFileSync(`${PROMPTS}${name}.md`, "utf8")}\n${readFileSync(`${PROMPTS}conventions.md`, "utf8")}`;
  return { text, version: `${name}@${createHash("sha256").update(text).digest("hex").slice(0, 8)}` };
}

export const loadPassAPrompt = () => loadPrompt("extract_a");

// ---- The model-facing schema. Structured outputs compile the schema into a grammar with size and union limits,
// ---- so it is deliberately flat: no unions, no nested locator or spec objects, one list for all terms.
// ---- Values come back as text exactly as written ("" when not stated) and code parses them.

const str = { type: "string" };
const strs = { type: "array", items: str };
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const TERM_KINDS = ["freight_basis", "gst_basis", "validity", "fx_clause", "conditional_discount", "lines_not_quoted_statement"] as const;

export const PASS_A_SCHEMA = obj({
  terms: {
    type: "array",
    items: obj({
      kind: { type: "string", enum: [...TERM_KINDS] },
      value: str,
      text: str,
      amount: str,
      threshold_text: str,
      threshold_inclusive: { type: "boolean" },
      valid_until: str,
      from_date: str,
      snippet: str,
      locator: str,
    }),
  },
  rows: {
    type: "array",
    items: obj({
      line_id: str,
      match_confidence: { type: "number" },
      match_reasons: str,
      raw_text: str,
      rate_as_written: str,
      currency: str,
      unit_as_written: str,
      line_total_as_written: str,
      ply: str,
      liner_gsm: str,
      bf: str,
      dims: str,
      print: str,
      struck_out_or_overwritten: { type: "boolean" },
      carried_over: str,
      legibility: { type: "number" },
      snippet: str,
      locator: str,
      assumptions: strs,
    }),
  },
  extras: {
    type: "array",
    items: obj({ description: str, related_line_id: str, rate_as_written: str, currency: str, unit_as_written: str, snippet: str, locator: str }),
  },
  questionnaire: { type: "array", items: obj({ q_id: str, answer_raw: str, snippet: str }) },
  // A row the vendor quoted whose price cannot be read: with its line, code turns it into a row in review.
  unreadable_regions: { type: "array", items: obj({ line_id: str, description: str, snippet: str, locator: str }) },
  notes: strs,
});

// ---- Request

/** The RFx as stable JSON, so the cached prefix is byte-identical across calls. */
export function rfxContext(lines: readonly RfxLine[], questions: readonly Question[]): string {
  const view = {
    lines: lines.map((l) => ({
      line_id: l.line_id,
      description: l.description,
      spec: l.spec,
      base_uom: l.base_uom,
      annual_qty: l.annual_qty,
      conversion_hints: l.conversion_hints,
    })),
    questionnaire: questions.map((q) => ({ q_id: q.q_id, text: q.text, type: q.type })),
  };
  return `<rfx>\n${JSON.stringify(view)}\n</rfx>`;
}

export interface PassADocument {
  vendor_id: string;
  kind: DocKind;
  /** The parsed document as text (parser output: grid, page lines, paragraphs, or the email body). */
  text: string;
  /** For email: where quoted history begins, used to place snippets. */
  authoritative_end?: number;
  message_id?: string | null;
  /** For a photographed quote: the image itself. `text` is then the email it came with. */
  images?: { media_type: "image/jpeg" | "image/png"; data: string; name: string }[];
}

export function passAUser(doc: PassADocument, cleanText: string, task = `Extract the quotes from this ${doc.kind} document from vendor ${doc.vendor_id}.`): string {
  return [
    task,
    ...(doc.kind === "image" ? [`The quotation is the attached photo (${doc.images?.map((i) => i.name).join(", ")}). The text below is the email it came with; use its locator "" convention for anything taken from the email text.`] : []),
    `<vendor_document kind="${doc.kind}">`,
    cleanText,
    "</vendor_document>",
  ].join("\n");
}

// ---- Response mapping

type Raw = Record<string, unknown>;

/** Snippets sometimes carry this view's own markers; they are not document text. */
export function cleanSnippet(s: string): string {
  return s
    .replace(/^\s*\[(?:SMALL TEXT [\d.]+pt|P\d+|T\d+ R\d+|HEADER|FOOTER)\]\s*/, "")
    .replace(/^\s*[^\s!]+!row\d+(?: \[HIDDEN ROW\])?:\s*/, "")
    .trim();
}

/** Parses a locator reference. Anything it cannot read leaves only the type, which the provenance check rejects. */
export function parseRef(type: DocKind, ref: string): Record<string, unknown> {
  const r = ref.trim();
  if (type === "xlsx") {
    const m = /^'?([^'!]+)'?!\$?([A-Z]{1,3})\$?(\d+)$/.exec(r);
    return m ? { type, sheet: m[1], cell: `${m[2]}${m[3]}` } : { type };
  }
  if (type === "pdf") {
    const m = /^(?:page\s*|p\.?\s*)?(\d+)$/i.exec(r);
    return m ? { type, page: Number(m[1]) } : { type };
  }
  if (type === "image") {
    // "row 12 box 0.74 0.48 0.81 0.51": the row number printed on the photo, the rate cell as fractions of the image.
    const row = /\brow\s*(\d+)/i.exec(r);
    const box = /\bbox\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(r);
    const out: Record<string, unknown> = { type };
    if (row) out.row = Number(row[1]);
    if (box) out.box = box.slice(1, 5).map(Number);
    return out;
  }
  if (type === "docx") {
    const p = /^\[?P(\d+)\]?$/i.exec(r);
    if (p) return { type, paragraph_idx: Number(p[1]) };
    const t = /^\[?T(\d+)\s*R(\d+)\]?$/i.exec(r);
    return t ? { type, table_idx: Number(t[1]), row: Number(t[2]) } : { type };
  }
  return { type };
}

export function locatorFor(ref: string, snippet: string, doc: PassADocument): Record<string, unknown> {
  const out = parseRef(doc.kind, ref);
  if (doc.kind === "email") {
    // Code, not the model, places the span: in the new message first, then anywhere (the provenance check then
    // rejects a span that lies in quoted history).
    const end = doc.authoritative_end ?? doc.text.length;
    let start = doc.text.slice(0, end).indexOf(snippet);
    if (start < 0) start = doc.text.indexOf(snippet);
    if (start >= 0) {
      out.char_start = start;
      out.char_end = start + snippet.length;
    }
    if (doc.message_id) out.message_id = doc.message_id;
  }
  if (doc.kind === "image" && doc.images?.[0]) out.file = doc.images[0].name;
  return out;
}

/** "" means not stated. */
export const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Numbers are parsed by code from text as written ("18,09,879.50", "USD 1.53", "1.2 lakh"). */
export function num(v: unknown): number | null {
  const t = text(v);
  if (t === null) return null;
  try {
    return parseNumber(t.replace(/^(?:usd|inr|rs\.?|₹|\$)\s*/i, ""));
  } catch {
    return null;
  }
}

/** The first term of a kind, as the contract's term object; undefined when the document did not state it. */
function termOf(terms: Raw[], kind: string, doc: PassADocument, fields: (t: Raw) => Raw): Raw | undefined {
  const t = terms.find((x) => x.kind === kind);
  return t ? termObject(t, doc, fields) : undefined;
}

function termObject(t: Raw, doc: PassADocument, fields: (t: Raw) => Raw): Raw {
  const snippet = cleanSnippet(t.snippet as string);
  const out: Raw = { snippet, locator: locatorFor(t.locator as string, snippet, doc) };
  for (const [k, v] of Object.entries(fields(t))) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export interface PassAResult {
  extraction: Extraction | null;
  questionnaire: { q_id: string; answer_raw: string; snippet: string }[];
  unreadable_regions: { line_id?: string | null; description: string; locator: Record<string, unknown> }[];
  notes: string[];
  injection: InjectionFinding[];
  errors: string[];
  trace: PassATrace;
}

export interface PassATrace {
  step: "extract_a";
  vendor_id: string;
  prompt_version: string;
  model_requested: string;
  model_used: string | null;
  fallback_used: boolean;
  stop_reason: string | null;
  usage: JsonResponse["usage"] | null;
  cost_usd: number | null;
  ms: number;
  at: string;
}

/** Turns the model's JSON into the app's extraction contract. Throws with a readable message if it does not fit. */
export function toExtraction(json: Raw, doc: PassADocument): Extraction {
  const terms = json.terms as Raw[];
  const rows = (json.rows as Raw[]).map((r, i) => {
    const snippet = cleanSnippet(r.snippet as string);
    const spec_offered: Raw = {};
    for (const k of ["ply", "liner_gsm", "bf"] as const) {
      const n = num(r[k]);
      if (n !== null) spec_offered[k] = n;
    }
    const dims = text(r.dims);
    if (dims) spec_offered.dims_mm = (dims.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    const print = text(r.print);
    if (print) spec_offered.print = print;
    return {
      row_id: `A${i + 1}`,
      raw_text: r.raw_text,
      mapped_line_candidates: [
        {
          line_id: r.line_id,
          match_confidence: Math.min(1, Math.max(0, r.match_confidence as number)),
          reasons: text(r.match_reasons) ? [r.match_reasons] : [],
        },
      ],
      rate: { value: num(r.rate_as_written), currency: text(r.currency) ?? "", unit_as_written: text(r.unit_as_written) },
      line_total_as_written: num(r.line_total_as_written),
      spec_offered: Object.keys(spec_offered).length ? spec_offered : null,
      struck_out_or_overwritten: r.struck_out_or_overwritten,
      carried_over: [...new Set(String(r.carried_over ?? "").toLowerCase().match(/\b(unit|currency)\b/g) ?? [])],
      legibility: Math.min(1, Math.max(0, r.legibility as number)),
      locator: locatorFor(r.locator as string, snippet, doc),
      snippet,
      assumptions: r.assumptions,
    };
  });
  // Lines the vendor visibly quoted but whose price cannot be read: a row with no rate, so the line goes to review
  // ("unreadable"), never to "not quoted". Only where pass A gave no row of its own for that line.
  const covered = new Set(rows.map((r) => r.mapped_line_candidates[0]!.line_id));
  ((json.unreadable_regions as Raw[]) ?? []).forEach((u, i) => {
    const id = text(u.line_id);
    if (!id || covered.has(id)) return;
    covered.add(id);
    const snippet = cleanSnippet((text(u.snippet) ?? "") as string);
    rows.push({
      row_id: `A-U${i + 1}`,
      raw_text: `${snippet} (unreadable: ${String(u.description ?? "")})`,
      mapped_line_candidates: [{ line_id: id, match_confidence: 0.7, reasons: ["the line is there, its price cannot be read"] }],
      rate: { value: null, currency: "", unit_as_written: null },
      line_total_as_written: null,
      spec_offered: null,
      struck_out_or_overwritten: false,
      carried_over: [],
      legibility: 0.1,
      locator: locatorFor(u.locator as string, snippet, doc),
      snippet,
      assumptions: [],
    });
  });
  const extras = ((json.extras as Raw[]) ?? []).map((x) => {
    const snippet = cleanSnippet(x.snippet as string);
    return {
      description: x.description,
      rate: { value: num(x.rate_as_written), currency: text(x.currency) ?? "", unit_as_written: text(x.unit_as_written) },
      related_line_id: text(x.related_line_id),
      snippet,
      locator: locatorFor(x.locator as string, snippet, doc),
    };
  });
  const parsed = ExtractionSchema.safeParse({
    vendor_terms: {
      freight_basis: termOf(terms, "freight_basis", doc, (t) => ({ value: text(t.value) ?? "unstated" })),
      gst_basis: termOf(terms, "gst_basis", doc, (t) => ({ value: text(t.value) ?? "unstated", rate_pct: num(t.amount) })),
      validity: termOf(terms, "validity", doc, (t) => ({ value_text: t.text, valid_until: text(t.valid_until), from_date: text(t.from_date), valid_days: num(t.amount) })),
      fx_clause: termOf(terms, "fx_clause", doc, (t) => ({ value_text: t.text })),
      lines_not_quoted_statement: termOf(terms, "lines_not_quoted_statement", doc, (t) => ({ value_text: t.text, applies_to: "unquoted lines", resolves_to: text(t.value) ?? "other" })),
      conditional_discounts: terms
        .filter((t) => t.kind === "conditional_discount")
        .map((t) => termObject(t, doc, (x) => ({ pct: num(x.amount), condition_text: x.text, threshold_text: x.threshold_text, threshold_inclusive: x.threshold_inclusive }))),
    },
    rows,
    extras,
    notes: json.notes,
  });
  if (!parsed.success) throw new Error(`model output does not fit the extraction contract: ${parsed.error.message}`);
  return parsed.data;
}

export interface PassAOptions {
  client: LlmClient;
  config: Config;
  lines: readonly RfxLine[];
  questions: readonly Question[];
  effort?: "low" | "medium" | "high";
  now?: () => Date;
  /** Replaces the default task line, e.g. to say a reply answers questions about named lines. */
  task?: string;
}

export async function runPassA(doc: PassADocument, opts: PassAOptions): Promise<PassAResult> {
  const prompt = loadPassAPrompt();
  const screen = screenInjection(doc.text);
  const model = opts.config.models.extract_a;
  const empty = { questionnaire: [], unreadable_regions: [], notes: [], injection: screen.findings };
  const trace = (res: JsonResponse | null, ms: number): PassATrace => ({
    step: "extract_a",
    vendor_id: doc.vendor_id,
    prompt_version: prompt.version,
    model_requested: model,
    model_used: res?.model ?? null,
    fallback_used: res?.fallback_used ?? false,
    stop_reason: res?.stop_reason ?? null,
    usage: res?.usage ?? null,
    cost_usd: res?.cost_usd ?? null,
    ms,
    at: (opts.now ?? (() => new Date()))().toISOString(),
  });

  let res: JsonResponse;
  try {
    res = await opts.client.json({
      model,
      instructions: prompt.text,
      context: rfxContext(opts.lines, opts.questions),
      images: doc.images?.map(({ media_type, data }) => ({ media_type, data })),
      user: passAUser(doc, screen.clean_text, opts.task),
      schema: PASS_A_SCHEMA,
      effort: opts.effort ?? "medium", // measured: same accuracy as high on the four demo files at about 60% of the cost
      max_tokens: 32000,
    });
  } catch (err) {
    // Retries already happened in the SDK; the document is incomplete, never silently treated as empty (SY01).
    return { ...empty, extraction: null, errors: [`call failed: ${(err as Error).message}`], trace: trace(null, 0) };
  }

  const errors: string[] = [];
  if (res.stop_reason === "refusal") errors.push("the model declined this document");
  if (res.stop_reason === "max_tokens") errors.push("output was cut off at max_tokens");
  const limit = opts.config.limits.max_cost_usd_per_document;
  if (res.cost_usd !== null && res.cost_usd > limit) errors.push(`cost $${res.cost_usd.toFixed(3)} is over the $${limit} per-document cap`);
  if (res.text === null || errors.some((e) => e.startsWith("the model declined") || e.startsWith("output was cut"))) {
    return { ...empty, extraction: null, errors: errors.length ? errors : ["no output"], trace: trace(res, res.ms) };
  }

  try {
    const json = JSON.parse(res.text) as Raw;
    return {
      extraction: toExtraction(json, doc),
      questionnaire: (json.questionnaire as PassAResult["questionnaire"]).map((q) => ({ ...q, snippet: cleanSnippet(q.snippet) })),
      unreadable_regions: (json.unreadable_regions as Raw[]).map((u) => ({ line_id: text(u.line_id), description: u.description as string, locator: parseRef(doc.kind, u.locator as string) })),
      notes: json.notes as string[],
      injection: screen.findings,
      errors,
      trace: trace(res, res.ms),
    };
  } catch (err) {
    return { ...empty, extraction: null, errors: [...errors, (err as Error).message], trace: trace(res, res.ms) };
  }
}
