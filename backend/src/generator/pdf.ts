import PDFDocument from "pdfkit";

/**
 * Shared PDF helpers for the generator: deterministic documents (fixed dates, no compression) and the two
 * evidence documents every vendor may attach, an ISO 9001 certificate and a board test report (spec 17.7).
 */

export function newPdf(title: string, author: string, date: Date, creator = author): PDFKit.PDFDocument {
  return new PDFDocument({
    size: "A4",
    margin: 40,
    compress: false,
    info: { Title: title, Author: author, Creator: creator, Producer: creator, CreationDate: date, ModDate: date },
  });
}

export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("-");

export interface CertificateSpec {
  cert_type: string;
  number: string;
  issuer: string;
  entity: string;
  scope: string;
  valid_from: string;
  valid_to: string;
}

export interface TestReportSpec {
  lab: string;
  report_no: string;
  report_date: string;
  samples: { ply: number; flute: string; liner_gsm: number; bf: number }[];
}

/** Doc properties name the vendor that sent the file, not the issuer, as a scanned attachment would. */
export function buildCertificatePdf(c: CertificateSpec, author: string, date: Date, creator = author): Promise<Buffer> {
  const doc = newPdf(`${c.cert_type.split(":")[0]} Certificate`, author, date, creator);
  doc.font("Helvetica-Bold").fontSize(18).text("CERTIFICATE OF REGISTRATION", 40, 120, { width: 515, align: "center" });
  doc.font("Helvetica").fontSize(11);
  const lines = [
    `This is to certify that the quality management system of`,
    c.entity,
    `has been assessed and found to conform to ${c.cert_type}`,
    `Scope: ${c.scope}`,
    `Certificate No: ${c.number}`,
    `Valid from: ${ddmmyyyy(c.valid_from)}    Valid until: ${ddmmyyyy(c.valid_to)}`,
    `Issued by: ${c.issuer}`,
  ];
  lines.forEach((t, i) => doc.text(t, 40, 190 + i * 26, { width: 515, align: "center", lineBreak: false }));
  return pdfToBuffer(doc);
}

export function buildTestReportPdf(t: TestReportSpec, customer: string, author: string, date: Date, creator = author): Promise<Buffer> {
  const doc = newPdf("Test Report", author, date, creator);
  doc.font("Helvetica-Bold").fontSize(14).text(t.lab, 40, 60);
  doc.font("Helvetica").fontSize(10)
    .text(`Test Report No: ${t.report_no}    Date: ${ddmmyyyy(t.report_date)}`, 40, 84)
    .text(`Customer: ${customer}`, 40, 100)
    .text("Test: Bursting factor (IS 1060) and grammage of corrugated board samples", 40, 116);
  doc.font("Helvetica-Bold").text("Ply", 40, 150).text("Flute", 100, 150).text("Liner GSM", 170, 150).text("BF", 260, 150);
  doc.font("Helvetica");
  t.samples.forEach((s, i) => {
    const y = 168 + i * 16;
    doc.text(String(s.ply), 40, y).text(s.flute, 100, y).text(String(s.liner_gsm), 170, y).text(s.bf.toFixed(1), 260, y);
  });
  doc.text("Result: Samples tested as received. Results relate only to the samples tested.", 40, 240);
  return pdfToBuffer(doc);
}
