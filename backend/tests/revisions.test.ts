import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, allocate } from "../src/award/optimizer.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { buildV1Workbook } from "../src/generator/v1.js";
import { buildV2Quote } from "../src/generator/v2.js";
import { buildV5Eml } from "../src/generator/v5.js";
import { parseEmail } from "../src/ingest/parse_email.js";
import { parsePdf } from "../src/ingest/parse_pdf.js";
import { parseXlsx, type ParsedWorkbook } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type BuildResult } from "../src/ingest/quotes.js";
import { diffSubmissions, looksLikeRevision, staleAward, supersede, type Submission } from "../src/ingest/revisions.js";
import { config, q, vendor } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";

const line = (id: string) => RFX_LINES.find((l) => l.line_id === id)!;

let wb1: ParsedWorkbook;
let wb2: ParsedWorkbook;
let r1: BuildResult;
let r2: BuildResult;

const build = (wb: ParsedWorkbook) =>
  buildQuotes({ vendorId: "V1", vendorCity: "Pune", config, lines: RFX_LINES, extraction: v1Extraction(wb), sourceText: wb.text, workbook: wb, textNative: true });

beforeAll(async () => {
  wb1 = await parseXlsx((await buildV1Workbook(42, 1)).buffer);
  wb2 = await parseXlsx((await buildV1Workbook(42, 2)).buffer);
  r1 = build(wb1);
  r2 = build(wb2);
});

const sub = (id: string, quotes: BuildResult["quotes"], at: string) => ({ submission_id: id, vendor_id: "V1", received_at: at, quotes });

describe("looksLikeRevision (deterministic half of spec 10.8)", () => {
  it("V1 revision 2 says so; revision 1, V2 and V5 do not", async () => {
    expect(looksLikeRevision(wb2.text)).toBe(true);
    expect(looksLikeRevision(wb1.text)).toBe(false);
    expect(looksLikeRevision((await parsePdf((await buildV2Quote(42)).buffer)).text)).toBe(false);
    expect(looksLikeRevision((await parseEmail(buildV5Eml())).text)).toBe(false);
  });

  it.each(["Revised rates attached", "Please disregard our earlier quotation", "Rev 2 of our offer", "This supersedes the quote of 21 Sep", "Updated prices from 1 Oct"])(
    "%j is a revision",
    (t) => expect(looksLikeRevision(t)).toBe(true),
  );

  // "revised" alone is not enough: it must be followed by rates, prices, quotation or similar.
  it.each(["Rates are revised every quarter by the board", "Previous orders were delivered on time"])("%j is not", (t) => {
    expect(looksLikeRevision(t)).toBe(false);
  });
});

describe("supersede", () => {
  it("rev 2 supersedes rev 1, which is kept as history, not deleted", () => {
    const a = supersede([], sub("V1-s1", r1.quotes, "2026-09-21"));
    const b = supersede(a.history, sub("V1-s2", r2.quotes, "2026-10-08"));
    expect(b.current).toMatchObject({ submission_id: "V1-s2", revision: 2, is_current: true, supersedes: "V1-s1" });
    expect(b.superseded).toMatchObject({ submission_id: "V1-s1", is_current: false });
    expect(b.history.map((s) => [s.submission_id, s.revision, s.is_current])).toEqual([["V1-s1", 1, false], ["V1-s2", 2, true]]);
    expect(a.history[0]!.is_current).toBe(true); // the earlier history object is unchanged
  });

  it("a first submission supersedes nothing, and other vendors are untouched", () => {
    const other: Submission = { submission_id: "V2-s1", vendor_id: "V2", revision: 1, received_at: "x", is_current: true, supersedes: null, quotes: [] };
    const r = supersede([other], sub("V1-s1", r1.quotes, "2026-09-21"));
    expect(r.superseded).toBeNull();
    expect(r.current.revision).toBe(1);
    expect(r.history.find((s) => s.vendor_id === "V2")!.is_current).toBe(true);
  });
});

describe("diffSubmissions: trap 05, V1 Rev 2", () => {
  const diff = () => {
    const a = supersede([], sub("V1-s1", r1.quotes, "2026-09-21"));
    const b = supersede(a.history, sub("V1-s2", r2.quotes, "2026-10-08"));
    return diffSubmissions(a.current, b.current, RFX_LINES);
  };

  it("finds exactly the five changed lines and says so in the banner", () => {
    const d = diff();
    expect(d.changes.map((c) => c.line_id)).toEqual(["L04", "L06", "L15", "L16", "L17"]);
    expect(d.headline).toBe("V1 Rev 2 received, 5 prices changed.");
  });

  it("L06's slip is corrected: price up tenfold and the state moves from NEEDS_REVIEW to CONFIRMED", () => {
    const l06 = diff().changes.find((c) => c.line_id === "L06")!;
    expect(l06.before).toEqual({ point: 11.08, state: "NEEDS_REVIEW" });
    expect(l06.after).toEqual({ point: 110.81, state: "CONFIRMED" });
    expect(l06.delta_annual_inr).toBeCloseTo(13000 * (110.81 - 11.08), 6);
  });

  it("the kraft increase lines are about 3 percent up, and the annual impact adds up", () => {
    const d = diff();
    for (const id of ["L04", "L15", "L16", "L17"]) {
      const c = d.changes.find((x) => x.line_id === id)!;
      expect(c.after.point! / c.before.point!, id).toBeCloseTo(1.03, 2);
    }
    const expected = d.changes.reduce((s, c) => s + line(c.line_id).annual_qty * (c.after.point! - c.before.point!), 0);
    expect(d.annual_impact_inr).toBeCloseTo(expected, 6);
  });

  it("names lines newly quoted, withdrawn, or changed only in state", () => {
    const from = { ...supersede([], sub("A", [q("V1", "L01", 10), q("V1", "L02", 20), q("V1", "L03", 30)], "x")).current };
    const toQuotes = [q("V1", "L02", 20, { state: "INFERRED" }), q("V1", "L03", 30), q("V1", "L04", 40)];
    const l01Missing = { ...q("V1", "L01", 0), state: "MISSING" as const, landed: null, components: [] };
    const to = { ...from, submission_id: "B", revision: 2, quotes: [l01Missing, ...toQuotes] };
    const d = diffSubmissions(from, to, RFX_LINES.slice(0, 4));
    expect(d.changes.map((c) => [c.line_id, c.kind])).toEqual([["L01", "withdrawn"], ["L02", "state_changed"], ["L04", "newly_quoted"]]);
    expect(d.headline).toBe("V1 Rev 2 received, 0 prices changed, 3 other line changes.");
  });
});

describe("staleAward (W11)", () => {
  const diff = () => {
    const a = supersede([], sub("V1-s1", r1.quotes, "2026-09-21"));
    const b = supersede(a.history, sub("V1-s2", r2.quotes, "2026-10-08"));
    return diffSubmissions(a.current, b.current, RFX_LINES);
  };

  it("an award built on V1 Rev 1 is stale, with the changed awarded lines and their rupee impact", () => {
    const award = allocate(RFX_LINES, [{ vendor_id: "V1", quotes: r1.quotes, assessment: r1.vendor, gate: "PASS" }], DEFAULT_POLICY, config.exposure.safe_states);
    const s = staleAward(award, diff());
    expect(s.stale).toBe(true);
    expect(s.affected_lines).toEqual(["L04", "L06", "L15", "L16", "L17"]);
    expect(s.impact_inr).toBeCloseTo(diff().annual_impact_inr, 6);
    expect(s.message).toMatch(/^This award used V1 Rev 1, now superseded by Rev 2\. 5 awarded lines changed \(L04, L06, L15, L16, L17\), \+Rs [\d.]+ lakh a year\. Re-run before confirming\.$/);
  });

  it("is stale even when none of the awarded lines changed, because it still used superseded data", () => {
    const award = allocate([line("L09")], [{ vendor_id: "V1", quotes: r1.quotes, assessment: r1.vendor, gate: "PASS" }], DEFAULT_POLICY, config.exposure.safe_states);
    const s = staleAward(award, diff());
    expect(s).toMatchObject({ stale: true, affected_lines: [], impact_inr: 0 });
    expect(s.message).toMatch(/None of its lines changed; re-run to confirm\.$/);
  });

  it("an award with nothing from V1 is not stale", () => {
    const award = allocate([line("L09")], [vendor("V3", [q("V3", "L09", 5)])], DEFAULT_POLICY, config.exposure.safe_states);
    expect(staleAward(award, diff())).toEqual({ stale: false, affected_lines: [], impact_inr: 0, message: null });
  });
});
