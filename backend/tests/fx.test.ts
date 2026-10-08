import { describe, expect, it } from "vitest";
import { computeExposure } from "../src/award/exposure.js";
import { loadConfig } from "../src/config.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { ExtractionSchema } from "../src/ingest/extraction.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { span } from "./fixtures/v5.js";

const config = loadConfig(); // USD_INR 88, clause band 3 percent

// Trap 15: V3 quotes L26 to L28 in USD, "subject to the RBI reference rate on the date of order".
const TEXT = [
  "Stretch film 23 micron USD 1.53 per kg",
  "BOPP tape 48mm USD 0.41 per roll",
  "Pallet corner protector USD 0.14 per piece",
  "Rate for ceiling fan master carton is Rs 77.15 per piece",
  "USD rates are subject to the RBI reference rate on the date of order.",
  "Delivered FOR Chakan.",
].join("\n");

const FX_CLAUSE = "USD rates are subject to the RBI reference rate on the date of order.";

function row(id: string, lineId: string, snippet: string, value: number, currency: string, unit: string) {
  return {
    row_id: id,
    raw_text: snippet,
    mapped_line_candidates: [{ line_id: lineId, match_confidence: 0.9, reasons: ["description"] }],
    rate: { value, currency, unit_as_written: unit },
    locator: span(TEXT, snippet),
    snippet,
  };
}

function build(withClause: boolean) {
  const extraction = ExtractionSchema.parse({
    vendor_terms: {
      freight_basis: { value: "delivered", snippet: "Delivered FOR Chakan.", locator: span(TEXT, "Delivered FOR Chakan.") },
      ...(withClause ? { fx_clause: { value_text: FX_CLAUSE, snippet: FX_CLAUSE, locator: span(TEXT, FX_CLAUSE) } } : {}),
    },
    rows: [
      row("r1", "L26", "Stretch film 23 micron USD 1.53 per kg", 1.53, "USD", "per kg"),
      row("r2", "L27", "BOPP tape 48mm USD 0.41 per roll", 0.41, "USD", "per roll"),
      row("r3", "L28", "Pallet corner protector USD 0.14 per piece", 0.14, "USD", "per piece"),
      row("r4", "L04", "Rate for ceiling fan master carton is Rs 77.15 per piece", 77.15, "INR", "per piece"),
    ],
  });
  return buildQuotes({ vendorId: "V3", vendorCity: "Hosur", config, lines: RFX_LINES, extraction, sourceText: TEXT, textNative: true });
}

describe("FX clause band (spec C01, C02, trap 15)", () => {
  const { quotes } = build(true);
  const q = (id: string) => quotes.find((x) => x.line_id === id)!;

  it("converts at the stored rate and shows the chain: USD 1.53 x 88 = Rs 134.64", () => {
    const base = q("L26").components[0]!;
    expect(base.point).toBeCloseTo(134.64, 2);
    expect(q("L26").chain.join(" ")).toMatch(/USD 1\.53 x 88 = Rs 134\.64/);
  });

  it("applies a +/-3% band around the converted rate", () => {
    const base = q("L26").components[0]!;
    expect(base.low).toBeCloseTo(134.64 * 0.97, 2); // 130.60
    expect(base.high).toBeCloseTo(134.64 * 1.03, 2); // 138.68
    expect(q("L27").components[0]!.point).toBeCloseTo(0.41 * 88, 2); // 36.08
    expect(q("L28").components[0]!.point).toBeCloseTo(0.14 * 88, 2); // 12.32
  });

  it("the price is INFERRED, not safe, with the clause basis and a flag", () => {
    expect(q("L26")).toMatchObject({ state: "INFERRED", state_rule: 11 });
    expect(q("L26").components[0]!).toMatchObject({ state: "INFERRED", basis: "fx_clause_band" });
    expect(q("L26").flags).toContain("fx_clause");
    expect(q("L26").state_reason).toMatch(/FX rate at the order date/);
  });

  it("leaves V3's INR lines alone", () => {
    const l04 = q("L04");
    expect(l04.components[0]).toMatchObject({ point: 77.15, low: 77.15, high: 77.15, basis: "stated" });
    expect(l04.state).toBe("CONFIRMED");
    expect(l04.flags).not.toContain("fx_clause");
  });

  it("puts the band into the rupee exposure", () => {
    const allocation = ["L26", "L27", "L28"].map((id) => ({
      quote: q(id),
      annual_qty: RFX_LINES.find((l) => l.line_id === id)!.annual_qty,
    }));
    const exp = computeExposure(allocation, config.exposure.safe_states);
    expect(exp.unsafe_component_count).toBe(3);
    const atPoint = 2500 * 134.64 + 60000 * 36.08 + 50000 * 12.32;
    expect(exp.exposure_inr).toBeCloseTo(atPoint * 1.03, 2); // valued at the top of the band
    expect(exp.cost_high - exp.cost_low).toBeCloseTo(atPoint * 0.06, 2);
  });

  it("without a clause, USD is converted at the snapshot rate with no band", () => {
    const l26 = build(false).quotes.find((x) => x.line_id === "L26")!;
    expect(l26.components[0]).toMatchObject({ basis: "stated", state: "CONFIRMED" });
    expect(l26.components[0]!.low).toBe(l26.components[0]!.high);
    expect(l26.flags).not.toContain("fx_clause");
  });

  it("is reported to the buyer as a vendor-level discrepancy", () => {
    const a = build(true).vendor;
    expect(a.discrepancies.find((d) => d.kind === "fx_clause")).toMatchObject({ severity: "info" });
    expect(build(false).vendor.discrepancies.some((d) => d.kind === "fx_clause")).toBe(false);
  });
});
