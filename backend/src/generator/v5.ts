import { RFX_HEADER, RFX_LINES } from "../data/rfx.js";

/**
 * V5: Jai Bharat Boards, Vapi. One email, no attachments, freight extra (spec 17.5).
 * Plants traps 29 ("rest same as last year, freight extra"), 30 (per kg rates map to board lines only),
 * 31 (no questionnaire, no attachments, no validity), 32 (Vapi is not on the lane tariff) and
 * 37 (our own RFx quoted underneath, carrying last year's rates as a decoy).
 */

export const V5_FILE_NAME = "Re_RFx_KHA-PKG-FY26-27.eml";

/** The vendor's whole new message, verbatim from the spec. */
export const V5_REPLY =
  "Dear Meera, Rs 42/kg for the 5-ply, 38 for the 3-ply, rest same as last year, freight extra. Regards, Pankaj.";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 2822 date for a wall-clock time at an offset: ("2026-09-22", "11:42:00", "+0530") -> "Tue, 22 Sep 2026 11:42:00 +0530". */
export function rfc2822(date: string, time: string, offset: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${day}, ${d} ${MONTHS[m - 1]} ${y} ${time} ${offset}`;
}

function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

const baseline = (id: string) => RFX_LINES.find((l) => l.line_id === id)!.baseline_price_inr;

export function buildV5Eml(variant: V5Variant = V5_TUNED): string {
  if (variant.name === "holdout") return buildHoldoutEml(variant);
  const quoted = [
    `On ${shortDate(RFX_HEADER.issue_date)} at 10:05, Meera Kulkarni <meera.k@kaverihome.example> wrote:`,
    "> Dear Supplier,",
    `> Kaveri Home Appliances invites your quotation for ${RFX_HEADER.title}: 30 lines as per the attached RFx.`,
    "> Please quote ex GST, delivered Chakan plant, and state unit basis, GST basis, freight basis and validity next to each price.",
    // Trap 37: real numbers in the quote that must never be read as V5's offer.
    `> For reference, last year's rates: 5 ply sheet Rs ${baseline("L23").toFixed(2)}/kg, 3 ply sheet Rs ${baseline("L24").toFixed(2)}/kg.`,
    "> Responses are due by 23 September 2026.",
    "> Regards, Meera Kulkarni, Category Buyer",
  ];
  const headers = [
    "From: Pankaj Shah <pankaj@jaibharatboards.example>",
    "To: Meera Kulkarni <meera.k@kaverihome.example>",
    `Subject: Re: RFx ${RFX_HEADER.rfx_id} - ${RFX_HEADER.title}`,
    `Date: ${rfc2822("2026-09-22", "11:42:00", "+0530")}`,
    "Message-ID: <v5-reply-20260922@jaibharatboards.example>",
    "In-Reply-To: <rfx-kha-pkg-fy26-27@kaverihome.example>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  return [...headers, "", V5_REPLY, "", ...quoted, ""].join("\r\n");
}

export const V5_CLARIFICATION_REPLY_FILE = "Re_Clarification_KHA-PKG-FY26-27.eml";

/** V5's answer to our clarification (spec 13.2 scripted scenario, 13.4): explicit unit and currency, for sheet and roll. */
export const V5_CLARIFICATION_REPLY = "Dear Meera, Yes, Rs 38/kg applies to both the 3-ply sheet and the 3-ply roll. Regards, Pankaj.";

/**
 * The reply cites our clarification's id, so the reply loop can find the thread. Our questions are quoted underneath,
 * including "38 for the 3-ply" again: quoted history is never a source.
 */
export function buildV5ClarificationReplyEml(inReplyTo: string): string {
  const quoted = [
    `On ${shortDate("2026-09-24")} at 16:20, Meera Kulkarni <meera.k@kaverihome.example> wrote:`,
    "> Dear Mr Pankaj Shah,",
    `> Thank you for your quotation for ${RFX_HEADER.title} (${RFX_HEADER.rfx_id}). Before we can evaluate it, please clarify the following:`,
    '> 1. Your reply says "38 for the 3-ply". Does the 38 in it apply to Corrugated roll 3 ply 1500mm width (L25)? If so, please confirm the rate and the unit for it.',
    '> 2. Your reply says "38 for the 3-ply". Please confirm the currency and unit for this price, for Corrugated sheet 3 ply 1000x1400 (L24).',
    "> Regards, Meera Kulkarni",
  ];
  const headers = [
    "From: Pankaj Shah <pankaj@jaibharatboards.example>",
    "To: Meera Kulkarni <meera.k@kaverihome.example>",
    `Subject: Re: Clarification on your quotation for ${RFX_HEADER.rfx_id}`,
    `Date: ${rfc2822("2026-09-25", "09:10:00", "+0530")}`,
    "Message-ID: <v5-clarification-reply-20260925@jaibharatboards.example>",
    `In-Reply-To: ${inReplyTo}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  return [...headers, "", V5_CLARIFICATION_REPLY, "", ...quoted, ""].join("\r\n");
}

/** What the reply settles: both 3-ply lines at an explicit Rs 38/kg. Every other V5 cell is unchanged. */
export function v5ClarificationReplyTruth(): Record<string, unknown> {
  const after = { intended_rate: 38, unit: "kg", currency: "INR", base_state: "CONFIRMED", also_acceptable: ["HIGH_CONF"], carried_over: [] };
  return {
    vendor: "V5",
    file: `V5/${V5_CLARIFICATION_REPLY_FILE}`,
    answers: "clarification 1",
    lines: { L24: { before_base_state: "INFERRED", ...after }, L25: { before_state: "NEEDS_REVIEW", ...after } },
    unchanged: "every other V5 line",
    decoy_in_quoted_history: ["38 for the 3-ply"],
  };
}

/** Board lines the per kg rates apply to (trap 30). Everything else falls under "rest same as last year". */
const STATED: Record<string, number> = { L23: 42, L24: 38, L25: 38 };
const DEFAULT_FREIGHT = 4.0; // INR per kg, Vapi is not on the lane tariff
const FREIGHT_BAND = 0.3;
const BASELINE_HIGH = 0.08;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * The V5 slice of ground_truth.json (spec 17.9). Computed here from the spec's rules, independently of the app,
 * so the pipeline test is a real comparison.
 */
export function v5GroundTruth(variant: V5Variant = V5_TUNED): Record<string, unknown> {
  const lines: Record<string, unknown> = {};
  for (const line of RFX_LINES) {
    const freight = DEFAULT_FREIGHT * line.weight_kg_per_uom;
    const stated = variant.stated[line.line_id];
    if (stated !== undefined) {
      lines[line.line_id] = {
        quoted: true,
        intended_rate: stated,
        unit: "kg",
        currency: "INR",
        // Tuned: L23 writes "Rs 42/kg"; "38 for the 3-ply" carries the unit and currency over, which the buyer
        // confirms once. Holdout: every rate writes its own unit and currency.
        base_state: variant.carried.includes(line.line_id) ? "INFERRED" : "HIGH_CONF",
        carried_over: variant.carried.includes(line.line_id) ? (variant.carriedFields ?? ["unit", "currency"]) : [],
        // The 3 ply roll: a phrase that does not say sheet or roll may leave it in review (decided 2026-10-08 for the
        // tuned L25); a reading that prices it is also correct. The landed cell is INFERRED either way (freight).
        expected_state: line.line_id === variant.ambiguous ? "NEEDS_REVIEW" : "INFERRED",
        ...(line.line_id === variant.ambiguous ? { also_acceptable: ["INFERRED"] } : {}),
        expected_flags: [],
        landed_unit_inr_point: r4(stated + freight),
        landed_low: r4(stated + freight * (1 - FREIGHT_BAND)),
        landed_high: r4(stated + freight * (1 + FREIGHT_BAND)),
      };
    } else {
      const b = line.baseline_price_inr;
      lines[line.line_id] = {
        quoted: false,
        inferred_from: "baseline_same_as_last_year",
        intended_rate: b,
        base_state: "INFERRED",
        expected_state: "INFERRED",
        expected_flags: [],
        // "Same as last year" may already have included freight, so the low reading has none (spec 8.5).
        landed_unit_inr_point: r4(b + freight),
        landed_low: r4(b),
        landed_high: r4(b * (1 + BASELINE_HIGH) + freight * (1 + FREIGHT_BAND)),
      };
    }
  }
  return {
    freight_basis: "freight_extra",
    gst_basis: "unstated",
    received: "2026-09-22",
    late: false,
    validity: "not_stated",
    coverage: "3 explicit, 27 same as last year",
    lines,
    gates: { Q01: "UNKNOWN", Q02: "UNKNOWN", Q03: "UNKNOWN" },
    expected_discrepancies: ["validity_not_stated"],
    decoy_in_quoted_history: [`Rs ${baseline("L23").toFixed(2)}/kg`, `Rs ${baseline("L24").toFixed(2)}/kg`],
    reply: variant.reply,
  };
}

/** V5's reply wording and what it states. Tuned is the spec's email; holdout words the same classes of traps differently. */
export interface V5Variant {
  name: "tuned" | "holdout";
  file: string;
  reply: string;
  /** Per kg rates the reply states, by line. */
  stated: Record<string, number>;
  /** Lines whose unit and currency are carried over from elsewhere in the sentence. */
  carried: readonly string[];
  /** What is carried over on those lines; unit and currency when absent. */
  carriedFields?: ("unit" | "currency")[];
  /** The line the wording leaves open between sheet and roll, if any. */
  ambiguous: string | null;
  /** Holdout email details; the seed 7 holdout's when absent. */
  email?: { quoteStyle: "outlook" | "gmail"; date: string; time: string; messageId: string; subject: string };
}

export const V5_TUNED: V5Variant = { name: "tuned", file: V5_FILE_NAME, reply: V5_REPLY, stated: STATED, carried: ["L24", "L25"], ambiguous: "L25" };

export const V5_HOLDOUT: V5Variant = {
  name: "holdout",
  file: "RE_ RFx KHA-PKG-FY26-27 quotation.eml",
  reply:
    "Hi Meera,\n\nOur rates: 5 ply board Rs 41.50 per kg, 3 ply board Rs 37.25 per kg. All other items at last year's prices. Freight will be charged extra at actuals.\n\nThanks,\nPankaj Shah\nJai Bharat Boards, Vapi",
  stated: { L23: 41.5, L24: 37.25, L25: 37.25 },
  carried: [],
  // "3 ply board" names neither sheet nor roll; both are board sold per kg.
  ambiguous: "L25",
};

/** Holdout email: an Outlook-style reply with our RFx below an "Original Message" line, last year's rates included. */
function buildHoldoutEml(variant: V5Variant): string {
  const em = variant.email ?? { quoteStyle: "outlook", date: "2026-09-21", time: "18:05:00", messageId: "<jbb-20260921-1805@jaibharatboards.example>", subject: `RE: RFx ${RFX_HEADER.rfx_id}` };
  const gmail = [
    `On ${shortDate(RFX_HEADER.issue_date)}, 10:05 am Meera Kulkarni <meera.k@kaverihome.example> wrote:`,
    "> Dear Supplier,",
    `> Please quote for ${RFX_HEADER.title} as per the attached RFx (30 lines).`,
    `> For your reference, last year: 5 ply sheet Rs ${baseline("L23").toFixed(2)}/kg, 3 ply sheet Rs ${baseline("L24").toFixed(2)}/kg.`,
    "> Regards, Meera",
  ];
  const outlook = [
    "-----Original Message-----",
    "From: Meera Kulkarni <meera.k@kaverihome.example>",
    `Sent: ${shortDate(RFX_HEADER.issue_date)} 10:05`,
    `Subject: RFx ${RFX_HEADER.rfx_id}`,
    "",
    "Dear Supplier,",
    `Please quote for ${RFX_HEADER.title}, 30 lines as attached, ex GST, delivered Chakan.`,
    `Last year we paid Rs ${baseline("L23").toFixed(2)} per kg for 5 ply sheet and Rs ${baseline("L24").toFixed(2)} per kg for 3 ply sheet.`,
    "Regards, Meera",
  ];
  const quoted = em.quoteStyle === "gmail" ? gmail : outlook;
  const headers = [
    "From: Pankaj Shah <pankaj@jaibharatboards.example>",
    "To: Meera Kulkarni <meera.k@kaverihome.example>",
    `Subject: ${em.subject}`,
    `Date: ${rfc2822(em.date, em.time, "+0530")}`,
    `Message-ID: ${em.messageId}`,
    "In-Reply-To: <rfx-kha-pkg-fy26-27@kaverihome.example>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  return [...headers, "", ...variant.reply.split("\n"), "", ...quoted, ""].join("\r\n");
}

/** V5's entries in the trap register (spec 17.6). */
export function v5Traps(variant: V5Variant): Record<string, Record<string, unknown>> {
  const tuned = variant.name === "tuned";
  return {
    "29": { vendor: "V5", what: tuned ? "rest same as last year, freight extra" : "other items at last year's prices, freight extra" },
    "30": { vendor: "V5", lines: Object.keys(variant.stated), what: `per kg rates apply to ${Object.keys(variant.stated).join(", ")} only; not to piece priced cartons` },
    "31": { vendor: "V5", what: "no questionnaire, no attachments, no validity" },
    "32": { vendor: "V5", what: "Vapi not on the lane tariff; default 4.00 per kg with a 30 percent band" },
    "37": { vendor: "V5", what: tuned ? "our RFx quoted below the reply, with last year's rates as a decoy" : `our RFx quoted below the reply (${variant.email?.quoteStyle ?? "outlook"} style), with last year's rates as a decoy` },
  };
}

/** Fresh holdout (seed 8): terse shorthand, currency stated once in brackets, Gmail-style quoting. */
export const V5_HOLDOUT2: V5Variant = {
  name: "holdout",
  file: "Re RFx KHA-PKG-FY26-27 rates.eml",
  reply:
    "Meera ji,\nPankaj here. Sheets & rolls: 5ply @ 43/kg, 3ply sheet & roll @ 39/kg (rates in INR, ex-GST).\nBalance items as per previous year rate. Transport extra.\nPankaj",
  stated: { L23: 43, L24: 39, L25: 39 },
  // The currency is said once for the sentence, not next to each price.
  carried: ["L23", "L24", "L25"],
  carriedFields: ["currency"],
  ambiguous: null,
  email: { quoteStyle: "gmail", date: "2026-09-22", time: "20:40:00", messageId: "<CAJBB8x2026092220@mail.example>", subject: `Re: RFx ${RFX_HEADER.rfx_id}` },
};
