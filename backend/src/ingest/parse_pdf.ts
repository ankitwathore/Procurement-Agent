import { ParseError } from "./parse_xlsx.js";

/**
 * PDF text layer to a model-friendly representation with coordinates (spec 10.2, F04).
 * Text is grouped into lines by baseline; table cells on a line are separated by " | " where the gap is wide.
 * Small text is tagged, because fine print is where terms hide (GST basis, discounts, instructions to an AI).
 * Pages with no text layer are flagged for the vision path rather than read as empty.
 */

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
/** Text at or below this size (points) is tagged as fine print. */
export const SMALL_TEXT_PT = 6;
const SAME_LINE_PT = 2;
const CELL_GAP_PT = 6;

export interface PdfLine {
  text: string;
  /** PDF user space, origin bottom left: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Largest font size on the line, in points. */
  font_size: number;
  small: boolean;
}

export interface PdfPage {
  page: number;
  width: number;
  height: number;
  lines: PdfLine[];
  /** True when the page has no extractable text; it needs the vision path. */
  no_text_layer: boolean;
}

export interface ParsedPdf {
  pages: PdfPage[];
  text: string;
}

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}

/** Collapses " | " cell separators and whitespace so a snippet can be matched against a line however it was copied. */
export function normalizePdfText(s: string): string {
  return s.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim();
}

export function pdfPageText(pdf: ParsedPdf, page: number): string | undefined {
  const p = pdf.pages.find((x) => x.page === page);
  return p ? p.lines.map((l) => l.text).join("\n") : undefined;
}

function groupLines(items: Item[]): PdfLine[] {
  const sorted = items.filter((i) => i.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs((r[0] as Item).y - it.y) <= SAME_LINE_PT);
    if (row) row.push(it);
    else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd: number | null = null;
    for (const it of row) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        text += gap > CELL_GAP_PT ? " | " : gap > 0.5 ? " " : "";
      }
      text += it.str;
      prevEnd = it.x + it.w;
    }
    // Judge a line by its largest text: a table row with one shrunk cell is not fine print.
    const size = Math.max(...row.map((i) => i.size));
    return {
      text: text.trim(),
      bbox: [
        Math.min(...row.map((i) => i.x)),
        Math.min(...row.map((i) => i.y)),
        Math.max(...row.map((i) => i.x + i.w)),
        Math.max(...row.map((i) => i.y + i.h)),
      ] as [number, number, number, number],
      font_size: Math.round(size * 10) / 10,
      small: size <= SMALL_TEXT_PT,
    };
  });
}

export async function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  if (buffer.length > MAX_PDF_BYTES) throw new ParseError(`file is ${buffer.length} bytes, over the ${MAX_PDF_BYTES} byte limit`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (err) {
    throw new ParseError(`PDF could not be read (corrupted, password protected or not a PDF): ${(err as Error).message}`);
  }
  if (doc.numPages > MAX_PDF_PAGES) throw new ParseError(`PDF has ${doc.numPages} pages, over the ${MAX_PDF_PAGES} limit`);

  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [, , width, height] = page.view as [number, number, number, number];
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const t = raw.transform as number[];
      items.push({ str: raw.str, x: t[4] as number, y: t[5] as number, w: raw.width, h: raw.height, size: Math.hypot(t[0] as number, t[1] as number) });
    }
    const lines = groupLines(items);
    pages.push({ page: n, width, height, lines, no_text_layer: lines.length === 0 });
  }
  await doc.destroy();
  return { pages, text: renderText(pages) };
}

function renderText(pages: PdfPage[]): string {
  const out: string[] = [];
  for (const p of pages) {
    out.push(`=== Page ${p.page}${p.no_text_layer ? " [NO TEXT LAYER: needs vision]" : ""} ===`);
    for (const l of p.lines) out.push(l.small ? `[SMALL TEXT ${l.font_size}pt] ${l.text}` : l.text);
  }
  return out.join("\n");
}
