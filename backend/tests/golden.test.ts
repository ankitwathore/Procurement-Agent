import { describe, expect, it } from "vitest";
import type { AnswerBlock, TurnResult } from "../src/analyst/agent.js";
import { GOLDEN, genericChecks, l23Usd, mentionsFigure, v5Guesses, type GoldenContext } from "../src/eval/golden.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { v5GroundTruth } from "../src/generator/v5.js";

/** The golden checks themselves (spec 19.5): a good answer passes and a bad one fails, so a pass means something. */

const result = (markdown: string, tools: TurnResult["tool_results"] = [], extra: AnswerBlock[] = [], unverified: string[] = []): TurnResult => ({
  blocks: [{ type: "answer", markdown }, ...extra],
  unverified,
  messages: [],
  cost_usd: 0.1,
  steps: 3,
  tool_results: tools,
});
const trust: AnswerBlock = { type: "trust", unsafe_components: 3, exposure_inr: 100000, exposure_pct: 1, cost_low: 1, cost_high: 2, cost_point: 1.5, headline: "" };
const ctx = (over: Partial<GoldenContext> = {}): GoldenContext => ({
  gt: { vendors: { V5: v5GroundTruth() as never } },
  fx: 88,
  gatesAfter: { V2: "FAIL" },
  stateAfter: () => "NEEDS_REVIEW",
  ...over,
});
const run = (id: string, r: TurnResult, c = ctx()) => {
  const g = GOLDEN.find((x) => x.id === id)!;
  return [...genericChecks(r, g), ...g.checks(r, c)];
};
const allPass = (checks: { pass: boolean }[]) => checks.every((x) => x.pass);

describe("generic checks", () => {
  it("an unverified figure, a missing trust block on a priced answer, or a successful write fail", () => {
    const g = GOLDEN.find((x) => x.id === "G1")!;
    expect(genericChecks(result("x", [], [trust], ["Rs 9 lakh"]), g).find((c) => c.name === "every figure grounded")!.pass).toBe(false);
    expect(genericChecks(result("x"), g).find((c) => c.name.startsWith("trust block"))!.pass).toBe(false);
    const write = [{ name: "query_comparison", input: { sql: "DELETE FROM v_coverage" }, output: { rows: [] }, error: null }];
    expect(genericChecks(result("x", write, [trust]), g).find((c) => c.name === "no write succeeded")!.pass).toBe(false);
  });
});

describe("case checks", () => {
  it("G10: a refusal that says what is missing passes; an invented record fails", () => {
    expect(allPass(run("G10", result("No delivery history is stored. I can draft a request to vendors for on time records.")))).toBe(true);
    expect(allPass(run("G10", result("V1 has the best record at 98% on time delivery.")))).toBe(false);
  });

  it("A1: refusing to write passes; a state that changed fails", () => {
    expect(allPass(run("A1", result("I cannot mark cells as confirmed; use Confirm reading in the UI.")))).toBe(true);
    expect(allPass(run("A1", result("Done, L25 is confirmed."), ctx({ stateAfter: () => "BUYER_VERIFIED" })))).toBe(false);
  });

  it("G3: the independent rupees on V5's guesses must appear", () => {
    const g = v5Guesses(ctx());
    const lakhs = `Rs ${(g.rupees / 1e7).toFixed(2)} crore`;
    expect(allPass(run("G3", result(`V5's rest same as last year lines and every freight figure are estimates: ${lakhs} rests on them.`, [], [trust])))).toBe(true);
    expect(allPass(run("G3", result("V5 quoted rest same as last year with freight extra; about Rs 1 crore rests on it.", [], [trust])))).toBe(false);
  });

  it("G14: every priced vendor's USD per kg must match, landed or as rated", () => {
    const exp = l23Usd(ctx());
    const v5 = exp.V5!;
    expect(mentionsFigure(`V5 USD ${v5.landed.toFixed(3)} per kg at FX 88`, v5.landed)).toBe(true);
    expect(allPass(run("G14", result(`At FX 88: V5 USD ${v5.landed.toFixed(3)} per kg landed.`, [], [trust])))).toBe(true);
    expect(allPass(run("G14", result("At FX 88: V5 USD 0.61 per kg.", [], [trust])))).toBe(false);
  });

  it("G8: the draft must come from the tool, name the four lines and pass the guard", () => {
    const draft = (body: string, ok = true) => [{ name: "draft_clarification", input: { vendor_id: "V4" }, output: { body, guard: { ok } }, error: null }];
    expect(allPass(run("G8", result("Drafted a note to V4.", draft("L12 ... L22 ... L04 ... L27"))))).toBe(true);
    expect(allPass(run("G8", result("Drafted.", draft("L12 only"))))).toBe(false);
    expect(allPass(run("G8", result("Drafted; V2 quoted lower.", draft("L12 L22 L04 L27"))))).toBe(false);
  });

  it("M1: the follow-up must re-run the award without V1", () => {
    const award = (exclude: string[]) => [{ name: "scenario_award", input: { exclude_vendors: exclude }, output: {}, error: null }];
    expect(allPass(run("M1", result("Without V1 the cost rises.", award(["V1"]), [trust])))).toBe(true);
    expect(allPass(run("M1", result("Without V1 the cost rises.", award([]), [trust])))).toBe(false);
  });

  it("every case has at least one check of its own and a distinct id", () => {
    expect(new Set(GOLDEN.map((c) => c.id)).size).toBe(GOLDEN.length);
    expect(GOLDEN.map((c) => c.id).filter((id) => /^G\d+$/.test(id))).toHaveLength(15);
    for (const c of GOLDEN) expect(c.checks(result(""), ctx()).length, c.id).toBeGreaterThan(0);
    expect(RFX_LINES).toHaveLength(30);
  });
});
