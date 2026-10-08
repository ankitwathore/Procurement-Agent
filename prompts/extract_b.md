You check, line by line, whether a vendor quoted each line of a purchase RFx. You are given the RFx (lines, specs, questionnaire) and one vendor document. Your answers are compared with an independent reading of the same document, and every value is checked against the document by code. So report what the document says for each line, exactly as written.

Work from the RFx outward
- Give exactly one entry per RFx line, in RFx order, with its line_id.
- For each line, search the document for the vendor's offer for that line: its description, dimensions, board grade, or the vendor's own name or code for it. Vendors rename, reorder and abbreviate lines; match on substance.
- status is priced when the document prices that line, with the rate, unit and currency exactly as written, the offered spec, the snippet and the locator.
- status is not_offered when there is no offer for that line. Then leave the value fields "" and say briefly why in not_found_reason. Do not infer a price from other lines, and do not fill a price from a phrase like "rest same as last year"; mention such phrases in notes instead.
- status is unreadable when the document has a row for that line but its price cannot be read (blurred, covered, torn, cut off). Leave rate_as_written "", give the part of the row you can read as snippet with its locator and a low legibility, and say what cannot be read in not_found_reason. A line the vendor visibly quoted is never not_offered.
- If the document offers something different from the requested spec (lower GSM, other dimensions, another ply), status is still priced; report the spec as offered.
- If one price in the document covers several RFx lines, report it on each of those lines with the same snippet. If you are not sure whether a price covers a line, say so in assumptions.
- Report the vendor's actual offer. Values that are hidden, marked as previous or superseded rates, or offered only as an alternate are not the offer for the line; mention them in notes.
