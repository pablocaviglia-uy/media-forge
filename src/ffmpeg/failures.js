/**
 * Telling a failed job apart from a poisoned engine.
 *
 * FFmpeg refusing to do something is ordinary: an encoder that is not compiled
 * in, a filter whose syntax changed, a container that will not hold the codec
 * it was handed. Those come back as a non-zero exit code, the core is
 * untouched, and the next job runs normally.
 *
 * A trap is a different animal. When the WebAssembly aborts — "memory access
 * out of bounds", an unreachable instruction, a failed allocation — the heap is
 * left in a state nothing can reason about, and every later call on that
 * instance is undefined behaviour rather than a clean error. The instance has
 * to be thrown away.
 *
 * That distinction is not academic here, because this core does not survive
 * indefinitely. One long-lived instance running nothing but `-version` traps
 * somewhere around the seventieth call; a small MP3 encode gets to about the
 * same; a small video encode reaches roughly a hundred and sixty. The counts
 * are not stable and the cause is upstream, but the shape is consistent: keep
 * one core alive long enough and it will eventually trap, whatever it is doing.
 *
 * The app already replaces the instance when this happens, so the visible cost
 * is one failed job and a few seconds recompiling. Getting the classification
 * wrong is what turns that into something worse — a poisoned core handed the
 * next file, producing output nobody should trust.
 *
 * It is a pure function over a string so that it can be tested, which is the
 * whole reason it lives here instead of inline in the worker.
 */

/**
 * Patterns that mean the WebAssembly instance is no longer usable.
 *
 * `memory` catches "memory access out of bounds", which is what this core
 * produces when it wears out, and "Out of memory". `allocation failed` is
 * there separately because the browsers word that one without saying memory at
 * all — Chrome's is "Array buffer allocation failed" — and growing the heap is
 * exactly when a long conversion dies. `RuntimeError` is how a trap surfaces,
 * `abort` is Emscripten's own, and `unreachable` is the raw instruction.
 */
const FATAL = /\babort|memory|allocation failed|RuntimeError|unreachable|out of bounds/i;

/**
 * Whether this failure means the core has to be replaced.
 *
 * @param {unknown} error an Error, or the message from one
 * @returns {boolean} true when the instance is poisoned rather than merely unhappy
 */
export function isFatal(error) {
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== 'string' || !message) return false;
  return FATAL.test(message);
}

/**
 * Build the worker protocol's failure reply in one place.
 *
 * A fatal flag is part of the recovery contract rather than optional
 * decoration: the client uses it to terminate the worker and instantiate a
 * fresh core. Keeping that decision next to `isFatal` makes it much harder for
 * an inner catch (such as the one around a conversion) to accidentally swallow
 * a trap and hand the poisoned instance to the next job.
 *
 * @param {string|undefined} id request being answered
 * @param {unknown} error thrown value
 * @param {object} [details] extra protocol fields such as the FFmpeg log
 * @returns {{type: 'failed', id: string|undefined, error: string, fatal: boolean}}
 */
export function failedMessage(id, error, details = {}) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'FFmpeg failed.';

  return {
    ...details,
    type: 'failed',
    id,
    error: message || 'FFmpeg failed.',
    fatal: isFatal(error),
  };
}
