import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { ExtractionSchema } from "../src/ingest/extraction.js";
import { checkLineTotal } from "../src/ingest/checks.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { span } from "./fixtures/v5.js";

const config = loadConfig();
const TOL = config.tolerances.arithmetic_pct;

describe("checkLineTotal (spec X02)", () => {
  it("passes an exact total and one inside tolerance (paise rounding)", () => {
    expect(checkLineTotal({ quantity: 6500, rate: 250.63, statedTotal: 6500 * 250.63 }, TOL)!.fails).toBe(false);
    expect(checkLineTotal({ quantity: 6500, rate: 250.63, statedTotal: 6500 * 250.63 * 1.004 }, TOL)!.fails).toBe(false);
  });

  it("fails a total 10 percent too high, and one too low", () => {
    const high = checkLineTotal({ quantity: 6500, rate: 250.63, statedTotal: 6500 * 250.63 * 1.1 }, TOL)!;
    expect(high.fails).toBe(true);
    expect(high.diff_pct).toBeCloseTo(10, 6);
    expect(checkLineTotal({ quantity: 6500, rate: 250.63, statedTotal: 6500 * 250.63 * 0.9 }, TOL)!.fails).toBe(true);
  });

  it("the tolerance boundary is inclusive", () => {
    expect(checkLineTotal({ quantity: 1000, rate: 100, statedTotal: 100500 }, 0.5)!.fails).toBe(false);
    expect(checkLineTotal({ quantity: 1000, rate: 100, statedTotal: 100501 }, 0.5)!.fails).toBe(true);
  });

  it("checks nothing when the vendor stated no total", () => {
    expect(checkLineTotal({ quantity: 6500, rate: 250.63, statedTotal: null }, TOL)).toBeNull();
  });
});

describe("arithmetic check inside the quote builder (vector 17, trap 10)", () => {
  // V2 shows GST inclusive rates. Displayed L15 = 236 x 0.90 x 1.18 = 250.63 (rounded).
  const DISPLAYED = 250.63;
  const SNIPPET = "Washing machine outer carton 7 ply Rs 250.63 per pc";
  const TEXT = `${SNIPPET} total 1792004.50\nAll rates are inclusive of GST at 18 percent.`;
  const GST_SNIPPET = "All rates are inclusive of GST at 18 percent.";
  const DELIVERED = "total 1792004.50";

  function l15(total: number | null) {
    const extraction = ExtractionSchema.parse({
      vendor_terms: {
        gst_basis: { value: "inclusive", rate_pct: 18, snippet: GST_SNIPPET, locator: span(TEXT, GST_SNIPPET) },
        freight_basis: { value: "delivered", snippet: DELIVERED, locator: span(TEXT, DELIVERED) },
      },
      rows: [
        {
          row_id: "r1",
          raw_text: SNIPPET,
          mapped_line_candidates: [{ line_id: "L15", match_confidence: 0.95, reasons: ["description", "ply"] }],
          rate: { value: DISPLAYED, currency: "INR", unit_as_written: "per pc" },
          line_total_as_written: total,
          locator: span(TEXT, SNIPPET),
          snippet: SNIPPET,
        },
      ],
    });
    const { quotes } = buildQuotes({
      vendorId: "V2",
      vendorCity: "Ahmedabad",
      config,
      lines: RFX_LINES,
      extraction,
      sourceText: TEXT,
      textNative: true,
    });
    return quotes.find((q) => q.line_id === "L15")!;
  }

  it("a total 10 percent over quantity x rate becomes NEEDS_REVIEW (rule 6) with both numbers", () => {
    const q = l15(6500 * DISPLAYED * 1.1);
    expect(q.state).toBe("NEEDS_REVIEW");
    expect(q.state_rule).toBe(6);
    expect(q.flags).toContain("arithmetic_mismatch");
    expect(q.state_reason).toMatch(/vendor total .* vs quantity x rate/);
    expect(q.arithmetic).toMatchObject({ fails: true, stated: expect.closeTo(6500 * DISPLAYED * 1.1, 4) });
    expect(q.arithmetic!.diff_pct).toBeCloseTo(10, 6);
  });

  it("keeps the stated ex GST rate as the point and spans the rate the total implies", () => {
    const base = l15(6500 * DISPLAYED * 1.1).components[0]!;
    expect(base.point).toBeCloseTo(DISPLAYED / 1.18, 6);
    expect(base.low).toBeCloseTo(DISPLAYED / 1.18, 6);
    expect(base.high).toBeCloseTo((DISPLAYED * 1.1) / 1.18, 6);
    expect(base.state).toBe("NEEDS_REVIEW");
  });

  it("a matching total leaves the cell safe", () => {
    const q = l15(6500 * DISPLAYED);
    expect(q.arithmetic).toMatchObject({ fails: false });
    expect(q.flags).not.toContain("arithmetic_mismatch");
    expect(q.state).toBe("CONFIRMED");
  });

  it("no stated total means no check and no flag", () => {
    const q = l15(null);
    expect(q.arithmetic).toBeNull();
    expect(q.state).toBe("CONFIRMED");
  });
});
