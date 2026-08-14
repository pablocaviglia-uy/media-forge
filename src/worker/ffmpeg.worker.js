/**
 * The worker that owns FFmpeg.
 *
 * Everything expensive happens in here: the 30 MB core is instantiated once
 * and reused, files are read straight into its in-memory filesystem, and
 * `exec` runs synchronously — which is precisely why it cannot run on the main
 * thread. A single conversion blocks its thread completely from the first
 * argument to the last frame, so on the main thread the page would freeze,
 * with no progress bar, for as long as the job takes.
 *
 * The core is reusable across jobs as long as `reset()` is called before each
 * `exec`; without it the second `exec` returns nothing at all. Since a running
 * `exec` cannot be interrupted, cancelling means terminating this worker from
 * the outside, which is why the client owns the worker's lifetime and this
 * file keeps no state worth preserving.
 *
 * Protocol, all messages `{type, id, …}`:
 *
 *   in   load                    → out  ready {capabilities} | failed {error}
 *   in   probe {id, file}        → out  probed {id, info} | failed {id, error}
 *   in   run   {id, plan, file}  → out  progress {id, …} · log {id, …}
 *                                       · done {id, outputs} | failed {id, error}
 */

import createFFmpegCore from '../../assets/ffmpeg/ffmpeg-core.js';
import {
  parseProbe,
  parseProbeJson,
  parseProgress,
  parseProgressLine,
  progressFromReport,
} from '../media/probe.js';
import { parseEncoders, parseMuxers } from '../ffmpeg/capabilities.js';
import { isFatal } from '../ffmpeg/failures.js';

/** Where the core's own `.wasm` (and, for the threaded build, its worker) live. */
const CORE_BASE = new URL('../../assets/ffmpeg/', import.meta.url);

let core = null;
let log = [];
let currentJob = null;

/** Collected so a failure can show the last thing FFmpeg said before it died. */
const LOG_LIMIT = 400;

function record(entry) {
  log.push(entry);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
}

function send(message, transfer = []) {
  self.postMessage(message, transfer);
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/**
 * Which core to instantiate. The threaded build needs `SharedArrayBuffer`,
 * which needs the page to be cross-origin isolated, which needs response
 * headers GitHub Pages cannot send. So the single-threaded build is the
 * default and the threaded one is picked up only when the host happens to
 * provide isolation already — no service-worker header-rewriting tricks.
 */
async function chooseVariant() {
  const manifest = await fetch(new URL('manifest.json', CORE_BASE)).then((response) => response.json());
  const isolated = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
  const wanted = isolated && manifest.variants.mt ? 'mt' : 'st';
  return { manifest, variant: wanted, isolated };
}

async function load() {
  const { manifest, variant, isolated } = await chooseVariant();

  core = await createFFmpegCore({
    // Without this the runtime resolves `ffmpeg-core.wasm` against this
    // worker's own URL, which is two directories away from where it lives.
    // Nothing else is overridden: `print` and `printErr` in particular must be
    // left alone, because the runtime restores whatever was passed in over the
    // core's own versions, and the core's versions are what feed `setLogger`.
    locateFile: (path) => new URL(path, CORE_BASE).href,
  });

  core.setLogger(({ type, message }) => {
    if (currentJob) consumeProgressLine(message);
    record({ type, message });

    // The status line is still worth reading where it does arrive — it carries
    // the encoding speed, which is what the estimate is built from.
    if (!currentJob) return;
    for (const part of String(message).split('\r')) {
      const progress = parseProgress(part);
      if (progress && progress.speed) reportProgress(progress);
    }
  });

  // The core's own hook, as a third source. It reports output time in
  // microseconds, fires a handful of times per job, and overshoots one on the
  // last frame, so it is too coarse to rely on alone — but it keeps working
  // for outputs that print nothing at all.
  core.setProgress(({ time }) => {
    if (currentJob && Number.isFinite(time) && time > 0) reportProgress({ time: time / 1e6, speed: null });
  });

  return { variant, isolated, threads: manifest.variants[variant].threads, capabilities: probeCapabilities() };
}

/** Ask the core what it can actually encode, rather than assuming. */
function probeCapabilities() {
  const collect = (...args) => {
    log = [];
    core.reset();
    core.exec('-hide_banner', '-loglevel', 'info', ...args);
    const text = log.map((entry) => entry.message).join('\n');
    log = [];
    return text;
  };

  return {
    version: /ffmpeg version (\S+)/.exec(collect('-version'))?.[1] || null,
    encoders: parseEncoders(collect('-encoders')),
    muxers: parseMuxers(collect('-muxers')),
  };
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * `-progress` emits one `key=value` per line and closes each block with
 * `progress=continue`. Lines are accumulated until that terminator arrives so
 * the whole block is reported at once rather than a dribble of half-states.
 */
let progressReport = {};

function consumeProgressLine(message) {
  for (const line of String(message).split('\n')) {
    const pair = parseProgressLine(line);
    if (!pair) continue;
    progressReport[pair.key] = pair.value;
    if (pair.key !== 'progress') continue;

    const progress = progressFromReport(progressReport);
    progressReport = {};
    if (progress.time !== null) reportProgress(progress);
  }
}

function reportProgress(progress) {
  const job = currentJob;
  if (!job) return;

  // A plan can run FFmpeg more than once — a GIF builds a palette first, a
  // size-targeted encode measures before it commits — so the fraction is
  // scaled into the slice of the whole job that this step represents.
  const withinStep = job.duration > 0 ? Math.min(1, Math.max(0, progress.time / job.duration)) : 0;
  const fraction = (job.step + withinStep) / job.steps;

  send({
    type: 'progress',
    id: job.id,
    fraction: Math.min(1, Math.max(0, fraction)),
    time: progress.time,
    speed: progress.speed ?? null,
    step: job.step,
    steps: job.steps,
  });
}

/* ------------------------------------------------------------------ *
 * Filesystem
 * ------------------------------------------------------------------ */

/**
 * Copy a `File` into the core's filesystem.
 *
 * The bytes exist twice for a moment — once as the `ArrayBuffer` the browser
 * hands back and once inside the WebAssembly heap — and the heap tops out at
 * 2 GB for the whole process, input and output together. That ceiling is why
 * the UI refuses very large files before it ever gets here.
 */
async function writeInput(name, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  core.FS.writeFile(name, bytes);
  return bytes.length;
}

function removeQuietly(name) {
  try {
    core.FS.unlink(name);
  } catch {
    // Already gone, or never written because the step that would have made it
    // failed. Either way there is nothing to clean up.
  }
}

/** Everything the core created, so one job's leftovers cannot bloat the next. */
function listWorkingFiles() {
  try {
    return core.FS.readdir('/').filter((name) => name !== '.' && name !== '..' && !core.FS.isDir(core.FS.stat(`/${name}`).mode));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

/**
 * Run ffprobe and read its answer out of a file rather than off stdout.
 *
 * `-print_format json` normally writes to stdout, and stdout is where this
 * build also flushes leftover diagnostics from whatever ran before it — the
 * trailing "FFprobe: Cleanup done." of the previous call, and, once a couple
 * of invocations have gone by, decoder debug lines interleaved *inside* the
 * JSON object. No amount of careful parsing recovers from that. `-o` sends
 * the report to the in-memory filesystem instead, where nothing else can
 * write into the middle of it.
 */
function readProbeJson(name) {
  const REPORT = 'probe-report.json';
  removeQuietly(REPORT);
  log = [];
  core.reset();
  core.ffprobe('-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-o', REPORT, name);
  log = [];

  try {
    return new TextDecoder().decode(core.FS.readFile(REPORT));
  } catch {
    return '';
  } finally {
    removeQuietly(REPORT);
  }
}

async function probe(id, file) {
  const name = `probe-input${extensionOf(file.name)}`;
  await writeInput(name, file);

  try {
    let info = parseProbeJson(readProbeJson(name));
    if (!info) {
      // ffprobe declines some damaged files that `ffmpeg -i` will still
      // describe. Reading the banner is less precise but strictly more
      // tolerant, so it is worth the second attempt before giving up.
      log = [];
      core.reset();
      core.exec('-hide_banner', '-loglevel', 'info', '-i', name);
      info = parseProbe(log.map((entry) => entry.message).join('\n'));
    }

    send({ type: 'probed', id, info: { ...info, size: file.size, name: file.name } });
  } finally {
    removeQuietly(name);
    log = [];
  }
}

/**
 * Run a plan: one or more FFmpeg invocations that together produce the output.
 *
 * @param {string} id
 * @param {{steps: Array<{args: string[]}>, inputNames: string[], outputs: string[],
 *   outputPrefix?: string, duration: number|null}} plan
 * @param {File|null} file
 */
async function run(id, plan, file) {
  currentJob = { id, step: 0, steps: plan.steps.length, duration: plan.duration || 0 };
  progressReport = {};
  log = [];

  try {
    // A plan with no inputs is not a mistake: FFmpeg can generate video out of
    // nothing with `lavfi`, which is how the sample clip is made.
    if (plan.inputNames.length && file) await writeInput(plan.inputNames[0], file);

    for (const [index, step] of plan.steps.entries()) {
      currentJob.step = index;
      send({ type: 'step', id, step: index, steps: plan.steps.length, args: step.args });

      core.reset();
      // `-progress pipe:1` is added here rather than by the command builder so
      // that the command the inspector shows is one a person could paste into
      // a terminal without being buried in machine-readable status blocks.
      const code = core.exec('-progress', 'pipe:1', ...step.args);
      send({ type: 'log', id, lines: log.map((entry) => entry.message) });

      if (code !== 0) {
        throw new Error(explainFailure(code));
      }
      log = [];
    }

    // Frame extraction writes `frame-0001.png`, `frame-0002.png` and so on:
    // the plan cannot name them because it does not know how many there will
    // be until FFmpeg has finished counting.
    const produced = plan.outputPrefix
      ? listWorkingFiles().filter((name) => name.startsWith(plan.outputPrefix)).sort()
      : plan.outputs;
    if (!produced.length) throw new Error('FFmpeg finished but produced no output.');

    const outputs = produced.map((name) => {
      const bytes = core.FS.readFile(name);
      // `readFile` hands back a view onto the heap; slicing detaches a copy
      // that survives the buffer being freed and can be transferred.
      const copy = bytes.slice();
      return { name, bytes: copy };
    });

    send(
      { type: 'done', id, outputs, fraction: 1 },
      outputs.map((output) => output.bytes.buffer)
    );
  } catch (error) {
    send({ type: 'failed', id, error: error.message, log: log.map((entry) => entry.message).slice(-40) });
  } finally {
    currentJob = null;
    for (const name of listWorkingFiles()) removeQuietly(name);
    log = [];
  }
}

/**
 * Turn an exit code into something worth showing a person. FFmpeg's own
 * message is in the log, but the log is 200 lines of build banner and stream
 * mapping, and the last line is usually the useful one.
 */
function explainFailure(code) {
  const lastError = [...log]
    .reverse()
    .map((entry) => entry.message)
    .find((message) => /error|invalid|unable|no such|not found|failed|unsupported/i.test(message));

  if (lastError) return lastError.replace(/^\[[^\]]+\]\s*/, '');
  if (code === 1) return 'FFmpeg could not complete this conversion.';
  return `FFmpeg exited with code ${code}.`;
}

const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return match ? `.${match[1].toLowerCase()}` : '';
};

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

self.addEventListener('message', async (event) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'load': {
        const details = await load();
        // Every reply carries the id it is answering; the client looks the
        // waiting caller up by it, and a reply without one is a promise that
        // never settles.
        send({ type: 'ready', id: message.id, ...details });
        break;
      }
      case 'probe':
        await probe(message.id, message.file);
        break;
      case 'run':
        await run(message.id, message.plan, message.file);
        break;
      default:
        send({ type: 'failed', id: message.id, error: `Unknown message "${message.type}".` });
    }
  } catch (error) {
    // An abort inside the WebAssembly heap leaves the core unusable, so the
    // client is told to replace this worker rather than send it more work.
    // This core traps of its own accord once an instance has run long enough,
    // so the path is exercised in ordinary use, not only after a bad file.
    send({ type: 'failed', id: message.id, error: error.message, fatal: isFatal(error) });
  }
});
