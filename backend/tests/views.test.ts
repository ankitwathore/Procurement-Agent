import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { summarizeGates } from "../src/evidence/gates.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { applyConfirmation, awardView, cellView, comparisonView, vendorView, type Session } from "../src/server/views.js";
import { config } from "./fixtures/quotes.js";
import { v5Extraction } from "./fixtures/v5.js";

/** The UI's view models (spec 18), on a one-vendor session built from the V5 stand-in extraction. */

let s: Session;
beforeAll(async () => {
  const email = await parseEmail(buildV5Eml());
  const extraction = v5Extraction(email.text);
  const built = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
  s = {
    set: "tuned",
    config,
    rfx: RFX_HEADER,
    lines: RFX_LINES,
    decisions: [],
    vendors: [
      {
        vendor_id: "V5",
        file: "V5/Re_RFx_KHA-PKG-FY26-27.eml",
        run_file: "fixture",
        doc: { vendor_id: "V5", kind: "email", text: email.text, authoritative_end: email.new_text_end },
        quotes: built.quotes,
        assessment: built.vendor,
        extraction,
        extras: [],
        rejected: [],
        injection: [],
        gates: summarizeGates(QUESTIONS, { vendor_name: "Jai Bharat Boards", answers: {}, certificate: null, test_report: null, offered_plies: [] }, config),
        answers: {},
        findings: { hedged: [], contradictions: [], unanswered: [] },
        report_findings: [],
        certificate: null,
        test_report: null,
        evidence_docs: [],
        notes: [],
      },
    ],
  };
});

describe("comparison view", () => {
  it("one cell per line and vendor, coverage, gates, open items sorted by rupees, the pending batch", () => {
    const c = comparisonView(s);
    expect(c.lines).toHaveLength(30);
    expect(c.vendors[0]).toMatchObject({ vendor_id: "V5", coverage: { quoted: 30, total: 30 }, gate: "UNKNOWN", freight: "freight_extra", trusted_value: 0 });
    const values = c.open_items.map((i) => i.value_inr);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(c.confirmations.map((x) => x.id)).toEqual(["V5:carried_over:currency,unit"]);
    const l24 = c.open_items.find((i) => i.line_id === "L24" && i.kind === "base_rate")!;
    expect(l24).toMatchObject({ action: "confirm", confirmation_id: "V5:carried_over:currency,unit" });
    expect(c.open_items.find((i) => i.line_id === "L01" && i.kind === "base_rate")!.action).toBe("clarify");
  });

  it("best is the cheapest priced cell and carries its state; best among trusted is empty when nothing is safe", () => {
    const l23 = comparisonView(s).lines.find((l) => l.line_id === "L23")!;
    expect(l23.best).toMatchObject({ vendor_id: "V5", state: "INFERRED" });
    expect(l23.best_trusted).toBeNull();
  });
});

describe("cell view", () => {
  it("shows the email span the rate came from, with quoted history marked", () => {
    const d = cellView(s, "V5", "L24")!;
    const src = d.sources.find((x) => x.component === "base_rate")!;
    expect(src.snippet).toBe("38 for the 3-ply");
    expect(src.lines.find((l) => l.highlight)!.text).toContain("38 for the 3-ply");
    expect(src.lines.some((l) => l.muted && l.text.includes("wrote:"))).toBe(true);
    expect(src.lines.filter((l) => l.highlight).every((l) => !l.muted)).toBe(true);
    expect(d.confirmation?.id).toBe("V5:carried_over:currency,unit");
  });

  it("a baseline cell is derived, not read from one place", () => {
    const src = cellView(s, "V5", "L01")!.sources.find((x) => x.component === "base_rate")!;
    expect(src.note).toMatch(/^Derived/);
  });
});

describe("decisions and the award", () => {
  it("confirming the batch marks the rates buyer verified and is logged; a second time is refused", () => {
    const local: Session = { ...s, decisions: [], vendors: s.vendors.map((v) => ({ ...v })) };
    const log = applyConfirmation(local, "V5:carried_over:currency,unit", "confirmed", "confirmed with Pankaj by phone");
    expect(log).toMatchObject({ decision: "confirmed", lines: ["L24", "L25"], actor: "Meera" });
    expect(cellView(local, "V5", "L24")!.quote!.components[0]!.state).toBe("BUYER_VERIFIED");
    expect(comparisonView(local).confirmations).toEqual([]);
    expect(() => applyConfirmation(local, "V5:carried_over:currency,unit", "confirmed", "again")).toThrow(/no pending confirmation/);
  });

  it("the award respects the gate policy: V5 is not cleared, so nothing is awarded unless unknowns are included", () => {
    expect(awardView(s, {}).result.assignments.every((a) => a.vendor_id === null)).toBe(true);
    expect(awardView(s, { gate_policy: "include_unknown" }).result.assignments.filter((a) => a.vendor_id === "V5").length).toBeGreaterThan(0);
  });

  it("vendor view lists terms as stated and the validity discrepancy", () => {
    const v = vendorView(s, "V5")!;
    expect(v.terms.map((t) => t.term)).toContain("freight_basis");
    expect(v.discrepancies.map((d) => d.kind)).toContain("validity_not_stated");
  });
});
