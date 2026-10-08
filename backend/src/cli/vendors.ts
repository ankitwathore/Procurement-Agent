import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { RFX_LINES } from "../data/rfx.js";
import type { Adjudication } from "../ingest/adjudicate.js";
import type { PassADocument } from "../ingest/extract_a.js";
import { ExtractionSchema, type Extraction } from "../ingest/extraction.js";
import { parseDocx } from "../ingest/parse_docx.js";
import { parseEmail } from "../ingest/parse_email.js";
import { parsePdf } from "../ingest/parse_pdf.js";
import { parseXlsx } from "../ingest/parse_xlsx.js";
import { buildQuotes, type BuildInput, type BuildResult, type Quote } from "../ingest/quotes.js";
import { localDate } from "../util/dates.js";

/** The generated demo vendors and how to load each one: shared by the CLIs. Two sets: tuned (seed 42), holdout (seed 7). */

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export type DataSet = "tuned" | "holdout" | "holdout2";
export const DATA_SETS: readonly DataSet[] = ["tuned", "holdout", "holdout2"];
/** `photo`: for an email whose quote is a photographed attachment, that attachment's file name. */
type VendorFiles = Record<string, { city: string; file: string; received: string; photo?: string }>;

export const VENDORS: VendorFiles = {
  V1: { city: "Pune", file: "V1/Shree_Ganesh_Rate_Offer_FY26-27.xlsx", received: "2026-09-21" },
  V2: { city: "Ahmedabad", file: "V2/APW_Quotation_0912.pdf", received: "2026-09-19" },
  V3: { city: "Hosur", file: "V3/SFP_Quotation_Kaveri_FY26-27.docx", received: "2026-09-18" },
  V4: { city: "Bahadurgarh", file: "V4/Rates_Delhi_Carton_Works.eml", received: "", photo: "IMG_20260924_101533.jpg" },
  V5: { city: "Vapi", file: "V5/Re_RFx_KHA-PKG-FY26-27.eml", received: "" },
};

/** The holdout set: same vendors and roles, other files. Never used to tune prompts (spec D26). */
export const HOLDOUT_VENDORS: VendorFiles = {
  V1: { city: "Pune", file: "V1/SGC_Quotation_Kaveri_2026.xlsx", received: "2026-09-21" },
  V2: { city: "Ahmedabad", file: "V2/PW_Proforma_KHA_118.pdf", received: "2026-09-19" },
  V3: { city: "Hosur", file: "V3/Southern_Flute_Offer_KHA.docx", received: "2026-09-20" },
  V4: { city: "Bahadurgarh", file: "V4/DCW rate card Kaveri.eml", received: "", photo: "WhatsApp Image 2026-09-25 at 09.12.44.jpeg" },
  V5: { city: "Vapi", file: "V5/RE_ RFx KHA-PKG-FY26-27 quotation.eml", received: "" },
};

/** The fresh holdout (seed 8), generated after the fixes that the first holdout prompted: unseen when first run. */
export const HOLDOUT2_VENDORS: VendorFiles = {
  V1: { city: "Pune", file: "V1/Shree_Ganesh_Price_List_KHA.xlsx", received: "2026-09-21" },
  V2: { city: "Ahmedabad", file: "V2/APW_Quote_Kaveri_Sep26.pdf", received: "2026-09-19" },
  V3: { city: "Hosur", file: "V3/SFP_Rates_Kaveri_Sep2026.docx", received: "2026-09-17" },
  V4: { city: "Bahadurgarh", file: "V4/Delhi Carton Works quotation.eml", received: "", photo: "20260924_194012.jpg" },
  V5: { city: "Vapi", file: "V5/Re RFx KHA-PKG-FY26-27 rates.eml", received: "" },
};

export const vendorsOf = (set: DataSet): VendorFiles => (set === "holdout" ? HOLDOUT_VENDORS : set === "holdout2" ? HOLDOUT2_VENDORS : VENDORS);
/** Where a set's generated files live: data/ for tuned, data/<set>/ otherwise. */
export const dataDir = (set: DataSet): string => (set === "tuned" ? join(ROOT, "data") : join(ROOT, "data", set));
/** Where a set's saved live runs live: data/runs/ for tuned, data/runs/<set>/ otherwise. */
export const runsDir = (set: DataSet): string => (set === "tuned" ? join(ROOT, "data", "runs") : join(ROOT, "data", "runs", set));

/** `--set holdout` on the command line; tuned otherwise. */
export function setFromArgs(): DataSet {
  const i = process.argv.indexOf("--set");
  const v = i >= 0 ? process.argv[i + 1] : "tuned";
  if (!DATA_SETS.includes(v as DataSet)) throw new Error(`--set must be one of ${DATA_SETS.join(", ")}, not ${v}`);
  return v as DataSet;
}

export interface LoadedVendor {
  doc: PassADocument;
  build: (extraction: Extraction, passB?: Extraction, adjudications?: readonly Adjudication[]) => BuildResult;
}

export async function loadVendor(vendorId: string, config: Config, set: DataSet = "tuned"): Promise<LoadedVendor> {
  const v = vendorsOf(set)[vendorId];
  if (!v) throw new Error(`unknown vendor ${vendorId}; use one of ${Object.keys(VENDORS).join(", ")}`);
  const bytes = readFileSync(join(dataDir(set), "vendors", v.file));
  const base: Pick<BuildInput, "vendorId" | "vendorCity" | "config" | "lines" | "textNative"> = { vendorId, vendorCity: v.city, config, lines: RFX_LINES, textNative: true };

  if (v.file.endsWith(".xlsx")) {
    const wb = await parseXlsx(bytes);
    return { doc: { vendor_id: vendorId, kind: "xlsx", text: wb.text }, build: (extraction, passB, adjudications) => buildQuotes({ ...base, extraction, passB, adjudications, sourceText: wb.text, workbook: wb, receivedAt: v.received }) };
  }
  if (v.file.endsWith(".pdf")) {
    const pdf = await parsePdf(bytes);
    return { doc: { vendor_id: vendorId, kind: "pdf", text: pdf.text }, build: (extraction, passB, adjudications) => buildQuotes({ ...base, extraction, passB, adjudications, sourceText: pdf.text, pdf, receivedAt: v.received }) };
  }
  if (v.file.endsWith(".docx")) {
    const docx = await parseDocx(bytes);
    return { doc: { vendor_id: vendorId, kind: "docx", text: docx.text }, build: (extraction, passB, adjudications) => buildQuotes({ ...base, extraction, passB, adjudications, sourceText: docx.text, docx, receivedAt: v.received }) };
  }
  const email = await parseEmail(bytes);
  const received = email.sent_at ? localDate(email.sent_at, config.buyer_utc_offset) : undefined;
  if (v.photo) {
    // The quote is a photographed rate card attached to the email; the email text carries the questionnaire.
    const att = email.attachments.find((a) => a.filename === v.photo);
    if (!att) throw new Error(`${vendorId}: attachment ${v.photo} not found in ${v.file}`);
    const images = [{ media_type: "image/jpeg" as const, data: att.content.toString("base64"), name: att.filename }];
    return {
      doc: { vendor_id: vendorId, kind: "image", text: email.text, authoritative_end: email.new_text_end, message_id: email.message_id, images },
      // Read from an image: no text layer to check against, so rule 8 caps a reading at HIGH_CONF.
      build: (extraction, passB, adjudications) => buildQuotes({ ...base, textNative: false, extraction, passB, adjudications, sourceText: email.text, authoritativeEnd: email.new_text_end, receivedAt: received }),
    };
  }
  return {
    doc: { vendor_id: vendorId, kind: "email", text: email.text, authoritative_end: email.new_text_end, message_id: email.message_id },
    build: (extraction, passB, adjudications) => buildQuotes({ ...base, extraction, passB, adjudications, sourceText: email.text, authoritativeEnd: email.new_text_end, receivedAt: received }),
  };
}

/** A vendor's quotes rebuilt from its latest saved live run (pass A, pass B, adjudications), and its stated terms. Free. */
export interface SavedRun {
  file: string;
  quotes: Quote[];
  vendorTerms: Extraction["vendor_terms"];
  built: BuildResult;
  extraction: Extraction;
  /** The saved run as written: traces, questionnaire, injection findings, adjudication. */
  saved: Record<string, any>;
  doc: PassADocument;
}

export async function latestRun(vendorId: string, config: Config, set: DataSet = "tuned"): Promise<SavedRun | null> {
  const dir = runsDir(set);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).filter((f) => f.startsWith(`${vendorId}-pass-a-`)).sort().at(-1);
  if (!file) return null;
  const saved = JSON.parse(readFileSync(join(dir, file), "utf8"));
  if (!saved.extraction) return null;
  const { build, doc } = await loadVendor(vendorId, config, set);
  const extraction = ExtractionSchema.parse(saved.extraction);
  const passB = saved.pass_b?.extraction ? ExtractionSchema.parse(saved.pass_b.extraction) : undefined;
  const built = build(extraction, passB, saved.adjudication?.adjudications as Adjudication[] | undefined);
  return { file, quotes: built.quotes, vendorTerms: extraction.vendor_terms, built, extraction, saved, doc };
}
