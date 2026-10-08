import { vendorById } from "../data/vendors.js";
import { topCandidate, type Extraction, type RejectedRow, type Row } from "../ingest/extraction.js";
import type { ParsedEmail } from "../ingest/parse_email.js";
import { buildQuotes, type BuildInput, type Quote } from "../ingest/quotes.js";
import { isSafe, type CellState } from "../model/states.js";
import type { RfxLine } from "../schemas.js";
import type { ClarificationDraft } from "./clarify.js";

/**
 * Reply loop (spec 13.4). A message in reply to one of our clarifications updates only the cells it was asked about:
 * each answered cell is rebuilt from the reply through the same provenance checks and state rules as any quote, the
 * old value is kept in the cell's history, and the buyer sees a per-cell diff. An item is resolved only when the new
 * rate is explicit enough to be safe; otherwise it stays open. Inputs are never changed; new quotes are returned.
 * Classification here is the deterministic half (In-Reply-To and the sender); the model-based intent check comes later.
 */

export type InboundIntent = "clarification_reply" | "other";

export interface InboundClassification {
  intent: InboundIntent;
  thread: ClarificationDraft | null;
  reason: string;
}

const bareId = (id: string) => id.trim().replace(/^<|>$/g, "");
const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";

export function classifyInbound(email: Pick<ParsedEmail, "in_reply_to" | "from">, threads: readonly ClarificationDraft[]): InboundClassification {
  const replyTo = email.in_reply_to ? bareId(email.in_reply_to) : null;
  // A blocked draft never left the building, so nothing can be a reply to it.
  const thread = replyTo ? threads.find((t) => t.status !== "blocked" && bareId(t.message_id) === replyTo) : undefined;
  if (!thread) {
    return { intent: "other", thread: null, reason: replyTo ? `in reply to ${replyTo}, which is not one of our clarifications` : "not a reply to anything we sent" };
  }
  // Only the vendor we asked may change its own cells.
  const expected = domainOf(vendorById(thread.vendor_id).contact_email);
  if (!email.from || domainOf(email.from.address) !== expected) {
    return { intent: "other", thread: null, reason: `replies to our clarification to ${thread.vendor_id}, but comes from ${email.from?.address ?? "an unknown sender"}, not @${expected}` };
  }
  return { intent: "clarification_reply", thread, reason: `in reply to our clarification ${thread.message_id}` };
}

export interface ReplyInput {
  thread: ClarificationDraft;
  /** Current quotes; only the thread vendor's asked-about cells can change. */
  quotes: readonly Quote[];
  /** How the vendor's submission is built. Its terms (freight, GST) still apply: a reply about a rate changes the rate. */
  base: Pick<BuildInput, "vendorCity" | "config" | "lines" | "peerRates"> & { vendorTerms: Extraction["vendor_terms"] };
  reply: Pick<ParsedEmail, "message_id" | "text" | "new_text_end">;
  /** The extraction pass run on the reply. Rows are checked against the reply's own new text. */
  extraction: Extraction;
  at: string;
}

export interface ItemOutcome {
  lines: string[];
  question: string;
  status: "resolved" | "answered_not_safe" | "unanswered";
  detail: string;
}

/** A cell as the buyer compares it: the vendor's rate (INR per base UoM, ex GST) and the landed total. */
export interface CellView {
  rate_inr: number | null;
  rate_state: CellState;
  state: CellState;
  landed: number | null;
  snippet: string | null;
}

export interface CellChange {
  line_id: string;
  before: CellView;
  after: CellView;
  /** Annual quantity x landed change, when both sides are priced. */
  delta_annual_inr: number | null;
}

export interface ReplyResult {
  quotes: Quote[];
  changes: CellChange[];
  items: ItemOutcome[];
  /** Reply rows about lines nobody asked about: never applied. */
  ignored: RejectedRow[];
  /** Reply rows that failed the provenance check (for example, a value only in the quoted clarification). */
  rejected: RejectedRow[];
  headline: string;
}

function view(q: Quote): CellView {
  const rate = q.components.find((c) => c.kind === "base_rate");
  return { rate_inr: rate?.point ?? null, rate_state: rate?.state ?? q.state, state: q.state, landed: q.landed?.point ?? null, snippet: rate?.provenance.snippet ?? null };
}

export function applyClarificationReply(input: ReplyInput): ReplyResult {
  const { thread, base, reply } = input;
  const vendorId = thread.vendor_id;
  const asked = new Set(thread.items.flatMap((i) => i.lines));
  const targeted: Row[] = [];
  const ignored: RejectedRow[] = [];
  for (const row of input.extraction.rows) {
    const id = topCandidate(row);
    if (asked.has(id)) targeted.push(row);
    else ignored.push({ row_id: row.row_id, reason: `${id} was not asked about; a clarification reply changes only the cells in question` });
  }

  const built = buildQuotes({
    ...base,
    vendorId,
    textNative: true,
    extraction: { vendor_terms: base.vendorTerms, rows: targeted, extras: [], notes: [] },
    sourceText: reply.text,
    authoritativeEnd: reply.new_text_end,
  });
  const rejectedIds = new Set(built.rejected.map((r) => r.row_id));
  const answered = new Set(targeted.filter((r) => !rejectedIds.has(r.row_id)).map(topCandidate));
  const source = reply.message_id ?? "(reply without a message id)";

  const changes: CellChange[] = [];
  const quotes = input.quotes.map((old) => {
    if (old.vendor_id !== vendorId || !answered.has(old.line_id)) return old;
    const fresh = built.quotes.find((q) => q.line_id === old.line_id) as Quote;
    const updated: Quote = {
      ...fresh,
      history: [
        ...(old.history ?? []),
        { state: old.state, state_reason: old.state_reason, components: old.components, landed: old.landed, flags: old.flags, replaced_by: source, replaced_at: input.at },
      ],
    };
    const line = base.lines.find((l) => l.line_id === old.line_id) as RfxLine;
    const before = view(old);
    const after = view(updated);
    changes.push({
      line_id: old.line_id,
      before,
      after,
      delta_annual_inr: before.landed !== null && after.landed !== null ? (after.landed - before.landed) * line.annual_qty : null,
    });
    return updated;
  });

  const safe = base.config.exposure.safe_states;
  const items: ItemOutcome[] = thread.items.map((item) => {
    const got = item.lines.filter((id) => answered.has(id));
    if (got.length === 0) return { ...item, status: "unanswered", detail: "The reply gives no usable value for this item." };
    const unsafe = item.lines
      .map((id) => changes.find((c) => c.line_id === id))
      .filter((c) => !c || !isSafe(c.after.rate_state, safe));
    if (unsafe.length === 0) return { ...item, status: "resolved", detail: `Answered explicitly in ${source}.` };
    const why = unsafe.map((c) => (c ? `${c.line_id} is ${c.after.rate_state}` : "not every line was answered")).join("; ");
    return { ...item, status: "answered_not_safe", detail: `Answered, but not explicitly enough to settle: ${why}.` };
  });

  const resolved = items.filter((i) => i.status === "resolved").length;
  const headline = `${vendorId} replied to the clarification: ${resolved} of ${items.length} item${items.length === 1 ? "" : "s"} resolved, ${changes.length} cell${changes.length === 1 ? "" : "s"} updated.`;
  return { quotes, changes, items, ignored, rejected: built.rejected, headline };
}
