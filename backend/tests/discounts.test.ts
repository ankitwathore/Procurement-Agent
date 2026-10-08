import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { evaluateDiscount, resolveDiscount, type RawDiscount } from "../src/award/discounts.js";
import { assessVendor } from "../src/ingest/vendor.js";

const config = loadConfig();

// Trap 07: V2's footnote, "5 percent discount on invoice value if total annual PO value with us exceeds Rs 25,00,000."
const V2_FOOTNOTE: RawDiscount = {
  pct: 5,
  condition_text: "total annual PO value with us exceeds Rs 25,00,000",
  threshold_text: "Rs 25,00,000",
  threshold_inclusive: true,
  snippet: "5 percent discount on invoice value if total annual PO value with us exceeds Rs 25,00,000.",
};

describe("resolveDiscount", () => {
  it("parses the threshold from text in code (lakh, Indian grouping)", () => {
    expect(resolveDiscount(V2_FOOTNOTE)?.threshold_inr).toBe(2_500_000);
    expect(resolveDiscount({ ...V2_FOOTNOTE, threshold_text: "25 lakh" })?.threshold_inr).toBe(2_500_000);
    expect(resolveDiscount({ ...V2_FOOTNOTE, threshold_text: "Rs 1 crore" })?.threshold_inr).toBe(10_000_000);
  });

  it("returns null on an unreadable threshold or a nonsense percentage, never a guess", () => {
    expect(resolveDiscount({ ...V2_FOOTNOTE, threshold_text: "a large order" })).toBeNull();
    expect(resolveDiscount({ ...V2_FOOTNOTE, threshold_text: "0" })).toBeNull();
    expect(resolveDiscount({ ...V2_FOOTNOTE, pct: 0 })).toBeNull();
    expect(resolveDiscount({ ...V2_FOOTNOTE, pct: 150 })).toBeNull();
  });
});

describe("evaluateDiscount (spec vector 12)", () => {
  const d = resolveDiscount(V2_FOOTNOTE)!;

  it("5% above Rs 25 lakh on Rs 31.2 lakh is Rs 1.56 lakh off", () => {
    const e = evaluateDiscount(3_120_000, d);
    expect(e.applies).toBe(true);
    expect(e.amount).toBe(156_000);
    expect(e.net).toBe(2_964_000);
    expect(e.margin).toBe(620_000);
  });

  it("at Rs 24 lakh the discount is 0 and the shortfall is shown", () => {
    const e = evaluateDiscount(2_400_000, d);
    expect(e).toEqual({ applies: false, amount: 0, net: 2_400_000, margin: -100_000 });
  });

  it("the exact threshold applies when inclusive (spec 9.2) and not when strict ('exceeds')", () => {
    expect(evaluateDiscount(2_500_000, d).applies).toBe(true);
    expect(evaluateDiscount(2_500_000, { ...d, inclusive: false }).applies).toBe(false);
    expect(evaluateDiscount(2_500_001, { ...d, inclusive: false }).applies).toBe(true);
  });

  it("a discount can flip a vendor ahead of a rival: net value falls below the threshold-miss alternative", () => {
    const withDiscount = evaluateDiscount(2_600_000, d).net; // 2,470,000
    const withoutDiscount = evaluateDiscount(2_490_000, d).net; // 2,490,000
    expect(withDiscount).toBeLessThan(withoutDiscount);
  });
});

describe("conditional discounts as vendor discrepancies", () => {
  it("records the case for the optimizer and tells the buyer in plain words", () => {
    const a = assessVendor({ conditional_discounts: [{ ...V2_FOOTNOTE, locator: { type: "pdf" } }] }, undefined, config);
    expect(a.conditional_discounts).toEqual([expect.objectContaining({ pct: 5, threshold_inr: 2_500_000 })]);
    const d = a.discrepancies.find((x) => x.kind === "conditional_discount")!;
    expect(d.severity).toBe("info");
    expect(d.detail).toBe("5% discount applies only if this vendor's total value is at least Rs 25,00,000.");
  });

  it("warns, and applies nothing, when the threshold cannot be read", () => {
    const a = assessVendor({ conditional_discounts: [{ ...V2_FOOTNOTE, threshold_text: "big orders", locator: { type: "pdf" } }] }, undefined, config);
    expect(a.conditional_discounts).toEqual([]);
    expect(a.discrepancies.find((x) => x.kind === "conditional_discount")).toMatchObject({ severity: "warn" });
  });
});
