import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import type { Adjudication } from "../ingest/adjudicate.js";
import { ExtractionSchema } from "../ingest/extraction.js";
import { scoreAndPrint } from "./report.js";
import { ROOT, loadVendor, runsDir, setFromArgs, type DataSet } from "./vendors.js";

/**
 * Replays saved pass A extractions through the current deterministic code and scores them. Free: no API call.
 * Use it after changing checks, states or ground truth, to see the effect on real model output.
 * Usage: npm run rescore                 (the latest run of each vendor)
 *        npm run rescore -- --run <file> (one saved run, path under data/runs)
 *        add --set holdout for the holdout set
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function rescore(file: string, set: DataSet): Promise<void> {
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    vendor_id?: string;
    effort?: string;
    extraction: unknown;
    trace: { vendor_id: string; at: string };
    pass_b?: { extraction: unknown } | null;
    adjudication?: { adjudications: Adjudication[] };
  };
  const vendorId = saved.vendor_id ?? saved.trace.vendor_id;
  console.log(`===== ${vendorId}: ${file.replace(ROOT, "")} (effort ${saved.effort ?? "high"}, run ${saved.trace.at}${saved.pass_b?.extraction ? ", passes A and B" : ", pass A only"})`);
  if (!saved.extraction) {
    console.log("no extraction in this run");
    return;
  }
  const config = loadConfig();
  const extraction = ExtractionSchema.parse(saved.extraction);
  const { build } = await loadVendor(vendorId, config, set);
  const passB = saved.pass_b?.extraction ? ExtractionSchema.parse(saved.pass_b.extraction) : undefined;
  scoreAndPrint(vendorId, build(extraction, passB, saved.adjudication?.adjudications), extraction.rows.length, config, set);
}

async function main(): Promise<void> {
  const set = setFromArgs();
  const one = arg("run");
  if (one) return rescore(join(ROOT, one), set);
  const dir = runsDir(set);
  // Only quote runs; reply readings (`V5-reply-...`) are replayed by `npm run reply -- --reuse`.
  const files = readdirSync(dir).filter((f) => f.includes("-pass-a-") && f.endsWith(".json")).sort();
  const latest = new Map<string, string>();
  for (const f of files) latest.set(f.split("-pass-a-")[0] as string, f); // sorted by time, so the last one wins
  for (const f of latest.values()) await rescore(join(dir, f), set);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
