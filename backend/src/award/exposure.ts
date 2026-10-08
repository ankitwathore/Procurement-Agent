import type { ComponentKind, Quote } from "../ingest/quotes.js";
import { isSafe, type CellState } from "../model/states.js";

export interface AllocatedQuote {
  quote: Quote;
  annual_qty: number;
}

export interface UnsafeComponent {
  vendor_id: string;
  line_id: string;
  kind: ComponentKind;
  state: CellState;
  /** Rupees at stake: annual quantity x the larger of the point and high readings. */
  value_inr: number;
  /** Annual quantity x the point reading, for reference. */
  value_point_inr: number;
}

export interface Exposure {
  cost_point: number;
  cost_low: number;
  cost_high: number;
  /** Rupees resting on unsafe components, each valued at max(point, high). */
  exposure_inr: number;
  /** exposure_inr as a share of `risk_cost`. */
  exposure_pct: number;
  /** Safe components at point plus unsafe components at max(point, high): the denominator for exposure_pct. */
  risk_cost: number;
  unsafe_component_count: number;
  /** Sorted by rupee value, largest first. */
  unsafe: UnsafeComponent[];
}

/**
 * Spec 8.5, with one deliberate change: an unsafe component is valued at max(point, high), not at its point.
 * A magnitude slip's point is the low reading (V1 L06 at 11.08 for an intended 110.81), and valuing it at the
 * point understated the exposure about tenfold, so the award gate let it through without acknowledgment.
 * Lines with no usable price contribute nothing.
 */
export function computeExposure(allocation: readonly AllocatedQuote[], safeStates: readonly string[]): Exposure {
  let costPoint = 0;
  let costLow = 0;
  let costHigh = 0;
  let riskCost = 0;
  const unsafe: UnsafeComponent[] = [];

  for (const { quote, annual_qty } of allocation) {
    for (const c of quote.components) {
      costPoint += annual_qty * c.point;
      costLow += annual_qty * c.low;
      costHigh += annual_qty * c.high;
      if (isSafe(c.state, safeStates)) {
        riskCost += annual_qty * c.point;
        continue;
      }
      const atStake = annual_qty * Math.max(c.point, c.high);
      riskCost += atStake;
      unsafe.push({
        vendor_id: quote.vendor_id,
        line_id: quote.line_id,
        kind: c.kind,
        state: c.state,
        value_inr: atStake,
        value_point_inr: annual_qty * c.point,
      });
    }
  }

  unsafe.sort((a, b) => b.value_inr - a.value_inr);
  const exposure = unsafe.reduce((s, u) => s + u.value_inr, 0);
  return {
    cost_point: costPoint,
    cost_low: costLow,
    cost_high: costHigh,
    exposure_inr: exposure,
    exposure_pct: riskCost === 0 ? 0 : (exposure / riskCost) * 100,
    risk_cost: riskCost,
    unsafe_component_count: unsafe.length,
    unsafe,
  };
}
