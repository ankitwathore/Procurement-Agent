import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RFX_LINES } from "../src/data/rfx.js";
import type { Extraction } from "../src/ingest/extraction.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { assessVendor, resolveValidUntil } from "../src/ingest/vendor.js";
import { addDays, datePart, isIsoDate } from "../src/util/dates.js";
import { V5_EMAIL, v5Extraction } from "./fixtures/v5.js";

const config = loadConfig(); // as_of 2026-10-08, award 2026-10-12, due 2026-09-23

type Terms = Extraction["vendor_terms"];
const validity = (v: Record<string, unknown>): Terms => ({
  validity: { value_text: "as written", snippet: "as written", locator: { type: "email" }, ...v },
});

describe("date helpers", () => {
  it("adds days across month and year ends, and into a leap day", () => {
    expect(addDays("2026-09-18", 15)).toBe("2026-10-03");
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-10-08", 0)).toBe("2026-10-08");
  });

  it("rejects impossible and malformed dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("24-09-2026")).toBe(false);
    expect(isIsoDate("2026-10-08")).toBe(true);
    expect(() => addDays("2026-02-30", 1)).toThrow();
  });

  it("takes the calendar date from a datetime as written", () => {
    expect(datePart("2026-09-24T09:30:00+05:30")).toBe("2026-09-24");
    expect(datePart("not a date")).toBeNull();
  });
});

describe("resolveValidUntil", () => {
  it("computes the expiry from a start date and days (the model never adds dates)", () => {
    expect(resolveValidUntil(validity({ from_date: "2026-09-18", valid_days: 15 }).validity)).toEqual({ date: "2026-10-03", source: "computed" });
  });

  it("an explicit date wins over a computed one", () => {
    const v = validity({ valid_until: "2026-10-30", from_date: "2026-09-18", valid_days: 15 }).validity;
    expect(resolveValidUntil(v)).toEqual({ date: "2026-10-30", source: "stated" });
  });

  it("returns null for anything it cannot resolve, never a guess", () => {
    expect(resolveValidUntil(undefined)).toBeNull();
    expect(resolveValidUntil(validity({}).validity)).toBeNull();
    expect(resolveValidUntil(validity({ valid_until: "next month" }).validity)).toBeNull();
    expect(resolveValidUntil(validity({ valid_days: 15 }).validity)).toBeNull(); // no start date
  });
});

describe("assessVendor: validity (spec T04)", () => {
  const assess = (terms: Terms, received?: string) => assessVendor(terms, received, config);

  it("trap 17: V3 valid 15 days from 2026-09-18 has lapsed, and is excluded by default", () => {
    const a = assess(validity({ from_date: "2026-09-18", valid_days: 15 }));
    expect(a.validity).toMatchObject({ status: "lapsed", valid_until: "2026-10-03", source: "computed" });
    expect(a.excluded_by_default).toBe(true);
    expect(a.discrepancies).toEqual([expect.objectContaining({ kind: "validity_lapsed", severity: "high" })]);
  });

  it("trap 27: V4 valid until 2026-10-09 expires before the award on 2026-10-12", () => {
    const a = assess(validity({ from_date: "2026-09-24", valid_days: 15 }));
    expect(a.validity).toMatchObject({ status: "expiring", valid_until: "2026-10-09" });
    expect(a.excluded_by_default).toBe(false);
    expect(a.discrepancies[0]).toMatchObject({ kind: "validity_expiring", severity: "warn" });
  });

  it("trap 31: V5 states no validity", () => {
    const a = assess({});
    expect(a.validity).toMatchObject({ status: "not_stated", valid_until: null, source: null });
    expect(a.excluded_by_default).toBe(false);
    expect(a.discrepancies).toEqual([expect.objectContaining({ kind: "validity_not_stated" })]);
  });

  it("V1 and V2 are valid past the award date", () => {
    expect(assess(validity({ from_date: "2026-09-21", valid_days: 30 })).validity.status).toBe("ok"); // 2026-10-21
    expect(assess(validity({ from_date: "2026-09-19", valid_days: 30 })).validity.status).toBe("ok"); // 2026-10-19
  });

  it("boundaries are inclusive: valid until today, or until the award date, is still fine", () => {
    expect(assess(validity({ valid_until: "2026-10-08" })).validity.status).toBe("expiring"); // today, but before award
    expect(assess(validity({ valid_until: "2026-10-07" })).validity.status).toBe("lapsed");
    expect(assess(validity({ valid_until: "2026-10-12" })).validity.status).toBe("ok");
    expect(assess(validity({ valid_until: "2026-10-11" })).validity.status).toBe("expiring");
  });
});

describe("assessVendor: lateness (spec V03)", () => {
  const ok = validity({ valid_until: "2026-10-30" });

  it("trap 27: V4 received 2026-09-24, a day after the 2026-09-23 deadline", () => {
    const a = assessVendor(ok, "2026-09-24", config);
    expect(a.late).toBe(true);
    expect(a.discrepancies).toEqual([expect.objectContaining({ kind: "late_reply", severity: "warn" })]);
  });

  it("on the due date is not late, and a datetime uses its calendar date", () => {
    expect(assessVendor(ok, "2026-09-23", config).late).toBe(false);
    expect(assessVendor(ok, "2026-09-23T23:59:00+05:30", config).late).toBe(false);
    expect(assessVendor(ok, "2026-09-24T00:05:00+05:30", config).late).toBe(true);
  });

  it("judges nothing when no received date is given", () => {
    const a = assessVendor(ok, undefined, config);
    expect(a.late).toBe(false);
    expect(a.discrepancies).toEqual([]);
  });

  it("a late reply is flagged, never excluded", () => {
    expect(assessVendor(ok, "2026-09-24", config).excluded_by_default).toBe(false);
  });
});

describe("vendor assessment through buildQuotes", () => {
  it("V5: replied on time, but states no validity", () => {
    const { vendor } = buildQuotes({
      vendorId: "V5",
      vendorCity: "Vapi",
      config,
      lines: RFX_LINES,
      extraction: v5Extraction(),
      sourceText: V5_EMAIL,
      textNative: true,
      receivedAt: "2026-09-22",
    });
    expect(vendor.late).toBe(false);
    expect(vendor.discrepancies.map((d) => d.kind)).toEqual(["validity_not_stated"]);
  });

  it("combines lapsed validity and a late reply", () => {
    const extraction = v5Extraction();
    extraction.vendor_terms.validity = { value_text: "valid for 15 days", from_date: "2026-09-18", valid_days: 15, snippet: "freight extra", locator: { type: "email" } };
    const { vendor } = buildQuotes({
      vendorId: "V5",
      vendorCity: "Vapi",
      config,
      lines: RFX_LINES,
      extraction,
      sourceText: V5_EMAIL,
      textNative: true,
      receivedAt: "2026-09-25",
    });
    expect(vendor.discrepancies.map((d) => d.kind).sort()).toEqual(["late_reply", "validity_lapsed"]);
    expect(vendor.excluded_by_default).toBe(true);
  });
});
