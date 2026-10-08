import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { checkOutlier, median } from "../src/ingest/checks.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { V5_EMAIL, v5Extraction } from "./fixtures/v5.js";

const config = loadConfig();
const tol = config.tolerances;

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("checkOutlier (spec vector 16, trap 04)", () => {
  const peers = [110.8, 112, 115, 109];

  it("flags V1 L06 at 11.08 as a decimal slip and suggests, but does not apply, about 110.8", () => {
    const r = checkOutlier(11.08, peers, 112.5, tol);
    expect(r.hardOutlier).toBe(true);
    expect(r.slip).toMatchObject({ factor: 10, against: "peer_median" });
    expect(r.slip!.suggested_rate).toBeCloseTo(110.8, 1);
  });

  it("detects the slip the other way (1108 instead of 110.8)", () => {
    const r = checkOutlier(1108, peers, 112.5, tol);
    expect(r.slip).toMatchObject({ factor: 10 });
    expect(r.slip!.suggested_rate).toBeCloseTo(110.8, 1);
  });

  it("detects a per dozen slip (factor 12)", () => {
    const r = checkOutlier(9.3, peers, 112.5, tol);
    expect(r.slip).toMatchObject({ factor: 12 });
    expect(r.slip!.suggested_rate).toBeCloseTo(111.6, 1);
  });

  it("falls back to the baseline when there are too few peers", () => {
    const r = checkOutlier(11.08, [110], 112.5, tol);
    expect(r.slip).toMatchObject({ factor: 10, against: "baseline", reference: 112.5 });
  });

  it("does not flag a normal competitive rate (V4 at 0.88 of baseline)", () => {
    const r = checkOutlier(99, peers, 112.5, tol);
    expect(r).toEqual({ hardOutlier: false, reasons: [], slip: null });
  });

  it("flags a plain outlier with no slip suggestion", () => {
    const r = checkOutlier(50, peers, 112.5, tol);
    expect(r.hardOutlier).toBe(true);
    expect(r.slip).toBeNull();
    expect(r.reasons[0]).toMatch(/peer median/);
  });

  it("band edges are inclusive: 0.6x passes, just under fails", () => {
    expect(checkOutlier(66, [110, 110], null, tol).hardOutlier).toBe(false);
    expect(checkOutlier(65, [110, 110], null, tol).hardOutlier).toBe(true);
  });

  it("slip tolerance is 5 percent of the factor", () => {
    expect(checkOutlier(10, [104, 104], null, tol).slip).not.toBeNull(); // ratio 10.4
    expect(checkOutlier(10, [106, 106], null, tol).slip).toBeNull(); // ratio 10.6
  });

  it("judges nothing when there is no reference at all", () => {
    expect(checkOutlier(11.08, [], null, tol)).toEqual({ hardOutlier: false, reasons: [], slip: null });
  });
});

describe("outlier check inside the quote builder", () => {
  function l23(rate: number, peers: number[]) {
    const extraction = v5Extraction();
    extraction.rows[0]!.rate.value = rate;
    const { quotes } = buildQuotes({
      vendorId: "V5",
      vendorCity: "Vapi",
      config,
      lines: RFX_LINES,
      extraction,
      sourceText: V5_EMAIL,
      textNative: true,
      peerRates: new Map([["L23", peers]]),
    });
    return quotes.find((q) => q.line_id === "L23")!;
  }

  it("a slipped rate becomes NEEDS_REVIEW, keeps the stated value, spans both readings, never applies the fix", () => {
    const q = l23(4.2, [40.5, 41, 43]);
    const base = q.components.find((c) => c.kind === "base_rate")!;
    expect(q.state).toBe("NEEDS_REVIEW");
    expect(q.state_rule).toBe(5);
    expect(q.flags).toContain("magnitude_slip");
    expect(base.point).toBe(4.2);
    expect(base.low).toBe(4.2);
    expect(base.high).toBeCloseTo(42, 6);
    expect(q.suggested_reading).toMatchObject({ factor: 10, suggested_rate: expect.closeTo(42, 6) });
  });

  it("a sane rate is untouched by the check", () => {
    const q = l23(42, [40.5, 41, 43]);
    expect(q.suggested_reading).toBeNull();
    expect(q.flags).not.toContain("magnitude_slip");
    expect(q.components[0]!.state).toBe("HIGH_CONF");
  });

  it("works without peer rates, using the baseline alone", () => {
    const extraction = v5Extraction();
    extraction.rows[0]!.rate.value = 4.45; // baseline 44.5 / 4.45 = 10
    const { quotes } = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction, sourceText: V5_EMAIL, textNative: true });
    expect(quotes.find((q) => q.line_id === "L23")!.state).toBe("NEEDS_REVIEW");
  });
});
