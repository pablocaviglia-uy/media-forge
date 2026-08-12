/**
 * Asking the core what it can do, instead of assuming.
 *
 * The list of codecs compiled into a build of FFmpeg is a property of that
 * build, not of FFmpeg. Hard-coding "we have libx264" works right up until
 * someone swaps in a core built without `--enable-gpl`, at which point the app
 * offers MP4, runs, and fails on the last line with `Unknown encoder`. Running
 * `-encoders` and `-muxers` once at startup costs a few milliseconds and lets
 * the format menu tell the truth.
 *
 * Both listings share a layout: a legend, a row of dashes, then one fixed-width
 * flag field per line followed by a name and a description. The width of the
 * flag field is not stable across FFmpeg versions — `-muxers` prints two flag
 * columns in 5.x and three in 8.x — but it is always exactly the width of the
 * dashes on the separator line, so that is what these parsers measure rather
 * than guess.
 */

/** @returns {{column: number, width: number}|null} where the flag field sits. */
function findFlagField(lines) {
  for (const line of lines) {
    const match = /^(\s*)(-+)\s*$/.exec(line);
    if (match) return { column: match[1].length, width: match[2].length };
  }
  return null;
}

/**
 * Split the part after the flags into a name and a description. FFmpeg pads
 * the name column, so two or more spaces separate them; a single space is
 * inside the description.
 */
function splitNameAndDescription(rest) {
  const match = /^(\S+)(?:\s{2,}(.*))?$/.exec(rest.trim());
  if (!match) return null;
  return { name: match[1], description: (match[2] || '').trim() };
}

function parseListing(text, onRow) {
  const lines = String(text || '').split(/\r?\n/);
  const field = findFlagField(lines);
  if (!field) return [];

  const start = lines.findIndex((line) => /^\s*-+\s*$/.test(line)) + 1;
  const rows = [];

  for (const line of lines.slice(start)) {
    if (!line.trim()) continue;
    const flags = line.slice(field.column, field.column + field.width);
    const parsed = splitNameAndDescription(line.slice(field.column + field.width));
    if (!parsed) continue;
    const row = onRow(flags, parsed);
    if (row) rows.push(row);
  }

  return rows;
}

/** `V....D libx264   libx264 H.264 / AVC … (codec h264)` */
export function parseEncoders(text) {
  return parseListing(text, (flags, { name, description }) => {
    const kind = { V: 'video', A: 'audio', S: 'subtitle' }[flags[0]];
    if (!kind) return null;
    // Wrappers name the codec they implement in a trailing parenthesis;
    // native encoders are named after it already.
    const codec = /\(codec ([\w.-]+)\)\s*$/.exec(description);
    return {
      name,
      kind,
      codec: codec ? codec[1] : name,
      description: description.replace(/\s*\(codec [\w.-]+\)\s*$/, ''),
      experimental: flags.includes('X'),
    };
  });
}

/** `  E mp4             MP4 (MPEG-4 Part 14)` */
export function parseMuxers(text) {
  return parseListing(text, (flags, { name, description }) => {
    if (!flags.includes('E')) return null;
    return { name, description };
  });
}

/**
 * Everything a format needs, present and usable.
 *
 * @param {{encoders: Array, muxers: Array}} capabilities
 * @param {{muxer: string, encoders: string[]}} format
 */
export function supportsFormat(capabilities, format) {
  if (!capabilities) return true; // nothing probed yet; do not hide anything
  return missingFor(capabilities, format).length === 0;
}

/** @returns {string[]} the names that are not available, for the error message. */
export function missingFor(capabilities, format) {
  if (!capabilities) return [];
  const encoders = new Set((capabilities.encoders || []).filter((entry) => !entry.experimental).map((entry) => entry.name));
  const muxers = new Set((capabilities.muxers || []).map((entry) => entry.name));

  const missing = format.encoders.filter((name) => !encoders.has(name));
  // A muxer listing is only checked when there is one to check against; an
  // empty listing means the probe failed, and hiding every format because of
  // that would be worse than letting a job fail with FFmpeg's own message.
  if (muxers.size && !muxers.has(format.muxer)) missing.push(format.muxer);
  return missing;
}
