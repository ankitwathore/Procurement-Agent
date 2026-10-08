import type { Config } from "../config.js";

/**
 * Deterministic outlier and magnitude-slip check (spec 10.6, edge X03).
 * Compares a normalized rate (INR per base UoM, ex GST, before freight) with peers and the baseline.
 * A suggested reading is reported, never applied.
 */

export type Tolerances = Pick<Config["tolerances"], "outlier_vs_peer_median" | "outlier_vs_baseline" | "magnitude_slip_ratios">;

/** A ratio within this fraction of 10, 100, 1000 or 12 is treated as a probable slip. */
export const SLIP_TOLERANCE = 0.05;

/** Fewer peers than this and the median says too little to judge against. */
export const MIN_PEERS = 2;

export interface MagnitudeSlip {
  /** The slip factor matched, e.g. 10 for a dropped decimal point. */
  factor: number;
  against: "peer_median" | "baseline";
  reference: number;
  /** Rate multiplied or divided by the factor. A suggestion for the buyer only. */
  suggested_rate: number;
}

export interface OutlierResult {
  hardOutlier: boolean;
  reasons: string[];
  slip: MagnitudeSlip | null;
}

export interface LineTotalResult {
  expected: number;
  stated: number;
  diff_pct: number;
  fails: boolean;
}

/**
 * Quantity x rate against the vendor's own line total (spec X02).
 * Returns null when the vendor stated no total, so nothing is checked and nothing is assumed.
 */
export function checkLineTotal(
  input: { quantity: number; rate: number; statedTotal: number | null },
  tolerancePct: number,
): LineTotalResult | null {
  if (input.statedTotal === null) return null;
  const expected = input.quantity * input.rate;
  const diffPct = (Math.abs(input.statedTotal - expected) / expected) * 100;
  return { expected, stated: input.statedTotal, diff_pct: diffPct, fails: diffPct > tolerancePct };
}

export type SpecFlagKind = "spec_below_requirement" | "spec_dimension_off" | "spec_upgrade" | "spec_print_differs";

export interface SpecFlag {
  kind: SpecFlagKind;
  field: "ply" | "liner_gsm" | "bf" | "dims_mm" | "print";
  required: string | number;
  offered: string | number;
  detail: string;
  /** Where the evidence came from: the vendor's own offer (default) or its test report. */
  source?: "offer" | "test_report";
}

/** What the vendor says it is offering. Anything the vendor did not state is simply absent. */
export interface SpecOffered {
  ply?: number | null;
  liner_gsm?: number | null;
  bf?: number | null;
  dims_mm?: number[] | null;
  print?: string | null;
}

export interface RequiredSpec {
  ply: number | null;
  liner_gsm: number | null;
  bf: number | null;
  dims_text: string;
  print: string;
}

/** "440x330x310" -> [440, 330, 310]; "1500 wide" -> [1500]. */
export function parseDims(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

const normPrint = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Offered spec against the RFx line (spec 10.6, S01, S02, S04, S06).
 * Fields the vendor did not state are listed in `unstated`, never judged.
 * Dimensions are compared largest to smallest so a vendor's different axis order does not trigger a flag.
 * A cell that is below requirement or off in size is still a correct price; whether it may win is a policy decision later.
 */
export function checkSpec(
  required: RequiredSpec,
  offered: SpecOffered | null | undefined,
  dimTolerancePct: number,
): { flags: SpecFlag[]; unstated: string[] } {
  const below: SpecFlag[] = [];
  const above: SpecFlag[] = [];
  const other: SpecFlag[] = [];
  const unstated: string[] = [];

  for (const field of ["ply", "liner_gsm", "bf"] as const) {
    const need = required[field];
    if (need === null) continue;
    const got = offered?.[field];
    if (got === null || got === undefined) {
      unstated.push(field);
    } else if (got < need) {
      below.push({ kind: "spec_below_requirement", field, required: need, offered: got, detail: `${field} ${got} offered vs ${need} required` });
    } else if (got > need) {
      above.push({ kind: "spec_upgrade", field, required: need, offered: got, detail: `${field} ${got} offered vs ${need} required` });
    }
  }

  const needDims = parseDims(required.dims_text);
  const gotDims = offered?.dims_mm;
  if (!gotDims) {
    unstated.push("dims_mm");
  } else if (gotDims.length === needDims.length) {
    const need = [...needDims].sort((a, b) => b - a);
    const got = [...gotDims].sort((a, b) => b - a);
    // The epsilon keeps the tolerance edge inclusive despite float error (448.8 vs 440 is 2.0000000000000018 percent).
    const off = need.some((n, i) => (Math.abs((got[i] as number) - n) / n) * 100 > dimTolerancePct + 1e-9);
    if (off) {
      other.push({
        kind: "spec_dimension_off",
        field: "dims_mm",
        required: needDims.join("x"),
        offered: gotDims.join("x"),
        detail: `dimensions ${gotDims.join("x")} offered vs ${needDims.join("x")} required (tolerance ${dimTolerancePct}%)`,
      });
    }
  } else {
    unstated.push("dims_mm");
  }

  const gotPrint = offered?.print;
  if (gotPrint === null || gotPrint === undefined) {
    unstated.push("print");
  } else if (normPrint(gotPrint) !== normPrint(required.print)) {
    other.push({ kind: "spec_print_differs", field: "print", required: required.print, offered: gotPrint, detail: `print "${gotPrint}" offered vs "${required.print}" required` });
  }

  // An upgrade is only worth noting when nothing is below requirement.
  return { flags: [...below, ...(below.length === 0 ? above : []), ...other], unstated };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function findSlip(rate: number, reference: number, factors: readonly number[]): { factor: number; suggested: number } | null {
  for (const factor of factors) {
    if (Math.abs(reference / rate / factor - 1) <= SLIP_TOLERANCE) return { factor, suggested: rate * factor };
    if (Math.abs(rate / reference / factor - 1) <= SLIP_TOLERANCE) return { factor, suggested: rate / factor };
  }
  return null;
}

export function checkOutlier(
  rate: number,
  peerRates: readonly number[],
  baseline: number | null,
  tolerances: Tolerances,
): OutlierResult {
  const reasons: string[] = [];
  let slip: MagnitudeSlip | null = null;

  const references: { against: MagnitudeSlip["against"]; value: number; band: readonly [number, number] }[] = [];
  if (peerRates.length >= MIN_PEERS) {
    references.push({ against: "peer_median", value: median(peerRates), band: tolerances.outlier_vs_peer_median });
  }
  if (baseline !== null && baseline > 0) {
    references.push({ against: "baseline", value: baseline, band: tolerances.outlier_vs_baseline });
  }

  for (const ref of references) {
    const label = ref.against === "peer_median" ? "peer median" : "baseline";
    const found: ReturnType<typeof findSlip> = slip ? null : findSlip(rate, ref.value, tolerances.magnitude_slip_ratios);
    if (found) {
      slip = { factor: found.factor, against: ref.against, reference: ref.value, suggested_rate: found.suggested };
      reasons.push(`${rate} is about 1/${found.factor} or ${found.factor}x the ${label} ${ref.value}; probable unit or decimal slip`);
      continue;
    }
    const ratio = rate / ref.value;
    if (ratio < ref.band[0] || ratio > ref.band[1]) {
      reasons.push(`${rate} is ${ratio.toFixed(2)}x the ${label} ${ref.value} (allowed ${ref.band[0]} to ${ref.band[1]})`);
    }
  }

  return { hardOutlier: reasons.length > 0, reasons, slip };
}
