import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { scoreVendor, type GtLine, type VendorScore } from "../eval/score.js";
import type { BuildResult } from "../ingest/quotes.js";
import { pendingConfirmations, type Confirmation } from "../review/confirmations.js";
import { dataDir, type DataSet } from "./vendors.js";

/** Scores built quotes against ground truth and prints the summary both `extract` and `rescore` show. */
export function scoreAndPrint(vendorId: string, built: BuildResult, rowCount: number, config: Config, set: DataSet = "tuned"): { score: VendorScore; pending: Confirmation[] } {
  const gt = JSON.parse(readFileSync(join(dataDir(set), "ground_truth.json"), "utf8")) as { vendors: Record<string, { lines: Record<string, GtLine> }> };
  const score = scoreVendor(built.quotes, gt.vendors[vendorId]!.lines, config.exposure.safe_states);
  console.log(`rows ${rowCount}, rejected ${built.rejected.length}, extras ${built.extras.length}`);
  const recon = built.quotes.filter((q) => q.reconciliation);
  if (recon.length > 0) {
    const count = (s: string) => recon.filter((q) => q.reconciliation!.status === s).length;
    console.log(`passes: agree ${count("agree")}, disagree ${count("disagree")}, only A ${count("a_only")}, only B ${count("b_only")}, neither ${count("neither")}`);
    for (const q of recon.filter((x) => !["agree", "neither"].includes(x.reconciliation!.status))) {
      const a = q.reconciliation!.adjudication;
      console.log(`  ${q.line_id}: ${q.reconciliation!.detail}${a ? ` Adjudicator: ${a.decision}, ${a.reasoning} -> ${q.state}` : ""}`);
    }
  }
  for (const r of built.rejected) console.log(`  rejected ${r.row_id}: ${r.reason}`);
  console.log(`state accuracy ${(score.state_accuracy * 100).toFixed(1)}%, price accuracy ${(score.price_accuracy * 100).toFixed(1)}% of ${score.price_checked}`);
  console.log(`dangerous (safe but wrong): ${score.dangerous.length ? score.dangerous.join(", ") : "none"}; coverage errors: ${score.coverage_errors.join(", ") || "none"}`);
  const more = score.missing_flags.length > 8 ? ` and ${score.missing_flags.length - 8} more` : "";
  console.log(`flag recall ${(score.flag_recall * 100).toFixed(1)}% of ${score.flags_expected}${score.missing_flags.length ? `; missing: ${score.missing_flags.slice(0, 8).join(", ")}${more}` : ""}`);
  const pending = pendingConfirmations(built.quotes, config.currency_of_record);
  for (const c of pending) console.log(`buyer to confirm (${c.lines.length} cells): ${c.question}`);
  for (const l of score.lines.filter((x) => !x.state_ok || x.price_ok === false)) {
    console.log(`  ${l.line_id}: state ${l.got_state} (expected ${l.expected_state}), point ${l.got_point ?? "-"} (expected ${l.expected_point ?? "-"})`);
  }
  return { score, pending };
}
