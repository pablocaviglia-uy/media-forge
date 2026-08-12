/**
 * The main thread's handle on the worker that owns FFmpeg.
 *
 * One worker, one core, one job at a time. That is not a simplification: the
 * core is a single WebAssembly instance with one in-memory filesystem and one
 * set of FFmpeg globals, and two jobs sharing it would write over each other's
 * files. Running several would mean several 32 MB cores, and the heap ceiling
 * that already limits how large a single file can be is shared with them.
 *
 * Cancelling is the interesting part. `exec` is synchronous inside the worker
 * and cannot be interrupted — no flag, no signal, no message will be read
 * until it returns. The only thing that stops it is `terminate()`, so that is
 * what cancelling does, and the next job pays to instantiate a fresh core.
 * The WebAssembly itself comes back out of the HTTP cache, so the cost is
 * compiling it again rather than downloading it again.
 */

const WORKER_URL = new URL('../worker/ffmpeg.worker.js', import.meta.url);

/**
 * A running conversion, as far as the caller is concerned.
 * @typedef {object} Running
 * @property {Promise<{outputs: Array<{name: string, bytes: Uint8Array}>}>} finished
 * @property {() => void} cancel
 */

export function createEngine() {
  let worker = null;
  let ready = null;
  let capabilities = null;
  let nextId = 1;

  /** Every request waiting on the worker, by id. */
  const pending = new Map();

  function handleMessage(event) {
    const message = event.data;
    const entry = pending.get(message.id);

    switch (message.type) {
      case 'progress':
        entry?.onProgress?.(message);
        return;
      case 'step':
        entry?.onStep?.(message);
        return;
      case 'log':
        entry?.onLog?.(message.lines);
        return;
      case 'probed':
        pending.delete(message.id);
        entry?.resolve(message.info);
        return;
      case 'done':
        pending.delete(message.id);
        entry?.resolve({ outputs: message.outputs });
        return;
      case 'ready':
        pending.delete(message.id);
        entry?.resolve(message);
        return;
      case 'failed': {
        pending.delete(message.id);
        const error = new Error(message.error || 'FFmpeg failed.');
        error.log = message.log || [];
        entry?.reject(error);
        // A trap inside WebAssembly leaves the heap in a state nothing can
        // recover from; the instance has to be thrown away rather than
        // handed the next job.
        if (message.fatal) discard();
        return;
      }
      default:
        console.warn('[media-forge] unexpected message from the worker:', message);
    }
  }

  /**
   * The worker dying without telling us — an out-of-memory kill, most often —
   * would otherwise leave every caller waiting forever.
   */
  function handleDeath(event) {
    const error = new Error(
      event?.message
        ? `The converter stopped: ${event.message}`
        : 'The converter stopped unexpectedly. The file may be too large for this browser.'
    );
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    discard();
  }

  function spawn() {
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleDeath);
    worker.addEventListener('messageerror', handleDeath);
    return worker;
  }

  function discard() {
    if (!worker) return;
    worker.removeEventListener('message', handleMessage);
    worker.removeEventListener('error', handleDeath);
    worker.removeEventListener('messageerror', handleDeath);
    worker.terminate();
    worker = null;
    ready = null;
  }

  function request(message, handlers = {}, transfer = []) {
    const id = String(nextId++);
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, ...handlers });
    });
    (worker || spawn()).postMessage({ ...message, id }, transfer);
    return { id, promise };
  }

  /** Instantiate the core, once, and remember what it turned out to be. */
  function load() {
    if (!ready) {
      ready = request({ type: 'load' }).promise.then((details) => {
        capabilities = details.capabilities;
        return details;
      });
      // A failed load must not be remembered as a permanent verdict — the
      // next attempt should be allowed to try a fresh worker.
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }

  return {
    load,

    /** What the loaded core can encode and mux. Null until `load` resolves. */
    get capabilities() {
      return capabilities;
    },

    get running() {
      return pending.size > 0;
    },

    /** @returns {Promise<object>} the file's streams, duration and format. */
    async probe(file) {
      await load();
      return request({ type: 'probe', file }).promise;
    },

    /**
     * Run a plan built by `media/commands.js`.
     * @returns {Running}
     */
    start(plan, file, handlers = {}) {
      const started = load().then(() => request({ type: 'run', plan, file }, handlers));

      return {
        finished: started.then(({ promise }) => promise),
        cancel() {
          const error = new Error('Cancelled.');
          error.cancelled = true;
          for (const entry of pending.values()) entry.reject(error);
          pending.clear();
          discard();
        },
      };
    },

    /** Let go of the core. The next call brings up a new one. */
    dispose: discard,
  };
}

/**
 * Whether this page could run the threaded core at all.
 *
 * Reported in settings rather than acted on: the threaded build needs
 * `SharedArrayBuffer`, which needs cross-origin isolation, which needs two
 * response headers that GitHub Pages cannot send. Anyone self-hosting behind a
 * server that can send them gets the faster core for free, and everyone else
 * needs to know why they did not.
 */
export function isolationStatus() {
  return {
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
}
