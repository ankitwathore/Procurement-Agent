import { beforeAll, describe, expect, it } from "vitest";
import { RFX_LINES } from "../src/data/rfx.js";
import { V5_REPLY, buildV5Eml, rfc2822, v5GroundTruth } from "../src/generator/v5.js";
import { parseEmail, quotedStart, type ParsedEmail } from "../src/ingest/parse_email.js";
import { ParseError } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type Quote } from "../src/ingest/quotes.js";
import { assessVendor } from "../src/ingest/vendor.js";
import { localDate } from "../src/util/dates.js";
import { config } from "./fixtures/quotes.js";
import { span, v5Extraction } from "./fixtures/v5.js";

describe("V5 email generator", () => {
  it("is deterministic and carries the spec's reply verbatim", () => {
    expect(buildV5Eml()).toBe(buildV5Eml());
    expect(buildV5Eml()).toContain(`\r\n\r\n${V5_REPLY}\r\n`);
  });

  it("writes real RFC 2822 dates with the right weekday", () => {
    expect(rfc2822("2026-09-22", "11:42:00", "+0530")).toBe("Tue, 22 Sep 2026 11:42:00 +0530");
    expect(rfc2822("2026-10-08", "09:00:00", "+0530")).toBe("Thu, 8 Oct 2026 09:00:00 +0530");
  });
});

describe("parseEmail on the V5 reply", () => {
  let email: ParsedEmail;
  beforeAll(async () => {
    email = await parseEmail(buildV5Eml());
  });

  it("reads the headers", () => {
    expect(email.from).toEqual({ name: "Pankaj Shah", address: "pankaj@jaibharatboards.example" });
    expect(email.to).toEqual(["meera.k@kaverihome.example"]);
    expect(email.subject).toMatch(/^Re: RFx KHA-PKG-FY26-27/);
    expect(email.message_id).toBe("<v5-reply-20260922@jaibharatboards.example>");
    expect(email.in_reply_to).toBe("<rfx-kha-pkg-fy26-27@kaverihome.example>");
    expect(email.attachments).toEqual([]);
  });

  it("trap 37: splits the vendor's new message from our quoted RFx", () => {
    expect(email.new_text.trim()).toBe(V5_REPLY);
    expect(email.quoted_text.startsWith("On Mon, 14 Sep 2026 at 10:05")).toBe(true);
    expect(email.quoted_text).toContain("Rs 44.50/kg");
    expect(email.new_text).not.toContain("44.50");
  });

  it("dates the reply on the buyer's calendar", () => {
    expect(localDate(email.sent_at!, config.buyer_utc_offset)).toBe("2026-09-22");
  });
});

describe("quoted history markers", () => {
  it.each([
    ["Gmail or Apple Mail", "Rates attached.\n\nOn Tue, 22 Sep 2026, Meera wrote:\n> please quote", "Rates attached.\n\n"],
    ["Outlook", "Rates attached.\n-----Original Message-----\nFrom: Meera", "Rates attached.\n"],
    ["Outlook header block", "Rates attached.\n\nFrom: Meera\nSent: Monday\nSubject: RFx", "Rates attached.\n\n"],
    ["forwarded", "FYI\n---------- Forwarded message ---------\nFrom: x", "FYI\n"],
    ["bare quoting", "38 per kg\n> 44.50 last year", "38 per kg\n"],
    ["no history", "Rs 42/kg, freight extra", "Rs 42/kg, freight extra"],
  ])("%s", (_name, text, expectedNew) => {
    expect(text.slice(0, quotedStart(text))).toBe(expectedNew);
  });
});

describe("lateness on the buyer's calendar (spec V03)", () => {
  const due = { ...config }; // due 2026-09-23
  const ok = { validity: { value_text: "x", valid_until: "2026-10-30", snippet: "x", locator: { type: "email" } } };
  const lateOn = (header: string) => {
    const sent = new Date(header);
    return assessVendor(ok, localDate(sent, config.buyer_utc_offset), due).late;
  };

  it("23:30 on the 23rd in California is already the 24th in India: late", () => {
    expect(lateOn("Wed, 23 Sep 2026 23:30:00 -0700")).toBe(true);
  });

  it("00:30 on the 24th in India is late; 23:59 on the 23rd in India is not", () => {
    expect(lateOn("Thu, 24 Sep 2026 00:30:00 +0530")).toBe(true);
    expect(lateOn("Wed, 23 Sep 2026 23:59:00 +0530")).toBe(false);
  });
});

describe("parseEmail failures", () => {
  it("refuses an email with no body and no attachments", async () => {
    const empty = "From: a@b.example\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\n";
    await expect(parseEmail(empty)).rejects.toBeInstanceOf(ParseError);
  });

  it("refuses an oversized email", async () => {
    await expect(parseEmail(Buffer.alloc(25 * 1024 * 1024 + 1, "a"))).rejects.toThrow(/byte limit/);
  });
});

describe("V5's real email through the pipeline, scored against ground truth", () => {
  let email: ParsedEmail;
  let quotes: Quote[];
  const gt = v5GroundTruth() as {
    lines: Record<string, { expected_state: string; also_acceptable?: string[]; base_state: string; landed_unit_inr_point: number; landed_low: number; landed_high: number }>;
  };
  const build = (extraction = v5Extraction(email.text)) =>
    buildQuotes({
      vendorId: "V5",
      vendorCity: "Vapi",
      config,
      lines: RFX_LINES,
      extraction,
      sourceText: email.text,
      authoritativeEnd: email.new_text_end,
      textNative: true,
      receivedAt: localDate(email.sent_at!, config.buyer_utc_offset),
    });

  beforeAll(async () => {
    email = await parseEmail(buildV5Eml());
    quotes = build().quotes;
  });
  const q = (id: string) => quotes.find((x) => x.line_id === id)!;

  it("accepts every row and every line gets its expected state", () => {
    expect(build().rejected).toEqual([]);
    for (const l of RFX_LINES) {
      const g = gt.lines[l.line_id]!;
      expect([g.expected_state, ...(g.also_acceptable ?? [])], l.line_id).toContain(q(l.line_id).state);
      expect(q(l.line_id).components[0]!.state, l.line_id).toBe(gt.lines[l.line_id]!.base_state);
    }
  });

  it("landed point, low and high match the ground truth on every line", () => {
    for (const l of RFX_LINES) {
      const g = gt.lines[l.line_id]!;
      const landed = q(l.line_id).landed!;
      expect(landed.point, `${l.line_id} point`).toBeCloseTo(g.landed_unit_inr_point, 4);
      expect(landed.low, `${l.line_id} low`).toBeCloseTo(g.landed_low, 4);
      expect(landed.high, `${l.line_id} high`).toBeCloseTo(g.landed_high, 4);
    }
  });

  it("vendor: on time, no validity stated, nothing excluded", () => {
    const { vendor } = build();
    expect(vendor.late).toBe(false);
    expect(vendor.validity.status).toBe("not_stated");
    expect(vendor.excluded_by_default).toBe(false);
  });

  it("trap 37: a price read from our own quoted RFx is rejected, and the line stays on the vendor's statement", () => {
    const extraction = v5Extraction(email.text);
    const decoy = "Rs 44.50/kg";
    extraction.rows[0] = { ...extraction.rows[0]!, row_id: "decoy", rate: { ...extraction.rows[0]!.rate, value: 44.5 }, snippet: decoy, locator: span(email.text, decoy) };
    const r = build(extraction);
    expect(r.rejected).toEqual([{ row_id: "decoy", reason: "snippet is in quoted history, not the vendor's new message" }]);
    expect(r.quotes.find((x) => x.line_id === "L23")!.components[0]!.basis).toBe("baseline_same_as_last_year");
  });
});
