import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { RFX_LINES } from "../src/data/rfx.js";
import { V4_HOLDOUT, V4_HOLDOUT2, V4_TUNED, buildV4CertificatePhoto, buildV4Eml, buildV4Photo, v4GroundTruth, v4Traps, type V4Photo, type V4Row } from "../src/generator/v4.js";
import { homography } from "../src/generator/photo.js";
import { parseEmail } from "../src/ingest/parse_email.js";

/** V4, the phone photo (spec 17.5, 17.8): the image, its email, and the ground truth it plants. */

let photo: V4Photo;
let rows: V4Row[];
beforeAll(async () => {
  ({ photo, rows } = await buildV4Photo(42));
}, 30_000);

describe("the rate card photo", () => {
  it("is a JPEG of a phone photo: deterministic, rotated 4 to 6 degrees, bottom 4 percent cropped", async () => {
    const again = await buildV4Photo(42);
    expect(again.photo.jpeg.equals(photo.jpeg)).toBe(true);
    const meta = await sharp(photo.jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.abs(photo.params.rotation_deg)).toBeGreaterThanOrEqual(4);
    expect(Math.abs(photo.params.rotation_deg)).toBeLessThanOrEqual(6);
    expect(photo.params).toMatchObject({ jpeg_quality: 70, crop_bottom_pct: 4 });
    expect(photo.params.blur_sigma).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("27 rows: L15 to L17 left off, L04 printed 65.90 and corrected to 68.50, L27 per box, three cartons smaller", () => {
    expect(rows).toHaveLength(27);
    expect(rows.map((r) => r.line_id)).not.toContain("L16");
    expect(rows.find((r) => r.line_id === "L04")).toMatchObject({ printed: 65.9, intended: 68.5 });
    expect(rows.find((r) => r.line_id === "L27")).toMatchObject({ printed: 2400, unit: "box", per_base: 33.33 });
    expect(rows.find((r) => r.line_id === "L01")!.size).toBe("420x320x300");
  });

  it("every row has a region inside the photo, rows top to bottom", () => {
    const ys = rows.map((r) => photo.regions[r.line_id]!.row[1]);
    for (const r of rows) for (const v of photo.regions[r.line_id]!.row) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("the homography maps the four corners exactly", () => {
    const src: [number, number][] = [[0, 0], [100, 0], [100, 50], [0, 50]];
    const dst: [number, number][] = [[3, 2], [97, 6], [101, 55], [-1, 48]];
    const h = homography(src, dst);
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i]!;
      const w = h[6] * x + h[7] * y + h[8];
      expect((h[0] * x + h[1] * y + h[2]) / w).toBeCloseTo(dst[i]![0], 6);
      expect((h[3] * x + h[4] * y + h[5]) / w).toBeCloseTo(dst[i]![1], 6);
    }
  });
});

describe("the email", () => {
  it("arrives a day late with the questionnaire in the body, the photo and certificate attached, and no test report", async () => {
    const e = await parseEmail(buildV4Eml(photo.jpeg, await buildV4CertificatePhoto(42)));
    expect(e.sent_at!.toISOString().slice(0, 10)).toBe("2026-09-24");
    expect(e.attachments.map((a) => a.filename)).toEqual([V4_TUNED.files.photo, V4_TUNED.files.certificate]);
    expect(e.attachments[0]!.content.equals(photo.jpeg)).toBe(true);
    expect(e.new_text).toContain("Q02 BF and GSM test report: Yes, attached");
  }, 30_000);
});

describe("ground truth and traps", () => {
  it("states: missing, review for the unreadable, struck and per box lines, inferred elsewhere (freight is ex works)", () => {
    const gt = v4GroundTruth(rows, photo) as { lines: Record<string, { expected_state: string; expected_flags: string[]; true_landed_point?: number; landed_unit_inr_point: number | null }>; validity_until: string; late: boolean; gates: Record<string, string> };
    const states = (s: string) => Object.entries(gt.lines).filter(([, l]) => l.expected_state === s).map(([id]) => id);
    expect(states("MISSING")).toEqual(["L15", "L16", "L17"]);
    expect(states("NEEDS_REVIEW")).toEqual(["L04", "L12", "L22", "L27"]);
    expect(states("INFERRED")).toHaveLength(23);
    expect(gt.lines.L27!.true_landed_point).toBeCloseTo(33.33 + 7.8 * RFX_LINES.find((l) => l.line_id === "L27")!.weight_kg_per_uom, 3);
    expect(gt.lines.L01!.expected_flags).toEqual(["spec_dimension_off"]);
    expect(gt).toMatchObject({ validity_until: "2026-10-09", late: true, gates: { Q01: "PASS", Q02: "FAIL", Q03: "PASS" } });
  });

  it("the holdouts move every trap to other lines", async () => {
    for (const variant of [V4_HOLDOUT, V4_HOLDOUT2]) {
      const t = v4Traps(variant);
      const tuned = v4Traps(V4_TUNED);
      for (const id of ["21", "22", "24"]) expect(t[id]!.lines, `${variant.files.photo} ${id}`).not.toEqual(tuned[id]!.lines);
      expect(t["23"]!.line).not.toBe(tuned["23"]!.line);
      expect(t["25"]!.line).not.toBe(tuned["25"]!.line);
    }
  });
});
