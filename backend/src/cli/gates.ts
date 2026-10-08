import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { QUESTIONS } from "../data/rfx.js";
import { assembleVendor, latestEvidence, loadManifest } from "./assemble.js";
import { VENDORS, dataDir, setFromArgs } from "./vendors.js";

/**
 * Questionnaire answers from each vendor's latest saved pass A, verified, through the gates and the claim checks,
 * compared with ground truth. Free: no API call. Certificates and test reports come from the saved evidence readings
 * (`npm run evidence`); an attached document with no verified reading is unread, so a yes resting on it is UNKNOWN.
 * Usage: npm run gates [-- --set holdout]
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const set = setFromArgs();
  const gt = JSON.parse(readFileSync(join(dataDir(set), "ground_truth.json"), "utf8"));
  const manifest = loadManifest(set);
  const evidence = latestEvidence(set);

  for (const vendorId of Object.keys(VENDORS)) {
    const v = await assembleVendor(vendorId, config, manifest, evidence, set);
    if (!v) {
      console.log(`${vendorId}: no saved run`);
      continue;
    }
    const truth = gt.vendors?.[vendorId] ?? {};
    const docs = v.evidence_docs.map((d) => `${d.role} (${d.read ? "read" : "unread"})`);
    console.log(`\n${vendorId} (${v.file}): ${Object.keys(v.answers.answers).length} of ${QUESTIONS.length} answers verified${v.answers.rejected.length ? `, ${v.answers.rejected.length} rejected` : ""}; attached: ${docs.join(", ") || "none"}`);
    for (const x of v.answers.rejected) console.log(`  rejected ${x.q_id}: ${x.reason}`);
    for (const g of v.gates.gates) {
      const want = truth.gates?.[g.q_id];
      const mark = want === undefined ? "" : want === g.result ? "  (matches ground truth)" : `  (ground truth ${want}${/not been read/.test(g.reason) ? "; needs the evidence-reading pass" : ""})`;
      console.log(`  ${g.q_id} ${g.result}: ${g.reason}${mark}`);
    }
    console.log(`  overall: ${v.gates.headline}`);
    const wantHedged = Object.keys(truth.hedged ?? {});
    for (const h of v.findings.hedged) console.log(`  hedged ${h.q_id}: "${h.answer}"${wantHedged.includes(h.q_id) ? "  (in ground truth)" : "  (not in ground truth)"}`);
    for (const q of wantHedged) if (!v.findings.hedged.some((h) => h.q_id === q)) console.log(`  MISSED hedged ${q}`);
    if (v.report_findings.length) console.log(`  test report below requirement on: ${[...new Set(v.report_findings.map((x) => x.line_id))].join(", ")}`);
    for (const c of v.findings.contradictions) console.log(`  claim vs evidence ${c.q_id}: "${c.claim}" but ${c.evidence.length} deviation(s) on ${c.lines.join(", ")}`);
    if (v.findings.unanswered.length) console.log(`  unanswered: ${v.findings.unanswered.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
