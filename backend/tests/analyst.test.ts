import { beforeAll, describe, expect, it } from "vitest";
import { runAnalystTurn, type ChatClient, type ChatTurn } from "../src/analyst/agent.js";
import { calc } from "../src/analyst/calc.js";
import { buildDb, guardedQuery } from "../src/analyst/db.js";
import { checkGrounding, proseNumbers } from "../src/analyst/grounding.js";
import { explicitlyInstructed, runTool } from "../src/analyst/tools.js";
import { QUESTIONS, RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { summarizeGates } from "../src/evidence/gates.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import type { Session } from "../src/server/views.js";
import { config } from "./fixtures/quotes.js";
import { v5Extraction } from "./fixtures/v5.js";

/** The analyst agent (spec 14): calculator, SQL guard, grounding, and the tool loop with a scripted model. */

let s: Session;
beforeAll(async () => {
  const email = await parseEmail(buildV5Eml());
  const extraction = v5Extraction(email.text);
  const built = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: true });
  s = {
    set: "tuned", config, rfx: RFX_HEADER, lines: RFX_LINES, decisions: [],
    vendors: [{
      vendor_id: "V5", file: "V5/x.eml", run_file: "fixture", doc: { vendor_id: "V5", kind: "email", text: email.text, authoritative_end: email.new_text_end },
      quotes: built.quotes, assessment: built.vendor, extraction, extras: [], rejected: [], injection: [],
      gates: summarizeGates(QUESTIONS, { vendor_name: "Jai Bharat Boards", answers: {}, certificate: null, test_report: null, offered_plies: [] }, config),
      answers: {}, findings: { hedged: [], contradictions: [], unanswered: [] }, report_findings: [], certificate: null, test_report: null, evidence_docs: [], notes: [],
    }],
  };
});

describe("calc", () => {
  it("does arithmetic with named inputs, precedence and a few functions", () => {
    expect(calc("a * b + 2 ^ 3", { a: 1.5, b: 4 }).value).toBe(14);
    expect(calc("round((x - y) / y * 100, 1)", { x: 42.78, y: 39.5 }).value).toBe(8.3);
    expect(calc("sum(1, 2, 3) - max(4, 5) + abs(-1)").value).toBe(2);
    expect(calc("1,52,000 / 100").value).toBe(1520);
  });
  it("refuses anything that is not arithmetic", () => {
    expect(() => calc("process.exit(1)")).toThrow();
    expect(() => calc("x + 1")).toThrow(/unknown input x/);
    expect(() => calc("1 / 0")).toThrow(/division by zero/);
    expect(() => calc("constructor('return 1')()")).toThrow();
  });
});

describe("SQL guard", () => {
  it("answers a SELECT over the curated views", () => {
    const db = buildDb(s);
    const r = guardedQuery(db, "SELECT line_id, landed_point FROM v_quote_current WHERE vendor_id = 'V5' AND line_id = 'L23';");
    expect(r.columns).toEqual(["line_id", "landed_point"]);
    expect(r.rows[0]![1]).toBeCloseTo(42 + 4.0 * RFX_LINES.find((l) => l.line_id === "L23")!.weight_kg_per_uom, 6);
    expect(guardedQuery(db, "WITH x AS (SELECT * FROM v_coverage) SELECT quoted FROM x").rows).toEqual([[30]]);
  });
  it("refuses writes, more than one statement, pragmas and unknown tables, with a reason the model can use", () => {
    const db = buildDb(s);
    expect(() => guardedQuery(db, "DROP TABLE v_quote_current")).toThrow(/only a single SELECT/);
    expect(() => guardedQuery(db, "SELECT 1; DELETE FROM v_coverage")).toThrow(/query rejected/);
    expect(() => guardedQuery(db, "PRAGMA table_info(v_coverage)")).toThrow(/only a single SELECT/);
    expect(() => guardedQuery(db, "SELECT * FROM quotes")).toThrow(/no such table: quotes.*Views: v_rfx_lines/);
  });
});

describe("grounding (spec 14.5)", () => {
  it("reads figures, not names, sizes, ids or dates", () => {
    expect(proseNumbers("Room cooler 40L (L06), 1100x1600 sheet, 5ply, on 2026-10-08: Rs 4.1L and 3.3%").map((p) => p.value)).toEqual([410000, 3.3].map((v) => expect.closeTo(v, 6)));
  });
  it("accepts figures rounded as written, rejects invented ones", () => {
    expect(checkGrounding("Rs 12.4 lakh (3.3%) on 9 components", [1238765, 3.27, 9]).ok).toBe(true);
    expect(checkGrounding("about Rs 13 lakh", [1238765]).ungrounded).toEqual(["Rs 13 lakh"]);
  });
});

describe("tools", () => {
  it("get_source wraps the vendor's words as untrusted", () => {
    const out = runTool("get_source", { vendor_id: "V5", line_id: "L24" }, s, buildDb(s), { charts: [], trust: null }) as { vendor_words: { snippet: string }[] };
    expect(out.vendor_words[0]!.snippet).toBe('<vendor_text untrusted="true">38 for the 3-ply</vendor_text>');
  });
  it("scenario_award runs a hypothetical waiver without changing the session", () => {
    const state = { charts: [], trust: null };
    const out = runTool("scenario_award", { waive_gates: ["V5"] }, s, buildDb(s), state) as { lines: { vendor_id: string | null }[]; scenario: { waived_gates_hypothetically: string[] } };
    expect(out.scenario.waived_gates_hypothetically).toEqual(["V5"]);
    expect(out.lines.some((l) => l.vendor_id === "V5")).toBe(true);
    expect(s.vendors[0]!.gates.overall).toBe("UNKNOWN");
    expect(state.trust).not.toBeNull();
  });
});

/** A model that follows a script: each call returns the next turn. */
class Script implements ChatClient {
  calls = 0;
  seen: unknown[] = [];
  constructor(private readonly turns: ChatTurn["content"][]) {}
  async turn(req: { messages: unknown[] }): Promise<ChatTurn> {
    this.seen.push(JSON.parse(JSON.stringify(req.messages.at(-1))));
    const content = this.turns[Math.min(this.calls++, this.turns.length - 1)]!;
    return { content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  }
}
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use" as const, id, name, input, caller: { type: "direct" as const } }) as unknown as ChatTurn["content"][number];
const answer = (id: string, markdown: string) => use(id, "answer", { markdown, table_columns: [], table_rows: [], chart_id: "", assumptions: ["Basis: landed, ex GST"], actions: [] });

describe("write tools run only on the buyer's explicit instruction (spec 14.2)", () => {
  const verb = /\b(verify|confirm|mark)\b/i;
  it("an instruction naming the vendor and cell passes; a question, a missing name or no verb does not", () => {
    expect(explicitlyInstructed("Verify V1 L02 as correct, I checked the signed sheet", verb, "V1", "L02")).toBeNull();
    expect(explicitlyInstructed("Should we verify V1 L02?", verb, "V1", "L02")).toBe("the message asks about it rather than instructing it");
    expect(explicitlyInstructed("What if V1 L02 were verified", verb, "V1", "L02")).toMatch(/asks about it/);
    expect(explicitlyInstructed("Verify V1's prices", verb, "V1", "L02")).toBe("the message does not name L02");
    expect(explicitlyInstructed("V1 L02 looks right to me", verb, "V1", "L02")).toBe("the message does not instruct it");
    expect(explicitlyInstructed("Verify V1 L020", verb, "V1", "L02")).toBe("the message does not name L02"); // whole ids only
  });

  it("the loop writes when instructed, and refuses (as a tool error the model reads) when not", async () => {
    const done: string[] = [];
    const writes = { verify: (v: string, l: string, r: string) => void done.push(`${v} ${l} ${r}`), waive: () => void done.push("waive") };
    const ok = new Script([[use("w", "verify_cell", { vendor_id: "V5", line_id: "L23", reason: "rate card seen" })], [answer("a", "Verified V5 L23 with your reason.")]]);
    await runAnalystTurn({ session: s, client: ok, question: "Verify V5 L23, I saw the rate card", model: "claude-opus-5-5", writes });
    expect(done).toEqual(["V5 L23 rate card seen"]);
    const unasked = new Script([[use("w", "set_gate_waiver", { vendor_id: "V5", q_id: "Q01", reason: "seems fine" })], [answer("a", "I did not waive anything.")]]);
    await runAnalystTurn({ session: s, client: unasked, question: "Is V5 likely to pass Q01?", model: "claude-opus-5-5", writes });
    expect(done).toEqual(["V5 L23 rate card seen"]);
    expect((unasked.seen[1] as { content: { is_error: boolean; content: string }[] }).content[0]).toMatchObject({ is_error: true });
    expect((unasked.seen[1] as { content: { content: string }[] }).content[0]!.content).toMatch(/^Not done: a write runs only on the buyer's explicit instruction/);
  });
});

describe("the tool loop", () => {
  it("sends an invented figure back, then delivers the corrected answer with a trust block from code", async () => {
    const script = new Script([
      [use("t1", "scenario_award", { gate_policy: "include_unknown" })],
      [answer("t2", "Awarding to V5 costs about Rs 99.9 crore.")],
      [use("t3", "query_comparison", { sql: "SELECT exposure_inr FROM v_exposure_by_vendor" })],
      [answer("t4", "With unknown gates included, V5 takes the lines it quoted; see the trust block for what rests on unconfirmed figures.")],
    ]);
    const events: string[] = [];
    const r = await runAnalystTurn({ session: s, client: script, question: "What if we include V5?", model: "claude-opus-5-5", onEvent: (e) => events.push(e.type) });
    expect(events).toContain("correction");
    expect((script.seen[2] as { content: { content: string; is_error?: boolean }[] }).content[0]).toMatchObject({ is_error: true });
    expect((script.seen[2] as { content: { content: string }[] }).content[0]!.content).toMatch(/Rs 99\.9 crore/);
    expect(r.unverified).toEqual([]);
    expect(r.blocks.map((b) => b.type)).toEqual(["answer", "trust", "assumptions", "how"]);
    expect(r.blocks.find((b) => b.type === "how")).toMatchObject({ tool_calls: [{ name: "scenario_award" }, { name: "query_comparison" }] });
  });

  it("after two corrections the answer is shown with the figure marked unverified", async () => {
    const script = new Script([[answer("a", "It is Rs 7.7 crore.")]]);
    const r = await runAnalystTurn({ session: s, client: script, question: "Total?", model: "claude-opus-5-5" });
    expect(script.calls).toBe(3);
    expect(r.unverified).toEqual(["Rs 7.7 crore"]);
  });

  it("figures from the RFx and from the question itself are grounded; history carries over to the next turn", async () => {
    const script = new Script([[answer("a", "L23 is 37,500 kg a year; you asked about a 50 percent cap, which is not supported yet.")]]);
    const r = await runAnalystTurn({ session: s, client: script, question: "Cap V5 at 50 percent?", model: "claude-opus-5-5" });
    expect(r.unverified).toEqual([]);
    expect(r.messages[0]).toEqual({ role: "user", content: "Cap V5 at 50 percent?" });
    const next = await runAnalystTurn({ session: s, client: new Script([[answer("b", "Done.")]]), question: "Now exclude V3", history: r.messages, model: "claude-opus-5-5" });
    expect(next.messages.length).toBe(r.messages.length + 3);
  });

  it("a tool error goes back to the model as an error result, not a crash", async () => {
    const script = new Script([[use("q", "query_comparison", { sql: "DELETE FROM v_coverage" })], [answer("a", "I can only read the data.")]]);
    const r = await runAnalystTurn({ session: s, client: script, question: "Delete V5", model: "claude-opus-5-5" });
    expect((script.seen[1] as { content: { is_error: boolean; content: string }[] }).content[0]).toMatchObject({ is_error: true, content: "only a single SELECT (or WITH ... SELECT) is allowed" });
    expect(r.blocks[0]).toEqual({ type: "answer", markdown: "I can only read the data." });
  });
});
