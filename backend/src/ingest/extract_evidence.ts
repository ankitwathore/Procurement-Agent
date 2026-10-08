import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { CertificateFields } from "../evidence/certificates.js";
import type { TestReportFields } from "../evidence/gates.js";
import type { JsonResponse, LlmClient } from "../llm/client.js";
import { isIsoDate } from "../util/dates.js";
import type { PassATrace } from "./extract_a.js";
import { num, text } from "./extract_a.js";
import { screenInjection, type InjectionFinding } from "./injection.js";
import { normalizePdfText } from "./parse_pdf.js";

/**
 * Evidence documents (spec 10.9, 17.7): one small structured-output call reads an ISO certificate or a board test
 * report. The model reports values as written; code parses dates and numbers and checks each against the document.
 * What the gates rest on (a certificate's entity and dates, a report's date and every sample) must verify, or the
 * document counts as unread: its gate is then UNKNOWN, never a guess. Fields nothing depends on are dropped if they
 * do not verify.
 */

const PROMPT_FILE = fileURLToPath(new URL("../../../prompts/extract_evidence.md", import.meta.url));

export function loadEvidencePrompt(): { text: string; version: string } {
  const t = readFileSync(PROMPT_FILE, "utf8");
  return { text: t, version: `extract_evidence@${createHash("sha256").update(t).digest("hex").slice(0, 8)}` };
}

const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const EVIDENCE_SCHEMA = obj({
  doc_role: { type: "string", enum: ["certificate", "test_report", "other"] },
  certificate: obj({ cert_type: str, number: str, issuer: str, entity_name: str, scope: str, valid_from: str, valid_to: str, validity_snippet: str }),
  test_report: obj({
    lab: str,
    report_no: str,
    report_date: str,
    header_snippet: str,
    samples: { type: "array", items: obj({ ply: str, flute: str, liner_gsm: str, bf: str, row_text: str }) },
  }),
  notes: { type: "array", items: str },
});

/** Stable, document-independent context, first in the prompt. */
export const EVIDENCE_CONTEXT =
  "<context>Evidence attached by vendors to quotations for corrugated packaging (RFx KHA-PKG-FY26-27, Kaveri Home Appliances). The buyer checks ISO 9001 certificates and board test reports (ply, flute, liner GSM, bursting factor) against its gates.</context>";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date as written, to ISO. Numeric dates are read day first (the Indian convention: "14-03-2027"), unless the
 * year comes first. Month names in either order ("14 March 2027", "March 14, 2027"). Anything else is null.
 */
export function parseWrittenDate(raw: string): string | null {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  const iso = (y: number, m: number, d: number) => {
    const v = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return isIsoDate(v) ? v : null;
  };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s-]+([a-z]+)\.?,?[\s-]+(\d{4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return mo < 0 ? null : iso(Number(m[3]), mo + 1, Number(m[1]));
  }
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    return mo < 0 ? null : iso(Number(m[3]), mo + 1, Number(m[2]));
  }
  return null;
}

type Raw = Record<string, unknown>;

export interface EvidenceReading {
  doc_role: "certificate" | "test_report" | "other";
  /** Null when not a certificate, or when what the gate needs did not verify. */
  certificate: CertificateFields | null;
  test_report: TestReportFields | null;
  /** Why something was dropped or the document counts as unread. */
  problems: string[];
}

/**
 * Checks the model's reading against the document text. Pure: the unit tests feed it hand-written readings.
 * A photographed document has no text layer (`docText` null): values cannot be found in it, so they are taken as
 * read, still parsed strictly, and the reading says so.
 */
export function verifyEvidence(json: Raw, docText: string | null): EvidenceReading {
  const hay = docText === null ? null : normalizePdfText(docText).toLowerCase();
  const inDoc = (s: string | null) => s !== null && (hay === null || hay.includes(normalizePdfText(s).toLowerCase()));
  const problems: string[] = docText === null ? ["read from a photo: no text layer to check the values against"] : [];
  const role = json.doc_role as EvidenceReading["doc_role"];
  const out: EvidenceReading = { doc_role: role, certificate: null, test_report: null, problems };
  /** A field nothing depends on: kept only when it is in the document. */
  const optional = (label: string, v: unknown) => {
    const t = text(v);
    if (t !== null && !inDoc(t)) {
      problems.push(`${label} "${t}" is not in the document; dropped`);
      return null;
    }
    return t;
  };

  if (role === "certificate") {
    const c = json.certificate as Raw;
    const entity = text(c.entity_name);
    const standard = text(c.cert_type);
    const from = text(c.valid_from);
    const to = text(c.valid_to);
    const fail: string[] = [];
    if (!entity || !inDoc(entity)) fail.push(`entity "${entity ?? ""}" is not in the document`);
    if (!standard || !inDoc(standard)) fail.push(`standard "${standard ?? ""}" is not in the document`);
    for (const [label, d] of [["valid from", from], ["valid to", to]] as const) {
      if (!d) fail.push(`${label} date not stated`);
      else if (!inDoc(d)) fail.push(`${label} date "${d}" is not in the document`);
      else if (!parseWrittenDate(d)) fail.push(`${label} date "${d}" could not be read as a date`);
    }
    if (fail.length > 0) {
      problems.push(...fail, "certificate counts as unread");
      return out;
    }
    out.certificate = {
      cert_type: standard as string,
      number: optional("certificate number", c.number),
      issuer: optional("issuer", c.issuer),
      entity_name: entity,
      valid_from: parseWrittenDate(from as string),
      valid_to: parseWrittenDate(to as string),
      scope: optional("scope", c.scope),
    };
  }

  if (role === "test_report") {
    const t = json.test_report as Raw;
    const date = text(t.report_date);
    const fail: string[] = [];
    if (!date || !inDoc(date) || !parseWrittenDate(date)) fail.push(`report date "${date ?? ""}" is not a date in the document`);
    const rows = (t.samples as Raw[]) ?? [];
    if (rows.length === 0) fail.push("no sample rows");
    const samples: TestReportFields["samples"] = [];
    rows.forEach((r, i) => {
      const row = text(r.row_text);
      if (!row || !inDoc(row)) {
        fail.push(`sample ${i + 1}: row "${row ?? ""}" is not in the document`);
        return;
      }
      // Every value must be written in its own row, so a sample cannot borrow another row's numbers.
      const tokens = normalizePdfText(row).toLowerCase().split(/[\s,;]+/);
      const value = (label: string, v: unknown, parse: (x: unknown) => number | null) => {
        const written = text(v);
        if (written === null) return null;
        if (!tokens.includes(written.toLowerCase())) {
          fail.push(`sample ${i + 1}: ${label} "${written}" is not in its row`);
          return null;
        }
        return parse(written);
      };
      const flute = text(r.flute);
      if (flute !== null && !tokens.includes(flute.toLowerCase())) fail.push(`sample ${i + 1}: flute "${flute}" is not in its row`);
      samples.push({ ply: value("ply", r.ply, num), flute, liner_gsm: value("liner GSM", r.liner_gsm, num), bf: value("BF", r.bf, num) });
    });
    if (fail.length > 0) {
      problems.push(...fail, "test report counts as unread");
      return out;
    }
    out.test_report = { lab: optional("lab", t.lab), report_no: optional("report number", t.report_no), report_date: parseWrittenDate(date as string), samples };
  }
  return out;
}

export interface EvidenceTrace extends Omit<PassATrace, "step"> {
  step: "extract_evidence";
  file: string;
}

export interface EvidenceResult {
  reading: EvidenceReading | null;
  notes: string[];
  injection: InjectionFinding[];
  errors: string[];
  trace: EvidenceTrace;
}

export interface EvidenceOptions {
  client: LlmClient;
  config: Config;
  vendorId: string;
  file: string;
  now?: () => Date;
}

/** One call per evidence document. A failed call leaves the document unread; it is never treated as empty. */
export async function runEvidencePass(docText: string, opts: EvidenceOptions & { image?: { media_type: "image/jpeg" | "image/png"; data: string } }): Promise<EvidenceResult> {
  const prompt = loadEvidencePrompt();
  const screen = screenInjection(docText);
  const model = opts.config.models.extract_a;
  const trace = (res: JsonResponse | null, ms: number): EvidenceTrace => ({
    step: "extract_evidence",
    file: opts.file,
    vendor_id: opts.vendorId,
    prompt_version: prompt.version,
    model_requested: model,
    model_used: res?.model ?? null,
    fallback_used: res?.fallback_used ?? false,
    stop_reason: res?.stop_reason ?? null,
    usage: res?.usage ?? null,
    cost_usd: res?.cost_usd ?? null,
    ms,
    at: (opts.now ?? (() => new Date()))().toISOString(),
  });
  const empty = { reading: null, notes: [], injection: screen.findings };

  let res: JsonResponse;
  try {
    res = await opts.client.json({
      model,
      context: EVIDENCE_CONTEXT,
      instructions: prompt.text,
      ...(opts.image ? { images: [opts.image] } : {}),
      user: opts.image
        ? `Read this evidence document from vendor ${opts.vendorId} (${opts.file}): it is the attached photo.`
        : [`Read this evidence document from vendor ${opts.vendorId} (${opts.file}).`, "<vendor_document kind=\"pdf\">", screen.clean_text, "</vendor_document>"].join("\n"),
      schema: EVIDENCE_SCHEMA,
      effort: "low",
      max_tokens: 4000,
    });
  } catch (err) {
    return { ...empty, errors: [`call failed: ${(err as Error).message}`], trace: trace(null, 0) };
  }
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens" || res.text === null) {
    return { ...empty, errors: [res.stop_reason === "refusal" ? "the model declined this document" : res.stop_reason === "max_tokens" ? "output was cut off at max_tokens" : "no output"], trace: trace(res, res.ms) };
  }
  try {
    const json = JSON.parse(res.text) as Raw;
    // Verified against the screened text the model saw, so a value from a stripped instruction cannot pass.
    return { reading: verifyEvidence(json, opts.image ? null : screen.clean_text), notes: (json.notes as string[]) ?? [], injection: screen.findings, errors: [], trace: trace(res, res.ms) };
  } catch (err) {
    return { ...empty, errors: [(err as Error).message], trace: trace(res, res.ms) };
  }
}
