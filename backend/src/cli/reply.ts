import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { QUESTIONS, RFX_HEADER, RFX_LINES } from "../data/rfx.js";
import { runPassA, type PassADocument } from "../ingest/extract_a.js";
import { ExtractionSchema, type Extraction } from "../ingest/extraction.js";
import { parseEmail } from "../ingest/parse_email.js";
import type { Quote } from "../ingest/quotes.js";
import { AnthropicLlm } from "../llm/client.js";
import { draftClarification } from "../review/clarify.js";
import { applyClarificationReply, classifyInbound, type CellView } from "../review/reply.js";
import { formatRupees } from "../util/format.js";
import { ROOT, VENDORS, latestRun } from "./vendors.js";

/**
 * The reply loop on the scripted reply (spec 13.2, 13.4): drafts the clarification from the latest live runs, reads the
 * vendor's reply to it with pass A (one live call, spends credit), and shows which cells changed.
 * Usage: npm run reply -- --vendor V5 [--reuse]   (--reuse replays the latest saved reply extraction; free)
 */

const REPLIES: Record<string, string> = { V5: "V5/Re_Clarification_KHA-PKG-FY26-27.eml" };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const show = (c: CellView) =>
  c.rate_inr === null ? `${c.state}, no price` : `rate ${c.rate_inr.toFixed(2)} ${c.rate_state}, landed ${c.landed?.toFixed(2) ?? "-"} ${c.state}`;

async function main(): Promise<void> {
  const vendorId = arg("vendor") ?? "V5";
  const replyFile = REPLIES[vendorId];
  if (!replyFile) throw new Error(`no scripted reply for ${vendorId}; have ${Object.keys(REPLIES).join(", ")}`);
  const config = loadConfig();

  const all: Quote[] = [];
  let vendorTerms: Extraction["vendor_terms"] | null = null;
  for (const v of Object.keys(VENDORS)) {
    const run = await latestRun(v, config);
    all.push(...(run?.quotes ?? []));
    if (v === vendorId) vendorTerms = run?.vendorTerms ?? null;
  }
  if (!vendorTerms) throw new Error(`no saved live run for ${vendorId}; run npm run extract -- --vendor ${vendorId} first`);
  const thread = draftClarification(vendorId, all, RFX_LINES, RFX_HEADER);
  if (!thread) throw new Error(`${vendorId} has nothing to clarify, so there is no thread to reply to`);
  console.log(`clarification ${thread.message_id} (${thread.status}): ${thread.items.length} item(s) on ${thread.items.flatMap((i) => i.lines).join(", ")}`);

  const reply = await parseEmail(readFileSync(join(ROOT, "data", "vendors", replyFile)));
  const c = classifyInbound(reply, [thread]);
  console.log(`inbound ${reply.message_id}: ${c.intent} (${c.reason})`);
  if (c.intent !== "clarification_reply") return;

  const doc: PassADocument = { vendor_id: vendorId, kind: "email", text: reply.text, authoritative_end: reply.new_text_end, message_id: reply.message_id };
  const runDir = join(ROOT, "data", "runs");
  let extraction: Extraction | null;
  let saved: Record<string, unknown>;
  if (process.argv.includes("--reuse")) {
    const file = readdirSync(runDir).filter((f) => f.startsWith(`${vendorId}-reply-`)).sort().at(-1);
    if (!file) throw new Error(`no saved reply run for ${vendorId}; run without --reuse first`);
    saved = JSON.parse(readFileSync(join(runDir, file), "utf8"));
    extraction = saved.extraction ? ExtractionSchema.parse(saved.extraction) : null;
    console.log(`reusing the reply extraction from ${file}`);
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set. Put it in .env at the repo root (see .env.example), or use --reuse.");
      process.exit(2);
    }
    const client = new AnthropicLlm({ timeoutMs: config.limits.llm_timeout_s * 1000, maxRetries: config.limits.max_retries });
    const asked = thread.items.flatMap((i) => i.lines).map((id) => `${id} (${RFX_LINES.find((l) => l.line_id === id)?.description})`);
    const task =
      `This email from vendor ${vendorId} replies to our clarification about ${asked.join(", ")}. ` +
      "Report a row only where the vendor's new message gives a rate for one of those lines. Our own questions are quoted below the reply; they are not the vendor's answer.";
    const result = await runPassA(doc, { client, config, lines: RFX_LINES, questions: QUESTIONS, task });
    const t = result.trace;
    console.log(`extract_a on the reply: model ${t.model_used}${t.fallback_used ? " (FALLBACK)" : ""}, stop ${t.stop_reason}, ${t.ms} ms, $${t.cost_usd?.toFixed(4) ?? "?"}`);
    if (result.errors.length) console.log(`errors: ${result.errors.join("; ")}`);
    extraction = result.extraction;
    saved = { vendor_id: vendorId, in_reply_to: thread.message_id, message_id: reply.message_id, trace: t, errors: result.errors, notes: result.notes, extraction };
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, `${vendorId}-reply-${t.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, JSON.stringify(saved, null, 2));
    console.log(`saved ${path.replace(ROOT, "")}`);
  }
  if (!extraction) return;

  const r = applyClarificationReply({
    thread,
    quotes: all,
    base: { vendorCity: VENDORS[vendorId]!.city, config, lines: RFX_LINES, vendorTerms },
    reply,
    extraction,
    at: reply.sent_at?.toISOString() ?? new Date().toISOString(),
  });
  console.log(`\n${r.headline}`);
  for (const ch of r.changes) {
    const delta = ch.delta_annual_inr === null ? "" : `, ${ch.delta_annual_inr >= 0 ? "+" : ""}${formatRupees(ch.delta_annual_inr)} a year`;
    console.log(`  ${ch.line_id}: ${show(ch.before)}  ->  ${show(ch.after)}${delta}`);
    console.log(`        from "${ch.after.snippet}"`);
  }
  for (const it of r.items) console.log(`  item ${it.lines.join(", ")}: ${it.status}. ${it.detail}`);
  for (const x of [...r.ignored, ...r.rejected]) console.log(`  row ${x.row_id} not applied: ${x.reason}`);
  const left = draftClarification(vendorId, r.quotes, RFX_LINES, RFX_HEADER, undefined, 2);
  console.log(left ? `\nstill open, next clarification would ask:\n${left.items.map((i) => `  - ${i.question}`).join("\n")}` : `\nnothing left to clarify for ${vendorId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
