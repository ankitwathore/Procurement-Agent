import ExcelJS from "exceljs";
import { generateVendorRates, roundTo2dp } from "../data/prices.js";
import { createRng } from "../data/rng.js";
import { RFX_LINES } from "../data/rfx.js";
import { parseDims } from "../ingest/checks.js";
import type { RfxLine } from "../schemas.js";
import { buildCertificatePdf, buildTestReportPdf } from "./pdf.js";
import { normalizeZip } from "./zip.js";

/**
 * V1: Shree Ganesh Corrugators, an Excel offer that ignores the RFx template (spec 17.5).
 * Plants traps 01 (transposed layout, merged group headers, separate Summary sheet), 02 (hidden previous-quarter
 * rates), 03 (lighter board on L01, L02, L03, L05 while the questionnaire says no deviations),
 * 04 (L06 typed 11.08), 35 (NQ and a blank) and, as revision 2, trap 05.
 */

export const V1_SEED_OFFSET = 1;
export const V1_FILE_NAMES = {
  1: "Shree_Ganesh_Rate_Offer_FY26-27.xlsx",
  2: "Shree_Ganesh_Rate_Offer_FY26-27_REVISED.xlsx",
} as const;

export const V1_EVIDENCE_FILES = { certificate: "SGC_ISO9001_Certificate.pdf", testReport: "SGC_Board_Test_Report.pdf" } as const;

/** Spec 17.5: ISO 9001 valid to 2027-03-14. */
export const V1_CERTIFICATE = {
  cert_type: "ISO 9001:2015",
  number: "IQA/QMS/2024/1187",
  issuer: "Indus Quality Assurance Services (fictional)",
  entity: "Shree Ganesh Corrugators, Chakan Industrial Area, Pune",
  scope: "Manufacture of corrugated boxes and board",
  valid_from: "2024-03-15",
  valid_to: "2027-03-14",
};

/**
 * Spec 17.5: a test report matching the board V1 actually offers, the lighter 120 GSM 5 ply included. Each grade has
 * its own sample, so the lighter one speaks only for the lines offered on it (L01, L02, L03, L05).
 */
export const V1_TEST_REPORT = {
  lab: "Deccan Packaging Test Centre (fictional)",
  report_no: "DPTC/2026/0612",
  report_date: "2026-06-10",
  samples: [
    { ply: 3, flute: "B", liner_gsm: 120, bf: 16.6 },
    { ply: 3, flute: "B", liner_gsm: 150, bf: 18.7 },
    { ply: 5, flute: "BC", liner_gsm: 120, bf: 16.3 },
    { ply: 5, flute: "BC", liner_gsm: 180, bf: 22.5 },
    { ply: 7, flute: "BCB", liner_gsm: 200, bf: 24.7 },
  ],
};

const EVIDENCE_DATE = new Date("2026-09-21T10:00:00Z");
export const buildV1Certificate = (variant: V1Variant = V1_TUNED) => buildCertificatePdf(variant.certificate, "Shree Ganesh Corrugators", EVIDENCE_DATE);
export const buildV1TestReport = (variant: V1Variant = V1_TUNED) => buildTestReportPdf(variant.testReport, variant.certificate.entity, "Shree Ganesh Corrugators", EVIDENCE_DATE);

/** Lines offered on a lighter board: 120 GSM liner, BF 16, at 0.93 instead of 0.985 (trap 03). */
const LIGHTER = { liner_gsm: 120, bf: 16, factor: 0.93 };

/**
 * Where V1's traps sit and how the workbook is laid out. The tuned set (seed 42) is the spec's file; the holdout set
 * (seed 7, spec 17.10) keeps the same classes of traps on different lines, in a different layout and wording.
 */
export interface RowsStyle {
  sheet: string;
  reverseGroups: boolean;
  headers: [string, string, string, string, string, string, string, string];
  subtitle: string;
  noteWord: string;
  terms: [string, string][];
  termsSheet: string;
  qaSheet: string;
  totalLabel: string;
}

const ROWS_DEFAULT: RowsStyle = {
  sheet: "Offer",
  reverseGroups: true,
  headers: ["Sr", "Item", "Size (mm)", "Board", "UOM", "Rate (Rs)", "Last Qtr Rate", "Remarks"],
  subtitle: "Quotation for Kaveri Home Appliances against RFx KHA-PKG-FY26-27",
  noteWord: "Supplied in",
  terms: [
    ["Freight", "Door delivery to Chakan plant, included in rates"],
    ["Taxes", "GST 18% extra as applicable"],
    ["Payment", "45 days"],
    ["Validity", "Rates valid for 30 days from 21.09.2026"],
    ["Delivery", "8 to 10 days after PO"],
  ],
  termsSheet: "Terms",
  qaSheet: "Questionnaire",
  totalLabel: "Total value (Rs)",
};

export interface V1Variant {
  name: "tuned" | "holdout";
  layout: "transposed" | "rows";
  lighter: readonly string[];
  /** "spec": the spec's L06 (0.985 x baseline, typed a tenth); "x10": the generated rate typed ten times over. */
  slip: { line: string; mode: "spec" | "x10" | "div10" };
  /** The rows layout's wording; the seed 7 holdout's when absent. */
  rows?: RowsStyle;
  notQuoted: { line: string; token: string };
  blank: string;
  files: { 1: string; 2: string; certificate: string; testReport: string };
  qa: [string, string, string][];
  certificate: typeof V1_CERTIFICATE;
  testReport: typeof V1_TEST_REPORT;
}
/** Revision 2: kraft paper price increase on these lines, and L06 corrected. */
const REV2_INCREASE_LINES = ["L04", "L15", "L16", "L17"] as const;
const REV2_INCREASE = 1.03;

const GROUPS: { title: string; from: string; to: string }[] = [
  { title: "5 PLY PRINTED", from: "L01", to: "L08" },
  { title: "3 PLY INNER", from: "L09", to: "L14" },
  { title: "7 PLY OUTER", from: "L15", to: "L17" },
  { title: "PARTITIONS / PADS", from: "L18", to: "L22" },
  { title: "SHEETS / ROLLS", from: "L23", to: "L25" },
  { title: "PACKING ACCESSORIES", from: "L26", to: "L30" },
];

// The vendor uses its own short names, so mapping is a real step.
const ABBREVIATIONS: [RegExp, string][] = [
  [/master carton/i, "MC"],
  [/inner carton/i, "IC"],
  [/corrugated/i, "CORR"],
  [/microwave oven/i, "MW OVEN"],
  [/refrigerator/i, "FRIDGE"],
  [/washing machine fully automatic/i, "WM FA"],
  [/mixer grinder/i, "MIXER"],
  [/ceiling fan/i, "C FAN"],
];

const UNIT_LABEL: Record<RfxLine["base_uom"], string> = { piece: "pc", set: "set", pair: "pair", kg: "kg", roll: "roll" };

// Sheet rows. Columns: A holds the row labels, line i (0-based) sits in column i + 2.
const ROW = { title: 1, group: 3, item: 4, size: 5, board: 6, unit: 7, rate: 8, note: 9, rateQ2: 10 } as const;
const firstCol = 2;
const colOf = (lineId: string): number => firstCol + RFX_LINES.findIndex((l) => l.line_id === lineId);

export function vendorItemName(line: RfxLine): string {
  return ABBREVIATIONS.reduce((name, [re, short]) => name.replace(re, short), line.description).toUpperCase();
}

export interface V1Line {
  line_id: string;
  /** What the cell shows: a number, a not-quoted token ("NQ"), or null for blank. */
  shown: number | string | null;
  /** The rate the vendor meant. */
  intended: number | null;
  /** Previous quarter rate in the hidden row. */
  hidden_q2: number | null;
  cell: string;
  board: { ply: number | null; liner_gsm: number | null; bf: number | null };
  note: string;
}

export interface V1Sheet {
  revision: 1 | 2;
  lines: V1Line[];
  grand_total: number;
}

/** Deterministic content of the offer, before it is written to a workbook. */
export function buildV1Content(seed: number, revision: 1 | 2, variant: V1Variant = V1_TUNED): V1Sheet {
  const SLIP_LINE = variant.slip.line;
  const overrides = Object.fromEntries(variant.lighter.map((id) => [id, LIGHTER.factor]));
  const rowOf = variant.layout === "rows" ? rowsLayout(variant.rows ?? ROWS_DEFAULT) : null;
  const base = generateVendorRates("V1", RFX_LINES, createRng(seed + V1_SEED_OFFSET), overrides);
  const q2noise = createRng(seed + V1_SEED_OFFSET + 100);

  const lines: V1Line[] = RFX_LINES.map((line) => {
    const id = line.line_id;
    const lighter = variant.lighter.includes(id);
    const generated = base.get(id) as number;
    // Trap 04: the intended rate is 0.985 x baseline; the typed cell is a slipped decimal.
    const spec = variant.slip.mode === "spec";
    let intended = id === SLIP_LINE && spec ? roundTo2dp(line.baseline_price_inr * 0.985) : generated;
    let shown: V1Line["shown"] = id === SLIP_LINE ? roundTo2dp(variant.slip.mode === "x10" ? intended * 10 : intended / 10) : generated;
    const noise = q2noise.uniform(0.03, 0.05); // drawn for every line so the stream stays stable

    let note = lighter ? `Offered on ${LIGHTER.liner_gsm} GSM liner, BF ${LIGHTER.bf}` : "";
    if (revision === 2) {
      if (id === SLIP_LINE) shown = intended;
      if ((REV2_INCREASE_LINES as readonly string[]).includes(id)) {
        intended = roundTo2dp(intended * REV2_INCREASE);
        shown = intended;
        note = "Kraft paper price increase";
      }
    }

    let hidden: number | null = roundTo2dp((revision === 2 ? intendedRev1(id, generated, line) : intended) * (1 + noise));
    if (id === variant.notQuoted.line) {
      shown = variant.notQuoted.token;
      hidden = null;
    }
    if (id === variant.blank) {
      shown = null;
      hidden = null;
    }

    const board = lighter
      ? { ply: line.spec.ply, liner_gsm: LIGHTER.liner_gsm, bf: LIGHTER.bf }
      : { ply: line.spec.ply, liner_gsm: line.spec.liner_gsm, bf: line.spec.bf };
    const quoted = typeof shown === "number";
    return {
      line_id: id,
      shown,
      intended: quoted ? intended : null,
      hidden_q2: hidden,
      cell: rowOf ? `F${rowOf.lines.get(id)}` : `${colName(colOf(id))}${ROW.rate}`,
      board,
      note,
    };
  });

  const grand = lines.reduce((s, l) => {
    const line = RFX_LINES.find((x) => x.line_id === l.line_id) as RfxLine;
    return typeof l.shown === "number" ? s + line.annual_qty * l.shown : s;
  }, 0);
  return { revision, lines, grand_total: roundTo2dp(grand) };
}

/** Previous quarter rates stay the same across revisions: they are last quarter's, not this offer's. */
function intendedRev1(id: string, generated: number, line: RfxLine): number {
  return id === V1_TUNED.slip.line ? roundTo2dp(line.baseline_price_inr * 0.985) : generated;
}

/** Holdout layout: one line per row, groups in reverse order, each under its own title row. Header on row 4. */
function rowsLayout(style: RowsStyle): { lines: Map<string, number>; titles: Map<string, number> } {
  const lines = new Map<string, number>();
  const titles = new Map<string, number>();
  let r = 5;
  for (const g of style.reverseGroups ? [...GROUPS].reverse() : GROUPS) {
    titles.set(g.title, r++);
    const from = RFX_LINES.findIndex((l) => l.line_id === g.from);
    const to = RFX_LINES.findIndex((l) => l.line_id === g.to);
    for (const line of RFX_LINES.slice(from, to + 1)) lines.set(line.line_id, r++);
  }
  return { lines, titles };
}

function colName(n: number): string {
  let s = "";
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

export const V1_QA: [string, string, string][] = [
  ["Q01", "Valid ISO 9001 certificate for the quoting plant", "Yes - certificate attached (valid to 14-03-2027)"],
  ["Q02", "BF and GSM test report for the offered board, dated within 12 months", "Yes - test report attached"],
  ["Q03", "Supplied corrugated packaging to a consumer durables or appliance manufacturer for at least 3 years", "Yes - 8 years"],
  ["Q04", "FSC certified board available", "No"],
  ["Q05", "Monthly capacity in tonnes", "600"],
  ["Q06", "Standard lead time in days from PO", "10"],
  ["Q07", "Accept payment terms net 45 days", "Yes"],
  ["Q08", "Free samples before PO", "Yes"],
  ["Q09", "Rejection policy: replacement within how many days", "7"],
  ["Q10", "Plant location and distance to Chakan", "Chakan, Pune - 4 km"],
  ["Q11", "Price validity in days", "30"],
  ["Q12", "Any deviations from the specification", "No deviations."],
];

export async function buildV1Workbook(seed: number, revision: 1 | 2, variant: V1Variant = V1_TUNED): Promise<{ buffer: Buffer; content: V1Sheet }> {
  const content = buildV1Content(seed, revision, variant);
  if (variant.layout === "rows") return { buffer: await buildRowsWorkbook(content, variant), content };
  const wb = new ExcelJS.Workbook();
  wb.creator = "Shree Ganesh Corrugators";
  wb.created = new Date("2026-09-21T10:00:00Z");
  wb.modified = new Date(revision === 2 ? "2026-10-08T10:00:00Z" : "2026-09-21T10:00:00Z");

  const ws = wb.addWorksheet("Rates");
  ws.getCell(ROW.title, 1).value = "SHREE GANESH CORRUGATORS - RATE OFFER FY 26-27";
  ws.getCell(ROW.title, 1).font = { bold: true, size: 14 };
  const labels: [number, string][] = [
    [ROW.group, "GROUP"],
    [ROW.item, "ITEM"],
    [ROW.size, "SIZE (mm)"],
    [ROW.board, "BOARD"],
    [ROW.unit, "UNIT"],
    [ROW.rate, "RATE (Rs)"],
    [ROW.note, "REMARKS"],
    [ROW.rateQ2, "Rate Q2"],
  ];
  for (const [row, text] of labels) {
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { bold: true };
  }
  ws.getColumn(1).width = 14;

  for (const g of GROUPS) {
    const from = colOf(g.from);
    const to = colOf(g.to);
    ws.mergeCells(ROW.group, from, ROW.group, to);
    const cell = ws.getCell(ROW.group, from);
    cell.value = g.title;
    cell.font = { bold: true };
    cell.alignment = { horizontal: "center" };
  }

  RFX_LINES.forEach((line, i) => {
    const c = firstCol + i;
    const l = content.lines[i] as V1Line;
    ws.getColumn(c).width = 16;
    ws.getCell(ROW.item, c).value = vendorItemName(line);
    ws.getCell(ROW.size, c).value = line.spec.dims_text;
    ws.getCell(ROW.board, c).value = line.spec.ply === null ? "-" : `${l.board.ply}P ${line.spec.flute} ${l.board.liner_gsm}/${l.board.bf}`;
    ws.getCell(ROW.unit, c).value = UNIT_LABEL[line.base_uom];
    const rate = ws.getCell(ROW.rate, c);
    if (l.shown !== null) rate.value = l.shown;
    if (typeof l.shown === "number") rate.numFmt = "0.00";
    if (l.note) ws.getCell(ROW.note, c).value = l.note;
    if (l.hidden_q2 !== null) ws.getCell(ROW.rateQ2, c).value = l.hidden_q2;
  });
  // Trap 02: previous quarter rates sit in a hidden row (the transposed sheet's equivalent of a hidden column).
  ws.getRow(ROW.rateQ2).hidden = true;

  const summary = wb.addWorksheet("Summary");
  const terms: [string, string | number][] = [
    ["Vendor", "Shree Ganesh Corrugators, Chakan, Pune"],
    ["Offer", revision === 2 ? "REVISED RATES - please disregard earlier sheet" : "Rate offer FY 26-27"],
    ["Delivery", "Delivered, FOR Chakan plant"],
    ["GST", "Extra at 18%"],
    ["Payment", "45 days from invoice"],
    ["Validity", `30 days from ${revision === 2 ? "08-10-2026" : "21-09-2026"}`],
    ["Lead time", "10 days from PO"],
    ["Grand total (Rs)", content.grand_total],
  ];
  terms.forEach(([k, v], i) => {
    summary.getCell(i + 1, 1).value = k;
    summary.getCell(i + 1, 1).font = { bold: true };
    summary.getCell(i + 1, 2).value = v;
  });
  summary.getColumn(1).width = 20;
  summary.getColumn(2).width = 50;

  const qa = wb.addWorksheet("QA");
  qa.addRow(["Q#", "Question", "Answer"]).font = { bold: true };
  for (const row of V1_QA) qa.addRow(row);
  qa.getColumn(2).width = 80;
  qa.getColumn(3).width = 50;

  const buffer = await normalizeZip(Buffer.from(await wb.xlsx.writeBuffer()));
  return { buffer, content };
}

/** The V1 slice of ground_truth.json (spec 17.9). */
export function v1GroundTruth(content: V1Sheet, variant: V1Variant = V1_TUNED): Record<string, unknown> {
  const lines: Record<string, unknown> = {};
  const sheet = variant.layout === "rows" ? (variant.rows ?? ROWS_DEFAULT).sheet : "Rates";
  // A rate column whose header names no currency (seed 8's "Price"): the prices are taken as INR, the RFx currency,
  // INFERRED until the buyer confirms once (the rule decided for V3 L29 and L30). Corrected 2026-10-09.
  const rateHeader = variant.layout === "rows" ? (variant.rows ?? ROWS_DEFAULT).headers[5] : "RATE (Rs)";
  const noCurrency = !/\b(rs\.?|inr|rupees?)\b|₹/i.test(rateHeader);
  for (const l of content.lines) {
    const line = RFX_LINES.find((x) => x.line_id === l.line_id) as RfxLine;
    const quoted = l.intended !== null;
    const slip = l.line_id === variant.slip.line && content.revision === 1;
    lines[l.line_id] = {
      quoted,
      cell: `${sheet}!${l.cell}`,
      intended_rate: l.intended,
      rate_as_shown: l.shown,
      hidden_q2_rate: l.hidden_q2,
      unit: line.base_uom,
      currency: "INR",
      readable: true,
      spec_offered: {
        ply: l.board.ply,
        liner_gsm: l.board.liner_gsm,
        bf: l.board.bf,
        dims_mm: parseDims(line.spec.dims_text),
      },
      expected_state: !quoted ? "MISSING" : slip ? "NEEDS_REVIEW" : noCurrency ? "INFERRED" : "CONFIRMED",
      expected_flags: [
        ...(slip ? ["magnitude_slip"] : []),
        ...(quoted && !slip && noCurrency ? ["currency_assumed"] : []),
        ...(quoted ? ["hidden_value_differs"] : []),
        ...(variant.lighter.includes(l.line_id) ? ["spec_below_requirement"] : []),
      ],
      landed_unit_inr_point: quoted && !slip ? l.intended : null,
      // The value the vendor meant, for calibration: a slip cell has no expected price, but its read value is wrong.
      ...(slip ? { true_landed_point: l.intended } : {}),
    };
  }
  return {
    freight_basis: "delivered",
    gst_basis: "exclusive",
    revision: content.revision,
    coverage: `${content.lines.filter((l) => l.intended !== null).length} of 30`,
    lines,
    gates: { Q01: "PASS", Q02: "PASS", Q03: "PASS" },
    claim_vs_evidence: { Q12: { claimed: variant.qa.find(([q]) => q === "Q12")![2], contradicted_by: `lighter board on ${variant.lighter.join(", ")}` } },
    // The report's 120 GSM sample confirms the lighter board on exactly the lines offered on it.
    report_findings: { lines: [...variant.lighter], fields: ["bf", "liner_gsm"] },
    certificate: variant.certificate,
    test_report: variant.testReport,
    expected_discrepancies: [
      "hidden_value_differs",
      "spec_below_requirement",
      "claim_vs_evidence",
      "magnitude_slip",
      ...(content.revision === 2 ? ["revision_superseded"] : []),
    ],
  };
}

export const V1_TUNED: V1Variant = {
  name: "tuned",
  layout: "transposed",
  lighter: ["L01", "L02", "L03", "L05"],
  slip: { line: "L06", mode: "spec" },
  notQuoted: { line: "L20", token: "NQ" },
  blank: "L21",
  files: { ...V1_FILE_NAMES, ...V1_EVIDENCE_FILES },
  qa: V1_QA,
  certificate: V1_CERTIFICATE,
  testReport: V1_TEST_REPORT,
};

/** Holdout: rows layout, lighter board on three 3 ply lines, a tenfold slip on a 7 ply line, other words throughout. */
export const V1_HOLDOUT: V1Variant = {
  name: "holdout",
  layout: "rows",
  lighter: ["L12", "L14", "L22"],
  slip: { line: "L16", mode: "x10" },
  notQuoted: { line: "L28", token: "Not quoted" },
  blank: "L19",
  files: { 1: "SGC_Quotation_Kaveri_2026.xlsx", 2: "SGC_Quotation_Kaveri_2026_rev2.xlsx", certificate: "SGC_QMS_Certificate.pdf", testReport: "SGC_Lab_Report_BF_GSM.pdf" },
  qa: [
    ["Q01", "ISO 9001 certificate (quoting plant)", "Yes, copy enclosed"],
    ["Q02", "Board test report (BF, GSM), last 12 months", "Yes, enclosed"],
    ["Q03", "3+ years supply to appliance / durables makers", "Yes, since 2017"],
    ["Q04", "FSC board", "No"],
    ["Q05", "Capacity (MT per month)", "650"],
    ["Q06", "Lead time (days)", "8 to 10"],
    ["Q07", "Net 45 days payment acceptable", "Yes"],
    ["Q08", "Free samples", "Yes"],
    ["Q09", "Replacement of rejected lots (days)", "5"],
    ["Q10", "Plant and distance to Chakan", "Chakan MIDC, 3 km"],
    ["Q11", "Validity of rates (days)", "30"],
    ["Q12", "Deviations from RFx specification", "Nil"],
  ],
  certificate: {
    cert_type: "ISO 9001:2015",
    number: "IQA/QMS/2025/0291",
    issuer: "Indus Quality Assurance Services (fictional)",
    entity: "Shree Ganesh Corrugators, Plot B-14, Chakan MIDC, Pune",
    scope: "Design and manufacture of corrugated boxes, sheets and partitions",
    valid_from: "2025-02-01",
    valid_to: "2028-01-31",
  },
  testReport: {
    lab: "Sahyadri Board Testing Laboratory (fictional)",
    report_no: "SBTL/26/1140",
    report_date: "2026-07-22",
    samples: [
      { ply: 3, flute: "B", liner_gsm: 120, bf: 16.4 },
      { ply: 3, flute: "B", liner_gsm: 150, bf: 18.9 },
      { ply: 5, flute: "BC", liner_gsm: 150, bf: 18.6 },
      { ply: 5, flute: "BC", liner_gsm: 180, bf: 22.7 },
      { ply: 7, flute: "BCB", liner_gsm: 200, bf: 24.9 },
    ],
  },
};

/** The holdout workbook: one line per row, a hidden "Last Qtr Rate" column, terms and questionnaire on their own sheets. */
async function buildRowsWorkbook(content: V1Sheet, variant: V1Variant): Promise<Buffer> {
  const style = variant.rows ?? ROWS_DEFAULT;
  const wb = new ExcelJS.Workbook();
  wb.creator = "SGC Sales";
  wb.created = new Date("2026-09-21T10:00:00Z");
  wb.modified = new Date("2026-09-21T10:00:00Z");
  const ws = wb.addWorksheet(style.sheet);
  ws.getCell("A1").value = "Shree Ganesh Corrugators";
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = style.subtitle;
  style.headers.forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value = h;
    c.font = { bold: true };
  });
  const layout = rowsLayout(style);
  let r = 5;
  let sr = 1;
  for (const g of style.reverseGroups ? [...GROUPS].reverse() : GROUPS) {
    const t = layout.titles.get(g.title) as number;
    ws.mergeCells(t, 1, t, 8);
    ws.getCell(t, 1).value = g.title;
    ws.getCell(t, 1).font = { bold: true };
    const from = RFX_LINES.findIndex((l) => l.line_id === g.from);
    const to = RFX_LINES.findIndex((l) => l.line_id === g.to);
    for (const line of RFX_LINES.slice(from, to + 1)) {
      r = layout.lines.get(line.line_id) as number;
      const l = content.lines.find((x) => x.line_id === line.line_id) as V1Line;
      ws.getCell(r, 1).value = sr++;
      ws.getCell(r, 2).value = vendorItemName(line);
      ws.getCell(r, 3).value = line.spec.dims_text;
      ws.getCell(r, 4).value = line.spec.ply === null ? "-" : `${l.board.ply} ply ${line.spec.flute} ${l.board.liner_gsm} GSM BF ${l.board.bf}`;
      ws.getCell(r, 5).value = UNIT_LABEL[line.base_uom];
      if (l.shown !== null) ws.getCell(r, 6).value = l.shown;
      if (typeof l.shown === "number") ws.getCell(r, 6).numFmt = "#,##0.00";
      if (l.hidden_q2 !== null) ws.getCell(r, 7).value = l.hidden_q2;
      if (l.note) ws.getCell(r, 8).value = l.note.replace("Offered on", style.noteWord);
    }
  }
  // Trap 02 in the holdouts: previous quarter rates in a hidden column.
  ws.getColumn(7).hidden = true;
  ws.getColumn(2).width = 40;
  ws.getCell(r + 2, 5).value = style.totalLabel;
  ws.getCell(r + 2, 6).value = content.grand_total;

  const terms = wb.addWorksheet(style.termsSheet);
  style.terms.forEach(([k, v], i) => {
    terms.getCell(i + 1, 1).value = k;
    terms.getCell(i + 1, 2).value = v;
  });
  terms.getColumn(2).width = 60;

  const qa = wb.addWorksheet(style.qaSheet);
  qa.addRow(["No.", "Question", "Reply"]).font = { bold: true };
  for (const row of variant.qa) qa.addRow(row);
  qa.getColumn(2).width = 60;
  return normalizeZip(Buffer.from(await wb.xlsx.writeBuffer()));
}

/** V1's entries in the trap register (spec 17.6), with what the eval needs to check each one. */
export function v1Traps(variant: V1Variant, content: V1Sheet): Record<string, Record<string, unknown>> {
  const slip = content.lines.find((l) => l.line_id === variant.slip.line) as V1Line;
  const tuned = variant.name === "tuned";
  return {
    "01": { vendor: "V1", what: tuned ? "transposed layout, merged group headers, Summary sheet" : `one line per row${(variant.rows ?? ROWS_DEFAULT).reverseGroups ? ", groups reversed" : ""} under title rows, terms on their own sheet` },
    "02": { vendor: "V1", what: tuned ? "hidden row 'Rate Q2' with previous quarter rates 3 to 5 percent higher" : `hidden column '${(variant.rows ?? ROWS_DEFAULT).headers[6]}' with previous quarter rates 3 to 5 percent higher` },
    "03": { vendor: "V1", lines: [...variant.lighter], what: `120 GSM / BF 16 offered; Q12 says ${variant.qa.find(([q]) => q === "Q12")![2]}` },
    "04": { vendor: "V1", line: variant.slip.line, intended: slip.intended, shown: slip.shown },
    ...(tuned ? { "05": { vendor: "V1", what: "revision 2 with L06 corrected and L04, L15, L16, L17 up 3 percent" } } : {}),
    "35": { vendor: "V1", lines: { [variant.notQuoted.line]: variant.notQuoted.token, [variant.blank]: "blank" } },
  };
}

/** Fresh holdout (seed 8): RFx group order, other headings, lighter board on two 5 ply lines, a tenth slip on a kg line. */
export const V1_HOLDOUT2: V1Variant = {
  name: "holdout",
  layout: "rows",
  rows: {
    sheet: "Price List",
    reverseGroups: false,
    headers: ["#", "Product", "Dimensions", "Board spec", "Unit", "Price", "Prev. Price", "Note"],
    subtitle: "Price list for Kaveri Home Appliances, Chakan (your RFx KHA-PKG-FY26-27)",
    noteWord: "Made in",
    terms: [
      ["Delivery terms", "FOR Kaveri Chakan; our vehicle"],
      ["GST", "Extra, 18 percent"],
      ["Credit", "45 days from GRN"],
      ["Price validity", "One month from 21-09-2026"],
      ["Lead time", "7 working days"],
    ],
    termsSheet: "Commercials",
    qaSheet: "Vendor Q&A",
    totalLabel: "Annual value Rs",
  },
  lighter: ["L03", "L20"],
  slip: { line: "L23", mode: "div10" },
  notQuoted: { line: "L27", token: "N/A" },
  blank: "L13",
  files: { 1: "Shree_Ganesh_Price_List_KHA.xlsx", 2: "Shree_Ganesh_Price_List_KHA_r2.xlsx", certificate: "Shree_Ganesh_ISO.pdf", testReport: "Shree_Ganesh_Board_Tests.pdf" },
  qa: [
    ["Q01", "ISO 9001 for the plant quoting", "Yes. Certificate copy sent with this mail"],
    ["Q02", "BF and GSM test report (12 months)", "Yes, sent"],
    ["Q03", "Three years supplying appliance companies", "Yes, 9 years"],
    ["Q04", "FSC board available", "No"],
    ["Q05", "Tonnes per month", "600"],
    ["Q06", "Lead time from PO, days", "7"],
    ["Q07", "Can you accept net 45", "Yes"],
    ["Q08", "Free samples", "Yes"],
    ["Q09", "Replacement within (days)", "7"],
    ["Q10", "Plant and distance", "Chakan, 5 km"],
    ["Q11", "Validity (days)", "30"],
    ["Q12", "Any deviation from the RFx specs", "No deviation from specs"],
  ],
  certificate: {
    cert_type: "ISO 9001:2015",
    number: "IQA/QMS/2023/0957",
    issuer: "Indus Quality Assurance Services (fictional)",
    entity: "Shree Ganesh Corrugators, Chakan, Pune",
    scope: "Manufacture of corrugated boxes and board",
    valid_from: "2023-11-20",
    valid_to: "2026-11-19",
  },
  testReport: {
    lab: "Pune Packaging Test Laboratory (fictional)",
    report_no: "PPTL/26/0388",
    report_date: "2026-08-05",
    samples: [
      { ply: 3, flute: "B", liner_gsm: 120, bf: 16.5 },
      { ply: 3, flute: "B", liner_gsm: 150, bf: 18.4 },
      { ply: 5, flute: "BC", liner_gsm: 120, bf: 16.2 },
      { ply: 5, flute: "BC", liner_gsm: 150, bf: 18.5 },
      { ply: 5, flute: "BC", liner_gsm: 180, bf: 22.3 },
      { ply: 7, flute: "BCB", liner_gsm: 200, bf: 24.6 },
    ],
  },
};
