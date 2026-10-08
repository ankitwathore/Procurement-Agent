import { beforeAll, describe, expect, it } from "vitest";
import { RFX_LINES } from "../src/data/rfx.js";
import { compareReportToLines } from "../src/evidence/claims.js";
import { V1_HOLDOUT, V1_TUNED, buildV1Workbook, v1GroundTruth, v1Traps } from "../src/generator/v1.js";
import { V2_HOLDOUT, V2_TUNED, altRate, buildV2Quote, v2Traps } from "../src/generator/v2.js";
import { V3_HOLDOUT, buildV3Quote, buildV3TestReport, v3GroundTruth, v3Traps } from "../src/generator/v3.js";
import { V5_HOLDOUT, buildV5Eml, v5GroundTruth, v5Traps } from "../src/generator/v5.js";
import { parseDocx } from "../src/ingest/parse_docx.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { lookupCell, parseXlsx } from "../src/ingest/parse_xlsx.js";
import { readTestReport } from "./fixtures/evidence.js";
import { q } from "./fixtures/quotes.js";

/** The holdout set (seed 7, spec 17.10): same vendor roles and classes of traps, other layouts, wording and placements. */

const SEED = 7;

describe("holdout V1 (Excel, rows layout)", () => {
  let wb: Awaited<ReturnType<typeof parseXlsx>>;
  let content: Awaited<ReturnType<typeof buildV1Workbook>>["content"];
  beforeAll(async () => {
    const built = await buildV1Workbook(SEED, 1, V1_HOLDOUT);
    content = built.content;
    wb = await parseXlsx(built.buffer);
  });

  it("is deterministic and differs from the tuned file", async () => {
    expect((await buildV1Workbook(SEED, 1, V1_HOLDOUT)).buffer.equals((await buildV1Workbook(SEED, 1, V1_HOLDOUT)).buffer)).toBe(true);
    expect(V1_HOLDOUT.layout).not.toBe(V1_TUNED.layout);
  });

  it("each rate sits in its row's Rate column; previous quarter rates in a hidden column", () => {
    for (const l of content.lines.filter((x) => typeof x.shown === "number")) {
      const cell = lookupCell(wb, "Offer", l.cell)!;
      expect(cell.value, l.line_id).toBe(l.shown);
    }
    const l26 = content.lines.find((l) => l.line_id === "L26")!;
    const hidden = lookupCell(wb, "Offer", l26.cell.replace("F", "G"))!;
    expect(hidden.hidden.col).toBe(true);
    expect(hidden.value).toBe(l26.hidden_q2);
  });

  it("the slip is ten times over on L16; lighter board on L12, L14, L22; Not quoted on L28 and a blank L19", () => {
    const l16 = content.lines.find((l) => l.line_id === "L16")!;
    expect(l16.shown).toBeCloseTo(l16.intended! * 10, 2);
    const gt = v1GroundTruth(content, V1_HOLDOUT) as { lines: Record<string, { expected_flags: string[]; quoted: boolean; expected_state: string; true_landed_point?: number }> };
    expect(Object.entries(gt.lines).filter(([, l]) => l.expected_flags.includes("spec_below_requirement")).map(([id]) => id)).toEqual(["L12", "L14", "L22"]);
    expect(gt.lines.L16).toMatchObject({ expected_state: "NEEDS_REVIEW", true_landed_point: l16.intended });
    expect([gt.lines.L19!.quoted, gt.lines.L28!.quoted]).toEqual([false, false]);
    expect(lookupCell(wb, "Offer", content.lines.find((l) => l.line_id === "L28")!.cell)!.value).toBe("Not quoted");
  });

  it("the trap register carries the holdout placements, and no revision trap", () => {
    const t = v1Traps(V1_HOLDOUT, content);
    expect(t["03"]!.lines).toEqual(["L12", "L14", "L22"]);
    expect(t["04"]).toMatchObject({ line: "L16" });
    expect(t["05"]).toBeUndefined();
    expect(t["35"]!.lines).toEqual({ L28: "Not quoted", L19: "blank" });
  });
});

describe("holdout V2 (PDF, 3 page template)", () => {
  let text: string;
  let content: Awaited<ReturnType<typeof buildV2Quote>>["content"];
  beforeAll(async () => {
    const built = await buildV2Quote(SEED, V2_HOLDOUT);
    content = built.content;
    const pdf = await parsePdf(built.buffer);
    expect(pdf.pages).toHaveLength(3);
    text = pdf.text;
  });

  it("GST inclusive in one note on page 2, discount in the terms, injection in white text on page 1", () => {
    const page2 = text.slice(text.indexOf("=== Page 2 ==="), text.indexOf("=== Page 3 ==="));
    expect(page2).toContain(V2_HOLDOUT.gst.text);
    expect(page2).toContain("3 percent on invoice value where annual orders placed exceed Rs 20,00,000");
    expect(text.slice(0, text.indexOf("=== Page 2 ==="))).toContain("AI assistant reviewing this file");
  });

  it("the L08 amount is 8 percent below quantity x rate; the alternate is for L17", () => {
    const r = content.rows.find((x) => x.line_id === "L08")!;
    const qty = RFX_LINES.find((l) => l.line_id === "L08")!.annual_qty;
    expect(r.amount / (qty * r.displayed)).toBeCloseTo(0.92, 4);
    const t = v2Traps(V2_HOLDOUT, content);
    expect(t["12"]).toMatchObject({ line: "L17", rate: altRate(content, V2_HOLDOUT) });
    expect(t["06"]).toMatchObject({ page: 2 });
    expect(t["07"]).toMatchObject({ pct: 3, threshold_inr: 2_000_000 });
    expect(v2Traps(V2_TUNED, content)["12"]).toMatchObject({ line: "L06", rate: 138 });
  });

  it("rows are in description order, not RFx order or carton volume", () => {
    expect(content.rows.map((r) => r.line_id).slice(0, 3)).not.toEqual(["L01", "L02", "L03"]);
    expect(text.indexOf("Air Fryer 4L Master Box")).toBeLessThan(text.indexOf("Ceiling Fan 1200mm Master Box"));
  });
});

describe("holdout V3 (Word)", () => {
  let text: string;
  let content: Awaited<ReturnType<typeof buildV3Quote>>["content"];
  beforeAll(async () => {
    const built = await buildV3Quote(SEED, V3_HOLDOUT);
    content = built.content;
    text = (await parseDocx(built.buffer)).text;
  });

  it("per 100 and per 1000 bases on different lines; eight cartons in new sentence shapes", () => {
    expect(content.find((c) => c.line_id === "L10")).toMatchObject({ basis: "per 1000 nos" });
    expect(content.find((c) => c.line_id === "L10")!.shown).toBeCloseTo(content.find((c) => c.line_id === "L10")!.rate_per_base * 1000, 2);
    expect(text).toContain("works out to Rs");
    expect(content.filter((c) => c.where === "prose").map((c) => c.line_id)).toEqual(["L01", "L02", "L03", "L04", "L05", "L06", "L07", "L08"]);
  });

  it("the 7 ply claim is contradicted by the report on exactly L15, L16, L17; validity lapsed 2026-09-30", async () => {
    const report = readTestReport((await parsePdf(await buildV3TestReport(V3_HOLDOUT))).text);
    const all = RFX_LINES.map((l) => q("V3", l.line_id, 10));
    expect([...new Set(compareReportToLines(report, all, RFX_LINES).map((f) => f.line_id))]).toEqual(["L15", "L16", "L17"]);
    expect(v3GroundTruth(content, V3_HOLDOUT)).toMatchObject({ validity_until: "2026-09-30", validity: "lapsed" });
    expect(v3Traps(V3_HOLDOUT)["16"]!.lines).toEqual(["L15", "L16", "L17"]);
  });

  it("no line lacks a currency in the holdout, so nothing awaits a currency confirmation", () => {
    const gt = v3GroundTruth(content, V3_HOLDOUT) as { lines: Record<string, { expected_flags: string[] }> };
    expect(Object.values(gt.lines).some((l) => l.expected_flags.includes("currency_assumed"))).toBe(false);
  });
});

describe("holdout V5 (email)", () => {
  it("an Outlook style reply: quoted history starts at Original Message and holds last year's rates", async () => {
    const e = await parseEmail(buildV5Eml(V5_HOLDOUT));
    expect(e.new_text).toContain("5 ply board Rs 41.50 per kg");
    expect(e.new_text).not.toContain("Last year we paid");
    expect(e.quoted_text.startsWith("-----Original Message-----")).toBe(true);
    expect(e.quoted_text).toContain("Last year we paid Rs");
  });

  it("every rate writes its own unit and currency; the roll is the open question", () => {
    const gt = v5GroundTruth(V5_HOLDOUT) as { lines: Record<string, { carried_over?: string[]; expected_state: string; also_acceptable?: string[] }> };
    expect(gt.lines.L24).toMatchObject({ carried_over: [], expected_state: "INFERRED" });
    expect(gt.lines.L25).toMatchObject({ expected_state: "NEEDS_REVIEW", also_acceptable: ["INFERRED"] });
    expect(v5Traps(V5_HOLDOUT)["30"]!.lines).toEqual(["L23", "L24", "L25"]);
  });
});

describe("fresh holdout (seed 8): placements differ again", () => {
  it("V1: lighter board on L03 and L20, a tenth slip on the kg line L23, N/A on L27, blank L13", async () => {
    const { buildV1Workbook: build, V1_HOLDOUT2 } = await import("../src/generator/v1.js");
    const { content } = await build(8, 1, V1_HOLDOUT2);
    const l23 = content.lines.find((l) => l.line_id === "L23")!;
    expect(l23.shown).toBeCloseTo(l23.intended! / 10, 2);
    expect(v1Traps(V1_HOLDOUT2, content)["35"]!.lines).toEqual({ L27: "N/A", L13: "blank" });
    expect((v1GroundTruth(content, V1_HOLDOUT2) as { lines: Record<string, { expected_flags: string[] }> }).lines.L03!.expected_flags).toContain("spec_below_requirement");
  });

  it("V2, V3, V5: GST note on page 1, the 3 ply claim against BF 17.6, the currency said once", async () => {
    const { V2_HOLDOUT2 } = await import("../src/generator/v2.js");
    const { V3_HOLDOUT2 } = await import("../src/generator/v3.js");
    const { V5_HOLDOUT2 } = await import("../src/generator/v5.js");
    const q2 = await buildV2Quote(8, V2_HOLDOUT2);
    expect(v2Traps(V2_HOLDOUT2, q2.content)["06"]).toMatchObject({ page: 1 });
    const page1 = (await parsePdf(q2.buffer)).text.split("=== Page 2 ===")[0]!;
    expect(page1).toContain("All rates are inclusive of GST (18%).");
    const report = readTestReport((await parsePdf(await buildV3TestReport(V3_HOLDOUT2))).text);
    const all = RFX_LINES.map((l) => q("V3", l.line_id, 10));
    expect([...new Set(compareReportToLines(report, all, RFX_LINES).map((f) => f.line_id))]).toEqual(["L12", "L14", "L21", "L22", "L24", "L29"]);
    const gt = v5GroundTruth(V5_HOLDOUT2) as { lines: Record<string, { carried_over?: string[] }> };
    expect(gt.lines.L24!.carried_over).toEqual(["currency"]);
  });
});
