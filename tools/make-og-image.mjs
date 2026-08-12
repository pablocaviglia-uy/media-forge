/**
 * Generate the social preview image used by `og:image`.
 *
 * LinkedIn, Slack and the rest render this at card size, so it has to read at a
 * glance and survive heavy downscaling: big mark, heavy strokes, no fine text.
 *
 * There is no font here. Rasterizing real type would mean shipping a font file
 * or depending on a system one, and the project's rule is that every binary in
 * the repository can be reproduced from source. The wordmark and the line under
 * it are therefore drawn as stroked polylines, in the same geometric style as
 * the app icon.
 *
 *   node tools/make-og-image.mjs           write assets/og.png
 *   node tools/make-og-image.mjs --check   verify it still matches
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'og.png');

const WIDTH = 1200;
const HEIGHT = 630;

/* ------------------------------------------------------------------ *
 * A geometric alphabet, drawn rather than typeset
 *
 * Each glyph lives in a unit box: x from 0 to its advance, y from 0 (cap
 * height) to 1 (baseline). Straight segments only, to match the icon's mark.
 * Curves are chamfered instead, which is what keeps the O and the S in the
 * same family as the rest.
 * ------------------------------------------------------------------ */

const GLYPHS = {
  A: { advance: 0.76, strokes: [[[0, 1], [0.38, 0], [0.76, 1]], [[0.14, 0.63], [0.62, 0.63]]] },
  B: {
    advance: 0.76,
    strokes: [
      [[0, 1], [0, 0], [0.44, 0], [0.72, 0.24], [0.44, 0.48], [0, 0.48]],
      [[0.44, 0.48], [0.76, 0.74], [0.44, 1], [0, 1]],
    ],
  },
  C: {
    advance: 0.76,
    strokes: [[[0.76, 0.2], [0.52, 0], [0.24, 0], [0, 0.28], [0, 0.72], [0.24, 1], [0.52, 1], [0.76, 0.8]]],
  },
  D: { advance: 0.82, strokes: [[[0, 1], [0, 0], [0.44, 0], [0.82, 0.34], [0.82, 0.66], [0.44, 1], [0, 1]]] },
  E: { advance: 0.7, strokes: [[[0.7, 0], [0, 0], [0, 1], [0.7, 1]], [[0, 0.5], [0.52, 0.5]]] },
  F: { advance: 0.66, strokes: [[[0.66, 0], [0, 0], [0, 1]], [[0, 0.5], [0.5, 0.5]]] },
  G: {
    advance: 0.82,
    strokes: [
      [[0.82, 0.2], [0.58, 0], [0.26, 0], [0, 0.28], [0, 0.72], [0.26, 1], [0.58, 1], [0.82, 0.72],
        [0.82, 0.56], [0.5, 0.56]],
    ],
  },
  H: { advance: 0.76, strokes: [[[0, 0], [0, 1]], [[0.76, 0], [0.76, 1]], [[0, 0.5], [0.76, 0.5]]] },
  I: { advance: 0.16, strokes: [[[0.08, 0], [0.08, 1]]] },
  L: { advance: 0.6, strokes: [[[0, 0], [0, 1], [0.6, 1]]] },
  M: { advance: 0.92, strokes: [[[0, 1], [0, 0], [0.46, 0.62], [0.92, 0], [0.92, 1]]] },
  N: { advance: 0.78, strokes: [[[0, 1], [0, 0], [0.78, 1], [0.78, 0]]] },
  O: {
    advance: 0.8,
    strokes: [
      [[0.24, 0], [0.56, 0], [0.8, 0.28], [0.8, 0.72], [0.56, 1], [0.24, 1], [0, 0.72], [0, 0.28],
        [0.24, 0]],
    ],
  },
  P: { advance: 0.72, strokes: [[[0, 1], [0, 0], [0.44, 0], [0.72, 0.24], [0.44, 0.48], [0, 0.48]]] },
  R: {
    advance: 0.8,
    strokes: [[[0, 1], [0, 0], [0.46, 0], [0.8, 0.25], [0.46, 0.5], [0, 0.5]], [[0.36, 0.5], [0.8, 1]]],
  },
  S: {
    advance: 0.72,
    strokes: [
      [[0.72, 0.18], [0.5, 0], [0.22, 0], [0, 0.2], [0.2, 0.44], [0.52, 0.56], [0.72, 0.78],
        [0.5, 1], [0.2, 1], [0, 0.82]],
    ],
  },
  T: { advance: 0.7, strokes: [[[0, 0], [0.7, 0]], [[0.35, 0], [0.35, 1]]] },
  U: { advance: 0.76, strokes: [[[0, 0], [0, 0.72], [0.24, 1], [0.52, 1], [0.76, 0.72], [0.76, 0]]] },
  V: { advance: 0.8, strokes: [[[0, 0], [0.4, 1], [0.8, 0]]] },
  W: { advance: 1.16, strokes: [[[0, 0], [0.29, 1], [0.58, 0.36], [0.87, 1], [1.16, 0]]] },
  Y: { advance: 0.76, strokes: [[[0, 0], [0.38, 0.52], [0.76, 0]], [[0.38, 0.52], [0.38, 1]]] },
  '-': { advance: 0.46, strokes: [[[0.06, 0.56], [0.4, 0.56]]] },
  // A zero-length segment, which the rasterizer measures as a point and so
  // draws as a round dot the width of the stroke.
  '.': { advance: 0.24, strokes: [[[0.12, 1], [0.12, 1]]] },
  ' ': { advance: 0.34, strokes: [] },
};

const LETTER_SPACING = 0.2;

/**
 * Lay a string out as absolute polylines.
 *
 * @param {string} text
 * @param {number} x Left edge.
 * @param {number} y Cap-height line.
 * @param {number} size Cap height in pixels.
 */
function layout(text, x, y, size) {
  const strokes = [];
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`no glyph for ${JSON.stringify(char)}`);
    for (const stroke of glyph.strokes) {
      strokes.push(stroke.map(([gx, gy]) => [cursor + gx * size, y + gy * size]));
    }
    cursor += (glyph.advance + LETTER_SPACING) * size;
  }
  return { strokes, width: cursor - x - LETTER_SPACING * size };
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/** The app icon's mark: a conversion cycle around a play head, as in `icon.svg`. */
const CYCLE = [
  arcPolyline([118, 280], 140, [377, 186]),
  [[330, 169], [377, 186], [386, 137]],
  arcPolyline([394, 232], 140, [135, 326]),
  [[182, 343], [135, 326], [126, 375]],
];
const PLAY = [[208, 188], [330, 256], [208, 324]];

const CYCLE_STROKE = 30;
const PLAY_STROKE = 26;

const TEAL_LIGHT = [0x14, 0xb8, 0xa6];
const TEAL_DARK = [0x11, 0x5e, 0x59];
const WHITE = [255, 255, 255];

// The mark is drawn in the icon's 512-unit box, which is mostly padding this
// layout does not want, so it is measured by its ink and scaled from there.
const MARK_SCALE = 0.84;

const WORD = 'MEDIA-FORGE';
const WORD_SIZE = 84;
const WORD_STROKE = 14;
const GAP = 58;

const TAGLINE = 'CONVERT VIDEO AND AUDIO IN YOUR BROWSER. NOTHING IS UPLOADED.';
const TAGLINE_GAP = 46;
// A whole sentence is wider than it is tall, so the tagline is sized by the
// width it has to fit into rather than by a cap height picked by eye.
const TAGLINE_SIZE = 1020 / layout(TAGLINE, 0, 0, 1).width;
const TAGLINE_STROKE = TAGLINE_SIZE * 0.24;

/**
 * One piece of ink: its polylines, half its stroke width, and the box outside
 * which no pixel can possibly touch it. The tagline alone is a few hundred
 * segments, so that box is what keeps the render seconds rather than minutes.
 */
function element(strokes, stroke) {
  return { strokes, half: stroke / 2, box: bounds(strokes, stroke / 2) };
}

/** Everything positioned once, so the sample function stays cheap. */
const scene = (() => {
  // The cycle encloses the play head, so it alone describes the mark's ink.
  const ink = bounds(CYCLE, CYCLE_STROKE / 2);
  const inkWidth = (ink.maxX - ink.minX) * MARK_SCALE;
  const inkHeight = (ink.maxY - ink.minY) * MARK_SCALE;

  const wordWidth = layout(WORD, 0, 0, WORD_SIZE).width;
  const taglineWidth = layout(TAGLINE, 0, 0, TAGLINE_SIZE).width;

  const stack = inkHeight + GAP + WORD_SIZE + TAGLINE_GAP + TAGLINE_SIZE;
  const top = (HEIGHT - stack) / 2;
  const left = (WIDTH - inkWidth) / 2;
  const place = ([x, y]) => [left + (x - ink.minX) * MARK_SCALE, top + (y - ink.minY) * MARK_SCALE];

  const play = PLAY.map(place);
  const wordTop = top + inkHeight + GAP;
  const word = layout(WORD, (WIDTH - wordWidth) / 2, wordTop, WORD_SIZE).strokes;
  const taglineTop = wordTop + WORD_SIZE + TAGLINE_GAP;
  const tagline = layout(TAGLINE, (WIDTH - taglineWidth) / 2, taglineTop, TAGLINE_SIZE).strokes;

  return {
    play,
    elements: [
      element(CYCLE.map((line) => line.map(place)), CYCLE_STROKE * MARK_SCALE),
      // The play head is filled as well as stroked; the outline is what rounds
      // its corners, exactly as `stroke-linejoin="round"` does in the SVG.
      element([[...play, play[0]]], PLAY_STROKE * MARK_SCALE),
      element(word, WORD_STROKE),
      element(tagline, TAGLINE_STROKE),
    ],
  };
})();

function sample(x, y) {
  // A rounded plate inset from the edges, so the card keeps an edge of its own
  // wherever a platform composites it onto white.
  const inset = 28;
  const plate = roundedRectDistance(x, y, inset, inset, WIDTH - inset * 2, HEIGHT - inset * 2, 34);
  if (plate > 0) return [0, 0, 0, 0];

  if (pointInTriangle(x, y, scene.play)) return [...WHITE, 255];
  for (const { strokes, half, box } of scene.elements) {
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
    if (distanceToPolylines(x, y, strokes) <= half) return [...WHITE, 255];
  }

  const t = (x / WIDTH) * 0.55 + (y / HEIGHT) * 0.45;
  return [...mix(TEAL_LIGHT, TEAL_DARK, t), 255];
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const pixels = render({ width: WIDTH, height: HEIGHT, samples: 3, sample });

if (process.argv.includes('--check')) {
  try {
    const existing = decodePng(readFileSync(OUT));
    if (existing.width !== WIDTH || existing.height !== HEIGHT || !existing.pixels.equals(pixels)) {
      console.error('assets/og.png does not match what this script renders');
      console.error('Run `node tools/make-og-image.mjs` and commit the result.');
      process.exit(1);
    }
    console.log('assets/og.png matches');
  } catch (error) {
    console.error(`assets/og.png: ${error.message}`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, encodePng(WIDTH, HEIGHT, pixels));
  console.log(`wrote assets/og.png (${WIDTH}×${HEIGHT})`);
}
