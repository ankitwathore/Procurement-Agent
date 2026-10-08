# QuoteKill eval report (tuned set, 2026-10-08)

**When the system says CONFIRMED, it is right 100.0% of the time (52 of 52), and it flags 100.0% of its own mistakes (1 of 1).**

Dangerous errors (shown safe but wrong): 0 of 52 safe cells (0.0%).

Regression gate: passed (no drop in CONFIRMED precision, no rise in dangerous errors).

## Calibration (spec 19.2)

| Reported state | Cells | Actually correct | Precision | Counted correct when |
|---|---|---|---|---|
| CONFIRMED | 52 | 52 | 100.0% | value correct within 0.5% (safe state) |
| HIGH_CONF | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| BUYER_VERIFIED | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| INFERRED | 86 | 86 | 100.0% | true value within the stated range |
| NEEDS_REVIEW | 7 | 7 | 100.0% | genuinely ambiguous or wrong |
| MISSING | 5 | 5 | 100.0% | nothing was offered |

Wrong cells: 1 (V1:L06); flagged unsafe: 1.

## Extraction (spec 19.1)

| Group | Cells | State accuracy | Price accuracy | Quoted precision | Quoted recall | Dangerous |
|---|---|---|---|---|---|---|
| V1 | 30 | 100.0% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| V2 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V3 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V4 | 30 | 100.0% | 100.0% of 23 | 100.0% | 100.0% | 0 |
| V5 | 30 | 100.0% | 100.0% of 29 | 100.0% | 100.0% | 0 |
| xlsx | 30 | 100.0% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| pdf | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| docx | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| photo | 30 | 100.0% | 100.0% of 23 | 100.0% | 100.0% | 0 |
| email | 30 | 100.0% | 100.0% of 29 | 100.0% | 100.0% | 0 |
| all | 150 | 100.0% | 100.0% of 139 | 100.0% | 100.0% | 0 |

State confusion (rows expected, columns reported):

| expected | CONFIRMED | HIGH_CONF | BUYER_VERIFIED | INFERRED | NEEDS_REVIEW | MISSING |
|---|---|---|---|---|---|---|
| CONFIRMED | 52 | 0 | 0 | 0 | 0 | 0 |
| INFERRED | 0 | 0 | 0 | 86 | 0 | 0 |
| NEEDS_REVIEW | 0 | 0 | 0 | 0 | 7 | 0 |
| MISSING | 0 | 0 | 0 | 0 | 0 | 5 |

## Traps (spec 19.3): 36 of 36 runnable passed; 37 registered

| Trap | Vendor | Status | Detail |
|---|---|---|---|
| 01 | V1 | pass | state 100.0%, price 100.0%, every rate located by cell: true |
| 02 | V1 | pass | hidden values flagged on 28 of 28 lines; visible values used |
| 03 | V1 | pass | spec_below_requirement on L01, L02, L03, L05; Q12 contradiction on L01, L02, L03, L05 |
| 04 | V1 | pass | L06 NEEDS_REVIEW, suggested 110.80 for 110.81 (not applied), clarification asks: true |
| 05 | V1 | not_run | no saved live run of V1 revision 2 |
| 06 | V2 | pass | GST basis inclusive from page 3 (expected 3); prices normalized ex GST |
| 07 | V2 | pass | 5% above Rs 2500000 captured as a case: "5 percent discount on invoice value if total annual PO value with us exceeds Rs 25,00,000." |
| 08 | V2 | pass | freight from the Ahmedabad lane, INFERRED, on 30 priced lines |
| 09 | V2 | pass | Q01 FAIL: Expired on 2026-08-31, before today (2026-10-08). |
| 10 | V2 | pass | L15 NEEDS_REVIEW, arithmetic_mismatch |
| 11 | V2 | pass | 4 injection finding(s) stripped; every V2 price and state as expected |
| 12 | V2 | pass | alternate listed ("ALT: 7 Ply BCB 200/24 for Room Cooler 40L"), L06 priced from the main offer |
| 13 | V2 | pass | hedged: Q04, Q07 |
| 14 | V3 | pass | 9 of 9 per pack lines converted in code with the chain shown |
| 15 | V3 | pass | L26, L27, L28: INFERRED with the FX band |
| 16 | V3 | pass | test report below requirement on L04, L06, L07, L08, L23; claim contradicted: Q12 "None" |
| 17 | V3 | pass | validity lapsed (2026-10-03), excluded by default: true |
| 18 | V3 | pass | 11 prose lines priced with paragraph locators |
| 19 | V3 | pass | hedged: Q07 |
| 20 | V4 | pass | 23 readable lines priced, 0 wrong (none) |
| 21 | V4 | pass | L15 MISSING, L16 MISSING, L17 MISSING |
| 22 | V4 | pass | L12 NEEDS_REVIEW, L22 NEEDS_REVIEW (review, not missing) |
| 23 | V4 | pass | L04 NEEDS_REVIEW: Value struck out or overwritten |
| 24 | V4 | pass | spec_dimension_off on L01, L03, L05 |
| 25 | V4 | pass | L27 NEEDS_REVIEW, not priced: the box count is never assumed |
| 26 | V4 | pass | Q02 FAIL: Answered yes, but no test report was attached (claim without evidence). |
| 27 | V4 | pass | late true, validity expiring (2026-10-09) |
| 28 | V4 | pass | cheapest headline on 21 lines; of those, most expensive landed on 14 |
| 29 | V5 | pass | 27 lines INFERRED from "rest same as last year" with a range |
| 30 | V5 | pass | per kg rates applied to L23, L24 (allowed: L23, L24, L25) |
| 31 | V5 | pass | gates UNKNOWN, validity not_stated |
| 32 | V5 | pass | default tariff on 29 priced lines |
| 33 | All | pass | V4 headline rank 1 (-13.7% vs last year), landed rank 3 (2.7%) |
| 34 | V2 | pass | own codes and reordered rows mapped: state 100.0%, price 100.0% |
| 35 | V1 | pass | L20 MISSING, L21 MISSING |
| 36 | V2 | pass | deduped by hash: Quotation_Kaveri_Packaging.pdf |
| 37 | V5 | pass | no value taken from quoted history |

## Targets (spec 19.7)

| Metric | Target | Value | Status |
|---|---|---|---|
| Rate accuracy, text native | >= 99% | 100.0% | met |
| Rate accuracy, photo | >= 93% | 100.0% of 23 | met |
| Quoted vs missing detection (tuned) | 100% | precision 100.0%, recall 100.0% | met |
| Precision of CONFIRMED | >= 99.5% | 100.0% | met |
| Recall of wrong cells flagged unsafe | >= 95% | 100.0% | met |
| Trap recall (tuned, of runnable) | 100% | 36 of 36 | met |
| Analyst golden pass rate | >= 90% | n/a | not_measured |
| Grounding rate after correction loop | 100% | n/a | not_measured |
| Adversarial pass rate | 100% | n/a | not_measured |
| Per document latency, text native | < 90 s | 74 s max (photo: 79 s) | met |
| Cost per full RFx (5 of 5 vendors) | < 5 USD | $1.09 | met |

## Not covered yet

- Trap 05 (V1 revision 2) needs a live run of the revised workbook.
- V4 (phone photo) not built: its traps and the photo targets are not measured.
- Exposure accuracy against an independent solver (spec 19.4) not built.
- Analyst golden questions (spec 19.5) and the adversarial suite (spec 19.6) not built.

# QuoteKill eval report (holdout set, 2026-10-08)

**When the system says CONFIRMED, it is right 100.0% of the time (54 of 54), and it flags 100.0% of its own mistakes (1 of 1).**

Dangerous errors (shown safe but wrong): 0 of 54 safe cells (0.0%).

Regression gate: passed (no drop in CONFIRMED precision, no rise in dangerous errors).

## Calibration (spec 19.2)

| Reported state | Cells | Actually correct | Precision | Counted correct when |
|---|---|---|---|---|
| CONFIRMED | 54 | 54 | 100.0% | value correct within 0.5% (safe state) |
| HIGH_CONF | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| BUYER_VERIFIED | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| INFERRED | 85 | 85 | 100.0% | true value within the stated range |
| NEEDS_REVIEW | 6 | 6 | 100.0% | genuinely ambiguous or wrong |
| MISSING | 5 | 5 | 100.0% | nothing was offered |

Wrong cells: 1 (V1:L16); flagged unsafe: 1.

## Extraction (spec 19.1)

| Group | Cells | State accuracy | Price accuracy | Quoted precision | Quoted recall | Dangerous |
|---|---|---|---|---|---|---|
| V1 | 30 | 100.0% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| V2 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V3 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V4 | 30 | 100.0% | 100.0% of 23 | 100.0% | 100.0% | 0 |
| V5 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| xlsx | 30 | 100.0% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| pdf | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| docx | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| photo | 30 | 100.0% | 100.0% of 23 | 100.0% | 100.0% | 0 |
| email | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| all | 150 | 100.0% | 100.0% of 140 | 100.0% | 100.0% | 0 |

State confusion (rows expected, columns reported):

| expected | CONFIRMED | HIGH_CONF | BUYER_VERIFIED | INFERRED | NEEDS_REVIEW | MISSING |
|---|---|---|---|---|---|---|
| CONFIRMED | 54 | 0 | 0 | 0 | 0 | 0 |
| INFERRED | 0 | 0 | 0 | 84 | 0 | 0 |
| NEEDS_REVIEW | 0 | 0 | 0 | 1 | 6 | 0 |
| MISSING | 0 | 0 | 0 | 0 | 0 | 5 |

## Traps (spec 19.3): 36 of 36 runnable passed; 36 registered

| Trap | Vendor | Status | Detail |
|---|---|---|---|
| 01 | V1 | pass | state 100.0%, price 100.0%, every rate located by cell: true |
| 02 | V1 | pass | hidden values flagged on 28 of 28 lines; visible values used |
| 03 | V1 | pass | spec_below_requirement on L12, L14, L22; Q12 contradiction on L12, L14, L22 |
| 04 | V1 | pass | L16 NEEDS_REVIEW, suggested 267.58 for 267.58 (not applied), clarification asks: true |
| 06 | V2 | pass | GST basis inclusive from page 2 (expected 2); prices normalized ex GST |
| 07 | V2 | pass | 3% above Rs 2000000 captured as a case: "6. Discount: 3 percent on invoice value where annual orders placed exceed Rs 20,00,000." |
| 08 | V2 | pass | freight from the Ahmedabad lane, INFERRED, on 30 priced lines |
| 09 | V2 | pass | Q01 FAIL: Expired on 2026-09-30, before today (2026-10-08). |
| 10 | V2 | pass | L08 NEEDS_REVIEW, arithmetic_mismatch |
| 11 | V2 | pass | 3 injection finding(s) stripped; every V2 price and state as expected |
| 12 | V2 | pass | alternate listed ("Alternate: 5 Ply BC 180/22 in place of 7 ply, Fridge Outer (dims listed 800x340x580)"), L17 priced from the main offer |
| 13 | V2 | pass | hedged: Q04, Q07 |
| 14 | V3 | pass | 6 of 6 per pack lines converted in code with the chain shown |
| 15 | V3 | pass | L26, L27, L28: INFERRED with the FX band |
| 16 | V3 | pass | test report below requirement on L15, L16, L17; claim contradicted: Q12 "None" |
| 17 | V3 | pass | validity lapsed (2026-09-30), excluded by default: true |
| 18 | V3 | pass | 8 prose lines priced with paragraph locators |
| 19 | V3 | pass | hedged: Q07 |
| 20 | V4 | pass | 23 readable lines priced, 0 wrong (none) |
| 21 | V4 | pass | L26 MISSING, L27 MISSING, L28 MISSING |
| 22 | V4 | pass | L07 NEEDS_REVIEW, L24 NEEDS_REVIEW (review, not missing) |
| 23 | V4 | pass | L09 NEEDS_REVIEW: Value struck out or overwritten |
| 24 | V4 | pass | spec_dimension_off on L02, L06 |
| 25 | V4 | pass | L30 NEEDS_REVIEW, not priced: the box count is never assumed |
| 26 | V4 | pass | Q02 FAIL: Answered yes, but no test report was attached (claim without evidence). |
| 27 | V4 | pass | late true, validity expiring (2026-10-09) |
| 28 | V4 | pass | cheapest headline on 23 lines; of those, most expensive landed on 18 |
| 29 | V5 | pass | 27 lines INFERRED from "rest same as last year" with a range |
| 30 | V5 | pass | per kg rates applied to L23, L24, L25 (allowed: L23, L24, L25) |
| 31 | V5 | pass | gates UNKNOWN, validity not_stated |
| 32 | V5 | pass | default tariff on 30 priced lines |
| 33 | All | pass | V4 headline rank 1 (-12.5% vs last year), landed rank 4 (3.9%) |
| 34 | V2 | pass | own codes and reordered rows mapped: state 100.0%, price 100.0% |
| 35 | V1 | pass | L28 MISSING, L19 MISSING |
| 36 | V2 | pass | deduped by hash: Packwell_offer_Kaveri.pdf |
| 37 | V5 | pass | no value taken from quoted history |

## Targets (spec 19.7)

| Metric | Target | Value | Status |
|---|---|---|---|
| Rate accuracy, text native | >= 99% | 100.0% | met |
| Rate accuracy, photo | >= 93% | 100.0% of 23 | met |
| Quoted vs missing detection (holdout) | >= 98% | precision 100.0%, recall 100.0% | met |
| Precision of CONFIRMED | >= 99.5% | 100.0% | met |
| Recall of wrong cells flagged unsafe | >= 95% | 100.0% | met |
| Trap recall (holdout, of runnable) | >= 90% | 36 of 36 | met |
| Analyst golden pass rate | >= 90% | n/a | not_measured |
| Grounding rate after correction loop | 100% | n/a | not_measured |
| Adversarial pass rate | 100% | n/a | not_measured |
| Per document latency, text native | < 90 s | 52 s max (photo: 56 s) | met |
| Cost per full RFx (5 of 5 vendors) | < 5 USD | $1.09 | met |

## Not covered yet

- The holdout has no revision 2 and no clarification reply; trap 05 is tuned only.
- Seed 7 is no longer unseen: the code fixes of 2026-10-08 were prompted by its first run (kept in eval/holdout/seed7-first-run-2026-10-08.md).
- V4 (phone photo) not built: its traps and the photo targets are not measured.
- Exposure accuracy against an independent solver (spec 19.4) not built.
- Analyst golden questions (spec 19.5) and the adversarial suite (spec 19.6) not built.

# QuoteKill eval report (holdout2 set, 2026-10-08)

**When the system says CONFIRMED, it is right 100.0% of the time (27 of 27), and it flags 100.0% of its own mistakes (1 of 1).**

Dangerous errors (shown safe but wrong): 0 of 27 safe cells (0.0%).

Regression gate: passed (no drop in CONFIRMED precision, no rise in dangerous errors).

## Calibration (spec 19.2)

| Reported state | Cells | Actually correct | Precision | Counted correct when |
|---|---|---|---|---|
| CONFIRMED | 27 | 27 | 100.0% | value correct within 0.5% (safe state) |
| HIGH_CONF | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| BUYER_VERIFIED | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| INFERRED | 112 | 112 | 100.0% | true value within the stated range |
| NEEDS_REVIEW | 6 | 6 | 100.0% | genuinely ambiguous or wrong |
| MISSING | 5 | 5 | 100.0% | nothing was offered |

Wrong cells: 1 (V1:L23); flagged unsafe: 1.

## Extraction (spec 19.1)

| Group | Cells | State accuracy | Price accuracy | Quoted precision | Quoted recall | Dangerous |
|---|---|---|---|---|---|---|
| V1 | 30 | 100.0% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| V2 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V3 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V4 | 30 | 100.0% | 100.0% of 23 | 100.0% | 100.0% | 0 |
| V5 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| xlsx | 30 | 100.0% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| pdf | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| docx | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| photo | 30 | 100.0% | 100.0% of 23 | 100.0% | 100.0% | 0 |
| email | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| all | 150 | 100.0% | 100.0% of 140 | 100.0% | 100.0% | 0 |

State confusion (rows expected, columns reported):

| expected | CONFIRMED | HIGH_CONF | BUYER_VERIFIED | INFERRED | NEEDS_REVIEW | MISSING |
|---|---|---|---|---|---|---|
| CONFIRMED | 27 | 0 | 0 | 0 | 0 | 0 |
| INFERRED | 0 | 0 | 0 | 112 | 0 | 0 |
| NEEDS_REVIEW | 0 | 0 | 0 | 0 | 6 | 0 |
| MISSING | 0 | 0 | 0 | 0 | 0 | 5 |

## Traps (spec 19.3): 36 of 36 runnable passed; 36 registered

| Trap | Vendor | Status | Detail |
|---|---|---|---|
| 01 | V1 | pass | state 100.0%, price 100.0%, every rate located by cell: true |
| 02 | V1 | pass | hidden values flagged on 28 of 28 lines; visible values used |
| 03 | V1 | pass | spec_below_requirement on L03, L20; Q12 contradiction on L03, L20 |
| 04 | V1 | pass | L23 NEEDS_REVIEW, suggested 44.30 for 44.32 (not applied), clarification asks: true |
| 06 | V2 | pass | GST basis inclusive from page 1 (expected 1); prices normalized ex GST |
| 07 | V2 | pass | 2% above Rs 4000000 captured as a case: "6. Volume discount: 2% if total annual business crosses Rs 40 lakh." |
| 08 | V2 | pass | freight from the Ahmedabad lane, INFERRED, on 30 priced lines |
| 09 | V2 | pass | Q01 FAIL: Expired on 2026-07-15, before today (2026-10-08). |
| 10 | V2 | pass | L22 NEEDS_REVIEW, arithmetic_mismatch |
| 11 | V2 | pass | 1 injection finding(s) stripped; every V2 price and state as expected |
| 12 | V2 | pass | alternate listed ("Option: 3 Ply B 180/22 for Cooktop Glass Plate Inner"), L12 priced from the main offer |
| 13 | V2 | pass | hedged: Q07 |
| 14 | V3 | pass | 4 of 4 per pack lines converted in code with the chain shown |
| 15 | V3 | pass | L26, L27, L28: INFERRED with the FX band |
| 16 | V3 | pass | test report below requirement on L12, L14, L21, L22, L24, L29; claim contradicted: Q12 "None" |
| 17 | V3 | pass | validity lapsed (2026-09-25), excluded by default: true |
| 18 | V3 | pass | 6 prose lines priced with paragraph locators |
| 19 | V3 | pass | hedged: Q07 |
| 20 | V4 | pass | 23 readable lines priced, 0 wrong (none) |
| 21 | V4 | pass | L23 MISSING, L24 MISSING, L25 MISSING |
| 22 | V4 | pass | L05 NEEDS_REVIEW, L16 NEEDS_REVIEW (review, not missing) |
| 23 | V4 | pass | L20 NEEDS_REVIEW: Value struck out or overwritten |
| 24 | V4 | pass | spec_dimension_off on L07, L08 |
| 25 | V4 | pass | L28 NEEDS_REVIEW, not priced: the box count is never assumed |
| 26 | V4 | pass | Q02 FAIL: Answered yes, but no test report was attached (claim without evidence). |
| 27 | V4 | pass | late true, validity expiring (2026-10-09) |
| 28 | V4 | pass | cheapest headline on 22 lines; of those, most expensive landed on 15 |
| 29 | V5 | pass | 27 lines INFERRED from "rest same as last year" with a range |
| 30 | V5 | pass | per kg rates applied to L23, L24, L25 (allowed: L23, L24, L25) |
| 31 | V5 | pass | gates UNKNOWN, validity not_stated |
| 32 | V5 | pass | default tariff on 30 priced lines |
| 33 | All | pass | V4 headline rank 1 (-12.3% vs last year), landed rank 3 (3.1%) |
| 34 | V2 | pass | own codes and reordered rows mapped: state 100.0%, price 100.0% |
| 35 | V1 | pass | L27 MISSING, L13 MISSING |
| 36 | V2 | pass | deduped by hash: APW_Quote_Kaveri_Sep26.pdf |
| 37 | V5 | pass | no value taken from quoted history |

## Targets (spec 19.7)

| Metric | Target | Value | Status |
|---|---|---|---|
| Rate accuracy, text native | >= 99% | 100.0% | met |
| Rate accuracy, photo | >= 93% | 100.0% of 23 | met |
| Quoted vs missing detection (holdout2) | >= 98% | precision 100.0%, recall 100.0% | met |
| Precision of CONFIRMED | >= 99.5% | 100.0% | met |
| Recall of wrong cells flagged unsafe | >= 95% | 100.0% | met |
| Trap recall (holdout2, of runnable) | >= 90% | 36 of 36 | met |
| Analyst golden pass rate | >= 90% | n/a | not_measured |
| Grounding rate after correction loop | 100% | n/a | not_measured |
| Adversarial pass rate | 100% | n/a | not_measured |
| Per document latency, text native | < 90 s | 108 s max (photo: 90 s) | missed |
| Cost per full RFx (5 of 5 vendors) | < 5 USD | $1.27 | met |

## Not covered yet

- The holdout has no revision 2 and no clarification reply; trap 05 is tuned only.
- V4 (phone photo) not built: its traps and the photo targets are not measured.
- Exposure accuracy against an independent solver (spec 19.4) not built.
- Analyst golden questions (spec 19.5) and the adversarial suite (spec 19.6) not built.
