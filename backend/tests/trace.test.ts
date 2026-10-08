import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { summarizeGates } from "../src/evidence/gates.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { traceView } from "../src/server/trace.js";
import type { Session } from "../src/server/views.js";
import { config } from "./fixtures/quotes.js";
import { v5Extraction } from "./fixtures/v5.js";

/** The trace page (spec 18.8): every stage behind a vendor's data, and one cell's slice of it. */

let s: Session;
let eml: string;
beforeAll(async () => {
  eml = buildV5Eml();
  const email = await parseEmail(eml);
  const a = v5Extraction(email.text);
  a.rows = a.rows.filter((r) => r.row_id !== "r3"); // pass A maps "38 for the 3-ply" to the sheet only
  const b = { ...v5Extraction(email.text), vendor_terms: {}, rows: v5Extraction(email.text).rows.map((r) => ({ ...r, row_id: `B-${r.mapped_line_candidates[0]!.line_id}` })) };
  const adjudications = [{ line_id: "L25", decision: "UNRESOLVED", reasoning: "does not say sheet or roll", model: "claude-opus-5-5" }];
  const built = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction: a, passB: b, adjudications: adjudications as never, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
  const call = (step: string, model: string, cost: number) => ({ step, file: "V5/x.eml", model, fallback_used: false, stop_reason: "end_turn", prompt_version: `${step}@abc`, tokens_in: 100, tokens_out: 50, cache_read: 0, cache_write: 0, cost_usd: cost, ms: 1000, at: "2026-10-08T12:00:00Z" });
  s = {
    set: "tuned", config, rfx: RFX_HEADER, lines: RFX_LINES, decisions: [],
    vendors: [{
      vendor_id: "V5", file: "V5/x.eml", run_file: "V5-pass-a-x.json", doc: { vendor_id: "V5", kind: "email", text: email.text, authoritative_end: email.new_text_end },
      quotes: built.quotes, assessment: built.vendor, extraction: a, extras: [], rejected: built.rejected, injection: [],
      gates: summarizeGates(QUESTIONS, { vendor_name: "Jai Bharat Boards", answers: {}, certificate: null, test_report: null, offered_plies: [] }, config),
      answers: {}, findings: { hedged: [], contradictions: [], unanswered: [] }, report_findings: [], certificate: null, test_report: null, evidence_docs: [], notes: [],
      run: { extraction: a, pass_b: { extraction: b, notes: [] }, adjudication: { adjudications }, notes: ["note from pass A"], questionnaire: [] },
      traces: [call("extract_a", "claude-sonnet-5-5", 0.03), call("extract_b", "claude-sonnet-5-5", 0.07), call("adjudicate", "claude-opus-5-5", 0.05)],
    }],
  };
});

const files = () => [{ vendor_id: "V5", filename: "Re_RFx.eml", content: Buffer.from(eml) }, { vendor_id: "V5", filename: "copy.eml", content: Buffer.from(eml) }];

describe("whole document", () => {
  it("runs from intake to gates, with each model call's cost", () => {
    const t = traceView(s, "V5", { files: files(), events: [] })!;
    expect(t.stages.map((x) => x.id)).toEqual(["intake", "parse", "injection", "pass_a", "pass_b", "reconcile", "adjudicate", "checks", "normalize", "state", "gates"]);
    expect(t.stages[0]!.summary).toBe("2 files received; 1 duplicate by hash.");
    expect(t.stages.find((x) => x.id === "parse")!.summary).toMatch(/quoted history/);
    expect(t.totals).toEqual({ calls: 3, cost_usd: expect.closeTo(0.15, 9), ms: 3000 });
    expect(t.stages.find((x) => x.id === "pass_b")!.call!.model).toBe("claude-sonnet-5-5");
    expect(t.stages.find((x) => x.id === "reconcile")!.summary).toBe("agree 2, disagree 0, only A 0, only B 1, neither 27.");
  });
});

describe("one cell", () => {
  it("V5 L25: only pass B read it, the adjudicator left it unresolved, rule 2 sent it to review", () => {
    const t = traceView(s, "V5", { files: files(), events: [] }, "L25")!;
    const by = (id: string) => t.stages.find((x) => x.id === id)!;
    expect(by("pass_a").table!.rows).toEqual([]);
    expect(by("pass_b").table!.rows[0]!.slice(0, 5)).toEqual(["B-L25", "L25", "38", "per kg", "INR"]);
    expect(by("reconcile").summary).toMatch(/^Only pass B found an offer/);
    expect(by("adjudicate").table!.rows).toEqual([["L25", "UNRESOLVED", "does not say sheet or roll"]]);
    expect(by("state").summary).toBe("NEEDS_REVIEW by rule 2.");
    expect(t.totals.calls).toBe(3); // the three calls that touched it
  });

  it("shows the buyer's decisions on that cell from the audit log", () => {
    const events = [
      { event_id: "1", kind: "cell_overridden", ref: "V5:L25", payload: { reason: "Pankaj confirmed 38 for the roll", actor: "Meera", new: "38" }, at: "2026-10-09T10:00:00Z" },
      { event_id: "2", kind: "cell_verified", ref: "V5:L23", payload: { reason: "x", actor: "Meera" }, at: "2026-10-09T10:01:00Z" },
    ];
    const t = traceView(s, "V5", { files: files(), events }, "L25")!;
    expect(t.stages.at(-1)).toMatchObject({ id: "decisions", table: { rows: [["2026-10-09 10:00", "cell_overridden", "V5:L25", "Meera", "Pankaj confirmed 38 for the roll"]] } });
  });
});
