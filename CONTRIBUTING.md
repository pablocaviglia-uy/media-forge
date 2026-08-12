# Contributing

Thanks for looking. The project has a few hard rules that shape everything else.

## The rules

1. **No runtime dependencies.** Not one, with the single documented exception of
   the compiled FFmpeg core in `assets/ffmpeg/`, which nobody is going to write
   by hand. Everything else gets written here or does not ship.
2. **No build step.** Native ES modules, served as-is. If you cannot open
   `index.html` through a plain file server and have it work, the change is wrong.
3. **No network at runtime.** No CDNs, no fonts, no analytics, no "phone home".
   The only fetches are same-origin requests for the app's own files — and that
   includes the core, which is why it is committed rather than pulled from unpkg.
4. **Relative paths everywhere**, so the app works from any subdirectory.
5. **Nothing leaves the tab.** Files are read into memory, converted, and handed
   back. They are not stored, not indexed, and not sent anywhere.

Development dependencies are allowed in principle, but there are none today and
that is worth keeping.

## Getting set up

```bash
node tools/serve.js     # http://localhost:8080
npm test                # node --test, no framework
```

Node 20 or newer. CI runs the tests on 20, 22 and 24.

`tools/serve.js` sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy`, so locally the page is cross-origin isolated
even though the deployed one is not. That is deliberate — it is the only place
the multi-threaded path gets exercised — but it does mean a bug that only
appears without isolation will not show up until you deploy.

Verifying or re-vendoring the FFmpeg core:

```bash
node tools/fetch-core.mjs --check  # what CI runs
node tools/fetch-core.mjs          # re-download and re-checksum
node tools/fetch-core.mjs --mt     # also vendor the multi-threaded build
```

Bump `CACHE_VERSION` in `sw.js` whenever you re-vendor. The core is cached
permanently on purpose, and without the bump nobody who has already visited will
ever see the new one.

Regenerating the icons after editing `assets/icons/icon.svg`:

```bash
node tools/make-icons.mjs
node tools/make-icons.mjs --check
node tools/make-og-image.mjs --check
```

## Tests

Anything in `src/media/` needs a test. Those are the parts with behaviour that
can silently drift.

- `tests/commands.test.js` — the command builder: that it produces the arguments
  it is supposed to, without loading WebAssembly
- `tests/core.test.js` — the same builder against the vendored core, running
  every operation end to end. The core synthesises its own test clip with
  `lavfi`, so no sample media is committed
- `tests/probe.test.js` — the ffprobe and log parsers, against real captured
  FFmpeg output
- `tests/zip.test.js` — the archive writer, including a round-trip through the
  system `unzip` where one exists

`core.test.js` is the slow one and the one that matters. An argument list can be
perfectly well-formed and still be rejected by the binary — that is how the VP9
problem was found — so a new operation is not finished until it runs there.

If a test fails because the source is wrong, fix the source. Do not weaken the
assertion.

UI code in `src/ui/`, `src/app.js` and the worker is not unit tested; verify it
in a browser and say what you checked in the pull request.

## Style

- Follow what is already there. Two-space indent, single quotes, semicolons.
- JSDoc on exported functions; explain **why** in comments, not what.
- Prefer clarity over cleverness.
- Never invent an FFmpeg argument from memory. Run it.

## Adding things

**An output format** — add it to `src/media/formats.js` with the muxer and every
encoder it needs, and `capabilities.js` will hide it automatically on a core
that lacks them. Then add a case to `tests/core.test.js`, because a format that
is listed and does not work is worse than one that is missing.

**An operation** — add it to `OPERATIONS` in `src/media/commands.js` with the
controls it needs, write its builder, and add the controls to `buildControl` in
`src/app.js`. The inspector renders from the catalogue, so it needs no other
knowledge of what your operation means.

**A preference** — `src/storage/prefs.js`, with a default and, if it is not a
boolean, a range or an enum. Anything read before first paint has to work from
the inline script in `index.html` too.

## Pull requests

Say what you changed, why, and how you verified it. Screenshots for anything
visual, and the real test output for anything else. Small and focused beats
large and comprehensive.
