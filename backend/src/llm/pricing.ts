/**
 * USD per million tokens (Anthropic first-party API, as of 2026-10). Cache writes are 1.25x input (5 minute TTL).
 * Haiku 5.5's cache read rate is assumed at 0.1x input; the others are published figures.
 */
export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }, // Sonnet 5.5's refusal fallback
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Cost of one call in USD, or null for a model with no known price (never a guess). */
export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cache_read + u.cache_creation_input_tokens * p.cache_write) /
    1_000_000
  );
}
