/**
 * Pure parsers for numbers and unit strings (spec 9.1, F17). No I/O, no LLM.
 */

const CURRENCY_TOKENS = /rs\.?|inr|₹|usd|\$/g;
const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
};

const NUMBER_WITH_SUFFIX = /^(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?|cr)?$/;
const DECIMAL_COMMA = /^\d+,\d{1,2}$/;
const INDIAN_GROUPING = /^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?$/;
const WESTERN_GROUPING = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * Parses "1,52,000", "42k", "Rs 1.2 lakh", "12,5" (decimal comma), "1,500".
 * Throws on anything it cannot read, never guesses.
 */
export function parseNumber(input: string): number {
  const s = input.trim().toLowerCase().replace(CURRENCY_TOKENS, "").trim();
  const m = NUMBER_WITH_SUFFIX.exec(s);
  if (!m) throw new Error(`cannot parse number: "${input}"`);
  const digits = m[1] as string;
  const suffix = m[2];

  let value: number;
  if (!digits.includes(",")) {
    value = Number(digits);
  } else if (DECIMAL_COMMA.test(digits)) {
    value = Number(digits.replace(",", "."));
  } else if (INDIAN_GROUPING.test(digits) || WESTERN_GROUPING.test(digits)) {
    value = Number(digits.replaceAll(",", ""));
  } else {
    throw new Error(`ambiguous digit grouping: "${input}"`);
  }

  const result = suffix ? value * (MULTIPLIERS[suffix] as number) : value;
  return Math.round(result * 1e6) / 1e6;
}

export type UnitKind = "piece" | "kg" | "ton" | "box" | "carton" | "roll" | "set" | "pair" | "dozen";

/** A price is quoted for `per` units of `kind`, e.g. "per 100 pcs" is { kind: "piece", per: 100 }. */
export interface CanonicalUnit {
  kind: UnitKind;
  per: number;
}

const UNIT_WORDS: Record<string, UnitKind> = {
  pc: "piece", pcs: "piece", piece: "piece", pieces: "piece", nos: "piece", no: "piece", each: "piece", ea: "piece",
  kg: "kg", kgs: "kg", kilo: "kg", kilogram: "kg", kilograms: "kg",
  ton: "ton", tons: "ton", tonne: "ton", tonnes: "ton", mt: "ton",
  box: "box", boxes: "box",
  carton: "carton", cartons: "carton", ctn: "carton", ctns: "carton",
  roll: "roll", rolls: "roll",
  set: "set", sets: "set",
  pair: "pair", pairs: "pair",
  dozen: "dozen", doz: "dozen",
};

/** Returns null when the unit text is missing or not recognised, so the caller can route to review. */
export function canonicalUnit(raw: string | null | undefined): CanonicalUnit | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:rs\.?\s*)?(?:per|\/|@)\s*/, "")
    // Counts written as words: "per hundred", "per thousand pcs", "a dozen".
    .replace(/\b(?:a|one)\s+(hundred|thousand)\b/, "$1")
    .replace(/\bhundred\b/, "100")
    .replace(/\bthousand\b/, "1000")
    // "a piece", "one roll": the article is not part of the unit (a count is a number, handled below).
    .replace(/^(?:a|an|one)\s+/, "")
    .trim();
  // A bare count ("per hundred", "per 1000") counts pieces.
  const bare = /^(\d[\d,]*)$/.exec(s);
  if (bare) {
    const n = parseNumber(bare[1] as string);
    return n > 0 ? { kind: "piece", per: n } : null;
  }
  const m = /^(?:(\d[\d,]*)\s*)?([a-z]+)\.?$/.exec(s);
  if (!m) return null;
  const kind = UNIT_WORDS[m[2] as string];
  if (!kind) return null;
  const per = m[1] ? parseNumber(m[1]) : 1;
  return per > 0 ? { kind, per } : null;
}
