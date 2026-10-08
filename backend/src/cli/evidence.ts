import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { runEvidencePass, type EvidenceResult } from "../ingest/extract_evidence.js";
import { parsePdf } from "../ingest/parse_pdf.js";
import { AnthropicLlm } from "../llm/client.js";
import { ROOT, dataDir, runsDir, setFromArgs } from "./vendors.js";

/**
 * Reads every certificate and test report in the generated dataset with the evidence pass (one small live call each;
 * spends credit) and saves the readings for `npm run gates`.
 * Usage: npm run evidence [-- --vendor V2] [--set holdout]
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env at the repo root (see .env.example).");
    process.exit(2);
  }
  const config = loadConfig();
  const set = setFromArgs();
  const only = arg("vendor");
  const manifest: Record<string, { vendor: string; doc_role: string }> = JSON.parse(readFileSync(join(dataDir(set), "docs_manifest.json"), "utf8"));
  const docs = Object.entries(manifest).filter(([, m]) => (m.doc_role === "certificate" || m.doc_role === "test_report") && (!only || m.vendor === only));
  const client = new AnthropicLlm({ timeoutMs: config.limits.llm_timeout_s * 1000, maxRetries: config.limits.max_retries });

  // Concurrent: the documents are independent and small.
  const results: (EvidenceResult & { vendor_id: string; expected_role: string })[] = await Promise.all(
    docs.map(async ([file, m]) => {
      const bytes = readFileSync(join(dataDir(set), "vendors", file));
      if (/\.jpe?g$/i.test(file)) {
        // A photographed certificate: sent as an image, read with vision.
        return { vendor_id: m.vendor, expected_role: m.doc_role, ...(await runEvidencePass("", { client, config, vendorId: m.vendor, file, image: { media_type: "image/jpeg", data: bytes.toString("base64") } })) };
      }
      const pdf = await parsePdf(bytes);
      return { vendor_id: m.vendor, expected_role: m.doc_role, ...(await runEvidencePass(pdf.text, { client, config, vendorId: m.vendor, file })) };
    }),
  );

  let total = 0;
  for (const r of results) {
    const t = r.trace;
    total += t.cost_usd ?? 0;
    const got = r.reading?.doc_role ?? "unread";
    console.log(`${t.file}: ${got}${got !== r.expected_role ? ` (manifest says ${r.expected_role})` : ""}; ${t.model_used}, ${t.ms} ms, $${t.cost_usd?.toFixed(4) ?? "?"}`);
    if (r.reading?.certificate) {
      const c = r.reading.certificate;
      console.log(`  ${c.cert_type}, ${c.entity_name}, valid ${c.valid_from} to ${c.valid_to}`);
    }
    if (r.reading?.test_report) {
      const t2 = r.reading.test_report;
      console.log(`  ${t2.report_no} dated ${t2.report_date}: ${t2.samples.map((s) => `${s.ply}${s.flute ?? ""} ${s.liner_gsm}/${s.bf}`).join(", ")}`);
    }
    for (const p of r.reading?.problems ?? []) console.log(`  problem: ${p}`);
    for (const e of r.errors) console.log(`  error: ${e}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    if (r.injection.length) console.log(`  injection screen: ${r.injection.length} finding(s), stripped before the call`);
  }
  console.log(`spent this run $${total.toFixed(4)}`);

  const runDir = runsDir(set);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(`saved ${path.replace(ROOT, "")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
