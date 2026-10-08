import { describe, expect, it } from "vitest";
import { exGst, freightPerUom, toBaseUomRate, toInr } from "../src/normalize/convert.js";
import { canonicalUnit, parseNumber } from "../src/normalize/parse.js";

const PIECE_LINE = { line_id: "L09", base_uom: "piece", weight_kg_per_uom: 0.14 } as const;
const KG_LINE = { line_id: "L23", base_uom: "kg", weight_kg_per_uom: 1 } as const;
const L04 = { line_id: "L04", base_uom: "piece", weight_kg_per_uom: 1.55 } as const;

function base(rate: number, unit: string, line: Parameters<typeof toBaseUomRate>[2]) {
  return toBaseUomRate(rate, canonicalUnit(unit)!, line);
}

describe("spec 9.3 test vectors", () => {
  it("1: Rs 640 per 100 pcs = 6.40 per piece", () => {
    const r = base(640, "per 100 pcs", PIECE_LINE);
    expect(r.ok && r.rate).toBeCloseTo(6.4, 10);
  });

  it("2: Rs 42,000 per ton = 42.00 per kg", () => {
    const r = base(42000, "per ton", KG_LINE);
    expect(r.ok && r.rate).toBeCloseTo(42, 10);
  });

  it("4: Rs 1.2 lakh per 1000 pcs = 120.00 per piece", () => {
    const r = base(parseNumber("Rs 1.2 lakh"), "per 1000 pcs", PIECE_LINE);
    expect(r.ok && r.rate).toBeCloseTo(120, 10);
  });

  it("6: USD 1.62 per kg at 88.00 = 142.56 INR per kg", () => {
    expect(toInr(1.62, "USD", 88).rate).toBeCloseTo(142.56, 10);
  });

  it("7: 79.54 inclusive of 18% GST = 67.41 ex GST", () => {
    expect(exGst(79.54, 18, true)).toBeCloseTo(67.41, 2);
    expect(exGst(79.54, 18, false)).toBe(79.54);
  });

  it("8 and 9: Ahmedabad freight 4.20/kg x 1.55 kg = 6.51; 67.41 + 6.51 = 73.92", () => {
    const freight = freightPerUom(4.2, L04.weight_kg_per_uom);
    expect(freight).toBeCloseTo(6.51, 2);
    expect(exGst(79.54, 18, true) + freight).toBeCloseTo(73.92, 2);
  });
});

describe("toBaseUomRate edge handling", () => {
  it("converts per kg to a piece line through the stated weight", () => {
    const r = base(40, "per kg", L04);
    expect(r.ok && r.rate).toBeCloseTo(62, 10);
    expect(r.ok && r.chain.length).toBe(2);
  });

  it("refuses per box with no count (never picks an interpretation)", () => {
    const r = base(2400, "per box", { line_id: "L27", base_uom: "roll", weight_kg_per_uom: 0.11 });
    expect(r).toEqual({ ok: false, reason: "quoted per box with no stated count" });
  });

  it("refuses a unit that does not match the line's base uom", () => {
    const r = base(10, "per roll", PIECE_LINE);
    expect(r.ok).toBe(false);
  });

  it("handles per dozen on a piece line", () => {
    const r = base(120, "per dozen", PIECE_LINE);
    expect(r.ok && r.rate).toBeCloseTo(10, 10);
  });
});

describe("piece as the line's own unit (RFx hint)", () => {
  const set = { line_id: "L18", base_uom: "set", weight_kg_per_uom: 0.28 } as const;

  it("converts per 100 pcs on a set line only when the RFx says a piece is a set", () => {
    const hinted = toBaseUomRate(1372, canonicalUnit("per 100 pcs")!, { ...set, conversion_hints: { piece_is_base_uom: true } });
    expect(hinted.ok && hinted.rate).toBeCloseTo(13.72, 10);
    expect(hinted.ok && hinted.chain[1]).toBe("one piece read as one set, as the RFx states for L18");
    expect(toBaseUomRate(1372, canonicalUnit("per 100 pcs")!, set)).toEqual({ ok: false, reason: "quoted per piece but L18 is priced per set" });
  });
});
