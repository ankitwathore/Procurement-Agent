import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";

const CONFIG_PATH = fileURLToPath(new URL("../../config.yaml", import.meta.url));
const VALID_YAML = readFileSync(CONFIG_PATH, "utf8");

describe("config.yaml (spec 7.3)", () => {
  it("loads the repo config with the spec's dates and models", () => {
    const c = loadConfig(CONFIG_PATH);
    expect(c.as_of_date).toBe("2026-10-08");
    expect(c.expected_award_date).toBe("2026-10-12");
    expect(c.fx.USD_INR).toBe(88);
    expect(c.freight.lanes.Pune).toBe(1.1);
    expect(c.freight.lanes.Vapi).toBeUndefined();
    expect(c.models.adjudicator).toBe("claude-opus-5-5");
    expect(c.optimizer.default_mode).toBe("risk_adjusted");
  });

  it("rejects a malformed date", () => {
    const bad = VALID_YAML.replace("as_of_date: 2026-10-08", "as_of_date: 08/10/2026");
    expect(() => parseConfig(bad)).toThrow(/YYYY-MM-DD/);
  });

  it("rejects a missing section", () => {
    const bad = VALID_YAML.replace(/^limits:[\s\S]*$/m, "");
    expect(() => parseConfig(bad)).toThrow();
  });

  it("rejects an unknown optimizer mode", () => {
    const bad = VALID_YAML.replace("default_mode: risk_adjusted", "default_mode: greedy");
    expect(() => parseConfig(bad)).toThrow();
  });
});
