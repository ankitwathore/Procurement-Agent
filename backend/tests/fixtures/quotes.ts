import { DEFAULT_POLICY, allocate, type GateResult, type Policy, type VendorInput } from "../../src/award/optimizer.js";
import { loadConfig } from "../../src/config.js";
import { RFX_LINES } from "../../src/data/rfx.js";
import type { Component, Quote } from "../../src/ingest/quotes.js";
import type { VendorAssessment } from "../../src/ingest/vendor.js";
import type { CellState } from "../../src/model/states.js";

/** Synthetic quotes for scenarios that do not need the extraction pipeline. */

export const config = loadConfig();
export const SAFE = config.exposure.safe_states;
export const L = (id: string) => RFX_LINES.find((l) => l.line_id === id)!;

export interface QOpts {
  state?: CellState;
  low?: number;
  high?: number;
  specKinds?: string[];
}

/** A quote built from explicit components. */
export function qc(vendor: string, line: string, components: Component[], specKinds: string[] = []): Quote {
  const landed = components.reduce(
    (t, c) => ({ point: t.point + c.point, low: t.low + c.low, high: t.high + c.high }),
    { point: 0, low: 0, high: 0 },
  );
  const worst = components.some((c) => c.state === "INFERRED") ? "INFERRED" : (components[0]?.state ?? "CONFIRMED");
  return {
    vendor_id: vendor,
    line_id: line,
    state: worst,
    state_rule: 10,
    state_reason: "",
    components,
    landed,
    chain: [],
    assumptions: [],
    flags: [],
    suggested_reading: null,
    arithmetic: null,
    spec_flags: specKinds.map((kind) => ({ kind: kind as never, field: "bf", required: 18, offered: 16, detail: "bf 16 offered vs 18 required" })),
    spec_unstated: [],
    hidden_values: [],
    reconciliation: null,
  };
}

export function comp(kind: "base_rate" | "freight", point: number, state: CellState = "CONFIRMED", low = point, high = point): Component {
  return { kind, point, low, high, state, basis: "stated", provenance: { locator: {}, snippet: "" } };
}

/** A one-component quote. */
export function q(vendor: string, line: string, point: number, o: QOpts = {}): Quote {
  return qc(vendor, line, [comp("base_rate", point, o.state ?? "CONFIRMED", o.low ?? point, o.high ?? point)], o.specKinds);
}

export function assessment(o: { lapsed?: boolean; discount?: { pct: number; threshold_inr: number } } = {}): VendorAssessment {
  return {
    validity: { status: o.lapsed ? "lapsed" : "ok", valid_until: null, source: null, snippet: null },
    excluded_by_default: o.lapsed ?? false,
    late: false,
    conditional_discounts: o.discount ? [{ ...o.discount, inclusive: true, condition_text: "", snippet: "" }] : [],
    discrepancies: [],
  };
}

export function vendor(id: string, quotes: Quote[], gate: GateResult = "PASS", a: VendorAssessment = assessment()): VendorInput {
  return { vendor_id: id, quotes, assessment: a, gate };
}

export const run = (lines: string[], vendors: VendorInput[], policy: Partial<Policy> = {}) =>
  allocate(lines.map(L), vendors, { ...DEFAULT_POLICY, ...policy }, SAFE);
