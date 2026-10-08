# Generated dataset

Everything under `data/` except this file is produced by `npm run gen-data` (seed 42; `-- --seed 7` for a variant). Output is deterministic: the same seed gives byte-identical files. Zip timestamps and PDF dates are fixed for that reason.

`ground_truth.json` and `docs_manifest.json` are read only by the eval harness, never by the app.

## Files

| File | Contents | Traps |
|---|---|---|
| `rfx.json` | RFx header, 30 lines, 12-question questionnaire | none |
| `ground_truth.json` | Intended rates, locators, expected states and flags, landed cost, gates, trap register | all generated so far |
| `docs_manifest.json` | Every evidence file and its true attributes | 09, 36 |
| `vendors/V1/Shree_Ganesh_Rate_Offer_FY26-27.xlsx` | V1 Excel offer, revision 1 | 01, 02, 03, 04, 35 |
| `vendors/V1/Shree_Ganesh_Rate_Offer_FY26-27_REVISED.xlsx` | V1 revision 2, dropped live in the demo | 05 |
| `vendors/V2/APW_Quotation_0912.pdf` | V2 4-page letterhead quotation | 06, 07, 08, 10, 11, 12, 13, 34 |
| `vendors/V2/Quotation_Kaveri_Packaging.pdf` | The same quotation, sent again under another name | 36 |
| `vendors/V2/ISO9001_Certificate_APW.pdf` | ISO 9001 certificate, expired 31-08-2026 | 09 |
| `vendors/V2/Test_Report_APW_2026.pdf` | BF and GSM test report (3, 5, 7 ply) | none |
| `vendors/V3/SFP_Quotation_Kaveri_FY26-27.docx` | V3 Word quotation: cartons in sentences, tables, terms, questionnaire table | 14, 15, 17, 18, 19 |
| `vendors/V3/SFP_ISO9001.pdf` | V3 ISO 9001 certificate, valid to 30-06-2027 | none |
| `vendors/V3/SFP_Board_Test_Report.pdf` | V3 test report: 5 ply BC BF 19.5 against a claimed BF 22 | 16 |
| `vendors/V5/Re_RFx_KHA-PKG-FY26-27.eml` | V5 one-line email reply with our RFx quoted below | 29, 30, 31, 32, 37 |
| `vendors/V5/Re_Clarification_KHA-PKG-FY26-27.eml` | V5's scripted answer to our clarification, our questions quoted below | reply loop (13.4) |
| `vendors/V1/SGC_ISO9001_Certificate.pdf` | V1 ISO 9001 certificate, valid to 14-03-2027 | none |
| `vendors/V1/SGC_Board_Test_Report.pdf` | V1 test report, one sample per grade offered, the lighter 120 GSM 5 ply included | 03 |

| `vendors/V4/Rates_Delhi_Carton_Works.eml` | V4 email: questionnaire in the body, received 24-09-2026 (a day late), two photos attached, no test report | 26, 27 |
| `vendors/V4/IMG_20260924_101533.jpg` | V4 rate card as a phone photo: skewed, rotated, glare, JPEG 70, bottom cropped | 20, 21 (L15 to L17 absent), 22 (L12, L22 unreadable), 23 (L04 65.90 struck, 68.50 by hand), 24 (L01, L03, L05 smaller), 25 (L27 per box), 28 |
| `vendors/V4/ISO_certificate_DCW.jpg` | V4 ISO 9001 certificate, photographed, valid to 10-01-2027 | none |
| `vendors/V4/photo_params.json` | The photo's parameters and where each row landed in it | |

The holdouts carry their own V4 (a WhatsApp-named photo on seed 7, a phone-camera name on seed 8) with every trap moved to other lines and other photo settings.

## Holdout set (`data/holdout/`, seed 7)

The same five vendor roles and classes of traps, in other layouts, wording and placements (spec 17.10). Never used to tune prompts. Its own `ground_truth.json` (with the trap register's placements) and `docs_manifest.json`.

| File | What it is | Traps, where they sit |
|---|---|---|
| `vendors/V1/SGC_Quotation_Kaveri_2026.xlsx` | One line per row, groups reversed under title rows, terms and questionnaire on their own sheets | 01; 02 hidden column "Last Qtr Rate"; 03 lighter board on L12, L14, L22, Q12 "Nil"; 04 L16 typed ten times over; 35 L28 "Not quoted", L19 blank |
| `vendors/V1/SGC_QMS_Certificate.pdf`, `SGC_Lab_Report_BF_GSM.pdf` | Valid certificate; report with a 3 ply 120 GSM sample | 03 |
| `vendors/V2/PW_Proforma_KHA_118.pdf` (and `Packwell_offer_Kaveri.pdf`, the same bytes) | 3 page proforma, other columns, rows by description | 06 GST note on page 2; 07 3 percent above Rs 20 lakh in the terms; 08; 10 L08 amount 8 percent low; 11 white text on page 1; 12 alternate for L17; 13 Q07 "against post-dated cheques only"; 34; 36 |
| `vendors/V2/APW_QMS_Cert.pdf`, `APW_BF_GSM_Report.pdf` | Certificate expired 30-09-2026; report | 09 |
| `vendors/V3/Southern_Flute_Offer_KHA.docx` | Eight cartons in four new sentence shapes, per 100 and per 1000 nos, US$ accessories | 14, 15, 17 (lapsed 30-09-2026), 18, 19 |
| `vendors/V3/SFP_ISO_9001_2015.pdf`, `SFP_Lab_Test_BF.pdf` | Valid certificate; report with 7 ply BF 22.8 against a claimed BF 24 | 16 (L15, L16, L17) |
| `vendors/V5/RE_ RFx KHA-PKG-FY26-27 quotation.eml` | Multi-line reply, our RFx below an Outlook "Original Message" line | 29, 30, 31, 32, 37 |

The holdout has no revision 2 (trap 05) and no clarification reply.

## Not generated yet

Wild card files.

## Notes

- V1, trap 02: the spec says a hidden column; because the sheet is transposed, previous quarter rates sit in the hidden row 10, "Rate Q2".
- V2: page 3 holds the terms, the discount footnote (7pt), the GST fine print (5pt) and a light grey 4.5pt footer addressed to AI systems.
- V2: the alternate 7 ply offer has the same size as L06; a correct extraction lists it under `extras`, not as an L06 quote.
- V3: the cartons are priced in sentences with three phrasings; the per 100 pcs lines include L18, a partition set, which the RFx says may be quoted per 100 pcs.
- V5: the quoted RFx carries last year's rates (Rs 44.50/kg, Rs 39.80/kg) as a decoy; only the top message is the vendor's offer.
