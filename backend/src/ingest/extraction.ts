import { z } from "zod";
import { parseNumber } from "../normalize/parse.js";
import { docxParagraph, docxRow, type ParsedDocx } from "./parse_docx.js";
import { normalizePdfText, pdfPageText, type ParsedPdf } from "./parse_pdf.js";
import { lookupCell, type ParsedWorkbook } from "./parse_xlsx.js";

/**
 * The contract the LLM extraction passes must satisfy (subset of spec 11.1).
 * Everything the model reports is untrusted until it passes validateRows.
 */

const Locator = z.looseObject({ type: z.string() });

export const RowSchema = z.object({
  row_id: z.string(),
  raw_text: z.string(),
  mapped_line_candidates: z
    .array(
      z.object({
        line_id: z.string(),
        match_confidence: z.number().min(0).max(1),
        reasons: z.array(z.string()),
      }),
    )
    .min(1),
  rate: z.object({
    value: z.number().nullable(),
    currency: z.string(),
    unit_as_written: z.string().nullable(),
    basis_note: z.string().default(""),
  }),
  /** What the vendor says it is offering. Absent fields were not stated. */
  spec_offered: z
    .object({
      ply: z.number().nullable().optional(),
      liner_gsm: z.number().nullable().optional(),
      bf: z.number().nullable().optional(),
      dims_mm: z.array(z.number()).nullable().optional(),
      print: z.string().nullable().optional(),
    })
    .nullable()
    .default(null),
  /** The vendor's own total for this line, as written. Assumed to be at the RFx annual quantity. */
  line_total_as_written: z.number().nullable().default(null),
  struck_out_or_overwritten: z.boolean().default(false),
  /** Fields not written next to this value but carried over from the same sentence ("Rs 42/kg ..., 38 for ..."). */
  carried_over: z.array(z.enum(["unit", "currency"])).default([]),
  legibility: z.number().min(0).max(1).default(1),
  locator: Locator,
  snippet: z.string(),
  assumptions: z.array(z.string()).default([]),
});
export type Row = z.infer<typeof RowSchema>;

const TermBase = { snippet: z.string(), locator: Locator };

export const ExtractionSchema = z.object({
  vendor_terms: z.object({
    freight_basis: z
      .object({ value: z.enum(["ex_works", "delivered", "freight_extra", "unstated"]), ...TermBase })
      .optional(),
    gst_basis: z
      .object({ value: z.enum(["inclusive", "exclusive", "unstated"]), rate_pct: z.number().optional(), ...TermBase })
      .optional(),
    fx_clause: z.object({ value_text: z.string(), ...TermBase }).optional(),
    conditional_discounts: z
      .array(
        z.object({
          pct: z.number(),
          condition_text: z.string(),
          threshold_text: z.string(),
          threshold_inclusive: z.boolean().default(true),
          ...TermBase,
        }),
      )
      .optional(),
    validity: z
      .object({
        value_text: z.string(),
        /** Either an explicit date, or a start date plus days. Code does the date arithmetic. */
        valid_until: z.string().nullable().optional(),
        from_date: z.string().nullable().optional(),
        valid_days: z.number().int().nonnegative().optional(),
        ...TermBase,
      })
      .optional(),
    lines_not_quoted_statement: z
      .object({
        value_text: z.string(),
        applies_to: z.string(),
        /** The model's reading of what the statement means. Code, not the model, applies it. */
        resolves_to: z.enum(["baseline", "other"]).default("other"),
        ...TermBase,
      })
      .optional(),
  }),
  rows: z.array(RowSchema),
  /** Offers the RFx did not ask for, such as an alternate board. Listed for the buyer, never compared (spec G03). */
  extras: z
    .array(
      z.object({
        description: z.string(),
        rate: z.object({ value: z.number().nullable(), currency: z.string(), unit_as_written: z.string().nullable() }),
        related_line_id: z.string().nullable().default(null),
        snippet: z.string(),
        locator: Locator,
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface RejectedRow {
  row_id: string;
  reason: string;
}

export function topCandidate(row: Row): string {
  const best = row.mapped_line_candidates.reduce((a, b) => (b.match_confidence > a.match_confidence ? b : a));
  return best.line_id;
}

/**
 * For email locators, the snippet must be exactly the text at [char_start, char_end), and it must sit in the
 * vendor's new message, not in quoted history (spec F11).
 */
function checkEmailSpan(locator: Record<string, unknown>, snippet: string, source: ProvenanceSource): string | null {
  if (locator.type !== "email") return null;
  const { char_start: start, char_end: end } = locator;
  if (typeof start !== "number" || typeof end !== "number") return "email locator has no character span";
  if (source.text.slice(start, end) !== snippet) return "snippet does not match the source text at the stated span";
  if (source.authoritativeEnd !== undefined && end > source.authoritativeEnd) {
    return "snippet is in quoted history, not the vendor's new message";
  }
  return null;
}

/**
 * For xlsx locators, the cell must exist, the snippet must be its text, and a numeric cell must equal the rate.
 * A snippet that quotes the whole row is accepted when it holds this cell's own "F33=38.51" entry as the parser
 * renders it; the stored snippet is then trimmed to the cell's text.
 * Returns whether the cell is hidden, which the model's own locator is not trusted to report.
 */
function checkXlsxCell(row: Row, workbook: ParsedWorkbook | undefined): { error: string | null; hidden: boolean; snippet?: string } {
  const { sheet, cell: ref } = row.locator;
  if (typeof sheet !== "string" || typeof ref !== "string") return { error: "xlsx locator has no sheet or cell", hidden: false };
  if (!workbook) return { error: "no workbook to verify the cell against", hidden: false };
  const cell = lookupCell(workbook, sheet, ref);
  if (!cell) return { error: `cell ${sheet}!${ref} is empty or does not exist`, hidden: false };
  const own = String(cell.value);
  const entry = new RegExp(`(^|\\|\\s*)${ref}=${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*(\\[[^\\]]*\\]\\s*)*(\\||$))`);
  if (own !== row.snippet.trim() && !entry.test(row.snippet.trim())) return { error: `snippet does not match cell ${sheet}!${ref}`, hidden: false };
  if (typeof cell.value === "number" && row.rate.value !== null && Math.abs(cell.value - row.rate.value) > 1e-9) {
    return { error: `rate ${row.rate.value} does not match cell ${sheet}!${ref} (${cell.value})`, hidden: false };
  }
  return { error: null, hidden: cell.hidden.row || cell.hidden.col || cell.hidden.sheet, snippet: own };
}

/** Every number written in a snippet, parsed the same way prices are ("1,52,000", "250.63"). */
function numbersIn(snippet: string): number[] {
  const out: number[] = [];
  for (const token of snippet.match(/\d+(?:,\d+)*(?:\.\d+)?/g) ?? []) {
    try {
      out.push(parseNumber(token));
    } catch {
      // A token like "1,5,5" is not a number as written; skip it.
    }
  }
  return out;
}

/**
 * For pdf locators, the page must exist, the snippet must appear on it (spacing and cell separators aside),
 * and the rate must be one of the numbers written in the snippet.
 */
function checkPdfSnippet(row: Row, pdf: ParsedPdf | undefined): string | null {
  const page = row.locator.page;
  if (typeof page !== "number") return "pdf locator has no page";
  if (!pdf) return "no PDF to verify the snippet against";
  const text = pdfPageText(pdf, page);
  if (text === undefined) return `page ${page} does not exist`;
  if (!normalizePdfText(text).includes(normalizePdfText(row.snippet))) return `snippet does not appear on page ${page}`;
  const rate = row.rate.value;
  if (rate !== null && !numbersIn(row.snippet).some((n) => Math.abs(n - rate) < 1e-9)) {
    return `rate ${rate} is not written in the snippet`;
  }
  return null;
}

/**
 * For docx locators: a body paragraph (`paragraph_idx`) or a table row (`table_idx`, `row`) must exist and contain
 * the snippet, and the rate must be one of the numbers written in the snippet.
 */
function checkDocxSnippet(row: Row, docx: ParsedDocx | undefined): string | null {
  if (!docx) return "no Word document to verify the snippet against";
  const { paragraph_idx: pi, table_idx: ti, row: ri } = row.locator;
  let text: string | undefined;
  let where: string;
  if (typeof pi === "number") {
    text = docxParagraph(docx, pi);
    where = `paragraph ${pi}`;
  } else if (typeof ti === "number" && typeof ri === "number") {
    text = docxRow(docx, ti, ri)?.join(" | ");
    where = `table ${ti} row ${ri}`;
  } else {
    return "docx locator has no paragraph or table row";
  }
  if (text === undefined) return `${where} does not exist`;
  if (!normalizePdfText(text).includes(normalizePdfText(row.snippet))) return `snippet does not appear in ${where}`;
  const rate = row.rate.value;
  if (rate !== null && !numbersIn(row.snippet).some((n) => Math.abs(n - rate) < 1e-9)) return `rate ${rate} is not written in the snippet`;
  return null;
}

/**
 * For image locators: a row number and a box inside the image, and the rate written in the snippet (the model's
 * transcription of the row). There is no text layer to check against, so a photo reading is never more than
 * HIGH_CONF (rule 8) and the two passes must agree.
 */
function checkImageRow(row: Row): string | null {
  const box = row.locator.box;
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number" && v >= 0 && v <= 1)) return "image locator has no box inside the image";
  const [x0, y0, x1, y1] = box as number[];
  if (!(x0! < x1!) || !(y0! < y1!)) return "image locator box is empty";
  const rate = row.rate.value;
  if (rate !== null && !numbersIn(row.snippet).some((n) => Math.abs(n - rate) < 1e-9)) return `rate ${rate} is not written in the snippet`;
  return null;
}

/** What a row's locator is checked against: the email or document text, and the parsed workbook for xlsx. */
export interface ProvenanceSource {
  text: string;
  workbook?: ParsedWorkbook;
  pdf?: ParsedPdf;
  docx?: ParsedDocx;
  /** For email: offsets at or beyond this are quoted history and cannot be a source. */
  authoritativeEnd?: number;
}

/**
 * Provenance and mapping checks (spec X10, 20.4). A row that fails is rejected, never silently kept.
 * Rows read from hidden cells are verified but returned separately: they are evidence of a hidden value,
 * never the price (spec F02, D24).
 */
export function validateRows(
  extraction: Extraction,
  source: string | ProvenanceSource,
  knownLineIds: readonly string[],
): { valid: Row[]; hidden: Row[]; rejected: RejectedRow[] } {
  const src: ProvenanceSource = typeof source === "string" ? { text: source } : source;
  const known = new Set(knownLineIds);
  const valid: Row[] = [];
  const hidden: Row[] = [];
  const rejected: RejectedRow[] = [];
  for (const original of extraction.rows) {
    let row = original;
    const unknown = row.mapped_line_candidates.find((c) => !known.has(c.line_id));
    if (unknown) {
      rejected.push({ row_id: row.row_id, reason: `unknown line id ${unknown.line_id}` });
      continue;
    }
    const spanError = checkEmailSpan(row.locator, row.snippet, src);
    if (spanError) {
      rejected.push({ row_id: row.row_id, reason: spanError });
      continue;
    }
    if (row.locator.type === "xlsx") {
      const check = checkXlsxCell(row, src.workbook);
      if (check.error) {
        rejected.push({ row_id: row.row_id, reason: check.error });
        continue;
      }
      if (check.snippet !== undefined && check.snippet !== row.snippet) row = { ...row, snippet: check.snippet };
      if (check.hidden) {
        hidden.push(row);
        continue;
      }
    }
    if (row.locator.type === "image") {
      const error = checkImageRow(row);
      if (error) {
        rejected.push({ row_id: row.row_id, reason: error });
        continue;
      }
    }
    if (row.locator.type === "pdf" || row.locator.type === "docx") {
      const error = row.locator.type === "pdf" ? checkPdfSnippet(row, src.pdf) : checkDocxSnippet(row, src.docx);
      if (error) {
        rejected.push({ row_id: row.row_id, reason: error });
        continue;
      }
    }
    valid.push(row);
  }
  return { valid, hidden, rejected };
}
