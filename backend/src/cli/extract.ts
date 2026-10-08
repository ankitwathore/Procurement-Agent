import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { QUESTIONS, RFX_LINES } from "../data/rfx.js";
import { runPassA } from "../ingest/extract_a.js";
import { disputesOf, runAdjudicator, type Adjudication } from "../ingest/adjudicate.js";
import { runPassB } from "../ingest/extract_b.js";
import { ExtractionSchema } from "../ingest/extraction.js";
import { AnthropicLlm } from "../llm/client.js";
import { scoreAndPrint } from "./report.js";
import { ROOT, loadVendor, runsDir, setFromArgs } from "./vendors.js";

/**
 * Live passes A and B on one generated vendor file, reconciled and scored against ground truth. Spends real API credit.
 * Usage: npm run extract -- --vendor V1 [--set holdout] [--effort medium] [--a-only] [--reuse-a | --reuse-ab]   (V1, V2, V3 or V5; run `npm run gen-data` first)
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const vendorId = arg("vendor") ?? "V1";
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env at the repo root (see .env.example).");
    process.exit(2);
  }
  const config = loadConfig();
  const set = setFromArgs();
  const { doc, build } = await loadVendor(vendorId, config, set);

  const client = new AnthropicLlm({ timeoutMs: config.limits.llm_timeout_s * 1000, maxRetries: config.limits.max_retries });
  const effort = (arg("effort") ?? "medium") as "low" | "medium" | "high";
  const skipB = process.argv.includes("--a-only");
  console.log(`passes ${skipB ? "A" : "A and B"} on ${vendorId} (${set} set) (${doc.kind}, ${doc.text.length} chars) with ${config.models.extract_a}, effort ${effort}...`);
  const opts = { client, config, lines: RFX_LINES, questions: QUESTIONS, effort };
  // --reuse-a: take pass A from the latest saved run and spend only on pass B; --reuse-ab: reuse both passes too.
  const reuseB = process.argv.includes("--reuse-ab");
  const reuse = process.argv.includes("--reuse-a") || reuseB ? latestSavedPassA(vendorId, runsDir(set)) : null;
  if (reuse) console.log(`reusing pass A${reuseB && reuse.passB ? " and pass B" : ""} from ${reuse.file}`);
  // Pass A first writes the shared RFx cache; pass B then starts and reads it.
  const resultPromise = reuse ? Promise.resolve(reuse.result) : runPassA(doc, opts);
  const passBPromise = skipB
    ? Promise.resolve(null)
    : reuseB && reuse?.passB
      ? Promise.resolve(reuse.passB)
      : new Promise((r) => setTimeout(r, reuse ? 0 : 3000)).then(() => runPassB(doc, opts));
  const [result, passB] = await Promise.all([resultPromise, passBPromise]);

  for (const t of [result.trace, ...(passB ? [passB.trace] : [])]) {
    console.log(`${t.step}: model ${t.model_used}${t.fallback_used ? " (FALLBACK)" : ""}, stop ${t.stop_reason}, ${t.ms} ms, $${t.cost_usd?.toFixed(4) ?? "?"}`);
    if (t.usage) console.log(`  tokens: in ${t.usage.input_tokens}, out ${t.usage.output_tokens}, cache read ${t.usage.cache_read_input_tokens}, cache write ${t.usage.cache_creation_input_tokens}`);
  }
  let total = (reuse ? 0 : (result.trace.cost_usd ?? 0)) + (reuseB && reuse?.passB ? 0 : (passB?.trace.cost_usd ?? 0));
  if (result.errors.length) console.log(`pass A errors: ${result.errors.join("; ")}`);
  if (passB?.errors.length) console.log(`pass B errors: ${passB.errors.join("; ")}`);
  if (result.injection.length) console.log(`injection screen: ${result.injection.length} finding(s), stripped before the call`);

  const out: Record<string, unknown> = {
    vendor_id: vendorId,
    effort,
    trace: result.trace,
    errors: result.errors,
    injection: result.injection,
    notes: result.notes,
    questionnaire: result.questionnaire,
    extraction: result.extraction,
    pass_b: passB ? { trace: passB.trace, errors: passB.errors, notes: passB.notes, extraction: passB.extraction } : null,
  };
  let adjudications: Adjudication[] = [];
  if (result.extraction && passB?.extraction) {
    // Only disputed lines go to the adjudicator (Opus), all of a document's in one call.
    const disputes = disputesOf(build(result.extraction, passB.extraction).quotes, RFX_LINES);
    if (disputes.length > 0) {
      const adj = await runAdjudicator(doc, disputes, { client, config, lines: RFX_LINES, questions: QUESTIONS });
      adjudications = adj.adjudications;
      const t = adj.trace;
      console.log(`adjudicate (${disputes.length} line${disputes.length === 1 ? "" : "s"}): model ${t.model_used}, stop ${t.stop_reason}, ${t.ms} ms, $${t.cost_usd?.toFixed(4) ?? "?"}`);
      if (adj.errors.length) console.log(`adjudicator errors: ${adj.errors.join("; ")}`);
      total += t.cost_usd ?? 0;
      out.adjudication = { trace: t, errors: adj.errors, adjudications };
    }
  }
  console.log(`spent this run $${total.toFixed(4)}`);
  if (result.extraction) {
    const built = build(result.extraction, passB?.extraction ?? undefined, adjudications);
    const { score, pending } = scoreAndPrint(vendorId, built, result.extraction.rows.length, config, set);
    Object.assign(out, { rejected: built.rejected, score, pending_confirmations: pending });
  }
  const runDir = runsDir(set);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, `${vendorId}-pass-a-${result.trace.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`saved ${path.replace(ROOT, "")}`);
}

function latestSavedPassA(vendorId: string, dir: string): { file: string; result: Awaited<ReturnType<typeof runPassA>>; passB: Awaited<ReturnType<typeof runPassB>> | null } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`${vendorId}-pass-a-`) && f.endsWith(".json")).sort();
  const file = files.at(-1);
  if (!file) return null;
  const saved = JSON.parse(readFileSync(join(dir, file), "utf8"));
  if (!saved.extraction) return null;
  return {
    file,
    result: {
      extraction: ExtractionSchema.parse(saved.extraction),
      questionnaire: saved.questionnaire ?? [],
      unreadable_regions: [],
      notes: saved.notes ?? [],
      injection: saved.injection ?? [],
      errors: saved.errors ?? [],
      trace: saved.trace,
    },
    passB: saved.pass_b?.extraction
      ? { extraction: ExtractionSchema.parse(saved.pass_b.extraction), notes: saved.pass_b.notes ?? [], errors: saved.pass_b.errors ?? [], trace: saved.pass_b.trace }
      : null,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
