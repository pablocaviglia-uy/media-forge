/**
 * A ZIP writer, in about 150 lines and with no dependencies.
 *
 * "Download all" is the one place this app has to invent a container format,
 * and pulling in a compression library for it would be absurd: every file it
 * packs is already compressed video or audio, so deflating them wastes CPU to
 * save nothing. Every entry is therefore stored (method 0), which makes the
 * writer small enough to read in one sitting.
 *
 * Memory matters here — a queue of results can easily be a gigabyte. The
 * output is assembled as a `Blob` built from the header byte arrays and the
 * original result blobs, so the payloads are never copied into JavaScript
 * memory; the browser keeps them wherever it already had them. Only the CRC
 * pass touches the bytes, and it does so in chunks it immediately discards.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Bit 11: the name and comment are UTF-8. We always encode them that way. */
const FLAG_UTF8 = 0x0800;

/**
 * Anything at or past this needs Zip64, which this writer does not implement.
 * Four gigabytes of output is far past the point where the browser would have
 * run out of memory converting it anyway.
 */
const MAX_SIZE = 0xffffffff;

let crcTable = null;

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** Feed bytes in, one chunk at a time; `crc32Finish` closes it out. */
export function crc32Update(crc, bytes) {
  if (!crcTable) crcTable = buildCrcTable();
  let value = crc;
  for (let i = 0; i < bytes.length; i += 1) {
    value = crcTable[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

export const crc32Start = 0xffffffff;
export const crc32Finish = (crc) => (crc ^ 0xffffffff) >>> 0;

/** CRC of a whole blob, read in chunks so a large file never lands in memory. */
async function crcOfBlob(blob, onBytes) {
  let crc = crc32Start;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    crc = crc32Update(crc, value);
    if (onBytes) onBytes(value.length);
  }
  return crc32Finish(crc);
}

/**
 * MS-DOS date and time, which is what ZIP stores: two-second resolution and an
 * epoch of 1980. Dates before that clamp rather than wrap.
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** A little-endian byte writer, sized up front because every record is fixed. */
function record(length) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  return {
    bytes,
    u16(value) {
      view.setUint16(offset, value, true);
      offset += 2;
    },
    u32(value) {
      view.setUint32(offset, value >>> 0, true);
      offset += 4;
    },
    raw(source) {
      bytes.set(source, offset);
      offset += source.length;
    },
  };
}

/**
 * Names inside a ZIP use forward slashes and cannot start with one, cannot
 * contain `..` segments, and cannot contain a NUL. An archive that ignores
 * that is an archive that can write outside the directory it is extracted to.
 */
function safeName(name) {
  const cleaned = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .replace(/[\u0000-\u001f\u007f]/g, '');
  return cleaned || 'file';
}

/** Append " (2)", " (3)" … before the extension until the name is unused. */
function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Pack `entries` into a ZIP.
 *
 * @param {Array<{name: string, blob: Blob, date?: Date}>} entries
 * @param {{onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<Blob>}
 */
export async function createZip(entries, { onProgress } = {}) {
  const encoder = new TextEncoder();
  const taken = new Set();
  const parts = [];
  const directory = [];
  let offset = 0;

  const totalBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
  let hashedBytes = 0;

  for (const entry of entries) {
    const name = encoder.encode(uniqueName(safeName(entry.name), taken));
    const size = entry.blob.size;
    const stamp = dosDateTime(entry.date instanceof Date ? entry.date : new Date());

    const crc = await crcOfBlob(entry.blob, (length) => {
      hashedBytes += length;
      if (onProgress && totalBytes) onProgress(hashedBytes / totalBytes);
    });

    const local = record(30 + name.length);
    local.u32(LOCAL_HEADER);
    local.u16(20); // version needed to extract: 2.0
    local.u16(FLAG_UTF8);
    local.u16(0); // stored
    local.u16(stamp.time);
    local.u16(stamp.date);
    local.u32(crc);
    local.u32(size);
    local.u32(size);
    local.u16(name.length);
    local.u16(0); // no extra field
    local.raw(name);

    parts.push(local.bytes, entry.blob);
    directory.push({ name, crc, size, stamp, offset });
    offset += local.bytes.length + size;

    if (offset > MAX_SIZE) {
      throw new Error('Archive is larger than 4 GB, which needs Zip64. Download the files individually.');
    }
  }

  const centralStart = offset;
  for (const item of directory) {
    const central = record(46 + item.name.length);
    central.u32(CENTRAL_HEADER);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(FLAG_UTF8);
    central.u16(0); // stored
    central.u16(item.stamp.time);
    central.u16(item.stamp.date);
    central.u32(item.crc);
    central.u32(item.size);
    central.u32(item.size);
    central.u16(item.name.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(item.offset);
    central.raw(item.name);

    parts.push(central.bytes);
    offset += central.bytes.length;
  }

  const end = record(22);
  end.u32(END_OF_CENTRAL);
  end.u16(0); // this disk
  end.u16(0); // disk with the central directory
  end.u16(directory.length);
  end.u16(directory.length);
  end.u32(offset - centralStart);
  end.u32(centralStart);
  end.u16(0); // no comment
  parts.push(end.bytes);

  return new Blob(parts, { type: 'application/zip' });
}
