import { AlignmentType, Document, Footer, Header, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { generateVendorRates, roundTo2dp } from "../data/prices.js";
import { createRng } from "../data/rng.js";
import { RFX_LINES } from "../data/rfx.js";
import { parseDims } from "../ingest/checks.js";
import type { RfxLine } from "../schemas.js";
import { buildCertificatePdf, buildTestReportPdf, type CertificateSpec, type TestReportSpec } from "./pdf.js";
import { normalizeZip } from "./zip.js";

/**
 * V3: Southern Flute Packaging, Hosur. A Word document, delivered FOR Chakan (spec 17.5).
 * Traps: 14 (per 100 pcs on nine lines), 15 (USD on L26 to L28 with an RBI-rate clause, advance payment),
 * 16 (says BF 22 for 5 ply BC; the report shows 19.5), 17 (valid 15 days from 18-09-2026, lapsed 03-10-2026),
 * 18 (cartons priced in sentences, not tables), 19 (Q07 split across imported and other items).
 */

export const V3_SEED_OFFSET = 3;
export const V3_FILES = {
  quote: "SFP_Quotation_Kaveri_FY26-27.docx",
  certificate: "SFP_ISO9001.pdf",
  testReport: "SFP_Board_Test_Report.pdf",
} as const;
export const V3_QUOTE_DATE = "2026-09-18";
const FIXED_DATE = new Date("2026-09-18T06:00:00Z");
const AUTHOR = "Southern Flute Packaging";

/** Trap 14: small cartons, partitions, pads and trays quoted per 100 pieces. */
export const PER_100 = ["L09", "L10", "L11", "L12", "L13", "L14", "L18", "L19", "L22"];
/** Trap 18: the cartons are priced in sentences. */
export const PROSE = ["L01", "L02", "L03", "L04", "L05", "L06", "L07", "L08", "L15", "L16", "L17"];
/** Trap 15: imported items in USD (spec 17.5 gives these exact figures). */
export const USD: Record<string, { rate: number; unit: string }> = {
  L26: { rate: 1.53, unit: "per kg" },
  L27: { rate: 0.41, unit: "per roll" },
  L28: { rate: 0.14, unit: "per piece" },
};

export const FX_CLAUSE = "4. USD rates are subject to the RBI reference rate on the date of order.";
export const VALIDITY_TERM = "5. Validity: valid for 15 days from the date of this quotation.";
export const FREIGHT_TERM = "1. Delivery: FOR Chakan plant, freight included.";
export const GST_TERM = "2. GST: extra at 18 percent.";

export const V3_QA: [string, string, string][] = [
  ["Q01", "Valid ISO 9001 certificate for the quoting plant", "Yes, ISO 9001 certificate attached"],
  // Trap 16: the claim the test report contradicts.
  ["Q02", "BF and GSM test report for the offered board, dated within 12 months", "Yes, test report attached. BF 22 compliant for 5 ply BC board."],
  ["Q03", "Supplied corrugated packaging to a consumer durables or appliance manufacturer for at least 3 years", "Yes, 9 years"],
  ["Q04", "FSC certified board available", "No"],
  ["Q05", "Monthly capacity in tonnes", "900"],
  ["Q06", "Standard lead time in days from PO", "12"],
  // Trap 19: a split answer.
  ["Q07", "Accept payment terms net 45 days", "No: 100 percent advance for imported items, net 30 for others."],
  ["Q08", "Free samples before PO", "Yes"],
  ["Q09", "Rejection policy: replacement within how many days", "7"],
  ["Q10", "Plant location and distance to Chakan", "Hosur, about 1,050 km"],
  ["Q11", "Price validity in days", "15"],
  ["Q12", "Any deviations from the specification", "None"],
];

export const V3_CERTIFICATE: CertificateSpec = {
  cert_type: "ISO 9001:2015",
  number: "IQA/QMS/2024/1187",
  issuer: "Indus Quality Assessors Pvt Ltd (fictional)",
  entity: "Southern Flute Packaging, SIPCOT Phase II, Hosur",
  scope: "Manufacture and supply of corrugated boxes, sheets and rolls",
  valid_from: "2024-07-01",
  valid_to: "2027-06-30",
};

export const V3_TEST_REPORT: TestReportSpec = {
  lab: "Deccan Paper and Board Testing Centre (fictional)",
  report_no: "DPBTC/26/0517",
  report_date: "2026-05-20",
  samples: [
    // The spec prints 16.8, below BF 18 on six 3 ply lines; only the 5 ply shortfall is the planted trap, so raised
    // (decided 2026-10-08).
    { ply: 3, flute: "B", liner_gsm: 150, bf: 18.2 },
    { ply: 5, flute: "BC", liner_gsm: 180, bf: 19.5 }, // trap 16: the RFx needs BF 22 on L04, L06, L07, L08, L23
    { ply: 7, flute: "BCB", liner_gsm: 200, bf: 24.6 },
  ],
};

const lineOf = (id: string) => RFX_LINES.find((l) => l.line_id === id) as RfxLine;
const money = (n: number) => n.toFixed(2);

export interface V3Line {
  line_id: string;
  /** Rate per base UoM as the vendor means it: INR, or USD for L26 to L28. */
  rate_per_base: number;
  currency: "INR" | "USD";
  /** What the document prints and its basis, e.g. 659.00 "per 100 pcs". */
  shown: number;
  basis: string;
  where: "prose" | "table";
}

export function buildV3Content(seed: number, variant: V3Variant = V3_TUNED): V3Line[] {
  const inr = generateVendorRates("V3", RFX_LINES, createRng(seed + V3_SEED_OFFSET));
  return RFX_LINES.map((line) => {
    const id = line.line_id;
    const usd = variant.usd[id];
    if (usd) return { line_id: id, rate_per_base: usd.rate, currency: "USD", shown: usd.rate, basis: usd.unit, where: "table" };
    const rate = inr.get(id) as number;
    const pack = variant.perPack[id];
    return {
      line_id: id,
      rate_per_base: rate,
      currency: "INR",
      shown: pack ? roundTo2dp(rate * pack.n) : rate,
      basis: pack ? pack.label : line.base_uom === "kg" ? "per kg" : line.base_uom === "pair" ? "per pair" : line.base_uom === "set" ? "per set" : "per pc",
      where: variant.prose.includes(id) ? "prose" : "table",
    };
  });
}

/** The sentence V3 uses for a carton. Three phrasings, chosen by position, so the reader cannot rely on one. */
export function proseFor(line: RfxLine, rate: number, i: number): string {
  const [l, w, h] = parseDims(line.spec.dims_text);
  const desc = line.description.toLowerCase();
  switch (i % 3) {
    case 0:
      return `The rate for a ${desc} of ${l} by ${w} by ${h} mm is Rs ${money(rate)} per piece.`;
    case 1:
      return `For the ${desc} (${l} x ${w} x ${h} mm), our price is Rs ${money(rate)} per piece.`;
    default:
      return `We can supply the ${desc}, size ${l} x ${w} x ${h} mm, at Rs ${money(rate)} each.`;
  }
}

const cell = (text: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
const table = (header: string[], rows: string[][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: header.map((h) => cell(h, true)) }), ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))],
  });
const p = (text: string) => new Paragraph({ children: [new TextRun(text)] });
const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });

const board = (line: RfxLine) => (line.spec.ply === null ? "-" : `${line.spec.ply} ply ${line.spec.flute} ${line.spec.liner_gsm}/${line.spec.bf}`);

export async function buildV3Quote(seed: number, variant: V3Variant = V3_TUNED): Promise<{ buffer: Buffer; content: V3Line[] }> {
  const content = buildV3Content(seed, variant);
  if (variant.name === "holdout") return { buffer: await buildHoldoutDocx(content, variant), content };
  const get = (id: string) => content.find((c) => c.line_id === id) as V3Line;
  const row = (id: string, withBoard: boolean) => {
    const line = lineOf(id);
    const c = get(id);
    const rate = c.currency === "USD" ? `USD ${money(c.shown)}` : money(c.shown);
    return withBoard ? [line.description, line.spec.dims_text, board(line), rate, c.basis] : [line.description, line.spec.dims_text, rate, c.basis];
  };

  const doc = new Document({
    creator: AUTHOR,
    title: "Quotation for corrugated packaging",
    description: "Quotation to Kaveri Home Appliances",
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "SOUTHERN FLUTE PACKAGING", bold: true }), new TextRun(" | SIPCOT Phase II, Hosur 635109, Tamil Nadu")] })] }) },
        footers: { default: new Footer({ children: [p("GSTIN 33AAACS5678K1Z2 (fictional) | quotes@southernflute.example")] }) },
        children: [
          new Paragraph({ text: "Quotation for Corrugated Packaging", heading: HeadingLevel.HEADING_1 }),
          p("Date: 18-09-2026"),
          p("Ref: RFx KHA-PKG-FY26-27 dated 14-09-2026"),
          p("Dear Ms Meera,"),
          p("Thank you for your enquiry. We are pleased to quote as follows."),
          heading("Master and outer cartons"),
          ...PROSE.map((id, i) => p(proseFor(lineOf(id), get(id).shown, i))),
          heading("Inner cartons, partitions, pads and trays"),
          table(["Item", "Size (mm)", "Board", "Rate (Rs)", "Basis"], ["L09", "L10", "L11", "L12", "L13", "L14", "L18", "L19", "L20", "L21", "L22"].map((id) => row(id, true))),
          heading("Sheets and rolls"),
          table(["Item", "Size (mm)", "Board", "Rate (Rs)", "Basis"], ["L23", "L24", "L25"].map((id) => row(id, true))),
          heading("Packing accessories"),
          p("Stretch film, tape and corner protectors are imported and quoted in USD."),
          table(["Item", "Size", "Rate", "Basis"], ["L26", "L27", "L28", "L29", "L30"].map((id) => row(id, false))),
          heading("Terms and conditions"),
          p(FREIGHT_TERM),
          p(GST_TERM),
          p("3. Payment: 100 percent advance for imported items, net 30 days for others."),
          p(FX_CLAUSE),
          p(VALIDITY_TERM),
          p("6. Lead time: 12 days from PO."),
          heading("Supplier questionnaire"),
          table(["Q#", "Question", "Answer"], V3_QA.map((r) => [...r])),
          p("Our ISO 9001 certificate and board test report are attached."),
          p("For Southern Flute Packaging, R. Senthil, Sales Manager"),
        ],
      },
    ],
  });
  const buffer = await normalizeZip(await Packer.toBuffer(doc), FIXED_DATE);
  return { buffer, content };
}

export const buildV3Certificate = (variant: V3Variant = V3_TUNED) => buildCertificatePdf(variant.certificate, AUTHOR, FIXED_DATE);
export const buildV3TestReport = (variant: V3Variant = V3_TUNED) => buildTestReportPdf(variant.testReport, variant.certificate.entity, AUTHOR, FIXED_DATE);

/** The V3 slice of ground_truth.json, from the spec's rules, independently of the app. */
export function v3GroundTruth(content: V3Line[], variant: V3Variant = V3_TUNED): Record<string, unknown> {
  const USD_INR = 88;
  const BAND = 0.03;
  const FIVE_PLY_BF22 = variant.claimShortfall.lines;
  const NO_CURRENCY = variant.noCurrency;
  const lines: Record<string, unknown> = {};
  for (const c of content) {
    const usd = c.currency === "USD";
    const inr = usd ? c.rate_per_base * USD_INR : c.rate_per_base;
    lines[c.line_id] = {
      quoted: true,
      where: c.where,
      rate_as_shown: c.shown,
      basis_as_shown: c.basis,
      currency: c.currency,
      intended_rate_per_base_inr: inr,
      // L29 and L30 sit in the mixed INR/USD table under a bare "Rate" header with no currency written: priced in
      // INR, the RFx currency, and awaiting the buyer's confirmation.
      expected_state: usd || NO_CURRENCY.includes(c.line_id) ? "INFERRED" : "CONFIRMED",
      expected_flags: [...(usd ? ["fx_clause"] : []), ...(NO_CURRENCY.includes(c.line_id) ? ["currency_assumed"] : [])],
      // Raised only once the test report is read (claim vs evidence), not by the quote itself.
      expected_evidence_flags: FIVE_PLY_BF22.includes(c.line_id) ? ["spec_below_requirement"] : [],
      landed_unit_inr_point: inr,
      landed_low: usd ? inr * (1 - BAND) : inr,
      landed_high: usd ? inr * (1 + BAND) : inr,
    };
  }
  return {
    freight_basis: "delivered",
    gst_basis: "exclusive",
    quote_date: variant.quoteDate,
    validity_until: variant.validUntil,
    validity: "lapsed",
    coverage: "30 of 30",
    lines,
    gates: { Q01: "PASS", Q02: "PASS", Q03: "PASS" },
    hedged: { Q07: variant.qa[6]![2] },
    claim_vs_evidence: { claim: variant.qa[1]![2], evidence: variant.claimShortfall.evidence, lines: FIVE_PLY_BF22 },
    expected_discrepancies: ["validity_lapsed", "fx_clause", "claim_vs_evidence", "spec_below_requirement", "hedged_answer"],
    certificate: variant.certificate,
    test_report: variant.testReport,
  };
}

export interface V3DocStyle {
  title: string;
  intro: string[];
  cartonsHeading: string;
  tableHeading: string;
  rateHeader: string;
  usdHeading: string;
  usdRateHeader: string;
  terms: string[];
  qaHeading: string;
  prose: (line: RfxLine, rate: number, i: number) => string;
}

/** Where V3's traps sit and how the document reads. Tuned is the spec's file; holdout varies wording and placement. */
export interface V3Variant {
  name: "tuned" | "holdout";
  files: { quote: string; certificate: string; testReport: string };
  quoteDate: string;
  validUntil: string;
  /** Lines quoted per pack of n pieces, with the basis as printed. */
  perPack: Record<string, { n: number; label: string }>;
  prose: readonly string[];
  usd: Record<string, { rate: number; unit: string }>;
  /** Lines priced with no currency written (bare "Rate" header). */
  noCurrency: readonly string[];
  claimShortfall: { lines: string[]; evidence: string };
  /** The holdout document's wording; the seed 7 holdout's when absent. */
  doc?: V3DocStyle;
  qa: [string, string, string][];
  certificate: CertificateSpec;
  testReport: TestReportSpec;
}

export const V3_TUNED: V3Variant = {
  name: "tuned",
  files: V3_FILES,
  quoteDate: V3_QUOTE_DATE,
  validUntil: "2026-10-03",
  perPack: Object.fromEntries(PER_100.map((id) => [id, { n: 100, label: "per 100 pcs" }])),
  prose: PROSE,
  usd: USD,
  noCurrency: ["L29", "L30"],
  claimShortfall: { lines: ["L04", "L06", "L07", "L08", "L23"], evidence: "test report shows BF 19.5 for 5 ply BC" },
  qa: V3_QA,
  certificate: V3_CERTIFICATE,
  testReport: V3_TEST_REPORT,
};

export const V3_HOLDOUT: V3Variant = {
  name: "holdout",
  files: { quote: "Southern_Flute_Offer_KHA.docx", certificate: "SFP_ISO_9001_2015.pdf", testReport: "SFP_Lab_Test_BF.pdf" },
  quoteDate: "2026-09-20",
  validUntil: "2026-09-30",
  perPack: {
    L09: { n: 100, label: "per 100 nos" },
    L11: { n: 100, label: "per 100 nos" },
    L18: { n: 100, label: "per 100 nos" },
    L10: { n: 1000, label: "per 1000 nos" },
    L13: { n: 1000, label: "per 1000 nos" },
    L19: { n: 1000, label: "per 1000 nos" },
  },
  prose: ["L01", "L02", "L03", "L04", "L05", "L06", "L07", "L08"],
  usd: { L26: { rate: 1.49, unit: "per kg" }, L27: { rate: 0.39, unit: "per roll" }, L28: { rate: 0.15, unit: "per piece" } },
  noCurrency: [],
  claimShortfall: { lines: ["L15", "L16", "L17"], evidence: "test report shows BF 22.8 for 7 ply BCB" },
  qa: [
    ["Q01", "ISO 9001 certificate", "Yes, certificate enclosed"],
    ["Q02", "BF / GSM test report within 12 months", "Yes, report enclosed. All 7 ply board meets BF 24."],
    ["Q03", "3 years supplying appliance makers", "Yes, 11 years"],
    ["Q04", "FSC board", "No"],
    ["Q05", "Capacity, tonnes per month", "850"],
    ["Q06", "Lead time, days", "12"],
    ["Q07", "Net 45 days payment", "Net 45 acceptable for corrugated items; imported items against advance only."],
    ["Q08", "Free samples", "Yes"],
    ["Q09", "Replacement within days", "7"],
    ["Q10", "Plant and distance to Chakan", "Hosur, approx. 1,050 km"],
    ["Q11", "Validity, days", "10"],
    ["Q12", "Deviations", "None"],
  ],
  certificate: {
    cert_type: "ISO 9001:2015",
    number: "IQA/QMS/2025/0744",
    issuer: "Indus Quality Assessors Pvt Ltd (fictional)",
    entity: "Southern Flute Packaging, SIPCOT Phase II, Hosur",
    scope: "Manufacture and supply of corrugated packaging",
    valid_from: "2025-04-01",
    valid_to: "2028-03-31",
  },
  testReport: {
    lab: "Kaveri Valley Paper Testing Services (fictional)",
    report_no: "KVPT/2026/2209",
    report_date: "2026-06-30",
    samples: [
      { ply: 3, flute: "B", liner_gsm: 150, bf: 18.5 },
      { ply: 5, flute: "BC", liner_gsm: 180, bf: 22.4 },
      { ply: 7, flute: "BCB", liner_gsm: 200, bf: 22.8 }, // the claim says BF 24 for 7 ply; L15, L16, L17 need 24
    ],
  },
};

/** Holdout prose: other sentence shapes than the tuned file's. */
function holdoutProse(line: RfxLine, rate: number, i: number): string {
  const [l, w, h] = parseDims(line.spec.dims_text);
  const desc = line.description;
  switch (i % 4) {
    case 0:
      return `${desc}, ${l}x${w}x${h} mm: Rs. ${money(rate)}/pc.`;
    case 1:
      return `We quote Rs. ${money(rate)} for each ${desc.toLowerCase()} (${l} x ${w} x ${h}).`;
    case 2:
      return `Price of ${desc.toLowerCase()} in ${l} x ${w} x ${h} mm works out to Rs ${money(rate)} a piece.`;
    default:
      return `${desc} (${l}/${w}/${h} mm) will be Rs ${money(rate)} per carton.`;
  }
}

const DOC_DEFAULT = (): V3DocStyle => ({
  title: "Commercial Offer",
  intro: ["Offer date: 20-09-2026. Against your RFx KHA-PKG-FY26-27.", "Kind attention: Ms Meera Kulkarni"],
  cartonsHeading: "A. Cartons",
  tableHeading: "B. Other corrugated items (rates in Rs.)",
  rateHeader: "Rate (Rs.)",
  usdHeading: "C. Imported accessories (US$)",
  usdRateHeader: "Rate (US$)",
  terms: [
    "Prices are delivered to your Chakan plant; no separate freight.",
    "GST will be charged extra @ 18%.",
    "Imported accessories: 100% advance. Corrugated items: 45 days.",
    "Prices in US$ are subject to the exchange rate prevailing on the date of invoice.",
    "This offer is valid for 10 days from the offer date.",
  ],
  qaHeading: "Vendor questionnaire",
  prose: holdoutProse,
});

async function buildHoldoutDocx(content: V3Line[], variant: V3Variant): Promise<Buffer> {
  const st = variant.doc ?? DOC_DEFAULT();
  const get = (id: string) => content.find((c) => c.line_id === id) as V3Line;
  const inrRow = (id: string) => {
    const line = lineOf(id);
    const c = get(id);
    return [id === "L20" ? `${line.description} (pair)` : line.description, line.spec.dims_text, board(line), money(c.shown), c.basis];
  };
  const tableIds = RFX_LINES.map((l) => l.line_id).filter((id) => !variant.prose.includes(id) && !variant.usd[id]);
  const doc = new Document({
    creator: "SFP Sales",
    title: "Offer for corrugated packaging",
    sections: [
      {
        headers: { default: new Header({ children: [p("Southern Flute Packaging, Hosur")] }) },
        children: [
          new Paragraph({ text: st.title, heading: HeadingLevel.HEADING_1 }),
          ...st.intro.map(p),
          heading(st.cartonsHeading),
          ...variant.prose.map((id, i) => p(st.prose(lineOf(id), get(id).shown, i))),
          heading(st.tableHeading),
          table(["Description", "Size", "Board", st.rateHeader, "Unit"], tableIds.map(inrRow)),
          heading(st.usdHeading),
          table(["Description", "Size", st.usdRateHeader, "Unit"], Object.keys(variant.usd).map((id) => [lineOf(id).description, lineOf(id).spec.dims_text, money(get(id).shown), get(id).basis])),
          heading("Terms"),
          ...st.terms.map(p),
          heading(st.qaHeading),
          table(["Q", "Question", "Our reply"], variant.qa.map((r) => [...r])),
          p("Regards, R. Senthil"),
        ],
      },
    ],
  });
  return normalizeZip(await Packer.toBuffer(doc), FIXED_DATE);
}

/** V3's entries in the trap register (spec 17.6), with what the eval needs to check each one. */
export function v3Traps(variant: V3Variant): Record<string, Record<string, unknown>> {
  const tuned = variant.name === "tuned";
  const packs = Object.keys(variant.perPack);
  return {
    "14": { vendor: "V3", lines: packs, what: tuned ? "quoted per 100 pcs" : `quoted per pack: ${[...new Set(Object.values(variant.perPack).map((x) => x.label))].join(", ")}` },
    "15": { vendor: "V3", lines: Object.keys(variant.usd), what: tuned ? "USD with an RBI-rate clause; advance payment for imported items" : "imported items in dollars with an exchange rate clause; advance payment for them" },
    "16": { vendor: "V3", lines: variant.claimShortfall.lines, what: `Q02 claims "${variant.qa[1]![2]}"; ${variant.claimShortfall.evidence}` },
    "17": { vendor: "V3", what: `validity lapsed ${variant.validUntil}` },
    "18": { vendor: "V3", lines: [...variant.prose], what: "priced in sentences" },
    "19": { vendor: "V3", question: "Q07", what: variant.qa[6]![2] },
  };
}

/** Fresh holdout (seed 8): cartons and 7 ply priced in other sentences, "$" accessories, a 3 ply shortfall. */
export const V3_HOLDOUT2: V3Variant = {
  name: "holdout",
  files: { quote: "SFP_Rates_Kaveri_Sep2026.docx", certificate: "SouthernFlute_ISO.pdf", testReport: "SouthernFlute_BF_Report.pdf" },
  quoteDate: "2026-09-17",
  validUntil: "2026-09-25",
  perPack: {
    L10: { n: 100, label: "per 100 nos" },
    L12: { n: 100, label: "per hundred" },
    L14: { n: 100, label: "per 100 nos" },
    L18: { n: 50, label: "per 50 sets" },
  },
  prose: ["L01", "L02", "L05", "L15", "L16", "L17"],
  usd: { L26: { rate: 1.55, unit: "per kg" }, L27: { rate: 0.42, unit: "per roll" }, L28: { rate: 0.13, unit: "per piece" } },
  noCurrency: [],
  claimShortfall: { lines: ["L12", "L14", "L21", "L22", "L24", "L29"], evidence: "test report shows BF 17.6 for 3 ply B 150 GSM" },
  qa: [
    ["Q01", "ISO 9001", "Yes, attached"],
    ["Q02", "Board test report", "Yes, attached; 3 ply board tested above BF 18."],
    ["Q03", "Experience with appliance makers", "Yes, 10 years"],
    ["Q04", "FSC", "No"],
    ["Q05", "Capacity", "900 tonnes a month"],
    ["Q06", "Lead time", "12 days"],
    ["Q07", "Net 45", "For corrugated items yes; imported items need full advance."],
    ["Q08", "Samples", "Yes"],
    ["Q09", "Replacement", "7 days"],
    ["Q10", "Plant", "Hosur, around 1,050 km"],
    ["Q11", "Validity", "Till 25-09-2026"],
    ["Q12", "Deviations", "None"],
  ],
  doc: {
    title: "Rate Quotation",
    intro: ["17 September 2026", "To Meera Kulkarni, Kaveri Home Appliances. Sub: your RFx KHA-PKG-FY26-27."],
    cartonsHeading: "1. Cartons and outer boxes",
    tableHeading: "2. Inner cartons, partitions, sheets and others",
    rateHeader: "Rate, INR",
    usdHeading: "3. Imported items",
    usdRateHeader: "Rate ($)",
    terms: [
      "Freight: included up to your Chakan plant.",
      "GST 18% will be extra.",
      "Dollar prices will be converted at the SBI TT selling rate on the day of dispatch.",
      "Payment: imported items full advance, others 45 days.",
      "Rates valid till 25-09-2026.",
    ],
    qaHeading: "Questionnaire replies",
    prose: (line, rate, i) => {
      const [l, w, h] = parseDims(line.spec.dims_text);
      const desc = line.description.toLowerCase();
      return i % 2 === 0
        ? `For the ${desc} in ${l} x ${w} x ${h} mm we offer INR ${money(rate)} per no.`
        : `${line.description} (${l}x${w}x${h}): ${money(rate)} rupees each.`;
    },
  },
  certificate: {
    cert_type: "ISO 9001:2015",
    number: "IQA/QMS/2024/0466",
    issuer: "Indus Quality Assessors Pvt Ltd (fictional)",
    entity: "Southern Flute Packaging, SIPCOT Phase II, Hosur",
    scope: "Manufacture of corrugated boxes and board",
    valid_from: "2024-09-01",
    valid_to: "2027-08-31",
  },
  testReport: {
    lab: "Hosur Paperboard Testing Centre (fictional)",
    report_no: "HPTC/2026/0631",
    report_date: "2026-07-14",
    samples: [
      { ply: 3, flute: "B", liner_gsm: 150, bf: 17.6 }, // the claim says above BF 18; six 3 ply lines need 18
      { ply: 5, flute: "BC", liner_gsm: 180, bf: 22.5 },
      { ply: 7, flute: "BCB", liner_gsm: 200, bf: 24.3 },
    ],
  },
};
