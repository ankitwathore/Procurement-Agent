import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { scoreVendor } from "../src/eval/score.js";
import { buildV1Workbook, v1GroundTruth } from "../src/generator/v1.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { loadPrompt, rfxContext, type PassADocument } from "../src/ingest/extract_a.js";
import { PASS_B_SCHEMA, passBToExtraction, runPassB } from "../src/ingest/extract_b.js";
import type { Extraction, Row } from "../src/ingest/extraction.js";
import { parseEmail, type ParsedEmail } from "../src/ingest/parse_email.js";
import { parseXlsx, type ParsedWorkbook } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, reconcile } from "../src/ingest/quotes.js";
import type { JsonRequest, JsonResponse, LlmClient } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";
import { v5Extraction } from "./fixtures/v5.js";

class StubLlm implements LlmClient {
  requests: JsonRequest[] = [];
  constructor(private readonly respond: () => Partial<JsonResponse>) {}
  async json(req: JsonRequest): Promise<JsonResponse> {
    this.requests.push(req);
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return { text: null, stop_reason: "end_turn", model: req.model, fallback_used: false, usage, cost_usd: costUsd(req.model, usage), ms: 1, ...this.respond() };
  }
}

/** Pass B's view of an extraction: the same visible rows, as an independent RFx-first reading would give them. */
const asPassB = (e: Extraction, keep: (r: Row) => boolean = () => true): Extraction => ({
  ...e,
  vendor_terms: {},
  extras: [],
  rows: e.rows.filter(keep).map((r) => ({ ...r, row_id: `B-${r.mapped_line_candidates[0]!.line_id}`, assumptions: [] })),
});

let wb: ParsedWorkbook;
let gt: Record<string, never>;
beforeAll(async () => {
  const { buffer, content } = await buildV1Workbook(42, 1);
  wb = await parseXlsx(buffer);
  gt = (v1GroundTruth(content) as { lines: Record<string, never> }).lines;
});
const v1 = (passB?: Extraction) =>
  buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), passB, sourceText: wb.text, workbook: wb, textNative: true });
const visible = (r: Row) => !String(r.locator.cell).endsWith("10");

describe("pass B request and schema", () => {
  it("is closed and union-free like pass A's", () => {
    const s = JSON.stringify(PASS_B_SCHEMA);
    expect(s.match(/"anyOf"|"type":\[/g) ?? []).toEqual([]);
    expect(s).toContain('"additionalProperties":false');
  });

  it("shares pass A's RFx context, so both passes read one cached prefix, and uses its own instructions", async () => {
    const stub = new StubLlm(() => ({ text: JSON.stringify({ lines: [], notes: [] }) }));
    const doc: PassADocument = { vendor_id: "V1", kind: "xlsx", text: wb.text };
    await runPassB(doc, { client: stub, config, lines: RFX_LINES, questions: QUESTIONS });
    const req = stub.requests[0]!;
    expect(req.context).toBe(rfxContext(RFX_LINES, QUESTIONS));
    expect(req.instructions).toBe(loadPrompt("extract_b").text);
    expect(req.instructions).toContain("Snippets and locators"); // the shared conventions
    expect(req.model).toBe(config.models.extract_b);
    expect(req.effort).toBe("medium");
    expect(req.user).toMatch(/^Check each RFx line against this xlsx document from vendor V1\./);
  });

  it("turns priced lines into rows and skips lines not offered; a refusal yields nothing", async () => {
    const line = (line_id: string, found: boolean) => ({
      line_id, status: found ? "priced" : "not_offered", rate_as_written: found ? "72.8" : "", currency: found ? "Rs" : "", unit_as_written: found ? "pc" : "", carried_over: "",
      line_total_as_written: "", ply: "", liner_gsm: "", bf: "", dims: "", print: "", struck_out_or_overwritten: false, legibility: 1,
      snippet: found ? "72.8" : "", locator: found ? "Rates!E8" : "", assumptions: [], not_found_reason: found ? "" : "NQ",
    });
    const e = passBToExtraction({ lines: [line("L04", true), line("L20", false)], notes: [] }, { vendor_id: "V1", kind: "xlsx", text: wb.text });
    expect(e.rows.map((r) => [r.row_id, r.rate.value, r.locator.cell])).toEqual([["B-L04", 72.8, "E8"]]);

    const refused = await runPassB({ vendor_id: "V1", kind: "xlsx", text: wb.text }, { client: new StubLlm(() => ({ stop_reason: "refusal" })), config, lines: RFX_LINES, questions: QUESTIONS });
    expect(refused).toMatchObject({ extraction: null, errors: ["the model declined this document"] });
  });
});

describe("reconcile (spec 10.6)", () => {
  const row = (value: number | null, unit: string | null, currency: string): Row =>
    ({ rate: { value, unit_as_written: unit, currency, basis_note: "" }, snippet: "x", locator: {} }) as unknown as Row;

  it.each([
    [100, "per pc", "Rs", 100.4, "per pc", "INR", "agree"], // 0.4 percent, and Rs is INR
    [100, "per pc", "INR", 101, "per pc", "INR", "disagree"], // 1 percent
    [6.4, "per pc", "INR", 640, "per 100 pcs", "INR", "disagree"], // same price, different unit as written: let the adjudicator see it
    [42, "per kg", "INR", 42, "per kg", "", "disagree"], // one pass saw no currency
    [42, "per kg", "INR", 42, "/kg", "INR", "agree"], // unit wording differs, canonical unit is the same
  ] as const)("%s %s %s vs %s %s %s -> %s", (av, au, ac, bv, bu, bc, status) => {
    expect(reconcile([row(av, au, ac)], [row(bv, bu, bc)], config.tolerances.rate_agreement_pct).status).toBe(status);
  });

  it("both passes see the line but read no price: agreed, so no adjudication; the line still goes to review", () => {
    const r = reconcile([row(null, null, "")], [row(null, "pc", "Rs")], config.tolerances.rate_agreement_pct);
    expect(r).toMatchObject({ status: "agree", detail: "Both passes found the line; neither could read its price." });
  });

  it("one pass alone, or neither", () => {
    expect(reconcile([row(1, "per pc", "INR")], [], 0.5).status).toBe("a_only");
    expect(reconcile([], [row(1, "per pc", "INR")], 0.5).status).toBe("b_only");
    expect(reconcile([], [], 0.5).status).toBe("neither");
  });
});

describe("both passes on V1's real file", () => {
  it("when they agree, every line keeps its expected state and the score is perfect", () => {
    const r = v1(asPassB(v1Extraction(wb), visible));
    const statuses = r.quotes.map((q) => q.reconciliation!.status);
    expect(statuses.filter((s) => s === "agree")).toHaveLength(28);
    expect(statuses.filter((s) => s === "neither")).toHaveLength(2); // L20 NQ, L21 blank
    const s = scoreVendor(r.quotes, gt, config.exposure.safe_states);
    expect({ state: s.state_accuracy, price: s.price_accuracy, flags: s.flag_recall, dangerous: s.dangerous }).toEqual({ state: 1, price: 1, flags: 1, dangerous: [] });
  });

  it("a row shift in one pass (L04 read from L05's cell) sends L04 to review with both readings, unpriced", () => {
    const b = asPassB(v1Extraction(wb), visible);
    const l04 = b.rows.find((x) => x.row_id === "B-L04")!;
    l04.locator = { type: "xlsx", sheet: "Rates", cell: "F8" };
    l04.snippet = "42.4";
    l04.rate.value = 42.4;
    const q = v1(b).quotes.find((x) => x.line_id === "L04")!;
    expect(q).toMatchObject({ state: "NEEDS_REVIEW", state_rule: 2, landed: null });
    expect(q.flags).toContain("passes_disagree");
    expect(q.reconciliation!.detail).toBe("Pass A read INR 72.8 per pc; pass B read INR 42.4 per pc.");
    expect(q.reconciliation!.readings.map((x) => [x.pass, x.locator.cell])).toEqual([["A", "E8"], ["B", "F8"]]);
  });

  it("a pass B row that fails provenance counts as not found, so the line is single-pass and goes to review", () => {
    const b = asPassB(v1Extraction(wb), visible);
    b.rows.find((x) => x.row_id === "B-L04")!.rate.value = 99; // the cell says 72.8
    const r = v1(b);
    expect(r.rejected.map((x) => x.row_id)).toContain("B-L04");
    expect(r.quotes.find((x) => x.line_id === "L04")!.reconciliation!.status).toBe("a_only");
    expect(r.quotes.find((x) => x.line_id === "L04")!.state).toBe("NEEDS_REVIEW");
  });

  it("without pass B nothing changes: no reconciliation is recorded", () => {
    expect(v1().quotes.every((q) => q.reconciliation === null)).toBe(true);
  });
});

describe("V5's '38 for the 3-ply': pass B catches what pass A left out", () => {
  let email: ParsedEmail;
  beforeAll(async () => {
    email = await parseEmail(buildV5Eml());
  });

  it("A maps it to the sheet only, B to sheet and roll: L24 agrees, L25 goes to review instead of a wrong baseline price", () => {
    const a = v5Extraction(email.text);
    a.rows = a.rows.filter((r) => r.row_id !== "r3"); // pass A as in the live run: no L25 row
    const b = asPassB(v5Extraction(email.text));
    const quotes = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: a, passB: b, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true }).quotes;
    const q = (id: string) => quotes.find((x) => x.line_id === id)!;
    expect(q("L24").reconciliation!.status).toBe("agree");
    expect(q("L25")).toMatchObject({ state: "NEEDS_REVIEW", landed: null });
    expect(q("L25").reconciliation!.status).toBe("b_only");
    expect(q("L01").reconciliation!.status).toBe("neither"); // "same as last year" still applies to the 27
    expect(q("L01").state).toBe("INFERRED");
  });
});
