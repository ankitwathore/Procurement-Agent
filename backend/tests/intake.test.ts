import { beforeAll, describe, expect, it } from "vitest";
import { buildV1Workbook } from "../src/generator/v1.js";
import { V2_FILES, buildV2Certificate, buildV2Quote, buildV2TestReport } from "../src/generator/v2.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { intake, sniff, type IncomingFile } from "../src/ingest/intake.js";

let v1: Buffer;
let v2: Buffer;
let cert: Buffer;
let report: Buffer;
let v5: Buffer;

beforeAll(async () => {
  v1 = (await buildV1Workbook(42, 1)).buffer;
  v2 = (await buildV2Quote(42)).buffer;
  cert = await buildV2Certificate();
  report = await buildV2TestReport();
  v5 = Buffer.from(buildV5Eml());
});

const file = (vendor_id: string, filename: string, content: Buffer): IncomingFile => ({ vendor_id, filename, content });

describe("sniff: kind by bytes", () => {
  it("recognises every generated vendor file", () => {
    expect(sniff(v1)).toBe("zip");
    expect(sniff(v2)).toBe("pdf");
    expect(sniff(v5)).toBe("email");
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("png");
    expect(sniff(Buffer.from("MZ\x90\x00 an executable"))).toBe("unknown");
  });
});

describe("intake", () => {
  it("trap 36: V2's quotation sent twice under two names is one artifact plus a linked duplicate", () => {
    const out = intake([
      file("V2", V2_FILES.quote, v2),
      file("V2", V2_FILES.duplicate, v2),
      file("V2", V2_FILES.certificate, cert),
      file("V2", V2_FILES.testReport, report),
    ]);
    expect(out.map((a) => [a.filename, a.kind, a.status])).toEqual([
      [V2_FILES.quote, "pdf", "RECEIVED"],
      [V2_FILES.duplicate, "pdf", "DUPLICATE"],
      [V2_FILES.certificate, "pdf", "RECEIVED"],
      [V2_FILES.testReport, "pdf", "RECEIVED"],
    ]);
    expect(out[1]!.duplicate_of).toBe(out[0]!.artifact_id);
    expect(out[1]!.notes).toEqual([`same file as ${V2_FILES.quote}; not processed again`]);
    expect(new Set(out.map((a) => a.artifact_id)).size).toBe(4);
  });

  it("catches a file re-sent in a later message (V05)", () => {
    const first = intake([file("V2", V2_FILES.quote, v2)]);
    const later = intake([file("V2", "resend.pdf", v2)], first);
    expect(later[0]).toMatchObject({ status: "DUPLICATE", duplicate_of: first[0]!.artifact_id });
  });

  it("the same bytes from a different vendor are not a duplicate of that vendor's file", () => {
    const out = intake([file("V2", "a.pdf", v2), file("V3", "a.pdf", v2)]);
    expect(out.map((a) => a.status)).toEqual(["RECEIVED", "RECEIVED"]);
  });

  it("classifies the Excel, the PDF and the email, and is deterministic", () => {
    const files = [file("V1", "rates.xlsx", v1), file("V2", "q.pdf", v2), file("V5", "reply.eml", v5)];
    const a = intake(files);
    expect(a.map((x) => x.kind)).toEqual(["xlsx", "pdf", "email"]);
    expect(intake(files)).toEqual(a);
    expect(a[0]!.artifact_id).toMatch(/^V1-[0-9a-f]{12}$/);
  });

  it("refuses a file whose bytes do not match its name, rather than trusting the name", () => {
    const [a] = intake([file("V2", "quote.pdf", v1)]);
    expect(a).toMatchObject({ status: "FAILED", kind: "other", error: "content is zip but the file is named .pdf; not processed" });
  });

  it("reads a macro workbook as data and says so (SY08)", () => {
    const [a] = intake([file("V1", "rates.xlsm", v1)]);
    expect(a).toMatchObject({ status: "RECEIVED", kind: "xlsx", notes: ["macro-enabled workbook: read as data only, macros never run"] });
  });

  it("fails empty, oversized and unsupported files with a visible reason (F13)", () => {
    const out = intake(
      [file("V4", "empty.pdf", Buffer.alloc(0)), file("V4", "big.pdf", v2), file("V4", "setup.exe", Buffer.from("MZ\x90\x00"))],
      [],
      1000,
    );
    expect(out.map((a) => [a.status, a.error])).toEqual([
      ["FAILED", "empty file"],
      ["FAILED", `file is ${v2.length} bytes, over the 1000 byte limit`],
      ["FAILED", "unsupported file type"],
    ]);
  });
});
