import { beforeAll, describe, expect, it } from "vitest";
import { evaluateGate } from "../src/award/gate.js";
import { DEFAULT_POLICY, allocate } from "../src/award/optimizer.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { buildV1Workbook, v1GroundTruth } from "../src/generator/v1.js";
import type { Extraction } from "../src/ingest/extraction.js";
import { parseXlsx, type ParsedWorkbook } from "../src/ingest/parse_xlsx.js";
import { buildQuotes, type BuildInput, type Quote } from "../src/ingest/quotes.js";
import { config } from "./fixtures/quotes.js";
import { v1Extraction } from "./fixtures/v1.js";

/**
 * First real file through the whole deterministic pipeline: generated workbook -> parser -> extraction stand-in
 * -> provenance checks -> normalization -> checks -> states, scored against ground_truth.json.
 */

interface GtLine {
  quoted: boolean;
  expected_state: string;
  expected_flags: string[];
  landed_unit_inr_point: number | null;
}

let wb: ParsedWorkbook;
let gt: { lines: Record<string, GtLine> };

beforeAll(async () => {
  const { buffer, content } = await buildV1Workbook(42, 1);
  wb = await parseXlsx(buffer);
  gt = v1GroundTruth(content) as typeof gt;
});

function build(extraction: Extraction = v1Extraction(wb), overrides: Partial<BuildInput> = {}) {
  return buildQuotes({
    vendorId: "V1",
    vendorCity: "Pune",
    config,
    lines: RFX_LINES,
    extraction,
    sourceText: wb.text,
    workbook: wb,
    textNative: true,
    receivedAt: "2026-09-21",
    ...overrides,
  });
}

describe("V1 Excel through the pipeline, scored against ground truth", () => {
  let quotes: Quote[];
  const q = (id: string) => quotes.find((x) => x.line_id === id)!;
  beforeAll(() => {
    quotes = build().quotes;
  });

  it("every line gets the state the ground truth expects", () => {
    const mismatches = RFX_LINES.filter((l) => q(l.line_id).state !== gt.lines[l.line_id]!.expected_state).map(
      (l) => `${l.line_id}: got ${q(l.line_id).state}, expected ${gt.lines[l.line_id]!.expected_state}`,
    );
    expect(mismatches).toEqual([]);
  });

  it("every expected flag is raised", () => {
    const missing = RFX_LINES.flatMap((l) =>
      gt.lines[l.line_id]!.expected_flags.filter((f) => !q(l.line_id).flags.includes(f)).map((f) => `${l.line_id}: ${f}`),
    );
    expect(missing).toEqual([]);
  });

  it("landed prices for confirmed lines equal the ground truth exactly", () => {
    for (const l of RFX_LINES) {
      const expected = gt.lines[l.line_id]!.landed_unit_inr_point;
      if (expected === null) continue;
      expect(q(l.line_id).landed!.point, l.line_id).toBe(expected);
    }
  });

  it("trap 04: L06 is NEEDS_REVIEW at 11.08 with 110.8 suggested, and spans both readings", () => {
    const l06 = q("L06");
    expect(l06.state).toBe("NEEDS_REVIEW");
    expect(l06.suggested_reading!.suggested_rate).toBeCloseTo(110.8, 1);
    expect(l06.landed).toMatchObject({ point: 11.08, low: 11.08 });
    expect(l06.landed!.high).toBeCloseTo(110.8, 1);
  });

  it("trap 02: hidden previous-quarter rates are recorded and flagged, never used as the price", () => {
    const l04 = q("L04");
    expect(l04.hidden_values).toHaveLength(1);
    expect(l04.hidden_values[0]!.locator).toMatchObject({ sheet: "Rates", cell: "E10", hidden: true });
    expect(l04.landed!.point).toBe(72.8);
    expect(l04.hidden_values[0]!.value).toBe(75.8);
    expect(build().hidden_rows).toHaveLength(28);
  });

  it("trap 03: the lighter-board lines carry their spec flags, and their price state stays CONFIRMED", () => {
    for (const id of ["L01", "L02", "L03", "L05"]) {
      expect(q(id).spec_flags.map((f) => f.field), id).toEqual(["liner_gsm", "bf"]);
      expect(q(id).state, id).toBe("CONFIRMED");
    }
    expect(q("L04").spec_flags).toEqual([]);
  });

  it("trap 35: NQ and blank are MISSING, never imputed", () => {
    expect(q("L20")).toMatchObject({ state: "MISSING", landed: null });
    expect(q("L21")).toMatchObject({ state: "MISSING", landed: null });
  });

  it("vendor terms resolve: delivered, ex GST, valid to 2026-10-21, on time", () => {
    const { vendor } = build();
    expect(vendor.validity).toMatchObject({ status: "ok", valid_until: "2026-10-21", source: "computed" });
    expect(vendor.late).toBe(false);
    expect(q("L04").components.map((c) => c.kind)).toEqual(["base_rate"]);
    expect(q("L04").flags).not.toContain("gst_basis_assumed");
  });
});

describe("xlsx provenance guards (spec 20.4: every price needs a source that exists)", () => {
  const tamper = (fn: (e: Extraction) => void) => {
    const e = v1Extraction(wb);
    fn(e);
    return build(e);
  };
  const g8 = (e: Extraction) => e.rows.find((r) => r.row_id === "G8")!;

  it("accepts the honest extraction without a single rejection", () => {
    expect(build().rejected).toEqual([]);
  });

  it("rejects a rate that does not match its cell (an invented price)", () => {
    const r = tamper((e) => {
      g8(e).rate.value = 110.81;
    });
    expect(r.rejected).toEqual([{ row_id: "G8", reason: "rate 110.81 does not match cell Rates!G8 (11.08)" }]);
    expect(r.quotes.find((x) => x.line_id === "L06")!.state).toBe("MISSING");
  });

  it("rejects a snippet that does not match its cell", () => {
    const r = tamper((e) => {
      g8(e).snippet = "110.81";
    });
    expect(r.rejected[0]!.reason).toBe("snippet does not match cell Rates!G8");
  });

  it("rejects a locator that points at an empty cell", () => {
    const r = tamper((e) => {
      g8(e).locator = { type: "xlsx", sheet: "Rates", cell: "V8" };
    });
    expect(r.rejected[0]!.reason).toBe("cell Rates!V8 is empty or does not exist");
  });

  it("rejects xlsx rows when there is no workbook to check them against", () => {
    const r = build(v1Extraction(wb), { workbook: undefined });
    expect(r.rejected).toHaveLength(56);
    expect(r.rejected[0]!.reason).toBe("no workbook to verify the cell against");
  });

  it("does not trust the model's hidden flag: a hidden cell claimed visible is still treated as hidden", () => {
    const r = tamper((e) => {
      const hiddenRow = e.rows.find((x) => x.row_id === "E10")!;
      hiddenRow.locator = { ...hiddenRow.locator, hidden: false };
    });
    expect(r.hidden_rows.map((h) => h.row_id)).toContain("E10");
    expect(r.quotes.find((x) => x.line_id === "L04")!.landed!.point).toBe(72.8);
  });

  it("a line with only a hidden value stays MISSING and is flagged, never priced from the hidden cell", () => {
    const r = tamper((e) => {
      e.rows = e.rows.filter((x) => x.row_id !== "E8");
    });
    const l04 = r.quotes.find((x) => x.line_id === "L04")!;
    expect(l04).toMatchObject({ state: "MISSING", landed: null });
    expect(l04.flags).toContain("hidden_value_differs");
    expect(l04.hidden_values[0]!.value).toBe(75.8);
  });
});

describe("V1 into the optimizer", () => {
  it("under risk adjusted pricing the L06 slip is priced at its high reading, not at 11.08", () => {
    const { quotes, vendor } = build();
    const run = (cell_policy: "point" | "risk_adjusted") =>
      allocate(RFX_LINES, [{ vendor_id: "V1", quotes, assessment: vendor, gate: "PASS" }], { ...DEFAULT_POLICY, cell_policy }, config.exposure.safe_states);

    const risk = run("risk_adjusted").assignments.find((a) => a.line_id === "L06")!;
    expect(risk.price).toBeCloseTo(110.8, 1);
    const point = run("point").assignments.find((a) => a.line_id === "L06")!;
    expect(point.price).toBe(11.08);
  });

  it("the L06 slip is valued at its high reading in exposure, so the gate no longer lets it through unasked", () => {
    const { quotes, vendor } = build();
    const r = allocate(RFX_LINES, [{ vendor_id: "V1", quotes, assessment: vendor, gate: "PASS" }], DEFAULT_POLICY, config.exposure.safe_states);
    const l06 = r.exposure.unsafe.find((u) => u.line_id === "L06")!;
    expect(l06.value_point_inr).toBeCloseTo(13000 * 11.08, 6); // what spec 8.5 would have counted: about Rs 1.4 lakh
    expect(l06.value_inr).toBeCloseTo(13000 * 110.8, 0); // what is really at stake: about Rs 14.4 lakh
    const gate = evaluateGate(r, config.award_gate);
    expect(gate.status).not.toBe("allowed");
    expect(gate.resolve_first[0]!.line_id).toBe("L06");
  });

  it("strict spec policy leaves the lighter-board lines and the unquoted lines unfilled when V1 is alone", () => {
    const { quotes, vendor } = build();
    const r = allocate(RFX_LINES, [{ vendor_id: "V1", quotes, assessment: vendor, gate: "PASS" }], DEFAULT_POLICY, config.exposure.safe_states);
    expect(r.unfillable).toEqual(["L01", "L02", "L03", "L05", "L20", "L21"]);
  });
});
