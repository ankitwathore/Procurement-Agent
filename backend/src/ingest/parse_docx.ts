import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { ParseError } from "./parse_xlsx.js";

/**
 * Word to a model-friendly representation (spec 10.2, F07). Body paragraphs and tables in document order, each
 * with its index for provenance; headers and footers included, since terms often hide there; text boxes are read
 * as part of the paragraph that holds them.
 */

export const MAX_DOCX_BYTES = 25 * 1024 * 1024;

export interface DocxParagraph {
  type: "paragraph";
  /** Index among body paragraphs (spec 8.3 `paragraph_idx`). */
  paragraph_idx: number;
  text: string;
}

export interface DocxTable {
  type: "table";
  /** Index among body tables (spec 8.3 `table_idx`). */
  table_idx: number;
  rows: string[][];
}

export interface ParsedDocx {
  blocks: (DocxParagraph | DocxTable)[];
  headers: string[];
  footers: string[];
  text: string;
}

type Node = Record<string, unknown>;

// Text must stay exactly as written: "661.00" is not 661, and "007" is not 7.
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, trimValues: false, parseTagValue: false });

const tagOf = (n: Node): string => Object.keys(n).find((k) => k !== ":@") ?? "";
const kids = (n: Node): Node[] => (n[tagOf(n)] as Node[] | undefined) ?? [];

/** Concatenates every run of text under a node: w:t text, tabs as tabs, breaks as spaces. */
function textOf(n: Node): string {
  const tag = tagOf(n);
  if (tag === "#text") return String(n["#text"]);
  if (tag === "w:tab") return "\t";
  if (tag === "w:br" || tag === "w:cr") return " ";
  if (tag === "w:instrText" || tag === "w:delText") return ""; // field codes and deleted text are not content
  return kids(n).map(textOf).join("");
}

function tableRows(tbl: Node): string[][] {
  return kids(tbl)
    .filter((r) => tagOf(r) === "w:tr")
    .map((tr) =>
      kids(tr)
        .filter((c) => tagOf(c) === "w:tc")
        .map((tc) =>
          kids(tc)
            .filter((x) => tagOf(x) === "w:p" || tagOf(x) === "w:tbl")
            .map((x) => (tagOf(x) === "w:tbl" ? tableRows(x).map((r) => r.join(" ")).join(" ") : textOf(x)))
            .join(" ")
            .trim(),
        ),
    );
}

function find(nodes: Node[], tag: string): Node | undefined {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n;
    const inner = find(kids(n), tag);
    if (inner) return inner;
  }
  return undefined;
}

async function partParagraphs(zip: JSZip, prefix: string): Promise<string[]> {
  const names = Object.keys(zip.files).filter((n) => new RegExp(`^word/${prefix}\\d*\\.xml$`).test(n)).sort();
  const out: string[] = [];
  for (const name of names) {
    const tree = parser.parse(await zip.file(name)!.async("string")) as Node[];
    const root = find(tree, prefix === "header" ? "w:hdr" : "w:ftr");
    for (const p of root ? kids(root) : []) if (tagOf(p) === "w:p") out.push(textOf(p).trim());
  }
  return out.filter(Boolean);
}

export async function parseDocx(buffer: Buffer): Promise<ParsedDocx> {
  if (buffer.length > MAX_DOCX_BYTES) throw new ParseError(`file is ${buffer.length} bytes, over the ${MAX_DOCX_BYTES} byte limit`);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParseError(`Word file could not be read (corrupted, password protected or not a docx): ${(err as Error).message}`);
  }
  const main = zip.file("word/document.xml");
  if (!main) throw new ParseError("no word/document.xml; this is not a readable docx");

  const tree = parser.parse(await main.async("string")) as Node[];
  const body = find(tree, "w:body");
  if (!body) throw new ParseError("the document has no body");

  const blocks: ParsedDocx["blocks"] = [];
  let pi = 0;
  let ti = 0;
  for (const n of kids(body)) {
    const tag = tagOf(n);
    if (tag === "w:p") blocks.push({ type: "paragraph", paragraph_idx: pi++, text: textOf(n).trim() });
    else if (tag === "w:tbl") blocks.push({ type: "table", table_idx: ti++, rows: tableRows(n) });
  }

  const headers = await partParagraphs(zip, "header");
  const footers = await partParagraphs(zip, "footer");
  return { blocks, headers, footers, text: renderText(blocks, headers, footers) };
}

export function docxParagraph(doc: ParsedDocx, idx: number): string | undefined {
  return doc.blocks.find((b): b is DocxParagraph => b.type === "paragraph" && b.paragraph_idx === idx)?.text;
}

export function docxRow(doc: ParsedDocx, tableIdx: number, row: number): string[] | undefined {
  return doc.blocks.find((b): b is DocxTable => b.type === "table" && b.table_idx === tableIdx)?.rows[row];
}

function renderText(blocks: ParsedDocx["blocks"], headers: string[], footers: string[]): string {
  const out: string[] = [];
  for (const h of headers) out.push(`[HEADER] ${h}`);
  for (const b of blocks) {
    if (b.type === "paragraph") {
      if (b.text) out.push(`[P${b.paragraph_idx}] ${b.text}`);
    } else {
      b.rows.forEach((r, i) => out.push(`[T${b.table_idx} R${i}] ${r.join(" | ")}`));
    }
  }
  for (const f of footers) out.push(`[FOOTER] ${f}`);
  return out.join("\n");
}
