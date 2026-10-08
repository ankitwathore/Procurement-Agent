/** Typed calls to the QuoteKill API. Only the fields the screens use are typed. */

export type CellState = "CONFIRMED" | "HIGH_CONF" | "BUYER_VERIFIED" | "INFERRED" | "NEEDS_REVIEW" | "MISSING";

export interface CellSummary {
  state: CellState;
  point: number | null;
  low: number | null;
  high: number | null;
  rate: number | null;
  reason: string;
  flags: string[];
  unsafe: boolean;
}

export interface Best {
  vendor_id: string;
  point: number;
  state: CellState;
}

export interface Confirmation {
  id: string;
  vendor_id: string;
  kind: string;
  fields: string[];
  lines: string[];
  snippets: string[];
  question: string;
}

export interface OpenItem {
  vendor_id: string;
  line_id: string;
  kind: string;
  state: CellState;
  value_inr: number;
  why: string;
  action: "confirm" | "review" | "clarify" | "none";
  confirmation_id?: string;
}

export interface DecisionLog {
  confirmation_id: string;
  decision: "confirmed" | "rejected";
  lines: string[];
  actor: string;
  at: string;
  reason: string;
}

export interface Comparison {
  set: string;
  rfx: { id: string; title: string; as_of: string; fx: number; fx_date: string; due: string };
  vendors: {
    vendor_id: string;
    name: string;
    city: string;
    format: string;
    coverage: { quoted: number; total: number };
    gate: string;
    gate_headline: string;
    validity: string;
    freight: string;
    trusted_value: number;
    total_value: number;
    injection: boolean;
    ranking: { lines: number; headline_vs_baseline: number; landed_vs_baseline: number; headline_rank: number; landed_rank: number; flipped: boolean };
  }[];
  lines: {
    line_id: string;
    description: string;
    spec: string;
    base_uom: string;
    annual_qty: number;
    baseline: number;
    cells: Record<string, CellSummary>;
    best: Best | null;
    best_trusted: Best | null;
  }[];
  open_items: OpenItem[];
  confirmations: Confirmation[];
  decisions: DecisionLog[];
}

export interface SourceExcerpt {
  kind: string;
  file: string;
  snippet: string;
  locator: Record<string, unknown>;
  lines: { text: string; highlight: boolean; muted: boolean }[];
  note: string | null;
}

export interface Component {
  kind: string;
  point: number;
  low: number;
  high: number;
  state: CellState;
  basis: string;
  provenance: { locator: Record<string, unknown>; snippet: string };
}

export interface Quote {
  vendor_id: string;
  line_id: string;
  state: CellState;
  state_rule: number;
  state_reason: string;
  components: Component[];
  landed: { point: number; low: number; high: number } | null;
  chain: string[];
  assumptions: string[];
  flags: string[];
  suggested_reading: { suggested_rate: number; factor: number; against: string; reference: number } | null;
  arithmetic: { stated: number; expected: number; diff_pct: number; fails: boolean } | null;
  spec_flags: { kind: string; field: string; required: string | number; offered: string | number; detail: string; source?: string }[];
  spec_unstated: string[];
  hidden_values: { value: number | null; snippet: string; locator: Record<string, unknown> }[];
  reconciliation: {
    status: string;
    detail: string;
    readings: { pass: string; value: number | null; currency: string; unit: string | null; snippet: string }[];
    adjudication?: { decision: string; reasoning: string; model: string | null };
  } | null;
  history?: { state: CellState; state_reason: string; landed: Quote["landed"]; replaced_by: string; replaced_at: string }[];
}

export interface CellDetail {
  vendor: { vendor_id: string; name: string };
  line: { line_id: string; description: string; spec_text: string; base_uom: string; annual_qty: number; baseline_price_inr: number };
  quote: Quote | null;
  summary: CellSummary;
  rate_component: Component | null;
  sources: (SourceExcerpt & { component: string })[];
  readings: { pass: string; value: number | null; currency: string; unit: string | null; snippet: string; source: SourceExcerpt }[];
  confirmation: Confirmation | null;
}

export interface GateOutcome {
  q_id: string;
  result: string;
  reason: string;
  waiver: { reason: string; actor: string } | null;
}

export interface VendorDetail {
  vendor: { vendor_id: string; name: string; city: string; contact_name: string; contact_email: string; file: string; run_file: string; format: string };
  coverage: { quoted: number; total: number };
  states: Record<string, number>;
  terms: { term: string; value: string; snippet: string }[];
  validity: { status: string; valid_until: string | null; source: string | null; snippet: string | null };
  late: boolean;
  excluded_by_default: boolean;
  discounts: { pct: number; threshold_inr: number; condition_text: string; snippet: string }[];
  gates: { overall: string; headline: string; gates: GateOutcome[] };
  answers: Record<string, string>;
  certificate: { cert_type: string; number: string | null; issuer: string | null; entity_name: string | null; valid_from: string | null; valid_to: string | null; scope: string | null } | null;
  test_report: { lab: string | null; report_no: string | null; report_date: string | null; samples: { ply: number | null; flute?: string | null; liner_gsm?: number | null; bf?: number | null }[] } | null;
  evidence_docs: { role: string; file: string; read: boolean }[];
  report_findings: { line_id: string; detail: string }[];
  discrepancies: { kind: string; detail: string }[];
  extras: { description: string; rate: { value: number | null; currency: string; unit_as_written: string | null }; snippet: string }[];
  rejected: { row_id: string; reason: string }[];
  injection: string[];
  notes: string[];
}

export interface Award {
  policy: { gate_policy: string; spec_policy: string; cell_policy: string; include_expired_quotes: boolean };
  result: {
    assignments: { line_id: string; vendor_id: string | null; price: number | null; single_source: boolean; eligible_vendors: string[]; rejected: { vendor_id: string; reason: string }[]; quote: { state: CellState; landed: Quote["landed"] } | null }[];
    unfillable: string[];
    single_source: string[];
    excluded_vendors: { vendor_id: string; reason: string }[];
    vendors: { vendor_id: string; lines: number; value_point: number; share_pct: number; discount: { pct: number; threshold_inr: number; applies: boolean; amount: number; margin: number } | null }[];
    cost: { point: number; low: number; high: number };
    baseline_value: number;
    savings: number;
    savings_pct: number;
    notes: string[];
  };
  gate: {
    status: "allowed" | "acknowledge" | "blocked";
    exposure_inr: number;
    exposure_pct: number;
    unsafe_component_count: number;
    headline: string;
    blocked_reasons: string[];
    resolve_first: { id: string; vendor_id: string; line_id: string; kind: string; state: CellState; value_inr: number }[];
    required_acknowledgments: { id: string; vendor_id: string; line_id: string; kind: string; state: CellState; value_inr: number }[];
    warnings: string[];
  };
}

export interface ClarificationDraft {
  vendor_id: string;
  message_id: string;
  to: string;
  subject: string;
  body: string;
  status: "drafted" | "blocked";
  guard: { ok: boolean; problems: { kind: string; text: string; detail: string }[] };
}

export interface AwardRecord {
  award_id: string;
  confirmed_at: string;
  actor: string;
  exposure_inr: number;
  acknowledged: string[];
  superseded: boolean;
  scenario: { constraints: Record<string, unknown>; result: { cost: { point: number; low: number; high: number }; savings: number; vendors: { vendor_id: string; share_pct: number; lines: number }[]; unfillable: string[]; exposure_pct: number } };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.json().catch(() => ({}))).error ?? ""}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `${path}: ${r.status}`);
  return j as T;
}

export const api = {
  sets: () => get<{ set: string; vendors: number }[]>("/api/sets"),
  comparison: (set: string) => get<Comparison>(`/api/comparison?set=${set}`),
  cell: (set: string, vendor: string, line: string) => get<CellDetail>(`/api/cell?set=${set}&vendor=${vendor}&line=${line}`),
  vendor: (set: string, vendor: string) => get<VendorDetail>(`/api/vendor?set=${set}&vendor=${vendor}`),
  award: (set: string, q: Record<string, string>) => get<Award>(`/api/award?set=${set}&${new URLSearchParams(q).toString()}`),
  clarify: (set: string, vendor: string) => get<{ draft: ClarificationDraft | null }>(`/api/clarify?set=${set}&vendor=${vendor}`),
  confirm: (set: string, id: string, decision: "confirmed" | "rejected", reason: string) => post<{ log: DecisionLog }>(`/api/confirm?set=${set}`, { id, decision, reason }),
  reset: (set: string) => post<{ ok: boolean }>(`/api/reset?set=${set}`, {}),
  verify: (set: string, vendor: string, line: string, reason: string) => post<{ ok: boolean }>(`/api/verify?set=${set}`, { vendor, line, reason }),
  override: (set: string, vendor: string, line: string, rate: number, reason: string) => post<{ ok: boolean }>(`/api/override?set=${set}`, { vendor, line, rate, reason }),
  waive: (set: string, vendor: string, q_id: string, reason: string) => post<{ ok: boolean }>(`/api/waive?set=${set}`, { vendor, q_id, reason }),
  confirmAward: (set: string, policy: Record<string, unknown>, acknowledged: string[]) => post<{ award: AwardRecord }>(`/api/award/confirm?set=${set}`, { policy, acknowledged }),
  awards: (set: string) => get<(AwardRecord & { stale: boolean; now: { cost: { point: number }; exposure_inr: number } })[]>(`/api/awards?set=${set}`),
  events: (set: string) => get<{ event_id: string; kind: string; ref: string; payload: Record<string, unknown>; at: string }[]>(`/api/events?set=${set}`),
  imageUrl: (set: string, vendor: string, box: number[]) => `/api/image?set=${set}&vendor=${vendor}&box=${box.join(",")}`,
  fileUrl: (set: string, path: string) => `/api/file?set=${set}&path=${encodeURIComponent(path)}`,
};
