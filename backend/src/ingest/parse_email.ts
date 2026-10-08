import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import { ParseError } from "./parse_xlsx.js";

/**
 * Email to a model-friendly representation (spec 10.2, F10, F11).
 * Only the vendor's new top message is authoritative. Quoted history (our own RFx, earlier replies) is kept for
 * context but marked, so a price that only appears in the quote can be rejected.
 */

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

export interface EmailAttachment {
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  content: Buffer;
}

export interface ParsedEmail {
  message_id: string | null;
  in_reply_to: string | null;
  from: { name: string; address: string } | null;
  to: string[];
  subject: string;
  /** When it was sent, as an instant. Convert to the buyer's calendar with `localDate` before judging lateness. */
  sent_at: Date | null;
  /** The full plain-text body. Email locators are character offsets into this. */
  text: string;
  /** Offsets [0, new_text_end) are the vendor's new message; everything after is quoted history. */
  new_text_end: number;
  new_text: string;
  quoted_text: string;
  attachments: EmailAttachment[];
}

// Markers that start quoted history, in the forms common mail clients write.
const QUOTE_MARKERS: RegExp[] = [
  /^On .+wrote:\s*$/m, // Gmail, Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im, // Outlook
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^From: .+\r?\n(?:Sent|Date): .+$/m, // Outlook header block
  /^>/m, // bare quoting
];

/** Index where quoted history begins, or the text length when there is none. */
export function quotedStart(text: string): number {
  let start = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < start) start = m.index;
  }
  return start;
}

export async function parseEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (size > MAX_EMAIL_BYTES) throw new ParseError(`email is ${size} bytes, over the ${MAX_EMAIL_BYTES} byte limit`);

  let mail;
  try {
    mail = await simpleParser(raw);
  } catch (err) {
    throw new ParseError(`email could not be read: ${(err as Error).message}`);
  }

  const text = (mail.text ?? "").replace(/\r\n/g, "\n");
  const attachments: EmailAttachment[] = (mail.attachments ?? []).map((a) => ({
    filename: a.filename ?? "unnamed",
    content_type: a.contentType,
    size: a.size,
    sha256: createHash("sha256").update(a.content).digest("hex"),
    content: a.content,
  }));
  if (text.trim() === "" && attachments.length === 0) throw new ParseError("email has no readable body and no attachments");

  const end = quotedStart(text);
  const from = mail.from?.value[0];
  const toList = mail.to ? (Array.isArray(mail.to) ? mail.to : [mail.to]) : [];

  return {
    message_id: mail.messageId ?? null,
    in_reply_to: mail.inReplyTo ?? null,
    from: from?.address ? { name: from.name ?? "", address: from.address } : null,
    to: toList.flatMap((t) => t.value.map((v) => v.address ?? "")).filter(Boolean),
    subject: mail.subject ?? "",
    sent_at: mail.date ?? null,
    text,
    new_text_end: end,
    new_text: text.slice(0, end),
    quoted_text: text.slice(end),
    attachments,
  };
}
