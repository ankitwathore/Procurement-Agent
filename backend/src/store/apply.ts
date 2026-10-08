import { QUESTIONS } from "../data/rfx.js";
import { vendorById } from "../data/vendors.js";
import { offeredPlies, summarizeGates } from "../evidence/gates.js";
import { withBuyerRate, type Quote } from "../ingest/quotes.js";
import { worstState } from "../model/states.js";
import { decide, pendingConfirmations } from "../review/confirmations.js";
import type { Session } from "../server/views.js";
import type { Store } from "./store.js";

/**
 * Re-applies the buyer's stored decisions to a session freshly built from the saved runs, in the order they were
 * made: gate waivers, batch confirmations, then cell verifications and overrides. A decision that no longer fits the
 * data (the cell changed, the confirmation is no longer pending) is skipped and reported, never forced.
 */

export interface ApplyReport {
  applied: number;
  skipped: { kind: string; ref: string; why: string }[];
}

/** Marks a cell's read rate correct: the rate component becomes BUYER_VERIFIED; the price does not change. */
export function verifyQuote(q: Quote, note: string): Quote {
  const rate = q.components.find((c) => c.kind === "base_rate");
  if (!rate || !q.landed) throw new Error(`${q.vendor_id} ${q.line_id} has no price to verify (${q.state}); enter the rate instead`);
  const components = q.components.map((c) => (c.kind === "base_rate" ? { ...c, state: "BUYER_VERIFIED" as const, basis: `${c.basis}; verified` } : c));
  const state = worstState(components.map((c) => c.state));
  const driver = components.find((c) => c.state === state);
  return {
    ...q,
    components,
    state,
    state_rule: 0,
    state_reason: state === "BUYER_VERIFIED" ? note : `${driver?.kind ?? "component"} is ${state} (${driver?.basis ?? ""}); the rate was ${note}`,
    flags: q.flags.includes("buyer_verified") ? q.flags : [...q.flags, "buyer_verified"],
  };
}

/** Re-evaluates one vendor's gates with its waivers. */
export function regate(s: Session, vendorId: string, waivers: readonly { q_id: string; reason: string; actor: string }[]): void {
  const v = s.vendors.find((x) => x.vendor_id === vendorId);
  if (!v) return;
  v.gates = summarizeGates(
    QUESTIONS,
    { vendor_name: vendorById(v.vendor_id).name, answers: v.answers, certificate: v.certificate, test_report: v.test_report, offered_plies: offeredPlies(v.quotes, s.lines), unread: v.evidence_docs.filter((d) => !d.read).map((d) => d.role as "certificate" | "test_report") },
    s.config,
    waivers,
  );
}

export function applyDecisions(s: Session, store: Store): ApplyReport {
  const report: ApplyReport = { applied: 0, skipped: [] };

  const waivers = store.waivers();
  for (const v of s.vendors) {
    const mine = waivers.filter((w) => w.vendor_id === v.vendor_id);
    if (mine.length === 0) continue;
    regate(s, v.vendor_id, mine.map((w) => ({ q_id: w.q_id, reason: w.reason, actor: w.actor })));
    report.applied += mine.length;
  }

  for (const c of store.confirmations()) {
    const v = s.vendors.find((x) => x.vendor_id === c.vendor_id);
    const pending = v ? pendingConfirmations(v.quotes, s.config.currency_of_record).find((x) => x.id === c.confirmation_id) : undefined;
    if (!v || !pending) {
      report.skipped.push({ kind: "confirmation", ref: c.confirmation_id, why: "no longer pending in the current data" });
      continue;
    }
    const r = decide(v.quotes, pending, c.decision, { actor: c.actor, at: c.at, reason: c.reason });
    v.quotes = r.quotes;
    s.decisions.push(r.log);
    report.applied++;
  }

  for (const o of store.overrides()) {
    const v = s.vendors.find((x) => x.vendor_id === o.vendor_id);
    const line = s.lines.find((l) => l.line_id === o.line_id);
    const q = v?.quotes.find((x) => x.line_id === o.line_id);
    if (!v || !line || !q) {
      report.skipped.push({ kind: o.field, ref: `${o.vendor_id}:${o.line_id}`, why: "no such cell" });
      continue;
    }
    const note = `${o.field === "verify" ? "Verified" : "Rate entered"} by ${o.actor} on ${o.at.slice(0, 10)}: ${o.reason}`;
    try {
      const next =
        o.field === "verify"
          ? verifyQuote(q, note)
          : withBuyerRate(q, line, Number(o.new_value), { vendorCity: vendorById(v.vendor_id).city.split(",").pop()!.trim(), config: s.config, vendorTerms: v.extraction.vendor_terms }, note);
      v.quotes = v.quotes.map((x) => (x.line_id === o.line_id ? next : x));
      report.applied++;
    } catch (err) {
      report.skipped.push({ kind: o.field, ref: `${o.vendor_id}:${o.line_id}`, why: (err as Error).message });
    }
  }
  return report;
}
