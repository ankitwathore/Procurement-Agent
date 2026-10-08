<!-- The official holdout result: first live run on unseen files, before any fix. Do not regenerate. -->
# QuoteKill eval report (holdout set, 2026-10-08)

**When the system says CONFIRMED, it is right 100.0% of the time (49 of 49), and it flags 100.0% of its own mistakes (1 of 1).**

Dangerous errors (shown safe but wrong): 0 of 50 safe cells (0.0%).

Regression gate: passed (no drop in CONFIRMED precision, no rise in dangerous errors).

## Calibration (spec 19.2)

| Reported state | Cells | Actually correct | Precision | Counted correct when |
|---|---|---|---|---|
| CONFIRMED | 49 | 49 | 100.0% | value correct within 0.5% (safe state) |
| HIGH_CONF | 1 | 1 | 100.0% | value correct within 0.5% (safe state) |
| BUYER_VERIFIED | 0 | 0 | n/a | value correct within 0.5% (safe state) |
| INFERRED | 59 | 59 | 100.0% | true value within the stated range |
| NEEDS_REVIEW | 9 | 2 | 22.2% | genuinely ambiguous or wrong |
| MISSING | 2 | 2 | 100.0% | nothing was offered |

Wrong cells: 1 (V1:L16); flagged unsafe: 1.

## Extraction (spec 19.1)

| Group | Cells | State accuracy | Price accuracy | Quoted precision | Quoted recall | Dangerous |
|---|---|---|---|---|---|---|
| V1 | 30 | 96.7% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| V2 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| V3 | 30 | 76.7% | 76.7% of 30 | 100.0% | 100.0% | 0 |
| V5 | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| xlsx | 30 | 96.7% | 100.0% of 27 | 100.0% | 100.0% | 0 |
| pdf | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| docx | 30 | 76.7% | 76.7% of 30 | 100.0% | 100.0% | 0 |
| email | 30 | 100.0% | 100.0% of 30 | 100.0% | 100.0% | 0 |
| all | 120 | 93.3% | 94.0% of 117 | 100.0% | 100.0% | 0 |

State confusion (rows expected, columns reported):

| expected | CONFIRMED | HIGH_CONF | BUYER_VERIFIED | INFERRED | NEEDS_REVIEW | MISSING |
|---|---|---|---|---|---|---|
| CONFIRMED | 49 | 1 | 0 | 0 | 4 | 0 |
| INFERRED | 0 | 0 | 0 | 58 | 3 | 0 |
| NEEDS_REVIEW | 0 | 0 | 0 | 1 | 2 | 0 |
| MISSING | 0 | 0 | 0 | 0 | 0 | 2 |

## Traps (spec 19.3): 20 of 26 runnable passed; 36 registered

| Trap | Vendor | Status | Detail |
|---|---|---|---|
| 01 | V1 | fail | state 96.7%, price 100.0%, every rate located by cell: true |
| 02 | V1 | fail | hidden values flagged on 28 of 28 lines; visible values used |
| 03 | V1 | pass | spec_below_requirement on L12, L14, L22; Q12 contradiction on L12, L14, L22 |
| 04 | V1 | pass | L16 NEEDS_REVIEW, suggested 267.58 for 267.58 (not applied), clarification asks: true |
| 06 | V2 | pass | GST basis inclusive from page 2 (expected 2); prices normalized ex GST |
| 07 | V2 | pass | 3% above Rs 2000000 captured as a case: "6. Discount: 3 percent on invoice value where annual orders placed exceed Rs 20,00,000." |
| 08 | V2 | pass | freight from the Ahmedabad lane, INFERRED, on 30 priced lines |
| 09 | V2 | pass | Q01 FAIL: Expired on 2026-09-30, before today (2026-10-08). |
| 10 | V2 | pass | L08 NEEDS_REVIEW, arithmetic_mismatch |
| 11 | V2 | fail | 0 injection finding(s) stripped; every V2 price and state as expected |
| 12 | V2 | pass | alternate listed ("Alternate: 5 Ply BC 180/22 in place of 7 ply, Fridge Outer (dims listed 800x340x580)"), L17 priced from the main offer |
| 13 | V2 | fail | hedged: Q04 |
| 14 | V3 | pass | 6 per pack lines converted in code with the chain shown |
| 15 | V3 | fail | L26, L27, L28: INFERRED with the FX band |
| 16 | V3 | pass | test report below requirement on L15, L16, L17; claim contradicted: Q12 "None" |
| 17 | V3 | pass | validity lapsed (2026-09-30), excluded by default: true |
| 18 | V3 | fail | 8 prose lines priced with paragraph locators |
| 19 | V3 | pass | hedged: Q07 |
| 20 | V4 | not_built | the input or feature is not built yet |
| 21 | V4 | not_built | the input or feature is not built yet |
| 22 | V4 | not_built | the input or feature is not built yet |
| 23 | V4 | not_built | the input or feature is not built yet |
| 24 | V4 | not_built | the input or feature is not built yet |
| 25 | V4 | not_built | the input or feature is not built yet |
| 26 | V4 | not_built | the input or feature is not built yet |
| 27 | V4 | not_built | the input or feature is not built yet |
| 28 | V4 | not_built | the input or feature is not built yet |
| 29 | V5 | pass | 27 lines INFERRED from "rest same as last year" with a range |
| 30 | V5 | pass | per kg rates applied to L23, L24, L25 (allowed: L23, L24, L25) |
| 31 | V5 | pass | gates UNKNOWN, validity not_stated |
| 32 | V5 | pass | default tariff on 30 priced lines |
| 33 | All | not_built | the input or feature is not built yet |
| 34 | V2 | pass | own codes and reordered rows mapped: state 100.0%, price 100.0% |
| 35 | V1 | pass | L28 MISSING, L19 MISSING |
| 36 | V2 | pass | deduped by hash: Packwell_offer_Kaveri.pdf |
| 37 | V5 | pass | no value taken from quoted history |

## Targets (spec 19.7)

| Metric | Target | Value | Status |
|---|---|---|---|
| Rate accuracy, text native | >= 99% | 94.0% | missed |
| Rate accuracy, photo | >= 93% | n/a | not_measured |
| Quoted vs missing detection (holdout) | >= 98% | precision 100.0%, recall 100.0% | met |
| Precision of CONFIRMED | >= 99.5% | 100.0% | met |
| Recall of wrong cells flagged unsafe | >= 95% | 100.0% | met |
| Trap recall (holdout, of runnable) | >= 90% | 20 of 26 | missed |
| Analyst golden pass rate | >= 90% | n/a | not_measured |
| Grounding rate after correction loop | 100% | n/a | not_measured |
| Adversarial pass rate | 100% | n/a | not_measured |
| Per document latency, text native | < 90 s | 52 s max | met |
| Cost per full RFx (4 of 5 vendors) | < 5 USD | $0.82 | met |

## Not covered yet

- The holdout has no revision 2 and no clarification reply; trap 05 is tuned only.
- V4 (phone photo) not built: its traps and the photo targets are not measured.
- Exposure accuracy against an independent solver (spec 19.4) not built.
- Analyst golden questions (spec 19.5) and the adversarial suite (spec 19.6) not built.
