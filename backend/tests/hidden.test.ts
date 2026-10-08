import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { RFX_LINES } from "../src/data/rfx.js";
import { scoreVendor } from "../src/eval/score.js";
import { buildV1Workbook, v1GroundTruth } from "../src/generator/v1.js";
import { ExtractionSchema, type Extraction } from "../src/ingest/extraction.js";
import { parseXlsx, type ParsedWorkbook } from "../src/ingest/parse_xlsx.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";

let wb: ParsedWorkbook;
let gt: Record<string, never>;
beforeAll(async () => {
  const { buffer, content } = await buildV1Workbook(42, 1);
  wb = await parseXlsx(buffer);
  gt = (v1GroundTruth(content) as { lines: Record<string, never> }).lines;
});

/** The extraction a cautious model gave at medium effort: visible prices only, the hidden row left out. */
const visibleOnly = (): Extraction => {
  const e = v1Extraction(wb);
  e.rows = e.rows.filter((r) => !String(r.locator.cell).endsWith("10"));
  return e;
};

const build = (extraction: Extraction, workbook: ParsedWorkbook = wb) =>
  buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction, sourceText: workbook.text, workbook, textNative: true });

describe("hidden values found in code (trap 02 without the model's help)", () => {
  it("flags all 28 quoted V1 lines even when the model reported no hidden rows", () => {
    const quotes = build(visibleOnly()).quotes;
    const flagged = quotes.filter((q) => q.flags.includes("hidden_value_differs")).map((q) => q.line_id);
    expect(flagged).toHaveLength(28);
    expect(quotes.find((q) => q.line_id === "L04")!.hidden_values).toEqual([{ value: 75.8, snippet: "75.8", locator: { type: "xlsx", sheet: "Rates", cell: "E10", hidden: true } }]);
  });

  it("does not double count a hidden cell the model also reported", () => {
    const quotes = build(v1Extraction(wb)).quotes;
    expect(quotes.find((q) => q.line_id === "L04")!.hidden_values).toHaveLength(1);
  });

  it("never prices from the hidden cell", () => {
    expect(build(visibleOnly()).quotes.find((q) => q.line_id === "L04")!.landed!.point).toBe(72.8);
  });
});

describe("layouts", () => {
  /** Items down rows (the usual layout): A = item, B = rate, C = a hidden "old rate" column; row 4 is a hidden item. */
  async function rowLayout(): Promise<ParsedWorkbook> {
    const x = new ExcelJS.Workbook();
    const ws = x.addWorksheet("Quote");
    ws.addRow(["Item", "Rate", "Old rate"]);
    ws.addRow(["Mixer MC", 38.5, 41.0]);
    ws.addRow(["Cooktop MC", 26.1, 27.9]);
    ws.addRow(["Air fryer MC (withdrawn)", 99.9, 99.9]);
    ws.getColumn(3).hidden = true;
    ws.getRow(4).hidden = true;
    return parseXlsx(Buffer.from(await x.xlsx.writeBuffer()));
  }

  const row = (id: string, cell: string, value: number) => ({
    row_id: cell,
    raw_text: String(value),
    mapped_line_candidates: [{ line_id: id, match_confidence: 0.9, reasons: [] }],
    rate: { value, currency: "INR", unit_as_written: "per pc" },
    locator: { type: "xlsx", sheet: "Quote", cell },
    snippet: String(value),
  });

  it("items down rows: the hidden column in a price's own row belongs to that line; a hidden item row is not attached elsewhere", async () => {
    const book = await rowLayout();
    const extraction = ExtractionSchema.parse({ vendor_terms: {}, rows: [row("L01", "B2", 38.5), row("L02", "B3", 26.1)] });
    const quotes = build(extraction, book).quotes;
    expect(quotes.find((q) => q.line_id === "L01")!.hidden_values.map((h) => h.locator.cell)).toEqual(["C2"]);
    expect(quotes.find((q) => q.line_id === "L02")!.hidden_values.map((h) => h.locator.cell)).toEqual(["C3"]);
    expect(quotes.some((q) => q.hidden_values.some((h) => h.locator.cell === "B4" || h.locator.cell === "C4"))).toBe(false);
  });

  it("a single price gives no layout to read, so nothing is guessed", async () => {
    const book = await rowLayout();
    const extraction = ExtractionSchema.parse({ vendor_terms: {}, rows: [row("L01", "B2", 38.5)] });
    expect(build(extraction, book).quotes.find((q) => q.line_id === "L01")!.hidden_values).toEqual([]);
  });
});

describe("scorer flag recall", () => {
  it("is 100 percent for V1 even without the model reporting hidden rows, and names what goes missing", () => {
    const quotes = build(visibleOnly()).quotes;
    const s = scoreVendor(quotes, gt, config.exposure.safe_states);
    expect(s.flag_recall).toBe(1);
    expect(s.flags_expected).toBe(28 + 1 + 4); // hidden on 28 quoted lines, the L06 slip, four lighter-board lines

    const stripped = quotes.map((q) => (q.line_id === "L04" ? { ...q, flags: q.flags.filter((f) => f !== "hidden_value_differs") } : q));
    const s2 = scoreVendor(stripped, gt, config.exposure.safe_states);
    expect(s2.missing_flags).toEqual(["L04:hidden_value_differs"]);
    expect(s2.flag_recall).toBeCloseTo(32 / 33, 10);
  });
});
