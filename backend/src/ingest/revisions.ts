import type { AllocationResult } from "../award/optimizer.js";
import type { CellState } from "../model/states.js";
import type { RfxLine } from "../schemas.js";
import { formatRupees } from "../util/format.js";
import type { Quote } from "./quotes.js";

/**
 * Revisions (spec 10.8, V01, W11, TR04). A revision supersedes the vendor's earlier submission; nothing is
 * deleted, the old one is kept as history. The buyer sees a per-line diff with its rupee impact, and any award
 * that used the superseded data is flagged stale.
 * Detection here is the deterministic half: explicit revision language. The model-based intent check comes later.
 */

const REVISION_LANGUAGE =
  /\b(revised (rates|prices|quotation|quote|offer|sheet)|revision\s*(no\.?\s*)?\d|rev\.?\s*\d|updated (rates|prices|quotation|quote|offer)|(please )?disregard (the |our )?(earlier|previous|last)|supersedes?\b|replaces? (the |our )?(earlier|previous))/i;

export function looksLikeRevision(text: string): boolean {
  return REVISION_LANGUAGE.test(text);
}

export interface Submission {
  submission_id: string;
  vendor_id: string;
  revision: number;
  received_at: string;
  is_current: boolean;
  supersedes: string | null;
  quotes: readonly Quote[];
}

/** Adds a revision for its vendor: the vendor's current submission becomes history. Returns a new history. */
export function supersede(
  history: readonly Submission[],
  incoming: Pick<Submission, "submission_id" | "vendor_id" | "received_at" | "quotes">,
): { history: Submission[]; current: Submission; superseded: Submission | null } {
  const previous = history.find((s) => s.vendor_id === incoming.vendor_id && s.is_current) ?? null;
  const revision = Math.max(0, ...history.filter((s) => s.vendor_id === incoming.vendor_id).map((s) => s.revision)) + 1;
  const current: Submission = { ...incoming, revision, is_current: true, supersedes: previous?.submission_id ?? null };
  const updated = history.map((s) => (s === previous ? { ...s, is_current: false } : s));
  return { history: [...updated, current], current, superseded: previous ? { ...previous, is_current: false } : null };
}

export type ChangeKind = "price_changed" | "state_changed" | "newly_quoted" | "withdrawn";

export interface LineChange {
  line_id: string;
  kind: ChangeKind;
  before: { point: number | null; state: CellState };
  after: { point: number | null; state: CellState };
  /** Landed unit price change, when both sides have a price. */
  delta_unit: number | null;
  /** Annual quantity x delta_unit. */
  delta_annual_inr: number | null;
}

export interface RevisionDiff {
  vendor_id: string;
  from_revision: number;
  to_revision: number;
  changes: LineChange[];
  /** Sum of delta_annual_inr over lines priced in both revisions. */
  annual_impact_inr: number;
  /** The banner sentence (spec 10.8). */
  headline: string;
}

const EPS = 1e-9;

function classify(before: Quote | undefined, after: Quote | undefined): ChangeKind | null {
  const b = before?.landed?.point ?? null;
  const a = after?.landed?.point ?? null;
  if (b === null && a !== null) return "newly_quoted";
  if (b !== null && a === null) return "withdrawn";
  if (b !== null && a !== null && Math.abs(a - b) > EPS) return "price_changed";
  if ((before?.state ?? "MISSING") !== (after?.state ?? "MISSING")) return "state_changed";
  return null;
}

export function diffSubmissions(from: Submission, to: Submission, lines: readonly RfxLine[]): RevisionDiff {
  const changes: LineChange[] = [];
  for (const line of lines) {
    const b = from.quotes.find((q) => q.line_id === line.line_id);
    const a = to.quotes.find((q) => q.line_id === line.line_id);
    const kind = classify(b, a);
    if (!kind) continue;
    const bp = b?.landed?.point ?? null;
    const ap = a?.landed?.point ?? null;
    const delta = bp !== null && ap !== null ? ap - bp : null;
    changes.push({
      line_id: line.line_id,
      kind,
      before: { point: bp, state: b?.state ?? "MISSING" },
      after: { point: ap, state: a?.state ?? "MISSING" },
      delta_unit: delta,
      delta_annual_inr: delta === null ? null : delta * line.annual_qty,
    });
  }
  const priced = changes.filter((c) => c.kind === "price_changed").length;
  const others = changes.length - priced;
  const annual = changes.reduce((s, c) => s + (c.delta_annual_inr ?? 0), 0);
  const headline =
    `${to.vendor_id} Rev ${to.revision} received, ${priced} price${priced === 1 ? "" : "s"} changed` +
    (others > 0 ? `, ${others} other line change${others === 1 ? "" : "s"}` : "") +
    ".";
  return { vendor_id: to.vendor_id, from_revision: from.revision, to_revision: to.revision, changes, annual_impact_inr: annual, headline };
}

export interface StaleAward {
  stale: boolean;
  /** Awarded lines whose price or state the revision changed. */
  affected_lines: string[];
  /** Annual rupee change on those lines at the awarded quantities. */
  impact_inr: number;
  message: string | null;
}

/**
 * An award that gave any line to the revised vendor used superseded data, so it is stale even if none of its
 * own lines changed (spec 10.8). The affected lines and their rupee impact say how much it matters.
 */
export function staleAward(award: AllocationResult, diff: RevisionDiff): StaleAward {
  const awarded = award.assignments.filter((a) => a.vendor_id === diff.vendor_id).map((a) => a.line_id);
  if (awarded.length === 0) return { stale: false, affected_lines: [], impact_inr: 0, message: null };
  const affected = diff.changes.filter((c) => awarded.includes(c.line_id));
  const impact = affected.reduce((s, c) => s + (c.delta_annual_inr ?? 0), 0);
  const sign = impact > 0 ? "+" : "";
  const message =
    `This award used ${diff.vendor_id} Rev ${diff.from_revision}, now superseded by Rev ${diff.to_revision}. ` +
    (affected.length === 0
      ? "None of its lines changed; re-run to confirm."
      : `${affected.length} awarded line${affected.length === 1 ? "" : "s"} changed (${affected.map((c) => c.line_id).join(", ")}), ${sign}${formatRupees(impact)} a year. Re-run before confirming.`);
  return { stale: true, affected_lines: affected.map((c) => c.line_id), impact_inr: impact, message };
}
