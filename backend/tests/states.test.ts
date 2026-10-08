import { describe, expect, it } from "vitest";
import { NO_FLAGS, assignState, isSafe, worstState } from "../src/model/states.js";

describe("assignState (spec 8.4, first match wins)", () => {
  it("rule 1: no evidence is MISSING, or INFERRED if a default statement covers it", () => {
    expect(assignState({ ...NO_FLAGS, hasQuoteEvidence: false })).toMatchObject({ state: "MISSING", rule: 1 });
    expect(assignState({ ...NO_FLAGS, hasQuoteEvidence: false, coveredByDefaultStatement: true })).toMatchObject({
      state: "INFERRED",
      rule: 1,
    });
  });

  it("rule 2: unresolved disagreement is NEEDS_REVIEW; resolved is capped at HIGH_CONF", () => {
    expect(assignState({ ...NO_FLAGS, passesDisagree: true, adjudication: "unresolved" })).toMatchObject({ state: "NEEDS_REVIEW", rule: 2 });
    expect(assignState({ ...NO_FLAGS, passesDisagree: true, adjudication: "resolved" })).toMatchObject({ state: "HIGH_CONF", rule: 2 });
  });

  it("a later NEEDS_REVIEW rule beats an adjudicated HIGH_CONF", () => {
    const r = assignState({ ...NO_FLAGS, passesDisagree: true, adjudication: "resolved", struckOut: true });
    expect(r).toMatchObject({ state: "NEEDS_REVIEW", rule: 7 });
  });

  it.each([
    ["unreadable", 3],
    ["unitAmbiguous", 4],
    ["hardOutlier", 5],
    ["conflictingRows", 5],
    ["arithmeticFails", 6],
    ["struckOut", 7],
  ] as const)("rule %s -> NEEDS_REVIEW (rule %d)", (flag, rule) => {
    expect(assignState({ ...NO_FLAGS, [flag]: true })).toMatchObject({ state: "NEEDS_REVIEW", rule });
  });

  it("vision derived is HIGH_CONF, low impact assumption is HIGH_CONF, otherwise CONFIRMED", () => {
    expect(assignState({ ...NO_FLAGS, visionDerived: true })).toMatchObject({ state: "HIGH_CONF", rule: 8 });
    expect(assignState({ ...NO_FLAGS, lowImpactAssumption: true })).toMatchObject({ state: "HIGH_CONF", rule: 9 });
    expect(assignState(NO_FLAGS)).toMatchObject({ state: "CONFIRMED", rule: 10 });
  });

  it("adjudication can never raise a result to CONFIRMED", () => {
    expect(assignState({ ...NO_FLAGS, passesDisagree: true, adjudication: "resolved" }).state).not.toBe("CONFIRMED");
  });
});

describe("worstState and isSafe", () => {
  it("ranks MISSING > NEEDS_REVIEW > INFERRED > HIGH_CONF > CONFIRMED", () => {
    expect(worstState(["CONFIRMED", "HIGH_CONF"])).toBe("HIGH_CONF");
    expect(worstState(["HIGH_CONF", "INFERRED", "CONFIRMED"])).toBe("INFERRED");
    expect(worstState(["INFERRED", "NEEDS_REVIEW"])).toBe("NEEDS_REVIEW");
    expect(worstState(["NEEDS_REVIEW", "MISSING"])).toBe("MISSING");
    expect(worstState(["BUYER_VERIFIED", "CONFIRMED"])).toBe("BUYER_VERIFIED");
  });

  it("only CONFIRMED, HIGH_CONF, BUYER_VERIFIED are safe", () => {
    const safe = ["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED"];
    expect(["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED"].every((s) => isSafe(s as never, safe))).toBe(true);
    expect(["INFERRED", "NEEDS_REVIEW", "MISSING"].some((s) => isSafe(s as never, safe))).toBe(false);
  });
});
