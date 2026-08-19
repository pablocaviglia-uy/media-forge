# Architecture

How the pieces fit, and why they are shaped that way.

## The constraint that drives everything

The app must run from a static host with no backend and no build step, and the
conversion engine is a 32 MB WebAssembly module that runs synchronously, can
only do one thing at a time, cannot be interrupted, and shares a 2 GB heap
between the file going in and the file coming out.

Almost everything below is a consequence of that sentence.

## The pipeline

```
  a file arrives                      app.js
        │
        ├── refuse it if it is over 500 MB          app.js
        │
        ├── save a recoverable project copy ──────► storage/projects.js
        │     manifest + source File/Blob             IndexedDB
        │
        ├── probe ────────────────────────────────► worker
        │     ffprobe -print_format json -o report.json
        │     parseProbeJson(report)                 media/probe.js
        │     ↳ if that yields nothing:
        │       ffmpeg -i file, parseProbe(log)
        │
        ├── the inspector renders from the catalogue
        │     operationsFor(info)                    media/commands.js
        │     buildControl(control, job)             app.js
        │
        ├── buildPlan(source, operation, options)    media/commands.js
        │     ↳ { steps: [{args}], inputNames, outputs, mime, duration }
        │
        ├── run ──────────────────────────────────► worker
        │     FS.writeFile(input)
        │     for each step: reset(); exec(-progress pipe:1, ...args)
        │     progress ◄──── out_time_us= on the pipe
        │     FS.readFile(output).slice()
        │
        └── outputs come back as transferred bytes ──► Blob
              ├── save the new project revision ──► IndexedDB
              └── download on explicit request
```

Every arrow crossing to the worker is a `postMessage` carrying an id, and every
reply carries the same id back. A reply that forgets it is a promise that never
settles, which is a mistake worth making only once.

## Local projects

There are two browser-storage layers, with deliberately different jobs:

- `localStorage` holds only small preferences that must be available before
  first paint, including whether project autosave is enabled. It is synchronous
  and far too small for media.
- IndexedDB holds versioned project records and their `File`/`Blob` values. It
  is asynchronous, transactional and can store the bytes without turning them
  into base64. There is no server-side copy and the service worker's Cache
  Storage contains app assets only, never user media.

`storage/projects.js` is the boundary around IndexedDB. UI code deals in
project snapshots rather than object-store requests, which keeps schema
migrations, validation, quota failures and test doubles out of `app.js`.
Identifiers come from `storage/ids.js`; a counter that restarts at one would
collide with a restored project after every reload.

Schema v1 uses five stores: `projects`, `assets`, `outputs`, `blobs` and
`meta`. Media bytes live only in `blobs`; descriptors and editing state stay
small, and stable blob identities mean an option edit does not rewrite a
500 MB source. A workspace revision provides optimistic conflict detection.
`BroadcastChannel` announces commits to other tabs; a tab that sees an external
change stops autosaving and asks for a reload instead of silently overwriting
the other editor.

Autosave is continuous. Source changes and completed outputs are written when
they happen, while option-only changes are coalesced so dragging a control does
not open dozens of transactions. `pagehide` requests one final best-effort save
after flushing preferences, but correctness never depends on an asynchronous
unload write that the browser is free to cut short.

Startup hydrates manifests before the engine is needed. Runtime-only state —
object URLs, DOM references, worker handles and progress clocks — is rebuilt,
not serialized. A project that was `queued` or `running` when the page vanished
returns as interrupted work that can be started again; FFmpeg cannot resume an
encode in the middle. Object URLs are always revoked on the same lifecycle as
in-memory previews.

The browser owns the quota. `navigator.storage.estimate()` gives the Settings
sheet a useful, approximate usage report, and `navigator.storage.persist()` can
request protection from storage-pressure eviction after an explicit user
action. Neither is a promise of a particular number of bytes. A failed or full
database does not make the in-memory editor or converter unusable. If media
bytes exceed quota but metadata still fits, the edit graph is preserved and
the restored project asks the user to reconnect its original files. A failed
replacement output never evicts the last output that was already durable.

Turning autosave off stops new writes; it intentionally does not destroy data
as a side effect of a checkbox. Removing a project removes its stored record,
and the destructive Settings action clears every local project. Clearing site
data or ending a private-browsing session can do the same outside the app.

## One job at a time

`src/ffmpeg/client.js` owns exactly one worker, which owns exactly one core.
Probing a newly dropped file and converting a queued one use the same
instance, so `app.js` puts everything that touches the engine on a single
promise chain and lets it queue.

The temptation is to run several. It does not survive contact with the details:
the core has one in-memory filesystem, so two jobs would overwrite each other's
`input.mp4`; and a second instance means a second 32 MB core competing for the
heap ceiling that already decides how large one file can be.

## Cancelling means killing the worker

`exec` is a synchronous call into WebAssembly. While it runs, the worker's
event loop does not turn: a `postMessage` asking it to stop will be sitting
unread in the queue until the encode it is meant to interrupt has finished.
There is no flag and no signal.

So cancelling calls `terminate()`, and the next job instantiates a fresh core.
The `.wasm` comes back out of the HTTP cache, so the cost is compiling it
again rather than downloading it again — a second or two, and the only honest
option available.

The same path handles a trap. When FFmpeg dies inside WebAssembly the heap is
unrecoverable, so the worker marks the failure `fatal` and the client discards
the instance rather than sending it more work.

## Progress, and why it needs a pipe

FFmpeg's familiar `frame= ... time= ... speed=` status line is written with a
carriage return and no newline, because it is meant to overwrite itself in a
terminal. The runtime this core is compiled against flushes its output buffer
on newlines. The two facts together mean every status line of a five-minute
encode arrives in one burst, when the encode is over.

`-progress pipe:1` writes the same numbers as newline-terminated `key=value`
blocks, so they arrive while there is still something to report. The worker
accumulates a block until `progress=continue` closes it, then reports it. The
status line is still parsed where it does show up, and the core's own
`setProgress` hook feeds the same reporter as a third source — it is too coarse
to rely on alone but it keeps working for outputs that print nothing.

The estimate is not built on FFmpeg's `speed=`. That figure is wildly
optimistic while the encoder warms up — it will claim 3× on the first block of
a job that finishes at 0.9× — so the remaining time comes from elapsed
wall-clock over fraction complete, which is noisier at the start and correct by
the middle.

## Verbosity is a process global

The core keeps one FFmpeg process alive for the whole session, and FFmpeg's log
level is a global inside it. A `-v quiet` from a probe, or a debug level left
over from anything else, therefore decides how much the *next* invocation
prints — and `-loglevel info` does not reliably bring it back down.

Two consequences, both load-bearing:

- `ffprobe` writes its report to a file with `-o` instead of to stdout. At debug
  verbosity the core interleaves decoder trace lines *inside* the JSON object,
  and no amount of careful parsing recovers from that.
- The log parser tolerates the extra fields that appear on a stream line above
  `info` verbosity (`Stream #0:0[0x1](und), 1, 1/44100:`) rather than assuming
  they will not be there.

## Two probes, one shape

`ffprobe` is compiled into the same core as `ffmpeg`, so metadata comes from
`-print_format json`: exact, typed, and unambiguous. Occasionally it declines a
file that `ffmpeg -i` will still describe perfectly well in its banner, so
`parseProbe` reads that banner as a fallback. Both produce the same object, and
`tests/core.test.js` runs them against the same file and asserts they agree.

## Capabilities are asked for, not assumed

Which codecs a build of FFmpeg contains is a property of that build. So at
startup the worker runs `-encoders` and `-muxers`, parses the tables, and hands
the result to the UI, which offers only the formats whose encoder and muxer are
actually present. The flag column in those tables is a different width in
FFmpeg 5 than in FFmpeg 8, so the parser measures it from the row of dashes on
the separator line rather than guessing.

This is also how the app would behave correctly on an LGPL core built without
libx264: MP4 would simply not be offered, instead of being offered and failing.

## The command builder is pure

`src/media/commands.js` takes a description of the source and what the user
asked for and returns arguments. It touches no DOM, no worker and no file,
which is why every operation is testable in milliseconds and why the "show me
the command" panel can print the array that is about to run rather than a
plausible reconstruction of it.

Two operations need more than one invocation, and both are two passes in every
FFmpeg tutorial ever written: a GIF builds a palette from the clip before
quantising against it, and a size target measures before it commits to a
bitrate. The plan is therefore a list of steps, and the progress reporter scales
each one into its slice of the whole.

## Memory

The heap is 32-bit and capped at 2 GB by the build. Inside it live the input,
the output, and whatever the codec needs to work — and before any of that, the
browser hands back an `ArrayBuffer` of the whole input file to be copied in.
The practical ceiling is far below 2 GB.

The app refuses files over 500 MB and warns above 150 MB, which is a guess but
an honest one: the alternative is letting people discover the limit as
`Array buffer allocation failed`. Output bytes are `slice()`d out of the heap
so the copy survives the buffer being freed, transferred to the main thread
rather than cloned, and every file the job created is unlinked afterwards so
one job's leftovers cannot shrink the next.

## Offline

The service worker pre-caches the app — a hundred kilobytes of HTML, CSS and
JavaScript — and deliberately does not pre-cache the core. Hanging installation
off a single 32 MB download would mean the app is not installed, not
offline-capable and not done until it finishes, on connections where that is a
very long time, and one flaky download would fail the whole install.

Instead the core is cached on first use and then treated as immutable, because
it is: the bytes for a given version never change, so re-validating them would
be 32 MB of pure waste. That is also why re-vendoring the core requires bumping
`CACHE_VERSION`, and why `CONTRIBUTING.md` says so twice.
