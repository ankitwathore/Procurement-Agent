import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const ConfigSchema = z.object({
  as_of_date: isoDate,
  expected_award_date: isoDate,
  rfx_issue_date: isoDate,
  rfx_due_date: isoDate,
  currency_of_record: z.literal("INR"),
  buyer_utc_offset: z.string().regex(/^[+-]\d{2}:\d{2}$/, "expected +HH:MM"),
  fx: z.object({
    USD_INR: z.number().positive(),
    snapshot_date: isoDate,
    clause_band_pct: z.number().nonnegative(),
  }),
  gst: z.object({
    default_rate_pct: z.number().nonnegative(),
  }),
  tolerances: z.object({
    rate_agreement_pct: z.number().nonnegative(),
    arithmetic_pct: z.number().nonnegative(),
    dim_tolerance_pct: z.number().nonnegative(),
    outlier_vs_peer_median: z.tuple([z.number(), z.number()]),
    outlier_vs_baseline: z.tuple([z.number(), z.number()]),
    magnitude_slip_ratios: z.array(z.number().positive()),
  }),
  freight: z.object({
    lanes: z.record(z.string(), z.number().nonnegative()),
    default_when_unknown: z.number().nonnegative(),
    band_pct_lane_known: z.number().nonnegative(),
    band_pct_default: z.number().nonnegative(),
  }),
  inference_bands: z.object({
    baseline_same_as_last_year: z.object({
      low_pct: z.number(),
      high_pct: z.number(),
    }),
  }),
  exposure: z.object({
    safe_states: z.array(z.string()).min(1),
  }),
  award_gate: z.object({
    block_if_exposure_pct_over: z.number().nonnegative(),
    require_ack_if_exposure_pct_over: z.number().nonnegative(),
  }),
  optimizer: z.object({
    default_mode: z.enum(["trusted_only", "point", "risk_adjusted"]),
    default_max_vendor_share_pct: z.number().positive().max(100),
    capacity_utilization: z.number().positive().max(1),
  }),
  models: z.object({
    extract_a: z.string(),
    extract_b: z.string(),
    adjudicator: z.string(),
    analyst: z.string(),
    copilot: z.string(),
    light: z.string(),
  }),
  limits: z.object({
    max_cost_usd_per_document: z.number().positive(),
    llm_timeout_s: z.number().positive(),
    max_retries: z.number().int().nonnegative(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parses and validates a config document. Throws a ZodError on invalid input. */
export function parseConfig(yamlText: string): Config {
  return ConfigSchema.parse(parse(yamlText));
}

/**
 * Loads config from QUOTEKILL_CONFIG if set, otherwise the repo-root config.yaml.
 */
export function loadConfig(path = process.env.QUOTEKILL_CONFIG ?? defaultConfigPath()): Config {
  return parseConfig(readFileSync(path, "utf8"));
}

function defaultConfigPath(): string {
  return fileURLToPath(new URL("../../config.yaml", import.meta.url));
}
