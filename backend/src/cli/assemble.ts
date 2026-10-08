import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { QUESTIONS, RFX_LINES } from "../data/rfx.js";
import { vendorById } from "../data/vendors.js";
import { answersFromExtraction, questionnaireFindings, type AnswersResult, type QuestionnaireFindings } from "../evidence/answers.js";
import type { CertificateFields } from "../evidence/certificates.js";
import { applyReportFindings, compareReportToLines, type ReportFinding } from "../evidence/claims.js";
import { offeredPlies, summarizeGates, type GateSummary, type TestReportFields } from "../evidence/gates.js";
import type { EvidenceResult } from "../ingest/extract_evidence.js";
import type { Quote } from "../ingest/quotes.js";
import { RFX_HEADER } from "../data/rfx.js";
import type { Session, TraceStep } from "../server/views.js";
import { dataDir, latestRun, runsDir, vendorsOf, type DataSet, type SavedRun } from "./vendors.js";

/**
 * Everything the saved live runs say about one vendor, assembled once for `gates` and `eval`: the built quotes, the
 * verified questionnaire answers, the evidence readings, the gates, and the claim checks. Free: reads saved runs only.
 */

export interface Manifest {
  [file: string]: { vendor: string; doc_role: string };
}

export interface VendorRun extends SavedRun {
  vendor_id: string;
  answers: AnswersResult;
  evidence_docs: { role: "certificate" | "test_report"; file: string; read: boolean }[];
  certificate: CertificateFields | null;
  test_report: TestReportFields | null;
  gates: GateSummary;
  report_findings: ReportFinding[];
  /** The quotes with the test report's findings applied as spec flags. */
  quotes_with_evidence: Quote[];
  findings: QuestionnaireFindings;
  evidence_results: EvidenceResult[];
}

export function loadManifest(set: DataSet = "tuned"): Manifest {
  return JSON.parse(readFileSync(join(dataDir(set), "docs_manifest.json"), "utf8"));
}

/** The newest reading of each evidence file across all saved evidence runs of a set. */
export function latestEvidence(set: DataSet = "tuned"): Map<string, EvidenceResult> {
  const dir = runsDir(set);
  const out = new Map<string, EvidenceResult>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.startsWith("evidence-")).sort()) {
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as EvidenceResult[]) out.set(r.trace.file, r);
  }
  return out;
}

function traceStep(t: Record<string, any>, file: string): TraceStep {
  return {
    step: t.step,
    file,
    model: t.model_used ?? t.model_requested ?? null,
    fallback_used: !!t.fallback_used,
    stop_reason: t.stop_reason ?? null,
    prompt_version: t.prompt_version ?? null,
    tokens_in: t.usage?.input_tokens ?? null,
    tokens_out: t.usage?.output_tokens ?? null,
    cache_read: t.usage?.cache_read_input_tokens ?? null,
    cache_write: t.usage?.cache_creation_input_tokens ?? null,
    cost_usd: t.cost_usd ?? null,
    ms: t.ms ?? null,
    at: t.at ?? null,
  };
}

/** The buyer UI's and the analyst's session for a set: every vendor with a saved run, as views.ts expects. */
export async function buildSession(set: DataSet, config: Config): Promise<Session> {
  const manifest = loadManifest(set);
  const evidence = latestEvidence(set);
  const vendors: Session["vendors"] = [];
  for (const id of Object.keys(vendorsOf(set))) {
    const r = await assembleVendor(id, config, manifest, evidence, set);
    if (!r) continue;
    vendors.push({
      vendor_id: id,
      file: vendorsOf(set)[id]!.file,
      run_file: r.file,
      doc: r.doc,
      quotes: r.quotes_with_evidence,
      assessment: r.built.vendor,
      extraction: r.extraction,
      extras: r.built.extras,
      rejected: r.built.rejected,
      injection: r.saved.injection ?? [],
      gates: r.gates,
      answers: r.answers.answers,
      findings: r.findings,
      report_findings: r.report_findings,
      certificate: r.certificate,
      test_report: r.test_report,
      evidence_docs: r.evidence_docs,
      notes: [...(r.saved.notes ?? []), ...(r.saved.pass_b?.notes ?? [])],
      // Ground truth scores are in the saved run too: the app never sees them.
      run: Object.fromEntries(Object.entries(r.saved).filter(([k]) => k !== "score")),
      traces: [
        ...(["trace", "pass_b", "adjudication"] as const).map((k) => (k === "trace" ? r.saved.trace : r.saved[k]?.trace)).filter(Boolean).map((t: Record<string, any>) => traceStep(t, vendorsOf(set)[id]!.file)),
        ...r.evidence_results.map((e) => traceStep(e.trace as unknown as Record<string, any>, e.trace.file)),
      ],
    });
  }
  return { set, config, rfx: RFX_HEADER, lines: RFX_LINES, vendors, decisions: [] };
}

export async function assembleVendor(vendorId: string, config: Config, manifest: Manifest, evidence: Map<string, EvidenceResult>, set: DataSet = "tuned"): Promise<VendorRun | null> {
  const run = await latestRun(vendorId, config, set);
  if (!run) return null;
  const answers = answersFromExtraction(run.saved.questionnaire ?? [], QUESTIONS, { text: run.doc.text, authoritativeEnd: run.doc.authoritative_end });

  const files = Object.entries(manifest).filter(([, m]) => m.vendor === vendorId && (m.doc_role === "certificate" || m.doc_role === "test_report"));
  const results = files.map(([file]) => evidence.get(file)).filter((x): x is EvidenceResult => x !== undefined);
  const certificate = results.find((r) => r.reading?.certificate)?.reading?.certificate ?? null;
  const test_report = results.find((r) => r.reading?.test_report)?.reading?.test_report ?? null;
  const evidence_docs = files.map(([file, m]) => {
    const role = m.doc_role as "certificate" | "test_report";
    return { role, file, read: role === "certificate" ? certificate !== null : test_report !== null };
  });
  const unread = evidence_docs.filter((d) => !d.read).map((d) => d.role);

  const gates = summarizeGates(
    QUESTIONS,
    { vendor_name: vendorById(vendorId).name, answers: answers.answers, certificate, test_report, offered_plies: offeredPlies(run.quotes, RFX_LINES), unread },
    config,
  );
  // The test report's findings join the offer's own spec flags before any claim is checked (trap 16).
  const report_findings = test_report ? compareReportToLines(test_report, run.quotes, RFX_LINES) : [];
  const quotes_with_evidence = applyReportFindings(run.quotes, report_findings);
  const findings = questionnaireFindings(QUESTIONS, answers.answers, quotes_with_evidence);
  return { ...run, vendor_id: vendorId, answers, evidence_docs, certificate, test_report, gates, report_findings, quotes_with_evidence, findings, evidence_results: results };
}
