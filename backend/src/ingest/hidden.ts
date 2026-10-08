import type { Row } from "./extraction.js";
import { lookupCell, type ParsedCell, type ParsedWorkbook } from "./parse_xlsx.js";

/**
 * Hidden values found in code, from the parsed workbook (spec F02, D24, trap 02), so the check never depends on the
 * model choosing to report hidden rows or columns.
 *
 * Which hidden cells belong to which line depends on the layout, which is read from the priced cells themselves:
 * if several lines' prices share a row, items run across columns, and a hidden cell in a price's column belongs to
 * that line; if they share a column, items run down rows, and a hidden cell in a price's row belongs to it. Hidden
 * cells along the other axis (another item's hidden row, say) are never attached to the wrong line.
 */

export interface HiddenValue {
  value: number | null;
  snippet: string;
  locator: Record<string, unknown>;
}

type Axis = "items_across_columns" | "items_down_rows";

function layoutOf(cells: readonly ParsedCell[]): Axis | null {
  const byRow = new Map<number, number>();
  const byCol = new Map<number, number>();
  for (const c of cells) {
    byRow.set(c.row, (byRow.get(c.row) ?? 0) + 1);
    byCol.set(c.col, (byCol.get(c.col) ?? 0) + 1);
  }
  const maxRow = Math.max(0, ...byRow.values());
  const maxCol = Math.max(0, ...byCol.values());
  if (maxRow < 2 && maxCol < 2) return null; // one price: no layout to read
  return maxRow >= maxCol ? "items_across_columns" : "items_down_rows";
}

/** Hidden numeric cells that sit on each priced line's own axis, keyed by line id. */
export function hiddenValuesFor(rows: readonly { line_id: string; row: Row }[], wb: ParsedWorkbook): Map<string, HiddenValue[]> {
  const out = new Map<string, HiddenValue[]>();
  const priced = rows
    .map((r) => ({ ...r, cell: lookupCell(wb, r.row.locator.sheet as string, r.row.locator.cell as string) }))
    .filter((r): r is typeof r & { cell: ParsedCell } => r.row.locator.type === "xlsx" && r.cell !== undefined && typeof r.cell.value === "number");

  for (const sheet of new Set(priced.map((p) => p.cell.sheet))) {
    const here = priced.filter((p) => p.cell.sheet === sheet);
    const axis = layoutOf(here.map((p) => p.cell));
    if (!axis) continue;
    const hidden = (wb.sheets.find((s) => s.name === sheet)?.cells ?? []).filter(
      (c) => typeof c.value === "number" && (c.hidden.row || c.hidden.col || c.hidden.sheet),
    );
    for (const p of here) {
      const mine = hidden.filter((h) => (axis === "items_across_columns" ? h.col === p.cell.col && h.hidden.row : h.row === p.cell.row && h.hidden.col));
      if (mine.length === 0) continue;
      out.set(p.line_id, [
        ...(out.get(p.line_id) ?? []),
        ...mine.map((h) => ({ value: h.value as number, snippet: String(h.value), locator: { type: "xlsx", sheet: h.sheet, cell: h.ref, hidden: true } })),
      ]);
    }
  }
  return out;
}
