import type { CertificateFields } from "../../src/evidence/certificates.js";
import type { TestReportFields } from "../../src/evidence/gates.js";

/**
 * What a correct extraction would read off an evidence PDF's text. Test-only stand-ins for the model,
 * written against the generator's certificate and test report layout.
 */

export function readCertificate(text: string): CertificateFields {
  const ddmm = (s: string | undefined) => (s ? s.split("-").reverse().join("-") : null);
  const lines = text.split("\n");
  const after = (label: string) => lines.find((l) => l.startsWith(label))?.slice(label.length).trim() ?? null;
  const dates = /Valid from: (\d{2}-\d{2}-\d{4}) \| Valid until: (\d{2}-\d{2}-\d{4})/.exec(text);
  const entity = lines[lines.findIndex((l) => l.startsWith("This is to certify")) + 1] ?? null;
  return {
    cert_type: "ISO 9001:2015",
    number: after("Certificate No:"),
    issuer: after("Issued by:"),
    entity_name: entity,
    valid_from: ddmm(dates?.[1]),
    valid_to: ddmm(dates?.[2]),
    scope: after("Scope:"),
  };
}

export function readTestReport(text: string): TestReportFields {
  const head = /Test Report No: (\S+) \| Date: (\d{2})-(\d{2})-(\d{4})/.exec(text);
  const samples = [...text.matchAll(/^(\d) \| (\w+) \| (\d+) \| ([\d.]+)$/gm)].map((m) => ({
    ply: Number(m[1]),
    flute: m[2] as string,
    liner_gsm: Number(m[3]),
    bf: Number(m[4]),
  }));
  return { lab: text.split("\n")[1] ?? null, report_no: head?.[1] ?? null, report_date: head ? `${head[4]}-${head[3]}-${head[2]}` : null, samples };
}
