import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RFX_LINES } from "../src/data/rfx.js";
import { ExtractionSchema } from "../src/ingest/extraction.js";
import { checkSpec, parseDims } from "../src/ingest/checks.js";
import { buildQuotes } from "../src/ingest/quotes.js";
import { V5_EMAIL, v5Extraction } from "./fixtures/v5.js";

const config = loadConfig();
const TOL = config.tolerances.dim_tolerance_pct;
const spec = (id: string) => RFX_LINES.find((l) => l.line_id === id)!.spec;

describe("parseDims", () => {
  it.each([
    ["440x330x310", [440, 330, 310]],
    ["900x300 flat", [900, 300]],
    ["1500 wide", [1500]],
  ])("%s", (text, expected) => {
    expect(parseDims(text)).toEqual(expected);
  });
});

describe("checkSpec", () => {
  it("trap 03: V1 offers 120 GSM and BF 16 against 150 and 18 on L01", () => {
    const { flags } = checkSpec(spec("L01"), { ply: 5, liner_gsm: 120, bf: 16, dims_mm: [440, 330, 310], print: "2 colour" }, TOL);
    expect(flags.map((f) => [f.kind, f.field])).toEqual([
      ["spec_below_requirement", "liner_gsm"],
      ["spec_below_requirement", "bf"],
    ]);
    expect(flags[0]!.detail).toBe("liner_gsm 120 offered vs 150 required");
  });

  it("trap 16: V3 test report shows BF 19.5 against 22 on L04", () => {
    const { flags } = checkSpec(spec("L04"), { ply: 5, liner_gsm: 180, bf: 19.5, dims_mm: [1260, 180, 260], print: "2 colour" }, TOL);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "spec_below_requirement", field: "bf", required: 22, offered: 19.5 });
  });

  it.each([
    ["L01", [420, 320, 300]],
    ["L03", [345, 325, 365]],
    ["L05", [430, 220, 460]],
  ])("trap 24: V4 smaller dimensions on %s are flagged", (id, dims) => {
    const { flags } = checkSpec(spec(id), { dims_mm: dims }, TOL);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "spec_dimension_off", field: "dims_mm" });
  });

  it("an exact match raises nothing", () => {
    const { flags, unstated } = checkSpec(spec("L04"), { ply: 5, liner_gsm: 180, bf: 22, dims_mm: [1260, 180, 260], print: "2 colour" }, TOL);
    expect(flags).toEqual([]);
    expect(unstated).toEqual([]);
  });

  it("dimensions inside tolerance pass, including the 2 percent edge, and larger ones are also off", () => {
    expect(checkSpec(spec("L01"), { dims_mm: [446, 330, 310] }, TOL).flags).toEqual([]); // 1.4 percent
    expect(checkSpec(spec("L01"), { dims_mm: [448.8, 330, 310] }, TOL).flags).toEqual([]); // 2.0 percent
    expect(checkSpec(spec("L01"), { dims_mm: [460, 330, 310] }, TOL).flags).toHaveLength(1);
  });

  it("axis order does not matter", () => {
    expect(checkSpec(spec("L01"), { dims_mm: [310, 440, 330] }, TOL).flags).toEqual([]);
  });

  it("notes an upgrade only when nothing is below requirement", () => {
    const up = checkSpec(spec("L01"), { ply: 7, liner_gsm: 150, bf: 18 }, TOL).flags;
    expect(up).toEqual([expect.objectContaining({ kind: "spec_upgrade", field: "ply" })]);
    const mixed = checkSpec(spec("L01"), { ply: 7, liner_gsm: 150, bf: 16 }, TOL).flags;
    expect(mixed.map((f) => f.kind)).toEqual(["spec_below_requirement"]);
  });

  it("flags a print difference, ignoring case and spacing", () => {
    expect(checkSpec(spec("L01"), { print: "  2 Colour " }, TOL).flags).toEqual([]);
    expect(checkSpec(spec("L01"), { print: "1 colour" }, TOL).flags).toEqual([
      expect.objectContaining({ kind: "spec_print_differs" }),
    ]);
  });

  it("lists fields the vendor did not state and judges nothing for them", () => {
    const r = checkSpec(spec("L01"), { ply: 5 }, TOL);
    expect(r.flags).toEqual([]);
    expect(r.unstated).toEqual(["liner_gsm", "bf", "dims_mm", "print"]);
    expect(checkSpec(spec("L01"), null, TOL).unstated).toEqual(["ply", "liner_gsm", "bf", "dims_mm", "print"]);
  });

  it("skips fields the RFx does not specify (tape has no ply, GSM or BF)", () => {
    const r = checkSpec(spec("L27"), { print: "plain" }, TOL);
    expect(r.unstated).toEqual(["dims_mm"]);
  });
});

describe("spec check inside the quote builder", () => {
  function l24(specOffered: unknown) {
    const extraction = v5Extraction();
    extraction.rows[1] = ExtractionSchema.shape.rows.element.parse({ ...extraction.rows[1], spec_offered: specOffered });
    const { quotes } = buildQuotes({ vendorId: "V5", vendorCity: "Vapi", config, lines: RFX_LINES, extraction, sourceText: V5_EMAIL, textNative: true });
    return quotes.find((q) => q.line_id === "L24")!;
  }

  it("records the flags and kinds but leaves the price state alone", () => {
    const q = l24({ ply: 3, liner_gsm: 120, bf: 16 });
    expect(q.spec_flags.map((f) => f.field)).toEqual(["liner_gsm", "bf"]);
    expect(q.flags).toContain("spec_below_requirement");
    expect(q.components[0]!.state).toBe("INFERRED"); // its carried-over unit decides the state, not the spec flags
  });

  it("an unstated spec flags nothing and lists what was not stated", () => {
    const q = l24(null);
    expect(q.spec_flags).toEqual([]);
    expect(q.spec_unstated).toEqual(["ply", "liner_gsm", "bf", "dims_mm", "print"]);
  });
});
