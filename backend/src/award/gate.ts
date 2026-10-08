import type { Config } from "../config.js";
import { formatRupees } from "../util/format.js";
import type { AllocationResult } from "./optimizer.js";
import type { UnsafeComponent } from "./exposure.js";

/**
 * Award confirmation gate (spec 15.6, TR02). Pure functions over an allocation result.
 *
 *   exposure over the block limit        -> blocked until it is reduced
 *   exposure over the acknowledge limit  -> buyer must acknowledge every unsafe component
 *   otherwise                            -> allowed
 */

export type GateStatus = "allowed" | "acknowledge" | "blocked";

export interface AckItem extends UnsafeComponent {
  /** vendor:line:component, the key the buyer's acknowledgment must cover. */
  id: string;
}

export interface AwardGate {
  status: GateStatus;
  exposure_inr: number;
  exposure_pct: number;
  unsafe_component_count: number;
  /** The sentence for the award screen and every priced analyst answer. */
  headline: string;
  /** Why it is blocked, in plain words. Empty unless blocked. */
  blocked_reasons: string[];
  /** Every unsafe component the buyer must acknowledge. Empty unless status is "acknowledge". */
  required_acknowledgments: AckItem[];
  /** The biggest unsafe components, largest first, to resolve first. */
  resolve_first: AckItem[];
  /** Things worth knowing that do not block: unfillable and single-source lines. */
  warnings: string[];
}

type GateConfig = Pick<Config["award_gate"], "block_if_exposure_pct_over" | "require_ack_if_exposure_pct_over">;

/** Float noise must not move a value across a threshold it sits exactly on. */
const EPS = 1e-9;
const RESOLVE_FIRST = 3;

export const unsafeId = (u: Pick<UnsafeComponent, "vendor_id" | "line_id" | "kind">): string => `${u.vendor_id}:${u.line_id}:${u.kind}`;

function toAck(u: UnsafeComponent): AckItem {
  return { ...u, id: unsafeId(u) };
}

export function evaluateGate(result: AllocationResult, cfg: GateConfig): AwardGate {
  const { exposure } = result;
  const unsafe = exposure.unsafe.map(toAck);
  const filled = result.assignments.filter((a) => a.vendor_id !== null).length;
  const n = exposure.unsafe_component_count;

  const warnings: string[] = [];
  if (result.unfillable.length > 0) warnings.push(`${result.unfillable.length} line(s) could not be awarded: ${result.unfillable.join(", ")}.`);
  if (result.single_source.length > 0) warnings.push(`${result.single_source.length} line(s) have a single eligible vendor: ${result.single_source.join(", ")}.`);

  const blocked_reasons: string[] = [];
  if (filled === 0) {
    blocked_reasons.push("No line could be awarded under the current constraints.");
  } else if (exposure.exposure_pct > cfg.block_if_exposure_pct_over + EPS) {
    blocked_reasons.push(
      `${exposure.exposure_pct.toFixed(1)}% of the award rests on unconfirmed components, above the ${cfg.block_if_exposure_pct_over}% limit. Verify, clarify or change the allocation first.`,
    );
  }

  let status: GateStatus;
  if (blocked_reasons.length > 0) status = "blocked";
  else if (exposure.exposure_pct > cfg.require_ack_if_exposure_pct_over + EPS) status = "acknowledge";
  else status = "allowed";

  const headline =
    n === 0
      ? "Every component of this award is confirmed."
      : `${formatRupees(exposure.exposure_inr)} of this award rests on ${n} unconfirmed component${n === 1 ? "" : "s"}.`;

  return {
    status,
    exposure_inr: exposure.exposure_inr,
    exposure_pct: exposure.exposure_pct,
    unsafe_component_count: n,
    headline,
    blocked_reasons,
    required_acknowledgments: status === "acknowledge" ? unsafe : [],
    resolve_first: unsafe.slice(0, RESOLVE_FIRST),
    warnings,
  };
}

export interface AwardRecord {
  confirmed_at: string;
  actor: string;
  exposure_inr: number;
  exposure_pct: number;
  cost: AllocationResult["cost"];
  /** What the buyer acknowledged. Stored with the award for the audit trail. */
  acknowledged_ids: string[];
  warnings: string[];
}

export type ConfirmResult =
  | { ok: true; record: AwardRecord }
  | { ok: false; reason: string; missing_acknowledgments?: string[] };

/** Confirms an award only when the gate allows it. Acknowledgments must cover every required item. */
export function confirmAward(
  result: AllocationResult,
  gate: AwardGate,
  acknowledgedIds: readonly string[],
  who: { actor: string; at: string },
): ConfirmResult {
  if (gate.status === "blocked") {
    return { ok: false, reason: gate.blocked_reasons.join(" ") };
  }
  const given = new Set(acknowledgedIds);
  const missing = gate.required_acknowledgments.map((a) => a.id).filter((id) => !given.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Acknowledge all ${gate.required_acknowledgments.length} unconfirmed components before confirming (${missing.length} outstanding).`,
      missing_acknowledgments: missing,
    };
  }
  return {
    ok: true,
    record: {
      confirmed_at: who.at,
      actor: who.actor,
      exposure_inr: gate.exposure_inr,
      exposure_pct: gate.exposure_pct,
      cost: result.cost,
      acknowledged_ids: gate.required_acknowledgments.map((a) => a.id),
      warnings: gate.warnings,
    },
  };
}
