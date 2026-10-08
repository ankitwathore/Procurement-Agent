import { RFX_LINES } from "../../src/data/rfx.js";
import { parseDims } from "../../src/ingest/checks.js";
import { ExtractionSchema, type Extraction } from "../../src/ingest/extraction.js";
import { lookupCell, xlsxLocator, type ParsedWorkbook } from "../../src/ingest/parse_xlsx.js";

/**
 * What a correct pass A would emit for V1's workbook. Test-only stand-in for the LLM until extraction is wired.
 * It reads the parsed grid, never the ground truth, so the pipeline test scores real file content.
 * The column-to-line mapping is the one judgment it takes for granted; a model would infer it from names and sizes.
 */

const ROW = { item: 4, size: 5, board: 6, unit: 7, rate: 8, rateQ2: 10 };
const UNIT: Record<string, string> = { pc: "per pc", kg: "per kg", roll: "per roll", set: "per set", pair: "per pair" };

function colLetters(n: number): string {
  let s = "";
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

function board(text: unknown): { ply?: number; liner_gsm?: number; bf?: number } {
  const m = /^(\d)P \S+ (\d+)\/(\d+)$/.exec(String(text ?? ""));
  return m ? { ply: Number(m[1]), liner_gsm: Number(m[2]), bf: Number(m[3]) } : {};
}

function term(wb: ParsedWorkbook, label: string): { snippet: string; locator: Record<string, unknown> } {
  const summary = wb.sheets.find((s) => s.name === "Summary")!;
  const key = summary.cells.find((c) => c.col === 1 && c.value === label)!;
  const cell = lookupCell(wb, "Summary", `B${key.row}`)!;
  return { snippet: String(cell.value), locator: xlsxLocator(cell) };
}

export function v1Extraction(wb: ParsedWorkbook): Extraction {
  const rows: unknown[] = [];
  RFX_LINES.forEach((line, i) => {
    const col = colLetters(2 + i);
    const unit = lookupCell(wb, "Rates", `${col}${ROW.unit}`)?.value;
    const spec_offered = {
      ...board(lookupCell(wb, "Rates", `${col}${ROW.board}`)?.value),
      dims_mm: parseDims(String(lookupCell(wb, "Rates", `${col}${ROW.size}`)?.value ?? "")),
    };
    for (const r of [ROW.rate, ROW.rateQ2]) {
      const cell = lookupCell(wb, "Rates", `${col}${r}`);
      if (!cell || typeof cell.value !== "number") continue; // "NQ" and blanks are not priced rows
      rows.push({
        row_id: `${col}${r}`,
        raw_text: `${lookupCell(wb, "Rates", `${col}${ROW.item}`)?.value} ${cell.value}`,
        mapped_line_candidates: [{ line_id: line.line_id, match_confidence: 0.9, reasons: ["description", "dimensions"] }],
        rate: { value: cell.value, currency: "INR", unit_as_written: UNIT[String(unit)] ?? null },
        spec_offered,
        locator: xlsxLocator(cell),
        snippet: String(cell.value),
      });
    }
  });

  const delivery = term(wb, "Delivery");
  const gst = term(wb, "GST");
  const validity = term(wb, "Validity");
  return ExtractionSchema.parse({
    vendor_terms: {
      freight_basis: { value: "delivered", ...delivery },
      gst_basis: { value: "exclusive", rate_pct: 18, ...gst },
      validity: { value_text: validity.snippet, from_date: "2026-09-21", valid_days: 30, ...validity },
    },
    rows,
  });
}
