// Gel lighting: the cover art picks the stage's light colors, the way
// a lighting designer picks gels for a tour. Hues are extracted once
// per track and held static — all motion stays on the existing
// --bass/--highs energy path. gelHues/gelColor are pure math so they
// stay provable (same seam as energy.ts); extractGels is the thin
// canvas boundary.

/** Downsample size for extraction: 32x32 is plenty for a wash color. */
const SAMPLE = 32;
/** Hue histogram bin width in degrees. */
const BIN_DEG = 15;
const BINS = 360 / BIN_DEG;
/** Washed-out or near-black pixels don't read as stage light: skip them. */
const MIN_SATURATION = 0.25;
const MIN_LIGHTNESS = 0.12;
const MAX_LIGHTNESS = 0.88;
/** Below this share of colorful pixels the cover is effectively
    grayscale — keep the house gels (the CSS defaults). */
const MIN_QUALIFIED_SHARE = 0.05;
/** A second gel must sit this far around the hue wheel from the first
    and carry a real share of the color weight; otherwise fall back to
    an analogous shift — the classic two-tone wash. */
const MIN_HUE_SEPARATION = 45;
const MIN_SECOND_SHARE = 0.15;
const ANALOGOUS_SHIFT = 30;

function normHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Shortest distance between two hues around the wheel. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(normHue(a) - normHue(b));
  return Math.min(d, 360 - d);
}

/**
 * Floor and top gel hues from RGBA pixel data, or null when the cover
 * has no usable color (grayscale, near-empty). Dominant hue lights the
 * floor; the strongest sufficiently-distinct hue lights the top.
 *
 * Hue precision is one histogram bin (15°) — a stage wash doesn't need
 * better; widen to a neighborhood mean if it ever does.
 */
export function gelHues(rgba: Uint8ClampedArray): [number, number] | null {
  // Saturation-weighted circular sums per bin: atan2 recovers the mean
  // hue of a bin without seam artifacts at 0°/360°.
  const weight = new Float64Array(BINS);
  const sumX = new Float64Array(BINS);
  const sumY = new Float64Array(BINS);
  let totalPixels = 0;
  let qualifiedShare = 0; // share numerator: count of colorful pixels
  let qualifiedWeight = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue; // transparent: not part of the art
    totalPixels++;
    const r = rgba[i] / 255;
    const g = rgba[i + 1] / 255;
    const b = rgba[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) continue; // pure gray has no hue
    const l = (max + min) / 2;
    const s = delta / (1 - Math.abs(2 * l - 1));
    if (s < MIN_SATURATION || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue;

    let h: number;
    if (max === r) h = 60 * ((g - b) / delta);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
    h = normHue(h);

    qualifiedShare++;
    qualifiedWeight += s;
    const bin = Math.min(BINS - 1, Math.floor(h / BIN_DEG));
    weight[bin] += s;
    const rad = (h * Math.PI) / 180;
    sumX[bin] += s * Math.cos(rad);
    sumY[bin] += s * Math.sin(rad);
  }

  if (totalPixels === 0 || qualifiedShare / totalPixels < MIN_QUALIFIED_SHARE) {
    return null;
  }

  let floorBin = 0;
  for (let b = 1; b < BINS; b++) if (weight[b] > weight[floorBin]) floorBin = b;
  const floor = normHue((Math.atan2(sumY[floorBin], sumX[floorBin]) * 180) / Math.PI);

  let topBin = -1;
  for (let b = 0; b < BINS; b++) {
    if (weight[b] === 0) continue;
    if (hueDistance(b * BIN_DEG + BIN_DEG / 2, floor) < MIN_HUE_SEPARATION) continue;
    if (topBin < 0 || weight[b] > weight[topBin]) topBin = b;
  }
  const top =
    topBin >= 0 && weight[topBin] / qualifiedWeight >= MIN_SECOND_SHARE
      ? normHue((Math.atan2(sumY[topBin], sumX[topBin]) * 180) / Math.PI)
      : normHue(floor + ANALOGOUS_SHIFT);

  return [floor, top];
}

/**
 * A hue rendered as a stage light: fixed high saturation and lightness,
 * like putting a gel in front of a bright lamp. Keeping S/L fixed means
 * a muddy cover still yields clean light — the cover picks the hue, the
 * rig supplies the intensity.
 */
export function gelColor(hue: number): string {
  return `hsl(${Math.round(normHue(hue))} 85% 68%)`;
}

/**
 * Extract [floor, top] gel colors from a cover image URL, or null when
 * the cover has no usable color. Decode failures propagate — a corrupt
 * image is an upstream bug, not a "no gel" state.
 */
export async function extractGels(src: string): Promise<[string, string] | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable for gel extraction");
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  const hues = gelHues(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  return hues && [gelColor(hues[0]), gelColor(hues[1])];
}
