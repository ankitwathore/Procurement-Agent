import type { Config } from "../config.js";
import type { RfxLine } from "../schemas.js";
import { checkLineTotal, checkOutlier, checkSpec, type LineTotalResult, type MagnitudeSlip, type SpecFlag } from "./checks.js";
import { LEGIBILITY_MIN, NO_FLAGS, assignState, worstState, type CellState, type StateInputs } from "../model/states.js";
import { exGst, freightPerUom, toBaseUomRate, toInr } from "../normalize/convert.js";
import { canonicalUnit } from "../normalize/parse.js";
import { assessVendor, type VendorAssessment } from "./vendor.js";
import { topCandidate, validateRows, type Extraction, type RejectedRow, type Row } from "./extraction.js";
import type { Adjudication, AdjudicationDecision } from "./adjudicate.js";
import { hiddenValuesFor, type HiddenValue } from "./hidden.js";
import type { ParsedDocx } from "./parse_docx.js";
import type { ParsedPdf } from "./parse_pdf.js";
import type { ParsedWorkbook } from "./parse_xlsx.js";

export type ComponentKind = "base_rate" | "freight";

export interface Provenance {
  locator: Record<string, unknown>;
  snippet: string;
}

/** Values are INR per base UoM, ex GST. Safe components have low = point = high. */
export interface Component {
  kind: ComponentKind;
  point: number;
  low: number;
  high: number;
  state: CellState;
  basis: string;
  provenance: Provenance;
}

export interface Quote {
  vendor_id: string;
  line_id: string;
  state: CellState;
  state_rule: number;
  state_reason: string;
  components: Component[];
  /** Sum of components, or null when the line has no usable price (MISSING, NEEDS_REVIEW). */
  landed: { point: number; low: number; high: number } | null;
  chain: string[];
  assumptions: string[];
  flags: string[];
  /** A probable correction for a magnitude slip. Shown to the buyer, never applied. */
  suggested_reading: MagnitudeSlip | null;
  /** Result of qty x rate vs the vendor's own line total, or null when the vendor stated no total. */
  arithmetic: LineTotalResult | null;
  /** Offered spec vs the RFx line. Does not change the cell state; it decides comparability under the spec policy. */
  spec_flags: SpecFlag[];
  /** Spec fields the vendor did not state, so nothing was judged for them. */
  spec_unstated: string[];
  /** Values for this line found in hidden cells. Shown to the buyer, never used as the price (spec F02). */
  hidden_values: { value: number | null; snippet: string; locator: Record<string, unknown> }[];
  /** How pass A and pass B compared on this line; null when only one pass was run. */
  reconciliation: Reconciliation | null;
  /** Earlier values of this cell, oldest first, each replaced by a later message (spec 13.4). Absent when never revised. */
  history?: CellRevision[];
}

/** One earlier value of a cell, kept when a vendor's reply replaced it. */
export interface CellRevision {
  state: CellState;
  state_reason: string;
  components: Component[];
  landed: Quote["landed"];
  flags: string[];
  /** The message that replaced it, and when. */
  replaced_by: string;
  replaced_at: string;
}

export interface BuildInput {
  vendorId: string;
  vendorCity: string;
  config: Config;
  lines: readonly RfxLine[];
  extraction: Extraction;
  sourceText: string;
  /** The parsed workbook, required to verify xlsx locators. */
  workbook?: ParsedWorkbook;
  /** For an email: where quoted history begins in `sourceText`. */
  authoritativeEnd?: number;
  /** The parsed PDF, required to verify pdf locators. */
  pdf?: ParsedPdf;
  /** The parsed Word document, required to verify docx locators. */
  docx?: ParsedDocx;
  textNative: boolean;
  /** Other vendors' normalized base rates per line (INR per base UoM, ex GST, before freight). */
  peerRates?: ReadonlyMap<string, readonly number[]>;
  /** When the submission arrived (date or datetime). Lateness is only judged when this is given. */
  receivedAt?: string;
  /** Pass B's independent, RFx-first reading. When given, every priced line must agree across both passes. */
  passB?: Extraction;
  /** The adjudicator's decisions on disputed lines (spec 10.6 step 2). */
  adjudications?: readonly Adjudication[];
}

export type ReconciliationStatus = "agree" | "disagree" | "a_only" | "b_only" | "neither";

export interface Reading {
  pass: "A" | "B";
  value: number | null;
  currency: string;
  unit: string | null;
  snippet: string;
  locator: Record<string, unknown>;
}

export interface Reconciliation {
  status: ReconciliationStatus;
  detail: string;
  /** Both readings, so the buyer (or the adjudicator) can see exactly where they part. */
  readings: Reading[];
  /** The adjudicator's decision on a disputed line, when it ran. */
  adjudication?: { decision: AdjudicationDecision; reasoning: string; model: string | null };
}

export interface BuildResult {
  quotes: Quote[];
  rejected: RejectedRow[];
  /** Verified rows read from hidden cells. Evidence only. */
  hidden_rows: Row[];
  /** Alternate or extra offers, passed through for the buyer. Never part of the comparison. */
  extras: Extraction["extras"];
  vendor: VendorAssessment;
}

function byLine(rows: readonly Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const id = topCandidate(row);
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

export function buildQuotes(input: BuildInput): BuildResult {
  const { valid, hidden, rejected } = validateRows(
    input.extraction,
    { text: input.sourceText, workbook: input.workbook, pdf: input.pdf, docx: input.docx, authoritativeEnd: input.authoritativeEnd },
    input.lines.map((l) => l.line_id),
  );
  const visibleByLine = byLine(valid);
  const hiddenByLine = byLine(hidden);
  // Hidden values found in the workbook itself, whatever the model reported (trap 02 must not depend on it).
  const fromWorkbook = input.workbook
    ? hiddenValuesFor(valid.map((row) => ({ line_id: topCandidate(row), row })), input.workbook)
    : new Map<string, HiddenValue[]>();
  // Pass B rows go through the same provenance checks; a pass B row that fails is treated as not found.
  const b = input.passB
    ? validateRows(input.passB, { text: input.sourceText, workbook: input.workbook, pdf: input.pdf, docx: input.docx, authoritativeEnd: input.authoritativeEnd }, input.lines.map((l) => l.line_id))
    : null;
  const bByLine = byLine(b?.valid ?? []);
  const adjRejected: RejectedRow[] = [];
  const quotes = input.lines.map((line) => {
    const visible = visibleByLine.get(line.line_id) ?? [];
    const recon = b ? reconcile(visible, bByLine.get(line.line_id) ?? [], input.config.tolerances.rate_agreement_pct) : null;
    const disputed = recon !== null && recon.status !== "agree" && recon.status !== "neither";
    const adj = disputed ? input.adjudications?.find((x) => x.line_id === line.line_id) : undefined;
    let quote: Quote;
    if (!disputed) {
      quote = buildQuote(input, line, visible);
    } else if (!adj || adj.decision === "UNRESOLVED") {
      quote = disagreementQuote(input, line, recon, adj?.reasoning);
    } else {
      quote = adjudicatedQuote(input, line, adj, visible, bByLine.get(line.line_id) ?? [], recon, adjRejected);
    }
    quote.reconciliation = adj ? { ...(recon as Reconciliation), adjudication: { decision: adj.decision, reasoning: adj.reasoning, model: adj.model } } : recon;
    const reported = (hiddenByLine.get(line.line_id) ?? []).map((h) => ({ value: h.rate.value, snippet: h.snippet, locator: h.locator }));
    annotateHidden(quote, visible, mergeHidden(reported, fromWorkbook.get(line.line_id) ?? []), input.config.tolerances.rate_agreement_pct);
    return quote;
  });
  const vendor = assessVendor(input.extraction.vendor_terms, input.receivedAt, input.config);
  return { quotes, rejected: [...rejected, ...(b?.rejected ?? []), ...adjRejected], hidden_rows: hidden, extras: input.extraction.extras, vendor };
}

const readingOf = (pass: "A" | "B", r: Row): Reading => ({
  pass,
  value: r.rate.value,
  currency: r.rate.currency,
  unit: r.rate.unit_as_written,
  snippet: r.snippet,
  locator: r.locator,
});

const describe = (r: Reading) => `${r.currency} ${r.value ?? "?"} ${r.unit ?? "(no unit)"}`.trim();

/**
 * Compares the two passes on one line (spec 10.6). Agreement needs the same rate within tolerance, the same
 * canonical unit, and the same currency. Anything else, including one pass finding an offer the other did not, is a
 * disagreement that a person or the adjudicator must settle.
 */
export function reconcile(aRows: readonly Row[], bRows: readonly Row[], tolerancePct: number): Reconciliation {
  const a = aRows.length === 1 ? readingOf("A", aRows[0] as Row) : null;
  const bb = bRows.length === 1 ? readingOf("B", bRows[0] as Row) : null;
  const readings = [...aRows.map((r) => readingOf("A", r)), ...bRows.map((r) => readingOf("B", r))];
  if (aRows.length === 0 && bRows.length === 0) return { status: "neither", detail: "Neither pass found an offer for this line.", readings };
  if (aRows.length === 0) return { status: "b_only", detail: `Only pass B found an offer (${describe(readings[0] as Reading)}).`, readings };
  if (bRows.length === 0) return { status: "a_only", detail: `Only pass A found an offer (${describe(readings[0] as Reading)}).`, readings };
  if (!a || !bb) return { status: "disagree", detail: "A pass gave more than one reading for this line.", readings };
  // Both passes found the line and neither could read a price: nothing for an adjudicator to settle. The line still
  // goes to review (rule 3, unreadable).
  if (a.value === null && bb.value === null) return { status: "agree", detail: "Both passes found the line; neither could read its price.", readings };

  const sameUnit = JSON.stringify(canonicalUnit(a.unit)) === JSON.stringify(canonicalUnit(bb.unit));
  const sameCurrency = (normalizeCurrency(a.currency) ?? a.currency.trim()) === (normalizeCurrency(bb.currency) ?? bb.currency.trim());
  const sameValue =
    a.value !== null && bb.value !== null && (a.value === bb.value || (Math.abs(a.value - bb.value) / Math.max(Math.abs(a.value), Math.abs(bb.value))) * 100 <= tolerancePct);
  if (sameUnit && sameCurrency && sameValue) return { status: "agree", detail: `Both passes read ${describe(a)}.`, readings };
  return { status: "disagree", detail: `Pass A read ${describe(a)}; pass B read ${describe(bb)}.`, readings };
}

/** A line the passes disagree on: no price until it is settled; both readings travel with it. */
function disagreementQuote(input: BuildInput, line: RfxLine, recon: Reconciliation, adjudicatorSays?: string): Quote {
  const quote = emptyQuote(input, line);
  const result = assignState({ ...NO_FLAGS, passesDisagree: true, adjudication: "unresolved", detail: recon.detail });
  quote.state = result.state;
  quote.state_rule = result.rule;
  quote.state_reason = `${result.reason} ${recon.detail}${adjudicatorSays ? ` Adjudicator: ${adjudicatorSays}` : ""}`;
  quote.flags.push("passes_disagree");
  return quote;
}

/**
 * A disputed line the adjudicator settled. The chosen reading is built like any other, but marked as adjudicated, so
 * rule 2 caps it at HIGH_CONF; later rules (a carried-over unit, an outlier) can still lower it. A third reading must
 * pass the same provenance check as the passes' rows, or the line stays in review.
 */
function adjudicatedQuote(
  input: BuildInput,
  line: RfxLine,
  adj: Adjudication,
  aRows: Row[],
  bRows: Row[],
  recon: Reconciliation,
  rejected: RejectedRow[],
): Quote {
  if (adj.decision === "NO_OFFER") {
    const quote = buildQuote(input, line, []);
    quote.flags.push("adjudicated", "adjudicated_no_offer");
    return quote;
  }
  let rows = adj.decision === "A" ? aRows : adj.decision === "B" ? bRows : [];
  if (adj.decision === "THIRD") {
    const check = adj.row
      ? validateRows({ vendor_terms: {}, rows: [adj.row], extras: [], notes: [] }, { text: input.sourceText, workbook: input.workbook, pdf: input.pdf, docx: input.docx, authoritativeEnd: input.authoritativeEnd }, input.lines.map((l) => l.line_id))
      : null;
    if (!check || check.valid.length !== 1) {
      rejected.push(...(check?.rejected ?? []));
      return disagreementQuote(input, line, recon, `proposed a third reading that does not check out against the document. ${adj.reasoning}`);
    }
    rows = check.valid;
  }
  const quote = buildQuote(input, line, rows, { passesDisagree: true, adjudication: "resolved" });
  quote.flags.push("adjudicated");
  return quote;
}

/** One entry per hidden cell, whether the model reported it, the workbook check found it, or both. */
function mergeHidden(a: readonly HiddenValue[], b: readonly HiddenValue[]): HiddenValue[] {
  const key = (h: HiddenValue) => `${h.locator.sheet}!${h.locator.cell}`;
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((h) => !seen.has(key(h)))];
}

/**
 * Records hidden values for a line and flags `hidden_value_differs` when one differs from the visible rate,
 * or when only a hidden value exists. The cell state is not changed: the visible value is what the vendor offered.
 */
function annotateHidden(quote: Quote, visible: readonly Row[], hidden: readonly HiddenValue[], tolerancePct: number): void {
  if (hidden.length === 0) return;
  quote.hidden_values = [...hidden];
  const shown = visible.length === 1 ? (visible[0] as Row).rate.value : null;
  const differs =
    shown === null ||
    hidden.some((h) => h.value === null || (Math.abs(h.value - shown) / Math.abs(shown)) * 100 > tolerancePct);
  if (differs) quote.flags.push("hidden_value_differs");
}

function emptyQuote(input: BuildInput, line: RfxLine): Quote {
  return {
    vendor_id: input.vendorId,
    line_id: line.line_id,
    state: "MISSING",
    state_rule: 1,
    state_reason: "",
    components: [],
    landed: null,
    chain: [],
    assumptions: [],
    flags: [],
    suggested_reading: null,
    arithmetic: null,
    spec_flags: [],
    spec_unstated: [],
    hidden_values: [],
    reconciliation: null,
  };
}

function buildQuote(input: BuildInput, line: RfxLine, rows: Row[], extra: Partial<StateInputs> = {}): Quote {
  const quote = emptyQuote(input, line);
  const statement = input.extraction.vendor_terms.lines_not_quoted_statement;

  if (rows.length === 0) {
    const covered = statement?.resolves_to === "baseline";
    const result = assignState({ ...NO_FLAGS, hasQuoteEvidence: false, coveredByDefaultStatement: covered });
    quote.state = result.state;
    quote.state_rule = result.rule;
    quote.state_reason = result.reason;
    if (!covered || !statement) return quote;

    const { low_pct, high_pct } = input.config.inference_bands.baseline_same_as_last_year;
    const b = line.baseline_price_inr;
    quote.components.push({
      kind: "base_rate",
      point: b,
      low: b * (1 + low_pct / 100),
      high: b * (1 + high_pct / 100),
      state: result.state,
      basis: "baseline_same_as_last_year",
      provenance: { locator: { type: "derived", inputs: [`baseline:${line.line_id}`], rule: "baseline_same_as_last_year" }, snippet: statement.snippet },
    });
    return finish(input, line, quote, true);
  }

  if (rows.length > 1) {
    return reviewQuote(quote, { conflictingRows: true, detail: `${rows.length} rows map to ${line.line_id}` });
  }

  const row = rows[0] as Row;
  const flags: Partial<StateInputs> = {
    ...extra,
    struckOut: row.struck_out_or_overwritten,
    unreadable: row.legibility < LEGIBILITY_MIN || row.rate.value === null,
    visionDerived: !input.textNative,
    lowImpactAssumption: row.assumptions.length > 0,
    carriedOver: row.carried_over.length > 0,
  };
  for (const field of row.carried_over) {
    quote.flags.push(`carried_over_${field}`);
    quote.assumptions.push(`The ${field} is not written next to this price; it is taken from the same sentence ("${row.snippet}").`);
  }

  const unit = canonicalUnit(row.rate.unit_as_written);
  let currency = normalizeCurrency(row.rate.currency);
  if (!unit) return reviewQuote(quote, { ...flags, unitAmbiguous: true, detail: `unit "${row.rate.unit_as_written ?? "not stated"}"` });
  if (!currency && row.rate.currency.trim() === "") {
    // No currency written at all: price it in the RFx currency, unsafe until the buyer confirms (batch confirmation).
    // A currency that is written but not recognised still goes to review below.
    currency = input.config.currency_of_record;
    flags.carriedOver = true;
    quote.flags.push("currency_assumed");
    quote.assumptions.push(`No currency is written for this price; it is taken as ${currency}, the RFx currency, until the buyer confirms.`);
  }
  if (!currency) return reviewQuote(quote, { ...flags, unitAmbiguous: true, detail: `currency "${row.rate.currency}"` });
  if (row.rate.value === null) return reviewQuote(quote, flags);

  const base = toBaseUomRate(row.rate.value, unit, line);
  if (!base.ok) return reviewQuote(quote, { ...flags, unitAmbiguous: true, detail: base.reason });

  const fx = toInr(base.rate, currency, input.config.fx.USD_INR);
  const gst = input.extraction.vendor_terms.gst_basis;
  const inclusive = gst?.value === "inclusive";
  const gstPct = gst?.rate_pct ?? input.config.gst.default_rate_pct;
  const rate = exGst(fx.rate, gstPct, inclusive);

  quote.chain = [...base.chain, ...fx.chain];
  if (inclusive) quote.chain.push(`${fx.rate} incl ${gstPct}% GST = ${rate} ex GST`);
  if (!gst || gst.value === "unstated") {
    quote.assumptions.push("GST basis not stated; taken as ex GST per the RFx terms.");
    quote.flags.push("gst_basis_assumed");
  }
  quote.assumptions.push(...row.assumptions);

  const details: string[] = [];
  // With a candidate reading, the range spans every reading (spec 8.5).
  const candidates = [rate];

  const check = checkOutlier(rate, input.peerRates?.get(line.line_id) ?? [], line.baseline_price_inr, input.config.tolerances);
  if (check.hardOutlier) {
    flags.hardOutlier = true;
    details.push(...check.reasons);
    quote.flags.push(check.slip ? "magnitude_slip" : "outlier_price");
  }
  quote.suggested_reading = check.slip;
  if (check.slip) candidates.push(check.slip.suggested_rate);

  // The vendor's total is checked on the rate as displayed (before GST is stripped), at the RFx annual quantity.
  const arithmetic = checkLineTotal(
    { quantity: line.annual_qty, rate: base.rate, statedTotal: row.line_total_as_written },
    input.config.tolerances.arithmetic_pct,
  );
  quote.arithmetic = arithmetic;
  if (arithmetic?.fails) {
    flags.arithmeticFails = true;
    details.push(
      `vendor total ${arithmetic.stated} vs quantity x rate ${arithmetic.expected} (${arithmetic.diff_pct.toFixed(1)}% apart)`,
    );
    quote.flags.push("arithmetic_mismatch");
    // The rate the vendor's own total implies, in the same ex GST INR terms.
    const impliedBase = arithmetic.stated / line.annual_qty;
    candidates.push(exGst(toInr(impliedBase, currency, input.config.fx.USD_INR).rate, gstPct, inclusive));
  }
  if (details.length > 0) flags.detail = details.join("; ");

  const spec = checkSpec(line.spec, row.spec_offered, input.config.tolerances.dim_tolerance_pct);
  quote.spec_flags = spec.flags;
  quote.spec_unstated = spec.unstated;
  for (const f of spec.flags) if (!quote.flags.includes(f.kind)) quote.flags.push(f.kind);

  // A USD price "subject to the rate on the date of order" gets a band, and can never be safe (spec C02, 8.5).
  const fxClause = input.extraction.vendor_terms.fx_clause;
  if (currency === "USD" && fxClause) {
    const band = input.config.fx.clause_band_pct / 100;
    flags.fxClause = true;
    quote.flags.push("fx_clause");
    candidates.push(rate * (1 - band), rate * (1 + band));
  }

  const result = assignState({ ...NO_FLAGS, ...flags });
  quote.state = result.state;
  quote.state_rule = result.rule;
  quote.state_reason = result.reason;
  quote.components.push({
    kind: "base_rate",
    point: rate,
    low: Math.min(...candidates),
    high: Math.max(...candidates),
    state: result.state,
    basis: flags.fxClause ? "fx_clause_band" : "stated",
    provenance: { locator: row.locator, snippet: row.snippet },
  });
  return finish(input, line, quote, false);
}

/**
 * A quote rebuilt around a rate the buyer entered (an override, logged with a reason): the rate is BUYER_VERIFIED,
 * and freight is added again per the vendor's terms, so the landed cost and its state follow the normal rules.
 */
export function withBuyerRate(q: Quote, line: RfxLine, rate: number, ctx: { vendorCity: string; config: Config; vendorTerms: Extraction["vendor_terms"] }, note: string): Quote {
  const quote: Quote = {
    ...q,
    state: "BUYER_VERIFIED",
    state_rule: 0,
    state_reason: note,
    components: [{ kind: "base_rate", point: rate, low: rate, high: rate, state: "BUYER_VERIFIED", basis: "buyer_override", provenance: { locator: { type: "override" }, snippet: note } }],
    landed: null,
    chain: [...q.chain, `buyer override: ${rate} per ${line.base_uom}`],
    flags: q.flags.includes("buyer_override") ? q.flags : [...q.flags, "buyer_override"],
    suggested_reading: null,
  };
  const input = { vendorCity: ctx.vendorCity, config: ctx.config, extraction: { vendor_terms: ctx.vendorTerms } } as unknown as BuildInput;
  return finish(input, line, quote, false);
}

function reviewQuote(quote: Quote, flags: Partial<StateInputs>): Quote {
  const result = assignState({ ...NO_FLAGS, ...flags });
  quote.state = result.state;
  quote.state_rule = result.rule;
  quote.state_reason = result.reason;
  return quote;
}

const INR_WORDS = new Set(["INR", "RS", "RS.", "₹", "RUPEE", "RUPEES", "INDIAN RUPEES", "IRS"]);
const USD_WORDS = new Set(["USD", "$", "US$", "US $", "$US", "U.S.$", "US DOLLAR", "US DOLLARS", "DOLLAR", "DOLLARS", "USD$"]);

/** A currency as written to its code; null when it is not one we can price (it then goes to review). */
function normalizeCurrency(raw: string): "INR" | "USD" | null {
  const c = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (INR_WORDS.has(c)) return "INR";
  if (USD_WORDS.has(c)) return "USD";
  return null;
}

/**
 * Adds the freight component (spec 8.5 bounds), then derives landed cost and the quote's worst state.
 */
function finish(input: BuildInput, line: RfxLine, quote: Quote, baseInferred: boolean): Quote {
  const freight = input.extraction.vendor_terms.freight_basis;
  const basis = freight?.value ?? "unstated";

  if (basis === "freight_extra" || basis === "ex_works") {
    const { freight: f } = input.config;
    const laneRate = f.lanes[input.vendorCity];
    const ratePerKg = laneRate ?? f.default_when_unknown;
    const band = (laneRate !== undefined ? f.band_pct_lane_known : f.band_pct_default) / 100;
    const point = freightPerUom(ratePerKg, line.weight_kg_per_uom);
    quote.components.push({
      kind: "freight",
      point,
      // Same as last year may already have included freight, so the low reading is zero (spec 8.5).
      low: baseInferred ? 0 : point * (1 - band),
      high: point * (1 + band),
      state: "INFERRED",
      basis: laneRate !== undefined ? "lane_tariff" : "default_tariff",
      provenance: {
        locator: { type: "derived", inputs: [`${quote.vendor_id}:${line.line_id}:base_rate`], rule: laneRate !== undefined ? "lane_tariff" : "default_tariff" },
        snippet: freight?.snippet ?? "",
      },
    });
    quote.chain.push(`freight ${ratePerKg} per kg x ${line.weight_kg_per_uom} kg = ${point}`);
  } else if (basis === "unstated") {
    quote.assumptions.push("Freight basis not stated; no freight added, landed cost may be understated.");
    quote.flags.push("freight_basis_assumed");
  }

  quote.landed = quote.components.reduce(
    (t, c) => ({ point: t.point + c.point, low: t.low + c.low, high: t.high + c.high }),
    { point: 0, low: 0, high: 0 },
  );
  const worst = worstState(quote.components.map((c) => c.state));
  if (worst !== quote.state) {
    const driver = quote.components.find((c) => c.state === worst);
    quote.state = worst;
    quote.state_reason = `${driver?.kind ?? "component"} is ${worst} (${driver?.basis ?? "derived"}).`;
  }
  return quote;
}
