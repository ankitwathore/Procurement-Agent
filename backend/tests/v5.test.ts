import { beforeAll, describe, expect, it } from "vitest";
import { computeExposure } from "../src/award/exposure.js";
import { loadConfig } from "../src/config.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { ExtractionSchema } from "../src/ingest/extraction.js";
import { buildQuotes, type BuildInput, type Quote } from "../src/ingest/quotes.js";
import { V5_EMAIL, span, v5Extraction } from "./fixtures/v5.js";

const config = loadConfig();

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    vendorId: "V5",
    vendorCity: "Vapi", // not in the lane tariff, so the default tariff applies (trap 32)
    config,
    lines: RFX_LINES,
    extraction: v5Extraction(),
    sourceText: V5_EMAIL,
    textNative: true,
    ...overrides,
  };
}

describe("V5 email, end to end through the deterministic core", () => {
  let quotes: Quote[];
  const q = (id: string) => quotes.find((x) => x.line_id === id)!;

  beforeAll(() => {
    quotes = buildQuotes(input()).quotes;
  });

  it("produces a quote for all 30 lines and rejects nothing", () => {
    expect(quotes).toHaveLength(30);
    expect(quotes.every((x) => x.state !== "MISSING")).toBe(true);
    expect(buildQuotes(input()).rejected).toEqual([]);
  });

  it("vector 11: L23 at 42/kg, freight extra, default tariff 4.00 -> landed 46.00, 44.80 to 47.20", () => {
    const l23 = q("L23");
    expect(l23.landed!.point).toBeCloseTo(46.0, 2);
    expect(l23.landed!.low).toBeCloseTo(44.8, 2);
    expect(l23.landed!.high).toBeCloseTo(47.2, 2);
  });

  it("L23 base is HIGH_CONF (stated mapping assumption), freight INFERRED, quote INFERRED", () => {
    const [base, freight] = q("L23").components;
    expect(base).toMatchObject({ kind: "base_rate", state: "HIGH_CONF", basis: "stated" });
    expect(freight).toMatchObject({ kind: "freight", state: "INFERRED", basis: "default_tariff" });
    expect(q("L23").state).toBe("INFERRED");
    expect(q("L23").assumptions.join(" ")).toMatch(/not applied to piece priced cartons/);
  });

  it("L24 and L25 use 38/kg", () => {
    expect(q("L24").landed!.point).toBeCloseTo(42.0, 2);
    expect(q("L25").landed!.point).toBeCloseTo(42.0, 2);
  });

  it("vector 15: L01 same as last year -> base 39.50 (to 42.66), freight 3.28 (0 to 4.26), landed 42.78 (39.50 to 46.92)", () => {
    const l01 = q("L01");
    const [base, freight] = l01.components;
    expect(base).toMatchObject({ state: "INFERRED", basis: "baseline_same_as_last_year" });
    expect(base!.point).toBeCloseTo(39.5, 2);
    expect(base!.low).toBeCloseTo(39.5, 2);
    expect(base!.high).toBeCloseTo(42.66, 2);
    expect(freight!.point).toBeCloseTo(3.28, 2);
    expect(freight!.low).toBe(0);
    expect(freight!.high).toBeCloseTo(4.264, 3);
    expect(l01.landed!.point).toBeCloseTo(42.78, 2);
    expect(l01.landed!.low).toBeCloseTo(39.5, 2);
    expect(l01.landed!.high).toBeCloseTo(46.92, 2);
  });

  it("inferred cells quote the vendor's sentence as provenance", () => {
    expect(q("L01").components[0]!.provenance.snippet).toBe("rest same as last year");
    expect(q("L01").components[0]!.provenance.locator).toMatchObject({ type: "derived" });
    expect(q("L01").state).toBe("INFERRED");
  });

  it("prices V5's uncertainty in rupees (priced exposure)", () => {
    const allocation = RFX_LINES.map((line) => ({ quote: q(line.line_id), annual_qty: line.annual_qty }));
    const exp = computeExposure(allocation, config.exposure.safe_states);

    // 27 lines have INFERRED base + INFERRED freight; L23 to L25 have INFERRED freight; L24 and L25 also have a
    // base whose unit and currency are carried over from "Rs 42/kg", unsafe until the buyer confirms.
    expect(exp.unsafe_component_count).toBe(27 * 2 + 3 + 2);

    const lines27 = RFX_LINES.filter((l) => !["L23", "L24", "L25"].includes(l.line_id));
    const inferredBase = lines27.reduce((s, l) => s + l.annual_qty * l.baseline_price_inr, 0);
    const freightAll = RFX_LINES.reduce((s, l) => s + l.annual_qty * 4.0 * l.weight_kg_per_uom, 0);
    const statedBase = ["L23", "L24", "L25"].reduce((s, id) => {
      const l = RFX_LINES.find((x) => x.line_id === id)!;
      return s + l.annual_qty * (id === "L23" ? 42 : 38);
    }, 0);

    // Each unsafe component is valued at its high reading: baseline + 8 percent, freight + 30 percent.
    const carriedBase = (18800 + 27500) * 38; // L24 and L25 at 38 per kg, no band
    expect(exp.exposure_inr).toBeCloseTo(inferredBase * 1.08 + freightAll * 1.3 + carriedBase, 2);
    expect(exp.cost_point).toBeCloseTo(inferredBase + freightAll + statedBase, 2);
    expect(exp.cost_low).toBeLessThan(exp.cost_point);
    expect(exp.cost_high).toBeGreaterThan(exp.cost_point);
    expect(exp.unsafe[0]!.value_inr).toBeGreaterThanOrEqual(exp.unsafe[1]!.value_inr);
    // Almost everything V5 quoted is unconfirmed, which is the point of the product.
    expect(exp.exposure_pct).toBeGreaterThan(90);
  });
});

describe("trust guards", () => {
  it("never imputes lines when the vendor gave no default statement", () => {
    const extraction = v5Extraction();
    delete extraction.vendor_terms.lines_not_quoted_statement;
    const { quotes } = buildQuotes(input({ extraction }));
    const l01 = quotes.find((x) => x.line_id === "L01")!;
    expect(l01).toMatchObject({ state: "MISSING", components: [], landed: null });
    expect(quotes.filter((x) => x.state === "MISSING")).toHaveLength(27);
  });

  it("does not treat an unrelated statement as 'same as last year'", () => {
    const extraction = v5Extraction();
    extraction.vendor_terms.lines_not_quoted_statement!.resolves_to = "other";
    const { quotes } = buildQuotes(input({ extraction }));
    expect(quotes.find((x) => x.line_id === "L01")!.state).toBe("MISSING");
  });

  it("rejects rows that map to a hallucinated line id", () => {
    const extraction = v5Extraction();
    extraction.rows[0]!.mapped_line_candidates = [{ line_id: "L99", match_confidence: 0.9, reasons: [] }];
    const result = buildQuotes(input({ extraction }));
    expect(result.rejected).toEqual([{ row_id: "r1", reason: "unknown line id L99" }]);
    // L23 falls back to the baseline statement instead of silently using the bad row.
    expect(result.quotes.find((x) => x.line_id === "L23")!.components[0]!.basis).toBe("baseline_same_as_last_year");
  });

  it("rejects rows whose snippet is not at the stated span of the source", () => {
    const extraction = v5Extraction();
    extraction.rows[0]!.snippet = "Rs 49/kg for the 5-ply";
    const result = buildQuotes(input({ extraction }));
    expect(result.rejected[0]).toMatchObject({ row_id: "r1" });
    expect(result.rejected[0]!.reason).toMatch(/does not match the source/);
  });

  it("sends an unrecognised unit to NEEDS_REVIEW without guessing a value", () => {
    const extraction = v5Extraction();
    extraction.rows[0]!.rate.unit_as_written = null;
    const l23 = buildQuotes(input({ extraction })).quotes.find((x) => x.line_id === "L23")!;
    expect(l23).toMatchObject({ state: "NEEDS_REVIEW", landed: null, components: [] });
  });

  it("two rows for the same line is a conflict, not a pick", () => {
    const extraction = v5Extraction();
    extraction.rows.push({ ...extraction.rows[0]!, row_id: "r9" });
    const l23 = buildQuotes(input({ extraction })).quotes.find((x) => x.line_id === "L23")!;
    expect(l23).toMatchObject({ state: "NEEDS_REVIEW", landed: null });
  });

  it("a struck out row is NEEDS_REVIEW", () => {
    const extraction = v5Extraction();
    extraction.rows[0]!.struck_out_or_overwritten = true;
    const l23 = buildQuotes(input({ extraction })).quotes.find((x) => x.line_id === "L23")!;
    expect(l23.components[0]!.state).toBe("NEEDS_REVIEW");
    expect(l23.state).toBe("NEEDS_REVIEW");
  });

  it("delivered vendors get no freight component; unstated freight is flagged, not silently zero", () => {
    const delivered = v5Extraction();
    delivered.vendor_terms.freight_basis!.value = "delivered";
    const l23 = buildQuotes(input({ extraction: delivered })).quotes.find((x) => x.line_id === "L23")!;
    expect(l23.components.map((c) => c.kind)).toEqual(["base_rate"]);
    expect(l23.state).toBe("HIGH_CONF");

    const unstated = v5Extraction();
    delete unstated.vendor_terms.freight_basis;
    const l24 = buildQuotes(input({ extraction: unstated })).quotes.find((x) => x.line_id === "L24")!;
    expect(l24.flags).toContain("freight_basis_assumed");
  });

  it("uses the lane tariff and the narrow band when the vendor's city is on it", () => {
    const l23 = buildQuotes(input({ vendorCity: "Pune" })).quotes.find((x) => x.line_id === "L23")!;
    const freight = l23.components.find((c) => c.kind === "freight")!;
    expect(freight.basis).toBe("lane_tariff");
    expect(freight.point).toBeCloseTo(1.1, 10);
    expect(freight.low).toBeCloseTo(0.99, 10);
    expect(freight.high).toBeCloseTo(1.21, 10);
  });

  it("schema rejects extraction output with a missing mapping", () => {
    const bad = { vendor_terms: {}, rows: [{ row_id: "x", raw_text: "", mapped_line_candidates: [], rate: { value: 1, currency: "INR", unit_as_written: "kg" }, locator: { type: "email" }, snippet: "" }] };
    expect(ExtractionSchema.safeParse(bad).success).toBe(false);
    void span;
  });
});
