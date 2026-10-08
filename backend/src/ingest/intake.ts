import { createHash } from "node:crypto";

/**
 * Intake (spec 10.1, F13, V05, SY05, SY08). Every incoming file becomes an artifact with a hash and a kind
 * decided by its bytes, not its name. A file this vendor already sent is linked as a duplicate and not processed
 * again. Anything unreadable or unsupported is FAILED with a reason the buyer sees, never silently dropped.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type ArtifactKind = "xlsx" | "docx" | "pdf" | "image" | "email" | "other";
export type ArtifactStatus = "RECEIVED" | "DUPLICATE" | "FAILED";

export interface IncomingFile {
  vendor_id: string;
  filename: string;
  content: Buffer;
}

export interface Artifact {
  artifact_id: string;
  vendor_id: string;
  filename: string;
  sha256: string;
  size: number;
  kind: ArtifactKind;
  status: ArtifactStatus;
  /** For a duplicate, the artifact it repeats. */
  duplicate_of: string | null;
  error: string | null;
  notes: string[];
}

const ext = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

const startsWith = (b: Buffer, bytes: number[]): boolean => bytes.every((x, i) => b[i] === x);

/** What the bytes are, independent of the file name. */
export function sniff(content: Buffer): "zip" | "pdf" | "jpeg" | "png" | "email" | "unknown" {
  if (startsWith(content, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (startsWith(content, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47])) return "png";
  // An email starts with header lines such as "From:", "Received:" or "Return-Path:".
  if (/^(From|To|Subject|Date|Received|Return-Path|Message-ID|MIME-Version|Delivered-To):/i.test(content.subarray(0, 200).toString("utf8"))) return "email";
  return "unknown";
}

const EXT_FOR: Record<string, string[]> = {
  zip: ["xlsx", "xlsm", "docx"],
  pdf: ["pdf"],
  jpeg: ["jpg", "jpeg"],
  png: ["png"],
  email: ["eml"],
};

function classify(f: IncomingFile): { kind: ArtifactKind; error: string | null; notes: string[] } {
  const notes: string[] = [];
  const e = ext(f.filename);
  const magic = sniff(f.content);
  if (magic === "unknown") return { kind: "other", error: "unsupported file type", notes };
  if (!(EXT_FOR[magic] ?? []).includes(e)) {
    return { kind: "other", error: `content is ${magic} but the file is named .${e || "(none)"}; not processed`, notes };
  }
  if (magic === "zip") {
    if (e === "xlsm") notes.push("macro-enabled workbook: read as data only, macros never run");
    return { kind: e === "docx" ? "docx" : "xlsx", error: null, notes };
  }
  if (magic === "pdf") return { kind: "pdf", error: null, notes };
  if (magic === "email") return { kind: "email", error: null, notes };
  return { kind: "image", error: null, notes };
}

/**
 * Registers files in arrival order. `existing` is everything received before (earlier messages), so a file
 * re-sent in a later message is still caught. Deterministic: ids come from the vendor and the hash.
 */
export function intake(files: readonly IncomingFile[], existing: readonly Artifact[] = [], maxBytes = MAX_FILE_BYTES): Artifact[] {
  const seen = [...existing];
  const out: Artifact[] = [];
  for (const f of files) {
    const sha256 = createHash("sha256").update(f.content).digest("hex");
    const base = `${f.vendor_id}-${sha256.slice(0, 12)}`;
    const sameId = seen.filter((a) => a.artifact_id === base || a.artifact_id.startsWith(`${base}-`)).length;
    const artifact_id = sameId === 0 ? base : `${base}-${sameId + 1}`;
    const common = { artifact_id, vendor_id: f.vendor_id, filename: f.filename, sha256, size: f.content.length };

    let a: Artifact;
    if (f.content.length === 0) {
      a = { ...common, kind: "other", status: "FAILED", duplicate_of: null, error: "empty file", notes: [] };
    } else if (f.content.length > maxBytes) {
      a = { ...common, kind: "other", status: "FAILED", duplicate_of: null, error: `file is ${f.content.length} bytes, over the ${maxBytes} byte limit`, notes: [] };
    } else {
      const original = seen.find((x) => x.vendor_id === f.vendor_id && x.sha256 === sha256 && x.status !== "DUPLICATE");
      const { kind, error, notes } = classify(f);
      if (original) {
        a = { ...common, kind, status: "DUPLICATE", duplicate_of: original.artifact_id, error: null, notes: [`same file as ${original.filename}; not processed again`] };
      } else {
        a = { ...common, kind, status: error ? "FAILED" : "RECEIVED", duplicate_of: null, error, notes };
      }
    }
    seen.push(a);
    out.push(a);
  }
  return out;
}
