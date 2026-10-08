import { beforeAll, describe, expect, it } from "vitest";
import { evaluateIsoGate } from "../src/evidence/certificates.js";
import { evaluateTestReportGate } from "../src/evidence/gates.js";
import { V1_CERTIFICATE, V1_TEST_REPORT, buildV1Certificate, buildV1TestReport } from "../src/generator/v1.js";
import { V2_CERTIFICATE, buildV2Certificate } from "../src/generator/v2.js";
import { EVIDENCE_SCHEMA, parseWrittenDate, runEvidencePass, verifyEvidence } from "../src/ingest/extract_evidence.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import type { JsonRequest, JsonResponse, LlmClient } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import { config } from "./fixtures/quotes.js";

class StubLlm implements LlmClient {
  requests: JsonRequest[] = [];
  constructor(private readonly respond: (req: JsonRequest) => Partial<JsonResponse> | Error) {}
  async json(req: JsonRequest): Promise<JsonResponse> {
    this.requests.push(req);
    const r = this.respond(req);
    if (r instanceof Error) throw r;
    const usage = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return { text: null, stop_reason: "end_turn", model: req.model, fallback_used: false, usage, cost_usd: costUsd(req.model, usage), ms: 42, ...r };
  }
}

const emptyCert = { cert_type: "", number: "", issuer: "", entity_name: "", scope: "", valid_from: "", valid_to: "", validity_snippet: "" };
const emptyReport = { lab: "", report_no: "", report_date: "", header_snippet: "", samples: [] as Record<string, string>[] };

/** What a correct reading of V1's certificate looks like: everything as written. */
const v1CertReading = () => ({
  doc_role: "certificate",
  certificate: {
    cert_type: "ISO 9001:2015",
    number: "IQA/QMS/2024/1187",
    issuer: "Indus Quality Assurance Services (fictional)",
    entity_name: "Shree Ganesh Corrugators, Chakan Industrial Area, Pune",
    scope: "Manufacture of corrugated boxes and board",
    valid_from: "15-03-2024",
    valid_to: "14-03-2027",
    validity_snippet: "Valid from: 15-03-2024 | Valid until: 14-03-2027",
  },
  test_report: emptyReport,
  notes: [],
});

const row = (ply: string, flute: string, gsm: string, bf: string) => ({ ply, flute, liner_gsm: gsm, bf, row_text: `${ply} | ${flute} | ${gsm} | ${bf}` });
const v1ReportReading = () => ({
  doc_role: "test_report",
  certificate: emptyCert,
  test_report: {
    lab: "Deccan Packaging Test Centre (fictional)",
    report_no: "DPTC/2026/0612",
    report_date: "10-06-2026",
    header_snippet: "Test Report No: DPTC/2026/0612 | Date: 10-06-2026",
    samples: [row("3", "B", "120", "16.6"), row("3", "B", "150", "18.7"), row("5", "BC", "120", "16.3"), row("5", "BC", "180", "22.5"), row("7", "BCB", "200", "24.7")],
  },
  notes: [],
});

let certText: string, reportText: string, v2CertText: string;
beforeAll(async () => {
  certText = (await parsePdf(await buildV1Certificate())).text;
  reportText = (await parsePdf(await buildV1TestReport())).text;
  v2CertText = (await parsePdf(await buildV2Certificate())).text;
});

describe("parseWrittenDate", () => {
  it("reads numeric dates day first, and month names either way", () => {
    expect(parseWrittenDate("14-03-2027")).toBe("2027-03-14");
    expect(parseWrittenDate("04/03/2027")).toBe("2027-03-04"); // 4 March, not 3 April
    expect(parseWrittenDate("14.03.2027")).toBe("2027-03-14");
    expect(parseWrittenDate("2027-03-14")).toBe("2027-03-14");
    expect(parseWrittenDate("14th March 2027")).toBe("2027-03-14");
    expect(parseWrittenDate("14 Mar, 2027")).toBe("2027-03-14");
    expect(parseWrittenDate("March 14, 2027")).toBe("2027-03-14");
  });

  it("refuses what is not a real date", () => {
    for (const s of ["31-02-2027", "14-13-2027", "Q1 2027", "", "14 Smarch 2027"]) expect(parseWrittenDate(s), s).toBeNull();
  });
});

describe("verifyEvidence: a reading counts only if the document says it", () => {
  it("V1's certificate, read correctly, verifies and yields ISO dates", () => {
    const r = verifyEvidence(v1CertReading(), certText);
    expect(r.problems).toEqual([]);
    expect(r.certificate).toEqual({
      cert_type: "ISO 9001:2015",
      number: V1_CERTIFICATE.number,
      issuer: V1_CERTIFICATE.issuer,
      entity_name: V1_CERTIFICATE.entity,
      valid_from: "2024-03-15",
      valid_to: "2027-03-14",
      scope: V1_CERTIFICATE.scope,
    });
  });

  it("V1's test report, read correctly, verifies sample by sample", () => {
    const r = verifyEvidence(v1ReportReading(), reportText);
    expect(r.problems).toEqual([]);
    expect(r.test_report).toEqual({ lab: V1_TEST_REPORT.lab, report_no: V1_TEST_REPORT.report_no, report_date: "2026-06-10", samples: V1_TEST_REPORT.samples });
  });

  it("a date that is not in the document makes the certificate unread, so Q01 is UNKNOWN, not PASS", () => {
    const bad = v1CertReading();
    bad.certificate.valid_to = "14-03-2028"; // a hopeful reading
    const r = verifyEvidence(bad, certText);
    expect(r.certificate).toBeNull();
    expect(r.problems).toEqual(['valid to date "14-03-2028" is not in the document', "certificate counts as unread"]);
  });

  it("a sample that borrows a number from another row, or a row the document does not have, makes the report unread", () => {
    const borrowed = v1ReportReading();
    borrowed.test_report.samples[2] = { ...row("5", "BC", "120", "16.3"), bf: "18.7" };
    expect(verifyEvidence(borrowed, reportText).problems).toEqual(['sample 3: BF "18.7" is not in its row', "test report counts as unread"]);
    const invented = v1ReportReading();
    invented.test_report.samples.push(row("5", "BC", "150", "18.2"));
    const r = verifyEvidence(invented, reportText);
    expect(r.test_report).toBeNull();
    expect(r.problems[0]).toBe('sample 6: row "5 | BC | 150 | 18.2" is not in the document');
  });

  it("a wrong field nothing depends on is dropped and reported; the certificate still counts", () => {
    const r = verifyEvidence({ ...v1CertReading(), certificate: { ...v1CertReading().certificate, issuer: "Bureau Veritas" } }, certText);
    expect(r.certificate?.issuer).toBeNull();
    expect(r.certificate?.valid_to).toBe("2027-03-14");
    expect(r.problems).toEqual(['issuer "Bureau Veritas" is not in the document; dropped']);
  });

  it("the standard must be in the document too", () => {
    const r = verifyEvidence({ ...v1CertReading(), certificate: { ...v1CertReading().certificate, cert_type: "ISO 14001:2015" } }, certText);
    expect(r.certificate).toBeNull();
  });

  it("'other' documents yield neither section", () => {
    expect(verifyEvidence({ doc_role: "other", certificate: emptyCert, test_report: emptyReport, notes: [] }, certText)).toEqual({ doc_role: "other", certificate: null, test_report: null, problems: [] });
  });
});

describe("verified readings drive the gates", () => {
  it("V1: certificate valid and report covers 3, 5 and 7 ply: Q01 and Q02 PASS", () => {
    const cert = verifyEvidence(v1CertReading(), certText).certificate;
    expect(evaluateIsoGate("Yes - certificate attached (valid to 14-03-2027)", cert, "Shree Ganesh Corrugators", config).result).toBe("PASS");
    const report = verifyEvidence(v1ReportReading(), reportText).test_report;
    expect(evaluateTestReportGate("Yes - test report attached", report, [3, 5, 7], config).result).toBe("PASS");
  });

  it("V2: the certificate expired on 31-08-2026 (trap 09): Q01 FAIL", () => {
    const reading = {
      doc_role: "certificate",
      certificate: { ...emptyCert, cert_type: V2_CERTIFICATE.cert_type, entity_name: V2_CERTIFICATE.entity, scope: V2_CERTIFICATE.scope, valid_from: "01-09-2023", valid_to: "31-08-2026" },
      test_report: emptyReport,
      notes: [],
    };
    const cert = verifyEvidence(reading, v2CertText).certificate;
    expect(cert?.valid_to).toBe("2026-08-31");
    expect(evaluateIsoGate("Yes, ISO 9001 certificate attached", cert, "Ahmedabad Packwell Industries", config).result).toBe("FAIL");
  });
});

describe("runEvidencePass", () => {
  const opts = (client: LlmClient) => ({ client, config, vendorId: "V1", file: "V1/SGC_ISO9001_Certificate.pdf", now: () => new Date("2026-10-08T10:00:00Z") });

  it("one structured call with the evidence schema at low effort; the reading is verified", async () => {
    const stub = new StubLlm(() => ({ text: JSON.stringify(v1CertReading()) }));
    const r = await runEvidencePass(certText, opts(stub));
    const req = stub.requests[0]!;
    expect(req.schema).toBe(EVIDENCE_SCHEMA);
    expect(req.effort).toBe("low");
    expect(req.model).toBe(config.models.extract_a);
    expect(req.user).toContain("Shree Ganesh Corrugators, Chakan Industrial Area, Pune");
    expect(r.reading?.certificate?.valid_to).toBe("2027-03-14");
    expect(r.trace).toMatchObject({ step: "extract_evidence", file: "V1/SGC_ISO9001_Certificate.pdf", vendor_id: "V1", stop_reason: "end_turn" });
    expect(r.trace.prompt_version).toMatch(/^extract_evidence@[0-9a-f]{8}$/);
  });

  it("a failed call, a refusal or a cut-off leaves the document unread, never empty", async () => {
    for (const respond of [() => new Error("timeout"), () => ({ stop_reason: "refusal" }), () => ({ stop_reason: "max_tokens", text: "{" })]) {
      const r = await runEvidencePass(certText, opts(new StubLlm(respond)));
      expect(r.reading).toBeNull();
      expect(r.errors).toHaveLength(1);
    }
  });
});
