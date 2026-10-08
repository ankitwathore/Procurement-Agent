import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, allocate } from "../src/award/optimizer.js";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { applyReportFindings, checkDeviationClaim, compareReportToLines } from "../src/evidence/claims.js";
import type { TestReportFields } from "../src/evidence/gates.js";
import { V1_QA, buildV1TestReport, buildV1Workbook } from "../src/generator/v1.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { readTestReport } from "./fixtures/evidence.js";
import { V2_TEST_REPORT } from "../src/generator/v2.js";
import { V3_TEST_REPORT } from "../src/generator/v3.js";
import { parseXlsx } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import { assessment, config, q, vendor } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";

/** Every line quoted, as a confirmed price, by one vendor. */
const allQuoted = (vid: string) => RFX_LINES.map((l) => q(vid, l.line_id, 10));

// Spec 17.5, V3: the report shows 5 ply BC 19.5 and 7 ply 24.6; 3 ply raised from the spec's 16.8 to 18.2.
const V3_REPORT: TestReportFields = V3_TEST_REPORT;

const BF18_3PLY = ["L12", "L14", "L21", "L22", "L24", "L29"];

describe("compareReportToLines (trap 16)", () => {
  const findings = compareReportToLines(V3_REPORT, allQuoted("V3"), RFX_LINES);

  it("V3's 5 ply BC BF 19.5 falls short on exactly the lines that need BF 22: L04, L06, L07, L08, L23", () => {
    const fivePly = findings.filter((f) => f.sample.ply === 5).map((f) => f.line_id);
    expect(fivePly).toEqual(["L04", "L06", "L07", "L08", "L23"]);
    expect(findings.find((f) => f.line_id === "L04")!.detail).toBe("Test report shows BF 19.5 for 5 ply BC; L04 requires BF 22.");
  });

  it("the same 19.5 reading clears the 5 ply lines that need only BF 18, and 24.6 clears the 7 ply lines", () => {
    const flagged = new Set(findings.map((f) => f.line_id));
    for (const id of ["L01", "L02", "L03", "L05", "L20", "L15", "L16", "L17"]) expect(flagged.has(id), id).toBe(false);
  });

  it("the 3 ply BF 18.2 clears the six 3 ply lines that need BF 18, so only the planted 5 ply trap fires", () => {
    expect(findings.filter((f) => f.sample.ply === 3)).toEqual([]);
    expect(findings.map((f) => f.line_id)).toEqual(["L04", "L06", "L07", "L08", "L23"]);
  });

  it("a 3 ply reading below BF 18 would flag exactly those six lines", () => {
    const low: TestReportFields = { ...V3_REPORT, samples: [{ ply: 3, flute: "B", bf: 16.8 }] };
    expect(compareReportToLines(low, allQuoted("V3"), RFX_LINES).map((f) => f.line_id)).toEqual(BF18_3PLY);
  });

  it("ignores lines the vendor did not quote", () => {
    const quotes = allQuoted("V3");
    for (const x of quotes) if (x.line_id !== "L04") x.state = "MISSING";
    expect(compareReportToLines(V3_REPORT, quotes, RFX_LINES).map((f) => f.line_id)).toEqual(["L04"]);
  });

  it("matches by ply alone when the report gives no flute, and checks liner GSM too", () => {
    const r: TestReportFields = { ...V3_REPORT, samples: [{ ply: 7, liner_gsm: 180, bf: 25 }] };
    const f = compareReportToLines(r, allQuoted("V3"), RFX_LINES);
    expect(f.map((x) => [x.line_id, x.field])).toEqual([["L15", "liner_gsm"], ["L16", "liner_gsm"], ["L17", "liner_gsm"]]);
  });

  it("with two samples for one board, the weaker reading counts", () => {
    const r: TestReportFields = { ...V3_REPORT, samples: [{ ply: 7, flute: "BCB", bf: 25.1 }, { ply: 7, flute: "BCB", bf: 23.9 }] };
    expect(compareReportToLines(r, allQuoted("V3"), RFX_LINES).map((x) => x.reported)).toEqual([23.9, 23.9, 23.9]);
  });

  it("V2's report clears every line", () => {
    expect(compareReportToLines(V2_TEST_REPORT, allQuoted("V2"), RFX_LINES)).toEqual([]);
  });
});

describe("report findings feed the strict spec policy (spec 17.11)", () => {
  it("V3 loses L04, L06, L07, L08, L23 under strict, keeps them under allow_deviations", () => {
    const quotes = applyReportFindings(allQuoted("V3"), compareReportToLines(V3_REPORT, allQuoted("V3"), RFX_LINES).filter((f) => f.sample.ply === 5));
    const run = (spec_policy: "strict" | "allow_deviations") =>
      allocate(RFX_LINES, [vendor("V3", quotes, "PASS", assessment())], { ...DEFAULT_POLICY, spec_policy }, config.exposure.safe_states);
    expect(run("strict").unfillable).toEqual(["L04", "L06", "L07", "L08", "L23"]);
    expect(run("allow_deviations").unfillable).toEqual([]);
    const l04 = run("strict").assignments.find((a) => a.line_id === "L04")!;
    expect(l04.rejected[0]!.reason).toBe("spec deviation: Test report shows BF 19.5 for 5 ply BC; L04 requires BF 22.");
  });

  it("does not change the inputs or any price", () => {
    const before = allQuoted("V3");
    const snapshot = JSON.stringify(before);
    const after = applyReportFindings(before, compareReportToLines(V3_REPORT, before, RFX_LINES));
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after.map((x) => x.landed)).toEqual(before.map((x) => x.landed));
    expect(after.find((x) => x.line_id === "L04")!.spec_flags[0]).toMatchObject({ source: "test_report", field: "bf", offered: 19.5 });
  });
});

describe("checkDeviationClaim (trap 03, spec E02)", () => {
  let v1Quotes: Quote[];
  beforeAll(async () => {
    const wb = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
    v1Quotes = buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb, textNative: true }).quotes;
  });
  const q12 = QUESTIONS.find((x) => x.claim_check === "no_spec_deviations")!;

  it("the claim to check is named in the RFx data", () => {
    expect(q12.q_id).toBe("Q12");
  });

  it("V1 answers 'No deviations.' while its own sheet offers 120 GSM / BF 16 on four lines: contradiction", () => {
    const answer = V1_QA.find(([id]) => id === "Q12")![2];
    const c = checkDeviationClaim(q12.q_id, answer, v1Quotes)!;
    expect(c).toMatchObject({ kind: "claim_vs_evidence", q_id: "Q12", claim: "No deviations.", lines: ["L01", "L02", "L03", "L05"] });
    expect(c.evidence[0]).toBe("L01: liner_gsm 120 offered vs 150 required (offer)");
  });

  it("a deviation shown only by the test report also contradicts the claim, and says so", () => {
    const quotes = applyReportFindings(allQuoted("V3"), compareReportToLines(V3_REPORT, allQuoted("V3"), RFX_LINES));
    const c = checkDeviationClaim("Q12", "None", quotes)!;
    expect(c.lines).toContain("L04");
    expect(c.evidence.find((e) => e.startsWith("L04"))).toBe("L04: Test report shows BF 19.5 for 5 ply BC; L04 requires BF 22. (test report)");
  });

  it("no contradiction when the vendor discloses, does not answer, or has only upgrades", () => {
    expect(checkDeviationClaim("Q12", "Yes: L01, L02, L03, L05 on 120 GSM liner", v1Quotes)).toBeNull();
    expect(checkDeviationClaim("Q12", null, v1Quotes)).toBeNull();
    const upgrade = [q("V9", "L01", 40, { specKinds: ["spec_upgrade"] })];
    expect(checkDeviationClaim("Q12", "No deviations", upgrade)).toBeNull();
  });
});

describe("grade-aware sample matching (V1, spec 17.5)", () => {
  let v1Quotes: Quote[];
  let report: TestReportFields;
  beforeAll(async () => {
    const wb = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
    v1Quotes = buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb, textNative: true }).quotes;
    report = readTestReport((await parsePdf(await buildV1TestReport())).text);
  });

  it("the report, read from its PDF, holds two 5 ply BC samples: the lighter 120 GSM and the full 180 GSM", () => {
    expect(report.samples.filter((s) => s.ply === 5).map((s) => [s.liner_gsm, s.bf])).toEqual([[120, 16.3], [180, 22.5]]);
  });

  it("the 120 GSM sample speaks only for the lines offered on it; the full spec 5 ply lines are judged on the 180 sample", () => {
    const f = compareReportToLines(report, v1Quotes, RFX_LINES);
    expect([...new Set(f.map((x) => x.line_id))]).toEqual(["L01", "L02", "L03", "L05"]);
    expect(f.filter((x) => x.line_id === "L01").map((x) => x.detail)).toEqual([
      "Test report shows BF 16.3 for 5 ply BC; L01 requires BF 18.",
      "Test report shows liner GSM 120 for 5 ply BC; L01 requires liner GSM 150.",
    ]);
  });

  it("with no sample at the offered grade, every sample of that board counts, weakest first (unchanged)", () => {
    // V1's 3 ply 120 GSM lines and 150 GSM lines each have their own sample; drop the 150 one and the 120 one speaks.
    const only120 = { ...report, samples: report.samples.filter((s) => !(s.ply === 3 && s.liner_gsm === 150)) };
    const f = compareReportToLines(only120, v1Quotes, RFX_LINES).filter((x) => x.sample.ply === 3);
    expect([...new Set(f.map((x) => x.line_id))]).toEqual(["L12", "L14", "L22", "L24", "L29"]);
  });
});
