import ExcelJS from "exceljs";

/**
 * Excel to a model-friendly grid (spec 10.2, F01, F02, F03).
 * Every non-empty cell keeps its coordinate. Hidden rows, columns and sheets are included and tagged, never dropped
 * and never preferred. Formulas keep both the formula and the cached value. Notes are kept too, since they can
 * carry text addressed to an AI (spec 19.6).
 */

export class ParseError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ParseError";
  }
}

export interface ParseLimits {
  maxBytes: number;
  maxSheets: number;
  maxCells: number;
}

/** Spec 10.1: 25 MB. The sheet and cell caps stop a hostile or runaway workbook. */
export const DEFAULT_LIMITS: ParseLimits = { maxBytes: 25 * 1024 * 1024, maxSheets: 50, maxCells: 200_000 };

export type CellScalar = string | number | boolean | null;

export interface ParsedCell {
  sheet: string;
  /** A1 style, e.g. "G8". */
  ref: string;
  row: number;
  col: number;
  /** The displayed or cached value. */
  value: CellScalar;
  formula: string | null;
  note: string | null;
  /** The cell holds an Excel error such as #N/A. */
  error: boolean;
  hidden: { row: boolean; col: boolean; sheet: boolean };
  /** Set on the top-left cell of a merged range. Other cells of the range are not listed. */
  merged_range: string | null;
}

export interface ParsedSheet {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  merges: string[];
  hidden_rows: number[];
  hidden_cols: number[];
  cells: ParsedCell[];
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  /** The grid as text, for the extraction prompt. */
  text: string;
}

/** Provenance locator for a cell (spec 8.3). */
export function xlsxLocator(c: ParsedCell): { type: "xlsx"; sheet: string; cell: string; hidden: boolean; merged_range: string | null } {
  return { type: "xlsx", sheet: c.sheet, cell: c.ref, hidden: c.hidden.row || c.hidden.col || c.hidden.sheet, merged_range: c.merged_range };
}

export function lookupCell(wb: ParsedWorkbook, sheet: string, ref: string): ParsedCell | undefined {
  return wb.sheets.find((s) => s.name === sheet)?.cells.find((c) => c.ref === ref);
}

function colLetters(n: number): string {
  let s = "";
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

function noteText(note: ExcelJS.Cell["note"]): string | null {
  if (!note) return null;
  if (typeof note === "string") return note;
  const texts = (note as { texts?: { text: string }[] }).texts;
  return texts ? texts.map((t) => t.text).join("") : null;
}

/** Reduces any Excel cell value to a scalar, keeping the formula and error flag. */
function readValue(v: ExcelJS.CellValue): { value: CellScalar; formula: string | null; error: boolean } {
  if (v === null || v === undefined) return { value: null, formula: null, error: false };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { value: v, formula: null, error: false };
  if (v instanceof Date) return { value: v.toISOString().slice(0, 10), formula: null, error: false };
  if ("richText" in v) return { value: v.richText.map((r) => r.text).join(""), formula: null, error: false };
  if ("error" in v) return { value: v.error, formula: null, error: true };
  if ("formula" in v || "sharedFormula" in v) {
    const f = v as { formula?: string; sharedFormula?: string; result?: ExcelJS.CellValue };
    const inner = readValue((f.result ?? null) as ExcelJS.CellValue);
    return { value: inner.value, formula: f.formula ?? f.sharedFormula ?? null, error: inner.error };
  }
  if ("text" in v) return { value: (v as { text: string }).text, formula: null, error: false };
  return { value: String(v), formula: null, error: false };
}

export async function parseXlsx(buffer: Buffer, limits: ParseLimits = DEFAULT_LIMITS): Promise<ParsedWorkbook> {
  if (buffer.length > limits.maxBytes) throw new ParseError(`file is ${buffer.length} bytes, over the ${limits.maxBytes} byte limit`);

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw new ParseError(`workbook could not be read (corrupted, password protected or not an xlsx): ${(err as Error).message}`);
  }
  // A zip that is not a workbook can load without error and come back empty. That must fail visibly, not look like no data.
  if (wb.worksheets.length === 0) throw new ParseError("no worksheets found; this is not a readable xlsx workbook");
  if (wb.worksheets.length > limits.maxSheets) throw new ParseError(`workbook has ${wb.worksheets.length} sheets, over the ${limits.maxSheets} limit`);

  let cellCount = 0;
  const sheets: ParsedSheet[] = wb.worksheets.map((ws) => {
    const state = (ws.state ?? "visible") as ParsedSheet["state"];
    const merges = [...((ws.model as { merges?: string[] }).merges ?? [])];
    const hiddenRows: number[] = [];
    const hiddenCols = new Set<number>();
    const cells: ParsedCell[] = [];

    for (let c = 1; c <= ws.columnCount; c++) if (ws.getColumn(c).hidden) hiddenCols.add(c);

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (row.hidden) hiddenRows.push(rowNumber);
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        // Slaves of a merged range repeat the master's value. List the master only.
        if (cell.isMerged && cell.master.address !== cell.address) return;
        if (++cellCount > limits.maxCells) throw new ParseError(`workbook has more than ${limits.maxCells} cells`);
        const { value, formula, error } = readValue(cell.value);
        cells.push({
          sheet: ws.name,
          ref: cell.address,
          row: rowNumber,
          col,
          value,
          formula,
          note: noteText(cell.note),
          error,
          hidden: { row: Boolean(row.hidden), col: hiddenCols.has(col), sheet: state !== "visible" },
          merged_range: cell.isMerged ? (merges.find((m) => m.startsWith(`${cell.address}:`)) ?? null) : null,
        });
      });
    });

    return { name: ws.name, state, merges, hidden_rows: hiddenRows, hidden_cols: [...hiddenCols].sort((a, b) => a - b), cells };
  });

  return { sheets, text: renderText(sheets) };
}

function display(c: ParsedCell): string {
  let v = c.value === null ? "" : String(c.value).replace(/\r?\n/g, "\\n");
  if (c.error) v = `${v} [ERROR]`;
  const tags: string[] = [];
  if (c.hidden.col) tags.push("HIDDEN COL");
  if (c.merged_range) tags.push(`merged ${c.merged_range}`);
  if (c.formula) tags.push(`formula =${c.formula}`);
  if (c.note) tags.push(`note: ${c.note.replace(/\r?\n/g, "\\n")}`);
  return `${c.ref}=${v}${tags.length ? ` [${tags.join("; ")}]` : ""}`;
}

/** One line per row, so row relationships survive; hidden rows, columns and sheets are tagged, never omitted. */
function renderText(sheets: ParsedSheet[]): string {
  const out: string[] = [];
  for (const s of sheets) {
    out.push(`=== Sheet: ${s.name}${s.state !== "visible" ? ` [HIDDEN SHEET: ${s.state}]` : ""} ===`);
    if (s.merges.length > 0) out.push(`merged ranges: ${s.merges.join(", ")}`);
    if (s.hidden_cols.length > 0) out.push(`hidden columns: ${s.hidden_cols.map(colLetters).join(", ")}`);
    const rows = [...new Set(s.cells.map((c) => c.row))].sort((a, b) => a - b);
    for (const r of rows) {
      const inRow = s.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
      const hidden = s.hidden_rows.includes(r) ? " [HIDDEN ROW]" : "";
      out.push(`${s.name}!row${r}${hidden}: ${inRow.map(display).join(" | ")}`);
    }
  }
  return out.join("\n");
}
