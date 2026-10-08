import Anthropic from "@anthropic-ai/sdk";
import { AnthropicChat, runAnalystTurn } from "../analyst/agent.js";
import { loadConfig } from "../config.js";
import { buildSession } from "./assemble.js";
import { setFromArgs } from "./vendors.js";

/**
 * Asks the analyst one question from the terminal (live; spends credit). Same agent as the UI's drawer.
 * Usage: npm run ask -- "Which vendor is cheapest on L23?" [--set holdout]
 */

async function main(): Promise<void> {
  const question = process.argv.slice(2).filter((a, i, all) => a !== "--set" && all[i - 1] !== "--set").join(" ").trim();
  if (!question) throw new Error('usage: npm run ask -- "your question"');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (.env at the repo root)");
  const config = loadConfig();
  const set = setFromArgs();
  const session = await buildSession(set, config);
  const r = await runAnalystTurn({
    session,
    client: new AnthropicChat(new Anthropic({ timeout: 240_000, maxRetries: config.limits.max_retries })),
    question,
    model: config.models.analyst,
    onEvent: (e) => {
      if (e.type === "tool") console.log(`  [${e.name} ${e.status}] ${e.summary}`);
      if (e.type === "correction") console.log(`  [grounding: sent back ${e.ungrounded.join(", ")}]`);
    },
  });
  for (const b of r.blocks) {
    if (b.type === "answer") console.log(`\n${b.markdown}\n`);
    if (b.type === "table") console.log([b.columns.join(" | "), ...b.rows.map((x) => x.join(" | "))].join("\n"));
    if (b.type === "trust") console.log(`\nTrust: ${b.headline} Cost range ${Math.round(b.cost_low)} to ${Math.round(b.cost_high)}.`);
    if (b.type === "assumptions") console.log(`Assumptions: ${b.items.join(" / ")}`);
    if (b.type === "actions") console.log(`Actions: ${b.items.map((x) => x.label).join(" / ")}`);
  }
  if (r.unverified.length) console.log(`UNVERIFIED figures: ${r.unverified.join(", ")}`);
  console.log(`\n${r.steps} steps, $${r.cost_usd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
