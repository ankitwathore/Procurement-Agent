import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { V4_TUNED, buildV4CertificatePhoto, buildV4Eml, buildV4Photo, type V4Photo, type V4Row } from "../src/generator/v4.js";
import { parseRef, runPassA, type PassADocument } from "../src/ingest/extract_a.js";
import { verifyEvidence } from "../src/ingest/extract_evidence.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import type { JsonRequest, JsonResponse, LlmClient } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import { config } from "./fixtures/quotes.js";

/** Reading V4's photo (spec 10, 17.5): the vision path with a stub standing in for the model. */

class StubLlm implements LlmClient {
  requests: JsonRequest[] = [];
  constructor(private readonly respond: (req: JsonRequest) => Partial<JsonResponse>) {}
  async json(req: JsonRequest): Promise<JsonResponse> {
    this.requests.push(req);
    const usage = { input_tokens: 3000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return { text: null, stop_reason: "end_turn", model: req.model, fallback_used: false, usage, cost_usd: costUsd(req.model, usage), ms: 42, ...this.respond(req) };
  }
}

let photo: V4Photo;
let rows: V4Row[];
let doc: PassADocument;
let email: Awaited<ReturnType<typeof parseEmail>>;

const box = (b: number[]) => `box ${b.map((x) => x.toFixed(3)).join(" ")}`;

/** What a correct reading of the photo looks like, in pass A's output format. */
function reading(): Record<string, unknown> {
  const out = rows.map((r) => {
    const line = RFX_LINES.find((l) => l.line_id === r.line_id)!;
    const unreadable = V4_TUNED.unreadable.includes(r.line_id);
    const struck = V4_TUNED.overwritten.line === r.line_id;
    const rate = unreadable ? "" : struck ? "68.50" : r.printed.toLocaleString("en-IN", { minimumFractionDigits: 2 });
    return {
      line_id: r.line_id,
      match_confidence: 0.9,
      match_reasons: "description and size",
      raw_text: struck ? "65.90 struck through, 68.50 written by hand" : `${r.serial} ${line.description}`,
      rate_as_written: rate,
      currency: "Rs",
      unit_as_written: r.unit,
      line_total_as_written: "",
      ply: "",
      liner_gsm: "",
      bf: "",
      dims: r.size,
      print: "",
      struck_out_or_overwritten: struck,
      carried_over: "",
      legibility: unreadable ? 0.1 : 0.9,
      snippet: unreadable ? `${r.serial} ${line.description}` : `${r.serial} ${line.description} ${r.size} ${rate} ${r.unit}`,
      locator: `row ${r.serial} ${box(photo.regions[r.line_id]!.rate)}`,
      assumptions: [],
    };
  });
  return {
    terms: [
      { kind: "freight_basis", value: "ex_works", text: "EX WORKS BAHADURGARH", amount: "", threshold_text: "", threshold_inclusive: true, valid_until: "", from_date: "", snippet: "EX WORKS BAHADURGARH", locator: "box 0.2 0.15 0.8 0.18" },
      { kind: "gst_basis", value: "exclusive", text: "GST EXTRA 18 PERCENT", amount: "18", threshold_text: "", threshold_inclusive: true, valid_until: "", from_date: "", snippet: "GST EXTRA 18 PERCENT", locator: "box 0.2 0.15 0.8 0.18" },
      { kind: "validity", value: "", text: "RATES VALID 15 DAYS FROM 24-09-2026", amount: "15", threshold_text: "", threshold_inclusive: true, valid_until: "", from_date: "2026-09-24", snippet: "RATES VALID 15 DAYS FROM 24-09-2026", locator: "box 0.2 0.15 0.8 0.18" },
    ],
    rows: out,
    extras: [],
    questionnaire: V4_TUNED.qa.map(([q_id, text, a]) => ({ q_id, answer_raw: a, snippet: `${q_id} ${text}: ${a}` })),
    unreadable_regions: V4_TUNED.unreadable.map((id) => ({ line_id: id, description: `rate for ${id} under glare`, snippet: rows.find((r) => r.line_id === id)!.serial + " row", locator: `row ${rows.find((r) => r.line_id === id)!.serial} ${box(photo.regions[id]!.rate)}` })),
    notes: [],
  };
}

beforeAll(async () => {
  ({ photo, rows } = await buildV4Photo(42));
  email = await parseEmail(buildV4Eml(photo.jpeg, await buildV4CertificatePhoto(42)));
  const att = email.attachments[0]!;
  doc = { vendor_id: "V4", kind: "image", text: email.text, authoritative_end: email.new_text_end, message_id: email.message_id, images: [{ media_type: "image/jpeg", data: att.content.toString("base64"), name: att.filename }] };
}, 30_000);

describe("photo locators", () => {
  it("parses the row and the box; anything else leaves only the type, which the provenance check rejects", () => {
    expect(parseRef("image", "row 12 box 0.74 0.48 0.81 0.51")).toEqual({ type: "image", row: 12, box: [0.74, 0.48, 0.81, 0.51] });
    expect(parseRef("image", "Row 3, box 0.1, 0.2, 0.3, 0.4")).toEqual({ type: "image", row: 3, box: [0.1, 0.2, 0.3, 0.4] });
    expect(parseRef("image", "top right")).toEqual({ type: "image" });
  });
});

describe("pass A on the photo (stubbed model)", () => {
  it("sends the photo as an image block before the email text", async () => {
    const stub = new StubLlm(() => ({ text: JSON.stringify(reading()) }));
    await runPassA(doc, { client: stub, config, lines: RFX_LINES, questions: QUESTIONS });
    const req = stub.requests[0]!;
    expect(req.images).toHaveLength(1);
    expect(req.images![0]!.media_type).toBe("image/jpeg");
    expect(Buffer.from(req.images![0]!.data, "base64").equals(photo.jpeg)).toBe(true);
    expect(req.user).toContain("The quotation is the attached photo (IMG_20260924_101533.jpg)");
  });

  it("builds the trap states: priced rows inferred (freight), unreadable, struck and per box rows in review, three missing", async () => {
    const r = await runPassA(doc, { client: new StubLlm(() => ({ text: JSON.stringify(reading()) })), config, lines: RFX_LINES, questions: QUESTIONS });
    const built = buildQuotes({ vendorId: "V4", vendorCity: "Bahadurgarh", config, lines: RFX_LINES, extraction: r.extraction!, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: false, receivedAt: "2026-09-24" });
    expect(built.rejected).toEqual([]);
    const state = (s: string) => built.quotes.filter((q) => q.state === s).map((q) => q.line_id);
    expect(state("MISSING")).toEqual(["L15", "L16", "L17"]);
    expect(state("NEEDS_REVIEW")).toEqual(["L04", "L12", "L22", "L27"]);
    expect(state("INFERRED")).toHaveLength(23);
    const l02 = built.quotes.find((q) => q.line_id === "L02")!;
    expect(l02.components.find((c) => c.kind === "base_rate")!.state).toBe("HIGH_CONF"); // a photo reading is never CONFIRMED
    expect(l02.components[0]!.provenance.locator).toMatchObject({ type: "image", file: "IMG_20260924_101533.jpg" });
    expect(built.quotes.filter((q) => q.flags.includes("spec_dimension_off")).map((q) => q.line_id)).toEqual(["L01", "L03", "L05"]);
    expect(built.quotes.find((q) => q.line_id === "L27")!.state_reason).toMatch(/per box/);
    expect(built.vendor).toMatchObject({ late: true, validity: { status: "expiring", valid_until: "2026-10-09" } });
  });

  it("a row with no box, or a rate not in its own transcription, is rejected", async () => {
    const bad = reading();
    const rs = bad.rows as Record<string, unknown>[];
    rs[0]!.locator = "row 1";
    rs[1]!.rate_as_written = "99.99";
    const r = await runPassA(doc, { client: new StubLlm(() => ({ text: JSON.stringify(bad) })), config, lines: RFX_LINES, questions: QUESTIONS });
    const built = buildQuotes({ vendorId: "V4", vendorCity: "Bahadurgarh", config, lines: RFX_LINES, extraction: r.extraction!, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: false });
    expect(built.rejected.map((x) => x.reason)).toEqual(["image locator has no box inside the image", "rate 99.99 is not written in the snippet"]);
  });
});

describe("a line seen but unreadable is never 'not quoted' (holdout seed 7, 2026-10-09)", () => {
  const build = (extraction: NonNullable<Awaited<ReturnType<typeof runPassA>>["extraction"]>, passB?: typeof extraction) =>
    buildQuotes({ vendorId: "V4", vendorCity: "Bahadurgarh", config, lines: RFX_LINES, extraction, passB, sourceText: email.text, authoritativeEnd: email.new_text_end, textNative: false });

  it("pass A: an unreadable row given only in unreadable_regions, with its line, becomes a row in review", async () => {
    const r0 = reading();
    r0.rows = (r0.rows as { line_id: string }[]).filter((x) => !V4_TUNED.unreadable.includes(x.line_id)); // as the seed 7 run did
    const r = await runPassA(doc, { client: new StubLlm(() => ({ text: JSON.stringify(r0) })), config, lines: RFX_LINES, questions: QUESTIONS });
    const q = build(r.extraction!).quotes;
    for (const id of V4_TUNED.unreadable) expect(q.find((x) => x.line_id === id)!.state, id).toBe("NEEDS_REVIEW");
    expect(q.find((x) => x.line_id === "L12")!.state_reason).toMatch(/unreadable/i);
  });

  it("pass B: status unreadable gives a row with no rate; not_offered gives nothing", async () => {
    const lines = RFX_LINES.map((l) => {
      const r = rows.find((x) => x.line_id === l.line_id);
      const unreadable = !!r && V4_TUNED.unreadable.includes(l.line_id);
      return {
        line_id: l.line_id, status: !r ? "not_offered" : unreadable ? "unreadable" : "priced",
        rate_as_written: r && !unreadable ? String(r.printed) : "", currency: r ? "Rs" : "", unit_as_written: r ? r.unit : "", carried_over: "", line_total_as_written: "", ply: "", liner_gsm: "", bf: "", dims: r?.size ?? "", print: "",
        struck_out_or_overwritten: false, legibility: unreadable ? 0.6 : 0.9,
        snippet: r ? (unreadable ? `${r.serial} ${l.description}` : `${r.serial} ${l.description} ${r.printed}`) : "",
        locator: r ? `row ${r.serial} ${box(photo.regions[l.line_id]!.rate)}` : "", assumptions: [], not_found_reason: unreadable ? "rate under glare" : r ? "" : "not on the card",
      };
    });
    const { passBToExtraction } = await import("../src/ingest/extract_b.js");
    const b = passBToExtraction({ lines, notes: [] }, doc);
    const l12 = b.rows.find((x) => x.mapped_line_candidates[0]!.line_id === "L12")!;
    expect(l12).toMatchObject({ rate: { value: null }, legibility: 0.2 });
    expect(b.rows.some((x) => x.mapped_line_candidates[0]!.line_id === "L15")).toBe(false);
    const a = reading();
    a.rows = (a.rows as { line_id: string }[]).filter((x) => !V4_TUNED.unreadable.includes(x.line_id));
    a.unreadable_regions = [];
    const ra = await runPassA(doc, { client: new StubLlm(() => ({ text: JSON.stringify(a) })), config, lines: RFX_LINES, questions: QUESTIONS });
    // Pass A left the rows out entirely; pass B saw them: the line is in review, not missing.
    expect(build(ra.extraction!, b).quotes.find((x) => x.line_id === "L12")!.state).toBe("NEEDS_REVIEW");
  });
});

describe("a photographed certificate", () => {
  it("is taken as read, still parsed strictly, and says it has no text layer", () => {
    const r = verifyEvidence(
      {
        doc_role: "certificate",
        certificate: { cert_type: "ISO 9001:2015", number: "BQC/QMS/24/7712", issuer: "", entity_name: "Delhi Carton Works, Plot 18, HSIIDC Industrial Area, Bahadurgarh", scope: "Manufacture of corrugated boxes and board", valid_from: "11-01-2024", valid_to: "10-01-2027", validity_snippet: "" },
        test_report: { lab: "", report_no: "", report_date: "", header_snippet: "", samples: [] },
        notes: [],
      },
      null,
    );
    expect(r.certificate?.valid_to).toBe("2027-01-10");
    expect(r.problems).toEqual(["read from a photo: no text layer to check the values against"]);
    expect(verifyEvidence({ doc_role: "certificate", certificate: { cert_type: "ISO 9001:2015", entity_name: "Delhi Carton Works", valid_from: "11-01-2024", valid_to: "sometime 2027" }, test_report: {}, notes: [] }, null).certificate).toBeNull();
  });
});
