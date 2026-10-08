import { loadConfig } from "../config.js";
import { RFX_HEADER, RFX_LINES } from "../data/rfx.js";
import type { Quote } from "../ingest/quotes.js";
import { draftClarification } from "../review/clarify.js";
import { VENDORS, latestRun } from "./vendors.js";

/**
 * Prints the clarification draft for one vendor, built from every vendor's latest saved live run (the guard needs all
 * vendors' numbers). Free: no API call. The draft is never sent.
 * Usage: npm run clarify -- --vendor V5
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const vendorId = arg("vendor") ?? "V5";
  const config = loadConfig();
  const all: Quote[] = [];
  for (const v of Object.keys(VENDORS)) all.push(...((await latestRun(v, config))?.quotes ?? []));
  const d = draftClarification(vendorId, all, RFX_LINES, RFX_HEADER);
  if (!d) {
    console.log(`${vendorId}: nothing to clarify.`);
    return;
  }
  console.log(`Status: ${d.status.toUpperCase()} (draft only, never sent)`);
  console.log(`To: ${d.to}\nMessage-ID: ${d.message_id}\nSubject: ${d.subject}\n\n${d.body}`);
  if (!d.guard.ok) for (const p of d.guard.problems) console.log(`GUARD: ${p.kind} "${p.text}": ${p.detail}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
