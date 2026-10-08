/**
 * ISO date (YYYY-MM-DD) helpers. Dates are plain calendar dates, compared as strings, with no time zones.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for real calendar dates: "2026-02-30" is rejected. */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function addDays(iso: string, days: number): string {
  if (!isIsoDate(iso)) throw new Error(`not an ISO date: ${iso}`);
  const m = ISO_DATE.exec(iso) as RegExpExecArray;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return t.toISOString().slice(0, 10);
}

/** The same calendar day n years earlier; 29 February falls back to 28 February in a non-leap year. */
export function minusYears(iso: string, years: number): string {
  if (!isIsoDate(iso)) throw new Error(`not an ISO date: ${iso}`);
  const [y, m, d] = iso.split("-") as [string, string, string];
  const candidate = `${String(Number(y) - years).padStart(4, "0")}-${m}-${d}`;
  return isIsoDate(candidate) ? candidate : `${String(Number(y) - years).padStart(4, "0")}-${m}-28`;
}

/** "+05:30" -> 330, "-07:00" -> -420. */
export function offsetMinutes(offset: string): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!m) throw new Error(`not a UTC offset: ${offset}`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The calendar date of an instant on a given clock, e.g. the buyer's: 2026-09-23T18:45Z at +05:30 is 2026-09-24. */
export function localDate(instant: Date, offset: string): string {
  return new Date(instant.getTime() + offsetMinutes(offset) * 60_000).toISOString().slice(0, 10);
}

/** The calendar date of a date or datetime string as written ("2026-09-24T09:30:00+05:30" -> "2026-09-24"). */
export function datePart(s: string): string | null {
  const d = s.slice(0, 10);
  return isIsoDate(d) ? d : null;
}
