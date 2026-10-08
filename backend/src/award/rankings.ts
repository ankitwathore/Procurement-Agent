import type { Quote } from "../ingest/quotes.js";
import type { RfxLine } from "../schemas.js";

/**
 * Headline versus landed ranking (spec 18.4, trap 33). Vendors quote different lines, so each is ranked by an index
 * against last year's prices over the lines it priced: headline uses the vendor's own rate (ex GST), landed adds
 * freight. A vendor whose rank moves is cheap on paper but not delivered (V4: ex works from Bahadurgarh).
 */

export interface Ranking {
  vendor_id: string;
  lines: number;
  /** Sum of price x quantity over sum of last year's price x quantity, minus 1: -0.05 is 5 percent cheaper. */
  headline_vs_baseline: number;
  landed_vs_baseline: number;
  headline_rank: number;
  landed_rank: number;
  flipped: boolean;
}

export function rankings(vendors: { vendor_id: string; quotes: readonly Quote[] }[], lines: readonly RfxLine[]): Ranking[] {
  const rows = vendors.map((v) => {
    let head = 0, land = 0, base = 0, n = 0;
    for (const q of v.quotes) {
      const line = lines.find((l) => l.line_id === q.line_id);
      const rate = q.components.find((c) => c.kind === "base_rate")?.point;
      if (!line || !q.landed || rate === undefined || q.state === "NEEDS_REVIEW") continue;
      head += rate * line.annual_qty;
      land += q.landed.point * line.annual_qty;
      base += line.baseline_price_inr * line.annual_qty;
      n++;
    }
    return { vendor_id: v.vendor_id, lines: n, headline_vs_baseline: base ? head / base - 1 : 0, landed_vs_baseline: base ? land / base - 1 : 0 };
  });
  const priced = rows.filter((r) => r.lines > 0);
  const rank = (key: "headline_vs_baseline" | "landed_vs_baseline", id: string) => [...priced].sort((a, b) => a[key] - b[key]).findIndex((r) => r.vendor_id === id) + 1;
  return rows.map((r) => {
    const headline_rank = r.lines ? rank("headline_vs_baseline", r.vendor_id) : 0;
    const landed_rank = r.lines ? rank("landed_vs_baseline", r.vendor_id) : 0;
    return { ...r, headline_rank, landed_rank, flipped: r.lines > 0 && headline_rank !== landed_rank };
  });
}
