import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicChat, runAnalystTurn, type TurnResult } from "../analyst/agent.js";
import { loadConfig } from "../config.js";
import { GOLDEN, genericChecks, textOf, type CheckResult, type GoldenContext } from "../eval/golden.js";
import { regate, verifyQuote } from "../store/apply.js";
import { buildSession } from "./assemble.js";
import { ROOT, dataDir, setFromArgs } from "./vendors.js";

/**
 * The analyst's golden questions (spec 19.5), live: each in a fresh conversation, checked on numbers, mentions and
 * behaviour. Spends credit (Claude Opus); never starts a question that could take the total past the cap ($5 by
 * default), and stops cleanly on an API error such as no credit.
 * Usage: npm run golden [-- --only G1,G10] [--cap 5] [--set holdout]
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (.env at the repo root)");
  const config = loadConfig();
  const set = setFromArgs();
  const only = arg("only")?.split(",");
  const cap = Number(arg("cap") ?? 5);
  // A question cannot be stopped part way, so one is started only if a question as costly as the dearest so far
  // (at least $0.50) still fits under the cap.
  let dearest = 0.5;
  const gt = JSON.parse(readFileSync(join(dataDir(set), "ground_truth.json"), "utf8"));
  const client = new AnthropicChat(new Anthropic({ timeout: 300_000, maxRetries: config.limits.max_retries }));
  const cases = GOLDEN.filter((c) => !only || only.includes(c.id));
  const rows: { id: string; question: string; checks: CheckResult[]; cost: number; steps: number; answer: string; error: string | null }[] = [];
  let total = 0;

  for (const c of cases) {
    if (total + dearest > cap) {
      console.log(`stopping before ${c.id}: $${total.toFixed(2)} spent, and another question could pass the $${cap} cap`);
      break;
    }
    // A fresh session per case, so nothing one case does can leak into the next.
    const session = await buildSession(set, config);
    // Writes change only this case's session (nothing is stored), so a check can see their effect.
    const writes = {
      verify: (vendor: string, line: string, reason: string) => {
        const v = session.vendors.find((x) => x.vendor_id === vendor);
        const q = v?.quotes.find((x) => x.line_id === line);
        if (!v || !q) throw new Error(`no cell ${vendor} ${line}`);
        const next = verifyQuote(q, reason);
        v.quotes = v.quotes.map((x) => (x.line_id === line ? next : x));
      },
      waive: (vendor: string, q: string, reason: string) => regate(session, vendor, [{ q_id: q, reason, actor: "golden" }]),
    };
    const ask = (question: string, history?: TurnResult["messages"]) =>
      runAnalystTurn({ session, client, question, history, model: config.models.analyst, writes, onEvent: (e) => e.type === "tool" && e.status !== "start" && process.stdout.write(".") });
    process.stdout.write(`${c.id} `);
    try {
      const first = await ask(c.question);
      const r = c.followup ? await ask(c.followup, first.messages) : first;
      const ctx: GoldenContext = {
        gt,
        fx: config.fx.USD_INR,
        gatesAfter: Object.fromEntries(session.vendors.map((v) => [v.vendor_id, v.gates.overall])),
        stateAfter: (v, l) => session.vendors.find((x) => x.vendor_id === v)?.quotes.find((q) => q.line_id === l)?.state,
      };
      const checks = [...genericChecks(r, c), ...c.checks(r, ctx, first)];
      const cost = first.cost_usd + (c.followup ? r.cost_usd : 0);
      total += cost;
      dearest = Math.max(dearest, cost);
      rows.push({ id: c.id, question: c.question + (c.followup ? ` / then: ${c.followup}` : ""), checks, cost, steps: first.steps + (c.followup ? r.steps : 0), answer: textOf(r), error: null });
      const failed = checks.filter((x) => !x.pass);
      console.log(` ${failed.length ? `FAIL (${failed.map((x) => x.name).join("; ")})` : "pass"}  $${cost.toFixed(3)}`);
    } catch (err) {
      const msg = (err as Error).message;
      rows.push({ id: c.id, question: c.question, checks: [], cost: 0, steps: 0, answer: "", error: msg });
      console.log(` ERROR ${msg.slice(0, 160)}`);
      if (/credit balance|authentication|invalid x-api-key|permission/i.test(msg)) {
        console.log("stopping: the API cannot be used until this is fixed");
        break;
      }
    }
  }

  const passed = rows.filter((r) => !r.error && r.checks.every((x) => x.pass)).length;
  const checksTotal = rows.reduce((n, r) => n + r.checks.length, 0);
  const checksPassed = rows.reduce((n, r) => n + r.checks.filter((x) => x.pass).length, 0);
  const now = new Date().toISOString();
  const md = [
    `# Analyst golden questions (${set} set, ${now.slice(0, 10)})`,
    "",
    `**${passed} of ${rows.length} questions passed every check; ${checksPassed} of ${checksTotal} checks passed.** Cost $${total.toFixed(2)}. Target (spec 19.7): at least 90 percent of questions.`,
    "",
    "| Id | Result | Failed checks | Cost |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.error ? "error" : r.checks.every((x) => x.pass) ? "pass" : "fail"} | ${r.error ? r.error.slice(0, 120) : r.checks.filter((x) => !x.pass).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`).join("; ").replace(/\|/g, "/")} | $${r.cost.toFixed(3)} |`),
    "",
    ...rows.flatMap((r) => [`## ${r.id}: ${r.question}`, "", ...r.checks.map((x) => `- ${x.pass ? "pass" : "FAIL"}: ${x.name}${x.detail ? ` (${x.detail})` : ""}`), "", "```", r.error ?? r.answer, "```", ""]),
  ].join("\n");
  const dir = join(ROOT, "eval", "golden");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${now.replace(/[:.]/g, "-")}-${set}.md`);
  writeFileSync(file, md);
  console.log(`\n${passed} of ${rows.length} passed, ${checksPassed} of ${checksTotal} checks, $${total.toFixed(2)}. Report: ${file.replace(ROOT, "")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
