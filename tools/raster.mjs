/**
 * A tiny software rasterizer and PNG codec, shared by the image generators.
 *
 * The repository ships no binary that cannot be reproduced from source, so the
 * icons and the social preview are drawn here rather than exported from a
 * design tool. That also means CI can verify they still match the code.
 *
 * Everything is deliberately small: signed distance functions for the shapes,
 * supersampling for the edges, and the minimum PNG a decoder will accept.
 */

import { deflateSync, inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Distance from a point to a line segment. */
export function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance from a point to any segment of any polyline. */
export function distanceToPolylines(px, py, polylines) {
  let best = Infinity;
  for (const line of polylines) {
    for (let i = 0; i + 1 < line.length; i++) {
      best = Math.min(best, distanceToSegment(px, py, line[i], line[i + 1]));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** Signed distance to a rounded rectangle; negative inside. */
export function roundedRectDistance(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const outside = Math.hypot(Math.max(cx, 0), Math.max(cy, 0));
  return outside + Math.min(Math.max(cx, cy), 0) - r;
}

/** Whether a point is inside a triangle, from the sign of the three edge cross products. */
export function pointInTriangle(px, py, [a, b, c]) {
  const side = ([ax, ay], [bx, by]) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const ab = side(a, b);
  const bc = side(b, c);
  const ca = side(c, a);
  return !((ab < 0 || bc < 0 || ca < 0) && (ab > 0 || bc > 0 || ca > 0));
}

/**
 * Sample a circular SVG arc as a polyline.
 *
 * The icon artwork is an SVG that draws its conversion cycle with `A` commands,
 * and this rasterizer only understands line segments. Rather than re-deriving
 * the curve by eye, the same endpoint parameters are converted to a centre and
 * two angles exactly as the SVG specification does (implementation notes F.6.5)
 * and then walked. Only circular arcs are handled, which is all the icon uses.
 *
 * @param {number[]} from Start point, i.e. where the path already is.
 * @param {number} radius Both radii, since the arc is circular.
 * @param {number[]} to End point of the `A` command.
 * @param {object} [flags] The two flags of the `A` command.
 * @param {number} [flags.largeArc]
 * @param {number} [flags.sweep]
 * @param {number} [steps] Segments to split the arc into.
 * @returns {number[][]} Points along the arc, from `from` to `to`.
 */
export function arcPolyline(from, radius, to, { largeArc = 0, sweep = 1 } = {}, steps = 32) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const halfChordX = (x1 - x2) / 2;
  const halfChordY = (y1 - y2) / 2;
  const halfChordSquared = halfChordX * halfChordX + halfChordY * halfChordY;

  // A radius too small to span the chord is enlarged, as the specification asks.
  const r = Math.max(radius, Math.sqrt(halfChordSquared));
  const spread = Math.sqrt(Math.max(0, (r * r - halfChordSquared) / halfChordSquared));
  const sign = largeArc === sweep ? -1 : 1;
  const cx = sign * spread * halfChordY + (x1 + x2) / 2;
  const cy = -sign * spread * halfChordX + (y1 + y2) / 2;

  const start = Math.atan2(y1 - cy, x1 - cx);
  let end = Math.atan2(y2 - cy, x2 - cx);
  if (sweep && end < start) end += 2 * Math.PI;
  if (!sweep && end > start) end -= 2 * Math.PI;

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = start + ((end - start) * i) / steps;
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return points;
}

/** Axis-aligned bounds of some polylines, grown by `padding` on every side. */
export function bounds(polylines, padding = 0) {
  const points = polylines.flat();
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
  };
}

/** Linear blend between two `[r, g, b]` colours. */
export function mix(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Render an image by sampling a colour function.
 *
 * @param {object} spec
 * @param {number} spec.width  Output width in pixels.
 * @param {number} spec.height Output height in pixels.
 * @param {number} [spec.scale] Coordinate units per output pixel, so the
 *        sample function can work in a resolution-independent space.
 * @param {number} [spec.samples] Supersampling factor per axis.
 * @param {(x: number, y: number) => number[]} spec.sample Returns `[r,g,b,a]`.
 * @returns {Buffer} RGBA pixels, row-major.
 */
export function render({ width, height, scale = 1, samples = 4, sample }) {
  const pixels = Buffer.alloc(width * height * 4);
  const total = samples * samples;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) * scale;
          const y = (py + (sy + 0.5) / samples) * scale;
          const [sr, sg, sb, sa] = sample(x, y);
          const weight = sa / 255;
          r += sr * weight;
          g += sg * weight;
          b += sb * weight;
          a += sa;
        }
      }
      const alpha = a / total;
      const coverage = a / 255;
      const offset = (py * width + px) * 4;
      pixels[offset] = coverage === 0 ? 0 : Math.round(r / coverage);
      pixels[offset + 1] = coverage === 0 ? 0 : Math.round(g / coverage);
      pixels[offset + 2] = coverage === 0 ? 0 : Math.round(b / coverage);
      pixels[offset + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode RGBA pixels as an 8-bit, non-interlaced PNG. */
export function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Each scanline carries a filter byte; 0 (none) keeps this simple.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decode a PNG this module wrote.
 *
 * Used by the `--check` modes to compare *pixels* rather than file bytes,
 * because zlib's output is not guaranteed identical across Node versions.
 */
export function decodePng(buffer) {
  let offset = 8; // skip the signature
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('unexpected PNG format; only 8-bit RGBA, non-interlaced is supported');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12; // length + type + data + crc
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`unexpected PNG filter ${filter} on row ${y}`);
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, pixels };
}
