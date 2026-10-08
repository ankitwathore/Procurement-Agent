import { describe, expect, it } from "vitest";
import { computeExposure } from "../src/award/exposure.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import { NO_FLAGS, assignState } from "../src/model/states.js";
import { decide, pendingConfirmations } from "../src/review/confirmations.js";
import { config } from "./fixtures/quotes.js";
import { V5_EMAIL, v5Extraction } from "./fixtures/v5.js";

const v5 = () => buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: v5Extraction(), sourceText: V5_EMAIL, textNative: true }).quotes;
const q = (qs: Quote[], id: string) => qs.find((x) => x.line_id === id)!;
const WHO = { actor: "Meera", at: "2026-10-08T15:00:00+05:30", reason: "Pankaj confirmed by phone: 38 is Rs per kg" };
const exposureOf = (qs: Quote[]) =>
  computeExposure(RFX_LINES.map((l) => ({ quote: q(qs, l.line_id), annual_qty: l.annual_qty })), config.exposure.safe_states);

describe("carried-over unit or currency", () => {
  it("is priced but INFERRED (rule 12), with the reason and the assumption visible", () => {
    expect(assignState({ ...NO_FLAGS, carriedOver: true })).toMatchObject({ state: "INFERRED", rule: 12 });
    const l24 = q(v5(), "L24");
    expect(l24.components[0]).toMatchObject({ kind: "base_rate", point: 38, state: "INFERRED" });
    expect(l24.flags).toEqual(expect.arrayContaining(["carried_over_unit", "carried_over_currency"]));
    expect(l24.assumptions).toContain('The unit is not written next to this price; it is taken from the same sentence ("38 for the 3-ply").');
  });

  it("does not touch a value whose unit is written next to it (L23, 'Rs 42/kg')", () => {
    expect(q(v5(), "L23").components[0]!.state).toBe("HIGH_CONF");
  });
});

describe("pendingConfirmations", () => {
  it("groups V5's two carried-over cells into one question for the buyer", () => {
    const pending = pendingConfirmations(v5());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ vendor_id: "V5", kind: "carried_over", fields: ["currency", "unit"], lines: ["L24", "L25"], snippets: ["38 for the 3-ply"] });
    expect(pending[0]!.question).toBe(
      'V5 did not write the currency or unit next to these prices ("38 for the 3-ply"); it was read from the same sentence. Confirm that reading for L24, L25?',
    );
  });
});

describe("decide", () => {
  it("confirming marks both base prices BUYER_VERIFIED in one step, logs it, and lowers the exposure", () => {
    const before = v5();
    const [c] = pendingConfirmations(before);
    const { quotes: after, log } = decide(before, c!, "confirmed", WHO);

    for (const id of ["L24", "L25"]) {
      expect(q(after, id).components.find((x) => x.kind === "base_rate")!.state, id).toBe("BUYER_VERIFIED");
      expect(q(after, id).state, id).toBe("INFERRED"); // freight is still estimated
    }
    expect(log).toMatchObject({ decision: "confirmed", lines: ["L24", "L25"], actor: "Meera", reason: WHO.reason });
    expect(pendingConfirmations(after)).toEqual([]);

    const drop = exposureOf(before).exposure_inr - exposureOf(after).exposure_inr;
    expect(drop).toBeCloseTo((18800 + 27500) * 38, 2);
    expect(exposureOf(after).unsafe_component_count).toBe(exposureOf(before).unsafe_component_count - 2);
  });

  it("rejecting sends the cells to review without a price; other lines are untouched", () => {
    const before = v5();
    const [c] = pendingConfirmations(before);
    const { quotes: after } = decide(before, c!, "rejected", { ...WHO, reason: "38 is per piece, not per kg" });
    expect(q(after, "L24")).toMatchObject({ state: "NEEDS_REVIEW", landed: null, components: [] });
    expect(q(after, "L24").state_reason).toBe("Buyer rejected the reading (38 is per piece, not per kg).");
    expect(q(after, "L23")).toEqual(q(before, "L23"));
  });

  it("needs a reason, and never changes its input", () => {
    const before = v5();
    const snapshot = JSON.stringify(before);
    const [c] = pendingConfirmations(before);
    expect(() => decide(before, c!, "confirmed", { ...WHO, reason: " " })).toThrow(/needs a reason/);
    decide(before, c!, "confirmed", WHO);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("currency not stated (V3's mixed INR/USD table)", () => {
  const v3 = async () => {
    const { buildV3Quote } = await import("../src/generator/v3.js");
    const { parseDocx } = await import("../src/ingest/parse_docx.js");
    const { v3Extraction } = await import("./fixtures/v3.js");
    const doc = await parseDocx((await buildV3Quote(42)).buffer);
    return buildQuotes({ vendorId: "V3", vendorCity: "Hosur", config, lines: RFX_LINES, extraction: v3Extraction(doc), sourceText: doc.text, docx: doc, textNative: true }).quotes;
  };

  it("prices L29 and L30 in INR, INFERRED, and asks once for both", async () => {
    const quotes = await v3();
    for (const id of ["L29", "L30"]) {
      expect(q(quotes, id), id).toMatchObject({ state: "INFERRED", state_rule: 12 });
      expect(q(quotes, id).flags, id).toContain("currency_assumed");
    }
    const pending = pendingConfirmations(quotes, "INR");
    expect(pending.map((c) => [c.kind, c.lines])).toEqual([["currency_assumed", ["L29", "L30"]]]);
    expect(pending[0]!.question).toMatch(/^V3 did not state a currency for these prices \(".+", ".+"\); they are priced in INR, the RFx currency\. Confirm INR for L29, L30\?$/);
  });

  it("confirming makes both safe", async () => {
    const quotes = await v3();
    const [c] = pendingConfirmations(quotes, "INR");
    const { quotes: after } = decide(quotes, c!, "confirmed", { ...WHO, reason: "Accessories other than imported items are in INR, per the vendor" });
    expect(q(after, "L29").state).toBe("BUYER_VERIFIED");
    expect(q(after, "L30").state).toBe("BUYER_VERIFIED");
  });

  it("a currency that is written but not recognised still goes to review, not to INR", () => {
    const extraction = v5Extraction();
    extraction.rows[0]!.rate.currency = "EUR";
    const l23 = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction, sourceText: V5_EMAIL, textNative: true }).quotes.find((x) => x.line_id === "L23")!;
    expect(l23.state).toBe("NEEDS_REVIEW");
    expect(l23.flags).not.toContain("currency_assumed");
  });
});

describe("question length", () => {
  it("quotes at most three of the vendor's snippets and counts the rest", () => {
    const quotes = RFX_LINES.slice(0, 5).map((l) => {
      const base = q(v5(), "L24");
      return { ...base, line_id: l.line_id, components: base.components.map((c) => ({ ...c, provenance: { ...c.provenance, snippet: `row ${l.line_id}` } })) };
    });
    const [c] = pendingConfirmations(quotes);
    expect(c!.snippets).toHaveLength(5);
    expect(c!.question).toContain('("row L01", "row L02", "row L03" and 2 more)');
  });
});
