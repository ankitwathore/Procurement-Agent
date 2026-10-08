import type { Quote } from "../ingest/quotes.js";
import { worstState } from "../model/states.js";

/**
 * Batch confirmations: one buyer decision that settles several cells resting on the same reading.
 *  - carried_over: a unit or currency carried over within a vendor's sentence ("Rs 42/kg for the 5-ply, 38 for the
 *    3-ply").
 *  - currency_assumed: no currency written at all, priced in the RFx currency.
 * Those cells are priced but INFERRED until the buyer confirms the reading once per vendor and kind. Confirming
 * marks the affected price components BUYER_VERIFIED; rejecting sends the cells to review unpriced. Every decision
 * is logged (spec TR03). Inputs are never changed; new quote objects are returned.
 */

export type ConfirmationKind = "carried_over" | "currency_assumed";

export interface Confirmation {
  id: string;
  vendor_id: string;
  kind: ConfirmationKind;
  fields: string[];
  lines: string[];
  /** The vendor's own words the reading rests on (all of them; the question quotes the first few). */
  snippets: string[];
  question: string;
}

export interface DecisionLog {
  confirmation_id: string;
  decision: "confirmed" | "rejected";
  lines: string[];
  actor: string;
  at: string;
  reason: string;
}

/** The question quotes at most this many snippets, then says how many more. */
export const QUOTED_SNIPPETS = 3;

function pendingKind(q: Quote): { kind: ConfirmationKind; fields: string[] } | null {
  if (q.flags.includes("currency_assumed")) return { kind: "currency_assumed", fields: ["currency"] };
  const fields = q.flags.filter((f) => f.startsWith("carried_over_")).map((f) => f.slice("carried_over_".length)).sort();
  return fields.length > 0 ? { kind: "carried_over", fields } : null;
}

const quoteList = (snippets: string[]): string => {
  const shown = snippets.slice(0, QUOTED_SNIPPETS).map((s) => `"${s}"`).join(", ");
  const more = snippets.length - QUOTED_SNIPPETS;
  return more > 0 ? `${shown} and ${more} more` : shown;
};

function questionFor(kind: ConfirmationKind, vendor: string, fields: string[], lines: string[], snippets: string[], currency: string): string {
  const these = lines.length === 1 ? "this price" : "these prices";
  if (kind === "currency_assumed") {
    return `${vendor} did not state a currency for ${these} (${quoteList(snippets)}); ${lines.length === 1 ? "it is" : "they are"} priced in ${currency}, the RFx currency. Confirm ${currency} for ${lines.join(", ")}?`;
  }
  return `${vendor} did not write the ${fields.join(" or ")} next to ${these} (${quoteList(snippets)}); it was read from the same sentence. Confirm that reading for ${lines.join(", ")}?`;
}

export function pendingConfirmations(quotes: readonly Quote[], currencyOfRecord = "INR"): Confirmation[] {
  const groups = new Map<string, { kind: ConfirmationKind; fields: string[]; quotes: Quote[] }>();
  for (const q of quotes) {
    const pending = pendingKind(q);
    if (!pending || q.components.length === 0) continue;
    if (q.components.some((c) => c.kind === "base_rate" && c.state === "BUYER_VERIFIED")) continue;
    const key = `${q.vendor_id}:${pending.kind}:${pending.fields.join(",")}`;
    const g = groups.get(key) ?? { ...pending, quotes: [] };
    g.quotes.push(q);
    groups.set(key, g);
  }
  return [...groups.entries()].map(([id, g]) => {
    const vendor = (g.quotes[0] as Quote).vendor_id;
    const snippets = [...new Set(g.quotes.map((q) => q.components.find((c) => c.kind === "base_rate")?.provenance.snippet ?? "").filter(Boolean))];
    const lines = g.quotes.map((q) => q.line_id);
    return { id, vendor_id: vendor, kind: g.kind, fields: g.fields, lines, snippets, question: questionFor(g.kind, vendor, g.fields, lines, snippets, currencyOfRecord) };
  });
}

function settle(q: Quote, decision: "confirmed" | "rejected", log: DecisionLog): Quote {
  if (decision === "rejected") {
    return {
      ...q,
      state: "NEEDS_REVIEW",
      state_rule: 4,
      state_reason: `Buyer rejected the reading (${log.reason}).`,
      components: [],
      landed: null,
    };
  }
  const components = q.components.map((c) => (c.kind === "base_rate" ? { ...c, state: "BUYER_VERIFIED" as const, basis: `${c.basis}; confirmed by ${log.actor}` } : c));
  const state = worstState(components.map((c) => c.state));
  const driver = components.find((c) => c.state === state);
  return {
    ...q,
    components,
    state,
    state_reason: state === "BUYER_VERIFIED" ? `Confirmed by ${log.actor} on ${log.at.slice(0, 10)}: ${log.reason}` : `${driver?.kind ?? "component"} is ${state} (${driver?.basis ?? ""}).`,
  };
}

/** Applies one decision to every cell in the confirmation. Returns new quotes and the log entry. */
export function decide(
  quotes: readonly Quote[],
  confirmation: Confirmation,
  decision: "confirmed" | "rejected",
  who: { actor: string; at: string; reason: string },
): { quotes: Quote[]; log: DecisionLog } {
  if (who.reason.trim() === "") throw new Error("a decision needs a reason");
  const log: DecisionLog = { confirmation_id: confirmation.id, decision, lines: confirmation.lines, ...who };
  const out = quotes.map((q) => (q.vendor_id === confirmation.vendor_id && confirmation.lines.includes(q.line_id) ? settle(q, decision, log) : q));
  return { quotes: out, log };
}
