# Third-party code

One thing in this repository was not written here: the compiled FFmpeg core
under `assets/ffmpeg/`. Everything else — every line of JavaScript, CSS and
HTML, and the tooling — is original work under the licence in [LICENSE](LICENSE).

## What is bundled

| | |
|---|---|
| Package | [`@ffmpeg/core`](https://www.npmjs.com/package/@ffmpeg/core) 0.12.10 |
| Files | `assets/ffmpeg/ffmpeg-core.js` (112 KB), `assets/ffmpeg/ffmpeg-core.wasm` (32 MB) |
| Contains | FFmpeg 5.1.4, compiled with Emscripten 3.1.40 |
| Licence | **GPL-2.0-or-later** |
| Upstream | <https://github.com/ffmpegwasm/ffmpeg.wasm> |
| Integrity | `sha512-dzNplnn2Nxle2c2i2rrDhqcB19q9cglCkWnoMTDN9Q9l3PvdjZWd1HfSPjCNWc/p8Q3CT+Es9fWOR0UhAeYQZA==` |

Per-file SHA-256 checksums are in
[`assets/ffmpeg/manifest.json`](assets/ffmpeg/manifest.json), together with the
full `configure` line the binary reports for itself. `node
tools/fetch-core.mjs --check` verifies them, and CI runs it on every push.

Note that the ffmpeg.wasm project splits its licensing: the JavaScript wrapper
`@ffmpeg/ffmpeg` is MIT, and it is the package most write-ups are talking
about. This project does not use that wrapper — it drives `@ffmpeg/core`
directly — and `@ffmpeg/core` is the GPL half.

## Why the whole project is GPL

FFmpeg defaults to LGPL 2.1. The build in `@ffmpeg/core` is not the default: it
is configured with

```
--enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx --enable-libmp3lame
--enable-libtheora --enable-libvorbis --enable-libopus --enable-zlib --enable-libwebp
--enable-libfreetype --enable-libfribidi --enable-libass --enable-libzimg
```

`--enable-gpl` activates GPL-licensed parts, and [FFmpeg's own legal
page](https://ffmpeg.org/legal.html) is explicit that at that point the GPL
applies to all of FFmpeg. libx264 and libx265 are GPL libraries. npm publishes
`@ffmpeg/core@0.12.10` with `"license": "GPL-2.0-or-later"`, which agrees.

This repository ships that binary and deploys it. That makes the distributed
work as a whole GPL-2.0-or-later, and no licence chosen for the JavaScript
around it changes that. Calling the source MIT while shipping the binary would
be a claim this project could not stand behind, so the source is GPL too and
the two match.

H.264 and H.265 also carry patent obligations, which are a separate question
from copyright and are not addressed by any licence. If you deploy this
somewhere that matters, that is yours to look into.

## Building a core that is not GPL

If you want an LGPL 2.1 core, rebuild it without the GPL parts. The upstream
`Dockerfile` and `build/*.sh` scripts do all of it; drop `--enable-gpl`,
`--enable-libx264` and `--enable-libx265`, and put the result in
`assets/ffmpeg/` with an updated `manifest.json`.

What you lose is H.264 and H.265 **encoding**, which means no MP4, MKV or MOV
output — FFmpeg's native H.264 *decoder* is LGPL and survives, so those files
still open. VP8, Opus, Vorbis, MP3, FLAC and WAV all remain, so WebM and every
audio format keep working. For a general-purpose converter that is a severe
cut, which is why this project did not make it.

## Attribution

This software uses libraries from the FFmpeg project under the GPLv2 or later.
FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
