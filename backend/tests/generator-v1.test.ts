import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { RFX_LINES } from "../src/data/rfx.js";
import { checkOutlier } from "../src/ingest/checks.js";
import { buildV1Workbook, v1GroundTruth, vendorItemName, type V1Sheet } from "../src/generator/v1.js";
import { config } from "./fixtures/quotes.js";

const SEED = 42;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const colOf = (lineId: string) => 2 + RFX_LINES.findIndex((l) => l.line_id === lineId);
const line = (id: string) => RFX_LINES.find((l) => l.line_id === id)!;

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

interface Built {
  buffer: Buffer;
  content: V1Sheet;
  wb: ExcelJS.Workbook;
}

describe("V1 Excel offer (traps 01 to 04, 35)", () => {
  let rev1: Built;
  beforeAll(async () => {
    const { buffer, content } = await buildV1Workbook(SEED, 1);
    rev1 = { buffer, content, wb: await open(buffer) };
  });

  const rates = () => rev1.wb.getWorksheet("Rates")!;
  const rateCell = (id: string) => rates().getCell(8, colOf(id)).value;

  it("is byte-for-byte reproducible from the seed, and changes with it", async () => {
    const again = await buildV1Workbook(SEED, 1);
    expect(sha(again.buffer)).toBe(sha(rev1.buffer));
    expect(sha((await buildV1Workbook(7, 1)).buffer)).not.toBe(sha(rev1.buffer));
  });

  it("trap 01: transposed layout with merged group headers and a separate Summary sheet", () => {
    expect(rev1.wb.worksheets.map((w) => w.name)).toEqual(["Rates", "Summary", "QA"]);
    expect(rates().getCell(4, 1).value).toBe("ITEM");
    expect(rates().getCell(4, 2).value).toBe(vendorItemName(line("L01")));
    expect(rates().getCell(4, 31).value).toBe(vendorItemName(line("L30"))); // 30 lines run across columns B to AE
    const merges = (rates().model as { merges: string[] }).merges.sort();
    expect(merges).toEqual(["B3:I3", "J3:O3", "P3:R3", "S3:W3", "X3:Z3", "AA3:AE3"].sort());
    expect(rates().getCell(3, 2).value).toBe("5 PLY PRINTED");
    expect(rates().getCell(3, 10).value).toBe("3 PLY INNER");
  });

  it("uses the vendor's own short names, never the RFx wording", () => {
    for (const l of RFX_LINES) expect(vendorItemName(l)).not.toBe(l.description);
    expect(vendorItemName(line("L04"))).toBe("C FAN 1200MM MC");
  });

  it("trap 02: previous quarter rates sit in a hidden row, 3 to 5 percent above the real rate", () => {
    expect(rates().getRow(10).hidden).toBe(true);
    expect(rates().getCell(10, 1).value).toBe("Rate Q2");
    for (const l of rev1.content.lines) {
      if (l.intended === null) continue;
      const hidden = rates().getCell(10, colOf(l.line_id)).value as number;
      const ratio = hidden / l.intended;
      expect(ratio, l.line_id).toBeGreaterThanOrEqual(1.03 - 0.0005);
      expect(ratio, l.line_id).toBeLessThanOrEqual(1.05 + 0.0005);
    }
  });

  it("trap 03: L01, L02, L03, L05 are on 120 GSM / BF 16 at about 0.93 of baseline, while Q12 says no deviations", () => {
    for (const id of ["L01", "L02", "L03", "L05"]) {
      expect(rates().getCell(6, colOf(id)).value, id).toBe("5P BC 120/16");
      expect(rates().getCell(9, colOf(id)).value, id).toBe("Offered on 120 GSM liner, BF 16");
      const rate = rateCell(id) as number;
      expect(Math.abs(rate / (line(id).baseline_price_inr * 0.93) - 1), id).toBeLessThanOrEqual(0.015 + 0.0005);
    }
    expect(rates().getCell(6, colOf("L04")).value).toBe("5P BC 180/22");
    expect(rates().getCell(9, colOf("L04")).value).toBeNull();
    const qa = rev1.wb.getWorksheet("QA")!;
    expect(qa.getRow(13).values).toEqual([undefined, "Q12", "Any deviations from the specification", "No deviations."]);
  });

  it("trap 04: L06 is typed 11.08 against an intended 110.81, and the outlier check catches it", () => {
    expect(rateCell("L06")).toBe(11.08);
    const l06 = rev1.content.lines.find((l) => l.line_id === "L06")!;
    expect(l06.intended).toBe(110.81);
    const check = checkOutlier(11.08, [], line("L06").baseline_price_inr, config.tolerances);
    expect(check.slip).toMatchObject({ factor: 10 });
    expect(check.slip!.suggested_rate).toBeCloseTo(110.8, 1);
  });

  it("trap 35: L20 is 'NQ', L21 is blank, coverage is 28 of 30", () => {
    expect(rateCell("L20")).toBe("NQ");
    expect(rateCell("L21")).toBeNull();
    expect(rev1.content.lines.filter((l) => l.intended !== null)).toHaveLength(28);
  });

  it("other lines sit within 1.5% of baseline x 0.985 (L01 to L25) or x 1.00 (L26 to L30)", () => {
    for (const l of rev1.content.lines) {
      if (l.intended === null || ["L01", "L02", "L03", "L05", "L06"].includes(l.line_id)) continue;
      const n = Number(l.line_id.slice(1));
      const centre = line(l.line_id).baseline_price_inr * (n <= 25 ? 0.985 : 1.0);
      expect(Math.abs((rateCell(l.line_id) as number) / centre - 1), l.line_id).toBeLessThanOrEqual(0.015 + 0.001);
    }
  });

  it("Summary holds the terms and a grand total that matches the sheet as typed", () => {
    const s = rev1.wb.getWorksheet("Summary")!;
    const terms = new Map<string, unknown>();
    s.eachRow((row) => terms.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(terms.get("Delivery")).toBe("Delivered, FOR Chakan plant");
    expect(terms.get("GST")).toBe("Extra at 18%");
    expect(terms.get("Payment")).toBe("45 days from invoice");
    expect(terms.get("Validity")).toBe("30 days from 21-09-2026");
    expect(terms.get("Lead time")).toBe("10 days from PO");
    const expected = rev1.content.lines.reduce((sum, l) => (typeof l.shown === "number" ? sum + line(l.line_id).annual_qty * l.shown : sum), 0);
    expect(terms.get("Grand total (Rs)")).toBeCloseTo(expected, 2);
  });

  it("the QA sheet answers all 12 questions", () => {
    const qa = rev1.wb.getWorksheet("QA")!;
    expect(qa.rowCount).toBe(13);
    expect(qa.getCell(2, 3).value).toMatch(/ISO 9001|certificate/);
  });
});

describe("V1 ground truth matches the file it describes", () => {
  it("every quoted line's cell reference reads back its shown rate", async () => {
    const { buffer, content } = await buildV1Workbook(SEED, 1);
    const wb = await open(buffer);
    const gt = v1GroundTruth(content) as { lines: Record<string, { quoted: boolean; cell: string; rate_as_shown: unknown; expected_state: string }> };
    for (const [id, entry] of Object.entries(gt.lines)) {
      const [, ref] = entry.cell.split("!") as [string, string];
      expect(wb.getWorksheet("Rates")!.getCell(ref).value ?? null, id).toEqual(entry.rate_as_shown);
    }
  });

  it("states and flags follow the register", async () => {
    const { content } = await buildV1Workbook(SEED, 1);
    const gt = v1GroundTruth(content) as { lines: Record<string, { expected_state: string; expected_flags: string[] }>; coverage: string; gates: object };
    expect(gt.lines.L06).toMatchObject({ expected_state: "NEEDS_REVIEW" });
    expect(gt.lines.L06!.expected_flags).toContain("magnitude_slip");
    expect(gt.lines.L20).toMatchObject({ expected_state: "MISSING" });
    expect(gt.lines.L21).toMatchObject({ expected_state: "MISSING" });
    expect(gt.lines.L01!.expected_flags).toContain("spec_below_requirement");
    expect(gt.lines.L04).toMatchObject({ expected_state: "CONFIRMED", expected_flags: ["hidden_value_differs"] });
    expect(gt.coverage).toBe("28 of 30");
    expect(gt.gates).toEqual({ Q01: "PASS", Q02: "PASS", Q03: "PASS" });
  });
});

describe("trap 05: V1 revision 2", () => {
  let r1: Built;
  let r2: Built;
  beforeAll(async () => {
    const a = await buildV1Workbook(SEED, 1);
    const b = await buildV1Workbook(SEED, 2);
    r1 = { ...a, wb: await open(a.buffer) };
    r2 = { ...b, wb: await open(b.buffer) };
  });
  const shown = (b: Built, id: string) => b.content.lines.find((l) => l.line_id === id)!.shown;

  it("corrects L06 to 110.81 and raises L04, L15, L16, L17 by 3 percent", () => {
    expect(shown(r2, "L06")).toBe(110.81);
    for (const id of ["L04", "L15", "L16", "L17"]) {
      expect(shown(r2, id), id).toBeCloseTo((shown(r1, id) as number) * 1.03, 2);
    }
  });

  it("changes exactly those five lines and nothing else", () => {
    const changed = r1.content.lines.filter((l) => l.shown !== shown(r2, l.line_id)).map((l) => l.line_id);
    expect(changed).toEqual(["L04", "L06", "L15", "L16", "L17"]);
  });

  it("says so on the Summary sheet and in ground truth", () => {
    const summary = r2.wb.getWorksheet("Summary")!;
    expect(summary.getCell(2, 2).value).toBe("REVISED RATES - please disregard earlier sheet");
    const gt = v1GroundTruth(r2.content) as { expected_discrepancies: string[]; lines: Record<string, { expected_state: string }> };
    expect(gt.expected_discrepancies).toContain("revision_superseded");
    expect(gt.lines.L06!.expected_state).toBe("CONFIRMED");
  });

  it("keeps last quarter's hidden rates unchanged, and a different file hash", () => {
    for (const l of r1.content.lines) expect(r2.content.lines.find((x) => x.line_id === l.line_id)!.hidden_q2).toBe(l.hidden_q2);
    expect(sha(r1.buffer)).not.toBe(sha(r2.buffer));
  });
});
