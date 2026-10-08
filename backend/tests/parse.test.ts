import { describe, expect, it } from "vitest";
import { canonicalUnit, parseNumber } from "../src/normalize/parse.js";

describe("parseNumber (spec 9.3 vectors 3 to 5, F17)", () => {
  it.each([
    ["1,52,000", 152000],
    ["42k", 42000],
    ["Rs 1.2 lakh", 120000],
    ["Rs. 4 crore", 40000000],
    ["₹ 2,400", 2400],
    ["1,500", 1500],
    ["12,5", 12.5],
    ["79.54", 79.54],
    ["INR 640.00", 640],
  ])("%s -> %d", (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it.each(["", "abc", "1,5,5", "12..5", "Rs"])("rejects %j instead of guessing", (input) => {
    expect(() => parseNumber(input)).toThrow();
  });
});

describe("canonicalUnit", () => {
  it.each([
    ["per pc", { kind: "piece", per: 1 }],
    ["per 100 pcs", { kind: "piece", per: 100 }],
    ["Per 1000 pcs", { kind: "piece", per: 1000 }],
    ["/kg", { kind: "kg", per: 1 }],
    ["per kg", { kind: "kg", per: 1 }],
    ["per ton", { kind: "ton", per: 1 }],
    ["per box", { kind: "box", per: 1 }],
    ["per roll", { kind: "roll", per: 1 }],
    ["per dozen", { kind: "dozen", per: 1 }],
  ])("%s", (raw, expected) => {
    expect(canonicalUnit(raw)).toEqual(expected);
  });

  it("returns null for missing or unknown units", () => {
    expect(canonicalUnit(null)).toBeNull();
    expect(canonicalUnit("")).toBeNull();
    expect(canonicalUnit("per bundle")).toBeNull();
  });
});
