import { DEFAULT_POLICY, allocate, type Policy, type VendorInput } from "../award/optimizer.js";
import { evaluateGate } from "../award/gate.js";
import { rankings, type Ranking } from "../award/rankings.js";
import type { Config } from "../config.js";
import { vendorById } from "../data/vendors.js";
import type { QuestionnaireFindings } from "../evidence/answers.js";
import type { CertificateFields } from "../evidence/certificates.js";
import type { ReportFinding } from "../evidence/claims.js";
import type { GateSummary, TestReportFields } from "../evidence/gates.js";
import type { PassADocument } from "../ingest/extract_a.js";
import type { Extraction, RejectedRow } from "../ingest/extraction.js";
import type { InjectionFinding } from "../ingest/injection.js";
import type { Quote } from "../ingest/quotes.js";
import type { VendorAssessment } from "../ingest/vendor.js";
import { isSafe, type CellState } from "../model/states.js";
import { draftClarification, type ClarificationDraft } from "../review/clarify.js";
import { decide, pendingConfirmations, type Confirmation, type DecisionLog } from "../review/confirmations.js";
import type { RfxHeader, RfxLine } from "../schemas.js";

/**
 * View models for the buyer UI (spec 18). Pure: the server builds a Session from saved runs and these turn it into
 * what each screen shows. Nothing here reads ground truth: the app never sees it.
 */

export interface SessionVendor {
  vendor_id: string;
  /** The vendor's original document, relative to the set's vendors folder ("V1/....xlsx"). */
  file: string;
  /** The saved live run the quotes were rebuilt from. */
  run_file: string;
  doc: PassADocument;
  /** Current quotes: the test report's findings applied, and any buyer decision since the session began. */
  quotes: Quote[];
  assessment: VendorAssessment;
  extraction: Extraction;
  extras: Extraction["extras"];
  rejected: RejectedRow[];
  injection: InjectionFinding[];
  gates: GateSummary;
  answers: Record<string, string>;
  findings: QuestionnaireFindings;
  report_findings: ReportFinding[];
  certificate: CertificateFields | null;
  test_report: TestReportFields | null;
  evidence_docs: { role: string; file: string; read: boolean }[];
  /** The model passes' own notes, for the vendor page. */
  notes: string[];
  /** The saved live run as written (passes, adjudication, injection findings), for the trace page. Never ground truth. */
  run?: Record<string, any>;
  /** Every model call behind this vendor's data: passes, adjudicator, evidence documents. */
  traces?: TraceStep[];
}

export interface TraceStep {
  step: string;
  file: string;
  model: string | null;
  fallback_used: boolean;
  stop_reason: string | null;
  prompt_version: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
  ms: number | null;
  at: string | null;
}

export interface Session {
  set: string;
  config: Config;
  rfx: RfxHeader;
  lines: readonly RfxLine[];
  vendors: SessionVendor[];
  decisions: DecisionLog[];
}

const SAFE = (s: Session) => s.config.exposure.safe_states;
const allQuotes = (s: Session) => s.vendors.flatMap((v) => v.quotes);

export interface CellSummary {
  state: CellState;
  point: number | null;
  low: number | null;
  high: number | null;
  /** The vendor's rate in INR per base unit, ex GST, before freight. */
  rate: number | null;
  reason: string;
  flags: string[];
  unsafe: boolean;
}

function cellSummary(q: Quote | undefined, safe: readonly string[]): CellSummary {
  if (!q) return { state: "MISSING", point: null, low: null, high: null, rate: null, reason: "Not quoted. Never filled in.", flags: [], unsafe: false };
  const rate = q.components.find((c) => c.kind === "base_rate")?.point ?? null;
  return {
    state: q.state,
    point: q.landed?.point ?? null,
    low: q.landed?.low ?? null,
    high: q.landed?.high ?? null,
    rate,
    reason: q.state_reason,
    flags: q.flags,
    unsafe: q.components.some((c) => !isSafe(c.state, safe)) || (q.state !== "MISSING" && q.landed === null),
  };
}

export interface ComparisonView {
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
    /** Annual value at point, of safe components only, and of everything priced. */
    trusted_value: number;
    total_value: number;
    injection: boolean;
    /** Headline vs landed, against last year's prices (trap 33). */
    ranking: Ranking;
  }[];
  lines: {
    line_id: string;
    description: string;
    spec: string;
    base_uom: string;
    annual_qty: number;
    baseline: number;
    cells: Record<string, CellSummary>;
    /** Cheapest landed point among priced cells, and among safe cells only. */
    best: { vendor_id: string; point: number; state: CellState } | null;
    best_trusted: { vendor_id: string; point: number; state: CellState } | null;
  }[];
  open_items: OpenItem[];
  confirmations: Confirmation[];
  decisions: DecisionLog[];
}

export interface OpenItem {
  vendor_id: string;
  line_id: string;
  kind: string;
  state: CellState;
  /** Annual rupees at stake: quantity x the larger of point and high (spec 8.5); for an unpriced line, at baseline. */
  value_inr: number;
  why: string;
  action: "confirm" | "review" | "clarify" | "none";
  confirmation_id?: string;
}

const specText = (l: RfxLine) => (l.spec.ply === null ? l.spec.dims_text : `${l.spec.ply} ply ${l.spec.flute} ${l.spec.liner_gsm}/${l.spec.bf}, ${l.spec.dims_text}`);

/** Unsafe components across all quotes, largest rupees first, each with its one-click resolution (spec 18.1 point 4). */
export function openItems(s: Session, confirmations: readonly Confirmation[]): OpenItem[] {
  const safe = SAFE(s);
  const items: OpenItem[] = [];
  for (const v of s.vendors) {
    for (const q of v.quotes) {
      const line = s.lines.find((l) => l.line_id === q.line_id);
      if (!line) continue;
      const conf = confirmations.find((c) => c.vendor_id === v.vendor_id && c.lines.includes(q.line_id));
      if (q.state === "NEEDS_REVIEW") {
        // No usable price: what is at stake is the line itself, valued at last year's price.
        const at = q.landed ? q.landed.high : line.baseline_price_inr;
        items.push({ vendor_id: v.vendor_id, line_id: q.line_id, kind: "line", state: q.state, value_inr: at * line.annual_qty, why: q.state_reason, action: "review" });
        continue;
      }
      for (const c of q.components) {
        if (isSafe(c.state, safe)) continue;
        const action = c.kind === "base_rate" && conf ? "confirm" : c.kind === "base_rate" && c.basis.startsWith("baseline") ? "clarify" : "none";
        items.push({
          vendor_id: v.vendor_id,
          line_id: q.line_id,
          kind: c.kind,
          state: c.state,
          value_inr: Math.max(c.point, c.high) * line.annual_qty,
          why: c.kind === "freight" ? `Freight is not in the price; estimated from the ${c.basis === "lane_tariff" ? "lane tariff" : "default tariff"}.` : q.state_reason,
          action,
          ...(action === "confirm" && conf ? { confirmation_id: conf.id } : {}),
        });
      }
    }
  }
  return items.sort((a, b) => b.value_inr - a.value_inr);
}

export function comparisonView(s: Session): ComparisonView {
  const safe = SAFE(s);
  const confirmations = s.vendors.flatMap((v) => pendingConfirmations(v.quotes, s.config.currency_of_record));
  const ranks = rankings(s.vendors, s.lines);
  const vendors = s.vendors.map((v) => {
    const reg = vendorById(v.vendor_id);
    let trusted = 0;
    let total = 0;
    for (const q of v.quotes) {
      const qty = s.lines.find((l) => l.line_id === q.line_id)?.annual_qty ?? 0;
      if (!q.landed) continue;
      total += q.landed.point * qty;
      if (q.components.every((c) => isSafe(c.state, safe))) trusted += q.landed.point * qty;
    }
    return {
      vendor_id: v.vendor_id,
      name: reg.name,
      city: reg.city,
      format: v.doc.kind,
      coverage: { quoted: v.quotes.filter((q) => q.state !== "MISSING").length, total: s.lines.length },
      gate: v.gates.overall,
      gate_headline: v.gates.headline,
      validity: v.assessment.validity.status,
      freight: v.extraction.vendor_terms.freight_basis?.value ?? "unstated",
      trusted_value: trusted,
      total_value: total,
      injection: v.injection.length > 0,
      ranking: ranks.find((r) => r.vendor_id === v.vendor_id) as Ranking,
    };
  });
  const lines = s.lines.map((l) => {
    const cells: Record<string, CellSummary> = {};
    for (const v of s.vendors) cells[v.vendor_id] = cellSummary(v.quotes.find((q) => q.line_id === l.line_id), safe);
    const priced = Object.entries(cells).filter(([, c]) => c.point !== null && c.state !== "NEEDS_REVIEW");
    const pick = (xs: typeof priced) => {
      const b = xs.sort((a, b) => (a[1].point as number) - (b[1].point as number))[0];
      return b ? { vendor_id: b[0], point: b[1].point as number, state: b[1].state } : null;
    };
    return {
      line_id: l.line_id,
      description: l.description,
      spec: specText(l),
      base_uom: l.base_uom,
      annual_qty: l.annual_qty,
      baseline: l.baseline_price_inr,
      cells,
      best: pick([...priced]),
      best_trusted: pick(priced.filter(([, c]) => !c.unsafe)),
    };
  });
  return {
    set: s.set,
    rfx: { id: s.rfx.rfx_id, title: s.rfx.title, as_of: s.config.as_of_date, fx: s.config.fx.USD_INR, fx_date: s.config.fx.snapshot_date, due: s.rfx.due_date },
    vendors,
    lines,
    open_items: openItems(s, confirmations),
    confirmations,
    decisions: s.decisions,
  };
}

export interface SourceExcerpt {
  kind: string;
  file: string;
  /** The verbatim snippet the value rests on. */
  snippet: string;
  locator: Record<string, unknown>;
  /** Lines of the parsed document around the source, the source lines marked. */
  lines: { text: string; highlight: boolean; muted: boolean }[];
  note: string | null;
}

/** The parsed document around a component's locator: the email span, the sheet row, the page lines, the paragraph. */
export function sourceExcerpt(v: SessionVendor, locator: Record<string, unknown>, snippet: string): SourceExcerpt {
  const text = v.doc.text;
  const all = text.split("\n");
  let hit: number[] = [];
  let note: string | null = null;
  if (locator.type === "email" && typeof locator.char_start === "number") {
    const start = locator.char_start as number;
    let off = 0;
    all.forEach((l, i) => {
      if (start >= off && start <= off + l.length) hit.push(i);
      off += l.length + 1;
    });
  } else if (locator.type === "xlsx") {
    const ref = `${String(locator.sheet)}!row`;
    const cell = String(locator.cell);
    hit = all.map((l, i) => (l.startsWith(ref) && l.includes(`${cell}=`) ? i : -1)).filter((i) => i >= 0);
  } else if (locator.type === "docx") {
    const tag = typeof locator.paragraph_idx === "number" ? `[P${locator.paragraph_idx}]` : `[T${locator.table_idx} R${locator.row}]`;
    hit = all.map((l, i) => (l.startsWith(tag) ? i : -1)).filter((i) => i >= 0);
  } else if (locator.type === "image") {
    note = Array.isArray(locator.box) ? `Read from the photo${typeof locator.row === "number" ? `, row ${locator.row}` : ""}; the crop shows where.` : "Read from the photo; no region given.";
    return { kind: v.doc.kind, file: v.file, snippet, locator, lines: [], note };
  } else if (locator.type === "derived") {
    note = `Derived (${String(locator.rule ?? "")}), not read from one place.`;
  }
  if (hit.length === 0 && snippet.trim()) {
    const norm = (x: string) => x.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").toLowerCase();
    const sn = norm(snippet).slice(0, 60);
    hit = all.map((l, i) => (norm(l).includes(sn) ? i : -1)).filter((i) => i >= 0).slice(0, 3);
  }
  const quotedFrom = v.doc.authoritative_end !== undefined ? text.slice(0, v.doc.authoritative_end).split("\n").length - 1 : Infinity;
  const center = hit[0] ?? 0;
  const from = Math.max(0, center - 5);
  const to = Math.min(all.length, (hit.at(-1) ?? center) + 6);
  return {
    kind: v.doc.kind,
    file: v.file,
    snippet,
    locator,
    lines: hit.length === 0 && locator.type === "derived" ? [] : all.slice(from, to).map((t, i) => ({ text: t, highlight: hit.includes(from + i), muted: from + i >= quotedFrom })),
    note,
  };
}

export function cellView(s: Session, vendorId: string, lineId: string) {
  const v = s.vendors.find((x) => x.vendor_id === vendorId);
  const line = s.lines.find((l) => l.line_id === lineId);
  if (!v || !line) return null;
  const q = v.quotes.find((x) => x.line_id === lineId) ?? null;
  const rate = q?.components.find((c) => c.kind === "base_rate");
  const sources = (q?.components ?? []).map((c) => ({ component: c.kind, ...sourceExcerpt(v, c.provenance.locator, c.provenance.snippet) }));
  // A line in review has no component: show where each pass read it.
  const readings = (q?.reconciliation?.readings ?? []).map((r) => ({ ...r, source: sourceExcerpt(v, r.locator, r.snippet) }));
  const conf = pendingConfirmations([q].filter((x): x is Quote => x !== null), s.config.currency_of_record)[0] ?? null;
  return {
    vendor: { vendor_id: v.vendor_id, name: vendorById(v.vendor_id).name },
    line: { ...line, spec_text: specText(line) },
    quote: q,
    summary: cellSummary(q ?? undefined, SAFE(s)),
    rate_component: rate ?? null,
    sources,
    readings,
    confirmation: conf ? s.vendors.flatMap((x) => pendingConfirmations(x.quotes, s.config.currency_of_record)).find((c) => c.vendor_id === v.vendor_id && c.lines.includes(lineId)) ?? null : null,
  };
}

export function vendorView(s: Session, vendorId: string) {
  const v = s.vendors.find((x) => x.vendor_id === vendorId);
  if (!v) return null;
  const terms = v.extraction.vendor_terms;
  const discrepancies = [
    ...v.assessment.discrepancies.map((d) => ({ kind: d.kind, detail: d.detail })),
    ...(v.injection.length ? [{ kind: "injection_attempt", detail: "This document contains text addressed to AI systems. It was ignored and recorded." }] : []),
    ...v.findings.contradictions.map((c) => ({ kind: "claim_vs_evidence", detail: `${c.q_id} says "${c.claim}", but ${c.lines.join(", ")} deviate: ${c.evidence.slice(0, 3).join("; ")}${c.evidence.length > 3 ? "; ..." : ""}` })),
    ...v.findings.hedged.map((h) => ({ kind: "hedged_answer", detail: `${h.q_id}: "${h.answer}" has a condition attached; it is not scored as a yes.` })),
  ];
  return {
    vendor: { ...vendorById(v.vendor_id), file: v.file, run_file: v.run_file, format: v.doc.kind },
    coverage: { quoted: v.quotes.filter((q) => q.state !== "MISSING").length, total: s.lines.length },
    states: Object.fromEntries(["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED", "INFERRED", "NEEDS_REVIEW", "MISSING"].map((st) => [st, v.quotes.filter((q) => q.state === st).length])),
    terms: Object.entries(terms)
      .filter(([, t]) => t !== undefined)
      .map(([k, t]) => ({ term: k, value: Array.isArray(t) ? t.map((x) => `${x.pct}% ${x.condition_text}`).join("; ") : "value" in (t as object) ? String((t as { value: unknown }).value) : String((t as { value_text?: string }).value_text ?? ""), snippet: Array.isArray(t) ? t.map((x) => x.snippet).join(" | ") : (t as { snippet: string }).snippet })),
    validity: v.assessment.validity,
    late: v.assessment.late,
    excluded_by_default: v.assessment.excluded_by_default,
    discounts: v.assessment.conditional_discounts,
    gates: v.gates,
    answers: v.answers,
    certificate: v.certificate,
    test_report: v.test_report,
    evidence_docs: v.evidence_docs,
    report_findings: v.report_findings,
    discrepancies,
    extras: v.extras,
    rejected: v.rejected,
    injection: v.injection.map((f) => f.line),
    notes: v.notes,
  };
}

/** The allocation and the award gate under a policy, in full (for confirming an award). */
export function awardDecision(s: Session, policy: Partial<Policy>) {
  const p: Policy = { ...DEFAULT_POLICY, ...policy };
  const inputs: VendorInput[] = s.vendors.map((v) => ({ vendor_id: v.vendor_id, quotes: v.quotes, assessment: v.assessment, gate: v.gates.overall }));
  const result = allocate(s.lines, inputs, p, SAFE(s));
  return { policy: p, result, gate: evaluateGate(result, s.config.award_gate) };
}

export function awardView(s: Session, policy: Partial<Policy>) {
  const { policy: p, result, gate } = awardDecision(s, policy);
  return {
    policy: p,
    result: { ...result, assignments: result.assignments.map((a) => ({ ...a, quote: a.quote ? { state: a.quote.state, landed: a.quote.landed } : null })) },
    gate,
  };
}

export function clarificationView(s: Session, vendorId: string): ClarificationDraft | null {
  return draftClarification(vendorId, allQuotes(s), s.lines, s.rfx);
}

/** Applies a buyer's decision on a batch confirmation to the session. Logged; never touches the saved runs. */
export function applyConfirmation(s: Session, id: string, decision: "confirmed" | "rejected", reason: string, actor = "Meera"): DecisionLog {
  const v = s.vendors.find((x) => pendingConfirmations(x.quotes, s.config.currency_of_record).some((c) => c.id === id));
  if (!v) throw new Error(`no pending confirmation ${id}`);
  const c = pendingConfirmations(v.quotes, s.config.currency_of_record).find((x) => x.id === id) as Confirmation;
  const r = decide(v.quotes, c, decision, { actor, at: new Date().toISOString(), reason });
  v.quotes = r.quotes;
  s.decisions.push(r.log);
  return r.log;
}
