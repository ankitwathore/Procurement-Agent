import type { Config } from "../config.js";
import { resolveDiscount, type ResolvedDiscount } from "../award/discounts.js";
import { addDays, datePart, isIsoDate } from "../util/dates.js";
import type { Extraction } from "./extraction.js";

/**
 * Vendor-level checks: price validity and lateness (spec 10.6, T04, V03).
 * Date arithmetic lives here, not in the model: the model reports "15 days from 2026-09-18", code computes the expiry.
 */

export type ValidityStatus = "ok" | "lapsed" | "expiring" | "not_stated";
export type VendorDiscrepancyKind =
  | "validity_lapsed"
  | "validity_expiring"
  | "validity_not_stated"
  | "late_reply"
  | "conditional_discount"
  | "fx_clause";

export interface VendorDiscrepancy {
  kind: VendorDiscrepancyKind;
  severity: "info" | "warn" | "high";
  detail: string;
}

export interface VendorAssessment {
  validity: {
    status: ValidityStatus;
    valid_until: string | null;
    source: "stated" | "computed" | null;
    snippet: string | null;
  };
  /** Lapsed quotes are left out of the optimizer unless the buyer includes them (spec T04). */
  excluded_by_default: boolean;
  late: boolean;
  /** Threshold discounts the optimizer must evaluate as cases. Not applied to any per-line price. */
  conditional_discounts: ResolvedDiscount[];
  discrepancies: VendorDiscrepancy[];
}

type Validity = NonNullable<Extraction["vendor_terms"]["validity"]>;
type DateConfig = Pick<Config, "as_of_date" | "expected_award_date" | "rfx_due_date">;

/** An explicit valid_until wins; otherwise it is computed from a start date and a number of days. */
export function resolveValidUntil(v: Validity | undefined): { date: string; source: "stated" | "computed" } | null {
  if (!v) return null;
  if (v.valid_until && isIsoDate(v.valid_until)) return { date: v.valid_until, source: "stated" };
  if (v.from_date && v.valid_days !== undefined && isIsoDate(v.from_date)) {
    return { date: addDays(v.from_date, v.valid_days), source: "computed" };
  }
  return null;
}

export function assessVendor(
  terms: Extraction["vendor_terms"],
  receivedAt: string | undefined,
  cfg: DateConfig,
): VendorAssessment {
  const discrepancies: VendorDiscrepancy[] = [];
  const resolved = resolveValidUntil(terms.validity);

  let status: ValidityStatus;
  if (!resolved) {
    status = "not_stated";
    discrepancies.push({ kind: "validity_not_stated", severity: "warn", detail: "The vendor did not state how long the prices are valid." });
  } else if (resolved.date < cfg.as_of_date) {
    status = "lapsed";
    discrepancies.push({
      kind: "validity_lapsed",
      severity: "high",
      detail: `Prices were valid until ${resolved.date}, before today (${cfg.as_of_date}).`,
    });
  } else if (resolved.date < cfg.expected_award_date) {
    status = "expiring";
    discrepancies.push({
      kind: "validity_expiring",
      severity: "warn",
      detail: `Prices are valid until ${resolved.date}, before the expected award date (${cfg.expected_award_date}).`,
    });
  } else {
    status = "ok";
  }

  const received = receivedAt ? datePart(receivedAt) : null;
  const late = received !== null && received > cfg.rfx_due_date;
  if (late) {
    discrepancies.push({
      kind: "late_reply",
      severity: "warn",
      detail: `Received ${received}, after the due date (${cfg.rfx_due_date}). Accepted and flagged; the buyer decides.`,
    });
  }

  const conditional_discounts: ResolvedDiscount[] = [];
  for (const raw of terms.conditional_discounts ?? []) {
    const resolved = resolveDiscount(raw);
    if (!resolved) {
      discrepancies.push({
        kind: "conditional_discount",
        severity: "warn",
        detail: `A conditional discount was offered but could not be read ("${raw.condition_text}"). Not applied.`,
      });
      continue;
    }
    conditional_discounts.push(resolved);
    discrepancies.push({
      kind: "conditional_discount",
      severity: "info",
      detail: `${resolved.pct}% discount applies only if this vendor's total value is ${resolved.inclusive ? "at least" : "above"} Rs ${resolved.threshold_inr.toLocaleString("en-IN")}.`,
    });
  }

  if (terms.fx_clause) {
    discrepancies.push({
      kind: "fx_clause",
      severity: "info",
      detail: `Foreign currency prices are subject to the rate at the order date: "${terms.fx_clause.value_text}". A band is applied.`,
    });
  }

  return {
    validity: {
      status,
      valid_until: resolved?.date ?? null,
      source: resolved?.source ?? null,
      snippet: terms.validity?.snippet ?? null,
    },
    excluded_by_default: status === "lapsed",
    late,
    conditional_discounts,
    discrepancies,
  };
}
