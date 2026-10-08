import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, allocate } from "../src/award/optimizer.js";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import type { CertificateFields } from "../src/evidence/certificates.js";
import { evaluateTestReportGate, evaluateYesGate, offeredPlies, summarizeGates, type TestReportFields, type VendorEvidence } from "../src/evidence/gates.js";
import { V1_QA } from "../src/generator/v1.js";
import { V2_CERTIFICATE, V2_QA, buildV2Quote, buildV2TestReport } from "../src/generator/v2.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { buildQuotes, type BuildResult } from "../src/ingest/quotes.js";
import { minusYears } from "../src/util/dates.js";
import { config, q } from "./fixtures/quotes.js"; // as_of 2026-10-08
import { readTestReport } from "./fixtures/evidence.js";
import { v2Extraction } from "./fixtures/v2.js";

const answersOf = (qa: [string, string, string][]) => Object.fromEntries(qa.map(([id, , a]) => [id, a]));

const report = (o: Partial<TestReportFields> = {}): TestReportFields => ({
  lab: "Some Lab",
  report_no: "R/1",
  report_date: "2026-04-15",
  samples: [{ ply: 3 }, { ply: 5 }, { ply: 7 }],
  ...o,
});

const validCert = (entity: string): CertificateFields => ({
  cert_type: "ISO 9001:2015",
  number: "X/1",
  issuer: "Body",
  entity_name: entity,
  valid_from: "2024-03-15",
  valid_to: "2027-03-14",
  scope: "Manufacture of corrugated boxes and board",
});

describe("minusYears", () => {
  it.each([
    ["2026-10-08", 1, "2025-10-08"],
    ["2028-02-29", 1, "2027-02-28"],
    ["2026-01-31", 2, "2024-01-31"],
  ])("%s - %d year -> %s", (iso, n, out) => {
    expect(minusYears(iso, n)).toBe(out);
  });
});

describe("offeredPlies", () => {
  it("lists the plies of quoted lines only; a vendor that skipped the 7 ply lines is not asked to test 7 ply", () => {
    const all = RFX_LINES.map((l) => q("V4", l.line_id, 10));
    for (const id of ["L15", "L16", "L17"]) all.find((x) => x.line_id === id)!.state = "MISSING";
    expect(offeredPlies(all, RFX_LINES)).toEqual([3, 5]);
    expect(offeredPlies(RFX_LINES.map((l) => q("V1", l.line_id, 10)), RFX_LINES)).toEqual([3, 5, 7]);
  });
});

describe("Q02: test report (spec 17.4)", () => {
  const gate = (answer: string | null, r: TestReportFields | null, plies = [3, 5, 7]) => evaluateTestReportGate(answer, r, plies, config);

  it("V2's real test report PDF covers 3, 5 and 7 ply within 12 months: PASS", async () => {
    const fields = readTestReport((await parsePdf(await buildV2TestReport())).text);
    expect(fields).toMatchObject({ report_no: "WPTL/2026/0388", report_date: "2026-04-15" });
    expect(fields.samples.map((s) => s.ply)).toEqual([3, 5, 7]);
    expect(gate("Yes, test report attached", fields)).toEqual({ result: "PASS", reason: "Dated 2026-04-15; covers the 3, 5, 7 ply board offered." });
  });

  it("trap 26: yes, but no report attached: FAIL as a claim without evidence (E04)", () => {
    expect(gate("Yes, attached", null).reason).toBe("Answered yes, but no test report was attached (claim without evidence).");
  });

  it("older than 12 months fails; exactly 12 months passes", () => {
    expect(gate("Yes", report({ report_date: "2025-10-07" })).result).toBe("FAIL");
    expect(gate("Yes", report({ report_date: "2025-10-08" })).result).toBe("PASS");
  });

  it("a report missing a ply the vendor offers fails, and says which", () => {
    const d = gate("Yes", report({ samples: [{ ply: 3 }, { ply: 5 }] }));
    expect(d).toEqual({ result: "FAIL", reason: "The test report has no 7 ply sample, which this vendor offers." });
    expect(gate("Yes", report({ samples: [{ ply: 3 }, { ply: 5 }] }), [3, 5]).result).toBe("PASS");
  });

  it("an unreadable or future date, a hedge, or no answer is UNKNOWN", () => {
    expect(gate("Yes", report({ report_date: null })).result).toBe("UNKNOWN");
    expect(gate("Yes", report({ report_date: "2026-12-01" })).result).toBe("UNKNOWN");
    expect(gate("Yes, for 5 ply only, partly", report()).result).toBe("UNKNOWN");
    expect(gate(null, null).result).toBe("UNKNOWN");
  });
});

describe("Q03: plain yes gate", () => {
  it("yes passes, no fails, a hedge is unknown", () => {
    expect(evaluateYesGate("Yes, 12 years").result).toBe("PASS");
    expect(evaluateYesGate("No").result).toBe("FAIL");
    expect(evaluateYesGate("Yes, but only for small appliances").result).toBe("UNKNOWN");
  });
});

describe("summarizeGates: the vendor's questionnaire result (spec 17.11)", () => {
  const evidence = (o: Partial<VendorEvidence>): VendorEvidence => ({
    vendor_name: "X",
    answers: {},
    certificate: null,
    test_report: null,
    offered_plies: [3, 5, 7],
    ...o,
  });
  const v2Evidence = (): VendorEvidence =>
    evidence({
      vendor_name: "Ahmedabad Packwell Industries",
      answers: answersOf(V2_QA),
      certificate: { cert_type: V2_CERTIFICATE.cert_type, number: V2_CERTIFICATE.number, issuer: V2_CERTIFICATE.issuer, entity_name: V2_CERTIFICATE.entity, valid_from: V2_CERTIFICATE.valid_from, valid_to: V2_CERTIFICATE.valid_to, scope: V2_CERTIFICATE.scope },
      test_report: report(),
    });

  it("dispatches on each gate's rule from the RFx data, not on question numbers", () => {
    expect(QUESTIONS.filter((x) => x.is_gate).map((x) => [x.q_id, x.pass_check])).toEqual([
      ["Q01", "valid_certificate"],
      ["Q02", "test_report_covers_offered_plies"],
      ["Q03", "answer_yes"],
    ]);
  });

  it("V1: all three gates pass", () => {
    const s = summarizeGates(QUESTIONS, evidence({ vendor_name: "Shree Ganesh Corrugators", answers: answersOf(V1_QA), certificate: validCert("Shree Ganesh Corrugators, Chakan"), test_report: report() }), config);
    expect(s.overall).toBe("PASS");
    expect(s.gates.map((g) => g.result)).toEqual(["PASS", "PASS", "PASS"]);
    expect(s.headline).toBe("Cleared all gates.");
  });

  it("V2: the expired certificate fails Q01, so V2 is not cleared", () => {
    const s = summarizeGates(QUESTIONS, v2Evidence(), config);
    expect(s.overall).toBe("FAIL");
    expect(s.gates.find((g) => g.q_id === "Q01")).toMatchObject({ result: "FAIL", reason: "Expired on 2026-08-31, before today (2026-10-08)." });
    expect(s.headline).toBe("Not cleared: failed Q01.");
  });

  it("V2 with Q01 waived by the buyer, with a reason: WAIVED", () => {
    const s = summarizeGates(QUESTIONS, v2Evidence(), config, [{ q_id: "Q01", reason: "Renewal audit booked; certificate expected 15 Oct", actor: "Meera" }]);
    expect(s.overall).toBe("WAIVED");
    expect(s.gates[0]!.waiver).toMatchObject({ actor: "Meera" });
    expect(s.headline).toBe("Cleared, with Q01 waived by the buyer.");
  });

  it("trap 31, V5: no answers at all is UNKNOWN, not cleared by default (E09, D23)", () => {
    const s = summarizeGates(QUESTIONS, evidence({ vendor_name: "Jai Bharat Boards" }), config);
    expect(s.overall).toBe("UNKNOWN");
    expect(s.headline).toBe("Not cleared: no answers received.");
  });

  it("trap 26, V4-like: claims a test report it did not attach, so Q02 fails", () => {
    const s = summarizeGates(QUESTIONS, evidence({ vendor_name: "Delhi Carton Works", answers: { Q01: "Yes", Q02: "Yes, attached", Q03: "Yes" }, certificate: validCert("Delhi Carton Works"), offered_plies: [3, 5] }), config);
    expect(s.overall).toBe("FAIL");
    expect(s.gates.map((g) => [g.q_id, g.result])).toEqual([["Q01", "PASS"], ["Q02", "FAIL"], ["Q03", "PASS"]]);
  });

  it("FAIL outranks UNKNOWN; a waiver needs a reason; a waiver on a passing gate changes nothing", () => {
    const mixed = summarizeGates(QUESTIONS, evidence({ answers: { Q01: "Yes", Q02: "Yes, partly", Q03: "No" } }), config);
    expect(mixed.overall).toBe("FAIL");
    expect(() => summarizeGates(QUESTIONS, v2Evidence(), config, [{ q_id: "Q01", reason: "  ", actor: "Meera" }])).toThrow(/needs a reason/);
    const v1 = evidence({ vendor_name: "Shree Ganesh Corrugators", answers: answersOf(V1_QA), certificate: validCert("Shree Ganesh Corrugators"), test_report: report() });
    expect(summarizeGates(QUESTIONS, v1, config, [{ q_id: "Q03", reason: "just in case", actor: "Meera" }]).overall).toBe("PASS");
  });
});

describe("G7: 'What if we waive V2's expired certificate?' (gates feed the optimizer)", () => {
  let built: BuildResult;
  beforeAll(async () => {
    const pdf = await parsePdf((await buildV2Quote(42)).buffer);
    built = buildQuotes({ vendorId: "V2", vendorCity: "Ahmedabad", config, lines: RFX_LINES, extraction: v2Extraction(pdf), sourceText: pdf.text, pdf, textNative: true });
  });

  const gateFor = (waive: boolean) =>
    summarizeGates(
      QUESTIONS,
      {
        vendor_name: "Ahmedabad Packwell Industries",
        answers: answersOf(V2_QA),
        certificate: { cert_type: V2_CERTIFICATE.cert_type, number: V2_CERTIFICATE.number, issuer: V2_CERTIFICATE.issuer, entity_name: V2_CERTIFICATE.entity, valid_from: V2_CERTIFICATE.valid_from, valid_to: V2_CERTIFICATE.valid_to, scope: V2_CERTIFICATE.scope },
        test_report: report(),
        offered_plies: offeredPlies(built.quotes, RFX_LINES),
      },
      config,
      waive ? [{ q_id: "Q01", reason: "Renewal in progress", actor: "Meera" }] : [],
    ).overall;

  it("without the waiver, V2 is excluded under 'cleared only' and the reason is the gate", () => {
    const r = allocate(RFX_LINES, [{ vendor_id: "V2", quotes: built.quotes, assessment: built.vendor, gate: gateFor(false) }], DEFAULT_POLICY, config.exposure.safe_states);
    expect(r.excluded_vendors).toEqual([{ vendor_id: "V2", reason: "not cleared on the questionnaire gates (FAIL)" }]);
    expect(r.unfillable).toHaveLength(30);
  });

  it("with the waiver, V2 is eligible, wins every line alone, and earns its 5 percent", () => {
    const r = allocate(RFX_LINES, [{ vendor_id: "V2", quotes: built.quotes, assessment: built.vendor, gate: gateFor(true) }], DEFAULT_POLICY, config.exposure.safe_states);
    expect(r.excluded_vendors).toEqual([]);
    expect(r.vendors[0]!.discount!.applies).toBe(true);
  });
});
