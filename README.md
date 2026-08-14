# media-forge

A video and audio converter that runs entirely in your browser. No backend, no
build step, no npm dependencies — open the page and it works, including offline.

The converter is FFmpeg itself, compiled to WebAssembly and running in the tab.
Your files are never uploaded, because there is nowhere to upload them to.

**[→ Open it](https://pablocaviglia-uy.github.io/media-forge/)**

---

## What it does

**Converting**
- Video to MP4, WebM, MKV, MOV or an animated GIF
- Audio to MP3, M4A, Opus, OGG, WAV or FLAC
- Resolution, frame rate and quality, with the source never enlarged
- Trim to a time range, rotate, flip, or drop the sound
- Extract the audio from a video, or the video's frames as images
- Compress to a target file size, in two passes
- A poster frame from any point in the clip
- Your own `ffmpeg` arguments, when none of the above is what you meant

**Working with files**
- Drag and drop files, or a whole folder
- A queue that converts one file after another, with progress and an estimate
- Cancel a conversion that is taking longer than it is worth
- Preview the source, and download the result — or all of them, as a zip
- Every file is read straight into FFmpeg's memory and never touches storage

**Being local**
- Installable as a PWA; works with the network off
- No analytics, no telemetry, no fonts or scripts from a CDN
- The FFmpeg log, in full, whenever you want to see what it actually ran

## Why it is slow

Because it is FFmpeg in a virtual machine inside a browser tab, on one core.
That is the whole trade, stated plainly:

| | Native FFmpeg | This, single-threaded | This, multi-threaded |
|---|---|---|---|
| The same WebM → MP4 job | 5.2 s | 128.8 s | 60.4 s |
| Needs a server | yes | no | no |
| Needs special headers | — | no | yes |

Those numbers are the ffmpeg.wasm project's own published benchmark. A server
would be twenty-five times faster and would also mean uploading your files to
it, waiting, and trusting whoever runs it to delete them. This project takes
the other side of that trade.

**It runs single-threaded**, and that is not an oversight. The multi-threaded
build needs `SharedArrayBuffer`, which needs the page to be cross-origin
isolated, which needs two HTTP response headers — and GitHub Pages cannot send
response headers at all. The usual workaround is a service worker that forges
them, which is unmaintained, costs up to three page loads on Safari, and does
not exist in Android WebView. For roughly a factor of two. So the single-
threaded core is the only path here — but if you host this behind a server that
*can* send `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`, the
app notices and loads the faster core by itself. `tools/serve.js` sends them, so
that path is exercised every time anyone runs it locally.

## The core is committed to this repository

`assets/ffmpeg/ffmpeg-core.wasm` is 32 MB of compiled FFmpeg 5.1.4, and unlike
everything else here, nobody can read it. So:

- It is pinned to `@ffmpeg/core` **0.12.10** and fetched from the npm registry
  by [`tools/fetch-core.mjs`](tools/fetch-core.mjs), which verifies the tarball
  against the SHA-512 the registry publishes before unpacking it
- Every extracted file's SHA-256 is recorded in
  [`assets/ffmpeg/manifest.json`](assets/ffmpeg/manifest.json), along with the
  FFmpeg version, the Emscripten version and the full `configure` line
- `node tools/fetch-core.mjs --check` re-verifies those checksums, and CI runs
  it on every push

Loading it from a CDN instead would keep the repository small, but it would
also mean the app stops working when someone else's server does, and that a
third party gets to decide what code your browser runs. Neither is a trade this
project is interested in.

## Running it

There is no build. Serve the directory over HTTP (ES modules, Web Workers and
service workers all refuse to run from `file://`):

```bash
node tools/serve.js
```

Then open <http://localhost:8080>.

Tests:

```bash
npm test
```

Re-vendor the FFmpeg core, or verify the one that is already there:

```bash
node tools/fetch-core.mjs
node tools/fetch-core.mjs --check
```

Regenerate the generated images after editing the artwork:

```bash
node tools/make-icons.mjs
node tools/make-og-image.mjs
```

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. The included workflow runs the tests and publishes the repository as-is.

Every path in the app is relative, so it works from
`pablocaviglia-uy.github.io/media-forge/` as well as from a custom domain or any
subdirectory. `.nojekyll` stops Pages from filtering files that start with `_`.

The published site is about 33 MB, nearly all of it the core. That is well
inside the 1 GB Pages limit, and the core transfers at around 10 MB gzipped and
is then cached permanently by the service worker.

## Architecture

```
index.html            Shell. Applies the stored theme before first paint.
about.html            What this is, and what it costs.
sw.js                 Service worker: pre-caches the app, serves it offline.

assets/ffmpeg/        The vendored core, its checksums and its provenance.

src/
  main.js             Bootstrap and service-worker registration
  app.js              Controller: the queue, the inspector, all UI wiring

  ffmpeg/
    client.js         Owns the worker; one job at a time, cancel by terminate
    capabilities.js   Parses `-encoders` and `-muxers` into what is offerable

  media/
    formats.js        The output formats, and what each needs from the core
    commands.js       {source, operation, options} -> exact ffmpeg arguments
    probe.js          ffprobe JSON, the log as a fallback, and progress
    zip.js            A store-only ZIP writer, for "download all"

  worker/
    ffmpeg.worker.js  Instantiates the core, runs plans, reports progress

  storage/
    prefs.js          Preferences in localStorage

  ui/                 DOM helpers, formatting, downloads
```

A conversion goes: file dropped → probed with `ffprobe` → the inspector builds
`options` → `commands.js` turns those into a plan of one or more invocations →
the worker writes the input into FFmpeg's in-memory filesystem and runs each
step → progress arrives on FFmpeg's `-progress` pipe → the outputs are
transferred back as bytes and turned into a `Blob`. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the details.

### Why the queue converts one file at a time

FFmpeg here is a single WebAssembly instance with a single in-memory filesystem
and a single set of process globals. Two conversions sharing it would write
over each other's files. Running two instances would mean two 32 MB cores
competing for the same 2 GB heap ceiling that already limits how large one file
can be. So the queue is a queue.

## Security

The app makes no network requests after it loads, has no server to talk to, and
stores nothing: files live in memory for as long as their job does. There is no
`innerHTML` path that user data can reach, and file names — the only text that
comes from outside — are set as `textContent`.

The parts worth auditing are the ones that parse untrusted bytes:
[`src/media/probe.js`](src/media/probe.js) reads FFmpeg's own output, and
[`src/media/zip.js`](src/media/zip.js) writes archive entry names, where it
strips `..` segments and leading slashes so an archive cannot write outside the
directory it is extracted to.

FFmpeg itself is a large C codebase parsing hostile input, which is exactly why
running it in a WebAssembly sandbox in a tab is a better place for it than on a
server with a filesystem.

Found a hole? See [SECURITY.md](SECURITY.md).

## Limits

Worth knowing before you file an issue:

- **Large files fail.** The heap is 32-bit and capped at 2 GB, and the input,
  the output and the codec's working memory are all in it at once. The app
  refuses anything over 500 MB and warns above 150 MB, and even that is
  optimistic on a phone.
- **WebM output is VP8, not VP9.** `libvpx-vp9` is compiled into the core and
  listed by `-encoders`, but on a freshly instantiated core it traps with
  "memory access out of bounds" before the first frame. It is not simply
  broken: after roughly forty invocations on the same instance it starts
  working, which is worse — the engine is new on every page load, so a real
  first conversion always lands in the range where it takes the whole instance
  down. There is a test that runs it on a fresh core and will fail the day that
  changes.
- **There is no HEVC output, and `libx265` is the reason rather than the
  remedy.** It is compiled in and listed by `-encoders`, and asking it to encode
  a single frame never returns — not slowly, at all: no error, no exit code, no
  CPU. That is worse than the VP9 trap above, because a trap at least ends and
  the worker can report it, while a call that never returns takes the worker's
  event loop with it, so cancelling cannot be heard and progress simply stops.
  Four argument shapes were measured, including `pools=none:frame-threads=1`,
  and all four hang the same way. There is a test that runs it in a process with
  a clock on it and will fail the day it returns.
- **HEVC and VP9 files can still be repackaged**, because copying a stream never
  invokes an encoder. An MP4 of HEVC from a phone becomes an MKV in seconds with
  nothing decoded, which is the only thing this app can usefully do with one.
- **There is no AV1 or ProRes output.** AV1 has no encoder here at all. ProRes
  has three, and none is offered: the format exists to be edited, and a ProRes
  file large enough to be worth making is far past the heap ceiling above.
- **One engine does not last a whole session.** Whatever it is asked to do, a
  single instance eventually traps with "memory access out of bounds" — around
  the seventieth invocation for `-version` or a small MP3 encode, around the
  hundred and sixtieth for a small video encode. The counts move between runs.
  The app notices, throws the instance away and builds a fresh one, so the cost
  is one failed job and a few seconds recompiling rather than a broken tab, but
  a long queue can meet it.
- **Progress is an estimate.** It comes from the output timestamp FFmpeg has
  reached, so a two-pass job reports each pass as half the work whether or not
  it takes half the time.
- **Everything is per tab.** Closing it loses the queue. Nothing is persisted
  because nothing should be: these are your files.
- Browsers vary: module workers need Firefox 114+ or Safari 15+, and the
  threaded core needs headers no static host sends by default.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: no dependencies, no
build step, and anything in `src/media/` needs a test.

## License

[GPL-2.0-or-later](LICENSE).

This is not a preference. The vendored core is built with `--enable-gpl` and
links libx264 and libx265, and `@ffmpeg/core` is published as GPL-2.0-or-later;
distributing that binary alongside this code makes the whole distribution GPL.
[THIRD-PARTY.md](THIRD-PARTY.md) sets out exactly what is bundled, under what
terms, and how to rebuild a core that is not.
