/**
 * Tests for the ZIP writer.
 *
 * The archive is parsed back byte by byte rather than checked against a golden
 * file, because a golden file would only prove the writer still agrees with
 * itself. Where the system has `unzip`, the last test hands it a real archive
 * and lets a real implementation be the judge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZip, crc32Start, crc32Update, crc32Finish } from '../src/media/zip.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

function crc32(bytes) {
  return crc32Finish(crc32Update(crc32Start, bytes));
}

/** Parse just enough of a ZIP to assert on it. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL) end -= 1;
  assert.ok(end >= 0, 'no end-of-central-directory record');

  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  assert.equal(directoryStart + directorySize, end, 'central directory does not end where the EOCD begins');

  const entries = [];
  let offset = directoryStart;
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(offset, true), CENTRAL_HEADER, `entry ${i} has no central header`);
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entry = {
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      crc: view.getUint32(offset + 16, true),
      size: view.getUint32(offset + 24, true),
      localOffset,
    };

    assert.equal(view.getUint32(localOffset, true), LOCAL_HEADER, `entry ${i} has no local header`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + extraLength;
    entry.data = bytes.subarray(dataStart, dataStart + entry.size);
    entry.localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));

    entries.push(entry);
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

async function zipBytes(entries) {
  const blob = await createZip(entries);
  return new Uint8Array(await blob.arrayBuffer());
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('crc32 of nothing is zero', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('crc32 is the same whether fed at once or in chunks', () => {
  const bytes = new Uint8Array(1000).map((_, i) => (i * 31) % 256);
  let chunked = crc32Start;
  for (let i = 0; i < bytes.length; i += 7) chunked = crc32Update(chunked, bytes.subarray(i, i + 7));
  assert.equal(crc32Finish(chunked), crc32(bytes));
});

test('an archive round-trips names, sizes, contents and checksums', async () => {
  const first = new TextEncoder().encode('the first payload');
  const second = new Uint8Array(5000).map((_, i) => i % 251);

  const entries = readZip(await zipBytes([
    { name: 'clip.mp4', blob: new Blob([first]) },
    { name: 'sound.mp3', blob: new Blob([second]) },
  ]));

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.name), ['clip.mp4', 'sound.mp3']);

  for (const entry of entries) {
    assert.equal(entry.method, 0, 'entries must be stored, not deflated');
    assert.equal(entry.flags & 0x0800, 0x0800, 'the UTF-8 flag must be set');
    assert.equal(entry.localName, entry.name, 'local and central names disagree');
    assert.equal(entry.crc, crc32(entry.data));
  }

  assert.deepEqual(entries[0].data, first);
  assert.deepEqual(entries[1].data, second);
});

test('an empty archive is still a valid archive', async () => {
  assert.deepEqual(readZip(await zipBytes([])), []);
});

test('names cannot escape the extraction directory', async () => {
  const entries = readZip(await zipBytes([
    { name: '../../etc/passwd', blob: new Blob(['x']) },
    { name: '/absolute/path.mp4', blob: new Blob(['x']) },
    { name: 'C:\\Windows\\evil.mov', blob: new Blob(['x']) },
  ]));

  assert.deepEqual(entries.map((entry) => entry.name), [
    'etc/passwd',
    'absolute/path.mp4',
    'C:/Windows/evil.mov',
  ]);
  for (const entry of entries) {
    assert.ok(!entry.name.startsWith('/'), 'name is absolute');
    assert.ok(!entry.name.split('/').includes('..'), 'name climbs out');
  }
});

test('repeated names are made unique instead of overwriting each other', async () => {
  const entries = readZip(await zipBytes([
    { name: 'out.mp4', blob: new Blob(['a']) },
    { name: 'out.mp4', blob: new Blob(['b']) },
    { name: 'out.mp4', blob: new Blob(['c']) },
    { name: 'no-extension', blob: new Blob(['d']) },
    { name: 'no-extension', blob: new Blob(['e']) },
  ]));

  assert.deepEqual(entries.map((entry) => entry.name), [
    'out.mp4',
    'out (2).mp4',
    'out (3).mp4',
    'no-extension',
    'no-extension (2)',
  ]);
});

test('non-ASCII names survive as UTF-8', async () => {
  const entries = readZip(await zipBytes([{ name: 'canción — 日本語.m4a', blob: new Blob(['x']) }]));
  assert.equal(entries[0].name, 'canción — 日本語.m4a');
});

test('progress is reported monotonically and ends at one', async () => {
  const seen = [];
  await createZip(
    [
      { name: 'a.bin', blob: new Blob([new Uint8Array(3000)]) },
      { name: 'b.bin', blob: new Blob([new Uint8Array(1000)]) },
    ],
    { onProgress: (fraction) => seen.push(fraction) }
  );

  assert.ok(seen.length > 0, 'no progress was reported');
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], 'progress went backwards');
  assert.equal(seen.at(-1), 1);
});

test('a real unzip accepts the archive', async (t) => {
  let unzip;
  try {
    unzip = execFileSync('which', ['unzip'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('unzip is not installed');
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), 'media-forge-zip-'));
  try {
    const payload = new Uint8Array(20000).map((_, i) => (i * 7) % 256);
    const archive = join(directory, 'out.zip');
    writeFileSync(archive, await zipBytes([
      { name: 'clip.mp4', blob: new Blob([payload]) },
      { name: 'nested/track.mp3', blob: new Blob([new TextEncoder().encode('hello')]) },
    ]));

    execFileSync(unzip, ['-t', archive], { stdio: 'pipe' });
    execFileSync(unzip, ['-q', '-o', archive, '-d', directory], { stdio: 'pipe' });

    assert.deepEqual(new Uint8Array(readFileSync(join(directory, 'clip.mp4'))), payload);
    assert.equal(readFileSync(join(directory, 'nested', 'track.mp3'), 'utf8'), 'hello');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
