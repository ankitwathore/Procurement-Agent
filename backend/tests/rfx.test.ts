import { describe, expect, it } from "vitest";
import { QUESTIONS, RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { EXPECTED_BASELINE_TOTAL_INR, baselineTotal, lineAnnualValue } from "../src/data/totals.js";
import { RfxLineSchema, QuestionSchema, RfxHeaderSchema } from "../src/schemas.js";

// Independent fixture: "Annual value INR" column from spec section 17.2, in line order.
const SPEC_ANNUAL_VALUE_INR: number[] = [
  4009250, 1742000, 1679100, 5954550, 1501500, 1462500, 1402200, 1491420, 1388800, 1526400,
  622050, 916500, 377000, 713400, 1534000, 1366800, 1583400, 1339800, 723450, 469050,
  202800, 637000, 1668750, 1094500, 774560, 320000, 2070000, 590000, 280800, 544000,
];

describe("RFx lines (spec 17.2)", () => {
  it("has exactly 30 lines, L01 to L30 in order", () => {
    expect(RFX_LINES).toHaveLength(30);
    expect(RFX_LINES.map((l) => l.line_id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("every line passes its schema", () => {
    for (const line of RFX_LINES) {
      expect(() => RfxLineSchema.parse(line)).not.toThrow();
    }
  });

  it("each line's annual value matches the spec table", () => {
    RFX_LINES.forEach((line, i) => {
      expect(lineAnnualValue(line), line.line_id).toBe(SPEC_ANNUAL_VALUE_INR[i]);
    });
  });

  it("baseline total is Rs 39,985,580 exactly", () => {
    expect(baselineTotal(RFX_LINES)).toBe(EXPECTED_BASELINE_TOTAL_INR);
    expect(EXPECTED_BASELINE_TOTAL_INR).toBe(SPEC_ANNUAL_VALUE_INR.reduce((a, b) => a + b, 0));
  });

  it("carries the conversion hints from 17.2", () => {
    const hint = (id: string) => RFX_LINES.find((l) => l.line_id === id)!.conversion_hints;
    expect(hint("L27").rolls_per_carton).toBe(72);
    for (const id of ["L09", "L10", "L11", "L12", "L13", "L14", "L18", "L19", "L22"]) {
      expect(hint(id).quoting_basis_note, id).toMatch(/per 100 pcs/);
    }
    expect(hint("L01").quoting_basis_note).toBeUndefined();
  });

  it("uses the spec's board specs for the 5 ply and 7 ply lines", () => {
    const l4 = RFX_LINES.find((l) => l.line_id === "L04")!;
    expect(l4.spec).toMatchObject({ ply: 5, flute: "BC", liner_gsm: 180, bf: 22 });
    const l15 = RFX_LINES.find((l) => l.line_id === "L15")!;
    expect(l15.spec).toMatchObject({ ply: 7, flute: "BCB", liner_gsm: 200, bf: 24 });
  });
});

describe("RFx header and questionnaire (spec 17.1, 17.4)", () => {
  it("header passes its schema and has the spec dates", () => {
    expect(() => RfxHeaderSchema.parse(RFX_HEADER)).not.toThrow();
    expect(RFX_HEADER.issue_date).toBe("2026-09-14");
    expect(RFX_HEADER.due_date).toBe("2026-09-23");
    expect(RFX_HEADER.terms.min_validity_days).toBe(30);
    expect(RFX_HEADER.terms.max_lead_days).toBe(15);
  });

  it("has 12 questions with exactly three gates, Q01 to Q03", () => {
    expect(QUESTIONS).toHaveLength(12);
    expect(QUESTIONS.filter((q) => q.is_gate).map((q) => q.q_id)).toEqual(["Q01", "Q02", "Q03"]);
    for (const q of QUESTIONS) {
      expect(() => QuestionSchema.parse(q)).not.toThrow();
    }
  });
});
