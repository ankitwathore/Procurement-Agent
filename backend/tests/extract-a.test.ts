import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { scoreVendor } from "../src/eval/score.js";
import { buildV1Workbook, v1GroundTruth } from "../src/generator/v1.js";
import { buildV2Quote, INJECTION_FOOTER } from "../src/generator/v2.js";
import { buildV5Eml, v5GroundTruth } from "../src/generator/v5.js";
import { PASS_A_SCHEMA, cleanSnippet, loadPassAPrompt, num, parseRef, rfxContext, runPassA, type PassADocument } from "../src/ingest/extract_a.js";
import { parseEmail, type ParsedEmail } from "../src/ingest/parse_email.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { parseXlsx } from "../src/ingest/parse_xlsx.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import type { JsonRequest, JsonResponse, LlmClient } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";

/** A stub that records requests and returns a canned response. No network. */
class StubLlm implements LlmClient {
  requests: JsonRequest[] = [];
  constructor(private readonly respond: (req: JsonRequest) => Partial<JsonResponse> | Error) {}
  async json(req: JsonRequest): Promise<JsonResponse> {
    this.requests.push(req);
    const r = this.respond(req);
    if (r instanceof Error) throw r;
    const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 };
    return { text: null, stop_reason: "end_turn", model: req.model, fallback_used: false, usage, cost_usd: costUsd(req.model, usage), ms: 42, ...r };
  }
}

function v5Row(lineId: string, value: number, snippet: string, ply: number, carriedOver = "") {
  return {
    line_id: lineId,
    match_confidence: 0.9,
    match_reasons: "ply and per kg unit",
    raw_text: snippet,
    rate_as_written: String(value),
    currency: "INR",
    unit_as_written: "per kg",
    line_total_as_written: "",
    ply: String(ply),
    liner_gsm: "",
    bf: "",
    dims: "",
    print: "",
    struck_out_or_overwritten: false,
    carried_over: carriedOver,
    legibility: 1,
    snippet,
    locator: "",
    assumptions: ["the per kg rate applies to the board line priced per kg"],
  };
}

const term = (kind: string, value: string, text: string, snippet: string) => ({
  kind,
  value,
  text,
  amount: "",
  threshold_text: "",
  threshold_inclusive: false,
  valid_until: "",
  from_date: "",
  snippet,
  locator: "",
});

/** What a correct model answer for V5's email looks like, in the model-facing schema. */
const V5_ANSWER = {
  terms: [
    term("freight_basis", "freight_extra", "", "freight extra"),
    term("lines_not_quoted_statement", "baseline", "rest same as last year", "rest same as last year"),
  ],
  rows: [
    v5Row("L23", 42, "Rs 42/kg for the 5-ply", 5),
    v5Row("L24", 38, "38 for the 3-ply", 3, "unit, currency"),
    v5Row("L25", 38, "38 for the 3-ply", 3, "unit, currency"),
  ],
  extras: [],
  questionnaire: [],
  unreadable_regions: [],
  notes: [],
};

let email: ParsedEmail;
let v5Doc: PassADocument;
beforeAll(async () => {
  email = await parseEmail(buildV5Eml());
  v5Doc = { vendor_id: "V5", kind: "email", text: email.text, authoritative_end: email.new_text_end, message_id: email.message_id };
});

const opts = (client: LlmClient) => ({ client, config, lines: RFX_LINES, questions: QUESTIONS, now: () => new Date("2026-10-08T10:00:00Z") });

describe("the model-facing schema meets structured-output rules", () => {
  const walk = (node: unknown, path: string, out: string[]) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`, out));
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.type === "object") {
        if (o.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
        const keys = Object.keys(o.properties as object);
        if (JSON.stringify([...(o.required as string[])].sort()) !== JSON.stringify([...keys].sort())) out.push(`${path}: every property must be required`);
      }
      for (const bad of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "pattern"]) if (bad in o) out.push(`${path}: ${bad} is not supported`);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, out);
    }
  };

  it("every object is closed and fully required; no unsupported constraints", () => {
    const problems: string[] = [];
    walk(PASS_A_SCHEMA, "$", problems);
    expect(problems).toEqual([]);
  });

  it("stays under the API's limit of 16 union-typed fields (it has none)", () => {
    const unions = JSON.stringify(PASS_A_SCHEMA).match(/"anyOf"|"type":\[/g) ?? [];
    expect(unions.length).toBeLessThanOrEqual(16);
    expect(unions).toEqual([]);
  });
});

describe("request building", () => {
  it("puts the RFx in a stable, cacheable context and the document in untrusted tags", async () => {
    const stub = new StubLlm(() => ({ text: JSON.stringify(V5_ANSWER) }));
    await runPassA(v5Doc, opts(stub));
    const req = stub.requests[0]!;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.effort).toBe("medium");
    expect(req.context).toBe(rfxContext(RFX_LINES, QUESTIONS));
    expect(rfxContext(RFX_LINES, QUESTIONS)).toBe(rfxContext(RFX_LINES, QUESTIONS));
    for (const l of RFX_LINES) expect(req.context).toContain(`"line_id":"${l.line_id}"`);
    expect(req.user).toMatch(/^Extract the quotes from this email document from vendor V5\.\n<vendor_document kind="email">\n/);
    expect(req.user.endsWith("\n</vendor_document>")).toBe(true);
    expect(req.instructions).toBe(loadPassAPrompt().text);
  });

  it("strips AI-directed text before the call, and records it (trap 11)", async () => {
    const pdf = await parsePdf((await buildV2Quote(42)).buffer);
    const stub = new StubLlm(() => ({ text: null, stop_reason: "end_turn" }));
    const r = await runPassA({ vendor_id: "V2", kind: "pdf", text: pdf.text }, opts(stub));
    expect(stub.requests[0]!.user).not.toContain(INJECTION_FOOTER);
    expect(stub.requests[0]!.user).toContain("[REMOVED: text addressed to AI systems; recorded for the buyer]");
    expect(r.injection.length).toBeGreaterThan(0);
  });

  it("versions the prompt by its content", () => {
    expect(loadPassAPrompt().version).toMatch(/^extract_a@[0-9a-f]{8}$/);
  });
});

describe("mapping the model's answer", () => {
  it("V5: a correct answer becomes a valid extraction, code places the email spans, and the pipeline matches ground truth", async () => {
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: JSON.stringify(V5_ANSWER) }))));
    expect(r.errors).toEqual([]);
    const loc = r.extraction!.rows[0]!.locator;
    expect(email.text.slice(loc.char_start as number, loc.char_end as number)).toBe("Rs 42/kg for the 5-ply");
    expect(loc.message_id).toBe(email.message_id);

    const built = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: r.extraction!, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
    expect(built.rejected).toEqual([]);
    const score = scoreVendor(built.quotes, (v5GroundTruth() as { lines: never }).lines, config.exposure.safe_states);
    expect(score.state_accuracy).toBe(1);
    expect(score.price_accuracy).toBe(1);
    expect(score.dangerous).toEqual([]);
  });

  it("a price the model read from our quoted RFx is placed there and then rejected (trap 37)", async () => {
    const answer = structuredClone(V5_ANSWER);
    answer.rows[0] = v5Row("L23", 44.5, "Rs 44.50/kg", 5);
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: JSON.stringify(answer) }))));
    const built = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: r.extraction!, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
    expect(built.rejected[0]).toMatchObject({ row_id: "A1", reason: "snippet is in quoted history, not the vendor's new message" });
  });

  it("parses locator references for each format, and leaves an unreadable one for the provenance check to reject", () => {
    expect(parseRef("xlsx", "Rates!G8")).toEqual({ type: "xlsx", sheet: "Rates", cell: "G8" });
    expect(parseRef("xlsx", "'Rates'!$G$8")).toEqual({ type: "xlsx", sheet: "Rates", cell: "G8" });
    expect(parseRef("pdf", "page 3")).toEqual({ type: "pdf", page: 3 });
    expect(parseRef("pdf", "3")).toEqual({ type: "pdf", page: 3 });
    expect(parseRef("docx", "P12")).toEqual({ type: "docx", paragraph_idx: 12 });
    expect(parseRef("docx", "[T0 R3]")).toEqual({ type: "docx", table_idx: 0, row: 3 });
    expect(parseRef("xlsx", "somewhere in the sheet")).toEqual({ type: "xlsx" });
  });

  it("parses numbers as written, and treats an empty or unreadable value as not stated", () => {
    expect(num("18,09,879.50")).toBe(1809879.5);
    expect(num("USD 1.53")).toBe(1.53);
    expect(num("Rs 25,00,000")).toBe(2500000);
    expect(num("")).toBeNull();
    expect(num("illegible")).toBeNull();
  });

  it("strips the document view's own markers from snippets", () => {
    expect(cleanSnippet("[SMALL TEXT 5pt] All rates are inclusive of GST at 18 percent.")).toBe("All rates are inclusive of GST at 18 percent.");
    expect(cleanSnippet("[P9] The rate for a ceiling fan")).toBe("The rate for a ceiling fan");
    expect(cleanSnippet("[T0 R1] Mixer jar | 661.00")).toBe("Mixer jar | 661.00");
    expect(cleanSnippet("Rates!row10 [HIDDEN ROW]: A10=Rate Q2")).toBe("A10=Rate Q2");
    expect(cleanSnippet("11.08")).toBe("11.08");
  });

  it("clamps confidence and legibility into 0 to 1 instead of failing", async () => {
    const answer = structuredClone(V5_ANSWER);
    answer.rows[0]!.match_confidence = 1.2;
    answer.rows[0]!.legibility = -1;
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: JSON.stringify(answer) }))));
    expect(r.extraction!.rows[0]!.mapped_line_candidates[0]!.match_confidence).toBe(1);
    expect(r.extraction!.rows[0]!.legibility).toBe(0);
  });
});

describe("failure handling (spec SY01, SY03, SY06, X09)", () => {
  it("a refusal yields no extraction and says so", async () => {
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: null, stop_reason: "refusal" }))));
    expect(r).toMatchObject({ extraction: null, errors: ["the model declined this document"] });
    expect(r.trace.stop_reason).toBe("refusal");
  });

  it("truncated output is not trusted", async () => {
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: '{"vendor_terms":', stop_reason: "max_tokens" }))));
    expect(r.extraction).toBeNull();
    expect(r.errors).toContain("output was cut off at max_tokens");
  });

  it("output that is not valid JSON, or does not fit the contract, is an error, not a crash", async () => {
    expect((await runPassA(v5Doc, opts(new StubLlm(() => ({ text: "not json" }))))).extraction).toBeNull();
    const bad = structuredClone(V5_ANSWER);
    bad.terms[0]!.value = "air freight"; // not a freight basis the contract knows
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: JSON.stringify(bad) }))));
    expect(r.extraction).toBeNull();
    expect(r.errors[0]).toMatch(/does not fit the extraction contract/);
  });

  it("a failed call after the SDK's retries marks the document incomplete", async () => {
    const r = await runPassA(v5Doc, opts(new StubLlm(() => new Error("529 overloaded"))));
    expect(r).toMatchObject({ extraction: null, errors: ["call failed: 529 overloaded"] });
  });

  it("over the per-document cost cap is reported, and the extraction is kept", async () => {
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: JSON.stringify(V5_ANSWER), cost_usd: 2.5 }))));
    expect(r.extraction).not.toBeNull();
    expect(r.errors).toEqual(["cost $2.500 is over the $1.5 per-document cap"]);
  });

  it("the trace records prompt version, model, tokens, cost and time", async () => {
    const r = await runPassA(v5Doc, opts(new StubLlm(() => ({ text: JSON.stringify(V5_ANSWER) }))));
    expect(r.trace).toMatchObject({
      step: "extract_a",
      vendor_id: "V5",
      model_requested: "claude-sonnet-5-5",
      model_used: "claude-sonnet-5-5",
      fallback_used: false,
      ms: 42,
      at: "2026-10-08T10:00:00.000Z",
    });
    expect(r.trace.prompt_version).toBe(loadPassAPrompt().version);
    expect(r.trace.cost_usd).toBeCloseTo((1000 * 2 + 500 * 10 + 3000 * 0.2) / 1e6, 10);
  });
});

describe("scoreVendor", () => {
  it("the ideal V1 extraction scores perfectly; a confirmed wrong price is counted as dangerous", async () => {
    const { buffer, content } = await buildV1Workbook(42, 1);
    const wb = await parseXlsx(buffer);
    const built = buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb, textNative: true });
    const gt = (v1GroundTruth(content) as { lines: never }).lines;
    const s = scoreVendor(built.quotes, gt, config.exposure.safe_states);
    expect({ state: s.state_accuracy, price: s.price_accuracy, dangerous: s.dangerous, coverage: s.coverage_errors }).toEqual({ state: 1, price: 1, dangerous: [], coverage: [] });

    const tampered = built.quotes.map((q) => (q.line_id === "L04" ? { ...q, landed: { point: 80, low: 80, high: 80 } } : q));
    expect(scoreVendor(tampered, gt, config.exposure.safe_states).dangerous).toEqual(["L04"]);
  });
});

describe("costUsd", () => {
  it("prices Sonnet 5.5, Opus 5.5 and Haiku 5.5, and refuses to guess for an unknown model", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
    expect(costUsd("claude-sonnet-5-5", u)).toBeCloseTo(2 + 10 + 0.2 + 2.5, 10);
    expect(costUsd("claude-opus-5-5", u)).toBeCloseTo(4 + 20 + 0.2 + 5, 10);
    expect(costUsd("claude-haiku-5-5", u)).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 10);
    expect(costUsd("some-other-model", u)).toBeNull();
  });
});
