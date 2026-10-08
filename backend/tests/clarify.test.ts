import { beforeAll, describe, expect, it } from "vitest";
import { RFX_HEADER, RFX_LINES } from "../src/data/rfx.js";
import { buildV1Workbook } from "../src/generator/v1.js";
import { buildV2Quote } from "../src/generator/v2.js";
import { buildV3Quote } from "../src/generator/v3.js";
import { buildV5Eml } from "../src/generator/v5.js";
import type { Extraction, Row } from "../src/ingest/extraction.js";
import { parseDocx } from "../src/ingest/parse_docx.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { parseXlsx } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import { draftClarification } from "../src/review/clarify.js";
import { checkConfidentiality } from "../src/review/guard.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";
import { v2Extraction } from "./fixtures/v2.js";
import { v3Extraction } from "./fixtures/v3.js";
import { v5Extraction } from "./fixtures/v5.js";

const asPassB = (e: Extraction): Extraction => ({ ...e, vendor_terms: {}, extras: [], rows: e.rows.map((r: Row) => ({ ...r, row_id: `B-${r.mapped_line_candidates[0]!.line_id}` })) });

let all: Quote[];
beforeAll(async () => {
  const wb = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
  const pdf = await parsePdf((await buildV2Quote(42)).buffer);
  const docx = await parseDocx((await buildV3Quote(42)).buffer);
  const email = await parseEmail(buildV5Eml());
  const base = { config, lines: RFX_LINES, textNative: true };
  const v5a = v5Extraction(email.text);
  v5a.rows = v5a.rows.filter((r) => r.row_id !== "r3"); // as live: pass A maps "3-ply" to the sheet only
  all = [
    ...buildQuotes({ ...base, vendorId: "V1", vendorCity: "Pune", extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb }).quotes,
    ...buildQuotes({ ...base, vendorId: "V2", vendorCity: "Ahmedabad", extraction: v2Extraction(pdf), sourceText: pdf.text, pdf }).quotes,
    ...buildQuotes({ ...base, vendorId: "V3", vendorCity: "Hosur", extraction: v3Extraction(docx), sourceText: docx.text, docx }).quotes,
    ...buildQuotes({ ...base, vendorId: "V5", vendorCity: "Vapi", extraction: v5a, passB: asPassB(v5Extraction(email.text)), sourceText: email.text, authoritativeEnd: email.new_text_end }).quotes,
  ];
});

const draft = (v: string) => draftClarification(v, all, RFX_LINES, RFX_HEADER)!;
const guard = (v: string, text: string) => checkConfidentiality(text, { vendor_id: v, quotes: all, lines: RFX_LINES, rfx: RFX_HEADER }, 5);

describe("clarification drafts", () => {
  it("V5: asks whether '38 for the 3-ply' covers the roll, and to confirm its unit and currency; passes the guard", () => {
    const d = draft("V5");
    expect(d.status).toBe("drafted");
    expect(d.to).toBe("pankaj@jaibharatboards.example");
    expect(d.subject).toBe("Clarification on your quotation for KHA-PKG-FY26-27");
    expect(d.items.map((i) => i.lines)).toEqual([["L25"], ["L24"]]);
    expect(d.items[0]!.question).toBe('Your reply says "38 for the 3-ply". Does the 38 in it apply to Corrugated roll 3 ply 1500mm width (L25)? If so, please confirm the rate and the unit for it.');
    expect(d.items[1]!.question).toBe('Your reply says "38 for the 3-ply". Please confirm the currency and unit for this price, for Corrugated sheet 3 ply 1000x1400 (L24).');
    expect(d.body).toMatch(/^Dear Mr Pankaj Shah,/);
    expect(d.body).not.toMatch(/44\.50|39\.80/); // last year's rates from our own RFx stay out
  });

  it("V1: asks about the L06 slip with the vendor's own figure only, never our suggested correction", () => {
    const d = draft("V1");
    expect(d.status).toBe("drafted");
    const l06 = d.items.find((i) => i.lines.includes("L06"))!;
    expect(l06.question).toBe('For Room cooler 40L master carton (L06), your quotation shows "11.08". Please confirm this rate and its unit are correct.');
    expect(d.body).not.toMatch(/110\.8/);
  });

  it("V2: asks about the L15 amount with the vendor's own row; the RFx quantity is fine to show", () => {
    const d = draft("V2");
    expect(d.status).toBe("drafted");
    expect(d.items.map((i) => i.lines)).toEqual([["L15"]]);
    expect(d.items[0]!.question).toMatch(/^For Washing machine fully automatic 6\.5kg outer carton \(L15\), the amount in your quotation does not equal the rate times the quantity/);
  });

  it("V3: one question for the two prices with no currency", () => {
    const d = draft("V3");
    expect(d.status).toBe("drafted");
    expect(d.items.map((i) => i.lines)).toEqual([["L29", "L30"]]);
    expect(d.items[0]!.question).toMatch(/^Please confirm the currency of your prices for Corrugated pallet slip sheet 1100x1100 \(L29\), Edge board 40x40x3mm x 1200mm \(L30\)/);
  });

  it("no draft for a vendor with nothing to clarify", () => {
    const clean = all.filter((q) => q.vendor_id !== "V3" || !["L29", "L30"].includes(q.line_id));
    expect(draftClarification("V3", clean, RFX_LINES, RFX_HEADER)).toBeNull();
  });
});

describe("confidentiality guard (spec 13.3, SY07)", () => {
  const base = () => draft("V5").body;

  it("blocks another vendor's price and says whose it is", () => {
    const r = guard("V5", `${base()}\nFor reference, 37.29 is on the table.`);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ kind: "number", text: "37.29", detail: "37.29 appears in V1's quotation (L01)" }]);
  });

  it("blocks another vendor's name or alias", () => {
    const r = guard("V5", `${base()}\nAhmedabad Packwell has already replied.`);
    expect(r.problems.map((p) => [p.kind, p.text])).toEqual([["vendor_name", "Ahmedabad Packwell"], ["vendor_name", "Packwell"]]);
  });

  it("blocks comparisons and internal pricing, including last year's price", () => {
    expect(guard("V5", `${base()}\nA competitor offered lower.`).problems.map((p) => p.kind)).toContain("phrase");
    const r = guard("V5", `${base()}\nLast year's price was 44.50.`);
    expect(r.problems.map((p) => p.kind).sort()).toEqual(["number", "phrase"]);
  });

  it("blocks a number nobody wrote, such as our own computed correction", () => {
    const r = guard("V1", `${draft("V1").body}\nDid you mean 110.81?`);
    expect(r.problems).toEqual([{ kind: "number", text: "110.81", detail: "110.81 is not in this vendor's reply or the RFx" }]);
  });

  it("allows the RFx's public details: sizes, quantities, specs, ids and dates", () => {
    const r = guard("V5", `${base()}\nThe sheet is 1100x1600, 5 ply 180/22, 37,500 kg a year, RFx dated 14-09-2026.`);
    expect(r.problems).toEqual([]);
  });

  it("a blocked draft is marked blocked, never drafted", () => {
    const leaky = all.map((q) => (q.vendor_id === "V5" && q.line_id === "L24" ? { ...q, components: q.components.map((c) => ({ ...c, provenance: { ...c.provenance, snippet: "Shree Ganesh charges 38" } })) } : q));
    const d = draftClarification("V5", leaky, RFX_LINES, RFX_HEADER)!;
    expect(d.status).toBe("blocked");
    expect(d.guard.problems.some((p) => p.kind === "vendor_name")).toBe(true);
  });
});
