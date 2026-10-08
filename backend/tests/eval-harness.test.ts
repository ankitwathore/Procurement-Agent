import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { answersFromExtraction, questionnaireFindings } from "../src/evidence/answers.js";
import { summarizeGates } from "../src/evidence/gates.js";
import { evaluate, regressionGate, toMarkdown, type EvalInput, type EvalVendor } from "../src/eval/harness.js";
import { V1_QA, V1_TUNED, buildV1Workbook, v1GroundTruth, v1Traps } from "../src/generator/v1.js";
import { V5_TUNED, buildV5Eml, v5GroundTruth, v5Traps } from "../src/generator/v5.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { parseXlsx } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type BuildResult, type Quote } from "../src/ingest/quotes.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";
import { v5Extraction } from "./fixtures/v5.js";

const SAFE = config.exposure.safe_states;
let v1: EvalVendor;
let v5: EvalVendor;
let gt: EvalInput["gt"];

function evalVendor(id: string, format: EvalVendor["format"], built: BuildResult, extraction: EvalVendor["extraction"], over: Partial<EvalVendor> = {}): EvalVendor {
  return {
    vendor_id: id,
    format,
    quotes: built.quotes,
    vendor: built.vendor,
    extraction,
    extras: built.extras,
    injection_findings: 0,
    gates: summarizeGates(QUESTIONS, { vendor_name: id, answers: {}, certificate: null, test_report: null, offered_plies: [] }, config),
    findings: { hedged: [], contradictions: [], unanswered: [] },
    report_findings: [],
    clarification_lines: [],
    duplicates: [],
    cost_usd: 0.1,
    ms: 30_000,
    ...over,
  };
}

beforeAll(async () => {
  const { buffer, content } = await buildV1Workbook(42, 1);
  const wb = await parseXlsx(buffer);
  const e1 = v1Extraction(wb);
  const b1 = buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: e1, sourceText: wb.text, workbook: wb, textNative: true });
  const answers = answersFromExtraction(V1_QA.map(([q_id, , a]) => ({ q_id, answer_raw: a, snippet: a })), QUESTIONS, { text: wb.text }).answers;
  v1 = evalVendor("V1", "xlsx", b1, e1, { findings: questionnaireFindings(QUESTIONS, answers, b1.quotes), clarification_lines: ["L06"] });

  const email = await parseEmail(buildV5Eml());
  const e5 = v5Extraction(email.text);
  const b5 = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: e5, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
  v5 = evalVendor("V5", "email", b5, e5, { authoritative_end: email.new_text_end });

  const traps = { ...v1Traps(V1_TUNED, content), ...v5Traps(V5_TUNED) };
  // Only the traps these tests look at, so "runnable" stays small and exact.
  gt = { vendors: { V1: v1GroundTruth(content) as never, V5: v5GroundTruth() as never }, traps: { "04": traps["04"]!, "35": traps["35"]!, "37": traps["37"]!, "33": { vendor: "All", what: "landed ranking differs from headline ranking" } } as never };
});

const run = (vendors: EvalVendor[]) => evaluate({ set: "tuned", vendors, gt, safeStates: SAFE });
const withQuote = (v: EvalVendor, line: string, f: (q: Quote) => Quote): EvalVendor => ({ ...v, quotes: v.quotes.map((q) => (q.line_id === line ? f(q) : q)) });

describe("evaluate on stand-in extractions of V1 and V5", () => {
  it("calibration: CONFIRMED all correct; the one wrong value (L06 slip) was flagged", () => {
    const r = run([v1, v5]);
    expect(r.confirmed_precision).toBe(1);
    expect(r.wrong_cells).toEqual({ total: 1, flagged_unsafe: 1, recall: 1, cells: ["V1:L06"] });
    expect(r.dangerous_rate).toBe(0);
    expect(r.headline).toMatch(/^When the system says CONFIRMED, it is right 100\.0% of the time \(\d+ of \d+\), and it flags 100\.0% of its own mistakes \(1 of 1\)\.$/);
    expect(r.calibration.find((c) => c.state === "MISSING")).toMatchObject({ cells: 2, correct: 2 });
  });

  it("per format and per vendor metrics, quoted detection counts V5's inferred lines as quoted", () => {
    const r = run([v1, v5]);
    expect(Object.keys(r.per_format)).toEqual(["xlsx", "email"]);
    expect(r.per_vendor.V5!.quoted).toMatchObject({ tp: 30, fp: 0, fn: 0 });
    expect(r.per_vendor.V1!.quoted).toMatchObject({ tp: 28, fp: 0, fn: 0 });
  });

  it("trap checks pass here, and the ranking flip (33) without V4 in the run is not_run, never a pass", () => {
    const r = run([v1, v5]);
    expect(r.traps.filter((t) => ["04", "35", "37"].includes(t.id)).map((t) => t.status)).toEqual(["pass", "pass", "pass"]);
    expect(r.traps.find((t) => t.id === "33")).toMatchObject({ status: "not_run" });
    expect(r.trap_recall.runnable).toBe(3);
  });
});

describe("the harness catches what it exists to catch", () => {
  it("a slip shown as CONFIRMED is a dangerous error: precision drops, recall drops, trap 04 fails", () => {
    const bad = withQuote(v1, "L06", (q) => ({ ...q, state: "CONFIRMED", flags: [] }));
    const r = run([bad, v5]);
    expect(r.overall.dangerous).toEqual(["V1:L06"]);
    expect(r.confirmed_precision).toBeLessThan(1);
    expect(r.wrong_cells.recall).toBe(0);
    expect(r.traps.find((t) => t.id === "04")!.status).toBe("fail");
    expect(r.targets.find((t) => t.metric === "Precision of CONFIRMED")!.status).toBe("missed");
  });

  it("an INFERRED range that does not contain the true value is counted wrong", () => {
    const narrow = withQuote(v5, "L01", (q) => ({ ...q, landed: { point: q.landed!.point * 1.2, low: q.landed!.point * 1.15, high: q.landed!.point * 1.25 } }));
    const inferred = run([narrow]).calibration.find((c) => c.state === "INFERRED")!;
    expect(inferred.cells - inferred.correct).toBe(1);
  });

  it("a value from quoted history fails trap 37", () => {
    const leak = withQuote(v5, "L23", (q) => ({ ...q, components: q.components.map((c) => ({ ...c, provenance: { ...c.provenance, locator: { ...c.provenance.locator, char_end: 10_000 } } })) }));
    expect(run([leak]).traps.find((t) => t.id === "37")!.status).toBe("fail");
  });

  it("a quoted line reported MISSING is a coverage error and an unflagged wrong cell", () => {
    const lost = withQuote(v1, "L02", (q) => ({ ...q, state: "MISSING", components: [], landed: null }));
    const r = run([lost]);
    expect(r.per_vendor.V1!.quoted.fn).toBe(1);
    expect(r.wrong_cells.cells).toContain("V1:L02");
    expect(r.wrong_cells.flagged_unsafe).toBe(1); // only L06
  });

  it("a vendor not in the run makes its traps not_run, never pass", () => {
    expect(run([v1]).traps.find((t) => t.id === "37")!.status).toBe("not_run");
  });
});

describe("regression gate (spec 19.8) and the report", () => {
  it("fails on lower CONFIRMED precision or a higher dangerous rate; passes otherwise or with no history", () => {
    expect(regressionGate({ confirmed_precision: 1, dangerous_rate: 0 }, null).failed).toBe(false);
    expect(regressionGate({ confirmed_precision: 1, dangerous_rate: 0 }, { confirmed_precision: 1, dangerous_rate: 0 }).failed).toBe(false);
    expect(regressionGate({ confirmed_precision: 0.98, dangerous_rate: 0 }, { confirmed_precision: 1, dangerous_rate: 0 }).reasons).toEqual(["CONFIRMED precision fell from 100.0% to 98.0%"]);
    expect(regressionGate({ confirmed_precision: 1, dangerous_rate: 0.01 }, { confirmed_precision: 1, dangerous_rate: 0 }).failed).toBe(true);
  });

  it("the Markdown report carries the headline, the calibration table and the trap table", () => {
    const md = toMarkdown(run([v1, v5]), { date: "2026-10-08", regression: { failed: false, reasons: [] }, notes: ["Holdout not generated."] });
    expect(md).toContain("**When the system says CONFIRMED");
    expect(md).toContain("| Reported state | Cells | Actually correct | Precision |");
    expect(md).toContain("| 33 | All | not_run |");
    expect(md).toContain("- Holdout not generated.");
  });
});
