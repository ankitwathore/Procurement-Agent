import { VENDOR_REGISTRY } from "../data/vendors.js";
import type { Quote } from "../ingest/quotes.js";
import { parseNumber } from "../normalize/parse.js";
import type { RfxHeader, RfxLine } from "../schemas.js";

/**
 * Confidentiality guard for every outbound draft (spec 13.3, SY07). Fails closed.
 * A draft to a vendor may carry only that vendor's own words and the RFx's public content. So:
 *  - every number must come from this vendor's own reply or the RFx's public line details (an allow list, which
 *    also keeps out last year's prices and anything we computed);
 *  - no other vendor's name or alias;
 *  - no comparative or internal phrases ("a competitor", "cheaper", "last year's price").
 * The model-based check for paraphrased leaks (spec 13.3 point 2) needs the API and is not in this function.
 */

export interface GuardProblem {
  kind: "number" | "vendor_name" | "phrase";
  text: string;
  detail: string;
}

export interface GuardResult {
  ok: boolean;
  problems: GuardProblem[];
}

const PHRASES: RegExp[] = [
  /\b(other|another|competing)\s+(vendors?|suppliers?|bidders?|quotations?|quotes|offers?)\b/i,
  /\bcompetitors?\b/i,
  /\b(cheaper|lower|better|higher)\s+(than|price|rate|offer|quote)/i,
  /\byour\s+(price|rate|quote)\s+is\s+(higher|lower|above|below)\b/i,
  /\b(market|benchmark|target)\s+(price|rate)\b/i,
  /\blast\s+year'?s?\s+(price|rate)s?\b/i,
  /\bbaseline\b/i,
  /\bL1\b/,
];

const NUMBER = /\d+(?:,\d+)*(?:\.\d+)?/g; // a comma counts only when a digit follows ("1600," ends a clause)

function numbersIn(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const raw of text.match(NUMBER) ?? []) {
    try {
      out.push({ raw, value: parseNumber(raw) });
    } catch {
      out.push({ raw, value: Number.NaN });
    }
  }
  return out;
}

export interface GuardContext {
  vendor_id: string;
  /** All quotes, every vendor: this vendor's supply the allowed numbers, the others' are named in a rejection. */
  quotes: readonly Quote[];
  lines: readonly RfxLine[];
  rfx: RfxHeader;
}

/** Snippets of the vendor's own reply that a quote carries: price components and both passes' readings. */
function ownSnippets(quotes: readonly Quote[]): string[] {
  return quotes.flatMap((q) => [
    ...q.components.map((c) => c.provenance.snippet),
    ...(q.reconciliation?.readings.map((r) => r.snippet) ?? []),
  ]);
}

/** Numbers anyone may see in a draft to any vendor: the RFx's public line details, its id and its dates. */
function publicNumbers(lines: readonly RfxLine[], rfx: RfxHeader): string[] {
  return [
    ...lines.flatMap((l) => [l.line_id, l.description, l.spec.dims_text, String(l.annual_qty), String(l.spec.ply ?? ""), String(l.spec.liner_gsm ?? ""), String(l.spec.bf ?? "")]),
    rfx.rfx_id,
    rfx.title,
    rfx.issue_date.split("-").reverse().join("-"),
    rfx.due_date.split("-").reverse().join("-"),
  ];
}

export function checkConfidentiality(draft: string, ctx: GuardContext, itemCount: number): GuardResult {
  const problems: GuardProblem[] = [];
  const mine = ctx.quotes.filter((q) => q.vendor_id === ctx.vendor_id);
  const allowed = new Set<number>();
  for (const t of [...ownSnippets(mine), ...publicNumbers(ctx.lines, ctx.rfx)]) for (const n of numbersIn(t)) allowed.add(n.value);
  for (let i = 1; i <= itemCount; i++) allowed.add(i); // the draft's own item numbers

  const others = ctx.quotes.filter((q) => q.vendor_id !== ctx.vendor_id);
  for (const n of numbersIn(draft)) {
    if (!Number.isNaN(n.value) && allowed.has(n.value)) continue;
    const owner = others.find((q) => ownSnippets([q]).some((s) => numbersIn(s).some((x) => x.value === n.value)));
    problems.push({
      kind: "number",
      text: n.raw,
      detail: owner ? `${n.raw} appears in ${owner.vendor_id}'s quotation (${owner.line_id})` : `${n.raw} is not in this vendor's reply or the RFx`,
    });
  }

  for (const v of VENDOR_REGISTRY.filter((x) => x.vendor_id !== ctx.vendor_id)) {
    for (const name of [v.name, ...v.aliases]) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(draft)) {
        problems.push({ kind: "vendor_name", text: name, detail: `names another vendor (${v.vendor_id})` });
      }
    }
  }

  for (const re of PHRASES) {
    const m = re.exec(draft);
    if (m) problems.push({ kind: "phrase", text: m[0], detail: "compares with other offers or reveals internal pricing" });
  }
  return { ok: problems.length === 0, problems };
}
