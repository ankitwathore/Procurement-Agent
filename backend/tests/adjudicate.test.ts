import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { scoreVendor } from "../src/eval/score.js";
import { buildV1Workbook } from "../src/generator/v1.js";
import { buildV5Eml, v5GroundTruth } from "../src/generator/v5.js";
import { ADJUDICATE_SCHEMA, disputesOf, loadAdjudicatorPrompt, runAdjudicator, toAdjudications, type Adjudication } from "../src/ingest/adjudicate.js";
import type { PassADocument } from "../src/ingest/extract_a.js";
import type { Extraction, Row } from "../src/ingest/extraction.js";
import { parseEmail, type ParsedEmail } from "../src/ingest/parse_email.js";
import { parseXlsx, type ParsedWorkbook } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import type { JsonRequest, JsonResponse, LlmClient } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";
import { v5Extraction } from "./fixtures/v5.js";

class StubLlm implements LlmClient {
  requests: JsonRequest[] = [];
  constructor(private readonly respond: () => Partial<JsonResponse> | Error) {}
  async json(req: JsonRequest): Promise<JsonResponse> {
    this.requests.push(req);
    const r = this.respond();
    if (r instanceof Error) throw r;
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return { text: null, stop_reason: "end_turn", model: req.model, fallback_used: false, usage, cost_usd: costUsd(req.model, usage), ms: 1, ...r };
  }
}

const decision = (line_id: string, d: string, extra: Record<string, string> = {}) => ({
  line_id, decision: d, reasoning: "because", rate_as_written: "", currency: "", unit_as_written: "", carried_over: "", snippet: "", locator: "", ...extra,
});

const asPassB = (e: Extraction, keep: (r: Row) => boolean = () => true): Extraction => ({
  ...e,
  vendor_terms: {},
  extras: [],
  rows: e.rows.filter(keep).map((r) => ({ ...r, row_id: `B-${r.mapped_line_candidates[0]!.line_id}`, assumptions: [] })),
});

let wb: ParsedWorkbook;
let doc: PassADocument;
beforeAll(async () => {
  wb = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
  doc = { vendor_id: "V1", kind: "xlsx", text: wb.text };
});

/** V1 with a row shift in pass B: L04 read from L05's cell (42.4 instead of 72.8). */
function shifted(): Extraction {
  const b = asPassB(v1Extraction(wb), (r) => !String(r.locator.cell).endsWith("10"));
  const l04 = b.rows.find((x) => x.row_id === "B-L04")!;
  Object.assign(l04, { locator: { type: "xlsx", sheet: "Rates", cell: "F8" }, snippet: "42.4", rate: { ...l04.rate, value: 42.4 } });
  return b;
}
const v1 = (passB: Extraction, adjudications?: Adjudication[]) =>
  buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), passB, adjudications, sourceText: wb.text, workbook: wb, textNative: true });
const l04 = (quotes: Quote[]) => quotes.find((q) => q.line_id === "L04")!;
const adjudge = (d: Record<string, string>) => toAdjudications({ decisions: [d] }, disputesOf(v1(shifted()).quotes, RFX_LINES), doc, "claude-opus-5-5");

describe("adjudicator request", () => {
  it("is union-free, goes to Opus at high effort, and asks only about the disputed lines", async () => {
    expect(JSON.stringify(ADJUDICATE_SCHEMA).match(/"anyOf"|"type":\[/g) ?? []).toEqual([]);
    const disputes = disputesOf(v1(shifted()).quotes, RFX_LINES);
    expect(disputes.map((d) => d.line.line_id)).toEqual(["L04"]);

    const stub = new StubLlm(() => ({ text: JSON.stringify({ decisions: [decision("L04", "A")] }) }));
    const r = await runAdjudicator(doc, disputes, { client: stub, config, lines: RFX_LINES, questions: QUESTIONS });
    const req = stub.requests[0]!;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.effort).toBe("high");
    expect(req.instructions).toBe(loadAdjudicatorPrompt().text);
    expect(req.user).toContain("Line L04: Ceiling fan 1200mm master carton");
    expect(req.user).toContain('Reading A: INR 72.8 per pc; snippet "72.8"');
    expect(req.user).toContain('Reading B: INR 42.4 per pc; snippet "42.4"');
    expect(req.user).not.toContain("Line L05:");
    expect(r.adjudications).toEqual([{ line_id: "L04", decision: "A", reasoning: "because", row: null, model: "claude-opus-5-5" }]);
  });

  it("does nothing, and spends nothing, when no line is disputed", async () => {
    const stub = new StubLlm(() => ({ text: "{}" }));
    const r = await runAdjudicator(doc, [], { client: stub, config, lines: RFX_LINES, questions: QUESTIONS });
    expect(stub.requests).toEqual([]);
    expect(r.adjudications).toEqual([]);
  });
});

describe("applying decisions", () => {
  it("A: priced from pass A's verified cell, HIGH_CONF at best, never CONFIRMED (rule 2)", () => {
    const q = l04(v1(shifted(), adjudge(decision("L04", "A"))).quotes);
    expect(q).toMatchObject({ state: "HIGH_CONF", state_rule: 2 });
    expect(q.landed!.point).toBe(72.8);
    expect(q.flags).toContain("adjudicated");
    expect(q.reconciliation!.adjudication).toEqual({ decision: "A", reasoning: "because", model: "claude-opus-5-5" });
  });

  it("B: the adjudicator's choice is honoured even when it is the other reading", () => {
    const q = l04(v1(shifted(), adjudge(decision("L04", "B"))).quotes);
    expect(q.landed!.point).toBe(42.4);
    expect(q.state).toBe("HIGH_CONF");
  });

  it("UNRESOLVED: stays in review, unpriced, with the adjudicator's words", () => {
    const q = l04(v1(shifted(), adjudge(decision("L04", "UNRESOLVED", { reasoning: "both cells are labelled for the fan carton" }))).quotes);
    expect(q).toMatchObject({ state: "NEEDS_REVIEW", landed: null });
    expect(q.state_reason).toMatch(/Adjudicator: both cells are labelled for the fan carton$/);
  });

  it("THIRD: a reading that checks out against the document is used; one that does not stays in review and is reported", () => {
    const good = l04(v1(shifted(), adjudge(decision("L04", "THIRD", { rate_as_written: "72.8", currency: "INR", unit_as_written: "per pc", snippet: "72.8", locator: "Rates!E8" }))).quotes);
    expect(good).toMatchObject({ state: "HIGH_CONF" });
    expect(good.landed!.point).toBe(72.8);

    const made_up = v1(shifted(), adjudge(decision("L04", "THIRD", { rate_as_written: "70", currency: "INR", unit_as_written: "per pc", snippet: "70", locator: "Rates!E8" })));
    expect(l04(made_up.quotes)).toMatchObject({ state: "NEEDS_REVIEW", landed: null });
    expect(made_up.rejected.map((r) => r.row_id)).toContain("ADJ-L04");
  });

  it("NO_OFFER: the line is treated as not quoted", () => {
    const q = l04(v1(shifted(), adjudge(decision("L04", "NO_OFFER"))).quotes);
    expect(q).toMatchObject({ state: "MISSING", landed: null });
    expect(q.flags).toContain("adjudicated_no_offer");
  });

  it("never yields CONFIRMED, whatever it decides", () => {
    for (const d of ["A", "B", "NO_OFFER", "UNRESOLVED"]) expect(l04(v1(shifted(), adjudge(decision("L04", d))).quotes).state, d).not.toBe("CONFIRMED");
  });

  it("ignores decisions on lines nobody asked about, and picks of a reading that does not exist", () => {
    const disputes = disputesOf(v1(shifted()).quotes, RFX_LINES);
    expect(toAdjudications({ decisions: [decision("L09", "A")] }, disputes, doc, null)).toEqual([]);
    const v5ish = [{ line: RFX_LINES[24]!, readings: [{ pass: "B" as const, value: 38, currency: "Rs", unit: "/kg", snippet: "x", locator: {} }] }];
    expect(toAdjudications({ decisions: [decision("L25", "A")] }, v5ish, doc, null)[0]!.decision).toBe("UNRESOLVED");
  });

  it("a refused or failed call leaves the disputed lines in review", async () => {
    const disputes = disputesOf(v1(shifted()).quotes, RFX_LINES);
    for (const stub of [new StubLlm(() => ({ stop_reason: "refusal" })), new StubLlm(() => new Error("overloaded"))]) {
      const r = await runAdjudicator(doc, disputes, { client: stub, config, lines: RFX_LINES, questions: QUESTIONS });
      expect(r.adjudications).toEqual([]);
      expect(l04(v1(shifted(), r.adjudications).quotes).state).toBe("NEEDS_REVIEW");
    }
  });
});

describe("V5's L25, settled", () => {
  let email: ParsedEmail;
  beforeAll(async () => {
    email = await parseEmail(buildV5Eml());
  });

  it("taking pass B's '38 for the 3-ply' for the roll prices L25 at 38/kg, still awaiting the buyer's unit confirmation, and V5 then matches ground truth", () => {
    const a = v5Extraction(email.text);
    a.rows = a.rows.filter((r) => r.row_id !== "r3");
    const b = asPassB(v5Extraction(email.text));
    const build = (adjudications?: Adjudication[]) =>
      buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: a, passB: b, adjudications, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true }).quotes;
    const disputes = disputesOf(build(), RFX_LINES);
    expect(disputes.map((d) => d.line.line_id)).toEqual(["L25"]);

    const quotes = build(toAdjudications({ decisions: [decision("L25", "B")] }, disputes, { vendor_id: "V5", kind: "email", text: email.text }, "claude-opus-5-5"));
    const l25 = quotes.find((q) => q.line_id === "L25")!;
    expect(l25.state).toBe("INFERRED"); // the carried-over unit still needs the buyer, rule 12 below rule 2
    expect(l25.landed!.point).toBeCloseTo(42, 6); // 38 per kg plus 4.00 default freight
    const s = scoreVendor(quotes, (v5GroundTruth() as { lines: never }).lines, config.exposure.safe_states);
    expect({ state: s.state_accuracy, price: s.price_accuracy, dangerous: s.dangerous }).toEqual({ state: 1, price: 1, dangerous: [] });
  });
});
