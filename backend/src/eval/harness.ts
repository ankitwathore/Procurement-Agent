import type { QuestionnaireFindings } from "../evidence/answers.js";
import type { ReportFinding } from "../evidence/claims.js";
import type { GateSummary } from "../evidence/gates.js";
import type { Extraction } from "../ingest/extraction.js";
import type { Quote } from "../ingest/quotes.js";
import type { VendorAssessment } from "../ingest/vendor.js";
import { rankings } from "../award/rankings.js";
import { RFX_LINES } from "../data/rfx.js";
import { isSafe } from "../model/states.js";
import { PRICE_TOLERANCE, scoreVendor, type GtLine } from "./score.js";

/**
 * The evaluation harness (spec 19): extraction metrics, the calibration table, trap detection, targets, and the
 * regression gate. Pure: the CLI assembles the inputs from saved runs. It reads ground truth, never the app's prompts,
 * and computes every expected value from ground truth alone.
 */

export type Format = "xlsx" | "pdf" | "docx" | "email" | "photo";

export interface GtVendor {
  lines: Record<string, GtLine & { true_landed_point?: number; basis_as_shown?: string; where?: string; currency?: string; inferred_from?: string }>;
  gates?: Record<string, string>;
  hedged?: Record<string, string>;
}

/** What one vendor's saved live run produced, as the harness needs it. */
export interface EvalVendor {
  vendor_id: string;
  format: Format;
  quotes: readonly Quote[];
  vendor: VendorAssessment;
  extraction: Extraction;
  extras: Extraction["extras"];
  injection_findings: number;
  gates: GateSummary;
  findings: QuestionnaireFindings;
  report_findings: readonly ReportFinding[];
  /** Email only: where quoted history begins. */
  authoritative_end?: number;
  /** Lines the clarification draft asks about (empty when no draft). */
  clarification_lines: readonly string[];
  /** File names intake marked as duplicates. */
  duplicates: readonly string[];
  /** Total model cost and wall time for this vendor's documents. */
  cost_usd: number;
  ms: number;
}

export interface EvalInput {
  set: "tuned" | "holdout" | "holdout2";
  vendors: readonly EvalVendor[];
  gt: { vendors: Record<string, GtVendor>; traps: Record<string, TrapEntry> };
  safeStates: readonly string[];
}

/** A trap register entry: where the trap sits in this set, so one check works on the tuned and the holdout set. */
export interface TrapEntry {
  vendor?: string;
  what?: string;
  line?: string;
  lines?: string[] | Record<string, string>;
  intended?: number;
  page?: number;
  pct?: number;
  threshold_inr?: number;
  rate?: number;
}

export type ValueVerdict = "correct" | "wrong" | "none";

export interface CellResult {
  vendor_id: string;
  line_id: string;
  expected_state: string;
  acceptable: string[];
  got_state: string;
  point: number | null;
  low: number | null;
  high: number | null;
  /** The intended landed value from ground truth, or null when nothing was offered. */
  truth: number | null;
  value: ValueVerdict;
}

export interface CalibrationRow {
  state: string;
  cells: number;
  correct: number;
  precision: number | null;
  rule: string;
}

export interface TrapResult {
  id: string;
  vendor: string;
  what: string;
  status: "pass" | "fail" | "not_built" | "not_run";
  detail: string;
}

export interface TargetRow {
  metric: string;
  target: string;
  value: string;
  status: "met" | "missed" | "not_measured";
}

export interface GroupMetrics {
  cells: number;
  state_accuracy: number;
  price_checked: number;
  price_accuracy: number;
  quoted: { tp: number; fp: number; fn: number; precision: number; recall: number };
  dangerous: string[];
}

export interface EvalReport {
  set: string;
  per_vendor: Record<string, GroupMetrics>;
  per_format: Record<string, GroupMetrics>;
  overall: GroupMetrics;
  confusion: Record<string, Record<string, number>>;
  calibration: CalibrationRow[];
  wrong_cells: { total: number; flagged_unsafe: number; recall: number | null; cells: string[] };
  dangerous_rate: number;
  confirmed_precision: number | null;
  traps: TrapResult[];
  trap_recall: { passed: number; runnable: number; registered: number };
  targets: TargetRow[];
  cost_usd: number;
  max_doc_ms: number;
  headline: string;
  cells: CellResult[];
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const close = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) <= PRICE_TOLERANCE;

function cellResults(v: EvalVendor, gt: GtVendor): CellResult[] {
  return Object.entries(gt.lines).map(([line_id, g]) => {
    const q = v.quotes.find((x) => x.line_id === line_id);
    const truth = g.landed_unit_inr_point ?? g.true_landed_point ?? null;
    const point = q?.landed?.point ?? null;
    const value: ValueVerdict = point === null ? "none" : truth === null ? "wrong" : close(point, truth) ? "correct" : "wrong";
    return {
      vendor_id: v.vendor_id,
      line_id,
      expected_state: g.expected_state,
      acceptable: [g.expected_state, ...(g.also_acceptable ?? [])],
      got_state: q?.state ?? "MISSING",
      point,
      low: q?.landed?.low ?? null,
      high: q?.landed?.high ?? null,
      truth,
      value,
    };
  });
}

function groupMetrics(vendors: readonly EvalVendor[], gt: EvalInput["gt"], safe: readonly string[]): GroupMetrics {
  let cells = 0, stateOk = 0, priceChecked = 0, priceOk = 0, tp = 0, fp = 0, fn = 0;
  const dangerous: string[] = [];
  for (const v of vendors) {
    const g = gt.vendors[v.vendor_id];
    if (!g) continue;
    const s = scoreVendor(v.quotes, g.lines, safe);
    cells += s.lines.length;
    stateOk += s.lines.filter((l) => l.state_ok).length;
    priceChecked += s.price_checked;
    priceOk += s.lines.filter((l) => l.price_ok === true).length;
    dangerous.push(...s.dangerous.map((l) => `${v.vendor_id}:${l}`));
    for (const [line_id, gl] of Object.entries(g.lines)) {
      const gtQuoted = ![gl.expected_state, ...(gl.also_acceptable ?? [])].includes("MISSING");
      const appQuoted = (v.quotes.find((q) => q.line_id === line_id)?.state ?? "MISSING") !== "MISSING";
      if (gtQuoted && appQuoted) tp++;
      else if (!gtQuoted && appQuoted) fp++;
      else if (gtQuoted && !appQuoted) fn++;
    }
  }
  return {
    cells,
    state_accuracy: cells ? stateOk / cells : 0,
    price_checked: priceChecked,
    price_accuracy: priceChecked ? priceOk / priceChecked : 0,
    quoted: { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 },
    dangerous,
  };
}

/**
 * Spec 19.2. Safe states are correct when the value is right. INFERRED is correct when the true value lies within the
 * stated range. NEEDS_REVIEW is justified when the cell was genuinely ambiguous (ground truth accepts review) or its
 * value really was wrong. MISSING is correct when nothing was offered.
 */
function calibration(cells: readonly CellResult[], safe: readonly string[]): CalibrationRow[] {
  const states = ["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED", "INFERRED", "NEEDS_REVIEW", "MISSING"];
  const rules: Record<string, [string, (c: CellResult) => boolean]> = {
    INFERRED: ["true value within the stated range", (c) => c.truth !== null && c.low !== null && c.high !== null && c.low <= c.truth * (1 + PRICE_TOLERANCE) && c.high >= c.truth * (1 - PRICE_TOLERANCE)],
    NEEDS_REVIEW: ["genuinely ambiguous or wrong", (c) => c.acceptable.includes("NEEDS_REVIEW") || c.value === "wrong"],
    MISSING: ["nothing was offered", (c) => c.acceptable.includes("MISSING")],
  };
  return states.map((state) => {
    const mine = cells.filter((c) => c.got_state === state);
    const [rule, ok] = rules[state] ?? ["value correct within 0.5%", (c: CellResult) => c.value === "correct"];
    const correct = mine.filter(ok).length;
    return { state, cells: mine.length, correct, precision: mine.length ? correct / mine.length : null, rule: isSafe(state as never, safe) ? `${rule} (safe state)` : rule };
  });
}

// ---- Trap checks (spec 17.6, 19.3). Each looks only at app outputs and ground truth.

type Check = (v: (id: string) => EvalVendor | undefined, gt: EvalInput["gt"], trap: TrapEntry) => { ok: boolean; detail: string } | "not_run";

const q = (v: EvalVendor | undefined, line: string) => v?.quotes.find((x) => x.line_id === line);
const linesWithFlag = (v: EvalVendor, flag: string) => v.quotes.filter((x) => x.flags.includes(flag)).map((x) => x.line_id);
const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",");
const priced = (v: EvalVendor) => v.quotes.filter((x) => x.landed !== null);
/**
 * Every line mapped and priced right, nothing lost or invented. A cell may be more cautious than expected (CONFIRMED
 * shown as HIGH_CONF, still safe); traps about mapping and reading are about the value, not the confidence label.
 */
const SAFE_LABELS = ["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED"];
const allPricesRight = (v: EvalVendor, gt: EvalInput["gt"]) => {
  const s = scoreVendor(v.quotes, gt.vendors[v.vendor_id]!.lines, []);
  const stateFine = s.lines.every((l) => l.state_ok || (SAFE_LABELS.includes(l.got_state) && SAFE_LABELS.includes(l.expected_state)));
  return { ok: stateFine && s.lines.every((l) => l.price_ok !== false) && s.coverage_errors.length === 0, s };
};
const need = (id: string, f: (v: EvalVendor, gt: EvalInput["gt"], t: TrapEntry) => { ok: boolean; detail: string }): Check => (get, gt, trap) => {
  const v = get(id);
  return v ? f(v, gt, trap) : "not_run";
};
const linesOf = (t: TrapEntry): string[] => (Array.isArray(t.lines) ? t.lines : Object.keys(t.lines ?? {}));

const CHECKS: Record<string, Check> = {
  "01": need("V1", (v, gt) => {
    const { ok, s } = allPricesRight(v, gt);
    const cells = priced(v).every((x) => x.components.every((c) => c.kind !== "base_rate" || c.provenance.locator.type === "xlsx"));
    return { ok: ok && cells, detail: `state ${pct(s.state_accuracy)}, price ${pct(s.price_accuracy)}, every rate located by cell: ${cells}` };
  }),
  "02": need("V1", (v, gt) => {
    const want = Object.entries(gt.vendors.V1!.lines).filter(([, l]) => l.expected_flags?.includes("hidden_value_differs")).map(([id]) => id);
    const got = linesWithFlag(v, "hidden_value_differs");
    return { ok: same(want, got) && allPricesRight(v, gt).ok, detail: `hidden values flagged on ${got.length} of ${want.length} lines; visible values used` };
  }),
  "03": need("V1", (v, _gt, t) => {
    const lines = linesOf(t);
    const flagged = linesWithFlag(v, "spec_below_requirement");
    const c = v.findings.contradictions.find((x) => x.q_id === "Q12");
    return { ok: same(flagged, lines) && !!c && same(c.lines, lines), detail: `spec_below_requirement on ${flagged.join(", ") || "none"}; Q12 contradiction on ${c?.lines.join(", ") ?? "none"}` };
  }),
  "04": need("V1", (v, _gt, t) => {
    const id = t.line as string;
    const x = q(v, id);
    const ok = x?.state === "NEEDS_REVIEW" && x.flags.includes("magnitude_slip") && !!x.suggested_reading && close(x.suggested_reading.suggested_rate, t.intended as number) && v.clarification_lines.includes(id);
    return { ok, detail: `${id} ${x?.state}, suggested ${x?.suggested_reading?.suggested_rate.toFixed(2) ?? "none"} for ${t.intended} (not applied), clarification asks: ${v.clarification_lines.includes(id)}` };
  }),
  "05": () => "not_run",
  "06": need("V2", (v, gt, t) => {
    const g = v.extraction.vendor_terms.gst_basis;
    return { ok: g?.value === "inclusive" && g.locator.page === t.page && allPricesRight(v, gt).ok, detail: `GST basis ${g?.value ?? "none"} from page ${String(g?.locator.page ?? "-")} (expected ${t.page}); prices normalized ex GST` };
  }),
  "07": need("V2", (v, _gt, t) => {
    const d = v.vendor.conditional_discounts.find((x) => x.pct === t.pct && x.threshold_inr === t.threshold_inr);
    return { ok: !!d, detail: d ? `${t.pct}% above Rs ${t.threshold_inr} captured as a case: "${d.snippet}"` : `discount not captured (got ${v.vendor.conditional_discounts.map((x) => `${x.pct}% over ${x.threshold_inr}`).join(", ") || "none"})` };
  }),
  "08": need("V2", (v) => {
    const ok = priced(v).length > 0 && priced(v).every((x) => x.components.some((c) => c.kind === "freight" && c.basis === "lane_tariff" && c.state === "INFERRED"));
    return { ok, detail: `freight from the Ahmedabad lane, INFERRED, on ${priced(v).length} priced lines` };
  }),
  "09": need("V2", (v) => {
    const q01 = v.gates.gates.find((g) => g.q_id === "Q01");
    return { ok: q01?.result === "FAIL" && v.gates.overall === "FAIL", detail: `Q01 ${q01?.result}: ${q01?.reason}` };
  }),
  "10": need("V2", (v, _gt, t) => {
    const x = q(v, t.line as string);
    return { ok: x?.state === "NEEDS_REVIEW" && x.flags.includes("arithmetic_mismatch"), detail: `${t.line} ${x?.state}, ${x?.flags.includes("arithmetic_mismatch") ? "arithmetic_mismatch" : "no arithmetic flag"}` };
  }),
  "11": need("V2", (v, gt) => ({ ok: v.injection_findings > 0 && allPricesRight(v, gt).ok, detail: `${v.injection_findings} injection finding(s) stripped; every V2 price and state as expected` })),
  "12": need("V2", (v, gt, t) => {
    const alt = v.extras.find((e) => e.rate.value !== null && close(e.rate.value, t.rate as number));
    const main = scoreVendor(v.quotes, gt.vendors.V2!.lines, []).lines.find((l) => l.line_id === t.line);
    return { ok: !!alt && main?.price_ok === true, detail: alt ? `alternate listed ("${alt.description}"), ${t.line} priced from the main offer` : "alternate not listed" };
  }),
  "13": need("V2", (v) => ({ ok: v.findings.hedged.some((h) => h.q_id === "Q07"), detail: `hedged: ${v.findings.hedged.map((h) => h.q_id).join(", ") || "none"}` })),
  "14": need("V3", (v, gt, t) => {
    const lines = linesOf(t);
    const s = scoreVendor(v.quotes, gt.vendors.V3!.lines, []);
    // Each line's own pack size, as ground truth printed it ("per 100 pcs", "per 1000 nos", "per 50 sets").
    const pack = (id: string) => /(\d[\d,]*)/.exec(String(gt.vendors.V3!.lines[id]?.basis_as_shown ?? ""))?.[1]?.replace(/,/g, "") ?? "100";
    const wrong = lines.filter((id) => !(s.lines.find((l) => l.line_id === id)?.price_ok === true && (q(v, id)?.chain.some((c) => c.includes(`per ${pack(id)} `)) ?? false)));
    return { ok: wrong.length === 0, detail: `${lines.length - wrong.length} of ${lines.length} per pack lines converted in code with the chain shown${wrong.length ? ` (not: ${wrong.join(", ")})` : ""}` };
  }),
  "15": need("V3", (v, gt) => {
    const lines = Object.entries(gt.vendors.V3!.lines).filter(([, l]) => l.currency === "USD").map(([id]) => id);
    const ok = lines.every((id) => {
      const x = q(v, id);
      return x?.state === "INFERRED" && x.flags.includes("fx_clause") && !!x.landed && x.landed.low < x.landed.point && x.landed.point < x.landed.high;
    });
    return { ok, detail: `${lines.join(", ")}: INFERRED with the FX band` };
  }),
  "16": need("V3", (v, _gt, t) => {
    const lines = linesOf(t);
    const got = [...new Set(v.report_findings.map((f) => f.line_id))];
    const c = v.findings.contradictions.find((x) => x.lines.some((l) => lines.includes(l)));
    return { ok: same(got, lines) && !!c, detail: `test report below requirement on ${got.join(", ") || "none"}; claim contradicted: ${c ? `${c.q_id} "${c.claim}"` : "no"}` };
  }),
  "17": need("V3", (v) => ({ ok: v.vendor.validity.status === "lapsed" && v.vendor.excluded_by_default, detail: `validity ${v.vendor.validity.status} (${v.vendor.validity.valid_until}), excluded by default: ${v.vendor.excluded_by_default}` })),
  "18": need("V3", (v, gt) => {
    const lines = Object.entries(gt.vendors.V3!.lines).filter(([, l]) => l.where === "prose").map(([id]) => id);
    const s = scoreVendor(v.quotes, gt.vendors.V3!.lines, []);
    const ok = lines.every((id) => s.lines.find((l) => l.line_id === id)?.price_ok === true && typeof q(v, id)?.components[0]?.provenance.locator.paragraph_idx === "number");
    return { ok, detail: `${lines.length} prose lines priced with paragraph locators` };
  }),
  "19": need("V3", (v) => ({ ok: v.findings.hedged.some((h) => h.q_id === "Q07"), detail: `hedged: ${v.findings.hedged.map((h) => h.q_id).join(", ") || "none"}` })),
  "29": need("V5", (v, gt) => {
    const lines = Object.entries(gt.vendors.V5!.lines).filter(([, l]) => l.inferred_from).map(([id]) => id);
    const ok = lines.every((id) => {
      const x = q(v, id);
      return x?.state === "INFERRED" && x.components.some((c) => c.basis === "baseline_same_as_last_year" && c.provenance.snippet.length > 0) && !!x.landed && x.landed.low < x.landed.high;
    });
    return { ok, detail: `${lines.length} lines INFERRED from "rest same as last year" with a range` };
  }),
  "30": need("V5", (v, _gt, t) => {
    const allowed = linesOf(t);
    const stated = v.quotes.filter((x) => x.components.some((c) => c.kind === "base_rate" && c.basis === "stated")).map((x) => x.line_id);
    return { ok: stated.length > 0 && stated.every((id) => allowed.includes(id)), detail: `per kg rates applied to ${stated.join(", ") || "nothing"} (allowed: ${allowed.join(", ")})` };
  }),
  "31": need("V5", (v) => ({ ok: v.gates.gates.every((g) => g.result === "UNKNOWN") && v.gates.overall === "UNKNOWN" && v.vendor.validity.status === "not_stated", detail: `gates ${v.gates.overall}, validity ${v.vendor.validity.status}` })),
  "32": need("V5", (v) => ({ ok: priced(v).length > 0 && priced(v).every((x) => x.components.some((c) => c.kind === "freight" && c.basis === "default_tariff")), detail: `default tariff on ${priced(v).length} priced lines` })),
  "34": need("V2", (v, gt) => {
    const { ok, s } = allPricesRight(v, gt);
    return { ok, detail: `own codes and reordered rows mapped: state ${pct(s.state_accuracy)}, price ${pct(s.price_accuracy)}` };
  }),
  "35": need("V1", (v, _gt, t) => {
    const lines = linesOf(t);
    return { ok: lines.every((id) => q(v, id)?.state === "MISSING"), detail: lines.map((id) => `${id} ${q(v, id)?.state}`).join(", ") };
  }),
  "36": need("V2", (v) => ({ ok: v.duplicates.length === 1, detail: v.duplicates.length ? `deduped by hash: ${v.duplicates.join(", ")}` : "no duplicate detected" })),
  "20": need("V4", (v, gt) => {
    // The photo is read: every readable line priced right; the unreadable ones are other traps.
    const s = scoreVendor(v.quotes, gt.vendors.V4!.lines, []);
    const wrong = s.lines.filter((l) => l.price_ok === false || (l.expected_state !== "NEEDS_REVIEW" && !l.state_ok && !(SAFE_LABELS.includes(l.got_state) && SAFE_LABELS.includes(l.expected_state))));
    return { ok: wrong.length === 0 && s.coverage_errors.length === 0, detail: `${s.price_checked} readable lines priced, ${wrong.length} wrong (${wrong.map((l) => l.line_id).join(", ") || "none"})` };
  }),
  "21": need("V4", (v, _gt, t) => {
    const lines = linesOf(t);
    return { ok: lines.every((id) => q(v, id)?.state === "MISSING"), detail: lines.map((id) => `${id} ${q(v, id)?.state}`).join(", ") };
  }),
  "22": need("V4", (v, _gt, t) => {
    const lines = linesOf(t);
    return { ok: lines.every((id) => q(v, id)?.state === "NEEDS_REVIEW"), detail: `${lines.map((id) => `${id} ${q(v, id)?.state}`).join(", ")} (review, not missing)` };
  }),
  "23": need("V4", (v, _gt, t) => {
    const x = q(v, t.line as string);
    return { ok: x?.state === "NEEDS_REVIEW", detail: `${t.line} ${x?.state}: ${x?.state_reason ?? ""}` };
  }),
  "24": need("V4", (v, _gt, t) => {
    const lines = linesOf(t);
    const flagged = linesWithFlag(v, "spec_dimension_off");
    return { ok: lines.every((id) => flagged.includes(id)), detail: `spec_dimension_off on ${flagged.join(", ") || "none"}` };
  }),
  "25": need("V4", (v, _gt, t) => {
    const x = q(v, t.line as string);
    return { ok: x?.state === "NEEDS_REVIEW" && x.landed === null, detail: `${t.line} ${x?.state}${x?.landed ? `, priced ${x.landed.point}` : ", not priced: the box count is never assumed"}` };
  }),
  "26": need("V4", (v) => {
    const q02 = v.gates.gates.find((g) => g.q_id === "Q02");
    return { ok: q02?.result === "FAIL", detail: `Q02 ${q02?.result}: ${q02?.reason}` };
  }),
  "27": need("V4", (v) => ({ ok: v.vendor.late && v.vendor.validity.status === "expiring", detail: `late ${v.vendor.late}, validity ${v.vendor.validity.status} (${v.vendor.validity.valid_until})` })),
  "28": (get) => {
    const v4 = get("V4");
    const others = ["V1", "V2", "V3"].map(get).filter((x): x is EvalVendor => x !== undefined);
    if (!v4 || others.length === 0) return "not_run";
    let cheap = 0, flip = 0;
    for (const x of v4.quotes) {
      const rate = (z: Quote | undefined) => z?.components.find((c) => c.kind === "base_rate")?.point;
      const own = rate(x);
      if (own === undefined || !x.landed) continue;
      const peers = others.map((o) => q(o, x.line_id)).filter((z): z is Quote => !!z?.landed && rate(z) !== undefined);
      if (peers.length === 0) continue;
      if (peers.every((z) => own < (rate(z) as number))) {
        cheap++;
        if (peers.every((z) => x.landed!.point > z.landed!.point)) flip++;
      }
    }
    return { ok: cheap > 0 && flip / cheap > 0.5, detail: `cheapest headline on ${cheap} lines; of those, most expensive landed on ${flip}` };
  },
  "33": (get) => {
    // The comparison screen shows both rankings; the flip must be there for the ex works vendor whose headline is cheapest.
    const vs = ["V1", "V2", "V3", "V4", "V5"].map(get).filter((x): x is EvalVendor => x !== undefined);
    if (!vs.some((v) => v.vendor_id === "V4")) return "not_run";
    const r = rankings(vs, RFX_LINES);
    const v4 = r.find((x) => x.vendor_id === "V4")!;
    return { ok: v4.flipped && v4.landed_rank > v4.headline_rank, detail: `V4 headline rank ${v4.headline_rank} (${(v4.headline_vs_baseline * 100).toFixed(1)}% vs last year), landed rank ${v4.landed_rank} (${(v4.landed_vs_baseline * 100).toFixed(1)}%)` };
  },
  "37": need("V5", (v) => {
    const end = v.authoritative_end ?? Infinity;
    const leaked = v.quotes.flatMap((x) => x.components).filter((c) => typeof c.provenance.locator.char_end === "number" && (c.provenance.locator.char_end as number) > end);
    return { ok: leaked.length === 0, detail: leaked.length ? `${leaked.length} value(s) from quoted history` : "no value taken from quoted history" };
  }),
};

/** Spec 17.6 traps for parts not built yet. */
const NOT_BUILT: Record<string, [string, string]> = {};

export function evaluate(input: EvalInput): EvalReport {
  const { vendors, gt, safeStates: safe } = input;
  const cells = vendors.flatMap((v) => (gt.vendors[v.vendor_id] ? cellResults(v, gt.vendors[v.vendor_id]!) : []));

  const per_vendor = Object.fromEntries(vendors.map((v) => [v.vendor_id, groupMetrics([v], gt, safe)]));
  const formats = [...new Set(vendors.map((v) => v.format))];
  const per_format = Object.fromEntries(formats.map((f) => [f, groupMetrics(vendors.filter((v) => v.format === f), gt, safe)]));
  const overall = groupMetrics(vendors, gt, safe);

  const confusion: Record<string, Record<string, number>> = {};
  for (const c of cells) {
    confusion[c.expected_state] ??= {};
    confusion[c.expected_state]![c.got_state] = (confusion[c.expected_state]![c.got_state] ?? 0) + 1;
  }

  const cal = calibration(cells, safe);
  const wrong = cells.filter((c) => c.value === "wrong" || (c.got_state === "MISSING" && c.truth !== null));
  const flagged = wrong.filter((c) => c.got_state !== "MISSING" && !isSafe(c.got_state as never, safe));
  const safeCells = cells.filter((c) => isSafe(c.got_state as never, safe));
  const confirmed = cal.find((r) => r.state === "CONFIRMED")!;

  const traps: TrapResult[] = [];
  const get = (id: string) => vendors.find((v) => v.vendor_id === id);
  const ids = [...new Set([...Object.keys(gt.traps), ...Object.keys(NOT_BUILT)])].sort();
  for (const id of ids) {
    const reg = gt.traps[id];
    if (NOT_BUILT[id]) {
      traps.push({ id, vendor: NOT_BUILT[id]![0], what: NOT_BUILT[id]![1], status: "not_built", detail: "the input or feature is not built yet" });
      continue;
    }
    const check = CHECKS[id];
    const r = check ? check(get, gt, reg ?? {}) : "not_run";
    const what = reg?.what ?? "";
    if (r === "not_run") traps.push({ id, vendor: reg?.vendor ?? "", what, status: "not_run", detail: id === "05" ? "no saved live run of V1 revision 2" : "vendor not in this run" });
    else traps.push({ id, vendor: reg?.vendor ?? "", what, status: r.ok ? "pass" : "fail", detail: r.detail });
  }
  const runnable = traps.filter((t) => t.status === "pass" || t.status === "fail");
  const passed = runnable.filter((t) => t.status === "pass").length;

  const textFormats = vendors.filter((v) => v.format !== "photo");
  const text = groupMetrics(textFormats, gt, safe);
  const photos = vendors.filter((v) => v.format === "photo");
  const photo = groupMetrics(photos, gt, safe);
  const recall = wrong.length ? flagged.length / wrong.length : null;
  const dangerous_rate = safeCells.length ? overall.dangerous.length / safeCells.length : 0;
  const cost = vendors.reduce((s, v) => s + v.cost_usd, 0);
  const maxMs = Math.max(0, ...vendors.map((v) => v.ms));
  // The latency target is for text native documents; a photo is reported beside it.
  const maxTextMs = Math.max(0, ...textFormats.map((v) => v.ms));
  const maxPhotoMs = Math.max(0, ...photos.map((v) => v.ms));
  const status = (ok: boolean | null): TargetRow["status"] => (ok === null ? "not_measured" : ok ? "met" : "missed");
  const targets: TargetRow[] = [
    { metric: "Rate accuracy, text native", target: ">= 99%", value: pct(text.price_accuracy), status: status(text.price_checked ? text.price_accuracy >= 0.99 : null) },
    { metric: "Rate accuracy, photo", target: ">= 93%", value: photo.price_checked ? `${pct(photo.price_accuracy)} of ${photo.price_checked}` : "n/a", status: status(photo.price_checked ? photo.price_accuracy >= 0.93 : null) },
    { metric: `Quoted vs missing detection (${input.set})`, target: input.set === "tuned" ? "100%" : ">= 98%", value: `precision ${pct(overall.quoted.precision)}, recall ${pct(overall.quoted.recall)}`, status: status(Math.min(overall.quoted.precision, overall.quoted.recall) >= (input.set === "tuned" ? 1 : 0.98)) },
    { metric: "Precision of CONFIRMED", target: ">= 99.5%", value: pct(confirmed.precision), status: status(confirmed.precision === null ? null : confirmed.precision >= 0.995) },
    { metric: "Recall of wrong cells flagged unsafe", target: ">= 95%", value: recall === null ? "no wrong cells" : pct(recall), status: status(recall === null ? null : recall >= 0.95) },
    { metric: `Trap recall (${input.set}, of runnable)`, target: input.set === "tuned" ? "100%" : ">= 90%", value: `${passed} of ${runnable.length}`, status: status(runnable.length ? passed / runnable.length >= (input.set === "tuned" ? 1 : 0.9) : null) },
    { metric: "Analyst golden pass rate", target: ">= 90%", value: "n/a", status: "not_measured" },
    { metric: "Grounding rate after correction loop", target: "100%", value: "n/a", status: "not_measured" },
    { metric: "Adversarial pass rate", target: "100%", value: "n/a", status: "not_measured" },
    { metric: "Per document latency, text native", target: "< 90 s", value: `${(maxTextMs / 1000).toFixed(0)} s max${photos.length ? ` (photo: ${(maxPhotoMs / 1000).toFixed(0)} s)` : ""}`, status: status(textFormats.length ? maxTextMs < 90_000 : null) },
    { metric: `Cost per full RFx (${vendors.length} of 5 vendors)`, target: "< 5 USD", value: `$${cost.toFixed(2)}`, status: status(vendors.length ? cost < 5 : null) },
  ];

  const headline =
    confirmed.precision === null
      ? "No cell was reported CONFIRMED."
      : `When the system says CONFIRMED, it is right ${pct(confirmed.precision)} of the time (${confirmed.correct} of ${confirmed.cells}), and it flags ${recall === null ? "all (there were no wrong cells)" : pct(recall)} of its own mistakes${wrong.length ? ` (${flagged.length} of ${wrong.length})` : ""}.`;

  return {
    set: input.set,
    per_vendor,
    per_format,
    overall,
    confusion,
    calibration: cal,
    wrong_cells: { total: wrong.length, flagged_unsafe: flagged.length, recall, cells: wrong.map((c) => `${c.vendor_id}:${c.line_id}`) },
    dangerous_rate,
    confirmed_precision: confirmed.precision,
    traps,
    trap_recall: { passed, runnable: runnable.length, registered: traps.length },
    targets,
    cost_usd: cost,
    max_doc_ms: maxMs,
    headline,
    cells,
  };
}

export interface RegressionResult {
  failed: boolean;
  reasons: string[];
}

/** Spec 19.8: lower CONFIRMED precision or a higher dangerous error rate than the last report fails the build. */
export function regressionGate(now: Pick<EvalReport, "confirmed_precision" | "dangerous_rate">, previous: Pick<EvalReport, "confirmed_precision" | "dangerous_rate"> | null): RegressionResult {
  if (!previous) return { failed: false, reasons: [] };
  const reasons: string[] = [];
  if (now.confirmed_precision !== null && previous.confirmed_precision !== null && now.confirmed_precision < previous.confirmed_precision - 1e-12) {
    reasons.push(`CONFIRMED precision fell from ${pct(previous.confirmed_precision)} to ${pct(now.confirmed_precision)}`);
  }
  if (now.dangerous_rate > previous.dangerous_rate + 1e-12) reasons.push(`dangerous error rate rose from ${pct(previous.dangerous_rate)} to ${pct(now.dangerous_rate)}`);
  return { failed: reasons.length > 0, reasons };
}

/** The report as Markdown for eval/report.md. */
export function toMarkdown(r: EvalReport, meta: { date: string; regression: RegressionResult; notes: string[] }): string {
  const out: string[] = [`# QuoteKill eval report (${r.set} set, ${meta.date})`, "", `**${r.headline}**`, ""];
  out.push(`Dangerous errors (shown safe but wrong): ${r.overall.dangerous.length} of ${r.cells.filter((c) => ["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED"].includes(c.got_state)).length} safe cells (${pct(r.dangerous_rate)}).`, "");
  out.push(meta.regression.failed ? `**Regression gate: FAILED.** ${meta.regression.reasons.join("; ")}.` : "Regression gate: passed (no drop in CONFIRMED precision, no rise in dangerous errors).", "");

  out.push("## Calibration (spec 19.2)", "", "| Reported state | Cells | Actually correct | Precision | Counted correct when |", "|---|---|---|---|---|");
  for (const c of r.calibration) out.push(`| ${c.state} | ${c.cells} | ${c.correct} | ${pct(c.precision)} | ${c.rule} |`);
  out.push("", `Wrong cells: ${r.wrong_cells.total}${r.wrong_cells.total ? ` (${r.wrong_cells.cells.join(", ")})` : ""}; flagged unsafe: ${r.wrong_cells.flagged_unsafe}.`, "");

  out.push("## Extraction (spec 19.1)", "", "| Group | Cells | State accuracy | Price accuracy | Quoted precision | Quoted recall | Dangerous |", "|---|---|---|---|---|---|---|");
  const row = (name: string, m: GroupMetrics) => `| ${name} | ${m.cells} | ${pct(m.state_accuracy)} | ${pct(m.price_accuracy)} of ${m.price_checked} | ${pct(m.quoted.precision)} | ${pct(m.quoted.recall)} | ${m.dangerous.length} |`;
  for (const [k, m] of Object.entries(r.per_vendor)) out.push(row(k, m));
  for (const [k, m] of Object.entries(r.per_format)) out.push(row(k, m));
  out.push(row("all", r.overall), "");

  const states = ["CONFIRMED", "HIGH_CONF", "BUYER_VERIFIED", "INFERRED", "NEEDS_REVIEW", "MISSING"];
  out.push("State confusion (rows expected, columns reported):", "", `| expected | ${states.join(" | ")} |`, `|---|${states.map(() => "---").join("|")}|`);
  for (const e of states.filter((s) => r.confusion[s])) out.push(`| ${e} | ${states.map((s) => r.confusion[e]![s] ?? 0).join(" | ")} |`);
  out.push("");

  out.push(`## Traps (spec 19.3): ${r.trap_recall.passed} of ${r.trap_recall.runnable} runnable passed; ${r.trap_recall.registered} registered`, "", "| Trap | Vendor | Status | Detail |", "|---|---|---|---|");
  for (const t of r.traps) out.push(`| ${t.id} | ${t.vendor} | ${t.status} | ${t.detail.replace(/\|/g, "/")} |`);
  out.push("");

  out.push("## Targets (spec 19.7)", "", "| Metric | Target | Value | Status |", "|---|---|---|---|");
  for (const t of r.targets) out.push(`| ${t.metric} | ${t.target} | ${t.value} | ${t.status} |`);
  out.push("");
  if (meta.notes.length) out.push("## Not covered yet", "", ...meta.notes.map((n) => `- ${n}`), "");
  return out.join("\n");
}
