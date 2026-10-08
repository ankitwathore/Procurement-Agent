import { describe, expect, it } from "vitest";
import { RFX_LINES } from "../src/data/rfx.js";
import { createRng } from "../src/data/rng.js";
import { NOISE_PCT, generateVendorRates, quoteRate } from "../src/data/prices.js";

describe("seeded rng", () => {
  it("same seed gives the same sequence", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds give different sequences", () => {
    const a = createRng(42);
    const b = createRng(7);
    expect(a.next()).not.toBe(b.next());
  });

  it("values stay in [0, 1)", () => {
    const r = createRng(42);
    for (let i = 0; i < 10_000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("quoteRate (spec 17.5 rule)", () => {
  it("stays within +/-1.5% of baseline x factor, allowing 2dp rounding", () => {
    const rng = createRng(42);
    for (let i = 0; i < 5_000; i++) {
      const base = 2 + (i % 200) * 0.37;
      const factor = 0.9;
      const rate = quoteRate(base, factor, rng);
      const centre = base * factor;
      const bound = centre * (NOISE_PCT / 100) + 0.005;
      expect(Math.abs(rate - centre)).toBeLessThanOrEqual(bound);
    }
  });

  it("is rounded to 2 decimal places", () => {
    const rng = createRng(1);
    for (let i = 0; i < 200; i++) {
      const rate = quoteRate(39.5, 0.985, rng);
      expect(Math.round(rate * 100) / 100).toBe(rate);
    }
  });
});

describe("generateVendorRates", () => {
  it("is identical for the same seed, and differs across seeds", () => {
    const r1 = generateVendorRates("V1", RFX_LINES, createRng(42));
    const r2 = generateVendorRates("V1", RFX_LINES, createRng(42));
    const r3 = generateVendorRates("V1", RFX_LINES, createRng(7));
    expect([...r1.entries()]).toEqual([...r2.entries()]);
    expect([...r1.entries()]).not.toEqual([...r3.entries()]);
  });

  it("V1 quotes L01 to L25 and L26 to L30 with their factors", () => {
    const rates = generateVendorRates("V1", RFX_LINES, createRng(42));
    expect(rates.size).toBe(30);
    const l01 = RFX_LINES[0]!;
    expect(Math.abs(rates.get("L01")! - l01.baseline_price_inr * 0.985)).toBeLessThanOrEqual(
      l01.baseline_price_inr * 0.985 * 0.015 + 0.005,
    );
  });

  it("omits USD lines for V3 (L26 to L28) and generates the rest", () => {
    const rates = generateVendorRates("V3", RFX_LINES, createRng(42));
    expect(rates.size).toBe(27);
    expect(rates.has("L26")).toBe(false);
    expect(rates.has("L28")).toBe(false);
    expect(rates.has("L29")).toBe(true);
  });

  it("refuses to generate V5, which is statement based", () => {
    expect(() => generateVendorRates("V5", RFX_LINES, createRng(42))).toThrow(/statement based|not generated/);
  });
});
