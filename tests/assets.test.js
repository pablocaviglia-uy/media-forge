/**
 * That the service worker's pre-cache list still describes the app.
 *
 * This exists because the list is the one place in the project that has to be
 * updated by hand whenever a file is added, and forgetting is silent: the app
 * works perfectly in development, works online, and is missing its stylesheet
 * the first time someone opens it on a plane. It has already happened once —
 * `app.css` was written after `sw.js` was, and went unlisted.
 *
 * So the test walks the directory rather than trusting anybody's memory.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Directories that hold no part of the running app. */
const NOT_THE_APP = new Set(['.git', '.github', 'node_modules', 'tools', 'tests', 'docs']);

/** Extensions the browser will ask for while running the app. */
const SERVED = /\.(?:html|css|js|webmanifest|svg|png)$/;

function walk(directory = ROOT, found = []) {
  for (const entry of readdirSync(directory)) {
    if (NOT_THE_APP.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(`./${relative(ROOT, path)}`);
  }
  return found;
}

const precache = (() => {
  const source = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const block = /const PRECACHE = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'sw.js has no PRECACHE array to check');
  // Comments inside the array explain the exclusions; strip them so a path
  // mentioned in prose is not mistaken for a path that is listed.
  const withoutComments = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((match) => match[1]);
})();

describe('the service worker pre-cache list', () => {
  test('names nothing that does not exist', () => {
    const absent = precache.filter((path) => path !== './' && !existsSync(join(ROOT, path)));
    assert.deepEqual(absent, [], `sw.js pre-caches files that are not here:\n  ${absent.join('\n  ')}`);
  });

  test('has no duplicates', () => {
    const seen = new Set();
    const twice = precache.filter((path) => (seen.has(path) ? true : (seen.add(path), false)));
    assert.deepEqual(twice, []);
  });

  test('covers every file the app serves', () => {
    // The FFmpeg core is the documented exception: 32 MB pre-cached at install
    // would hold the whole installation hostage to one download, so the fetch
    // handler caches it on first use instead. `sw.js` itself is fetched by the
    // browser directly and must never be cached by a version of itself.
    const exempt = (path) => path === './sw.js' || /ffmpeg-core\.wasm$/.test(path);

    const served = walk().filter((path) => SERVED.test(path) && !exempt(path));
    const listed = new Set(precache);
    const unlisted = served.filter((path) => !listed.has(path));

    assert.deepEqual(
      unlisted,
      [],
      `these are served but not pre-cached, so the app is broken offline:\n  ${unlisted.join('\n  ')}`
    );
  });

  test('is versioned, so re-vendoring the core can invalidate it', () => {
    const source = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert.match(source, /const CACHE_VERSION = '[^']+';/);
    assert.match(source, /const CACHE_NAME = `media-forge-\$\{CACHE_VERSION\}`;/);
  });
});

describe('the app loads nothing from another origin', () => {
  /**
   * Subresources only. A link a person can click is not a request the browser
   * makes, so `<a href="https://github.com/…">` is fine and always has been;
   * what must not exist is a stylesheet, script, font or image fetched from
   * somewhere this project does not control.
   */
  test('no script, stylesheet, font or image is fetched off-origin', () => {
    const offenders = [];

    for (const path of walk().filter((file) => /\.(?:html|css|js)$/.test(file))) {
      // The vendored core is minified upstream code that mentions URLs in
      // strings it never fetches; it is verified by checksum instead.
      if (path.includes('assets/ffmpeg/')) continue;
      const source = readFileSync(join(ROOT, path), 'utf8');

      for (const match of source.matchAll(/<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)/gi)) {
        // `rel="canonical"` names the deployed site rather than loading it.
        if (/rel\s*=\s*["']?canonical/i.test(match[0])) continue;
        offenders.push(`${path}: <link> ${match[1]}`);
      }
      for (const match of source.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)/gi)) {
        offenders.push(`${path}: src ${match[1]}`);
      }
      for (const match of source.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/gi)) {
        offenders.push(`${path}: url() ${match[1]}`);
      }
      for (const match of source.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"')]+)/gi)) {
        offenders.push(`${path}: @import ${match[1]}`);
      }
    }

    assert.deepEqual(offenders, [], `the app must not load anything from another origin:\n  ${offenders.join('\n  ')}`);
  });

  test('no code fetches an absolute URL at runtime', () => {
    const offenders = [];
    for (const path of walk().filter((file) => file.endsWith('.js'))) {
      if (path.includes('assets/ffmpeg/')) continue;
      const source = readFileSync(join(ROOT, path), 'utf8');
      for (const match of source.matchAll(/\bfetch\(\s*["'`](https?:\/\/[^"'`]+)/g)) {
        offenders.push(`${path}: fetch ${match[1]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
