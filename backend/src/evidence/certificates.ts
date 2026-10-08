import type { Config } from "../config.js";
import { isIsoDate } from "../util/dates.js";

/**
 * Certificate checks and the ISO 9001 gate (spec 10.9, 17.4 Q01, E01, E03, E04, E06, E07).
 * The certificate fields come from extraction; the judgment is code: dates against today and the award date,
 * the entity against the vendor, the scope against the category.
 */

export interface CertificateFields {
  cert_type: string;
  number: string | null;
  issuer: string | null;
  entity_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  scope: string | null;
}

export type CertStatus = "valid" | "expired" | "expiring_before_award" | "not_yet_valid" | "undated";
export type CertFlag = "expired_certificate" | "expiring_certificate" | "entity_mismatch" | "scope_mismatch" | "undated_certificate" | "wrong_standard";

export interface CertificateCheck {
  status: CertStatus;
  entity_matches: boolean | null;
  /** Whether the certificate is for ISO 9001; null when its standard could not be read. */
  standard_matches: boolean | null;
  scope_covers: boolean | null;
  flags: CertFlag[];
  details: string[];
}

type DateConfig = Pick<Config, "as_of_date" | "expected_award_date">;

/** Words that do not identify a company. */
const NOISE = new Set(["pvt", "private", "ltd", "limited", "llp", "co", "company", "the", "and", "m", "s"]);

const tokens = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !NOISE.has(t));

/** True when every identifying word of the vendor's name appears in the certificate's entity. */
export function entityMatches(vendorName: string, entity: string): boolean {
  const have = new Set(tokens(entity));
  const need = tokens(vendorName);
  return need.length > 0 && need.every((t) => have.has(t));
}

export function checkCertificate(cert: CertificateFields, vendorName: string, cfg: DateConfig): CertificateCheck {
  const flags: CertFlag[] = [];
  const details: string[] = [];

  let status: CertStatus;
  const to = cert.valid_to && isIsoDate(cert.valid_to) ? cert.valid_to : null;
  const from = cert.valid_from && isIsoDate(cert.valid_from) ? cert.valid_from : null;
  if (!to) {
    status = "undated";
    flags.push("undated_certificate");
    details.push("The certificate's expiry date could not be read.");
  } else if (to < cfg.as_of_date) {
    status = "expired";
    flags.push("expired_certificate");
    details.push(`Expired on ${to}, before today (${cfg.as_of_date}).`);
  } else if (from && from > cfg.as_of_date) {
    status = "not_yet_valid";
    details.push(`Not valid until ${from}.`);
  } else if (to < cfg.expected_award_date) {
    status = "expiring_before_award";
    flags.push("expiring_certificate");
    details.push(`Valid until ${to}, before the expected award date (${cfg.expected_award_date}).`);
  } else {
    status = "valid";
  }

  const entity_matches = cert.entity_name ? entityMatches(vendorName, cert.entity_name) : null;
  if (entity_matches === false) {
    flags.push("entity_mismatch");
    details.push(`Issued to "${cert.entity_name}", which does not match the vendor "${vendorName}".`);
  }

  // Q01 asks for ISO 9001; a certificate for another standard (ISO 14001, FSC) does not answer it.
  const standard_matches = cert.cert_type.trim() ? /\b9001\b/.test(cert.cert_type) : null;
  if (standard_matches === false) {
    flags.push("wrong_standard");
    details.push(`The certificate is for ${cert.cert_type}, not ISO 9001.`);
  }

  const scope_covers = cert.scope ? /corrugat/i.test(cert.scope) : null;
  if (scope_covers === false) {
    flags.push("scope_mismatch");
    details.push(`Scope "${cert.scope}" does not cover corrugated packaging.`);
  }

  return { status, entity_matches, standard_matches, scope_covers, flags, details };
}

export type AnswerKind = "yes" | "no" | "hedged" | "unanswered";

// A yes that comes with a condition is not a yes (spec E06).
// A split answer ("advance for imported items, net 30 for others") is a condition too.
const HEDGES =
  /\b(subject to|with (the )?exceptions?|except|excluding|provided (that)?|conditional|depending|depends|only|if|unless|upon|as long as|on condition|against|interest|penalty|penalties|surcharge|late (payment )?(fee|charge)s?|but|however|partly|partially|in principle|in some cases|(for|on) (others|the rest|some items))\b/i;

/** Reads a yes/no questionnaire answer as written. Anything with a condition attached is hedged, kept verbatim. */
export function classifyAnswer(raw: string | null | undefined): AnswerKind {
  const s = (raw ?? "").trim();
  if (s === "") return "unanswered";
  if (HEDGES.test(s)) return "hedged";
  if (/^(yes|y|yeah|confirmed|agreed|accepted)\b/i.test(s)) return "yes";
  if (/^(no|n|not|none|nil|na|n\/a)\b/i.test(s)) return "no";
  return "hedged";
}

export type GateResult = "PASS" | "FAIL" | "UNKNOWN";

export interface GateDecision {
  result: GateResult;
  reason: string;
}

/**
 * Q01 pass rule (spec 17.4): yes, a certificate file attached, entity matches, valid on today and on the award date.
 * Scope outside corrugated packaging is reported but does not fail the gate (spec E07 is a warning).
 */
export function evaluateIsoGate(
  answer: string | null | undefined,
  cert: CertificateFields | null,
  vendorName: string,
  cfg: DateConfig,
): GateDecision & { certificate: CertificateCheck | null } {
  const kind = classifyAnswer(answer);
  if (kind === "unanswered") return { result: "UNKNOWN", reason: "Not answered.", certificate: null };
  if (kind === "hedged") return { result: "UNKNOWN", reason: `Answer is conditional and cannot be scored: "${answer}".`, certificate: null };
  if (kind === "no") return { result: "FAIL", reason: `Answered no: "${answer}".`, certificate: null };
  if (!cert) return { result: "FAIL", reason: "Answered yes, but no certificate was attached (claim without evidence).", certificate: null };

  const check = checkCertificate(cert, vendorName, cfg);
  if (check.standard_matches === false) return { result: "FAIL", reason: check.details.find((d) => d.includes("not ISO 9001")) as string, certificate: check };
  if (check.standard_matches === null) return { result: "UNKNOWN", reason: "The certificate's standard could not be read.", certificate: check };
  if (check.status !== "valid") return { result: "FAIL", reason: check.details.join(" "), certificate: check };
  if (check.entity_matches === false) return { result: "FAIL", reason: check.details.join(" "), certificate: check };
  if (check.entity_matches === null) return { result: "UNKNOWN", reason: "The certificate's holder could not be read.", certificate: check };
  return { result: "PASS", reason: check.details.length ? `Valid. ${check.details.join(" ")}` : "Valid certificate for this vendor.", certificate: check };
}
