import { describe, expect, it } from "vitest";
import { rankings } from "../src/award/rankings.js";
import type { Quote } from "../src/ingest/quotes.js";
import type { RfxLine } from "../src/schemas.js";

/** Headline versus landed ranking (spec 18.4, trap 33). */

const lines = [
  { line_id: "L01", annual_qty: 1000, baseline_price_inr: 10 },
  { line_id: "L02", annual_qty: 100, baseline_price_inr: 100 },
] as unknown as RfxLine[];

const q = (line_id: string, rate: number, landed: number, state = "CONFIRMED"): Quote =>
  ({ line_id, state, components: [{ kind: "base_rate", point: rate }], landed: { point: landed, low: landed, high: landed } }) as unknown as Quote;

describe("rankings", () => {
  it("an ex works vendor cheapest on paper but dearest delivered is flipped; a delivered vendor is not", () => {
    const r = rankings(
      [
        { vendor_id: "EXW", quotes: [q("L01", 9, 11), q("L02", 90, 110)] }, // -10% headline, +10% landed
        { vendor_id: "DEL", quotes: [q("L01", 10, 10), q("L02", 100, 100)] }, // 0% both
      ],
      lines,
    );
    expect(r[0]).toMatchObject({ vendor_id: "EXW", lines: 2, headline_rank: 1, landed_rank: 2, flipped: true });
    expect(r[0]!.headline_vs_baseline).toBeCloseTo(-0.1, 9);
    expect(r[0]!.landed_vs_baseline).toBeCloseTo(0.1, 9);
    expect(r[1]).toMatchObject({ vendor_id: "DEL", headline_rank: 2, landed_rank: 1, flipped: true });
  });

  it("lines needing review and unpriced lines are left out; a vendor with none priced is unranked", () => {
    const r = rankings(
      [
        { vendor_id: "A", quotes: [q("L01", 1, 1, "NEEDS_REVIEW"), q("L02", 95, 95)] },
        { vendor_id: "B", quotes: [{ ...q("L01", 9, 9), landed: null } as Quote] },
      ],
      lines,
    );
    expect(r[0]).toMatchObject({ lines: 1, headline_rank: 1, landed_rank: 1, flipped: false });
    expect(r[0]!.headline_vs_baseline).toBeCloseTo(-0.05, 9);
    expect(r[1]).toMatchObject({ lines: 0, headline_rank: 0, landed_rank: 0, flipped: false });
  });
});
