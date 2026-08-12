/** Tiny DOM helpers. Not a framework — just the handful used everywhere. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Create an element.
 *
 * @param {string} tag
 * @param {object} [props] `class`, `text`, `html`, `dataset`, `attrs`, plus
 *                         any direct property assignment.
 * @param {Array} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'attrs') for (const [name, v] of Object.entries(value)) node.setAttribute(name, v);
    else node[key] = value;
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Namespaced element, for the inline SVG the queue rows draw. */
export function svg(tag, props = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

/** Add a listener and return a function that removes it. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Trailing-edge debounce. */
export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

/** Run at most once per animation frame. */
export function raf(fn) {
  let pending = false;
  let lastArgs = [];
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

/** Shorten for display, keeping the extension, which is the part that matters here. */
export function truncateName(name, max = 42) {
  const value = String(name || '');
  if (value.length <= max) return value;
  const dot = value.lastIndexOf('.');
  const extension = dot > 0 && value.length - dot <= 6 ? value.slice(dot) : '';
  const stem = value.slice(0, value.length - extension.length);
  return `${stem.slice(0, Math.max(1, max - extension.length - 1))}…${extension}`;
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/**
 * Seconds as `m:ss`, or `h:mm:ss` once it runs past an hour. Used for
 * durations, elapsed time and estimates alike, so they all read the same.
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * Seconds as `hh:mm:ss.mmm`, which is the form FFmpeg's `-ss` and `-to` want.
 * Fractional seconds are kept: trimming to the nearest whole second would put
 * a visible jump in the result.
 */
export function formatTimestamp(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const rest = clamped % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Accepts `90`, `1:30`, `01:30.5` or `0:01:30.500` and returns seconds. */
export function parseTimestamp(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length > 3 || parts.some((part) => part !== '' && !/^\d*\.?\d*$/.test(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number(part) || 0);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Bits per second, as the number a person would say out loud. */
export function formatBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—';
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(bitsPerSecond >= 1e7 ? 0 : 1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1e3)} kbps`;
}

/** Copy text, falling back to a hidden textarea where the API is unavailable. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Trigger a download of `content` without touching the network. */
export function downloadFile(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
