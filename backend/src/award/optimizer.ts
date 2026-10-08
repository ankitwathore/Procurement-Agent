import type { RfxLine } from "../schemas.js";
import type { Quote } from "../ingest/quotes.js";
import type { VendorAssessment } from "../ingest/vendor.js";
import { isSafe, stateRank } from "../model/states.js";
import { evaluateDiscount, type ResolvedDiscount } from "./discounts.js";
import { computeExposure, type Exposure } from "./exposure.js";

/**
 * Award allocator (spec 15). Each line goes to exactly one vendor.
 *
 * This is the unconstrained core: cheapest eligible vendor per line, with the eligibility rules of 15.2,
 * deterministic tie-breaks, and conditional discounts handled by enumerating cases and scoring each on its
 * true cost. Share caps, minimum awards, capacity and bundles need a MIP solver and are not built yet.
 */

export type GateResult = "PASS" | "FAIL" | "UNKNOWN" | "WAIVED";
export type CellPolicy = "trusted_only" | "point" | "risk_adjusted";

export interface VendorInput {
  vendor_id: string;
  quotes: readonly Quote[];
  assessment: VendorAssessment;
  gate: GateResult;
}

export interface Policy {
  gate_policy: "cleared_only" | "include_unknown" | "ignore_gates";
  spec_policy: "strict" | "allow_deviations";
  cell_policy: CellPolicy;
  include_expired_quotes: boolean;
  exclude_vendors: readonly string[];
}

export const DEFAULT_POLICY: Policy = {
  gate_policy: "cleared_only",
  spec_policy: "strict",
  cell_policy: "risk_adjusted",
  include_expired_quotes: false,
  exclude_vendors: [],
};

export interface Ineligible {
  vendor_id: string;
  reason: string;
}

export interface LineAssignment {
  line_id: string;
  vendor_id: string | null;
  quote: Quote | null;
  /** The price the choice was made on, per the cell policy. */
  price: number | null;
  eligible_vendors: string[];
  /** Exactly one vendor could supply this line. A finding for the buyer, not an error. */
  single_source: boolean;
  /** Vendors that could not supply this line, and why. */
  rejected: Ineligible[];
}

export interface DiscountCase {
  /** Vendors whose discount the allocation was solved to chase. */
  assumed: string[];
  /** Vendors whose discount was actually earned on the resulting allocation. */
  earned: string[];
  objective_cost: number;
}

export interface VendorSummary {
  vendor_id: string;
  lines: number;
  value_point: number;
  share_pct: number;
  discount: { pct: number; threshold_inr: number; applies: boolean; amount: number; margin: number } | null;
}

export interface AllocationResult {
  policy: Policy;
  assignments: LineAssignment[];
  unfillable: string[];
  single_source: string[];
  excluded_vendors: Ineligible[];
  vendors: VendorSummary[];
  /** After discounts. low and high use the bounds of unsafe components. */
  cost: { point: number; low: number; high: number };
  exposure: Exposure;
  /** Baseline value (delivered, ex GST, annual volume) of the lines that were filled. */
  baseline_value: number;
  savings: number;
  savings_pct: number;
  discount_cases: DiscountCase[];
  notes: string[];
}

const SPEC_BLOCKERS = new Set(["spec_below_requirement", "spec_dimension_off"]);
const MAX_DISCOUNT_VENDORS = 5;
const EPS = 1e-9;

function vendorReason(v: VendorInput, p: Policy): string | null {
  if (p.exclude_vendors.includes(v.vendor_id)) return "excluded by the buyer";
  if (p.gate_policy !== "ignore_gates") {
    const cleared = v.gate === "PASS" || v.gate === "WAIVED" || (p.gate_policy === "include_unknown" && v.gate === "UNKNOWN");
    if (!cleared) return `not cleared on the questionnaire gates (${v.gate})`;
  }
  if (v.assessment.excluded_by_default && !p.include_expired_quotes) return "quote validity has lapsed";
  return null;
}

function quoteReason(q: Quote | undefined, p: Policy, safe: readonly string[]): string | null {
  if (!q || q.state === "MISSING") return "not quoted";
  if (!q.landed) return `no usable price (${q.state})`;
  if (p.spec_policy === "strict") {
    const blocker = q.spec_flags.find((f) => SPEC_BLOCKERS.has(f.kind));
    if (blocker) return `spec deviation: ${blocker.detail}`;
  }
  if (p.cell_policy === "trusted_only" && q.components.some((c) => !isSafe(c.state, safe))) {
    return "rests on unconfirmed components (trusted only)";
  }
  return null;
}

/** The price a line is chosen on. Risk adjusted uses the high bound for unsafe components only. */
function modePrice(q: Quote, mode: CellPolicy, safe: readonly string[]): number {
  if (mode !== "risk_adjusted") return (q.landed as NonNullable<Quote["landed"]>).point;
  return q.components.reduce((s, c) => s + (isSafe(c.state, safe) ? c.point : c.high), 0);
}

function unsafeValue(q: Quote, safe: readonly string[]): number {
  return q.components.reduce((s, c) => s + (isSafe(c.state, safe) ? 0 : c.point), 0);
}

function worstRank(q: Quote): number {
  return Math.max(...q.components.map((c) => stateRank(c.state)));
}

interface Cell {
  vendor_id: string;
  quote: Quote;
  price: number;
}

/** Cheapest first; ties go to lower exposure, then better states, then vendor id (spec 15.3). */
function compareCells(a: Cell, b: Cell, safe: readonly string[]): number {
  if (Math.abs(a.price - b.price) > EPS) return a.price - b.price;
  const ea = unsafeValue(a.quote, safe);
  const eb = unsafeValue(b.quote, safe);
  if (Math.abs(ea - eb) > EPS) return ea - eb;
  const ra = worstRank(a.quote);
  const rb = worstRank(b.quote);
  if (ra !== rb) return ra - rb;
  return a.vendor_id < b.vendor_id ? -1 : a.vendor_id > b.vendor_id ? 1 : 0;
}

export function allocate(
  lines: readonly RfxLine[],
  vendors: readonly VendorInput[],
  policy: Policy,
  safeStates: readonly string[],
): AllocationResult {
  const notes: string[] = [];
  const excluded_vendors: Ineligible[] = [];
  const active: VendorInput[] = [];
  for (const v of vendors) {
    const why = vendorReason(v, policy);
    if (why) excluded_vendors.push({ vendor_id: v.vendor_id, reason: why });
    else active.push(v);
  }

  // Eligibility per line.
  const cells = new Map<string, Cell[]>();
  const rejected = new Map<string, Ineligible[]>();
  for (const line of lines) {
    const ok: Cell[] = [];
    const no: Ineligible[] = excluded_vendors.map((e) => ({ ...e }));
    for (const v of active) {
      const q = v.quotes.find((x) => x.line_id === line.line_id);
      const why = quoteReason(q, policy, safeStates);
      if (why || !q) no.push({ vendor_id: v.vendor_id, reason: why ?? "not quoted" });
      else ok.push({ vendor_id: v.vendor_id, quote: q, price: modePrice(q, policy.cell_policy, safeStates) });
    }
    cells.set(line.line_id, ok);
    rejected.set(line.line_id, no);
  }

  // Conditional discounts: one discount per vendor is modelled; more than that is noted, not guessed.
  const discounts = new Map<string, ResolvedDiscount>();
  for (const v of active) {
    const ds = v.assessment.conditional_discounts;
    if (ds.length === 1) discounts.set(v.vendor_id, ds[0] as ResolvedDiscount);
    else if (ds.length > 1) notes.push(`${v.vendor_id} has ${ds.length} conditional discounts; none modelled, so its cost may be overstated.`);
  }
  let discountVendors = [...discounts.keys()].sort();
  if (discountVendors.length > MAX_DISCOUNT_VENDORS) {
    notes.push(`More than ${MAX_DISCOUNT_VENDORS} vendors have conditional discounts; none modelled.`);
    discountVendors = [];
  }

  const solve = (assumed: ReadonlySet<string>): Map<string, Cell | null> => {
    const out = new Map<string, Cell | null>();
    for (const line of lines) {
      const adjusted = (cells.get(line.line_id) ?? []).map((c) => {
        const d = assumed.has(c.vendor_id) ? discounts.get(c.vendor_id) : undefined;
        return d ? { ...c, price: c.price * (1 - d.pct / 100) } : c;
      });
      adjusted.sort((a, b) => compareCells(a, b, safeStates));
      const best = adjusted[0];
      // Keep the unadjusted cell so reported prices are the vendor's own.
      out.set(line.line_id, best ? ((cells.get(line.line_id) ?? []).find((c) => c.vendor_id === best.vendor_id) as Cell) : null);
    }
    return out;
  };

  const lineQty = new Map(lines.map((l) => [l.line_id, l.annual_qty]));
  const vendorValues = (choice: Map<string, Cell | null>, pick: (q: Quote) => number): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const [lineId, cell] of choice) {
      if (!cell) continue;
      totals.set(cell.vendor_id, (totals.get(cell.vendor_id) ?? 0) + (lineQty.get(lineId) as number) * pick(cell.quote));
    }
    return totals;
  };
  const earnedDiscounts = (choice: Map<string, Cell | null>): Set<string> => {
    const point = vendorValues(choice, (q) => (q.landed as NonNullable<Quote["landed"]>).point);
    const earned = new Set<string>();
    for (const [vid, d] of discounts) {
      if (evaluateDiscount(point.get(vid) ?? 0, d).applies) earned.add(vid);
    }
    return earned;
  };
  const objective = (choice: Map<string, Cell | null>): number => {
    const modeValue = vendorValues(choice, (q) => modePrice(q, policy.cell_policy, safeStates));
    let total = 0;
    for (const v of modeValue.values()) total += v;
    for (const vid of earnedDiscounts(choice)) total -= ((modeValue.get(vid) ?? 0) * (discounts.get(vid) as ResolvedDiscount).pct) / 100;
    return total;
  };

  // Enumerate which discounts to chase, score each allocation on what it truly earns, keep the cheapest.
  const subsets: string[][] = [[]];
  for (const vid of discountVendors) subsets.push(...subsets.map((s) => [...s, vid]));
  let best: { choice: Map<string, Cell | null>; cost: number } | null = null;
  const discount_cases: DiscountCase[] = [];
  for (const subset of subsets) {
    const choice = solve(new Set(subset));
    const cost = objective(choice);
    discount_cases.push({ assumed: subset, earned: [...earnedDiscounts(choice)].sort(), objective_cost: cost });
    if (!best || cost < best.cost - EPS) best = { choice, cost };
  }
  const choice = (best as NonNullable<typeof best>).choice;

  const assignments: LineAssignment[] = lines.map((line) => {
    const cell = choice.get(line.line_id) ?? null;
    const eligible = (cells.get(line.line_id) ?? []).map((c) => c.vendor_id);
    return {
      line_id: line.line_id,
      vendor_id: cell?.vendor_id ?? null,
      quote: cell?.quote ?? null,
      price: cell?.price ?? null,
      eligible_vendors: eligible,
      single_source: eligible.length === 1,
      rejected: rejected.get(line.line_id) ?? [],
    };
  });

  const filled = assignments.filter((a) => a.quote !== null);
  const point = vendorValues(choice, (q) => (q.landed as NonNullable<Quote["landed"]>).point);
  const low = vendorValues(choice, (q) => (q.landed as NonNullable<Quote["landed"]>).low);
  const high = vendorValues(choice, (q) => (q.landed as NonNullable<Quote["landed"]>).high);
  const earned = earnedDiscounts(choice);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);
  const discountOff = (m: Map<string, number>) =>
    [...earned].reduce((s, vid) => s + ((m.get(vid) ?? 0) * (discounts.get(vid) as ResolvedDiscount).pct) / 100, 0);
  const cost = {
    point: sum(point) - discountOff(point),
    low: sum(low) - discountOff(low),
    high: sum(high) - discountOff(high),
  };

  const grossPoint = sum(point);
  const vendorsSummary: VendorSummary[] = [...point.keys()].sort().map((vid) => {
    const d = discounts.get(vid);
    const ev = d ? evaluateDiscount(point.get(vid) as number, d) : null;
    return {
      vendor_id: vid,
      lines: filled.filter((a) => a.vendor_id === vid).length,
      value_point: point.get(vid) as number,
      share_pct: grossPoint === 0 ? 0 : ((point.get(vid) as number) / grossPoint) * 100,
      discount: d && ev ? { pct: d.pct, threshold_inr: d.threshold_inr, applies: ev.applies, amount: ev.amount, margin: ev.margin } : null,
    };
  });

  const baseline_value = filled.reduce((s, a) => {
    const line = lines.find((l) => l.line_id === a.line_id) as RfxLine;
    return s + line.annual_qty * line.baseline_price_inr;
  }, 0);
  const savings = baseline_value - cost.point;

  return {
    policy,
    assignments,
    unfillable: assignments.filter((a) => a.vendor_id === null).map((a) => a.line_id),
    single_source: assignments.filter((a) => a.single_source).map((a) => a.line_id),
    excluded_vendors,
    vendors: vendorsSummary,
    cost,
    exposure: computeExposure(
      filled.map((a) => ({ quote: a.quote as Quote, annual_qty: lineQty.get(a.line_id) as number })),
      safeStates,
    ),
    baseline_value,
    savings,
    savings_pct: baseline_value === 0 ? 0 : (savings / baseline_value) * 100,
    discount_cases,
    notes,
  };
}
