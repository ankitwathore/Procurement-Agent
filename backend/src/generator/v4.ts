import sharp from "sharp";
import { generateVendorRates, roundTo2dp } from "../data/prices.js";
import { createRng } from "../data/rng.js";
import { RFX_HEADER, RFX_LINES } from "../data/rfx.js";
import { parseDims } from "../ingest/checks.js";
import type { RfxLine } from "../schemas.js";
import { drawPhotoParams, handwritten, photograph, regionOf, type PhotoParams } from "./photo.js";
import { rfc2822 } from "./v5.js";

/**
 * V4: Delhi Carton Works, Bahadurgarh. A phone photo of a printed rate card, sent by email, ex works (spec 17.5).
 * Traps: 20 (the photo itself), 21 (7 ply lines not on the card), 22 (glare and blur over two rows),
 * 23 (a printed rate struck through with a handwritten correction), 24 (three cartons in smaller sizes, priced lower),
 * 25 (one line "per box" with no count), 26 (questionnaire in the email; a test report claimed, not attached),
 * 27 (late reply, validity ending before the award date), 28 (cheapest headline, most expensive landed).
 */

export const V4_SEED_OFFSET = 4;
const FREIGHT_PER_KG = 7.8; // Bahadurgarh lane (config)
const FREIGHT_BAND = 0.1;
const SMALLER_FACTOR = 0.94;

export interface V4Variant {
  name: "tuned" | "holdout";
  files: { email: string; photo: string; certificate: string; params: string };
  notQuoted: string[];
  unreadable: string[];
  overwritten: { line: string; printed: number; handwritten: number };
  smaller: Record<string, string>;
  perBox: { line: string; rate: number; count: number };
  received: { date: string; time: string };
  validity: { from: string; days: number };
  qa: [string, string, string][];
  certificate: { number: string; valid_from: string; valid_to: string };
  photo?: { rotation: [number, number]; corners: [number, number]; blur: [number, number] };
}

export const V4_TUNED: V4Variant = {
  name: "tuned",
  files: { email: "Rates_Delhi_Carton_Works.eml", photo: "IMG_20260924_101533.jpg", certificate: "ISO_certificate_DCW.jpg", params: "photo_params.json" },
  notQuoted: ["L15", "L16", "L17"],
  unreadable: ["L12", "L22"],
  overwritten: { line: "L04", printed: 65.9, handwritten: 68.5 },
  smaller: { L01: "420x320x300", L03: "345x325x365", L05: "430x220x460" },
  perBox: { line: "L27", rate: 2400, count: 72 },
  received: { date: "2026-09-24", time: "10:20:00" },
  validity: { from: "2026-09-24", days: 15 },
  qa: [
    ["Q01", "ISO 9001 certificate", "Yes, certificate attached"],
    ["Q02", "BF and GSM test report", "Yes, attached"],
    ["Q03", "3 years with appliance makers", "Yes, 6 years"],
    ["Q04", "FSC board", "No"],
    ["Q05", "Monthly capacity, tonnes", "500"],
    ["Q06", "Lead time, days", "15"],
    ["Q07", "Net 45 days", "Yes"],
    ["Q08", "Free samples", "Yes"],
    ["Q09", "Replacement within days", "7"],
    ["Q10", "Plant and distance to Chakan", "Bahadurgarh, about 1,450 km"],
    ["Q11", "Price validity, days", "15"],
    ["Q12", "Deviations from specification", "None"],
  ],
  certificate: { number: "BQC/QMS/24/7712", valid_from: "2024-01-11", valid_to: "2027-01-10" },
};

const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("-");
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const UNIT: Record<RfxLine["base_uom"], string> = { piece: "pc", set: "set", pair: "pair", kg: "kg", roll: "roll" };

/** V4's own names: "M/C" for master carton, "Box" for inner and outer. */
export function v4Name(line: RfxLine): string {
  return line.description.replace(/master carton/i, "M/C").replace(/inner carton/i, "Inner Box").replace(/outer carton/i, "Outer Box");
}

export interface V4Row {
  line_id: string;
  serial: number;
  /** The rate the vendor meant, per the unit it wrote. */
  intended: number;
  /** What is printed in the rate cell. */
  printed: number;
  unit: string;
  size: string;
  /** Rate per base unit, when the card gives enough to know it. */
  per_base: number;
}

export function buildV4Content(seed: number, variant: V4Variant = V4_TUNED): V4Row[] {
  const overrides = Object.fromEntries(Object.keys(variant.smaller).map((id) => [id, 0.88 * SMALLER_FACTOR]));
  const rates = generateVendorRates("V4", RFX_LINES, createRng(seed + V4_SEED_OFFSET), overrides);
  const rows: V4Row[] = [];
  for (const line of RFX_LINES) {
    if (variant.notQuoted.includes(line.line_id)) continue;
    const r = rates.get(line.line_id) as number;
    const ow = variant.overwritten.line === line.line_id;
    const box = variant.perBox.line === line.line_id;
    rows.push({
      line_id: line.line_id,
      serial: rows.length + 1,
      intended: ow ? variant.overwritten.handwritten : box ? variant.perBox.rate : r,
      printed: ow ? variant.overwritten.printed : box ? variant.perBox.rate : r,
      unit: box ? "box" : UNIT[line.base_uom],
      size: variant.smaller[line.line_id] ?? line.spec.dims_text,
      per_base: ow ? variant.overwritten.handwritten : box ? roundTo2dp(variant.perBox.rate / variant.perBox.count) : r,
    });
  }
  return rows;
}

// Card geometry, in pixels at about 200 dpi.
const CARD_W = 1400;
const ROW_H = 50;
const TABLE_TOP = 330;
const COLS = { sno: 70, item: 130, size: 700, board: 925, rate: 1125, per: 1265, end: 1335 } as const;

const rowY = (i: number) => TABLE_TOP + ROW_H * (i + 1);

function cardSvg(rows: V4Row[], variant: V4Variant, rng: ReturnType<typeof createRng>): { svg: string; height: number } {
  const height = rowY(rows.length) + 150;
  const until = ddmmyyyy(variant.validity.from);
  const t: string[] = [];
  const text = (x: number, y: number, s: string, o: { size?: number; weight?: string; anchor?: string } = {}) =>
    t.push(`<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${o.size ?? 24}" font-weight="${o.weight ?? "normal"}" text-anchor="${o.anchor ?? "start"}" fill="#1b1b1b">${esc(s)}</text>`);
  text(CARD_W / 2, 90, "DELHI CARTON WORKS", { size: 46, weight: "bold", anchor: "middle" });
  text(CARD_W / 2, 132, "Plot 18, HSIIDC Industrial Area, Bahadurgarh, Haryana", { size: 22, anchor: "middle" });
  text(CARD_W / 2, 190, "RATE CARD FOR KAVERI HOME APPLIANCES", { size: 28, weight: "bold", anchor: "middle" });
  text(CARD_W / 2, 236, `EX WORKS BAHADURGARH, GST EXTRA 18 PERCENT, RATES VALID ${variant.validity.days} DAYS FROM ${until}`, { size: 22, anchor: "middle" });
  t.push(`<line x1="${COLS.sno - 10}" y1="${TABLE_TOP - 38}" x2="${COLS.end}" y2="${TABLE_TOP - 38}" stroke="#333" stroke-width="2"/>`);
  const head = TABLE_TOP;
  text(COLS.sno, head, "No", { weight: "bold" });
  text(COLS.item, head, "Item", { weight: "bold" });
  text(COLS.size, head, "Size mm", { weight: "bold" });
  text(COLS.board, head, "Board", { weight: "bold" });
  text(COLS.rate + 125, head, "Rate Rs", { weight: "bold", anchor: "end" });
  text(COLS.per, head, "Per", { weight: "bold" });
  t.push(`<line x1="${COLS.sno - 10}" y1="${head + 14}" x2="${COLS.end}" y2="${head + 14}" stroke="#333" stroke-width="2"/>`);
  rows.forEach((r, i) => {
    const line = RFX_LINES.find((l) => l.line_id === r.line_id) as RfxLine;
    const y = rowY(i);
    text(COLS.sno, y, String(r.serial));
    text(COLS.item, y, v4Name(line), { size: line.description.length > 36 ? 20 : 22 });
    text(COLS.size, y, r.size, { size: 22 });
    text(COLS.board, y, line.spec.ply === null ? "-" : `${line.spec.ply}P ${line.spec.flute} ${line.spec.liner_gsm}/${line.spec.bf}`, { size: 22 });
    text(COLS.rate + 125, y, money(r.printed), { anchor: "end" });
    text(COLS.per, y, r.unit, { size: 22 });
    t.push(`<line x1="${COLS.sno - 10}" y1="${y + 14}" x2="${COLS.end}" y2="${y + 14}" stroke="#bbb" stroke-width="1"/>`);
    if (r.line_id === variant.overwritten.line) {
      // Trap 23: a pen stroke through the printed rate, the correction written beside it.
      t.push(`<line x1="${COLS.rate + 10}" y1="${y - 8}" x2="${COLS.rate + 130}" y2="${y - 6}" stroke="#1f3fa8" stroke-width="3"/>`);
      // In the gap between this row's printed rate and the row above, so the row above stays readable.
      t.push(handwritten(money(r.intended), COLS.rate + 28, y - 43, 22, rng));
    }
  });
  text(COLS.sno, height - 80, "For Delhi Carton Works", { size: 22 });
  text(COLS.sno, height - 48, "R. K. Gupta, Proprietor", { size: 22 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}"><rect width="100%" height="100%" fill="#fbfaf5"/>${t.join("")}</svg>`;
  return { svg, height };
}

/** Rows the photo must leave unreadable: blur the size-to-unit cells hard, then a soft glare ellipse over them. */
async function obscure(raw: Buffer, height: number, rows: V4Row[], variant: V4Variant): Promise<Buffer> {
  const out = Buffer.from(raw);
  const glare: string[] = [];
  for (const id of variant.unreadable) {
    const i = rows.findIndex((r) => r.line_id === id);
    if (i < 0) continue;
    const top = rowY(i) - 34;
    const rect = { left: COLS.size - 10, top, width: COLS.end - COLS.size + 10, height: 48 };
    const patch = await sharp(raw, { raw: { width: CARD_W, height, channels: 3 } }).extract(rect).blur(9).raw().toBuffer();
    for (let y = 0; y < rect.height; y++) patch.copy(out, ((rect.top + y) * CARD_W + rect.left) * 3, y * rect.width * 3, (y + 1) * rect.width * 3);
    glare.push(`<ellipse cx="${COLS.board + 150}" cy="${top + 24}" rx="380" ry="46" fill="white" fill-opacity="0.85" filter="url(#g)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}"><defs><filter id="g" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="16"/></filter></defs>${glare.join("")}</svg>`;
  return sharp(out, { raw: { width: CARD_W, height, channels: 3 } }).composite([{ input: Buffer.from(svg), blend: "over" }]).removeAlpha().raw().toBuffer();
}

export interface V4Photo {
  jpeg: Buffer;
  params: PhotoParams;
  /** Where each row and its rate cell land in the photo, as normalized [x0, y0, x1, y1] boxes. */
  regions: Record<string, { row: [number, number, number, number]; rate: [number, number, number, number] }>;
}

export async function buildV4Photo(seed: number, variant: V4Variant = V4_TUNED): Promise<{ photo: V4Photo; rows: V4Row[] }> {
  const rows = buildV4Content(seed, variant);
  const rng = createRng(seed + V4_SEED_OFFSET + 400);
  const { svg, height } = cardSvg(rows, variant, rng);
  const raw = await sharp(Buffer.from(svg)).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer();
  const card = await obscure(raw, height, rows, variant);
  const params = drawPhotoParams(rng, variant.photo);
  const p = await photograph({ data: card, width: CARD_W, height }, params, rng);
  const regions: V4Photo["regions"] = {};
  rows.forEach((r, i) => {
    const y = rowY(i) - 34;
    regions[r.line_id] = { row: regionOf(p, { x: COLS.sno - 10, y, w: COLS.end - COLS.sno + 10, h: 48 }), rate: regionOf(p, { x: COLS.rate, y, w: 135, h: 48 }) };
  });
  return { photo: { jpeg: p.jpeg, params, regions }, rows };
}

/** The certificate, photographed less harshly than the rate card. */
export async function buildV4CertificatePhoto(seed: number, variant: V4Variant = V4_TUNED): Promise<Buffer> {
  const c = variant.certificate;
  const lines = [
    ["CERTIFICATE OF REGISTRATION", 46, "bold"],
    ["This is to certify that the quality management system of", 24, "normal"],
    ["Delhi Carton Works, Plot 18, HSIIDC Industrial Area, Bahadurgarh", 26, "bold"],
    ["has been assessed and found to conform to ISO 9001:2015", 24, "normal"],
    ["Scope: Manufacture of corrugated boxes and board", 24, "normal"],
    [`Certificate No: ${c.number}`, 24, "normal"],
    [`Valid from: ${ddmmyyyy(c.valid_from)}    Valid until: ${ddmmyyyy(c.valid_to)}`, 24, "normal"],
    ["Issued by: Bharat Quality Certification Pvt Ltd (fictional)", 22, "normal"],
  ] as const;
  const W = 1300;
  const H = 900;
  const t = lines.map(([s, size, weight], i) => `<text x="${W / 2}" y="${150 + i * 85}" font-family="Times New Roman, Georgia, serif" font-size="${size}" font-weight="${weight}" text-anchor="middle" fill="#202020">${esc(s)}</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fffdf6"/><rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="#8a6d2f" stroke-width="6"/>${t.join("")}</svg>`;
  const raw = await sharp(Buffer.from(svg)).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer();
  const rng = createRng(seed + V4_SEED_OFFSET + 500);
  const params = drawPhotoParams(rng, { rotation: [1.5, 3], corners: [0.02, 0.04], blur: [0.7, 0.9] });
  return (await photograph({ data: raw, width: W, height: H }, params, rng)).jpeg;
}

/** The email: questionnaire answers typed in the body (trap 26), the rate card and certificate photos attached. */
export function buildV4Eml(photo: Buffer, certificate: Buffer, variant: V4Variant = V4_TUNED): string {
  const boundary = "----=_DCW_20260924_boundary";
  const b64 = (b: Buffer) => b.toString("base64").replace(/(.{76})/g, "$1\r\n");
  const body = [
    "Dear Madam,",
    "",
    `Please find attached our rate card for your RFx ${RFX_HEADER.rfx_id}. Our ISO certificate is also attached.`,
    "",
    "Questionnaire replies:",
    ...variant.qa.map(([q, text, a]) => `${q} ${text}: ${a}`),
    "",
    "Regards,",
    "R. K. Gupta",
    "Delhi Carton Works, Bahadurgarh",
  ];
  return [
    "From: R. K. Gupta <dcw.bahadurgarh@example.com>",
    "To: Meera Kulkarni <meera.k@kaverihome.example>",
    `Subject: Rate card - Delhi Carton Works - ${RFX_HEADER.rfx_id}`,
    `Date: ${rfc2822(variant.received.date, variant.received.time, "+0530")}`,
    `Message-ID: <dcw-${variant.received.date}@example.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    ...body,
    "",
    `--${boundary}`,
    `Content-Type: image/jpeg; name="${variant.files.photo}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${variant.files.photo}"`,
    "",
    b64(photo),
    `--${boundary}`,
    `Content-Type: image/jpeg; name="${variant.files.certificate}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${variant.files.certificate}"`,
    "",
    b64(certificate),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** The V4 slice of ground_truth.json, from the spec's rules, independently of the app. */
export function v4GroundTruth(rows: V4Row[], photo: V4Photo, variant: V4Variant = V4_TUNED): Record<string, unknown> {
  const lines: Record<string, unknown> = {};
  for (const line of RFX_LINES) {
    const row = rows.find((r) => r.line_id === line.line_id);
    if (!row) {
      lines[line.line_id] = { quoted: false, expected_state: "MISSING", expected_flags: [], landed_unit_inr_point: null };
      continue;
    }
    const freight = FREIGHT_PER_KG * line.weight_kg_per_uom;
    const unreadable = variant.unreadable.includes(line.line_id);
    const struck = variant.overwritten.line === line.line_id;
    const box = variant.perBox.line === line.line_id;
    const review = unreadable || struck || box;
    const smaller = variant.smaller[line.line_id];
    lines[line.line_id] = {
      quoted: true,
      serial: row.serial,
      rate_as_printed: row.printed,
      ...(struck ? { rate_handwritten: variant.overwritten.handwritten } : {}),
      unit_as_written: row.unit,
      ...(box ? { units_per_box: variant.perBox.count, note: "the count is not on the card; the system must not assume it" } : {}),
      intended_rate_per_base_inr: row.per_base,
      readable: !unreadable,
      currency: "INR",
      region: photo.regions[line.line_id],
      ...(smaller ? { size_offered: smaller, spec_offered: { dims_mm: parseDims(smaller) } } : {}),
      // A rate read from a photo is HIGH_CONF at best (rule 8); the landed cell is INFERRED because freight is ex works.
      base_state: review ? "NEEDS_REVIEW" : "HIGH_CONF",
      expected_state: review ? "NEEDS_REVIEW" : "INFERRED",
      expected_flags: smaller ? ["spec_dimension_off"] : [],
      landed_unit_inr_point: review ? null : r4(row.per_base + freight),
      ...(review ? { true_landed_point: r4(row.per_base + freight) } : {}),
      landed_low: review ? null : r4(row.per_base + freight * (1 - FREIGHT_BAND)),
      landed_high: review ? null : r4(row.per_base + freight * (1 + FREIGHT_BAND)),
    };
  }
  const until = addDays(variant.validity.from, variant.validity.days);
  return {
    freight_basis: "ex_works",
    gst_basis: "exclusive",
    received: variant.received.date,
    late: variant.received.date > RFX_HEADER.due_date,
    validity_until: until,
    validity: "expiring",
    coverage: `${rows.length} of 30`,
    lines,
    gates: { Q01: "PASS", Q02: "FAIL", Q03: "PASS" },
    claim_vs_evidence: { Q12: { claimed: variant.qa[11]![2], contradicted_by: `smaller sizes on ${Object.keys(variant.smaller).join(", ")}` } },
    attachments: { photo: variant.files.photo, certificate: variant.files.certificate, test_report: null },
    certificate: { cert_type: "ISO 9001:2015", entity: "Delhi Carton Works, Plot 18, HSIIDC Industrial Area, Bahadurgarh", ...variant.certificate },
    expected_discrepancies: ["late_reply", "validity_expiring", "claim_without_evidence", "spec_dimension_off", "unreadable_region", "overwritten_value", "per_box_no_count", "claim_vs_evidence"],
    photo_params: photo.params,
  };
}

/** V4's entries in the trap register (spec 17.6). */
export function v4Traps(variant: V4Variant): Record<string, Record<string, unknown>> {
  return {
    "20": { vendor: "V4", what: "phone photo: perspective, rotation, uneven light, blur, JPEG 70, bottom cropped" },
    "21": { vendor: "V4", lines: [...variant.notQuoted], what: `${variant.notQuoted.join(", ")} not on the card` },
    "22": { vendor: "V4", lines: [...variant.unreadable], what: "glare and blur over these rows: review with the crop, not missing" },
    "23": { vendor: "V4", line: variant.overwritten.line, intended: variant.overwritten.handwritten, shown: variant.overwritten.printed, what: "printed rate struck through, handwritten correction beside it" },
    "24": { vendor: "V4", lines: Object.keys(variant.smaller), what: "smaller dimensions, priced lower" },
    "25": { vendor: "V4", line: variant.perBox.line, what: `Rs ${variant.perBox.rate} per box with no count (truly ${variant.perBox.count})` },
    "26": { vendor: "V4", question: "Q02", what: "answers in the email body; test report claimed but not attached" },
    "27": { vendor: "V4", what: `received ${variant.received.date} after the deadline; validity ends ${addDays(variant.validity.from, variant.validity.days)}` },
    "28": { vendor: "V4", what: "lowest headline rates; most expensive once Bahadurgarh freight is added" },
  };
}

/** Holdout (seed 7): the accessories missing, other unreadable and overwritten rows, a box of edge boards. */
export const V4_HOLDOUT: V4Variant = {
  name: "holdout",
  files: { email: "DCW rate card Kaveri.eml", photo: "WhatsApp Image 2026-09-25 at 09.12.44.jpeg", certificate: "DCW ISO.jpeg", params: "photo_params.json" },
  notQuoted: ["L26", "L27", "L28"],
  unreadable: ["L07", "L24"],
  overwritten: { line: "L09", printed: 6.4, handwritten: 6.85 },
  smaller: { L02: "390x350x135", L06: "545x420x840" },
  perBox: { line: "L30", rate: 1500, count: 100 },
  received: { date: "2026-09-25", time: "09:15:00" },
  validity: { from: "2026-09-25", days: 14 },
  qa: [
    ["Q01", "ISO 9001", "Yes, copy attached"],
    ["Q02", "Test report (BF/GSM)", "Yes, sent with this mail"],
    ["Q03", "Appliance customers 3+ years", "Yes, since 2019"],
    ["Q04", "FSC", "No"],
    ["Q05", "Capacity", "450 tonnes per month"],
    ["Q06", "Lead time", "12 days"],
    ["Q07", "45 days credit", "Yes"],
    ["Q08", "Samples", "Yes"],
    ["Q09", "Replacement", "10 days"],
    ["Q10", "Location", "Bahadurgarh, 1,450 km"],
    ["Q11", "Validity", "14 days"],
    ["Q12", "Deviations", "Nil"],
  ],
  certificate: { number: "BQC/QMS/25/0318", valid_from: "2025-03-01", valid_to: "2028-02-28" },
  photo: { rotation: [2.5, 4], corners: [0.04, 0.07], blur: [1.1, 1.5] },
};

/** Fresh holdout (seed 8): the sheets and rolls missing, a pad pair overwritten, a box of corner protectors. */
export const V4_HOLDOUT2: V4Variant = {
  name: "holdout",
  files: { email: "Delhi Carton Works quotation.eml", photo: "20260924_194012.jpg", certificate: "iso-dcw.jpg", params: "photo_params.json" },
  notQuoted: ["L23", "L24", "L25"],
  unreadable: ["L05", "L16"],
  overwritten: { line: "L20", printed: 27.1, handwritten: 29.4 },
  smaller: { L07: "370x370x505", L08: "545x470x360" },
  perBox: { line: "L28", rate: 1800, count: 120 },
  received: { date: "2026-09-24", time: "19:40:00" },
  validity: { from: "2026-09-24", days: 15 },
  qa: [
    ["Q01", "ISO 9001 certificate", "Yes (attached)"],
    ["Q02", "BF/GSM test report", "Yes, attached"],
    ["Q03", "Experience with appliance OEMs", "Yes, 7 years"],
    ["Q04", "FSC", "No"],
    ["Q05", "Capacity", "520 MT/month"],
    ["Q06", "Lead time", "14 days"],
    ["Q07", "Net 45", "Yes"],
    ["Q08", "Free samples", "Yes"],
    ["Q09", "Replacement", "7 days"],
    ["Q10", "Plant", "Bahadurgarh (approx 1,450 km)"],
    ["Q11", "Validity", "15 days"],
    ["Q12", "Deviations", "No deviations"],
  ],
  certificate: { number: "BQC/QMS/23/5561", valid_from: "2023-12-05", valid_to: "2026-12-04" },
  photo: { rotation: [4.5, 6.5], corners: [0.06, 0.09], blur: [0.9, 1.3] },
};
