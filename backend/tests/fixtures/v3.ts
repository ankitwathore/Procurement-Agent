import { RFX_LINES } from "../../src/data/rfx.js";
import { parseDims } from "../../src/ingest/checks.js";
import { ExtractionSchema, type Extraction } from "../../src/ingest/extraction.js";
import type { DocxParagraph, DocxTable, ParsedDocx } from "../../src/ingest/parse_docx.js";
import { parseNumber } from "../../src/normalize/parse.js";

/**
 * What a correct pass A would emit for V3's Word quotation. Test-only stand-in for the LLM.
 * Reads the parsed document only: sentences for the cartons, tables for the rest, terms from their paragraphs.
 * Lines are matched by the dimensions the vendor wrote.
 */

const byDims = (dims: number[]) => RFX_LINES.find((l) => JSON.stringify(parseDims(l.spec.dims_text)) === JSON.stringify(dims));

function boardOf(text: string): { ply?: number; liner_gsm?: number; bf?: number } {
  const m = /^(\d) ply \S+ (\d+)\/(\d+)$/.exec(text);
  return m ? { ply: Number(m[1]), liner_gsm: Number(m[2]), bf: Number(m[3]) } : {};
}

export function v3Extraction(doc: ParsedDocx): Extraction {
  const rows: unknown[] = [];
  const paragraphs = doc.blocks.filter((b): b is DocxParagraph => b.type === "paragraph");
  const tables = doc.blocks.filter((b): b is DocxTable => b.type === "table");

  for (const p of paragraphs) {
    const dims = /(\d+) (?:by|x) (\d+) (?:by|x) (\d+) mm/.exec(p.text);
    const price = /Rs ([\d,.]+) (per piece|each)/.exec(p.text);
    if (!dims || !price) continue;
    const line = byDims([Number(dims[1]), Number(dims[2]), Number(dims[3])]);
    if (!line) continue;
    rows.push({
      row_id: `P${p.paragraph_idx}`,
      raw_text: p.text,
      mapped_line_candidates: [{ line_id: line.line_id, match_confidence: 0.85, reasons: ["description", "dimensions"] }],
      rate: { value: parseNumber(price[1] as string), currency: "INR", unit_as_written: price[2] },
      spec_offered: { dims_mm: [Number(dims[1]), Number(dims[2]), Number(dims[3])] },
      locator: { type: "docx", paragraph_idx: p.paragraph_idx },
      snippet: p.text,
    });
  }

  for (const t of tables) {
    const header = t.rows[0] ?? [];
    if (!header.includes("Basis")) continue; // the questionnaire table
    const sizeCol = header.indexOf(header.find((h) => h.startsWith("Size")) as string);
    const rateCol = header.findIndex((h) => h.startsWith("Rate"));
    const boardCol = header.indexOf("Board");
    t.rows.slice(1).forEach((cells, i) => {
      const line = RFX_LINES.find((l) => l.spec.dims_text === cells[sizeCol]);
      if (!line) return;
      const rateText = cells[rateCol] as string;
      const usd = /^USD\s+/.exec(rateText);
      rows.push({
        row_id: `T${t.table_idx}R${i + 1}`,
        raw_text: cells.join(" | "),
        mapped_line_candidates: [{ line_id: line.line_id, match_confidence: 0.9, reasons: ["description", "dimensions"] }],
        // A "Rate (Rs)" header states the currency; the mixed accessories table's "Rate" header does not.
        rate: { value: parseNumber(rateText.replace(/^USD\s+/, "")), currency: usd ? "USD" : /\(Rs\)/.test(header[rateCol] as string) ? "INR" : "", unit_as_written: cells[header.indexOf("Basis")] },
        spec_offered: { ...(boardCol >= 0 ? boardOf(cells[boardCol] as string) : {}), dims_mm: parseDims(cells[sizeCol] as string) },
        locator: { type: "docx", table_idx: t.table_idx, row: i + 1 },
        snippet: cells.join(" | "),
      });
    });
  }

  const para = (re: RegExp) => {
    const p = paragraphs.find((x) => re.test(x.text));
    if (!p) throw new Error(`not found: ${re}`);
    return { snippet: p.text, locator: { type: "docx", paragraph_idx: p.paragraph_idx } };
  };
  const validity = para(/^5\. Validity/);
  return ExtractionSchema.parse({
    vendor_terms: {
      freight_basis: { value: "delivered", ...para(/^1\. Delivery/) },
      gst_basis: { value: "exclusive", rate_pct: 18, ...para(/^2\. GST/) },
      fx_clause: { value_text: para(/RBI reference rate/).snippet, ...para(/RBI reference rate/) },
      validity: { value_text: validity.snippet, from_date: "2026-09-18", valid_days: 15, ...validity },
    },
    rows,
  });
}
