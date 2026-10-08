import type { Config } from "../config.js";
import type { GateResult as VendorGate } from "../award/optimizer.js";
import type { Quote } from "../ingest/quotes.js";
import type { Question, RfxLine } from "../schemas.js";
import { isIsoDate, minusYears } from "../util/dates.js";
import { classifyAnswer, evaluateIsoGate, type CertificateFields, type GateDecision } from "./certificates.js";

/**
 * Questionnaire gates (spec 10.9, 15.2, 17.4, D23). Each gate question names its rule in the RFx data
 * (`pass_check`); this module dispatches on the rule, never on the question number.
 * Missing or conditional answers are UNKNOWN, which is not cleared by default; a buyer waiver needs a reason.
 */

export interface TestReportFields {
  lab: string | null;
  report_no: string | null;
  report_date: string | null;
  samples: { ply: number | null; flute?: string | null; liner_gsm?: number | null; bf?: number | null }[];
}

type DateConfig = Pick<Config, "as_of_date" | "expected_award_date">;

/** Plies the vendor quotes for: the RFx ply of every line it did not leave MISSING. */
export function offeredPlies(quotes: readonly Quote[], lines: readonly RfxLine[]): number[] {
  const plies = new Set<number>();
  for (const q of quotes) {
    if (q.state === "MISSING") continue;
    const line = lines.find((l) => l.line_id === q.line_id);
    const ply = line?.spec.ply ?? null;
    if (ply !== null) plies.add(ply);
  }
  return [...plies].sort((a, b) => a - b);
}

/** Q02 rule: yes, a report attached, dated within 12 months, with a sample for every ply offered. */
export function evaluateTestReportGate(
  answer: string | null | undefined,
  report: TestReportFields | null,
  plies: readonly number[],
  cfg: DateConfig,
): GateDecision {
  const kind = classifyAnswer(answer);
  if (kind === "unanswered") return { result: "UNKNOWN", reason: "Not answered." };
  if (kind === "hedged") return { result: "UNKNOWN", reason: `Answer is conditional and cannot be scored: "${answer}".` };
  if (kind === "no") return { result: "FAIL", reason: `Answered no: "${answer}".` };
  if (!report) return { result: "FAIL", reason: "Answered yes, but no test report was attached (claim without evidence)." };

  if (!report.report_date || !isIsoDate(report.report_date)) return { result: "UNKNOWN", reason: "The test report's date could not be read." };
  if (report.report_date > cfg.as_of_date) return { result: "UNKNOWN", reason: `The test report is dated ${report.report_date}, after today.` };
  const oldest = minusYears(cfg.as_of_date, 1);
  if (report.report_date < oldest) {
    return { result: "FAIL", reason: `The test report is dated ${report.report_date}, more than 12 months before today (${cfg.as_of_date}).` };
  }

  const tested = new Set(report.samples.map((s) => s.ply).filter((p): p is number => p !== null));
  const missing = plies.filter((p) => !tested.has(p));
  if (missing.length > 0) {
    return { result: "FAIL", reason: `The test report has no ${missing.map((p) => `${p} ply`).join(" or ")} sample, which this vendor offers.` };
  }
  return { result: "PASS", reason: `Dated ${report.report_date}; covers the ${plies.join(", ")} ply board offered.` };
}

/** A plain yes/no gate. */
export function evaluateYesGate(answer: string | null | undefined): GateDecision {
  const kind = classifyAnswer(answer);
  if (kind === "yes") return { result: "PASS", reason: `Answered yes: "${answer}".` };
  if (kind === "no") return { result: "FAIL", reason: `Answered no: "${answer}".` };
  if (kind === "hedged") return { result: "UNKNOWN", reason: `Answer is conditional and cannot be scored: "${answer}".` };
  return { result: "UNKNOWN", reason: "Not answered." };
}

export interface Waiver {
  q_id: string;
  reason: string;
  actor: string;
}

export interface GateOutcome extends GateDecision {
  q_id: string;
  /** Set when the buyer waived a gate that did not pass. */
  waiver: Waiver | null;
}

export interface GateSummary {
  /** What the optimizer uses: FAIL beats UNKNOWN beats WAIVED beats PASS. */
  overall: VendorGate;
  gates: GateOutcome[];
  /** One sentence for the vendor panel. */
  headline: string;
}

export interface VendorEvidence {
  vendor_name: string;
  /** Raw answers as written, keyed by question id. Absent means unanswered. */
  answers: Readonly<Record<string, string | null | undefined>>;
  certificate: CertificateFields | null;
  test_report: TestReportFields | null;
  offered_plies: readonly number[];
  /**
   * Documents the vendor attached that have not been read yet. A yes that rests on one is UNKNOWN, not FAIL: the
   * evidence exists, it just has not been checked (null above means nothing was attached).
   */
  unread?: readonly ("certificate" | "test_report")[];
}

const DOC_NAME = { certificate: "certificate", test_report: "test report" } as const;

export function summarizeGates(
  questions: readonly Question[],
  evidence: VendorEvidence,
  cfg: DateConfig,
  waivers: readonly Waiver[] = [],
): GateSummary {
  for (const w of waivers) if (w.reason.trim() === "") throw new Error(`waiver for ${w.q_id} needs a reason`);

  const gates: GateOutcome[] = questions
    .filter((q) => q.is_gate)
    .map((q) => {
      const answer = evidence.answers[q.q_id];
      const needs = q.pass_check === "valid_certificate" ? "certificate" : q.pass_check === "test_report_covers_offered_plies" ? "test_report" : null;
      let decision: GateDecision;
      if (needs && evidence[needs] === null && evidence.unread?.includes(needs) && classifyAnswer(answer) === "yes") {
        decision = { result: "UNKNOWN", reason: `Answered yes ("${answer}"); the attached ${DOC_NAME[needs]} has not been read yet.` };
        const waiver = waivers.find((w) => w.q_id === q.q_id) ?? null;
        return { q_id: q.q_id, result: decision.result, reason: decision.reason, waiver };
      }
      switch (q.pass_check) {
        case "valid_certificate":
          decision = evaluateIsoGate(answer, evidence.certificate, evidence.vendor_name, cfg);
          break;
        case "test_report_covers_offered_plies":
          decision = evaluateTestReportGate(answer, evidence.test_report, evidence.offered_plies, cfg);
          break;
        case "answer_yes":
          decision = evaluateYesGate(answer);
          break;
        default:
          decision = { result: "UNKNOWN", reason: "This gate has no machine-checkable rule; it needs the buyer." };
      }
      const waiver = decision.result !== "PASS" ? (waivers.find((w) => w.q_id === q.q_id) ?? null) : null;
      return { q_id: q.q_id, result: decision.result, reason: decision.reason, waiver };
    });

  const open = gates.filter((g) => g.waiver === null);
  let overall: VendorGate;
  if (open.some((g) => g.result === "FAIL")) overall = "FAIL";
  else if (open.some((g) => g.result === "UNKNOWN")) overall = "UNKNOWN";
  else if (gates.some((g) => g.waiver !== null)) overall = "WAIVED";
  else overall = "PASS";

  const failed = open.filter((g) => g.result === "FAIL").map((g) => g.q_id);
  const unknown = open.filter((g) => g.result === "UNKNOWN").map((g) => g.q_id);
  const waived = gates.filter((g) => g.waiver !== null).map((g) => g.q_id);
  const headline =
    overall === "PASS"
      ? "Cleared all gates."
      : overall === "WAIVED"
        ? `Cleared, with ${waived.join(", ")} waived by the buyer.`
        : overall === "FAIL"
          ? `Not cleared: failed ${failed.join(", ")}.`
          : unknown.length === gates.length && Object.keys(evidence.answers).length === 0
            ? "Not cleared: no answers received."
            : `Not cleared: ${unknown.join(", ")} could not be scored.`;

  return { overall, gates, headline };
}
