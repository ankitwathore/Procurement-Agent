import { describe, expect, it } from "vitest";
import { type Policy } from "../src/award/optimizer.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { V5_EMAIL, v5Extraction } from "./fixtures/v5.js";
import { assessment, config, q, run, vendor } from "./fixtures/quotes.js";

describe("cheapest eligible vendor per line", () => {
  it("picks the lowest landed price on each line independently", () => {
    const r = run(["L01", "L02"], [
      vendor("V1", [q("V1", "L01", 38), q("V1", "L02", 27)]),
      vendor("V2", [q("V2", "L01", 39), q("V2", "L02", 26)]),
    ]);
    expect(r.assignments.map((a) => [a.line_id, a.vendor_id])).toEqual([["L01", "V1"], ["L02", "V2"]]);
    expect(r.cost.point).toBeCloseTo(101500 * 38 + 65000 * 26, 6);
  });

  it("is deterministic", () => {
    const vs = [vendor("V1", [q("V1", "L01", 38)]), vendor("V2", [q("V2", "L01", 38)])];
    expect(JSON.stringify(run(["L01"], vs))).toBe(JSON.stringify(run(["L01"], vs)));
  });
});

describe("gate policy (the VP question)", () => {
  const vs = () => [
    vendor("V1", [q("V1", "L01", 40)], "PASS"),
    vendor("V2", [q("V2", "L01", 30)], "FAIL"),
    vendor("V3", [q("V3", "L01", 35)], "UNKNOWN"),
    vendor("V4", [q("V4", "L01", 36)], "WAIVED"),
  ];

  it("cleared_only keeps PASS and WAIVED and says why the rest were dropped", () => {
    const r = run(["L01"], vs());
    expect(r.assignments[0]!.vendor_id).toBe("V4");
    expect(r.excluded_vendors.map((e) => e.vendor_id)).toEqual(["V2", "V3"]);
    expect(r.excluded_vendors[0]!.reason).toMatch(/gates \(FAIL\)/);
  });

  it("include_unknown lets UNKNOWN through, ignore_gates lets everyone", () => {
    expect(run(["L01"], vs(), { gate_policy: "include_unknown" }).assignments[0]!.vendor_id).toBe("V3");
    expect(run(["L01"], vs(), { gate_policy: "ignore_gates" }).assignments[0]!.vendor_id).toBe("V2");
  });

  it("the buyer can exclude a vendor outright", () => {
    const r = run(["L01"], vs(), { exclude_vendors: ["V4"] });
    expect(r.assignments[0]!.vendor_id).toBe("V1");
  });
});

describe("spec policy and validity", () => {
  const vs = () => [
    vendor("V1", [q("V1", "L01", 30, { specKinds: ["spec_below_requirement"] })]),
    vendor("V2", [q("V2", "L01", 40)]),
  ];

  it("strict drops a spec deviation, and the line becomes single source", () => {
    const r = run(["L01"], vs());
    expect(r.assignments[0]).toMatchObject({ vendor_id: "V2", single_source: true });
    expect(r.single_source).toEqual(["L01"]);
    expect(r.assignments[0]!.rejected).toEqual([{ vendor_id: "V1", reason: "spec deviation: bf 16 offered vs 18 required" }]);
  });

  it("allow_deviations lets the cheaper, lighter board win", () => {
    expect(run(["L01"], vs(), { spec_policy: "allow_deviations" }).assignments[0]!.vendor_id).toBe("V1");
  });

  it("an upgrade does not block", () => {
    const r = run(["L01"], [vendor("V1", [q("V1", "L01", 30, { specKinds: ["spec_upgrade"] })]), vendor("V2", [q("V2", "L01", 40)])]);
    expect(r.assignments[0]!.vendor_id).toBe("V1");
  });

  it("a lapsed quote is left out unless the buyer includes it", () => {
    const lapsed = [vendor("V1", [q("V1", "L01", 30)], "PASS", assessment({ lapsed: true })), vendor("V2", [q("V2", "L01", 40)])];
    expect(run(["L01"], lapsed).assignments[0]!.vendor_id).toBe("V2");
    expect(run(["L01"], lapsed).excluded_vendors[0]).toEqual({ vendor_id: "V1", reason: "quote validity has lapsed" });
    expect(run(["L01"], lapsed, { include_expired_quotes: true }).assignments[0]!.vendor_id).toBe("V1");
  });
});

describe("coverage is never hidden", () => {
  it("a line nobody can supply is reported as unfillable, not dropped, and costs nothing", () => {
    const r = run(["L01", "L02"], [vendor("V1", [q("V1", "L01", 38)])]);
    expect(r.assignments).toHaveLength(2);
    expect(r.unfillable).toEqual(["L02"]);
    expect(r.assignments[1]).toMatchObject({ vendor_id: null, quote: null, price: null });
    expect(r.cost.point).toBeCloseTo(101500 * 38, 6);
    expect(r.baseline_value).toBeCloseTo(101500 * 39.5, 6);
  });

  it("an unquoted or unpriced cell is not eligible", () => {
    const missing = q("V1", "L01", 38);
    missing.state = "MISSING";
    const noPrice = { ...q("V2", "L01", 38), state: "NEEDS_REVIEW" as const, landed: null, components: [] };
    const r = run(["L01"], [vendor("V1", [missing]), vendor("V2", [noPrice]), vendor("V3", [q("V3", "L01", 50)])]);
    expect(r.assignments[0]!.vendor_id).toBe("V3");
    expect(r.assignments[0]!.rejected.map((x) => x.reason)).toEqual(["not quoted", "no usable price (NEEDS_REVIEW)"]);
  });
});

describe("cell policy: do not win on a guess (W01)", () => {
  const guessed = () => q("V5", "L01", 38, { state: "INFERRED", low: 36, high: 42 });
  const vs = () => [vendor("V5", [guessed()], "UNKNOWN"), vendor("V1", [q("V1", "L01", 40)])];
  const policy = { gate_policy: "ignore_gates" as const };

  it("point mode takes the cheap guess", () => {
    expect(run(["L01"], vs(), { ...policy, cell_policy: "point" }).assignments[0]!.vendor_id).toBe("V5");
  });

  it("risk adjusted prices the guess at its high bound, so the confirmed quote wins", () => {
    const r = run(["L01"], vs(), { ...policy, cell_policy: "risk_adjusted" });
    expect(r.assignments[0]).toMatchObject({ vendor_id: "V1", price: 40 });
  });

  it("trusted only removes the guess entirely", () => {
    const r = run(["L01"], vs(), { ...policy, cell_policy: "trusted_only" });
    expect(r.assignments[0]!.vendor_id).toBe("V1");
    expect(r.assignments[0]!.rejected[0]!.reason).toMatch(/unconfirmed components/);
  });

  it("reports the range and the exposure of what it chose", () => {
    const r = run(["L01"], [vendor("V5", [guessed()], "UNKNOWN")], { ...policy, cell_policy: "point" });
    expect(r.cost).toEqual({ point: 101500 * 38, low: 101500 * 36, high: 101500 * 42 });
    expect(r.exposure.unsafe_component_count).toBe(1);
    expect(r.exposure.exposure_pct).toBe(100);
  });

  it("breaks an exact price tie toward lower exposure, then vendor id", () => {
    const tied = [
      vendor("V1", [q("V1", "L01", 40, { state: "INFERRED", low: 40, high: 40 })]),
      vendor("V2", [q("V2", "L01", 40)]),
    ];
    expect(run(["L01"], tied).assignments[0]!.vendor_id).toBe("V2");
    const same = [vendor("V9", [q("V9", "L01", 40)]), vendor("V3", [q("V3", "L01", 40)])];
    expect(run(["L01"], same).assignments[0]!.vendor_id).toBe("V3");
  });
});

describe("V5 from the real pipeline under risk adjusted pricing (spec 17.11)", () => {
  const { quotes: v5 } = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: v5Extraction(), sourceText: V5_EMAIL, textNative: true });

  it("V5 looks cheapest on L23 by point, but loses when its freight guess is priced at the high bound", () => {
    // V5 L23 lands at 46.00 (range 44.80 to 47.20). A confirmed rival at 46.50 is dearer by point, cheaper by risk.
    const rival = vendor("V1", [q("V1", "L23", 46.5)]);
    const guess = vendor("V5", v5, "UNKNOWN");
    const common = { gate_policy: "ignore_gates" as const };
    expect(run(["L23"], [guess, rival], { ...common, cell_policy: "point" }).assignments[0]!.vendor_id).toBe("V5");
    expect(run(["L23"], [guess, rival], { ...common, cell_policy: "risk_adjusted" }).assignments[0]!.vendor_id).toBe("V1");
  });
});

describe("savings against baseline (W10)", () => {
  it("is computed on the same basis, only over lines that were filled", () => {
    const r = run(["L01"], [vendor("V1", [q("V1", "L01", 38)])]);
    expect(r.savings).toBeCloseTo(101500 * (39.5 - 38), 6);
    expect(r.savings_pct).toBeCloseTo(((39.5 - 38) / 39.5) * 100, 6);
  });
});

describe("conditional discounts are scored as cases on their true cost (W07)", () => {
  // A is dearer per line but earns 5 percent off if its total reaches the threshold.
  const build = (threshold: number) => [
    vendor("A", [q("A", "L01", 40), q("A", "L02", 27)], "PASS", assessment({ discount: { pct: 5, threshold_inr: threshold } })),
    vendor("B", [q("B", "L01", 39), q("B", "L02", 26.5)]),
  ];
  const A_GROSS = 101500 * 40 + 65000 * 27; // 5,815,000
  const B_TOTAL = 101500 * 39 + 65000 * 26.5; // 5,681,000

  it("chases the discount when it makes the vendor cheaper overall", () => {
    const r = run(["L01", "L02"], build(5_000_000));
    expect(r.assignments.map((a) => a.vendor_id)).toEqual(["A", "A"]);
    expect(r.cost.point).toBeCloseTo(A_GROSS * 0.95, 6); // 5,524,250
    expect(r.vendors[0]!.discount).toMatchObject({ applies: true, amount: A_GROSS * 0.05, margin: A_GROSS - 5_000_000 });
    expect(r.discount_cases.map((c) => c.assumed)).toEqual([[], ["A"]]);
    expect(r.discount_cases[0]!.objective_cost).toBeCloseTo(B_TOTAL, 6);
  });

  it("ignores a discount the allocation cannot actually earn", () => {
    const r = run(["L01", "L02"], build(6_000_000)); // A's gross is only 5,815,000
    expect(r.assignments.map((a) => a.vendor_id)).toEqual(["B", "B"]);
    expect(r.cost.point).toBeCloseTo(B_TOTAL, 6);
    const chased = r.discount_cases.find((c) => c.assumed.includes("A"))!;
    expect(chased.earned).toEqual([]);
    expect(chased.objective_cost).toBeCloseTo(A_GROSS, 6); // chasing it earned nothing
  });

  it("takes a discount that is earned by accident too, never leaving it off the books", () => {
    // B is cheapest outright and happens to clear its own threshold.
    const vs = [
      vendor("B", [q("B", "L01", 39), q("B", "L02", 26.5)], "PASS", assessment({ discount: { pct: 10, threshold_inr: 1_000_000 } })),
      vendor("A", [q("A", "L01", 40), q("A", "L02", 27)]),
    ];
    const r = run(["L01", "L02"], vs);
    expect(r.cost.point).toBeCloseTo(B_TOTAL * 0.9, 6);
    expect(r.vendors[0]!.discount!.applies).toBe(true);
  });

  it("notes, and does not guess at, a vendor with several conditional discounts", () => {
    const a = assessment();
    a.conditional_discounts = [
      { pct: 5, threshold_inr: 1, inclusive: true, condition_text: "", snippet: "" },
      { pct: 8, threshold_inr: 2, inclusive: true, condition_text: "", snippet: "" },
    ];
    const r = run(["L01"], [vendor("V1", [q("V1", "L01", 38)], "PASS", a)]);
    expect(r.notes[0]).toMatch(/2 conditional discounts; none modelled/);
    expect(r.cost.point).toBeCloseTo(101500 * 38, 6);
  });
});
