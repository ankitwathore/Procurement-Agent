import type { SpecFlag } from "../ingest/checks.js";
import type { Quote } from "../ingest/quotes.js";
import type { RfxLine } from "../schemas.js";
import { classifyAnswer } from "./certificates.js";
import type { TestReportFields } from "./gates.js";

/**
 * Claim versus evidence (spec 10.9, E02, S01; traps 03 and 16).
 * 1. A test report's measured values against what each quoted line requires.
 * 2. A "no deviations" answer against the deviations actually found, in the offer or in the report.
 * Findings never change a price. They add spec flags, which the strict spec policy acts on, and a contradiction
 * the buyer sees with both sides quoted.
 */

export interface ReportFinding {
  line_id: string;
  field: "bf" | "liner_gsm";
  required: number;
  reported: number;
  sample: { ply: number; flute: string | null };
  detail: string;
}

type Sample = TestReportFields["samples"][number];

/** The liner GSM a line is offered on: what the vendor stated when it differs from the RFx, else the RFx's. */
function offeredGsm(q: Quote, line: RfxLine): number | null {
  const f = q.spec_flags.find((x) => x.field === "liner_gsm" && x.source !== "test_report");
  return f && typeof f.offered === "number" ? f.offered : line.spec.liner_gsm;
}

/**
 * The samples that speak for a line: same ply, and same flute when the report states one. When some of those were
 * tested at exactly the liner GSM the line is offered on, only they count: a report covering a lighter grade
 * (V1's 120 GSM 5 ply) says nothing about the full spec grade offered on other lines.
 */
function samplesFor(q: Quote, line: RfxLine, samples: readonly Sample[]): Sample[] {
  const sameBoard = samples.filter((s) => s.ply === line.spec.ply && (!s.flute || !line.spec.flute || s.flute === line.spec.flute));
  const gsm = offeredGsm(q, line);
  const sameGrade = sameBoard.filter((s) => typeof s.liner_gsm === "number" && s.liner_gsm === gsm);
  return sameGrade.length > 0 ? sameGrade : sameBoard;
}

/**
 * Compares each sample with every quoted line it covers. When several samples cover one line (same grade, or no
 * sample at the offered grade), the weakest reading is used: a report that shows the board can fall short is
 * evidence enough to ask.
 */
export function compareReportToLines(report: TestReportFields, quotes: readonly Quote[], lines: readonly RfxLine[]): ReportFinding[] {
  const findings: ReportFinding[] = [];
  const samples = report.samples;
  for (const q of quotes) {
    if (q.state === "MISSING") continue;
    const line = lines.find((l) => l.line_id === q.line_id);
    if (!line || line.spec.ply === null) continue;
    const covering = samplesFor(q, line, samples);
    if (covering.length === 0) continue;

    for (const field of ["bf", "liner_gsm"] as const) {
      const required = line.spec[field];
      const readings = covering.map((s) => s[field]).filter((v): v is number => typeof v === "number");
      if (required === null || readings.length === 0) continue;
      const reported = Math.min(...readings);
      if (reported < required) {
        const s = covering.find((x) => x[field] === reported) as Sample;
        const label = field === "bf" ? "BF" : "liner GSM";
        findings.push({
          line_id: line.line_id,
          field,
          required,
          reported,
          sample: { ply: s.ply as number, flute: s.flute ?? null },
          detail: `Test report shows ${label} ${reported} for ${s.ply} ply${s.flute ? ` ${s.flute}` : ""}; ${line.line_id} requires ${label} ${required}.`,
        });
      }
    }
  }
  return findings;
}

/** Returns new quotes with the report's findings added as spec flags (source: test_report). Inputs are not changed. */
export function applyReportFindings(quotes: readonly Quote[], findings: readonly ReportFinding[]): Quote[] {
  return quotes.map((q) => {
    const mine = findings.filter((f) => f.line_id === q.line_id);
    if (mine.length === 0) return q;
    const added: SpecFlag[] = mine.map((f) => ({
      kind: "spec_below_requirement",
      field: f.field,
      required: f.required,
      offered: f.reported,
      detail: f.detail,
      source: "test_report",
    }));
    return {
      ...q,
      spec_flags: [...q.spec_flags, ...added],
      flags: q.flags.includes("spec_below_requirement") ? q.flags : [...q.flags, "spec_below_requirement"],
    };
  });
}

export interface ClaimContradiction {
  kind: "claim_vs_evidence";
  q_id: string;
  /** The vendor's answer, verbatim. */
  claim: string;
  /** Each deviation found, in plain words, with where it came from. */
  evidence: string[];
  lines: string[];
}

const DEVIATIONS = new Set(["spec_below_requirement", "spec_dimension_off", "spec_print_differs"]);

/**
 * A vendor that answers "no deviations" while its offer or its test report shows one contradicts itself.
 * An upgrade is not a deviation. A vendor that discloses deviations, or does not answer, is not contradicting itself.
 */
export function checkDeviationClaim(qId: string, answer: string | null | undefined, quotes: readonly Quote[]): ClaimContradiction | null {
  if (classifyAnswer(answer) !== "no") return null;
  const evidence: string[] = [];
  const lines: string[] = [];
  for (const q of quotes) {
    const devs = q.spec_flags.filter((f) => DEVIATIONS.has(f.kind));
    if (devs.length === 0) continue;
    lines.push(q.line_id);
    for (const f of devs) evidence.push(`${q.line_id}: ${f.detail} (${f.source === "test_report" ? "test report" : "offer"})`);
  }
  return lines.length === 0 ? null : { kind: "claim_vs_evidence", q_id: qId, claim: (answer as string).trim(), evidence, lines };
}
