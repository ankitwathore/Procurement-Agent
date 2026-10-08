import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { RFX_HEADER, RFX_LINES } from "../data/rfx.js";
import { evaluate, regressionGate, toMarkdown, type EvalReport, type EvalVendor, type Format } from "../eval/harness.js";
import { screenInjection } from "../ingest/injection.js";
import { intake } from "../ingest/intake.js";
import type { Quote } from "../ingest/quotes.js";
import { draftClarification } from "../review/clarify.js";
import { assembleVendor, latestEvidence, loadManifest, type VendorRun } from "./assemble.js";
import { DATA_SETS, ROOT, VENDORS, dataDir, type DataSet } from "./vendors.js";

/**
 * The eval harness on the saved live runs (spec 19), for the tuned set and the holdout set, each where it has runs.
 * Free: no API call. Writes eval/report.md, eval/report.json and a dated copy per set under eval/history/, and exits 1
 * when the regression gate fails for either set (spec 19.8).
 * Usage: npm run eval
 */

const FORMAT: Record<string, Format> = { xlsx: "xlsx", pdf: "pdf", docx: "docx", email: "email", image: "photo" };

function traceCost(run: VendorRun, evidenceCost: number): { cost: number; ms: number } {
  const a = run.saved.trace;
  const b = run.saved.pass_b?.trace;
  const adj = run.saved.adjudication?.trace;
  const cost = (a?.cost_usd ?? 0) + (b?.cost_usd ?? 0) + (adj?.cost_usd ?? 0) + evidenceCost;
  // Passes A and B run side by side; the adjudicator runs after both.
  const ms = Math.max(a?.ms ?? 0, b?.ms ?? 0) + (adj?.ms ?? 0);
  return { cost, ms };
}

async function evalSet(set: DataSet): Promise<{ report: EvalReport; runs: string[] } | null> {
  const config = loadConfig();
  const gt = JSON.parse(readFileSync(join(dataDir(set), "ground_truth.json"), "utf8"));
  const manifest = loadManifest(set);
  const evidence = latestEvidence(set);
  const runs: VendorRun[] = [];
  for (const id of Object.keys(VENDORS)) {
    const r = await assembleVendor(id, config, manifest, evidence, set);
    if (r) runs.push(r);
    else console.log(`${set} ${id}: no saved run; left out`);
  }
  if (runs.length === 0) return null;
  const allQuotes: Quote[] = runs.flatMap((r) => r.quotes);
  const vendors: EvalVendor[] = runs.map((r) => {
    const dir = join(dataDir(set), "vendors", r.vendor_id);
    const files = readdirSync(dir).map((f) => ({ vendor_id: r.vendor_id, filename: f, content: readFileSync(join(dir, f)) }));
    const draft = draftClarification(r.vendor_id, allQuotes, RFX_LINES, RFX_HEADER);
    const { cost, ms } = traceCost(r, r.evidence_results.reduce((s, e) => s + (e.trace.cost_usd ?? 0), 0));
    return {
      vendor_id: r.vendor_id,
      format: FORMAT[r.doc.kind] ?? "pdf",
      quotes: r.quotes,
      vendor: r.built.vendor,
      extraction: r.extraction,
      extras: r.built.extras,
      // The screen is code: re-run it on the document so the eval measures the current screen, not the saved one.
      injection_findings: screenInjection(r.doc.text).findings.length,
      gates: r.gates,
      findings: r.findings,
      report_findings: r.report_findings,
      authoritative_end: r.doc.authoritative_end,
      clarification_lines: draft?.items.flatMap((i) => i.lines) ?? [],
      duplicates: intake(files).filter((a) => a.status === "DUPLICATE").map((a) => a.filename),
      cost_usd: cost,
      ms,
    };
  });
  return { report: evaluate({ set, vendors, gt, safeStates: config.exposure.safe_states }), runs: runs.map((r) => r.file) };
}

async function main(): Promise<void> {
  const evalDir = join(ROOT, "eval");
  const historyDir = join(evalDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const history = readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ f, j: JSON.parse(readFileSync(join(historyDir, f), "utf8")) }));

  const md: string[] = [];
  const json: Record<string, unknown> = { at: now };
  let failed = false;
  for (const set of DATA_SETS) {
    if (set !== "tuned" && !existsSync(join(dataDir(set), "ground_truth.json"))) continue;
    const r = await evalSet(set);
    if (!r) {
      md.push(`# ${set} set: no saved runs yet`, "");
      console.log(`\n== ${set}: no saved runs`);
      continue;
    }
    const { report } = r;
    const last = history.filter((h) => (h.j.set ?? "tuned") === set).at(-1);
    const regression = regressionGate(report, last?.j ?? null);
    failed ||= regression.failed;
    const notes = [
      ...(set === "tuned" ? ["Trap 05 (V1 revision 2) needs a live run of the revised workbook."] : ["The holdout has no revision 2 and no clarification reply; trap 05 is tuned only."]),
      ...(set === "holdout" ? ["Seed 7 is no longer unseen: the code fixes of 2026-10-08 were prompted by its first run (kept in eval/holdout/seed7-first-run-2026-10-08.md)."] : []),
      "V4 (phone photo) not built: its traps and the photo targets are not measured.",
      "Exposure accuracy against an independent solver (spec 19.4) not built.",
      "Analyst golden questions (spec 19.5) and the adversarial suite (spec 19.6) not built.",
    ];
    md.push(toMarkdown(report, { date: now.slice(0, 10), regression, notes }));
    json[set] = { runs: r.runs, ...report, regression };
    writeFileSync(join(historyDir, `${stamp}-${set}.json`), JSON.stringify({ at: now, set, confirmed_precision: report.confirmed_precision, dangerous_rate: report.dangerous_rate, trap_recall: report.trap_recall, overall: report.overall, calibration: report.calibration }, null, 2));

    console.log(`\n== ${set} set (${r.runs.length} vendors)\n${report.headline}`);
    for (const c of report.calibration) console.log(`  ${c.state.padEnd(14)} ${String(c.cells).padStart(4)} cells, ${String(c.correct).padStart(4)} correct, ${c.precision === null ? "n/a" : `${(c.precision * 100).toFixed(1)}%`}`);
    console.log(`dangerous: ${report.overall.dangerous.length}${report.overall.dangerous.length ? ` (${report.overall.dangerous.join(", ")})` : ""}; wrong cells ${report.wrong_cells.total} (${report.wrong_cells.cells.join(", ") || "none"}), flagged unsafe ${report.wrong_cells.flagged_unsafe}`);
    console.log(`traps: ${report.trap_recall.passed} of ${report.trap_recall.runnable} runnable passed (${report.trap_recall.registered} registered)`);
    for (const t of report.traps.filter((x) => x.status === "fail")) console.log(`  FAIL ${t.id} ${t.vendor}: ${t.detail}`);
    for (const t of report.targets.filter((x) => x.status !== "not_measured")) console.log(`  target ${t.metric}: ${t.value} (${t.target}) ${t.status}`);
    console.log(regression.failed ? `REGRESSION: ${regression.reasons.join("; ")}` : last ? `regression gate: passed against ${last.f}` : "regression gate: no earlier report for this set");
  }
  writeFileSync(join(evalDir, "report.md"), md.join("\n"));
  writeFileSync(join(evalDir, "report.json"), JSON.stringify(json, null, 2));
  console.log("\nwrote eval/report.md, eval/report.json and eval/history/");
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
