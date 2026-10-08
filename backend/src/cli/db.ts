import { join } from "node:path";
import { loadConfig } from "../config.js";
import { applyDecisions } from "../store/apply.js";
import { writeSnapshot } from "../store/snapshot.js";
import { Store } from "../store/store.js";
import { buildSession } from "./assemble.js";
import { ROOT, dataDir, setFromArgs } from "./vendors.js";

/**
 * The store for one data set (data/app.db for the demo set). Free.
 * Usage: npm run db -- status | load | reset   [--set holdout]
 *   status  counts per table, and the latest events
 *   load    rebuild the pipeline snapshot from the saved runs, with the stored decisions applied
 *   reset   remove every decision and the audit trail, then load: a clean state (spec 22 step 2)
 */

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const set = setFromArgs();
  const path = join(dataDir(set), "app.db");
  const store = new Store(path);
  if (cmd === "reset") store.reset();
  if (cmd === "reset" || cmd === "load") {
    const s = await buildSession(set, loadConfig());
    const report = applyDecisions(s, store);
    writeSnapshot(store, s);
    console.log(`${cmd === "reset" ? "reset and loaded" : "loaded"} ${path.replace(ROOT, "")}: ${s.vendors.length} vendors, ${report.applied} decision(s) applied${report.skipped.length ? `, ${report.skipped.length} skipped` : ""}`);
  }
  const counts = store.counts();
  console.log(Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", "));
  for (const e of store.events(10)) console.log(`  ${e.at} ${e.kind} ${e.ref} ${JSON.stringify(e.payload)}`);
  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
