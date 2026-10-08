import { ExtractionSchema, type Extraction } from "../../src/ingest/extraction.js";

/** V5's reply (spec 17.5, trap 29 and 37): a one line email with the original RFx quoted underneath. */
export const V5_EMAIL = [
  "Dear Meera, Rs 42/kg for the 5-ply, 38 for the 3-ply, rest same as last year, freight extra. Regards, Pankaj.",
  "",
  "> From: Meera <meera@kaveri.example>",
  "> Subject: RFx: Annual corrugated packaging FY 2026 27",
  "> Please quote 30 lines, ex GST, delivered Chakan, validity 30 days.",
].join("\n");

export function span(text: string, snippet: string, messageId = "m1"): { type: "email"; message_id: string; char_start: number; char_end: number } {
  const start = text.indexOf(snippet);
  if (start < 0) throw new Error(`snippet not in text: ${snippet}`);
  return { type: "email", message_id: messageId, char_start: start, char_end: start + snippet.length };
}

const BOARD_NOTE =
  "Per kg rate read as applying to the corrugated board lines priced per kg; not applied to piece priced cartons.";

function row(text: string, rowId: string, lineId: string, value: number, snippet: string, carriedOver: ("unit" | "currency")[] = []) {
  return {
    row_id: rowId,
    raw_text: snippet,
    mapped_line_candidates: [{ line_id: lineId, match_confidence: 0.9, reasons: ["ply", "unit kg"] }],
    rate: { value, currency: "INR", unit_as_written: "per kg" },
    locator: span(text, snippet),
    snippet,
    assumptions: [BOARD_NOTE],
    carried_over: carriedOver,
  };
}

/**
 * What a correct extraction pass would emit for V5's reply. Hand written, standing in for the LLM.
 * `text` is the body the locators point into: the inline fixture by default, or the parsed .eml body.
 */
export function v5Extraction(text: string = V5_EMAIL): Extraction {
  const freight = "freight extra";
  const rest = "rest same as last year";
  return ExtractionSchema.parse({
    vendor_terms: {
      freight_basis: { value: "freight_extra", snippet: freight, locator: span(text, freight) },
      lines_not_quoted_statement: {
        value_text: rest,
        applies_to: "unquoted lines",
        resolves_to: "baseline",
        snippet: rest,
        locator: span(text, rest),
      },
    },
    rows: [
      row(text, "r1", "L23", 42, "Rs 42/kg for the 5-ply"),
      // "38 for the 3-ply" writes neither unit nor currency; both carry over from "Rs 42/kg".
      row(text, "r2", "L24", 38, "38 for the 3-ply", ["unit", "currency"]),
      row(text, "r3", "L25", 38, "38 for the 3-ply", ["unit", "currency"]),
    ],
  });
}

export const V5_REPLY_ID = "<v5-clarification-reply-20260925@jaibharatboards.example>";

/** What a correct pass would read from V5's answer to our clarification: both 3-ply lines at an explicit Rs 38/kg. */
export function v5ReplyExtraction(text: string): Extraction {
  const snippet = "Rs 38/kg applies to both the 3-ply sheet and the 3-ply roll";
  const row = (rowId: string, lineId: string) => ({
    row_id: rowId,
    raw_text: snippet,
    mapped_line_candidates: [{ line_id: lineId, match_confidence: 0.95, reasons: ["3-ply", lineId === "L24" ? "sheet" : "roll"] }],
    rate: { value: 38, currency: "Rs", unit_as_written: "/kg" },
    locator: span(text, snippet, V5_REPLY_ID),
    snippet,
  });
  return ExtractionSchema.parse({ vendor_terms: {}, rows: [row("c1", "L24"), row("c2", "L25")] });
}
