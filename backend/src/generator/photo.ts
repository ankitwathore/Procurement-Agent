import sharp from "sharp";
import type { Rng } from "../data/rng.js";

/**
 * Turns a rendered document into a phone photo (spec 17.8): the card on a desk, perspective and rotation, uneven
 * light, a paper shadow and vignette, blur, noise, JPEG quality 70, the bottom cropped. Every random choice comes
 * from the seeded RNG and is returned as parameters, so the photo is reproducible and the holdouts can vary it.
 * Also maps rectangles on the card to where they land in the photo, so a reading can be checked against a region.
 */

export interface PhotoParams {
  /** Card corner offsets as fractions of the card size: [top-left, top-right, bottom-right, bottom-left], each [dx, dy]. */
  corners: [number, number][];
  rotation_deg: number;
  blur_sigma: number;
  noise: number;
  light: { angle_deg: number; strength: number };
  shadow: { side: "left" | "right"; width: number; strength: number };
  vignette: number;
  jpeg_quality: number;
  crop_bottom_pct: number;
  desk: { r: number; g: number; b: number };
}

export function drawPhotoParams(rng: Rng, o: { rotation: [number, number]; corners: [number, number]; blur: [number, number] } = { rotation: [4, 6], corners: [0.05, 0.09], blur: [1.0, 1.4] }): PhotoParams {
  const sign = () => (rng.uniform(0, 1) < 0.5 ? -1 : 1);
  const off = () => rng.uniform(o.corners[0], o.corners[1]);
  // Each corner pulled inward by 5 to 9 percent on one axis, as a hand-held phone shot foreshortens the far edge.
  const corners: [number, number][] = [
    [off(), rng.uniform(0, 0.02)],
    [-off(), rng.uniform(0, 0.03)],
    [-rng.uniform(0, 0.02), -rng.uniform(0, 0.02)],
    [rng.uniform(0, 0.02), -rng.uniform(0, 0.02)],
  ];
  return {
    corners,
    rotation_deg: sign() * rng.uniform(o.rotation[0], o.rotation[1]),
    blur_sigma: rng.uniform(o.blur[0], o.blur[1]),
    noise: rng.uniform(5, 8),
    light: { angle_deg: rng.uniform(0, 360), strength: rng.uniform(0.12, 0.2) },
    shadow: { side: rng.uniform(0, 1) < 0.5 ? "left" : "right", width: rng.uniform(0.08, 0.14), strength: rng.uniform(0.25, 0.35) },
    vignette: rng.uniform(0.18, 0.28),
    jpeg_quality: 70,
    crop_bottom_pct: 4,
    desk: { r: Math.round(rng.uniform(120, 150)), g: Math.round(rng.uniform(95, 115)), b: Math.round(rng.uniform(70, 90)) },
  };
}

type Mat = [number, number, number, number, number, number, number, number, number];

/** The homography taking the four source points to the four destination points (direct linear solve). */
export function homography(src: [number, number][], dst: [number, number][]): Mat {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as [number, number];
    const [u, v] = dst[i] as [number, number];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting on the 8x8 system.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((A[r] as number[])[c] as number) > Math.abs((A[p] as number[])[c] as number)) p = r;
    [A[c], A[p]] = [A[p] as number[], A[c] as number[]];
    [b[c], b[p]] = [b[p] as number, b[c] as number];
    for (let r = c + 1; r < n; r++) {
      const f = ((A[r] as number[])[c] as number) / ((A[c] as number[])[c] as number);
      for (let k = c; k < n; k++) (A[r] as number[])[k] = ((A[r] as number[])[k] as number) - f * ((A[c] as number[])[k] as number);
      b[r] = (b[r] as number) - f * (b[c] as number);
    }
  }
  const h = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r] as number;
    for (let k = r + 1; k < n; k++) s -= ((A[r] as number[])[k] as number) * (h[k] as number);
    h[r] = s / ((A[r] as number[])[r] as number);
  }
  return [...h, 1] as Mat;
}

function invert(m: Mat): Mat {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const apply = (m: Mat, x: number, y: number): [number, number] => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

export interface PhotoResult {
  jpeg: Buffer;
  width: number;
  height: number;
  /** Maps a point on the card (pixels) to the photo (pixels, after the crop). */
  toPhoto: (x: number, y: number) => [number, number];
}

/** A rectangle on the card, as a normalized [x0, y0, x1, y1] box in the photo (the bounding box of its warped corners). */
export function regionOf(photo: PhotoResult, rect: { x: number; y: number; w: number; h: number }): [number, number, number, number] {
  const pts = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]].map(([x, y]) => photo.toPhoto(x as number, y as number));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return [r(Math.max(0, Math.min(...xs)) / photo.width), r(Math.max(0, Math.min(...ys)) / photo.height), r(Math.min(photo.width, Math.max(...xs)) / photo.width), r(Math.min(photo.height, Math.max(...ys)) / photo.height)];
}

/** Photographs a rendered card (raw RGB pixels) per the parameters. */
export async function photograph(card: { data: Buffer; width: number; height: number }, params: PhotoParams, rng: Rng): Promise<PhotoResult> {
  const { width: cw, height: ch, data: src } = card;
  // The desk is larger than the card; the card sits in the middle before the warp.
  const W = Math.round(cw * 1.22);
  const H = Math.round(ch * 1.16);
  const ox = (W - cw) / 2;
  const oy = (H - ch) / 2;
  const cardCorners: [number, number][] = [[0, 0], [cw, 0], [cw, ch], [0, ch]];
  const warped = cardCorners.map(([x, y], i) => {
    const [dx, dy] = params.corners[i] as [number, number];
    return [ox + x + dx * cw, oy + y + dy * ch] as [number, number];
  });
  // Rotation about the desk centre, composed after the perspective.
  const t = (params.rotation_deg * Math.PI) / 180;
  const cx = W / 2;
  const cy = H / 2;
  const rotated = warped.map(([x, y]) => [cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t), cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t)] as [number, number]);
  const Hm = homography(cardCorners, rotated);
  const inv = invert(Hm);

  const out = Buffer.alloc(W * H * 3);
  const lightDir = (params.light.angle_deg * Math.PI) / 180;
  const lx = Math.cos(lightDir);
  const ly = Math.sin(lightDir);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const [u, v] = apply(inv, x + 0.5, y + 0.5);
      let r: number, g: number, b: number;
      if (u >= 0 && v >= 0 && u < cw - 1 && v < ch - 1) {
        // Bilinear sample of the card.
        const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
        const i00 = (y0 * cw + x0) * 3, i10 = i00 + 3, i01 = i00 + cw * 3, i11 = i01 + 3;
        const s = (k: number) => (src[i00 + k] as number) * (1 - fx) * (1 - fy) + (src[i10 + k] as number) * fx * (1 - fy) + (src[i01 + k] as number) * (1 - fx) * fy + (src[i11 + k] as number) * fx * fy;
        r = s(0); g = s(1); b = s(2);
        // The paper's own shadow: one edge of the sheet darker, as if lifted from the desk.
        const edge = params.shadow.side === "left" ? u / cw : 1 - u / cw;
        if (edge < params.shadow.width) {
          const k = 1 - params.shadow.strength * (1 - edge / params.shadow.width);
          r *= k; g *= k; b *= k;
        }
      } else {
        // Desk: a flat colour with a little grain.
        const grain = Math.sin(y * 0.05 + Math.sin(x * 0.013) * 3) * 6;
        r = params.desk.r + grain; g = params.desk.g + grain * 0.8; b = params.desk.b + grain * 0.6;
      }
      // Uneven light across the frame, then a vignette.
      const nx = x / W - 0.5;
      const ny = y / H - 0.5;
      const light = 1 + params.light.strength * (nx * lx + ny * ly) * 2;
      const vig = 1 - params.vignette * (nx * nx + ny * ny) * 2;
      const k = light * vig;
      out[o] = Math.max(0, Math.min(255, r * k));
      out[o + 1] = Math.max(0, Math.min(255, g * k));
      out[o + 2] = Math.max(0, Math.min(255, b * k));
    }
  }
  const blurred = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).blur(params.blur_sigma).raw().toBuffer();
  for (let i = 0; i < blurred.length; i++) {
    // Sensor noise, roughly normal (sum of uniforms).
    const n = (rng.uniform(-1, 1) + rng.uniform(-1, 1) + rng.uniform(-1, 1)) / 3;
    blurred[i] = Math.max(0, Math.min(255, (blurred[i] as number) + n * params.noise * 2));
  }
  const keep = Math.round(H * (1 - params.crop_bottom_pct / 100));
  const jpeg = await sharp(blurred, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: 0, top: 0, width: W, height: keep })
    .jpeg({ quality: params.jpeg_quality, mozjpeg: false, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return { jpeg, width: W, height: keep, toPhoto: (x, y) => apply(Hm, x, y) };
}

// ---- Handwriting: digits drawn as strokes in a 10 x 16 box, jittered by the RNG, so no handwriting font is needed.

const GLYPHS: Record<string, [number, number][][]> = {
  "0": [[[5, 0], [1, 3], [0, 8], [1, 13], [5, 16], [9, 13], [10, 8], [9, 3], [5, 0]]],
  "1": [[[2, 3], [6, 0], [6, 16]]],
  "2": [[[1, 4], [3, 1], [7, 0], [9, 3], [8, 7], [1, 16], [10, 16]]],
  "3": [[[1, 2], [5, 0], [9, 3], [7, 7], [4, 8], [8, 9], [10, 13], [6, 16], [1, 14]]],
  "4": [[[7, 16], [7, 0], [0, 11], [10, 11]]],
  "5": [[[9, 0], [2, 0], [1, 7], [6, 6], [10, 10], [8, 15], [4, 16], [0, 14]]],
  "6": [[[8, 1], [4, 0], [1, 5], [0, 11], [3, 16], [8, 15], [10, 11], [7, 8], [3, 8], [1, 11]]],
  "7": [[[0, 0], [10, 0], [4, 16]]],
  "8": [[[5, 8], [1, 5], [2, 1], [5, 0], [8, 1], [9, 5], [5, 8], [1, 11], [2, 15], [5, 16], [8, 15], [9, 11], [5, 8]]],
  "9": [[[9, 6], [6, 8], [2, 7], [0, 4], [3, 0], [7, 0], [9, 4], [9, 9], [7, 16]]],
  ".": [[[1, 15], [2, 16]]],
};

/** SVG paths for a handwritten number at (x, y), `h` pixels tall, slanted and jittered like a pen note. */
export function handwritten(text: string, x: number, y: number, h: number, rng: Rng, colour = "#1f3fa8"): string {
  const s = h / 16;
  let cx = x;
  const paths: string[] = [];
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (!glyph) {
      cx += 6 * s;
      continue;
    }
    for (const stroke of glyph) {
      const pts = stroke.map(([gx, gy]) => {
        const jx = rng.uniform(-0.6, 0.6);
        const jy = rng.uniform(-0.6, 0.6);
        // A forward slant: higher points lean right.
        return `${(cx + (gx + jx) * s + (16 - gy) * s * 0.18).toFixed(1)},${(y + (gy + jy) * s).toFixed(1)}`;
      });
      paths.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${colour}" stroke-width="${(s * 1.5).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    cx += (ch === "." ? 5 : 12) * s;
  }
  return paths.join("");
}
