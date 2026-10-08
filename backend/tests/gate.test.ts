import { describe, expect, it } from "vitest";
import { confirmAward, evaluateGate } from "../src/award/gate.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { formatRupees } from "../src/util/format.js";
import { V5_EMAIL, v5Extraction } from "./fixtures/v5.js";
import { comp, config, q, qc, run, vendor } from "./fixtures/quotes.js";

const GATE = config.award_gate; // block over 5 percent, acknowledge over 1 percent
const WHO = { actor: "Meera", at: "2026-10-08T12:00:00+05:30" };

/**
 * One line, one vendor: a confirmed base plus an inferred freight whose high reading equals its point,
 * so exposure = freight / (base + freight) and the thresholds can be hit exactly.
 */
function withFreight(base: number, freight: number) {
  const quote = qc("V1", "L01", [comp("base_rate", base), comp("freight", freight, "INFERRED", 0, freight)]);
  return run(["L01"], [vendor("V1", [quote])]);
}

describe("formatRupees", () => {
  it.each([
    [1_240_000, "Rs 12.4 lakh"],
    [101_500, "Rs 1.0 lakh"],
    [39_985_580, "Rs 4.00 crore"],
    [95_000, "Rs 95,000"],
    [0, "Rs 0"],
    [-250_000, "-Rs 2.5 lakh"],
  ])("%d -> %s", (n, text) => {
    expect(formatRupees(n)).toBe(text);
  });
});

describe("evaluateGate thresholds (spec 15.6)", () => {
  it("allows an award that is almost entirely confirmed", () => {
    const gate = evaluateGate(withFreight(40, 0.2), GATE);
    expect(gate.status).toBe("allowed");
    expect(gate.required_acknowledgments).toEqual([]);
  });

  it("requires acknowledgment between the two limits and lists the unsafe component", () => {
    const gate = evaluateGate(withFreight(39, 1), GATE); // 2.5 percent
    expect(gate.status).toBe("acknowledge");
    expect(gate.exposure_pct).toBeCloseTo(2.5, 9);
    expect(gate.required_acknowledgments.map((a) => a.id)).toEqual(["V1:L01:freight"]);
    expect(gate.headline).toBe("Rs 1.0 lakh of this award rests on 1 unconfirmed component.");
  });

  it("blocks above the block limit and says why and what to do", () => {
    const gate = evaluateGate(withFreight(19, 1.01), GATE); // about 5.05 percent
    expect(gate.status).toBe("blocked");
    expect(gate.blocked_reasons[0]).toMatch(/above the 5% limit.*Verify, clarify or change the allocation/);
    expect(gate.required_acknowledgments).toEqual([]);
    expect(gate.resolve_first[0]!.id).toBe("V1:L01:freight");
  });

  it("limits are 'over': exactly 1 percent is allowed, exactly 5 percent only needs acknowledgment", () => {
    expect(evaluateGate(withFreight(99, 1), GATE).status).toBe("allowed"); // 1.0 percent
    expect(evaluateGate(withFreight(19, 1), GATE).status).toBe("acknowledge"); // 5.0 percent
  });

  it("a fully confirmed award says so", () => {
    const gate = evaluateGate(run(["L01"], [vendor("V1", [q("V1", "L01", 40)])]), GATE);
    expect(gate).toMatchObject({ status: "allowed", unsafe_component_count: 0, headline: "Every component of this award is confirmed." });
  });

  it("blocks when nothing could be awarded", () => {
    const gate = evaluateGate(run(["L01"], [vendor("V1", [q("V1", "L01", 40)], "FAIL")]), GATE);
    expect(gate.status).toBe("blocked");
    expect(gate.blocked_reasons).toEqual(["No line could be awarded under the current constraints."]);
  });
});

describe("evaluateGate context", () => {
  it("warns, without blocking, about unfillable and single-source lines", () => {
    const r = run(["L01", "L02"], [vendor("V1", [q("V1", "L01", 40)])]);
    const gate = evaluateGate(r, GATE);
    expect(gate.status).toBe("allowed");
    expect(gate.warnings).toEqual([
      "1 line(s) could not be awarded: L02.",
      "1 line(s) have a single eligible vendor: L01.",
    ]);
  });

  it("lists the biggest unsafe components first, three at most", () => {
    const lines = ["L01", "L02", "L03", "L04"];
    const quotes = lines.map((id, i) => qc("V1", id, [comp("base_rate", 30), comp("freight", 1 + i * 2, "INFERRED", 0, 5)]));
    const gate = evaluateGate(run(lines, [vendor("V1", quotes)]), GATE);
    expect(gate.resolve_first).toHaveLength(3);
    const values = gate.resolve_first.map((a) => a.value_inr);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    expect(gate.unsafe_component_count).toBe(4);
  });
});

describe("confirmAward", () => {
  it("confirms an allowed award and records who, when, and the exposure", () => {
    const r = run(["L01"], [vendor("V1", [q("V1", "L01", 40)])]);
    const out = confirmAward(r, evaluateGate(r, GATE), [], WHO);
    expect(out).toMatchObject({ ok: true, record: { actor: "Meera", confirmed_at: WHO.at, exposure_inr: 0, acknowledged_ids: [] } });
  });

  it("refuses a blocked award regardless of acknowledgments", () => {
    const r = withFreight(19, 1.01);
    const gate = evaluateGate(r, GATE);
    const out = confirmAward(r, gate, ["V1:L01:freight"], WHO);
    expect(out).toMatchObject({ ok: false });
    expect(out.ok === false && out.reason).toMatch(/above the 5% limit/);
  });

  it("requires every unsafe component to be acknowledged, and says which are outstanding", () => {
    const lines = ["L01", "L02"];
    const quotes = lines.map((id) => qc("V1", id, [comp("base_rate", 39), comp("freight", 1, "INFERRED", 0, 1.3)])); // 2.5 percent
    const r = run(lines, [vendor("V1", quotes)]);
    const gate = evaluateGate(r, GATE);
    expect(gate.status).toBe("acknowledge");

    const partial = confirmAward(r, gate, ["V1:L01:freight"], WHO);
    expect(partial).toMatchObject({ ok: false, missing_acknowledgments: ["V1:L02:freight"] });

    const full = confirmAward(r, gate, ["V1:L01:freight", "V1:L02:freight"], WHO);
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.record.acknowledged_ids).toEqual(["V1:L01:freight", "V1:L02:freight"].sort((a, b) => (a < b ? -1 : 1)));
      expect(full.record.cost).toEqual(r.cost);
    }
  });

  it("ignores acknowledgments for things that are not required", () => {
    const r = withFreight(39, 1);
    const out = confirmAward(r, evaluateGate(r, GATE), ["V1:L01:freight", "V9:L99:base_rate"], WHO);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.record.acknowledged_ids).toEqual(["V1:L01:freight"]);
  });
});

describe("the gate on the real V5 pipeline", () => {
  it("blocks an award that is all guesses: 59 unconfirmed components", () => {
    const { quotes } = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: v5Extraction(), sourceText: V5_EMAIL, textNative: true });
    const r = run(RFX_LINES.map((l) => l.line_id), [vendor("V5", quotes, "UNKNOWN")], { gate_policy: "ignore_gates" });
    const gate = evaluateGate(r, GATE);
    expect(gate.status).toBe("blocked");
    expect(gate.unsafe_component_count).toBe(59);
    expect(gate.headline).toMatch(/^Rs [\d.]+ (lakh|crore) of this award rests on 59 unconfirmed components\.$/);
    expect(gate.exposure_pct).toBeGreaterThan(90);
    expect(gate.resolve_first).toHaveLength(3);
  });
});
