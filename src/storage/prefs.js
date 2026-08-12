/**
 * Preferences, backed by localStorage.
 *
 * These are small, must be readable synchronously before the first paint (to
 * avoid a theme flash), and describe how the app looks and behaves rather than
 * what is in the queue — the queue is deliberately not persisted, because the
 * `File` objects it holds cannot outlive the tab anyway.
 *
 * Reads go through an in-memory cache; writes are debounced and mirrored across
 * tabs via the `storage` event.
 */

const KEY = 'media-forge:prefs';

export const DEFAULTS = {
  theme: 'auto', // auto | light | dark
  accent: 'teal', // teal | indigo | amber | rose | slate
  queueOpen: true,
  logOpen: false,
  autoStart: false, // start converting the moment files are dropped
  preset: 'mp4-h264', // the target selected for a freshly added file
  advanced: false, // show codec-level controls and the command preview
  queueWidth: 320,
  logWidth: 340,
};

/** Values that must be one of a fixed set. */
const ENUMS = {
  theme: ['auto', 'light', 'dark'],
  accent: ['teal', 'indigo', 'amber', 'rose', 'slate'],
};

const RANGES = {
  queueWidth: [240, 520],
  logWidth: [280, 560],
};

function coerce(key, value) {
  const fallback = DEFAULTS[key];
  if (value === undefined || value === null) return fallback;
  if (typeof fallback === 'boolean') return Boolean(value);
  if (typeof fallback === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const range = RANGES[key];
    return range ? Math.min(range[1], Math.max(range[0], number)) : number;
  }
  if (ENUMS[key]) return ENUMS[key].includes(value) ? value : fallback;
  return value;
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (key in parsed) out[key] = coerce(key, parsed[key]);
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

let cache = read();
let writeTimer = null;
const listeners = new Set();

function flush() {
  writeTimer = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (error) {
    // Private-browsing modes and full quotas both land here. The app keeps
    // working with in-memory preferences; only persistence is lost.
    console.warn('[media-forge] preferences not saved:', error.message);
  }
}

function notify(changed) {
  for (const listener of listeners) listener(cache, changed);
}

export const prefs = {
  /** @returns {object} a snapshot of all preferences. */
  all() {
    return { ...cache };
  },

  get(key) {
    return cache[key];
  },

  /** Set one key, or many at once with an object. */
  set(keyOrPatch, maybeValue) {
    const patch = typeof keyOrPatch === 'string' ? { [keyOrPatch]: maybeValue } : keyOrPatch;
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      const next = coerce(key, value);
      if (cache[key] === next) continue;
      cache[key] = next;
      changed.push(key);
    }
    if (changed.length === 0) return changed;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 150);
    notify(changed);
    return changed;
  },

  reset() {
    cache = { ...DEFAULTS };
    flush();
    notify(Object.keys(DEFAULTS));
  },

  /** @returns {() => void} unsubscribe */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Persist immediately, e.g. on `pagehide`. */
  flush() {
    if (writeTimer) clearTimeout(writeTimer);
    flush();
  },
};

// Keep multiple tabs consistent.
if (typeof addEventListener === 'function') {
  addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    const next = read();
    const changed = Object.keys(DEFAULTS).filter((key) => next[key] !== cache[key]);
    cache = next;
    if (changed.length) notify(changed);
  });
}

/**
 * Resolve `theme: auto` against the OS setting.
 * @returns {'light'|'dark'}
 */
export function resolveTheme(theme = cache.theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
