/**
 * Vendor the FFmpeg WebAssembly core, verifiably.
 *
 * The core is the one thing in this repository that is not written here: 30 MB
 * of compiled FFmpeg that nobody can read. The least this project can do is
 * make it checkable — so this downloads the tarball straight from the npm
 * registry, checks it against the SHA-512 the registry publishes, unpacks it
 * without a dependency, and records a SHA-256 of every extracted file in
 * `assets/ffmpeg/manifest.json`. `--check` re-verifies those checksums, which
 * is what CI runs.
 *
 *   node tools/fetch-core.mjs            # vendor the single-threaded core
 *   node tools/fetch-core.mjs --mt       # also vendor the multi-threaded one
 *   node tools/fetch-core.mjs --check    # verify what is already vendored
 *
 * The tar reader below is about forty lines because npm tarballs are plain
 * gzipped ustar with five files in them; pulling in a tar library to read that
 * would cost more than it saves.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT = join(ROOT, 'assets', 'ffmpeg');
const MANIFEST = join(OUT, 'manifest.json');

/**
 * Pinned deliberately. A floating version would mean the checksums in the
 * manifest describe whatever happened to be published the day someone ran
 * this, which defeats the point of having them.
 */
const VERSION = '0.12.10';

const VARIANTS = {
  st: {
    package: '@ffmpeg/core',
    threads: false,
    requiresCrossOriginIsolation: false,
    directory: '.',
    files: { core: 'ffmpeg-core.js', wasm: 'ffmpeg-core.wasm' },
  },
  mt: {
    package: '@ffmpeg/core-mt',
    threads: true,
    requiresCrossOriginIsolation: true,
    directory: 'mt',
    files: { core: 'ffmpeg-core.js', wasm: 'ffmpeg-core.wasm', worker: 'ffmpeg-core.worker.js' },
  },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512Base64 = (bytes) => createHash('sha512').update(bytes).digest('base64');

/* ------------------------------------------------------------------ *
 * Tar
 * ------------------------------------------------------------------ */

const readOctal = (bytes) => {
  const text = new TextDecoder().decode(bytes).replace(/\0.*$/, '').trim();
  return text ? parseInt(text, 8) : 0;
};

/**
 * Read a ustar archive into a `path -> bytes` map.
 *
 * Handles the two extensions npm actually emits: GNU long names (`L`) and pax
 * extended headers (`x`), both of which override the path of the entry that
 * follows them. Everything else that is not a regular file is skipped.
 */
function untar(buffer) {
  const decoder = new TextDecoder();
  const files = new Map();
  let override = null;

  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive padding

    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const size = readOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]) || '0';
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, '');

    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      override = decoder.decode(body).replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'X') {
      const path = /\d+ path=(.*)\n/.exec(decoder.decode(body));
      override = path ? path[1] : null;
      continue;
    }
    if (type !== '0' && type !== '\0') {
      override = null;
      continue;
    }

    files.set(override || (prefix ? `${prefix}/${name}` : name), Buffer.from(body));
    override = null;
  }

  return files;
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

/** Download one package version and return its files, integrity-checked. */
async function download(packageName, version) {
  const metadata = await fetchJson(`https://registry.npmjs.org/${packageName}/${version}`);
  const { tarball, integrity } = metadata.dist;

  process.stdout.write(`  ${packageName}@${version} … `);
  const response = await fetch(tarball);
  if (!response.ok) throw new Error(`${tarball} responded ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  process.stdout.write(`${(archive.length / 1e6).toFixed(1)} MB\n`);

  // The registry publishes `sha512-<base64>`; anything else is a mismatch we
  // should refuse rather than guess at.
  const expected = String(integrity || '');
  if (!expected.startsWith('sha512-')) throw new Error(`${packageName} has no sha512 integrity to check against`);
  const actual = `sha512-${sha512Base64(archive)}`;
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${packageName}@${version}\n  expected ${expected}\n  actual   ${actual}`);
  }
  console.log(`  integrity ok (${expected.slice(0, 24)}…)`);

  return { files: untar(gunzipSync(archive)), integrity: expected, license: metadata.license };
}

/* ------------------------------------------------------------------ *
 * Vendoring
 * ------------------------------------------------------------------ */

async function vendor(names) {
  const manifest = {
    comment:
      'Written by tools/fetch-core.mjs. The app reads `variants` to decide which core it may load; ' +
      'the checksums exist so anyone can prove the vendored bytes are the published ones.',
    package: VARIANTS.st.package,
    version: VERSION,
    license: 'GPL-2.0-or-later',
    npmIntegrity: null,
    ffmpeg: existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')).ffmpeg : null,
    variants: {},
  };

  for (const name of names) {
    const variant = VARIANTS[name];
    console.log(`\n${name === 'st' ? 'Single-threaded' : 'Multi-threaded'} core:`);
    const { files, integrity, license } = await download(variant.package, VERSION);
    if (license && license !== manifest.license) {
      console.warn(`  warning: ${variant.package} declares "${license}", not ${manifest.license}`);
    }
    if (name === 'st') manifest.npmIntegrity = integrity;

    const directory = join(OUT, variant.directory);
    mkdirSync(directory, { recursive: true });

    const entry = { threads: variant.threads, requiresCrossOriginIsolation: variant.requiresCrossOriginIsolation, files: {} };
    for (const [role, filename] of Object.entries(variant.files)) {
      // The ESM build is the one this app loads; the UMD copy is dead weight.
      const bytes = files.get(`package/dist/esm/${filename}`);
      if (!bytes) throw new Error(`${variant.package} does not contain dist/esm/${filename}`);
      writeFileSync(join(directory, filename), bytes);
      entry.files[role] = {
        path: `./${variant.directory === '.' ? '' : `${variant.directory}/`}${filename}`,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
      console.log(`  wrote ${filename} (${(bytes.length / 1e6).toFixed(2)} MB)`);
    }
    manifest.variants[name] = entry;
  }

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote ${MANIFEST.replace(`${ROOT}/`, '')}`);
  console.log('Run `node tools/fetch-core.mjs --check` to verify, and update THIRD-PARTY.md if the version changed.');
}

/** Re-verify the vendored files against the manifest. This is what CI runs. */
function check() {
  if (!existsSync(MANIFEST)) {
    console.error('assets/ffmpeg/manifest.json is missing. Run `node tools/fetch-core.mjs` first.');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  let failures = 0;

  for (const [name, variant] of Object.entries(manifest.variants || {})) {
    for (const [role, file] of Object.entries(variant.files)) {
      const path = join(OUT, file.path);
      if (!existsSync(path)) {
        console.error(`✗ ${name}/${role}: ${file.path} is missing`);
        failures += 1;
        continue;
      }
      const bytes = readFileSync(path);
      const size = statSync(path).size;
      if (size !== file.bytes) {
        console.error(`✗ ${name}/${role}: ${size} bytes, manifest says ${file.bytes}`);
        failures += 1;
        continue;
      }
      const digest = sha256(bytes);
      if (digest !== file.sha256) {
        console.error(`✗ ${name}/${role}: sha256 ${digest}\n  manifest says ${file.sha256}`);
        failures += 1;
        continue;
      }
      console.log(`✓ ${name}/${role}  ${file.path}  ${(size / 1e6).toFixed(2)} MB`);
    }
  }

  if (failures) {
    console.error(`\n${failures} file(s) do not match the manifest.`);
    process.exit(1);
  }
  console.log(`\nAll vendored files match manifest.json (${manifest.package}@${manifest.version}).`);
}

const flags = process.argv.slice(2);
if (flags.includes('--check')) {
  check();
} else {
  await vendor(flags.includes('--mt') ? ['st', 'mt'] : ['st']);
}
