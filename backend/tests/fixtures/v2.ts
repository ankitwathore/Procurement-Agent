import { RFX_LINES } from "../../src/data/rfx.js";
import { parseDims } from "../../src/ingest/checks.js";
import { ExtractionSchema, type Extraction } from "../../src/ingest/extraction.js";
import type { ParsedPdf, PdfLine } from "../../src/ingest/parse_pdf.js";
import { parseNumber } from "../../src/normalize/parse.js";

/**
 * What a correct pass A would emit for V2's quotation PDF. Test-only stand-in for the LLM.
 * It reads the parsed text layer only, never the generator's internals or the ground truth.
 * Rows are mapped to RFx lines by the printed size, the way a reader would match the vendor's own codes.
 */

const UNIT: Record<string, string> = { Pc: "per pc", Kg: "per kg", Roll: "per roll", Set: "per set", Pair: "per pair" };
const GST_NOTE = "GST basis read from page 3 fine print: rates are inclusive of GST at 18 percent.";

function find(pdf: ParsedPdf, re: RegExp): { line: PdfLine; page: number } {
  for (const p of pdf.pages) {
    const line = p.lines.find((l) => re.test(l.text));
    if (line) return { line, page: p.page };
  }
  throw new Error(`not found in PDF: ${re}`);
}

const loc = (page: number, line: PdfLine) => ({ type: "pdf", page, bbox: line.bbox, source: "text_layer" });

function board(text: string): { ply?: number; liner_gsm?: number; bf?: number } {
  const m = /^(\d) Ply \S+ (\d+)\/(\d+)$/.exec(text);
  return m ? { ply: Number(m[1]), liner_gsm: Number(m[2]), bf: Number(m[3]) } : {};
}

export function v2Extraction(pdf: ParsedPdf): Extraction {
  const rows: unknown[] = [];
  const extras: unknown[] = [];
  for (const p of pdf.pages) {
    for (const line of p.lines) {
      const cells = line.text.split(" | ");
      if (cells.length !== 9) continue;
      const [sno, code, desc, size, brd, unit, , rate, amount] = cells as string[];
      if (!/^APW-/.test(code)) continue;
      const rateValue = parseNumber(rate);
      if (sno === "ALT") {
        // Not requested by the RFx: report it, do not map it (trap 12).
        const l06 = RFX_LINES.find((l) => l.spec.dims_text === size);
        extras.push({ description: desc, rate: { value: rateValue, currency: "INR", unit_as_written: UNIT[unit] ?? null }, related_line_id: l06?.line_id ?? null, snippet: line.text, locator: loc(p.page, line) });
        continue;
      }
      const target = RFX_LINES.find((l) => l.spec.dims_text === size);
      if (!target) continue;
      rows.push({
        row_id: code,
        raw_text: line.text,
        mapped_line_candidates: [{ line_id: target.line_id, match_confidence: 0.9, reasons: ["dimensions", "description", "board"] }],
        rate: { value: rateValue, currency: "INR", unit_as_written: UNIT[unit] ?? null, basis_note: "GST inclusive" },
        line_total_as_written: parseNumber(amount),
        spec_offered: { ...board(brd), dims_mm: parseDims(size) },
        locator: loc(p.page, line),
        snippet: line.text,
        assumptions: [GST_NOTE],
      });
    }
  }

  const freight = find(pdf, /Ex works Ahmedabad/);
  const gst = find(pdf, /inclusive of GST/);
  const validity = find(pdf, /^3\. Validity/);
  const discount = find(pdf, /percent discount on invoice value/);
  return ExtractionSchema.parse({
    vendor_terms: {
      freight_basis: { value: "ex_works", snippet: freight.line.text, locator: loc(freight.page, freight.line) },
      gst_basis: { value: "inclusive", rate_pct: 18, snippet: gst.line.text, locator: loc(gst.page, gst.line) },
      validity: { value_text: validity.line.text, from_date: "2026-09-19", valid_days: 30, snippet: validity.line.text, locator: loc(validity.page, validity.line) },
      conditional_discounts: [
        {
          pct: 5,
          condition_text: "total annual PO value with us exceeds Rs 25,00,000",
          threshold_text: "Rs 25,00,000",
          threshold_inclusive: false, // "exceeds"
          snippet: discount.line.text,
          locator: loc(discount.page, discount.line),
        },
      ],
    },
    rows,
    extras,
  });
}
