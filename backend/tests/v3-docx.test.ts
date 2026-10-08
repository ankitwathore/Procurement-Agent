import { createHash } from "node:crypto";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, allocate } from "../src/award/optimizer.js";
import { QUESTIONS, RFX_LINES } from "../src/data/rfx.js";
import { classifyAnswer } from "../src/evidence/certificates.js";
import { applyReportFindings, checkDeviationClaim, compareReportToLines } from "../src/evidence/claims.js";
import { offeredPlies, summarizeGates } from "../src/evidence/gates.js";
import { PER_100, PROSE, USD, V3_QA, buildV3Certificate, buildV3Quote, buildV3TestReport, v3GroundTruth, type V3Line } from "../src/generator/v3.js";
import type { Extraction } from "../src/ingest/extraction.js";
import { parseDocx, type ParsedDocx } from "../src/ingest/parse_docx.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { ParseError } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type BuildResult } from "../src/ingest/quotes.js";
import { readCertificate, readTestReport } from "./fixtures/evidence.js";
import { config } from "./fixtures/quotes.js";
import { v3Extraction } from "./fixtures/v3.js";

const SEED = 42;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const line = (id: string) => RFX_LINES.find((l) => l.line_id === id)!;

let buffer: Buffer;
let content: V3Line[];
let doc: ParsedDocx;

beforeAll(async () => {
  ({ buffer, content } = await buildV3Quote(SEED));
  doc = await parseDocx(buffer);
});

const build = (extraction: Extraction = v3Extraction(doc)) =>
  buildQuotes({ vendorId: "V3", vendorCity: "Hosur", config, lines: RFX_LINES, extraction, sourceText: doc.text, docx: doc, textNative: true, receivedAt: "2026-09-18" });

describe("V3 Word generator", () => {
  it("is byte-for-byte reproducible", async () => {
    expect(sha((await buildV3Quote(SEED)).buffer)).toBe(sha(buffer));
  });

  it("trap 14: nine lines are printed per 100 pieces, exactly 100x the per piece rate", () => {
    for (const c of content.filter((x) => PER_100.includes(x.line_id))) {
      expect(c.basis, c.line_id).toBe("per 100 pcs");
      expect(c.shown, c.line_id).toBeCloseTo(c.rate_per_base * 100, 6);
    }
  });

  it("trap 15: L26 to L28 are in USD at the spec's figures; INR lines sit at 1.03 of baseline", () => {
    for (const [id, u] of Object.entries(USD)) expect(content.find((c) => c.line_id === id)).toMatchObject({ currency: "USD", shown: u.rate });
    for (const c of content.filter((x) => x.currency === "INR")) {
      expect(Math.abs(c.rate_per_base / (line(c.line_id).baseline_price_inr * 1.03) - 1), c.line_id).toBeLessThanOrEqual(0.0155);
    }
  });

  it("trap 18: the eleven cartons are sentences, not table rows", () => {
    const prose = doc.blocks.filter((b) => b.type === "paragraph" && /Rs [\d.]+ (per piece|each)/.test(b.text));
    expect(prose).toHaveLength(PROSE.length);
    expect(doc.text).not.toMatch(/\[T\d+ R\d+\] [^|]*master carton/i);
  });
});

describe("parseDocx", () => {
  it("reads body paragraphs and tables in order, with the header and footer", () => {
    expect(doc.headers).toEqual(["SOUTHERN FLUTE PACKAGING | SIPCOT Phase II, Hosur 635109, Tamil Nadu"]);
    expect(doc.footers[0]).toMatch(/^GSTIN 33AAACS5678K1Z2/);
    expect(doc.blocks.filter((b) => b.type === "table")).toHaveLength(4);
    expect(doc.text.split("\n")[0]).toMatch(/^\[HEADER\]/);
    expect(doc.text.split("\n").at(-1)).toMatch(/^\[FOOTER\]/);
  });

  it("keeps numbers exactly as written ('661.00' stays '661.00')", () => {
    const per100 = content.find((c) => c.line_id === "L09")!;
    expect(doc.text).toContain(`| ${per100.shown.toFixed(2)} | per 100 pcs`);
  });

  it("ignores deleted text and field codes, keeps tabs and breaks", async () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Rate Rs </w:t></w:r><w:del><w:r><w:delText>40.00</w:delText></w:r></w:del><w:r><w:t>42.00</w:t></w:r><w:r><w:tab/><w:t>per kg</w:t></w:r></w:p>
      <w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>Page</w:t><w:br/><w:t>1</w:t></w:r></w:p></w:body></w:document>`;
    const zip = new JSZip();
    zip.file("word/document.xml", xml);
    const d = await parseDocx(await zip.generateAsync({ type: "nodebuffer" }));
    expect(d.blocks.map((b) => (b.type === "paragraph" ? b.text : ""))).toEqual(["Rate Rs 42.00\tper kg", "Page 1"]);
  });

  it("refuses what is not a Word document", async () => {
    await expect(parseDocx(Buffer.from("not a zip"))).rejects.toBeInstanceOf(ParseError);
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    await expect(parseDocx(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/not a readable docx/);
  });
});

describe("V3's real Word file through the pipeline, scored against ground truth", () => {
  let r: BuildResult;
  const gt = () => v3GroundTruth(content) as { lines: Record<string, { expected_state: string; landed_unit_inr_point: number; landed_low: number; landed_high: number }> };
  beforeAll(() => {
    r = build();
  });
  const q = (id: string) => r.quotes.find((x) => x.line_id === id)!;

  it("maps all 30 lines, from sentences and tables, with no rejections", () => {
    expect(r.rejected).toEqual([]);
    expect(r.quotes.every((x) => x.state !== "MISSING")).toBe(true);
  });

  it("every state and every landed price matches the ground truth", () => {
    for (const l of RFX_LINES) {
      const g = gt().lines[l.line_id]!;
      expect(q(l.line_id).state, l.line_id).toBe(g.expected_state);
      expect(q(l.line_id).landed!.point, l.line_id).toBeCloseTo(g.landed_unit_inr_point, 6);
      expect(q(l.line_id).landed!.low, l.line_id).toBeCloseTo(g.landed_low, 6);
      expect(q(l.line_id).landed!.high, l.line_id).toBeCloseTo(g.landed_high, 6);
    }
  });

  it("trap 14: the per 100 chain is shown, and delivered means no freight", () => {
    expect(q("L09").chain[0]).toMatch(/per 100 piece = [\d.]+ per piece/);
    expect(q("L09").components.map((c) => c.kind)).toEqual(["base_rate"]);
  });

  it("trap 15: USD lines carry the FX chain and the clause band; payment advance is a hedged Q07 (trap 19)", () => {
    expect(q("L26").chain.join(" ")).toMatch(/USD 1\.53 x 88 = Rs 134\.64/);
    expect(q("L26").flags).toContain("fx_clause");
    expect(r.vendor.discrepancies.some((d) => d.kind === "fx_clause")).toBe(true);
    expect(classifyAnswer(V3_QA.find(([id]) => id === "Q07")![2])).toBe("hedged");
  });

  it("trap 17: validity lapsed on 2026-10-03, so V3 is excluded by default and included only when asked", () => {
    expect(r.vendor.validity).toMatchObject({ status: "lapsed", valid_until: "2026-10-03" });
    const run = (include_expired_quotes: boolean) =>
      allocate(RFX_LINES, [{ vendor_id: "V3", quotes: r.quotes, assessment: r.vendor, gate: "PASS" }], { ...DEFAULT_POLICY, include_expired_quotes }, config.exposure.safe_states);
    expect(run(false).excluded_vendors).toEqual([{ vendor_id: "V3", reason: "quote validity has lapsed" }]);
    expect(run(true).unfillable).toEqual([]);
  });
});

describe("V3 evidence: gates pass, but the report contradicts the claim (trap 16)", () => {
  let r: BuildResult;
  beforeAll(() => {
    r = build();
  });

  it("all three gates pass on the real certificate and test report", async () => {
    const certificate = readCertificate((await parsePdf(await buildV3Certificate())).text);
    const test_report = readTestReport((await parsePdf(await buildV3TestReport())).text);
    const answers = Object.fromEntries(V3_QA.map(([id, , a]) => [id, a]));
    const s = summarizeGates(QUESTIONS, { vendor_name: "Southern Flute Packaging", answers, certificate, test_report, offered_plies: offeredPlies(r.quotes, RFX_LINES) }, config);
    expect(s.overall).toBe("PASS");
  });

  it("the report's 5 ply BC BF 19.5 flags L04, L06, L07, L08, L23 and contradicts the 'None' deviations answer", async () => {
    const report = readTestReport((await parsePdf(await buildV3TestReport())).text);
    const findings = compareReportToLines(report, r.quotes, RFX_LINES);
    expect(findings.filter((f) => f.sample.ply === 5).map((f) => f.line_id)).toEqual(["L04", "L06", "L07", "L08", "L23"]);
    const withFindings = applyReportFindings(r.quotes, findings);
    const claim = checkDeviationClaim("Q12", V3_QA.find(([id]) => id === "Q12")![2], withFindings)!;
    expect(claim.lines).toEqual(expect.arrayContaining(["L04", "L06", "L07", "L08", "L23"]));
    const strict = allocate(RFX_LINES, [{ vendor_id: "V3", quotes: withFindings, assessment: r.vendor, gate: "PASS" }], { ...DEFAULT_POLICY, include_expired_quotes: true }, config.exposure.safe_states);
    expect(strict.unfillable).toEqual(expect.arrayContaining(["L04", "L06", "L07", "L08", "L23"]));
  });
});

describe("docx provenance guards", () => {
  const tamper = (fn: (e: Extraction) => void) => {
    const e = v3Extraction(doc);
    fn(e);
    return build(e);
  };
  const prose = (e: Extraction) => e.rows.find((x) => x.locator.paragraph_idx !== undefined)!;
  const tableRow = (e: Extraction) => e.rows.find((x) => x.locator.table_idx !== undefined)!;

  it("rejects a sentence pointed at the wrong paragraph", () => {
    const r = tamper((e) => {
      prose(e).locator = { type: "docx", paragraph_idx: 0 };
    });
    expect(r.rejected[0]!.reason).toBe("snippet does not appear in paragraph 0");
  });

  it("rejects a rate that is not written in its sentence or row", () => {
    expect(tamper((e) => { prose(e).rate.value = 99.99; }).rejected[0]!.reason).toBe("rate 99.99 is not written in the snippet");
    expect(tamper((e) => { tableRow(e).rate.value = 1; }).rejected[0]!.reason).toMatch(/not written in the snippet/);
  });

  it("rejects a table row that does not exist, and everything when there is no document to check", () => {
    expect(tamper((e) => { tableRow(e).locator = { type: "docx", table_idx: 0, row: 99 }; }).rejected[0]!.reason).toBe("table 0 row 99 does not exist");
    const none = buildQuotes({ vendorId: "V3", vendorCity: "Hosur", config, lines: RFX_LINES, extraction: v3Extraction(doc), sourceText: doc.text, textNative: true });
    expect(none.rejected).toHaveLength(30);
  });
});
