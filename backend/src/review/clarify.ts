import { vendorById } from "../data/vendors.js";
import type { Quote } from "../ingest/quotes.js";
import type { RfxHeader, RfxLine } from "../schemas.js";
import { pendingConfirmations } from "./confirmations.js";
import { checkConfidentiality, type GuardResult } from "./guard.js";

/**
 * Clarification drafts (spec 13.3, edge V06, demo G8). One email per vendor listing exactly what is unclear, each
 * item quoting the vendor's own words and asking one precise question. Never sent: the result is a draft, and a draft
 * that fails the confidentiality guard is blocked (fail closed).
 * Questions are written by code, not a model, so they are exact and the guard has nothing to second-guess.
 */

export interface ClarificationItem {
  lines: string[];
  question: string;
}

export interface ClarificationDraft {
  vendor_id: string;
  /** The thread id: a vendor's reply carries it as In-Reply-To, which is how the reply loop finds this draft. */
  message_id: string;
  to: string;
  subject: string;
  body: string;
  items: ClarificationItem[];
  status: "drafted" | "blocked";
  guard: GuardResult;
}

const label = (l: RfxLine) => `${l.description} (${l.line_id})`;
const snippetOf = (q: Quote): string | null => q.components.find((c) => c.kind === "base_rate")?.provenance.snippet ?? q.reconciliation?.readings[0]?.snippet ?? null;

/** One question per review item, from why the cell is in review. Lines that are only unconfirmed are batched below. */
function reviewItem(q: Quote, line: RfxLine): ClarificationItem | null {
  if (q.state !== "NEEDS_REVIEW") return null;
  const recon = q.reconciliation;
  if (recon && (recon.status === "a_only" || recon.status === "b_only")) {
    const r = recon.readings[0]!;
    // Name the figure when the vendor's own words show it, so a sentence with two prices is not ambiguous.
    const which = r.value !== null && new RegExp(`(^|[^\\d.])${String(r.value).replace(".", "\\.")}(?![\\d])`).test(r.snippet) ? `the ${r.value} in it` : "this price";
    return { lines: [line.line_id], question: `Your reply says "${r.snippet}". Does ${which} apply to ${label(line)}? If so, please confirm the rate and the unit for it.` };
  }
  if (recon && recon.status === "disagree") {
    const snippets = [...new Set(recon.readings.map((r) => r.snippet))].map((s) => `"${s}"`).join(" and ");
    return { lines: [line.line_id], question: `For ${label(line)}, please confirm the rate and the unit; your reply can be read as ${snippets}.` };
  }
  const snip = snippetOf(q);
  if (q.flags.includes("magnitude_slip") || q.flags.includes("outlier_price")) {
    return { lines: [line.line_id], question: `For ${label(line)}, your quotation shows "${snip}". Please confirm this rate and its unit are correct.` };
  }
  if (q.flags.includes("arithmetic_mismatch")) {
    return { lines: [line.line_id], question: `For ${label(line)}, the amount in your quotation does not equal the rate times the quantity ("${snip}"). Please confirm the rate and the amount.` };
  }
  if (/per box/i.test(q.state_reason)) {
    return { lines: [line.line_id], question: `For ${label(line)}, your rate is per box. How many ${line.base_uom}s does one box hold?` };
  }
  if (q.state_rule === 7) {
    return { lines: [line.line_id], question: `For ${label(line)}, the rate in your quotation has been corrected by hand. Please confirm which rate applies.` };
  }
  return { lines: [line.line_id], question: `For ${label(line)}, we could not read the rate clearly from your reply. Please restate the rate, the unit and the currency.` };
}

export function clarificationItems(quotes: readonly Quote[], lines: readonly RfxLine[], vendorId: string): ClarificationItem[] {
  const mine = quotes.filter((q) => q.vendor_id === vendorId);
  const items: ClarificationItem[] = [];
  for (const q of mine) {
    const line = lines.find((l) => l.line_id === q.line_id);
    const item = line ? reviewItem(q, line) : null;
    if (item) items.push(item);
  }
  for (const c of pendingConfirmations(mine)) {
    const names = c.lines.map((id) => label(lines.find((l) => l.line_id === id) as RfxLine)).join(", ");
    const quoted = c.snippets.map((s) => `"${s}"`).join(", ");
    items.push(
      c.kind === "currency_assumed"
        ? { lines: c.lines, question: `Please confirm the currency of your prices for ${names} (${quoted}).` }
        : { lines: c.lines, question: `Your reply says ${quoted}. Please confirm the ${c.fields.join(" and ")} for this price, for ${names}.` },
    );
  }
  return items;
}

/** Our own outbound id for the n-th clarification to a vendor on an RFx. Deterministic, so a scripted reply can cite it. */
export function clarificationMessageId(vendorId: string, rfxId: string, seq = 1): string {
  return `<clarify-${vendorId.toLowerCase()}-${rfxId.toLowerCase()}-${seq}@kaverihome.example>`;
}

export function draftClarification(
  vendorId: string,
  quotes: readonly Quote[],
  lines: readonly RfxLine[],
  rfx: RfxHeader,
  buyer = { name: "Meera Kulkarni", title: "Category Buyer", org: "Kaveri Home Appliances" },
  seq = 1,
): ClarificationDraft | null {
  const items = clarificationItems(quotes, lines, vendorId);
  if (items.length === 0) return null;
  const v = vendorById(vendorId);
  const body = [
    `Dear ${v.contact_name},`,
    "",
    `Thank you for your quotation for ${rfx.title} (${rfx.rfx_id}). Before we can evaluate it, please clarify the following:`,
    "",
    ...items.map((it, i) => `${i + 1}. ${it.question}`),
    "",
    "A reply to this email is enough. The rest of your quotation is not affected.",
    "",
    "Regards,",
    buyer.name,
    `${buyer.title}, ${buyer.org}`,
  ].join("\n");
  const subject = `Clarification on your quotation for ${rfx.rfx_id}`;
  const guard = checkConfidentiality(`${subject}\n${body}`, { vendor_id: vendorId, quotes, lines, rfx }, items.length);
  return { vendor_id: vendorId, message_id: clarificationMessageId(vendorId, rfx.rfx_id, seq), to: v.contact_email, subject, body, items, status: guard.ok ? "drafted" : "blocked", guard };
}
