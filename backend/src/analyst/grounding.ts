import { formatRupees } from "../util/format.js";

/**
 * Numeric grounding check (spec 14.5). Every number the analyst writes must match a number from a tool result of this
 * turn: exactly as rounded in the prose, or within 0.5 percent, after unit scaling (lakh, crore, thousand, percent).
 * Identifiers (L04, V2, Q01), dates and years are not figures and are skipped.
 */

export interface ProseNumber {
  text: string;
  value: number;
  decimals: number;
}

const SCALE: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3, thousand: 1e3 };

/** Numbers as written in prose, scaled to plain units ("Rs 12.4 lakh" -> 1240000, "3.3%" -> 3.3). */
export function proseNumbers(text: string): ProseNumber[] {
  const out: ProseNumber[] = [];
  // Strip what is not a figure: identifiers, ISO and dd-mm dates, times.
  const cleaned = text
    .replace(/\b[A-Za-z]{1,3}\d{1,3}\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");
  const re = /(Rs\.?\s*|₹\s*|INR\s*)?(\d+(?:,\d+)*(?:\.\d+)?)(\s*(lakhs?|lac|crores?|cr|thousand|k|l)\b)?/gi;
  for (const m of cleaned.matchAll(re)) {
    const currency = !!m[1];
    const raw = m[2] as string;
    const at = (m.index ?? 0) + (m[1]?.length ?? 0);
    // A number glued to letters ("5ply", "x100", "40L", "1200mm") is part of a name or a size, not a figure,
    // unless a currency comes first ("Rs 4.1L" is 4.1 lakh).
    const before = cleaned[at - 1] ?? " ";
    const after = cleaned[at + raw.length] ?? " ";
    if (/[A-Za-z_]/.test(before)) continue;
    if (/[A-Za-z]/.test(after) && !currency) continue;
    const base = Number(raw.replace(/,/g, ""));
    let unit = (m[4] ?? "").toLowerCase();
    // Bare "k" and "l" scale only a money figure; "40 l" is litres.
    if ((unit === "k" || unit === "l") && !currency) unit = "";
    const value = unit ? base * (SCALE[unit] as number) : base;
    // Years are context, not figures.
    if (!unit && /^(19|20)\d{2}$/.test(raw)) continue;
    out.push({ text: (unit ? m[0] : `${m[1] ?? ""}${raw}`).trim(), value, decimals: (raw.split(".")[1] ?? "").length });
  }
  return out;
}

/** Every number in a tool result (any depth), plus its display forms (Rs lakh and crore as the UI rounds them). */
export function toolNumbers(value: unknown, into: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.push(value);
    if (Math.abs(value) >= 1e5) {
      const shown = formatRupees(value).replace(/^-?Rs /, "");
      const m = /^([\d.,]+)\s*(lakh|crore)?$/.exec(shown);
      if (m) into.push(Number((m[1] as string).replace(/,/g, "")) * (m[2] === "crore" ? 1e7 : m[2] === "lakh" ? 1e5 : 1) * (value < 0 ? -1 : 1));
    }
  } else if (typeof value === "string") {
    for (const n of proseNumbers(value)) into.push(n.value);
  } else if (Array.isArray(value)) {
    for (const v of value) toolNumbers(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) toolNumbers(v, into);
  }
  return into;
}

function matches(p: ProseNumber, t: number): boolean {
  const pv = Math.abs(p.value);
  const tv = Math.abs(t);
  if (pv === tv) return true;
  // Rounded as written: 3.3 for 3.27, 12.4 lakh for 12.38 lakh.
  const scale = p.value === 0 ? 1 : pv / Math.abs(Number(p.text.replace(/[^\d.]/g, "")) || 1);
  const shownDecimals = (p.text.match(/\.(\d+)/)?.[1] ?? "").length;
  const rounded = Math.round((tv / scale) * 10 ** shownDecimals) / 10 ** shownDecimals;
  if (Math.abs(rounded * scale - pv) < 1e-9 * Math.max(1, pv)) return true;
  return tv > 0 && Math.abs(pv - tv) / tv <= 0.005;
}

export interface GroundingResult {
  ok: boolean;
  ungrounded: string[];
}

/** Checks prose against the numbers this turn's tools produced. */
export function checkGrounding(prose: string, pool: readonly number[]): GroundingResult {
  const ungrounded = proseNumbers(prose)
    .filter((p) => !pool.some((t) => matches(p, t)))
    .map((p) => p.text);
  return { ok: ungrounded.length === 0, ungrounded: [...new Set(ungrounded)] };
}
