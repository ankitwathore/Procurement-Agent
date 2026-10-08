import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";

/**
 * Free credential check: lists models and looks up the ones config.yaml uses. No tokens, no cost.
 * Usage: npm run check-key
 */
async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env at the repo root (see .env.example).");
    process.exit(2);
  }
  const client = new Anthropic({ maxRetries: 1, timeout: 20_000 });
  try {
    const page = await client.models.list({ limit: 20 });
    console.log(`key accepted: ${page.data.length} models visible`);
    for (const m of page.data) console.log(`  ${m.id}`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.error("key rejected (401): not a valid API key for the Claude API");
    else if (err instanceof Anthropic.PermissionDeniedError) console.error("key valid but not permitted (403)");
    else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
    else console.error(`could not reach the API: ${(err as Error).message}`);
    process.exit(1);
  }

  const config = loadConfig();
  for (const id of [...new Set(Object.values(config.models))]) {
    try {
      const m = await client.models.retrieve(id);
      console.log(`model ${id}: available (${m.display_name})`);
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : "?";
      console.log(`model ${id}: NOT available to this key (${status})`);
    }
  }
}

main();
