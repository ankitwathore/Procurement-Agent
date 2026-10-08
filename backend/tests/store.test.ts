import { beforeEach, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { summarizeGates } from "../src/evidence/gates.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import type { Session } from "../src/server/views.js";
import { applyDecisions, verifyQuote } from "../src/store/apply.js";
import { writeSnapshot } from "../src/store/snapshot.js";
import { DECISION_TABLES, SNAPSHOT_TABLES, Store } from "../src/store/store.js";
import { config } from "./fixtures/quotes.js";
import { v5Extraction } from "./fixtures/v5.js";

/** The store (spec 8.2, 22 step 2): decisions survive a rebuild, are replayed in order, logged, and reset cleanly. */

async function freshSession(): Promise<Session> {
  const email = await parseEmail(buildV5Eml());
  const extraction = v5Extraction(email.text);
  const built = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
  return {
    set: "tuned", config, rfx: RFX_HEADER, lines: RFX_LINES, decisions: [],
    vendors: [{
      vendor_id: "V5", file: "V5/x.eml", run_file: "fixture", doc: { vendor_id: "V5", kind: "email", text: email.text, authoritative_end: email.new_text_end },
      quotes: built.quotes, assessment: built.vendor, extraction, extras: [], rejected: [], injection: [],
      gates: summarizeGates(QUESTIONS, { vendor_name: "Jai Bharat Boards", answers: {}, certificate: null, test_report: null, offered_plies: [] }, config),
      answers: {}, findings: { hedged: [], contradictions: [], unanswered: [] }, report_findings: [], certificate: null, test_report: null, evidence_docs: [], notes: [],
    }],
  };
}

let store: Store;
const at = "2026-10-09T10:00:00.000Z";
beforeEach(() => {
  store = new Store(":memory:");
});
const cell = (s: Session, line: string) => s.vendors[0]!.quotes.find((q) => q.line_id === line)!;

describe("schema", () => {
  it("creates every table of spec 8.2 plus the confirmation table, all empty", () => {
    const counts = store.counts();
    for (const t of [...SNAPSHOT_TABLES, ...DECISION_TABLES]) expect(counts[t], t).toBe(0);
    expect(Object.keys(counts)).toHaveLength(20);
  });
});

describe("decisions survive a rebuild and are replayed", () => {
  it("a batch confirmation: logged, re-applied to freshly built quotes, skipped once it no longer fits", async () => {
    store.addConfirmation({ confirmation_id: "V5:carried_over:currency,unit", vendor_id: "V5", decision: "confirmed", lines: ["L24", "L25"], reason: "confirmed with Pankaj by phone", actor: "Meera", at });
    expect(store.events().map((e) => e.kind)).toEqual(["confirmation_confirmed"]);
    const s = await freshSession();
    const report = applyDecisions(s, store);
    expect(report).toEqual({ applied: 1, skipped: [] });
    expect(cell(s, "L24").components.find((c) => c.kind === "base_rate")!.state).toBe("BUYER_VERIFIED");
    // Applying again to the same, already confirmed data: nothing pending, so it is skipped, not forced.
    expect(applyDecisions(s, store).skipped).toEqual([{ kind: "confirmation", ref: "V5:carried_over:currency,unit", why: "no longer pending in the current data" }]);
  });

  it("verify: the read rate becomes BUYER_VERIFIED, the price unchanged; freight still estimated, so the cell stays INFERRED", async () => {
    const s0 = await freshSession();
    const before = cell(s0, "L23").landed!.point;
    store.addOverride({ vendor_id: "V5", line_id: "L23", field: "verify", old_value: "INFERRED", new_value: "BUYER_VERIFIED", reason: "rate card seen", actor: "Meera", at });
    const s = await freshSession();
    applyDecisions(s, store);
    const q = cell(s, "L23");
    expect(q.components.find((c) => c.kind === "base_rate")!.state).toBe("BUYER_VERIFIED");
    expect(q.landed!.point).toBe(before);
    expect(q.state).toBe("INFERRED");
    expect(store.events()[0]).toMatchObject({ kind: "cell_verified", ref: "V5:L23", payload: { reason: "rate card seen", actor: "Meera" } });
  });

  it("rate override: the buyer's rate replaces a 'same as last year' reading; freight is added again", async () => {
    store.addOverride({ vendor_id: "V5", line_id: "L01", field: "rate", old_value: "39.5", new_value: "40", reason: "Pankaj quoted 40 on the phone", actor: "Meera", at });
    const s = await freshSession();
    applyDecisions(s, store);
    const q = cell(s, "L01");
    const line = RFX_LINES.find((l) => l.line_id === "L01")!;
    expect(q.components.map((c) => [c.kind, c.state])).toEqual([["base_rate", "BUYER_VERIFIED"], ["freight", "INFERRED"]]);
    expect(q.landed!.point).toBeCloseTo(40 + 4.0 * line.weight_kg_per_uom, 9);
    expect(q.flags).toContain("buyer_override");
    expect(q.state).toBe("INFERRED");
  });

  it("verifying a cell with no price is refused, and a stored one is skipped with the reason", async () => {
    const s = await freshSession();
    const unpriced = { ...cell(s, "L23"), components: [], landed: null, state: "NEEDS_REVIEW" as const };
    expect(() => verifyQuote(unpriced, "x")).toThrow(/no price to verify/);
    s.vendors[0]!.quotes = s.vendors[0]!.quotes.map((q) => (q.line_id === "L23" ? unpriced : q));
    store.addOverride({ vendor_id: "V5", line_id: "L23", field: "verify", old_value: null, new_value: null, reason: "x", actor: "Meera", at });
    expect(applyDecisions(s, store).skipped[0]!.why).toMatch(/no price to verify/);
  });

  it("gate waivers: the vendor's gates are re-evaluated with them", async () => {
    for (const q of ["Q01", "Q02", "Q03"]) store.addWaiver({ vendor_id: "V5", q_id: q, reason: "answers received by phone", actor: "Meera", at });
    const s = await freshSession();
    expect(s.vendors[0]!.gates.overall).toBe("UNKNOWN");
    applyDecisions(s, store);
    expect(s.vendors[0]!.gates.overall).toBe("WAIVED");
    expect(store.events().filter((e) => e.kind === "gate_waived")).toHaveLength(3);
  });
});

describe("awards, snapshot and reset", () => {
  it("a new confirmed award supersedes the earlier one; both kept", () => {
    store.addAward({ constraints: { gate_policy: "cleared_only" }, result: { cost: { point: 1 } }, actor: "Meera", at, exposure_inr: 10, acknowledged: [] });
    store.addAward({ constraints: { gate_policy: "include_unknown" }, result: { cost: { point: 2 } }, actor: "Meera", at: "2026-10-09T11:00:00.000Z", exposure_inr: 20, acknowledged: ["V5:L01:base_rate"] });
    const awards = store.awards();
    expect(awards.map((a) => [a.exposure_inr, a.superseded])).toEqual([[20, false], [10, true]]);
    expect(awards[0]!.scenario.constraints).toEqual({ gate_policy: "include_unknown" });
  });

  it("the snapshot fills the spec's tables from the current state; reset empties everything", async () => {
    const s = await freshSession();
    writeSnapshot(store, s);
    const c = store.counts();
    expect([c.rfx, c.rfx_line, c.question, c.quote, c.vendor]).toEqual([1, 30, 12, 30, 5]);
    expect(c.quote_component).toBe(s.vendors[0]!.quotes.reduce((n, q) => n + q.components.length, 0));
    store.addWaiver({ vendor_id: "V5", q_id: "Q01", reason: "x", actor: "Meera", at });
    store.reset();
    expect(Object.values(store.counts()).every((n) => n === 0)).toBe(true);
  });
});
