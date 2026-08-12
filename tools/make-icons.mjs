/**
 * Generate the PNG app icons from the same geometry as `assets/icons/icon.svg`.
 *
 * The repository ships no pre-built binaries that cannot be reproduced, so the
 * PNGs are rasterized here — by hand, with 4× supersampling and a tiny PNG
 * encoder — rather than checked in from an image editor.
 *
 *   node tools/make-icons.mjs           write the icons
 *   node tools/make-icons.mjs --check   verify the committed icons match
 *
 * `--check` compares decoded pixels rather than file bytes, because zlib's
 * compressed output is not guaranteed to be identical across Node versions.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  arcPolyline,
  bounds,
  decodePng,
  distanceToPolylines,
  encodePng,
  mix,
  pointInTriangle,
  render,
  roundedRectDistance,
} from './raster.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');

/* ------------------------------------------------------------------ *
 * Geometry, in a 512×512 space (matching the SVG)
 * ------------------------------------------------------------------ */

const STROKE = 30; // the cycle, as in the SVG
const PLAY_STROKE = 26; // the play head is stroked as well as filled, which rounds its corners

/**
 * The conversion cycle: one arrow over the top, its mirror under the bottom.
 * The numbers are the ones in `icon.svg`, arcs included, so the two cannot
 * drift apart without somebody editing both.
 */
const CYCLE = [
  arcPolyline([118, 280], 140, [377, 186]),
  [[330, 169], [377, 186], [386, 137]],
  arcPolyline([394, 232], 140, [135, 326]),
  [[182, 343], [135, 326], [126, 375]],
];

/** The play head in the middle: what is being converted. */
const PLAY = [[208, 188], [330, 256], [208, 324]];
const PLAY_OUTLINE = [...PLAY, PLAY[0]];

/**
 * The mark's ink, used only to skip the segment tests for pixels it cannot
 * reach. Without it every pixel of every icon would measure its distance to
 * all seventy-odd segments of the cycle.
 */
const INK = bounds([...CYCLE, PLAY_OUTLINE], STROKE / 2);

const TEAL_LIGHT = [0x14, 0xb8, 0xa6];
const TEAL_DARK = [0x0f, 0x76, 0x6e];
const WHITE = [255, 255, 255];

/**
 * Colour one point in 512-space.
 * @returns {[number, number, number, number]} RGBA, premultiplied by nothing.
 */
function sample(x, y, radius) {
  if (roundedRectDistance(x, y, 0, 0, 512, 512, radius) > 0) return [0, 0, 0, 0];

  if (x >= INK.minX && x <= INK.maxX && y >= INK.minY && y <= INK.maxY) {
    if (distanceToPolylines(x, y, CYCLE) <= STROKE / 2) return [...WHITE, 255];
    if (pointInTriangle(x, y, PLAY)) return [...WHITE, 255];
    if (distanceToPolylines(x, y, [PLAY_OUTLINE]) <= PLAY_STROKE / 2) return [...WHITE, 255];
  }

  // Diagonal gradient from teal-500 to teal-700, matching the SVG.
  return [...mix(TEAL_LIGHT, TEAL_DARK, (x + y) / 1024), 255];
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const TARGETS = [
  { file: 'icon-192.png', size: 192, radius: 112 },
  { file: 'icon-512.png', size: 512, radius: 112 },
  // iOS rounds the home-screen icon itself, so this one stays square; rounding
  // it here as well would show a pale sliver inside each corner.
  { file: 'icon-180.png', size: 180, radius: 0 },
  // A maskable icon is cropped to whatever shape the platform likes, so the
  // background has to bleed to the edges. The mark needs no inset: it already
  // sits within 191 units of the centre, inside the 205-unit safe circle.
  { file: 'icon-maskable.png', size: 512, radius: 0 },
];

const check = process.argv.includes('--check');
let failures = 0;

if (!check) mkdirSync(OUT_DIR, { recursive: true });

for (const target of TARGETS) {
  const pixels = render({
    width: target.size,
    height: target.size,
    scale: 512 / target.size,
    sample: (x, y) => sample(x, y, target.radius),
  });
  const path = join(OUT_DIR, target.file);

  if (!check) {
    writeFileSync(path, encodePng(target.size, target.size, pixels));
    console.log(`wrote ${target.file} (${target.size}×${target.size})`);
    continue;
  }

  try {
    const existing = decodePng(readFileSync(path));
    if (existing.width !== target.size || !existing.pixels.equals(pixels)) {
      console.error(`${target.file} does not match what this script renders`);
      failures++;
    } else {
      console.log(`${target.file} matches`);
    }
  } catch (error) {
    console.error(`${target.file}: ${error.message}`);
    failures++;
  }
}

if (check && failures > 0) {
  console.error('\nRun `node tools/make-icons.mjs` and commit the result.');
  process.exit(1);
}
