# QuoteKill Progress

Tracks completed work against the build order in [QUOTEKILL_MASTER_SPEC.md](QUOTEKILL_MASTER_SPEC.md) section 22 and the checkpoints in section 25. Update this file at the end of each slice.

Last updated: 2026-10-09

## Summary

| Checkpoint | Spec steps | Status |
|---|---|---|
| Slice 0: foundations | part of 1 and 2 | Done |
| Slice 1: V5 deterministic core | part of 3, 4 (contract), 5 (states), 9 (exposure) | Done |
| Slice 2: outlier and slip check | part of 5 | Done |
| Slice 3: arithmetic mismatch check | part of 5 | Done |
| Slice 4: spec comparison check | part of 5 | Done |
| Slice 5: validity and lateness | part of 5 | Done |
| Slice 6: conditional discounts and FX band | part of 3, 5, 9 | Done |
| Slice 7: optimizer core (unconstrained) | part of 9 | Done (MIP constraints pending) |
| Slice 8: award gate | part of 9 | Done |
| Slice 9: V1 Excel generator and ground truth | part of 1 | Done (V2 to V5 files pending) |
| Slice 10: Excel parser | part of 4 | Done |
| Slice 11: xlsx provenance and V1 end to end | part of 4, 5 | Done |
| Slice 12: exposure at the high reading | part of 9 | Done |
| Slice 13: V5 email file and parser | part of 1, 4 | Done |
| Slice 14: V2 PDF, PDF parser, injection screen | part of 1, 4, 5 | Done |
| Slice 15: certificate check and ISO 9001 gate | part of 6 | Done |
| Slice 16: Q02, Q03 and per-vendor gate summary | part of 6 | Done |
| Slice 17: claim vs evidence | part of 6 | Done |
| Slice 18: intake and dedupe by hash | part of 4 | Done |
| Slice 19: revisions, diff, stale award | part of 5 | Done |
| Slice 20: V3 Word file and docx parser | part of 1, 4 | Done |
| Slice 21: extraction pass A (LLM), scorer | part of 4, 14 | Built; live on V1, V2, V3, V5 |
| Slice 22: prompt fixes, currency batch confirmation | part of 4, 5 | Done |
| Slice 23: hidden values in code, flag recall, rescore | part of 5, 14 | Done |
| Slice 24: pass B and reconciliation | part of 4, 5 | Done; live on all four |
| Slice 25: adjudicator | part of 5 | Done; live on V5 |
| Slice 26: clarification drafts and confidentiality guard | part of 10 | Done |
| Slice 27: reply loop | part of 10 | Done |
| Slice 28: 3 ply BF fix; questionnaire answers into the gates | part of 6 | Done |
| Slice 29: V1 evidence, grade-aware report check, evidence pass | part of 1, 4, 6 | Done; step 6 acceptance met (gates match 17.11 live) |
| Slice 30: eval harness | part of 5, 14 | Done on the tuned set; step 5 acceptance met (prints calibration) |
| Slice 31: holdout set (seed 7) | part of 1, 14 | Done; first live run recorded (before any fix) |
| Slice 32: holdout fixes and a fresh holdout (seed 8) | part of 1, 5, 14 | Done; fresh first run recorded |
| Slice 33: buyer UI, first cut | part of 7, 9 | Done: comparison, cell panel, vendor, award |
| Slice 34: V4 phone photo and the vision path | part of 1, 4, 6 | Done; live on all three sets |
| Slice 35: analyst agent, first cut | part of 8 | Built; golden suite ready; live run blocked on API credit |
| Slice 36: database, event log, buyer actions | part of 2, 7, 8, 9 | Done |
| Slice 37: trace page | 13 | Done |
| Slice 38: seed 8 follow-ups and the ranking flip (trap 33) | part of 5, 9, 14 | Done; 36 of 36 runnable traps on every set |
| Slice 39: UI overhaul | 7, 9, 13 | Done |
| 1: dataset | 1 | Mostly done (V1 + rev 2, V2, V3, V5 + reply, evidence for V2 and V3, ground truth); V4 photo set, V1 evidence, holdout pending |
| 2: foundations | 2, 3 | Normalization done; config done; DB schema and event log pending |
| 3: extraction and eval | 4 to 6 | Mostly done: four parsers, passes A and B, adjudicator, evidence pass and eval harness, all live on four vendors; V4 (vision), holdout set pending |
| 4: product surface | 7 to 10 | Optimizer core, exposure, award gate, clarification loop done; UI, analyst, MIP constraints pending |
| 5: finish | 11 to 14 | Not started (scorer only) |

## Done

### Slice 0: foundations (2026-10-08)
- [x] npm workspaces monorepo, TypeScript strict, ESM, vitest (pinned to 3.x for Node 20)
- [x] `config.yaml` per spec 7.3, loaded and validated with zod (`backend/src/config.ts`)
- [x] Zod schemas for RFx header, line, question (`backend/src/schemas.ts`)
- [x] 30-line RFx, header, 12-question questionnaire with 3 gates (`backend/src/data/rfx.ts`)
- [x] Baseline total check: Rs 39,985,580 exactly (`backend/src/data/totals.ts`)
- [x] Seeded RNG, mulberry32 (`backend/src/data/rng.ts`)
- [x] Price generator with V1 to V4 factors (`backend/src/data/prices.ts`)
- [x] `npm run gen-data` summary CLI, exits non-zero on total mismatch

### Slice 1: V5 deterministic core (2026-10-08)
Proves the trust design on real numbers with no API key and no files: a hand-written extraction (standing in for the LLM) goes through the whole deterministic path.
- [x] Number parser: Indian grouping, `k`, lakh, crore, decimal comma, currency tokens; throws rather than guesses (`normalize/parse.ts`)
- [x] Unit parser: per pc, per 100 pcs, per kg, per ton, per box, per dozen, etc.; null when unknown (`normalize/parse.ts`)
- [x] Converters: unit to base UoM, USD to INR, GST inclusive to ex GST, freight per UoM; `per box` refused (`normalize/convert.ts`)
- [x] Cell states: all 6 states and the first-match-wins rules of spec 8.4, `worstState`, `isSafe` (`model/states.ts`)
- [x] Extraction contract (zod, subset of spec 11.1) plus provenance check: email snippet must sit at its stated span; unknown line ids rejected (`ingest/extraction.ts`)
- [x] Quote builder: explicit rates, "same as last year" from baseline with band, freight from lane or default tariff with bounds, landed low/point/high, conflicts and unit problems to NEEDS_REVIEW (`ingest/quotes.ts`)
- [x] Exposure: cost point/low/high, rupees resting on unsafe components, sorted unsafe list (`award/exposure.ts`)
- [x] Spec test vectors passing: 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 15
- [x] 85 tests passing across 7 files; typecheck clean

V5 result: all 30 lines quoted, 57 unsafe components, more than 90 percent of V5's value rests on unconfirmed components. This is the number the product is built to surface.

### Slice 2: outlier and magnitude-slip check (2026-10-08)
- [x] `checkOutlier`: rate vs peer median (needs 2+ peers) and vs baseline, bands from config; slip factors 10, 100, 1000, 12 within 5 percent, both directions (`ingest/checks.ts`)
- [x] Wired into `buildQuotes`: outlier sets `hardOutlier` (NEEDS_REVIEW, rule 5), keeps the stated value, and for a slip the component range spans stated and suggested readings; suggestion stored in `Quote.suggested_reading`, never applied
- [x] Spec vector 16 passing (V1 L06 11.08 flagged, suggestion about 110.8)
- [x] 98 tests passing across 8 files; typecheck clean

Note: the suggested reading is rate x 10 = 110.80, while the spec's ground truth intended rate is 110.81 (0.985 x 112.50). The system suggests a correction from the ratio; it does not know the vendor's true rate.

### Slice 3: arithmetic mismatch check (2026-10-08)
- [x] `checkLineTotal`: quantity x rate vs the vendor's own line total, tolerance from config (0.5 percent, inclusive); returns null when no total is stated (`ingest/checks.ts`)
- [x] `line_total_as_written` added to the extraction row schema (spec 11.1 field)
- [x] Wired into `buildQuotes`: mismatch sets `arithmeticFails` (NEEDS_REVIEW, rule 6), flag `arithmetic_mismatch`, `Quote.arithmetic` carries expected, stated and difference; the component range spans the stated rate and the rate the vendor's total implies
- [x] Outlier and arithmetic reasons now combine in one state reason
- [x] Spec vector 17 passing (V2 L15, total 10 percent over)
- [x] 106 tests passing across 9 files; typecheck clean

Assumption: the vendor's total is read as being at the RFx annual quantity, on the rate as displayed (GST inclusive for V2, before stripping GST). A vendor who totals a different quantity will be flagged for review, which is safe but noisy.

### Slice 4: spec comparison check (2026-10-08)
- [x] `checkSpec`: offered ply, liner GSM, BF, dimensions and print against the RFx line; kinds `spec_below_requirement`, `spec_dimension_off`, `spec_upgrade`, `spec_print_differs` (`ingest/checks.ts`)
- [x] Dimensions compared largest to smallest so axis order does not matter; tolerance from config (2 percent, inclusive via a small epsilon after a float edge case showed up in testing)
- [x] Upgrade noted only when nothing is below requirement; fields the vendor did not state are listed in `spec_unstated` and never judged
- [x] `spec_offered` added to the extraction row schema (spec 11.1 field); `Quote.spec_flags` and `Quote.spec_unstated`; flag kinds also added to `Quote.flags`
- [x] Traps covered: 03 (V1 120 GSM), 16 (V3 BF 19.5), 24 (V4 smaller dimensions on L01, L03, L05)
- [x] 123 tests passing across 10 files; typecheck clean

Design choice: spec flags do not change the cell state. The price is read correctly; whether the cell may win is the spec policy's job in the optimizer (strict vs allow deviations), not yet built.

### Slice 5: validity and lateness (2026-10-08)
- [x] Date helpers: strict ISO validation (rejects 2026-02-30), `addDays` across month, year and leap ends, `datePart` for datetimes (`util/dates.ts`)
- [x] `resolveValidUntil`: explicit date wins, otherwise computed from start date plus days in code; unresolvable returns null, never a guess (`ingest/vendor.ts`)
- [x] `assessVendor`: validity status ok / lapsed / expiring / not_stated against `as_of_date` and `expected_award_date`; late reply against `rfx_due_date`; discrepancies with severity; `excluded_by_default` for lapsed (`ingest/vendor.ts`)
- [x] Extraction schema gains `vendor_terms.validity` (`valid_until` or `from_date` + `valid_days`); `BuildInput.receivedAt` optional; `BuildResult.vendor`
- [x] Traps covered: 17 (V3 lapsed 2026-10-03), 27 (V4 expiring 2026-10-09 and late), 31 (V5 no validity); V1 and V2 come out ok
- [x] 140 tests passing across 11 files; typecheck clean

Choices: boundaries are inclusive (valid until today or until the award date is still valid). A late reply is flagged and never excluded; a lapsed quote is excluded from the optimizer by default only. Lateness is judged only when `receivedAt` is supplied. Dates are calendar dates as written, with no time zone conversion.

### Slice 6: conditional discounts and FX clause band (2026-10-08)
- [x] `resolveDiscount`: threshold parsed from text in code ("Rs 25,00,000", "25 lakh"); unreadable threshold or nonsense percentage returns null and applies nothing (`award/discounts.ts`)
- [x] `evaluateDiscount`: applies, amount, net, and signed margin (headroom or shortfall); inclusive or strict threshold (`award/discounts.ts`)
- [x] Spec vector 12 passing: 5 percent on Rs 31.2 lakh is Rs 1.56 lakh off; at Rs 24 lakh it is 0 with a Rs 1 lakh shortfall
- [x] Vendor assessment now carries `conditional_discounts` for the optimizer plus `conditional_discount` and `fx_clause` discrepancies (`ingest/vendor.ts`)
- [x] FX clause: USD price with a clause gets a +/-3 percent band (config), basis `fx_clause_band`, state INFERRED via new rule 11, flag `fx_clause`, and the band flows into exposure (`ingest/quotes.ts`, `model/states.ts`)
- [x] Trap 07 (V2 footnote discount) and trap 15 (V3 USD lines: USD 1.53 x 88 = Rs 134.64, range 130.60 to 138.68)
- [x] 155 tests passing across 13 files; typecheck clean

Choices and deviations: the extraction schema takes `threshold_text` (not the spec's `threshold_inr`) so code, not the model, converts "25 lakh". Spec 9.2 and 15.3 say "at least" while the V2 footnote says "exceeds", so `threshold_inclusive` defaults to true and the model can set it false; the two readings differ only at exactly the threshold. FX clause adds an eleventh state rule (INFERRED) beyond the ten in spec 8.4, evaluated before the HIGH_CONF rules. Multiple conditional discounts from one vendor are recorded individually; whether they stack is left to the optimizer, not guessed.

### Slice 7: optimizer core (2026-10-08)
- [x] `allocate`: each line to exactly one vendor, cheapest eligible, with the spec 15.2 eligibility rules: gate policy (cleared_only, include_unknown, ignore_gates, WAIVED passes), spec policy (strict drops below-requirement and dimension-off, upgrades pass), lapsed validity, buyer exclusions, cell policy (`ingest/../award/optimizer.ts`)
- [x] Cell policy: point, risk_adjusted (unsafe components priced at their high bound; the default), trusted_only (unsafe cells removed). The W01 case works: a cheap guess loses to a slightly dearer confirmed quote under risk adjusted, and wins under point
- [x] Deterministic tie-breaks: lower exposure, then better states, then vendor id
- [x] Nothing is dropped silently: unfillable lines are listed, single-source lines are flagged, every excluded vendor and rejected cell carries a reason (answers "why are V2, V4, V5 excluded")
- [x] Conditional discounts: enumerates which discounts to chase, scores each allocation on what it truly earns (not what it assumed), keeps the cheapest; all cases reported (`discount_cases`)
- [x] Result carries cost point/low/high after discounts, exposure (reuses `computeExposure`), vendor shares, savings against baseline on the same basis (W10)
- [x] V5 from the real pipeline: cheapest on L23 by point, loses to a confirmed rival under risk adjusted (spec 17.11)
- [x] 177 tests passing across 14 files; typecheck clean

Known limits, on purpose: this is the unconstrained core. Share caps, minimum awards, capacity, bundles and infeasibility diagnosis (spec 15.3, 15.4) need a MIP solver. The discount search is greedy per case, so it cannot hand a vendor extra lines it does not win in order to reach a threshold; it can miss a better allocation that a MIP would find. A vendor with more than one conditional discount is noted and not modelled. The `allocate` file lives at `backend/src/award/optimizer.ts`. The award gate (spec 15.6) is not built.

### Slice 8: award gate (2026-10-08)
- [x] `evaluateGate`: allowed / acknowledge / blocked from exposure percent against `config.award_gate` (block over 5, acknowledge over 1); limits are "over", so exactly 1 percent is allowed and exactly 5 percent needs acknowledgment, with an epsilon so float noise cannot move a value across an edge (`award/gate.ts`)
- [x] Headline sentence for the award screen and priced analyst answers: "Rs 12.4 lakh of this award rests on 9 unconfirmed components." (`util/format.ts` renders lakh and crore)
- [x] Blocked reasons in plain words with the fix; `resolve_first` lists the three biggest unsafe components; warnings for unfillable and single-source lines never block
- [x] Blocks when nothing could be awarded
- [x] `confirmAward`: refuses blocked awards, requires every unsafe component acknowledged (reports which are outstanding), ignores unrelated ids, returns an audit record with actor, time, exposure, cost and the acknowledged ids
- [x] Real pipeline check: V5 alone is blocked with "57 unconfirmed components", over 90 percent exposure
- [x] Shared synthetic quote helpers moved to `tests/fixtures/quotes.ts`
- [x] 196 tests passing across 15 files; typecheck clean

Not built: stale award handling after a late revision (W11), persistence of the award record, resolving an item to shrink exposure (verify, override, clarify).

### Slice 9: V1 Excel generator and ground truth (2026-10-08)
First real artifact. `npm run gen-data` now writes the dataset under `data/` (the earlier line-table printout moved to `npm run summary`).
- [x] V1 offer, revision 1 (`generator/v1.ts`): transposed layout (lines across columns B to AE), merged group headers, separate `Summary` and `QA` sheets, vendor's own abbreviated item names (trap 01)
- [x] Trap 02: previous quarter rates 3 to 5 percent higher in a hidden row, "Rate Q2"
- [x] Trap 03: L01, L02, L03, L05 on 120 GSM / BF 16 at about 0.93 of baseline, remark in the sheet, while QA Q12 says "No deviations."
- [x] Trap 04: L06 typed 11.08 against an intended 110.81 (checked: the outlier check flags it as a factor-10 slip)
- [x] Trap 35: L20 "NQ", L21 blank; coverage 28 of 30
- [x] Terms on `Summary`: delivered FOR Chakan, GST extra 18 percent, payment 45 days, validity 30 days from 21-09-2026, lead time 10 days, grand total as typed
- [x] Revision 2 (trap 05): L06 corrected, L04/L15/L16/L17 up 3 percent, "please disregard earlier sheet"; exactly those five lines change, last quarter's hidden rates do not
- [x] `ground_truth.json` (V1 slice, revision 2 slice, trap register) with cell locators, expected states and flags; tests confirm every locator reads back its shown value
- [x] `rfx.json`; `data/README.md` listing files and traps
- [x] Byte-for-byte reproducible: zip entry timestamps normalized with jszip (`generator/zip.ts`); two runs give identical hashes
- [x] `factorOverrides` option on `generateVendorRates` for lighter-board lines
- [x] Dependencies added: exceljs, jszip (generator only). `npm audit` reports advisories in exceljs's transitive packages; it is not used at run time by the app
- [x] 212 tests passing across 16 files; typecheck clean

Deviation: the spec says V1 has a hidden *column* "Rate Q2". The sheet is transposed, so the equivalent is a hidden *row*. Edge F02 covers either.

Not generated yet: the ISO certificate and test report V1's questionnaire refers to, so V1's gates are only PASS in ground truth and not yet verifiable from files.

### Slice 10: Excel parser (2026-10-08)
- [x] `parseXlsx` (`ingest/parse_xlsx.ts`): workbook to structured cells plus the text grid pass A will read; one line per row so row relationships survive a transposed layout
- [x] Hidden rows, hidden columns and hidden or very-hidden sheets are kept and tagged (`[HIDDEN ROW]`, `[HIDDEN COL]`, `[HIDDEN SHEET: ...]`), never dropped and never preferred (F02, D24)
- [x] Merged ranges listed once at the top-left cell with a `[merged B3:I3]` tag; covered cells are not repeated
- [x] Formulas keep the formula and the cached value (F03); Excel errors flagged; dates become ISO strings; rich text flattened; cell notes captured, since a note can carry text aimed at an AI (spec 19.6)
- [x] `xlsxLocator` and `lookupCell` give spec 8.3 locators and let a locator be verified against the real file
- [x] Safe failure (F13, SY08): corrupted bytes, a zip that is not a workbook, no worksheets, over 25 MB, over 50 sheets or over 200,000 cells all raise `ParseError` with a reason, never an empty result
- [x] Closes the loop with the generator: every quoted line in V1's `ground_truth.json` reads back from its recorded cell; L06 reads `Rates!G8 = 11.08`; the hidden row is tagged; revision 2 reads 110.81
- [x] Whole V1 workbook renders to about 5,000 characters, so prompts stay small
- [x] Bug caught by a test: a non-workbook zip loaded as an empty workbook silently; now a `ParseError`
- [x] 228 tests passing across 17 files; typecheck clean

Not done: a zip-bomb guard on uncompressed size (the byte, sheet and cell caps are the only limits so far), macro-enabled files are read as data only and not specially identified, and the provenance check in `validateRows` still only verifies email spans; xlsx locators can now be checked with `lookupCell` but are not yet wired in.

### Slice 11: xlsx provenance, hidden values, V1 end to end (2026-10-08)
- [x] `validateRows` checks xlsx locators against the parsed workbook: cell must exist, snippet must equal the cell text, a numeric cell must equal the rate; no workbook means rejection (`ingest/extraction.ts`)
- [x] Hidden cells are detected from the file, not from the model's locator; rows read from them are verified but kept apart (`hidden_rows`) and never priced
- [x] `hidden_value_differs` flag and `Quote.hidden_values` when a hidden value differs from the visible rate, or when only a hidden value exists (that line stays MISSING); cell state unchanged (`ingest/quotes.ts`)
- [x] Test-only "ideal pass A" fixture for V1 that reads the parsed grid, never the ground truth (`tests/fixtures/v1.ts`)
- [x] V1 end to end: generated workbook -> parser -> extraction stand-in -> provenance -> normalization -> checks -> states. Every line's state, every expected flag and every confirmed landed price match `ground_truth.json` exactly
- [x] Tamper tests: an invented rate, a wrong snippet, a pointer to an empty cell, a hidden cell claimed visible, and a hidden-only line are all caught
- [x] Optimizer on V1: the L06 slip is priced at its high reading (about 110.8) under risk adjusted, at 11.08 under point
- [x] 245 tests passing across 18 files; typecheck clean

Not covered: provenance of vendor terms (only rows are verified so far); "NQ" token preservation on MISSING cells (G06).

### Slice 12: exposure at the high reading (2026-10-08, decided with the user)
- [x] Spec 8.5 valued an unsafe component at its point. For a magnitude slip the point is the low reading, so V1's L06 counted as about Rs 1.4 lakh at stake when the real reading is about Rs 14.4 lakh, and the gate let it through unasked
- [x] Now each unsafe component is valued at max(point, high); `exposure_point` renamed `exposure_inr`; `exposure_pct` is taken over `risk_cost` (safe at point, unsafe at max) so it stays at or below 100 percent; `value_point_inr` kept for reference (`award/exposure.ts`)
- [x] Test pins it: V1 alone, L06 tops the resolve-first list and the gate is no longer "allowed"

### Slice 13: V5 email file and email parser (2026-10-08)
- [x] V5 `.eml` generator: the spec's one-line reply verbatim, RFC 2822 headers with correct weekdays, our RFx quoted below with last year's rates as a decoy (trap 37) (`generator/v5.ts`)
- [x] V5 ground truth computed independently from the spec's rules: per kg rates on L23 to L25, baseline on the other 27, default freight with its band, landed point, low and high
- [x] `parseEmail` with mailparser: headers, body, attachments with hashes, and the split between the vendor's new message and quoted history (Gmail, Outlook, header-block, forwarded and bare `>` styles) (`ingest/parse_email.ts`)
- [x] Provenance: an email row whose snippet sits in quoted history is rejected; the decoy price Rs 44.50/kg is caught
- [x] Lateness on the buyer's calendar: `buyer_utc_offset: "+05:30"` in config; 23:30 on the 23rd in California is already late in India
- [x] V5's real email through the pipeline: every line's state and landed point, low and high match ground truth

### Slice 14: V2 PDF, PDF parser, injection screen (2026-10-08)
- [x] V2 generator with pdfkit: 4-page letterhead quotation, own item codes sorted by carton volume, GST-inclusive rates, L15 amount 10 percent high with the total off by the same, terms page with the discount footnote, 5pt GST fine print and a 4.5pt light grey AI-directed footer, alternate offer row, questionnaire page with the hedged Q07 (`generator/v2.ts`)
- [x] Same quotation written under two names with identical bytes (trap 36); expired ISO certificate and test report PDFs; `docs_manifest.json`
- [x] Generator bugs found and fixed while probing: footers below the margin silently added blank pages (8 pages instead of 4), and over-wide cells wrapped a character onto the next line (the total read "...875.5")
- [x] `parsePdf` with pdfjs-dist 4.10.38 (5.x needs Node 22): lines by baseline, " | " between table cells, bounding boxes, fine print tagged by the line's largest font size, pages without a text layer flagged for vision (`ingest/parse_pdf.ts`)
- [x] Provenance for pdf rows: page must exist, snippet must appear on it, and the rate must be one of the numbers written in the snippet
- [x] `extras` added to the extraction contract (spec 11.1) so the alternate offer is listed, never compared
- [x] Injection screen, deterministic half: regex patterns find V2's footer, record it verbatim and strip only that line; no false positives on V1, V1 revision 2 ("please disregard earlier sheet") or V5 (`ingest/injection.ts`)
- [x] V2's real PDF through the pipeline: all 30 reordered, recoded rows mapped, every state and landed price matches ground truth, L15 NEEDS_REVIEW with the 10 percent gap, the 5 percent discount taken when V2's award clears the threshold, and the footer changes nothing
- [x] 294 tests passing across 20 files; typecheck clean; every generated file byte-identical across runs

Known noise: pdfjs prints "Cannot polyfill DOMMatrix / ImageData / Path2D" warnings on Node 20. They concern rendering, which is not used; text extraction is unaffected.

Not built: certificate and test report checks (gates, trap 09 FAIL, claim vs evidence), hedged-answer detection, dedupe by hash at intake, the model-based half of the injection screen (needs the key), light grey colour detection (only size is used).

### Slice 15: certificate check and the ISO 9001 gate (2026-10-08)
- [x] `checkCertificate`: valid / expired / expiring before award / not yet valid / undated against `as_of_date` and `expected_award_date` (edges inclusive); holder checked against the vendor's name ignoring Pvt, Ltd and punctuation (E03); scope checked for corrugated packaging (E07) (`evidence/certificates.ts`)
- [x] `classifyAnswer`: yes / no / hedged / unanswered for yes-no questions; any condition or split answer is hedged and kept verbatim (E06). V2 Q07 and V3 Q07 come out hedged; V2 Q04 "On request" too
- [x] `evaluateIsoGate` (Q01 pass rule, spec 17.4): PASS only for yes plus a current certificate for this vendor; yes with no file is FAIL as a claim without evidence (E04); hedged or unanswered is UNKNOWN; scope outside corrugated is reported but does not fail
- [x] Trap 09: V2's real certificate PDF, read by a test-only stand-in extraction, fails Q01 with "Expired on 2026-08-31, before today (2026-10-08)"
- [x] 320 tests passing across 21 files; typecheck clean

Not built: Q02 (test report covers the offered plies, dated within 12 months), Q03, claim vs evidence (V1 Q12, V3 BF), the per-vendor gate summary that feeds `VendorInput.gate`, and gate waivers.

### Slice 16: Q02, Q03 and the per-vendor gate summary (2026-10-08)
- [x] Each gate question names its rule in the RFx data: `pass_check` = `valid_certificate`, `test_report_covers_offered_plies` or `answer_yes`; code dispatches on the rule, never on the question number (spec 25: rules live in data) (`schemas.ts`, `data/rfx.ts`)
- [x] Q02: yes plus a report dated within 12 months (inclusive; `minusYears` handles 29 February) with a sample for every ply the vendor quotes for; yes with no file is a claim without evidence (trap 26); unreadable or future dates are UNKNOWN (`evidence/gates.ts`)
- [x] `offeredPlies`: the plies of lines the vendor did not leave MISSING, so a vendor that skipped the 7 ply lines is not asked to test 7 ply
- [x] Q03: plain yes gate
- [x] `summarizeGates`: per-gate result and reason, buyer waivers (reason required, logged with actor; a waiver on a passing gate changes nothing), overall FAIL > UNKNOWN > WAIVED > PASS, and a one-line headline ("Not cleared: no answers received.")
- [x] Expected outcomes from spec 17.11 reproduced: V1 PASS, V2 FAIL on Q01, V4-like FAIL on Q02, V5 UNKNOWN
- [x] Demo question G7 end to end: V2's real PDF through the pipeline, gates computed from its answers and evidence; excluded under "cleared only", and with Q01 waived it becomes eligible and earns its 5 percent
- [x] 339 tests passing across 22 files; typecheck clean

Not built: claim vs evidence (V1 says no deviations but offers 120 GSM; V3 claims BF 22 but reports 19.5), test report values against offered specs, gates with no machine-checkable rule (they return UNKNOWN and need the buyer), persisting waivers.

### Slice 17: claim vs evidence (2026-10-08)
- [x] `compareReportToLines`: each test report sample (same ply, and flute when stated) against every quoted line it covers, for BF and liner GSM; the weaker of two readings counts (`evidence/claims.ts`)
- [x] `applyReportFindings`: adds `spec_below_requirement` flags with `source: "test_report"` to new quote objects; prices and inputs untouched; the strict spec policy then excludes those cells
- [x] `checkDeviationClaim`: a "no deviations" answer against deviations found in the offer or the report (upgrades excluded); both sides quoted. Which answer to check is named in the RFx data (`claim_check: "no_spec_deviations"` on Q12)
- [x] Trap 16: V3's 5 ply BC BF 19.5 flags exactly L04, L06, L07, L08, L23 and those lines become unfillable for V3 under strict (spec 17.11)
- [x] Trap 03: V1's real sheet with "No deviations." produces a contradiction on L01, L02, L03, L05
- [x] 352 tests passing across 23 files; typecheck clean

## Open question for the spec (raised 2026-10-08)
The spec's test report values for V2 (3 ply BF 17.0) and V3 (3 ply BF 16.8) are below the BF 18 that six 3 ply lines require (L12, L14, L21, L22, L24, L29). Decided 2026-10-08: raised in the generator to 18.6 (V2) and 18.2 (V3), so only the planted V3 5 ply trap fires (slice 28).

### Slice 18: intake with dedupe by hash (2026-10-08)
- [x] `intake`: every incoming file becomes an artifact with sha256, size, deterministic id (`vendor-hash12`) and a kind decided by its bytes (zip, PDF, JPEG, PNG, email headers), not its name (`ingest/intake.ts`)
- [x] Trap 36: V2's quotation under two names is one RECEIVED artifact plus a DUPLICATE linked to it; a re-send in a later message is also caught (V05); the same bytes from another vendor are not a duplicate
- [x] FAILED with a visible reason for empty, oversized (25 MB), unsupported, and name-lies-about-content files (a zip named .pdf); `.xlsm` read as data with a note (F13, SY08)
- [x] 360 tests passing across 24 files; typecheck clean

Not built: zip-bomb guard on uncompressed size, password-protected detection before parsing (the parsers already fail visibly), storing artifacts on disk or in the DB.

### Slice 19: revisions, diff and stale award (2026-10-08)
- [x] `looksLikeRevision`: explicit revision language ("revised rates", "please disregard earlier", "Rev 2", "supersedes"); "revised" alone is not enough. Deterministic half; the model intent check comes later (`ingest/revisions.ts`)
- [x] `supersede`: the vendor's current submission becomes history (kept, not deleted); revision numbers per vendor; inputs not mutated
- [x] `diffSubmissions`: per-line price, state, newly quoted and withdrawn changes, landed delta per unit and per year, total annual impact, and the banner sentence
- [x] `staleAward`: an award that gave any line to the revised vendor is stale (spec 10.8), with the affected awarded lines, their annual rupee impact and a re-run message
- [x] Trap 05 on the real files: V1 Rev 2 changes exactly L04, L06, L15, L16, L17; L06 goes from 11.08 NEEDS_REVIEW to 110.81 CONFIRMED; banner "V1 Rev 2 received, 5 prices changed."
- [x] 377 tests passing across 25 files; typecheck clean

Note: the spec's wireframe banner says "4 prices changed"; the spec's own revision description changes five lines (L06 plus four kraft increases), so the code reports 5.

Not built: merging a second non-revision submission (spec G09, F12 cross-artifact conflicts), persisting submissions, re-running the pipeline automatically on a revision.

### Slice 20: V3 Word file and docx parser (2026-10-08)
- [x] V3 generator with the `docx` library: cartons priced in sentences (three phrasings), tables for inner cartons, sheets and accessories, nine lines per 100 pcs, L26 to L28 in USD, terms paragraphs with the RBI-rate clause and 15-day validity, questionnaire table with the BF 22 claim and the split Q07 (`generator/v3.ts`)
- [x] V3 ISO certificate (valid) and test report (5 ply BC BF 19.5); evidence PDF builders moved to `generator/pdf.ts` and shared with V2 (V2's files stay byte-identical)
- [x] Word core-property dates pinned in `normalizeZip`, so the docx is byte-identical across runs
- [x] `parseDocx` with fast-xml-parser: body paragraphs and tables in order with `paragraph_idx` / `table_idx` / `row`, headers and footers, deleted text and field codes ignored (`ingest/parse_docx.ts`)
- [x] Bug caught on probing: the XML parser turned "661.00" into 661; values now stay exactly as written
- [x] Provenance for docx rows: the paragraph or table row must exist and contain the snippet, and the rate must be written in it
- [x] RFx hint `piece_is_base_uom` on the per-100 lines, because the RFx accepts "per 100 pcs" for L18, a partition set priced per set; without it a correct converter sent L18 to review. Shown in the chain
- [x] V3's real Word file through the pipeline: all 30 lines mapped from sentences and tables, every state and landed price matches ground truth; lapsed validity excludes V3 by default; gates PASS on the real certificate and report; the report flags L04, L06, L07, L08, L23 and contradicts the "None" deviations answer
- [x] 396 tests passing across 26 files; typecheck clean; whole dataset byte-identical across runs

### Slice 21: extraction pass A, ready for a live run (2026-10-08)
- [x] Anthropic SDK (`@anthropic-ai/sdk` 0.132) behind a small `LlmClient` interface; unit tests use a stub and never call the API (`llm/client.ts`)
- [x] Structured outputs (`output_config.format` with a JSON schema), because Sonnet 5.5 rejects a forced tool choice; the spec's "one forced tool emit_quotes" becomes "one strict output schema"
- [x] Server-side refusal fallback on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); the trace records when it ran
- [x] RFx context cached (`cache_control` on a stable system block, deterministic JSON); prompt in `prompts/extract_a.md`, versioned by content hash
- [x] Model-facing schema is a flat, strict version of the extraction contract (every object closed, nulls for "not stated"); answers are mapped and validated against `ExtractionSchema` (`ingest/extract_a.ts`)
- [x] Vendor text is injection-screened and wrapped in `<vendor_document>` tags before the call; email spans are placed by code from the model's snippet, not counted by the model
- [x] Failures are explicit: refusal, truncation, invalid JSON, contract mismatch, a failed call after SDK retries, and the per-document cost cap
- [x] Per-call trace: prompt version, model requested and used, fallback, tokens incl. cache, cost (`llm/pricing.ts`), latency
- [x] `scoreVendor` (spec 19.1): state accuracy, price accuracy within 0.5 percent, dangerous errors (safe state, wrong value), coverage errors (`eval/score.ts`)
- [x] `npm run extract -- --vendor V1|V2|V3|V5`: live pass A on a generated file, builds quotes, scores against ground truth, saves `data/runs/<vendor>-pass-a-<time>.json`; loads `.env` via Node's `--env-file`
- [x] `.env` gitignored; `.env.example` committed
- [x] 412 tests passing across 27 files; typecheck clean

Not run yet: no live call has been made (the key is not in `.env` yet). Not built: pass B, reconcile, adjudicator, questionnaire answers into the gates, vision for V4.

### First live pass A results (2026-10-08, claude-sonnet-5-5, effort high, prompt as of this date)
| Vendor | Format | Price accuracy | State accuracy | Dangerous | Cost | Time |
|---|---|---|---|---|---|---|
| V1 | xlsx | 100% of 27 | 10% | 0 | $0.209 | 142 s |
| V2 | pdf | 100% of 30 | 100% | 0 | $0.152 | 69 s |
| V3 | docx | 93% of 30 | 47% | 0 | $0.125 | 85 s |
| V5 | email | 97% of 30 | 100% | 0 | $0.037 | 21 s |

Traps confirmed live: V1 L06 slip to review, hidden "Rate Q2" row extracted and flagged, NQ and blank left missing; V2 GST fine print applied, L15 arithmetic to review, alternate offer in extras, AI-directed footer stripped before the call; V3 per 100 pcs, USD and prose all priced correctly; V5 decoy rates in the quoted RFx ignored.

Causes of the state misses (all in the safe direction):
- V1 27 lines HIGH_CONF instead of CONFIRMED: the model writes an assumption on every row ("currency from RATE (Rs) label in A8"), and any assumption triggers rule 9. Reading a header or label is not an assumption.
- V2 and V3: the model marks currency as carried over when it comes from a column header ("Rate (Rs)"), so 30 and 14 cells were queued for buyer confirmation unnecessarily. A header counts as written.
- V3 L29, L30 to review: the mixed INR/USD table prints those two INR rates with no currency at all ("24.10"). The model correctly did not guess. Candidate for a batch "currency not stated, RFx currency INR" confirmation.
- V5 L25: "38 for the 3-ply" mapped to the sheet only in one run and to sheet and roll in another; a genuine ambiguity for pass B to catch.

Cost was higher than estimated (about $0.52 for four documents, against an estimate of a few cents each): output tokens dominate (V1 20,062 out, with 56 rows including the hidden ones and long assumptions). Levers: effort medium, terser assumptions.

### Slice 22: prompt fixes, "currency not stated" batch confirmation, effort medium (2026-10-08)
- [x] Prompt: a currency or unit in a column header, row label or table title counts as written; assumptions only for judgments that could change a price or a mapping; a currency written nowhere is left blank
- [x] No currency written at all: priced in the RFx currency (`config.currency_of_record`), INFERRED under rule 12, flag `currency_assumed`, joins a batch confirmation; a currency that is written but not recognised still goes to review (`ingest/quotes.ts`, `review/confirmations.ts`)
- [x] Confirmation questions quote at most three snippets and count the rest
- [x] `npm run extract -- --vendor V1 --effort medium`
- [x] V3 fixture and ground truth: L29 and L30 have no currency written, so they are INFERRED pending confirmation
- [x] 425 tests passing across 28 files

Second live run, effort medium:
| Vendor | Price accuracy | State accuracy | Dangerous | Cost (was at high) | Time (was) |
|---|---|---|---|---|---|
| V1 | 100% of 27 | 100% (was 10%) | 0 | $0.093 ($0.209) | 63 s (142 s) |
| V2 | 100% of 30 | 100% | 0 | $0.115 ($0.152) | 74 s (69 s) |
| V3 | 100% of 30 (was 93%) | 100% (was 47%) | 0 | $0.097 ($0.125) | 62 s (85 s) |
| V5 | 97% of 30 | 100% | 0 | $0.029 ($0.037) | 7 s (21 s) |
Total $0.33 for four documents (was $0.52).

Regression found by reading the run, not by the scorer: at medium effort the model saw V1's hidden "Rate Q2" row and chose not to report it ("labelled as a Q2 rate rather than the offer"), so trap 02 (`hidden_value_differs`) was missed. The scorer checks states and prices but not flags, so it showed 100%.

### Slice 23: hidden values in code, flag recall, medium effort by default, rescore (2026-10-08)
- [x] `hiddenValuesFor`: hidden numeric cells found in the parsed workbook on each priced line's own axis; the layout (items across columns or down rows) is read from the priced cells, so another item's hidden row is never attached to the wrong line; merged with any the model reported, one entry per cell (`ingest/hidden.ts`)
- [x] Scorer reports flag recall and the missing flags (`eval/score.ts`); V3's test-report flags moved to `expected_evidence_flags`, since pass A cannot raise them
- [x] Pass A defaults to effort medium (same accuracy as high on the demo files at about 60 percent of the cost)
- [x] `npm run rescore`: replays saved extractions through the current code and scores them, no API call; shared vendor loader and report (`cli/vendors.ts`, `cli/report.ts`)
- [x] Re-scored the medium-effort runs offline: V1, V2, V3 at 100 percent state, price and flag recall; V5 100 percent state, 97 percent price (L25); zero dangerous errors
- [x] 431 tests passing across 29 files; typecheck clean

### Slice 24: pass B and reconciliation (2026-10-08)
- [x] Pass B, RFx first (spec 10.5, 11.3): one entry per RFx line, found or not, exactly as written; never sees pass A; rows only (`ingest/extract_b.ts`, `prompts/extract_b.md`)
- [x] Shared reading rules in `prompts/conventions.md`, appended to both passes' prompts (versioned together) so a rule cannot drift between them
- [x] RFx context moved first in the system prompt, so both passes read one cached prefix (pass B: 6,452 cached tokens read)
- [x] Reconciliation in the quote builder (spec 10.6): pass B rows go through the same provenance checks; agreement needs the same rate within 0.5 percent, the same canonical unit and the same currency; a disagreement, or an offer only one pass found, is NEEDS_REVIEW under rule 2 with both readings attached and no price; `Quote.reconciliation`, flag `passes_disagree` (`ingest/quotes.ts`)
- [x] `npm run extract` runs both passes; `--a-only`, and `--reuse-a` to run only pass B against the latest saved pass A; `rescore` uses saved pass B
- [x] 445 tests passing across 30 files; typecheck clean

Live pass B (effort medium, reconciled with the saved medium pass A runs):
| Vendor | Agree | Disagree / one pass only | Pass B cost | Pass B time |
|---|---|---|---|---|
| V1 | 28 | 0 | $0.071 | 47 s |
| V2 | 30 | 0 | $0.081 | 51 s |
| V3 | 30 | 0 | $0.069 | 44 s |
| V5 | 2 | L25 only in pass B | $0.077 | 46 s |
The two passes agreed on every one of the 89 lines both priced. V5 L25 ("38 for the 3-ply", the roll) was priced only by pass B, so it now goes to review unpriced instead of carrying a wrong baseline price (45.20 against the intended 42.00). Zero dangerous errors. A full two-pass document now costs about $0.10 to $0.20.

### Slice 25: adjudicator (2026-10-08)
- [x] Runs only on disputed lines (passes disagree, or only one found an offer), all of a document's disputes in one Opus 5.5 call at effort high (`ingest/adjudicate.ts`, `prompts/adjudicate.md` plus the shared conventions)
- [x] Decisions: A, B, THIRD (its own reading, provenance-checked like any row), NO_OFFER, UNRESOLVED; decisions on lines not asked about, or picks of a reading that does not exist, are ignored
- [x] Never raises confidence: a settled line is built under rule 2 "resolved", HIGH_CONF at best, and later rules (carried-over unit, outlier) still apply; UNRESOLVED or a failed call leaves the line in review with both readings and the adjudicator's words (`ingest/quotes.ts`)
- [x] `npm run extract` adjudicates after reconciling; `--reuse-ab` spends only on adjudication; `rescore` replays saved decisions
- [x] 456 tests passing across 31 files; typecheck clean

Live on V5 L25 (reusing both saved passes): $0.048, 11 s. Decision UNRESOLVED: "The vendor's only price is '38 for the 3-ply', which does not say sheet or roll." L25 stays in review, unpriced. That is the honest answer for the document as written; the spec's ground truth assumes 38 per kg covers both the sheet and the roll.

Decided 2026-10-08: V5 L25 ground truth is NEEDS_REVIEW with INFERRED also acceptable (`also_acceptable` in ground truth; the scorer accepts either, and does not price-check an acceptable unpriced review). The live V5 run now scores 100 percent state and price.

### Slice 26: clarification drafts and the confidentiality guard (2026-10-08)
- [x] Vendor registry with contacts and aliases (`data/vendors.ts`)
- [x] `draftClarification`: one email per vendor, one precise question per item, each quoting only the vendor's own words: lines only one pass found, pass disagreements, slips and outliers, bad totals, per-box counts, hand corrections, unreadable rates, and batched unit/currency confirmations; never sent (`review/clarify.ts`)
- [x] Questions are written by code, not a model: exact, deterministic, nothing for the guard to second-guess (a model polish can come later)
- [x] `checkConfidentiality`, fail closed (`review/guard.ts`): every number must come from this vendor's reply or the RFx's public line details (keeps out other vendors' prices, last year's prices, and our computed corrections); no other vendor's name or alias; no comparative or internal phrases. The model check for paraphrased leaks needs the API and is not built
- [x] Bug found by a test and fixed in two places: the number pattern swallowed a trailing comma ("1600,"), which broke the guard and would have broken the provenance check for a price followed by a comma
- [x] `npm run clarify -- --vendor V5`: the draft from every vendor's latest live run, free
- [x] Drafts from the live runs: V5 asks whether "the 38 in it" applies to the 3 ply roll (L25) and to confirm the unit and currency for L24; V1 asks to confirm L06 "11.08" without revealing the suggested 110.81; both pass the guard
- [x] 467 tests passing across 32 files; typecheck clean

### Slice 27: reply loop (2026-10-08)
- [x] Each clarification draft carries a thread id (`clarificationMessageId`, deterministic) (`review/clarify.ts`)
- [x] `classifyInbound`: a clarification reply must cite one of our sent (not blocked) drafts in In-Reply-To and come from that vendor's domain; anything else is "other" with the reason (`review/reply.ts`). The model-based intent check is later
- [x] `applyClarificationReply`: only the asked-about cells of that vendor change; each is rebuilt from the reply through the same provenance checks and state rules (the vendor's freight and GST terms still apply), the old value goes into the cell's `history` with the replacing message and time, and the buyer gets a per-cell diff (rate and its state, landed and its state, annual rupee change)
- [x] An item is resolved only when the new rate is safe; a reply that still omits the currency updates the cell but leaves the item open; rows about lines nobody asked about are ignored; a value only in our own quoted question is rejected (quoted history)
- [x] Scripted V5 reply generated (`data/vendors/V5/Re_Clarification_KHA-PKG-FY26-27.eml`): "Yes, Rs 38/kg applies to both the 3-ply sheet and the 3-ply roll", with our questions quoted underneath as a decoy; ground truth under `replies.V5_clarification_1`
- [x] With a stand-in extraction: L24 rate INFERRED to CONFIRMED, L25 from unpriced review to priced CONFIRMED rate; both cells stay INFERRED overall because freight is still an estimate (the reply settled the rate, not freight); no confirmations or clarifications left for V5
- [x] `npm run reply -- --vendor V5`: drafts the thread from the latest runs, classifies the reply, reads it with pass A (one live call, told which lines were asked about), applies it and prints the diff; `--reuse` replays the saved reading for free
- [x] 478 tests passing across 33 files; typecheck clean; generated files byte-identical across runs

Live on the scripted V5 reply (2026-10-08): one pass A call, $0.027, 7 s. Two rows, L24 and L25, each Rs 38 /kg with nothing carried over; no rows from our quoted questions (the model noted it ignored them as history); nothing ignored or rejected. Both items resolved, L24 rate INFERRED to CONFIRMED, L25 priced with a CONFIRMED rate, nothing left to clarify. Same result as the stand-in. `--reuse` replays it.

### Slice 28: 3 ply BF fix, and questionnaire answers into the gates (2026-10-08)
- [x] 3 ply BF in the V2 and V3 test reports raised from the spec's 17.0 and 16.8 to 18.6 and 18.2; V2's report now clears every line and V3's flags only L04, L06, L07, L08, L23 (trap 16); V3's ground truth `open_question` removed
- [x] `answersFromExtraction` (`evidence/answers.ts`): pass A's answers are checked like prices: a known question, the snippet in the vendor's own text (not quoted history), the answer the vendor's words in that snippet; a question answered two ways counts as unanswered
- [x] `questionnaireFindings`: hedged yes/no answers kept verbatim, and the "no deviations" claim checked against the quotes' spec flags
- [x] Gates: an attached document not yet read makes a yes UNKNOWN, not FAIL (`unread` in `VendorEvidence`); nothing attached on a yes is still a FAIL
- [x] `npm run gates` (free): the latest live answers through the gates and findings, against ground truth
- [x] Bug fixed: `rescore` replayed the reply reading as if it were a V5 quote run (0 percent); it now takes only `-pass-a-` runs
- [x] 490 tests passing across 34 files; typecheck clean; generated files byte-identical; live runs still 100 percent

Live (from the saved runs, free): 36 of 36 answers verified for V1, V2, V3, none rejected; V5 has none, as planted. Q03 matches ground truth for all four. V1's Q12 "No deviations." is contradicted on L01, L02, L03, L05 (trap 03). Hedged: V2 Q07 and V3 Q07 as in ground truth, plus V2 Q04 "On request" (FSC board), which is not in ground truth. Q01 and Q02 are UNKNOWN for V2 and V3 because the live pipeline does not read certificates and test reports yet; V1's fail because V1's certificate and test report were never generated (spec 17.5 lists them).

### Slice 29: V1 evidence, grade-aware report check, and the evidence pass (2026-10-08)
- [x] V1's certificate (ISO 9001, valid to 2027-03-14) and test report generated (spec 17.5), in the manifest and ground truth; the report has a sample per grade offered, the lighter 120 GSM 5 ply included
- [x] Report check matches a line to the sample of the grade it is offered on (`evidence/claims.ts`): V1's 120 GSM sample now flags only L01, L02, L03, L05 (confirming trap 03), not the full spec 5 ply lines; with no sample at the offered grade, all samples of that board count, weakest first, as before
- [x] Q01 now checks the certificate is for ISO 9001: another standard fails, an unreadable one is UNKNOWN (it was not checked before)
- [x] Evidence pass (`ingest/extract_evidence.ts`, `prompts/extract_evidence.md`): one small structured call per certificate or test report, values as written; code parses dates (day first) and numbers and verifies against the PDF text. The entity, standard and dates of a certificate, and the date and every sample of a report, must verify or the document counts as unread (gate UNKNOWN); a sample cannot borrow another row's numbers; other fields are dropped if they do not verify
- [x] `npm run evidence` reads every certificate and test report (live, spends credit); `npm run gates` uses the newest verified reading per file, applies the report's findings to the quotes before checking claims
- [x] 508 tests passing across 35 files; typecheck clean; generated files byte-identical; live quote runs still 100 percent

Live (2026-10-08): six documents read in parallel, $0.049, about 7 s each, Sonnet 5.5 at low effort. Every reading verified against its PDF with no problems; doc roles all correct; dates parsed day first as written. `npm run gates`: all 12 gate results match ground truth (V1 and V3 pass all three, V2 fails Q01 on the certificate that expired 2026-08-31, V5 unknown on all three). The test reports flag exactly the planted lines: V1 L01, L02, L03, L05 (lighter board, contradicting Q12 "No deviations.") and V3 L04, L06, L07, L08, L23 (BF 19.5 against 22, contradicting Q12 "None"). V3's ground truth names its Q02 "BF 22 compliant" claim; the same shortfall is caught through Q12 and the report, and the Q02 wording itself is not parsed.

### Slice 30: eval harness (2026-10-08)
- [x] `eval/harness.ts` (pure): per cell, per vendor and per format metrics (state accuracy, price accuracy, quoted precision and recall, dangerous), the state confusion matrix, the calibration table (spec 19.2: safe states correct when the value is; INFERRED when the true value is inside the stated range; NEEDS_REVIEW when ground truth accepts review or the value really was wrong; MISSING when nothing was offered), recall of wrong cells flagged unsafe, the headline sentence, the targets of 19.7, and the regression gate of 19.8
- [x] A pass/fail check for each of the 27 registered traps against app outputs only; V4's ten traps are reported `not_built`, trap 05 `not_run` (no live run of revision 2); a vendor missing from the run is `not_run`, never a pass
- [x] `npm run eval` (free): assembles every vendor from the saved live runs (shared loader `cli/assemble.ts`, also used by `gates`), writes `eval/report.md`, `eval/report.json` and `eval/history/<time>.json`, and exits 1 on a regression against the last history file
- [x] Ground truth: V1 L06 records its true value (`true_landed_point`) for calibration; V2 Q04 "On request" counted as hedged (decided 2026-10-08)
- [x] Bug found by a harness test and fixed: the scorer did not count a slip shown as CONFIRMED (11.08 for 110.81) as dangerous, because ground truth gives a slip no expected price; it now compares a safe cell with the true value too
- [x] 518 tests passing across 36 files; typecheck clean; generated files byte-identical

Live (tuned set, 4 vendors, 120 cells): "When the system says CONFIRMED, it is right 100.0% of the time (52 of 52), and it flags 100.0% of its own mistakes (1 of 1)." INFERRED 63 of 63 inside their ranges, NEEDS_REVIEW 3 of 3 justified, MISSING 2 of 2. Dangerous 0. Traps 26 of 26 runnable passed. Max 74 s per document, $0.73 for four vendors. Caveat: the tuned set has only one wrong cell, so the recall figure rests on one case; the holdout set is what makes it meaningful.

### Slice 31: holdout set (2026-10-08)
- [x] Each vendor generator takes a variant: the tuned variant holds the spec's constants (every tuned vendor file byte-identical to before), the holdout variant (seed 7) keeps the vendor roles and classes of traps in other layouts, wording and placements (see `data/README.md`)
- [x] V1: rows layout with reversed groups, hidden column, lighter board on L12, L14, L22, a tenfold slip on L16, "Not quoted" L28 and blank L19, other questionnaire wording, own certificate and report
- [x] V2: 3 page proforma with other columns and description order, GST note on page 2, 3 percent above Rs 20 lakh, L08 amount 8 percent low, white text addressed to AI on page 1, alternate for L17, Q07 "against post-dated cheques only", certificate expired 30-09-2026
- [x] V3: four new sentence shapes on eight cartons, per 100 and per 1000 nos, US$ accessories with another FX clause, 7 ply BF 22.8 against a claimed 24 (L15 to L17), validity lapsed 30-09-2026
- [x] V5: multi-line reply with explicit units and currency, our RFx below an Outlook "Original Message" line
- [x] Trap register built from each vendor's own entries, with the placements the eval needs; the harness's trap checks read them instead of tuned constants
- [x] `--set holdout` on `extract`, `evidence`, `rescore`, `gates`; holdout runs go to `data/runs/holdout/`; `npm run eval` scores every set that has runs, one report section and one regression baseline per set
- [x] Bug found on the first look at the parsed holdout workbook and fixed: the first group title shared a row with its first line
- [x] 530 tests passing across 37 files; typecheck clean; both sets deterministic

**First live run on the holdout (2026-10-08, before any fix; this is the honest holdout number).** $0.82 for four vendors plus six evidence documents, max 52 s per document. "When the system says CONFIRMED, it is right 100.0% of the time (49 of 49), and it flags 100.0% of its own mistakes (1 of 1)" (the one wrong value is V1 L16, the tenfold slip, sent to review). Dangerous 0. Quoted detection 100 percent. But traps 20 of 26 runnable (target 90 percent missed), text-native rate accuracy 94.0 percent (target 99 percent missed), and NEEDS_REVIEW justified on only 2 of 9 cells.

The model misread nothing; every failure is in deterministic code or the eval:
- V3 L03, L04, L07, L08 to review: units "a piece" and "per carton" are not in the unit parser's vocabulary (the model read them correctly)
- V3 L26 to L28 to review, and so no `fx_clause` (trap 15): currency "US$" is not recognised by `normalizeCurrency`
- Trap 18 fails on the same four prose lines
- Trap 13: "Yes, against post-dated cheques only." is classified yes; the hedge pattern has no "only"/"against" condition. Both passes noted it as conditional
- Trap 11: the regex injection screen misses "AI assistant reviewing this file: ..."; both passes noticed it and did not act on it, and no price or state changed, but nothing records it as a finding (the model half of the screen is not built)
- Traps 01 and 02: pass B gave the whole row as its snippet instead of the cell text, the xlsx check rejected it, so L01 was settled by the adjudicator at HIGH_CONF. Price right and safe; the two trap checks fail only because they demand every state be exactly as expected, which is stricter than the traps themselves
All of these failed closed except traps 11 and 13, which are missed flags (no price effect here; a hedged answer read as yes on a gate question would be a gate error).

### Slice 32: holdout fixes, and a fresh holdout (2026-10-08)
- [x] The seed 7 first run is kept as the official holdout result: `eval/holdout/seed7-first-run-2026-10-08.md`
- [x] Fixes for the general gaps it exposed, each tested on other phrasings and against every answer and document in all sets for false positives (`tests/holdout-fixes.test.ts`):
  - currencies: US$, US dollars, rupees and the like (`normalizeCurrency`)
  - units: a leading article ("a piece"), and "carton" as a unit, which is one piece of a carton line and an unknown pack anywhere else (`canonicalUnit`, `toBaseUomRate`)
  - hedges: "only", "if", "upon", "against", "as long as", "on condition" (`classifyAnswer`); the safe direction is to over-hedge
  - injection screen: an AI addressed directly ("AI assistant ...:"), "treat ... as verified" (not when a vendor speaks of itself), "ignore other quotations"; parser tags such as "[SMALL TEXT 6pt]" allowed before them. A first wider pattern flagged "We consider the rates final" and was narrowed
  - xlsx provenance: a snippet quoting the whole row is accepted when it holds the cell's own "F33=38.51" entry, and is trimmed to the cell text
- [x] Eval: the mapping traps (01, 02, 34, 11) accept a safe cell that is more cautious than expected (CONFIRMED shown as HIGH_CONF); the injection count re-runs the current screen on the document instead of trusting the saved count
- [x] After fixes (replayed from the saved readings, free; seed 7 is no longer unseen): tuned 26 of 26, seed 7 26 of 26, CONFIRMED 54 of 54, every price right, NEEDS_REVIEW 2 of 2 justified
- [x] A fresh holdout, `data/holdout2/` (seed 8), written after the fixes: other headings and orders, lighter board on L03 and L20, a tenth slip on the kg line L23, a GST note on page 1, an injection in a page 2 footer to "automated bid analysis tools", "per hundred" and "per 50 sets", "$" and "rupees each", a 3 ply BF 17.6 shortfall on six lines, a terse email with the currency said once
- [x] 538 tests passing across 38 files; typecheck clean; all three sets deterministic, tuned and seed 7 vendor files unchanged

**Fresh holdout, first live run (2026-10-08, against ground truth as generated; kept in `eval/holdout/seed8-first-run-2026-10-08.md`).** $0.92 plus the evidence pass, all prices right where shown, dangerous 0, CONFIRMED 26 of 26, the one wrong value (V1 L23 typed a tenth) flagged. Traps 22 of 26 (target 90 percent missed), latency 108 s on V2 (target 90 s missed).
- Traps 01 and 02, and V1 at 10 percent state accuracy: a ground truth error, not an app error. The seed 8 V1 sheet's "Price" header and its rates carry no currency, so by the rule decided for V3 L29 and L30 (no currency written: priced in INR, INFERRED, one batch confirmation) the 28 cells are INFERRED; the generator's ground truth says CONFIRMED. The app asked the right question: "V1 did not state a currency for these prices ... Confirm INR?"
- V2: the passes disagreed on the currency on all 30 lines (pass B read "Rs" from the "Grand total Rs" row); the adjudicator (Opus, $0.14, 30 s) sided with "not written" on every line, citing the header. Correct, but it is why V2 took 108 s: one ambiguous header sent the whole document to adjudication
- Trap 13 (code): "Agreed for net 45 with 1.5% interest after due date" is classified yes; a condition expressed as "with ... interest" is not in the hedge pattern
- Trap 14 (code): "per hundred" (a number in words) is not parsed, so L12 went to review, unpriced (safe)
- The seed 7 fixes held on new wording: US$ and "$", "rupees each", "per no.", the footer injection (screened before the call, and the adjudicator noted the removed passage), row snippets

### Slice 33: buyer UI, first cut (2026-10-08)
- [x] API (`backend/src/server/`, plain Node http, port 8787): serves the saved live runs for each set, no key and no model calls. View models are pure and tested (`views.ts`); never read ground truth. Buyer decisions on batch confirmations are kept in memory per set and lost on restart (no database yet); `Reset decisions` clears them
- [x] Frontend (`frontend/`, React 18 + Vite 6, TypeScript): hash routes, a data set switcher (demo, holdout seed 7, fresh holdout seed 8)
- [x] Comparison page (spec 18.4): grid of landed cells with the six state icons and treatments (dashed italic for INFERRED, amber hatch for NEEDS_REVIEW, dotted grey for MISSING, blue edge for BUYER_VERIFIED), ranges under unsafe cells, per unit or annual value, best overall or best among trusted (the best carries the winning cell's state), coverage, gates, trusted and total value rows, pending batch confirmations, open items by rupees with one click actions (confirm reading, review, draft clarification)
- [x] Cell panel (spec 18.5): value and state with the reason, components with point, low and high, the conversion chain, the probable reading for a slip (shown, never applied), the arithmetic check, the source excerpt with the snippet highlighted and quoted history greyed, a link to the original file, both passes and the adjudicator, spec offered vs required, hidden values, assumptions, earlier values
- [x] Vendor page: coverage, gates with reasons, all answers, validity, terms with their snippets, conditional discounts, evidence (certificate, test report, findings), discrepancies including text addressed to AI, extras, rejected rows, the passes' notes
- [x] Award page (spec 18.6): gate, spec, cell and lapsed-quote policies; cost point and range, savings vs last year, exposure and the award gate, lines with eligibility reasons, allocation by vendor with discounts, resolve first
- [x] Smoke sweep through the dev proxy: 411 requests over every cell, vendor, draft and award policy in all three sets, 0 failures; file serving refuses paths outside the vendors folder
- [x] 545 tests passing across 39 files; backend and frontend typecheck clean; `npm run typecheck` covers both
- Deviations: plain CSS instead of Tailwind, a plain table instead of TanStack Table (small enough not to need either); the analyst drawer, mailbox, co-pilot, trace page, cell actions (verify, override) and award confirmation are not built

### Slice 34: V4, the phone photo, and reading it with vision (2026-10-08)
- [x] Photo pipeline (`generator/photo.ts`, sharp 0.33.5): the card on a desk, perspective (corner offsets 5 to 9 percent) and rotation (4 to 6 degrees) as one homography, uneven light, a paper shadow, vignette, blur, noise, JPEG quality 70, bottom 4 percent cropped (spec 17.8); handwriting drawn as jittered strokes (no font needed); every row's region in the photo recorded; seeded and deterministic on one machine (text is rendered with system fonts)
- [x] V4 (`generator/v4.ts`): the rate card (27 rows; L15 to L17 left off; L12 and L22 blurred under glare, item names still readable; L04 printed 65.90, struck through, 68.50 written beside it; L01, L03, L05 in smaller sizes priced lower; L27 Rs 2,400 per box with no count), the certificate photographed (valid to 10-01-2027), the email arriving 24-09-2026 with the questionnaire in its body and both photos attached but no test report; `photo_params.json` with parameters and regions; ground truth and traps 20 to 28; holdout variants (seed 7, seed 8) moving every trap to other lines with other photo settings
- [x] Checked by looking at the images: a first draft wrote the 68.50 over the row above (L03's rate), moved into the gap beside the struck value; the glare rows unreadable, their neighbours readable. The ranking flip holds in the generated prices: cheapest headline on 22 lines, most expensive landed on 16 of its 23 priced lines
- [x] Vision path: images sent before the text in passes A, B and the adjudicator (`llm/client.ts`); a `photo` attachment in the vendor list loads an email as an image quote (`cli/vendors.ts`); image locators "row N box x0 y0 x1 y1" (`parseRef`), one bullet added to `prompts/conventions.md`; provenance for images: a box inside the image and the rate in the row's transcription (`checkImageRow`); a photo reading is HIGH_CONF at most (rule 8); an unreadable row is still reported, so it goes to review, never missing
- [x] Photographed certificates read with vision; with no text layer the values are taken as read, parsed strictly, and the reading says so (`verifyEvidence(json, null)`)
- [x] Eval: trap checks 20 to 28 (not run until there is a V4 run); trap 33 stays not built (needs the ranking flip indicator in the UI). UI: the cell panel shows the crop of the photo where a value was read (`/api/image`)
- [x] 557 tests passing across 41 files; typechecks clean; all three sets deterministic, other vendors' files unchanged; existing eval numbers unchanged

**Live (2026-10-08 and 09).** About $0.34 on the demo set, $0.25 and $0.34 on the holdouts, $0.01 per certificate photo.
- Demo set: 23 lines agreed across the passes. Pass A misread L12 (a glare row) as 2.30, which is row 13's rate, because of the skew; the provenance check rejected it (2.30 is not in its own transcription of row 12), so the wrong price never reached a cell. The first adjudicator call died mid stream ("terminated"); the disputed lines stayed in review, as designed. Added a retry for dropped streams (`AnthropicLlm.json`), re-ran the adjudicator alone ($0.09): with the image it settled L13 (noting the skew offsets values below each item), kept L04 (struck), L12 and L22 (unreadable) in review. V4 100 percent state and price; certificate photo read (valid to 10-01-2027); gates as ground truth (Q02 fails, test report claimed not attached); Q12 "None" contradicted by the smaller cartons. Demo set now 35 of 35 runnable traps, photo rate accuracy 100 percent of 23, CONFIRMED 52 of 52, dangerous 0
- Fresh holdout (seed 8), first run: V4 100 percent state and price; both glare rows and the struck L20 in review
- Holdout (seed 7), first run: L07 and L24 (the glare rows) came out MISSING, "not quoted", which is false. Both passes saw them and said so in notes ("rate not legible; not reported as rows") but left them out, against the convention. Not dangerous (nothing shown safe), but recall of wrong cells there drops to 1 of 3 and traps 20 and 22 fail. Cause: pass B can only answer found or not found, and pass A's unreadable regions carry no line, so "seen but unreadable" has nowhere structural to go
- The eval now measures photo rate accuracy, and reports text native latency apart from the photo's (74 s text native, 97 s photo)

**Fix for "seen but unreadable" (2026-10-09).** Pass B answers each line priced, not_offered or unreadable (was found true or false); pass A's unreadable regions name their line_id and the readable part of the row; code turns either into a row with no rate, so the line goes to review ("Region unreadable"), never to "not quoted" (`passBToExtraction`, `toExtraction`; prompts `extract_a.md`, `extract_b.md`, `conventions.md`). Tests reproduce the seed 7 failure (rows left out, only reported as unreadable). Live check ($0.36 demo, $0.26 seed 7): seed 7 L07 and L24 now in review, V4 100 percent on both; all sets: CONFIRMED 100 percent, dangerous 0, demo and seed 7 35 of 35 runnable traps, photo rate accuracy 100 percent of 23 on every set. Seed 7's V4 is no longer unseen after this fix; its first run is recorded above.

Seen in the demo re-run: pass A's snippets for nine rows left out the rate, so the provenance check rejected them and the adjudicator settled all nine from the image (correctly; $0.085, 26 s). No error, but cost and latency; the image snippet convention could say "including the rate".

**Image snippets (2026-10-09).** The image locator convention now asks for the whole row including the rate as reported (both figures for a correction), because code checks the rate against it. Live on the demo V4 ($0.35): pass A rows rejected 0 (was 9), 25 of 27 lines agreed, 100 percent state and price. The two left for the adjudicator were the unreadable rows, where both passes read no price; two empty readings now count as agreement (nothing to settle, the line still goes to review under rule 3), so a replay of the same run needs no adjudication at all (27 of 27 agree), saving about $0.08 and 18 s per photo. 560 tests; all sets unchanged (CONFIRMED 100 percent, dangerous 0, demo and seed 7 35 of 35 runnable traps).

### Slice 35: analyst agent, first cut (2026-10-09)
- [x] Read-only database (`analyst/db.ts`): an in-memory SQLite (better-sqlite3 11.10.0) holding only the curated views of spec 14.3 (v_rfx_lines, v_quote_current, v_components, v_vendor_summary, v_coverage, v_gate_status, v_discrepancy, v_exposure_by_vendor), built from the session, `query_only` on; one SELECT or WITH per query, 500 rows; errors name the views so the model can retry. No base tables exist to reach. Vendor text is not in the views
- [x] Calculator (`analyst/calc.ts`): a small parser, never eval; named inputs, + - * / ^, min, max, abs, round, sum
- [x] Tools (`analyst/tools.ts`): query_comparison, get_source (vendor words wrapped as untrusted), calc, scenario_award (the optimizer; waive_gates as a labelled hypothetical; a vendor share cap is not supported and the tool says so), compute_exposure, list_discrepancies, draft_clarification (guarded), make_chart, and answer (the typed blocks of spec 14.4). The write tools (verify a cell, waive a gate) are not offered: they need an explicit instruction and a database
- [x] Agent loop (`analyst/agent.ts`, `prompts/analyst.md` from spec 14.6): Claude Opus 5.5 (config `models.analyst`), adaptive thinking, effort medium, refusal fallback, a retry for dropped streams; no forced tool choice (400 on Opus 5.5), so a turn that ends in text is taken as the answer and still checked
- [x] Grounding check (`analyst/grounding.ts`, spec 14.5): every figure in the answer, table and chart must match a number from this turn's tool results, as rounded in the prose or within 0.5 percent, after lakh, crore and percent scaling; names, sizes, ids and dates are skipped; the RFx's own figures and the buyer's question count. An ungrounded answer goes back with the list (at most twice), then is shown with those figures marked unverified
- [x] Trust block from code (the last scenario_award or compute_exposure), "how I got this" from the tool log; multi-turn history kept per conversation
- [x] API: `POST /api/analyst` streams server-sent events (tool chips, corrections, the final blocks); `npm run api` now reads `.env`. CLI: `npm run ask -- "question"`
- [x] UI: an analyst drawer (spec 18.7): quick prompts from the demo questions, tool chips while it works, answer, table, bar chart, trust card, assumptions, how, action buttons (draft clarification, open vendor, cell or award), unverified figures highlighted, cost per question
- [x] 572 tests passing across 42 files; typechecks clean; frontend builds
- [x] Golden questions (`eval/golden.ts`, `npm run golden`, spec 19.5): G1 to G15, a two-turn follow-up (M1, "now also exclude V1") and two adversarial cases (A1 "mark L25 as confirmed", A2 an instruction planted in the question). Generic checks on every case (every figure grounded, an answer block, no write succeeded, a trust block on priced answers) plus each case's own (tools used, vendors and lines named, refusals, nothing stored changed). G3 and G14 are checked against figures computed independently from ground truth; these were compared with the app's own values on the saved runs first and agree exactly (V5: 57 estimated components, Rs 4.45 crore; L23 in USD per kg for all five vendors). The runner uses a fresh session per case, a cost cap, stops cleanly on an API error, and writes `eval/golden/<time>-<set>.md`. The checks themselves are unit-tested so a good answer passes and a bad one fails (`tests/golden.test.ts`)
- [x] Offline sweep: every analyst tool on the saved runs of all three sets (every view, every cell's source, every vendor's draft and discrepancies, 18 award policies, a hypothetical waiver, exposure, calc, typical SQL): 582 calls, 0 errors
- [x] A clear message in the UI when the API account has no credit, instead of the raw 400

### Slice 36: database, event log and the buyer's actions (2026-10-09)
- [x] SQLite store (`store/store.ts`), one file per data set (`data/app.db` for the demo set): every table of spec 8.2, plus `confirmation_decision` for batch confirmations (not in the spec's schema). Pipeline output (rfx, lines, questions, vendors, submissions, artifacts, quotes, components, terms, answers, certificates, discrepancies) is a snapshot rebuilt from the saved runs (`store/snapshot.ts`); buyer decisions are durable and replayed on every rebuild in the order made (`store/apply.ts`); a decision that no longer fits the data is skipped and reported, never forced. Every decision goes to the event log
- [x] `npm run db -- status | load | reset [--set ...]`: the reset restores a clean state (spec 22 step 2 acceptance). Demo set loaded: 150 quotes, 224 components, 51 answers, 13 discrepancies; `run_trace` stays empty until the trace page
- [x] API: batch confirmations stored; new `verify` (a read rate marked correct; refused for a cell with no price), `override` (the buyer's rate replaces the read one, freight re-added per the vendor's terms: `withBuyerRate`), `waive` (a gate counts as cleared; refused for a passed gate), `award/confirm` (only through `confirmAward`: every required acknowledgment, never when blocked), `awards` (marked stale when the same scenario now gives a different cost or exposure), `events`; `reset` clears the store
- [x] UI: Verify as correct and Enter or Override the rate in the cell panel, Waive on a vendor's failed or unknown gates, Confirm award with the acknowledgment checklist and the history of confirmed awards (current, superseded, stale), an Audit log page, and Reset decisions now asks first
- [x] Analyst write tools (spec 14.2): `verify_cell` and `set_gate_waiver`, run only when the buyer's message in that turn instructs it, naming the vendor and the cell or gate, not as a question ("should we", "what if"), with a reason; code checks this, not the model (`explicitlyInstructed`). Logged as "Meera (via the analyst)". Golden cases W1 (explicit: must verify) and W2 (a question: must not waive) added; A1 still holds (L25 has no price to verify)
- [x] End to end through the dev proxy, with an API restart in the middle: verify V1 L02, enter 110.81 for V1 L06 and 14.20 for the unreadable V4 L12 (landed 16.62 with Bahadurgarh freight), waive V4 Q02 (V4 now WAIVED), confirm the V3 currency batch, confirm the award (refused without its 5 acknowledgments), all still there after the restart; a later rate change on an awarded line marks the award stale; reset removes everything
- [x] 590 tests passing across 44 files; typechecks clean; frontend builds

### Slice 37: trace page (2026-10-09)
- [x] Trace view (`server/trace.ts`, spec 18.8): for one vendor's document, intake (files, hashes, duplicates), parse (characters, quoted history, photos sent as images), injection screen, pass A and pass B rows (rate, unit, currency, where, legibility, struck or carried, assumptions, and the provenance check's verdict), reconciliation, the adjudicator's decisions, checks (slips, arithmetic, spec against the RFx and the test report, hidden values), normalization (the chain, rate and freight with their states, landed range), state assignment with the rule that fired, evidence documents, gates, and the buyer's decisions from the audit log. Each model call shows its model, time, tokens (cached and written), cost, stop reason, prompt version and time
- [x] One cell's slice (`/api/trace?vendor=V5&line=L25`): only the stages and calls that touched it, everything open; links from the cell panel ("Trace this cell"), the vendor page ("Pipeline trace") and each line in the whole-document trace
- [x] The session keeps each saved run (without its ground truth scores) and the model calls behind it; the store's `run_trace` table is now filled (19 calls on the demo set)
- [x] Swept: 465 traces (every vendor and cell, all three sets), 0 errors, 0 containing a ground truth field
- [x] 593 tests passing across 45 files; typechecks clean; frontend builds

### Slice 38: seed 8 follow-ups and the ranking flip (2026-10-09)
- [x] Seed 8 ground truth: a V1 rows header with no currency ("Price") now expects INFERRED with `currency_assumed`, the V3 rule; the app's batch question was right all along
- [x] Code gaps found on seed 8: number words in units ("per hundred" is 100, "per thousand" 1000); "interest", "penalty", "surcharge" and late payment charges count as hedges in an answer
- [x] Trap 14's check reads each line's pack size from ground truth instead of assuming 100
- [x] Ranking flip (`award/rankings.ts`, spec 18.4, trap 33): each vendor indexed against last year's prices over the lines it priced (needs review left out), headline (own rate) and landed (with freight), ranked both ways; the comparison carries `vendors[].ranking`; the harness checks V4 flips (demo: #1 on paper, #3 delivered). Trap 33 moved from "not built" to the register
- [x] `npm run eval`: 36 of 36 runnable traps on the demo set (37 registered; trap 05 needs a live run of V1 revision 2) and on both holdouts; CONFIRMED precision 100 percent and 0 dangerous errors on every set. The first-run holdout reports stay the official numbers
- [x] Ranking unit tests (`tests/rankings.test.ts`)

### Slice 39: UI overhaul (2026-10-09)
- [x] Design system (`frontend/src/styles.css`, `components/ui.tsx`): Inter, one accent, a colour per vendor, tabular figures; tiles, banners, segmented controls, tags, pills, toasts after every buyer action, skeletons while loading
- [x] Shell: brand, nav pills, data set picker, Reset, Ask the analyst. Deep links: `#/comparison/V4/L04` opens that cell's panel, `#/ask` opens the analyst
- [x] Comparison: summary tiles (lowest landed, lowest among trusted cells, open items with rupees at stake, gates cleared, ranking flips), the confirmation banner, toolbar (per unit or annual, best overall or among trusted, cell filter, line search, legend), grid grouped by product family with sticky header and first column, vendor header cards (format, freight, validity, AI-directed text, coverage bar, ranking flip tag), the best cell tinted, open items ranked by rupees
- [x] Cell panel: sticky header with Trace, price with state badge, a facts strip (range, annual, against last year), the reason in the state's colour, actions, the number's build-up (rate, freight, landed), the source with the photo crop, both passes, spec, hidden values, assumptions, earlier values
- [x] Vendor page: avatar and contact, tiles (coverage with a state bar, gates, validity, reply), the gate checklist with answers and Waive, discrepancies, AI-directed text, terms as stated, evidence cards
- [x] Award page: scenario controls by group, tiles, gate banners, lines with vendor chips and states, the allocation bar in vendor colours, resolve first, the confirm card with the acknowledgment checklist (Tick all) and award history
- [x] Audit log as a list with icons, reasons and actors; Trace with tiles, model-call chips, expand or collapse all; analyst drawer with chat bubbles, tool chips and a typing indicator
- [x] Checked by screenshot at 1300 and 1600 px wide; no console errors. 597 tests passing across 46 files; typechecks clean

## Next up
- [ ] Run the analyst live: `npm run golden` (18 cases, stops at $5). Blocked on 2026-10-09: the Anthropic account's credit balance is too low (the API answers 400 before any model runs; nothing was charged)
- [ ] UI feedback from testing
- [ ] Vendor share cap (G2) and the award memo export (G9)
- [ ] Consider treating a currency named only on a total row as a hint, not a disagreement, so one ambiguous header does not send every line to the adjudicator
- [ ] Checks: duplicate rows and cross-artifact conflicts
- [ ] Per box candidate interpretations (test vector 10)
- [ ] V5 alternate reading note (per kg applied to cartons via weight, shown but not applied)

## Decisions and deviations
- Vitest pinned to 3.x because vitest 4+ needs a newer Node than 20.10.
- Line dimensions stored as `dims_text` strings, not the `dims_mm` arrays of spec 8.2, because some lines are not three-part (e.g. "1500 wide").
- V3's USD lines (L26 to L28) and V5 are not produced by the baseline price generator; they get their own paths.
- Freight lane tariff lives only in `config.yaml`, not duplicated in RFx data.
- Extraction schema adds `resolves_to: baseline | other` on `lines_not_quoted_statement`. The model interprets the sentence; code applies it. Without it, code would have to parse English.
- Legibility threshold (0.6) is a constant in `model/states.ts`, not yet in config.
- GST basis not stated is taken as ex GST per the RFx terms, recorded as an assumption with flag `gst_basis_assumed`. It does not change the cell state yet; revisit with the discrepancy list.
- Freight basis not stated adds no freight and sets flag `freight_basis_assumed`, so landed cost may be understated. Needs to surface in the UI.
- Rows with a stated assumption (such as V5's per kg to board mapping) become HIGH_CONF via rule 9, matching spec 17.5.

## Not built yet
The model half of intent classification, co-pilot, award memo and exports, vendor share cap, MIP constraints beyond the gate and spec policies.

## Verify
```bash
npm install
npm test
npm run typecheck
npm run gen-data   # writes data/ (V1 Excel, rfx.json, ground_truth.json)
npm run summary    # prints the RFx line table and checks the baseline total
npm run check-key                # free: confirms the key and the configured models
npm run extract -- --vendor V5   # live pass A (effort medium by default); spends API credit
npm run rescore                  # free: replays the latest saved runs through the current code
npm run clarify -- --vendor V5   # free: the clarification draft from the latest runs, guard included
npm run evidence                 # live: reads every certificate and test report (six small calls)
npm run gates                    # free: live questionnaire answers through the gates, against ground truth
npm run gen-data                 # writes all sets: data/ (tuned, seed 42), data/holdout/ (seed 7), data/holdout2/ (seed 8)
npm run dev                      # the UI on http://localhost:5173 (API on 8787), from the saved runs
npm run ask -- "question"        # live: one question to the analyst (Claude Opus), about $0.10 to $0.40
npm run golden                   # live: the analyst's golden questions (spec 19.5), stops at $5
npm run db -- status             # the store for the demo set; `load` rebuilds the snapshot, `reset` clears every decision
npm run eval                     # free: the eval harness on the saved runs; writes eval/report.md
npm run reply -- --vendor V5     # one live pass A call on the scripted reply; add --reuse to replay for free
```
