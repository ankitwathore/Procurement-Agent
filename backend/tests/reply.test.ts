import { beforeAll, describe, expect, it } from "vitest";
import { RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { buildV1Workbook } from "../src/generator/v1.js";
import { V5_CLARIFICATION_REPLY, buildV5ClarificationReplyEml, buildV5Eml } from "../src/generator/v5.js";
import { ExtractionSchema, type Extraction, type Row } from "../src/ingest/extraction.js";
import { parseEmail, type ParsedEmail } from "../src/ingest/parse_email.js";
import { parseXlsx } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import { draftClarification, type ClarificationDraft } from "../src/review/clarify.js";
import { pendingConfirmations } from "../src/review/confirmations.js";
import { applyClarificationReply, classifyInbound, type ReplyInput } from "../src/review/reply.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";
import { V5_REPLY_ID, span, v5Extraction, v5ReplyExtraction } from "./fixtures/v5.js";

let all: Quote[];
let thread: ClarificationDraft;
let reply: ParsedEmail;
let vendorTerms: Extraction["vendor_terms"];

beforeAll(async () => {
  const wb = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
  const email = await parseEmail(buildV5Eml());
  const base = { config, lines: RFX_LINES, textNative: true };
  // As live: pass A maps "38 for the 3-ply" to the sheet only, pass B to both, so L25 is in review.
  const a = v5Extraction(email.text);
  a.rows = a.rows.filter((r) => r.row_id !== "r3");
  const b: Extraction = { ...v5Extraction(email.text), vendor_terms: {}, rows: v5Extraction(email.text).rows.map((r: Row) => ({ ...r, row_id: `B-${r.mapped_line_candidates[0]!.line_id}` })) };
  vendorTerms = a.vendor_terms;
  all = [
    ...buildQuotes({ ...base, vendorId: "V1", vendorCity: "Pune", extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb }).quotes,
    ...buildQuotes({ ...base, vendorId: "V5", vendorCity: "Vapi", extraction: a, passB: b, sourceText: email.text, authoritativeEnd: email.new_text_end }).quotes,
  ];
  thread = draftClarification("V5", all, RFX_LINES, RFX_HEADER)!;
  reply = await parseEmail(buildV5ClarificationReplyEml(thread.message_id));
});

const input = (over: Partial<ReplyInput> = {}): ReplyInput => ({
  thread,
  quotes: all,
  base: { vendorCity: "Vapi", config, lines: RFX_LINES, vendorTerms },
  reply,
  extraction: v5ReplyExtraction(reply.text),
  at: "2026-09-25T09:15:00+05:30",
  ...over,
});
const cell = (qs: Quote[], v: string, l: string) => qs.find((q) => q.vendor_id === v && q.line_id === l)!;

describe("classifying an inbound message", () => {
  it("a reply citing our clarification's id, from the vendor, is a clarification reply", () => {
    expect(thread.message_id).toBe("<clarify-v5-kha-pkg-fy26-27-1@kaverihome.example>");
    const c = classifyInbound(reply, [thread]);
    expect(c.intent).toBe("clarification_reply");
    expect(c.thread).toBe(thread);
  });

  it("the vendor's new message ends where our quoted questions begin", () => {
    expect(reply.new_text.trim()).toBe(V5_CLARIFICATION_REPLY);
  });

  it("anything else is not: another thread, no thread, someone else's address, or a draft the guard blocked", () => {
    expect(classifyInbound({ ...reply, in_reply_to: "<rfx-kha-pkg-fy26-27@kaverihome.example>" }, [thread]).intent).toBe("other");
    expect(classifyInbound({ ...reply, in_reply_to: null }, [thread]).intent).toBe("other");
    const stranger = classifyInbound({ ...reply, from: { name: "X", address: "sales@apw.example" } }, [thread]);
    expect(stranger.intent).toBe("other");
    expect(stranger.reason).toMatch(/not @jaibharatboards\.example/);
    expect(classifyInbound(reply, [{ ...thread, status: "blocked" }]).intent).toBe("other");
  });
});

describe("applying a clarification reply (spec 13.4)", () => {
  it("both items resolve; L24's rate becomes explicit and L25 gets a price", () => {
    const r = applyClarificationReply(input());
    expect(r.items.map((i) => [i.lines, i.status])).toEqual([[["L25"], "resolved"], [["L24"], "resolved"]]);
    expect(r.headline).toBe("V5 replied to the clarification: 2 of 2 items resolved, 2 cells updated.");

    const [l25, l24] = [r.changes.find((c) => c.line_id === "L25")!, r.changes.find((c) => c.line_id === "L24")!];
    expect(l24.before).toMatchObject({ rate_inr: 38, rate_state: "INFERRED", snippet: "38 for the 3-ply" });
    expect(l24.after).toMatchObject({ rate_inr: 38, rate_state: "CONFIRMED", snippet: "Rs 38/kg applies to both the 3-ply sheet and the 3-ply roll" });
    expect(l24.delta_annual_inr).toBe(0);
    expect(l25.before).toMatchObject({ rate_inr: null, state: "NEEDS_REVIEW", landed: null });
    expect(l25.after).toMatchObject({ rate_inr: 38, rate_state: "CONFIRMED" });
    expect(l25.delta_annual_inr).toBeNull();
    // Freight is still extra and estimated, so the landed cell stays INFERRED: the reply settled the rate, not freight.
    expect(l24.after.state).toBe("INFERRED");
    expect(l25.after.state).toBe("INFERRED");
  });

  it("keeps the old value in history, and the new value points into the reply", () => {
    const r = applyClarificationReply(input());
    const l24 = cell(r.quotes, "V5", "L24");
    expect(l24.history).toHaveLength(1);
    expect(l24.history![0]).toMatchObject({ state: "INFERRED", flags: expect.arrayContaining(["carried_over_unit", "carried_over_currency"]), replaced_by: V5_REPLY_ID, replaced_at: "2026-09-25T09:15:00+05:30" });
    expect(l24.history![0]!.components.find((c) => c.kind === "base_rate")!.provenance.snippet).toBe("38 for the 3-ply");
    expect(l24.flags).not.toContain("carried_over_unit");
    expect(l24.components[0]!.provenance.locator).toMatchObject({ type: "email", message_id: V5_REPLY_ID });
  });

  it("changes nothing else: other V5 cells and other vendors are the same objects", () => {
    const r = applyClarificationReply(input());
    for (const q of all) if (!(q.vendor_id === "V5" && ["L24", "L25"].includes(q.line_id))) expect(cell(r.quotes, q.vendor_id, q.line_id)).toBe(q);
    expect(all.find((q) => q.line_id === "L24" && q.vendor_id === "V5")!.history).toBeUndefined(); // input untouched
  });

  it("afterwards nothing is left to confirm or clarify", () => {
    const r = applyClarificationReply(input());
    expect(pendingConfirmations(r.quotes.filter((q) => q.vendor_id === "V5"))).toEqual([]);
    expect(draftClarification("V5", r.quotes, RFX_LINES, RFX_HEADER)).toBeNull();
  });

  it("a reply row about a line nobody asked about is ignored", () => {
    const e = v5ReplyExtraction(reply.text);
    e.rows.push({ ...e.rows[0]!, row_id: "c3", mapped_line_candidates: [{ line_id: "L23", match_confidence: 0.9, reasons: [] }] });
    const r = applyClarificationReply(input({ extraction: e }));
    expect(r.ignored).toEqual([{ row_id: "c3", reason: "L23 was not asked about; a clarification reply changes only the cells in question" }]);
    expect(cell(r.quotes, "V5", "L23")).toBe(cell(all, "V5", "L23"));
  });

  it("a value found only in our own quoted question is rejected, and its item stays open", () => {
    const quotedAt = reply.text.indexOf("38 for the 3-ply");
    expect(quotedAt).toBeGreaterThan(reply.new_text_end);
    const e = v5ReplyExtraction(reply.text);
    e.rows[1] = { ...e.rows[1]!, snippet: "38 for the 3-ply", locator: { type: "email", message_id: V5_REPLY_ID, char_start: quotedAt, char_end: quotedAt + 16 } };
    const r = applyClarificationReply(input({ extraction: e }));
    expect(r.rejected).toEqual([{ row_id: "c2", reason: "snippet is in quoted history, not the vendor's new message" }]);
    expect(r.items.find((i) => i.lines.includes("L25"))!.status).toBe("unanswered");
    expect(cell(r.quotes, "V5", "L25")).toBe(cell(all, "V5", "L25"));
    expect(r.items.find((i) => i.lines.includes("L24"))!.status).toBe("resolved");
  });

  it("an answer that still leaves out the currency updates the cell but does not resolve it", () => {
    const text = "Dear Meera, yes, 38/kg for the roll too. Regards, Pankaj.";
    const vague = { message_id: "<v5-vague@jaibharatboards.example>", text, new_text_end: text.length };
    const e = ExtractionSchema.parse({
      vendor_terms: {},
      rows: [{ row_id: "c1", raw_text: "38/kg for the roll too", mapped_line_candidates: [{ line_id: "L25", match_confidence: 0.9, reasons: ["roll"] }], rate: { value: 38, currency: "", unit_as_written: "/kg" }, locator: span(text, "38/kg for the roll too"), snippet: "38/kg for the roll too" }],
    });
    const r = applyClarificationReply(input({ reply: vague, extraction: e }));
    const l25 = r.items.find((i) => i.lines.includes("L25"))!;
    expect(l25.status).toBe("answered_not_safe");
    expect(l25.detail).toBe("Answered, but not explicitly enough to settle: L25 is INFERRED.");
    expect(cell(r.quotes, "V5", "L25").flags).toContain("currency_assumed");
    expect(r.items.find((i) => i.lines.includes("L24"))!.status).toBe("unanswered");
  });

  it("a second reply stacks history, oldest first", () => {
    const first = applyClarificationReply(input());
    const text = "Correction: Rs 39/kg for the 3-ply roll.";
    const second = { message_id: "<v5-second@jaibharatboards.example>", text, new_text_end: text.length };
    const e = ExtractionSchema.parse({
      vendor_terms: {},
      rows: [{ row_id: "c1", raw_text: "Rs 39/kg for the 3-ply roll", mapped_line_candidates: [{ line_id: "L25", match_confidence: 0.9, reasons: ["roll"] }], rate: { value: 39, currency: "Rs", unit_as_written: "/kg" }, locator: span(text, "Rs 39/kg for the 3-ply roll"), snippet: "Rs 39/kg for the 3-ply roll" }],
    });
    const r = applyClarificationReply(input({ quotes: first.quotes, reply: second, extraction: e, at: "2026-09-26T10:00:00+05:30" }));
    const l25 = cell(r.quotes, "V5", "L25");
    expect(l25.history!.map((h) => [h.state, h.replaced_by])).toEqual([["NEEDS_REVIEW", V5_REPLY_ID], ["INFERRED", "<v5-second@jaibharatboards.example>"]]);
    const change = r.changes.find((c) => c.line_id === "L25")!;
    expect(change.after.rate_inr).toBe(39);
    const qty = RFX_LINES.find((l) => l.line_id === "L25")!.annual_qty;
    expect(change.delta_annual_inr).toBeCloseTo(qty, 6);
  });
});
