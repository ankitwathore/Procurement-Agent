import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { answersFromExtraction, questionnaireFindings, type ExtractedAnswer } from "../src/evidence/answers.js";
import { summarizeGates, type VendorEvidence } from "../src/evidence/gates.js";
import { V1_QA, buildV1Certificate, buildV1TestReport, buildV1Workbook } from "../src/generator/v1.js";
import { offeredPlies } from "../src/evidence/gates.js";
import { V2_QA, buildV2Certificate, buildV2Quote, buildV2TestReport } from "../src/generator/v2.js";
import { V3_QA, buildV3Quote } from "../src/generator/v3.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { parseDocx } from "../src/ingest/parse_docx.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { parseXlsx } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import { readCertificate, readTestReport } from "./fixtures/evidence.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";

/** What pass A emits for a questionnaire: the answer as written, and the text it sits in. */
const asPassA = (qa: [string, string, string][]): ExtractedAnswer[] => qa.map(([q_id, , a]) => ({ q_id, answer_raw: a, snippet: a }));

let v1Text: string, v2Text: string, v3Text: string;
let v1Quotes: Quote[];
beforeAll(async () => {
  const wb = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
  v1Text = wb.text;
  v2Text = (await parsePdf((await buildV2Quote(42)).buffer)).text;
  v3Text = (await parseDocx((await buildV3Quote(42)).buffer)).text;
  v1Quotes = buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb, textNative: true }).quotes;
});

describe("answersFromExtraction: answers are checked like prices", () => {
  it("all twelve answers of V1 (Excel), V2 (PDF) and V3 (Word) are found in the vendor's own document", () => {
    for (const [qa, text] of [[V1_QA, v1Text], [V2_QA, v2Text], [V3_QA, v3Text]] as const) {
      const r = answersFromExtraction(asPassA(qa), QUESTIONS, { text });
      expect(r.rejected).toEqual([]);
      expect(Object.keys(r.answers)).toHaveLength(12);
    }
  });

  it("rejects an unknown question, an answer not in the document, and an answer that is not the vendor's words", () => {
    const r = answersFromExtraction(
      [
        { q_id: "Q99", answer_raw: "Yes", snippet: "Yes" },
        { q_id: "Q01", answer_raw: "Yes", snippet: "Yes, ISO 9001:2015 certified by TUV" },
        { q_id: "Q03", answer_raw: "Yes, more than three years", snippet: "Yes - 8 years" },
      ],
      QUESTIONS,
      { text: v1Text },
    );
    expect(r.rejected).toEqual([
      { q_id: "Q99", reason: "unknown question Q99" },
      { q_id: "Q01", reason: "snippet is not in the vendor's own text" },
      { q_id: "Q03", reason: "answer is not the vendor's words in the snippet" },
    ]);
    expect(r.answers).toEqual({});
  });

  it("an answer found only in quoted history does not count (spec F11)", async () => {
    const email = await parseEmail(buildV5Eml());
    const quoted = "Responses are due by 23 September 2026.";
    expect(email.text.indexOf(quoted)).toBeGreaterThan(email.new_text_end);
    const r = answersFromExtraction([{ q_id: "Q11", answer_raw: "23 September 2026", snippet: quoted }], QUESTIONS, { text: email.text, authoritativeEnd: email.new_text_end });
    expect(r.rejected).toEqual([{ q_id: "Q11", reason: "snippet is not in the vendor's own text" }]);
  });

  it("a question answered two ways counts as unanswered; the same answer twice is fine", () => {
    const yes = { q_id: "Q03", answer_raw: "Yes - 8 years", snippet: "Yes - 8 years" };
    expect(answersFromExtraction([yes, yes], QUESTIONS, { text: v1Text }).answers).toEqual({ Q03: "Yes - 8 years" });
    const r = answersFromExtraction([yes, { q_id: "Q03", answer_raw: "No", snippet: "No" }], QUESTIONS, { text: v1Text });
    expect(r.answers.Q03).toBeUndefined();
    expect(r.rejected[0]!.reason).toMatch(/^answered more than one way/);
  });

  it("an empty answer is simply unanswered, not an error", () => {
    const r = answersFromExtraction([{ q_id: "Q04", answer_raw: "", snippet: "" }], QUESTIONS, { text: v1Text });
    expect(r).toEqual({ answers: {}, snippets: {}, rejected: [] });
  });
});

describe("questionnaireFindings", () => {
  it("V1: 'No deviations.' is contradicted by its own 120 GSM offer on L01, L02, L03, L05 (trap 03)", () => {
    const { answers } = answersFromExtraction(asPassA(V1_QA), QUESTIONS, { text: v1Text });
    const f = questionnaireFindings(QUESTIONS, answers, v1Quotes);
    expect(f.contradictions.map((c) => [c.q_id, c.lines])).toEqual([["Q12", ["L01", "L02", "L03", "L05"]]]);
    expect(f.hedged).toEqual([]);
    expect(f.unanswered).toEqual([]);
  });

  it("V2 and V3: conditional answers are hedged and kept verbatim (traps 13, 19); V2's 'On request' too", () => {
    const v2 = questionnaireFindings(QUESTIONS, answersFromExtraction(asPassA(V2_QA), QUESTIONS, { text: v2Text }).answers, []);
    expect(v2.hedged).toEqual([
      { q_id: "Q04", answer: "On request" },
      { q_id: "Q07", answer: "Yes, subject to 2 percent monthly interest beyond 30 days." },
    ]);
    const v3 = questionnaireFindings(QUESTIONS, answersFromExtraction(asPassA(V3_QA), QUESTIONS, { text: v3Text }).answers, []);
    expect(v3.hedged).toEqual([{ q_id: "Q07", answer: "No: 100 percent advance for imported items, net 30 for others." }]);
  });

  it("number and text questions are never called hedged", () => {
    expect(questionnaireFindings(QUESTIONS, { Q06: "12 to 15", Q10: "Ahmedabad, about 660 km" }, []).hedged).toEqual([]);
  });
});

describe("gates read the verified answers", () => {
  const evidence = (answers: Record<string, string>, over: Partial<VendorEvidence> = {}): VendorEvidence => ({
    vendor_name: "Ahmedabad Packwell Industries",
    answers,
    certificate: null,
    test_report: null,
    offered_plies: [3, 5, 7],
    ...over,
  });

  it("a yes resting on an attached document not yet read is UNKNOWN, not FAIL", () => {
    const { answers } = answersFromExtraction(asPassA(V2_QA), QUESTIONS, { text: v2Text });
    const s = summarizeGates(QUESTIONS, evidence(answers, { unread: ["certificate", "test_report"] }), config);
    expect(s.gates.map((g) => [g.q_id, g.result])).toEqual([["Q01", "UNKNOWN"], ["Q02", "UNKNOWN"], ["Q03", "PASS"]]);
    expect(s.gates[0]!.reason).toBe('Answered yes ("Yes, ISO 9001 certificate attached"); the attached certificate has not been read yet.');
    expect(s.overall).toBe("UNKNOWN");
  });

  it("nothing attached at all is still a FAIL on a yes (claim without evidence)", () => {
    const { answers } = answersFromExtraction(asPassA(V2_QA), QUESTIONS, { text: v2Text });
    expect(summarizeGates(QUESTIONS, evidence(answers), config).gates[0]!.result).toBe("FAIL");
  });

  it("V1 with its certificate and test report read: all three gates PASS, as in ground truth", async () => {
    const { answers } = answersFromExtraction(asPassA(V1_QA), QUESTIONS, { text: v1Text });
    const certificate = readCertificate((await parsePdf(await buildV1Certificate())).text);
    const test_report = readTestReport((await parsePdf(await buildV1TestReport())).text);
    const s = summarizeGates(QUESTIONS, evidence(answers, { vendor_name: "Shree Ganesh Corrugators", certificate, test_report, offered_plies: offeredPlies(v1Quotes, RFX_LINES) }), config);
    expect(s.gates.map((g) => [g.q_id, g.result])).toEqual([["Q01", "PASS"], ["Q02", "PASS"], ["Q03", "PASS"]]);
  });

  it("V2 with its certificate and test report read: Q01 FAIL (expired), Q02 and Q03 PASS, as in ground truth", async () => {
    const { answers } = answersFromExtraction(asPassA(V2_QA), QUESTIONS, { text: v2Text });
    const certificate = readCertificate((await parsePdf(await buildV2Certificate())).text);
    const test_report = readTestReport((await parsePdf(await buildV2TestReport())).text);
    const s = summarizeGates(QUESTIONS, evidence(answers, { certificate, test_report }), config);
    expect(s.gates.map((g) => [g.q_id, g.result])).toEqual([["Q01", "FAIL"], ["Q02", "PASS"], ["Q03", "PASS"]]);
  });
});
