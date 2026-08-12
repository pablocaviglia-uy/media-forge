# Security

## Reporting

Open a [private security advisory](https://github.com/pablocaviglia-uy/media-forge/security/advisories/new)
rather than a public issue. Please include the file that triggers the problem,
or a way to generate one.

## Threat model

The app opens media files from wherever the user got them and hands them to
FFmpeg — a large C codebase whose job is parsing hostile input, with a long
history of memory-safety bugs to prove it. That is the interesting surface.

What the app is **not** exposed to: there is no server, no account, no session,
no cross-origin request, and no data ever leaves the device. Nothing is
persisted either — files live in memory for as long as their conversion does
and are unlinked afterwards — so there is no stored corpus for a successful
attack to reach.

## Defences

**FFmpeg runs in a WebAssembly sandbox, in a Worker.** A memory-safety bug in a
demuxer cannot read outside the module's linear memory, cannot reach the DOM,
cannot open a file, and cannot make a network request. The realistic outcome of
feeding it a malicious file is that the worker traps and dies, which the app
already handles: `src/ffmpeg/client.js` treats a trap as fatal and replaces the
worker rather than sending it more work. This is a far better place to run
FFmpeg than a server with a filesystem and credentials.

**Nothing from a file reaches the DOM as markup.** File names, FFmpeg's log
output and error messages are all set with `textContent`. The app has no
`innerHTML` path that untrusted data can reach.

**Arguments are passed as an array, never as a string.** There is no shell
between the app and FFmpeg, so there is no shell injection to have. The "raw
command" feature parses what you type with `splitArguments` in
`src/media/commands.js`, which handles quoting and escaping and deliberately
does *not* glob, expand variables, or interpret `|`, `;`, `&&` or backticks.
Whatever you write is passed to FFmpeg verbatim, which is the point of the
feature and the limit of what it can do.

**Archive entry names are sanitised.** `src/media/zip.js` strips `..` segments,
leading slashes, drive-letter paths and control characters, so a "download all"
archive cannot write outside the directory it is extracted into.

**The vendored core is verifiable.** `assets/ffmpeg/manifest.json` records a
SHA-256 for every file, `tools/fetch-core.mjs --check` verifies them, and CI
runs it on every push. The fetch itself checks the npm registry's published
SHA-512 before unpacking. See [THIRD-PARTY.md](THIRD-PARTY.md).

## Known, accepted limitations

- **FFmpeg 5.1.4 is not the current release.** It is what `@ffmpeg/core@0.12.10`
  ships, and the upstream project has not published since 2025. Known CVEs
  against 5.1.x therefore apply. The sandbox is what makes that acceptable
  rather than alarming; if it stops being acceptable, the answer is a rebuilt
  core, and `tools/fetch-core.mjs` is where you would point it.
- **The 2 GB heap is a denial of service on yourself.** A large enough file
  kills the worker. The app refuses over 500 MB to make that a message rather
  than a crash, but the limit is a guess and a small file can still be
  expensive to decode.
- **The app runs with whatever Content-Security-Policy the host sends.** GitHub
  Pages sends none. If you self-host, a strict CSP is a good idea; note that
  `script-src` must include `'wasm-unsafe-eval'`, or the core will not
  instantiate and the app will not start at all.
- **Cross-origin isolation is off on GitHub Pages**, which is why the
  single-threaded core is used. That is a performance consequence, not a
  security one: `SharedArrayBuffer` is gated behind isolation precisely because
  of Spectre, and not having it is the safe side of that trade.
