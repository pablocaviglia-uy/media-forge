/**
 * A reusable, local-first audio transport for result previews and Audio Lab.
 *
 * Waveform peaks are deliberately supplied by the caller. This component does
 * not decode audio (and therefore cannot accidentally expand a large MP3 into
 * gigabytes of PCM on the main thread). It owns only object URLs it creates
 * from `blob`; a caller-provided `url` is never revoked.
 */

import { el, formatDuration, formatTimestamp, on, parseTimestamp } from './dom.js';
import {
  MIN_SPAN,
  fit,
  fractionOf,
  lengthOf,
  nudge,
  pan,
  selectAll,
  spanOf,
  step,
  timeAt,
} from '../media/timeline.js';

export const AUDIO_LAB_MIN_SELECTION = 0.01;

const WHEEL_ZOOM = 0.82;
const BUTTON_SEEK_SECONDS = 10;
const LOOP_EPSILON = 0.008;
const REGION_DRAG_THRESHOLD_PX = 6;

let nextAudioLabPlayerId = 1;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const finiteDuration = (value) => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
};

const finiteTime = (value, fallback = 0) => {
  const time = Number(value);
  return Number.isFinite(time) ? time : fallback;
};

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const PEAK_STATUSES = new Set(['idle', 'loading', 'ready', 'unavailable']);

const normalizePeakStatus = (value, hasPeaks = false) => {
  if (hasPeaks) return 'ready';
  if (value === 'ready') return 'idle';
  return PEAK_STATUSES.has(value) ? value : 'idle';
};

/**
 * Clamp a proposed range to an audio duration without allowing its edges to
 * cross. Missing ranges mean the whole file, matching MediaForge's scrubber.
 */
export function normalizeAudioSelection(selection, duration, least = AUDIO_LAB_MIN_SELECTION) {
  return normalizeBoundedAudioSelection(selection, duration, null, least);
}

function normalizeAudioSelectionBounds(bounds, duration) {
  const total = finiteDuration(duration);
  if (!total) return { from: 0, to: 0 };

  if (!bounds || typeof bounds !== 'object') return selectAll(total);
  const requestedFrom = Number(bounds.from ?? bounds.start);
  const requestedTo = Number(bounds.to ?? bounds.end);
  if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo) || requestedTo <= requestedFrom) {
    return selectAll(total);
  }
  const from = clamp(requestedFrom, 0, total);
  const to = clamp(requestedTo, from, total);
  return to > from ? { from, to } : selectAll(total);
}

function normalizeBoundedAudioSelection(selection, duration, bounds, least = AUDIO_LAB_MIN_SELECTION) {
  const total = finiteDuration(duration);
  if (!total) return { from: 0, to: 0 };

  const limits = normalizeAudioSelectionBounds(bounds, total);
  const available = Math.max(0, limits.to - limits.from);
  const minimum = Math.min(available, Math.max(0, finiteTime(least, AUDIO_LAB_MIN_SELECTION)));
  if (!selection) return { ...limits };

  const requestedFrom = finiteTime(selection.from, limits.from);
  const requestedTo = finiteTime(selection.to, limits.to);
  // Set the far edge first. If an inverted external range arrives, the start
  // is then stopped just before it instead of silently swapping edge roles.
  const to = clamp(requestedTo, limits.from + minimum, limits.to);
  const from = clamp(requestedFrom, limits.from, to - minimum);
  return { from, to };
}

/** Normalize amplitudes to min/max pairs in the browser-audio range. */
export function normalizeAudioPeaks(peaks) {
  if (!peaks || typeof peaks === 'string' || typeof peaks[Symbol.iterator] !== 'function') return [];
  return Array.from(peaks, (entry) => {
    let low;
    let high;
    if (Array.isArray(entry)) {
      low = finiteTime(entry[0], 0);
      high = finiteTime(entry[1], low);
    } else if (entry && typeof entry === 'object') {
      low = finiteTime(entry.min, 0);
      high = finiteTime(entry.max, low);
    } else {
      const amplitude = Math.abs(finiteTime(entry, 0));
      low = -amplitude;
      high = amplitude;
    }
    const clampedMin = clamp(Math.min(0, low, high), -1, 1);
    const min = Object.is(clampedMin, -0) ? 0 : clampedMin;
    const max = clamp(Math.max(0, low, high), -1, 1);
    return Object.freeze({ min, max });
  });
}

/**
 * Reduce the visible portion of a peak array to canvas-sized buckets.
 * Every source peak participates in exactly one output bucket, preserving
 * transients better than choosing a representative sample.
 */
export function bucketAudioPeaks(peaks, count, view, duration) {
  const normalized = normalizeAudioPeaks(peaks);
  return bucketNormalizedAudioPeaks(normalized, count, view, duration);
}

function bucketNormalizedAudioPeaks(normalized, count, view, duration) {
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  if (!normalized.length || !wanted) return [];

  const total = finiteDuration(duration) || 1;
  const visible = view || { start: 0, end: total };
  const startFraction = clamp(finiteTime(visible.start) / total, 0, 1);
  const endFraction = clamp(finiteTime(visible.end, total) / total, startFraction, 1);
  const startIndex = Math.min(normalized.length - 1, Math.floor(startFraction * normalized.length));
  const endIndex = Math.max(startIndex + 1, Math.ceil(endFraction * normalized.length));
  const available = Math.max(1, endIndex - startIndex);
  const bucketCount = Math.min(wanted, available);
  const buckets = [];

  for (let index = 0; index < bucketCount; index += 1) {
    const from = startIndex + Math.floor((index / bucketCount) * available);
    const to = startIndex + Math.max(
      Math.floor(((index + 1) / bucketCount) * available),
      Math.floor((index / bucketCount) * available) + 1,
    );
    let min = 0;
    let max = 0;
    for (let cursor = from; cursor < Math.min(to, normalized.length); cursor += 1) {
      min = Math.min(min, normalized[cursor].min);
      max = Math.max(max, normalized[cursor].max);
    }
    buckets.push(Object.freeze({ min, max }));
  }
  return buckets;
}

/** Fit the selected range into a timeline window using the shared zoom model. */
export function audioViewForSelection(selection, duration) {
  const total = finiteDuration(duration);
  const whole = fit(total);
  if (!total) return whole;
  const range = normalizeAudioSelection(selection, total);
  const width = Math.max(AUDIO_LAB_MIN_SELECTION, lengthOf(range));
  return pan(fit(width), range.from, total);
}

/** Pure boundary decision used by the requestAnimationFrame playback monitor. */
export function audioSelectionBoundary({ currentTime, selection, playingSelection, loop }) {
  if (!playingSelection || !selection || !(selection.to > selection.from)) {
    return { action: 'continue', time: finiteTime(currentTime) };
  }
  const time = finiteTime(currentTime);
  // A selection can be edited while it is playing. If its new beginning moves
  // ahead of the playhead, continuing outside the active range would make the
  // transport lie about what it is playing; rebase immediately in both looped
  // and one-shot selection playback.
  // Compressed formats can report a decoded timestamp a few milliseconds
  // before the requested seek. Treat that as having arrived, or every frame
  // would issue the same seek again and some browsers would never settle it.
  if (time < selection.from - LOOP_EPSILON) return { action: 'rebase', time: selection.from };
  // Never cut a selection early. requestAnimationFrame may observe a small
  // overshoot, but treating an epsilon before the edge as the edge is audible.
  if (time < selection.to) return { action: 'continue', time };
  return loop
    ? { action: 'loop', time: selection.from }
    : { action: 'stop', time: selection.to };
}

function clockLabel(current, duration) {
  return `${formatDuration(current)} / ${formatDuration(duration)}`;
}

function formatAudioLabDuration(value) {
  const seconds = Math.max(0, finiteTime(value));
  return seconds < 1 ? `${seconds.toFixed(3)} s` : formatDuration(seconds);
}

function formatAudioLabDurationAria(value) {
  const seconds = Math.max(0, finiteTime(value));
  if (seconds < 1) {
    const milliseconds = Math.round(seconds * 1000);
    return `${milliseconds} ${milliseconds === 1 ? 'milisegundo' : 'milisegundos'}`;
  }
  return formatDuration(seconds);
}

function button(label, action, text, attrs = {}) {
  return el('button', {
    type: 'button',
    class: `audio-lab-button audio-lab-${action}`,
    text,
    dataset: { audioLabAction: action },
    attrs: { 'aria-label': label, ...attrs },
  });
}

/**
 * @typedef {{from: number, to: number}} AudioLabSelection
 * @typedef {{start: number, end: number}} AudioLabView
 *
 * @param {object} [options]
 * @param {Blob|null} [options.blob] Local bytes. Its generated object URL is owned here.
 * @param {string|null} [options.url] Caller-owned URL. Takes precedence over `blob`.
 * @param {string} [options.name]
 * @param {number|null} [options.duration]
 * @param {Iterable<number|[number, number]|{min: number, max: number}>|null} [options.peaks]
 * @param {'idle'|'loading'|'ready'|'unavailable'} [options.peaksStatus]
 * @param {string|null} [options.peaksMessage]
 * @param {AudioLabSelection|null} [options.selection]
 * @param {AudioLabSelection|null} [options.selectionBounds] Allowed range of the active fragment, on the root clock.
 * @param {boolean} [options.loop]
 * @param {boolean} [options.preferSelectionPlayback]
 * @param {number} [options.fragmentDepth]
 * @param {'source'|0|1|2|3|4|5} [options.fragmentAccent]
 * @param {boolean} [options.disabled]
 * @param {(selection: AudioLabSelection, context: {source: string, commit: boolean}) => void} [options.onSelectionChange]
 * @param {(loop: boolean, context: {source: 'button'|'shortcut'}) => void} [options.onLoopChange]
 * @param {(selection: AudioLabSelection, context: {name: string, duration: number}) => boolean|void|Promise<boolean>} [options.onCreateFragment]
 * @param {(state: {selection: AudioLabSelection, view: AudioLabView, currentTime: number, loop: boolean}) => void} [options.onOpenLab]
 * @param {() => void|Promise<unknown>} [options.onRetryPeaks]
 * @returns {{
 *   node: HTMLElement,
 *   media: HTMLAudioElement,
 *   update: (next: object) => void,
 *   selection: () => AudioLabSelection,
 *   view: () => AudioLabView,
 *   seek: (seconds: number) => void,
 *   togglePlayback: () => void,
 *   setSelection: (selection: AudioLabSelection, notify?: boolean) => void,
 *   focus: () => void,
 *   destroy: () => void,
 * }}
 */
export function createAudioLabPlayer(options = {}) {
  const instanceId = `audio-lab-player-${nextAudioLabPlayerId++}`;
  const titleId = `${instanceId}-title`;
  const helpId = `${instanceId}-help`;
  let config = {
    blob: null,
    url: null,
    name: 'Audio',
    duration: null,
    peaks: null,
    peaksStatus: 'idle',
    peaksMessage: null,
    selection: null,
    selectionBounds: null,
    loop: false,
    preferSelectionPlayback: false,
    fragmentDepth: 0,
    fragmentAccent: 'source',
    disabled: false,
    onSelectionChange: null,
    onLoopChange: null,
    onCreateFragment: null,
    onOpenLab: null,
    onRetryPeaks: null,
    ...options,
  };
  let duration = finiteDuration(config.duration);
  let pendingSelection = config.selection ? { ...config.selection } : null;
  let selection = normalizeBoundedAudioSelection(config.selection, duration, config.selectionBounds);
  let selectionFollowsBounds = config.selection == null;
  const initialLimits = normalizeAudioSelectionBounds(config.selectionBounds, duration);
  let view = initialLimits.to > initialLimits.from
    ? { start: initialLimits.from, end: initialLimits.to }
    : fit(duration);
  let peaks = normalizeAudioPeaks(config.peaks);
  let looping = Boolean(config.loop);
  let disabled = Boolean(config.disabled);
  let playbackScope = 'all';
  let ownedUrl = null;
  let activeBlob = null;
  let activeExternalUrl = null;
  let installedSourceUrl = null;
  let frameId = null;
  let stopPointerDrag = null;
  let destroyed = false;
  let resizeObserver = null;
  let fragmentCreationPending = false;

  const media = el('audio', {
    class: 'audio-lab-media sr-only',
    preload: 'metadata',
    controls: false,
    attrs: { 'aria-hidden': 'true', tabindex: '-1' },
  });
  const nameNode = el('strong', { id: titleId, class: 'audio-lab-name', text: config.name });
  const live = el('p', {
    class: 'sr-only audio-lab-live',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const help = el('p', {
    id: helpId,
    class: 'sr-only',
    text: 'Arrastrá sobre la onda para seleccionar. Un clic mueve el cabezal. Espacio reproduce o pausa. L activa el loop. I y O marcan inicio y final. Las flechas mueven el cabezal; Shift mueve un segundo y Alt diez milisegundos.',
  });

  const canvas = el('canvas', {
    class: 'audio-lab-waveform-canvas',
    width: 960,
    height: 180,
    attrs: { 'aria-hidden': 'true' },
  });
  const fallbackText = el('span', {
    class: 'audio-lab-waveform-fallback-copy',
  });
  const retryPeaksButton = button('Reintentar el análisis de la forma de onda', 'retry-peaks', 'Reintentar');
  const fallback = el('div', {
    class: 'audio-lab-waveform-fallback',
    attrs: { role: 'status', 'aria-live': 'polite' },
  }, [fallbackText, retryPeaksButton]);
  const selectionBadge = el('span', { class: 'audio-lab-selection-badge' });
  const selectionBand = el('span', {
    class: 'audio-lab-selection-band',
    attrs: { 'aria-hidden': 'true' },
  }, [selectionBadge]);
  const playhead = el('span', { class: 'audio-lab-playhead', attrs: { 'aria-hidden': 'true' } });
  const fromHandle = el('span', {
    class: 'audio-lab-selection-handle audio-lab-selection-from',
    attrs: {
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Inicio de la selección',
      'aria-describedby': helpId,
      'aria-orientation': 'horizontal',
    },
  });
  const toHandle = el('span', {
    class: 'audio-lab-selection-handle audio-lab-selection-to',
    attrs: {
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Final de la selección',
      'aria-describedby': helpId,
      'aria-orientation': 'horizontal',
    },
  });
  const seekControl = el('span', {
    class: 'audio-lab-seek-control',
    attrs: {
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Posición de reproducción',
      'aria-describedby': helpId,
      'aria-orientation': 'horizontal',
      'aria-keyshortcuts': 'ArrowLeft ArrowRight ArrowUp ArrowDown PageUp PageDown Home End',
    },
  });
  const guidanceId = `${instanceId}-waveform-guidance`;
  const waveformGuidance = el('p', {
    id: guidanceId,
    class: 'audio-lab-waveform-guidance',
  }, [
    el('span', { class: 'audio-lab-waveform-hint', text: 'Arrastrá para seleccionar · clic para mover el cabezal' }),
    el('span', { class: 'audio-lab-shortcut-hint', text: 'Espacio: reproducir/pausar' }),
  ]);
  const track = el('div', {
    class: 'audio-lab-waveform-track',
    attrs: {
      role: 'group',
      'aria-label': 'Forma de onda y selección',
      'aria-describedby': guidanceId,
    },
  }, [canvas, selectionBand, playhead, seekControl, fromHandle, toHandle, fallback, waveformGuidance]);

  const playButton = button('Reproducir', 'play', '▶', { 'aria-keyshortcuts': 'Space' });
  const backButton = button(`Retroceder ${BUTTON_SEEK_SECONDS} segundos`, 'back', `−${BUTTON_SEEK_SECONDS}`);
  const forwardButton = button(`Avanzar ${BUTTON_SEEK_SECONDS} segundos`, 'forward', `+${BUTTON_SEEK_SECONDS}`);
  const timeOutput = el('output', { class: 'audio-lab-time', text: clockLabel(0, duration), attrs: { 'aria-live': 'off' } });
  const loopButton = button('Repetir la selección', 'loop', 'Loop', { 'aria-pressed': 'false', 'aria-keyshortcuts': 'L' });
  const zoomOutButton = button('Alejar la forma de onda', 'zoom-out', '−');
  const zoomInButton = button('Acercar la forma de onda', 'zoom-in', '+');
  const fitButton = button('Mostrar todo el audio', 'fit', 'Todo');
  const fitSelectionButton = button('Ajustar la vista a la selección', 'fit-selection', 'Selección');
  const zoomOutput = el('output', { class: 'audio-lab-zoom', text: '1×', attrs: { 'aria-live': 'off' } });
  const markFromButton = button('Marcar el tiempo actual como inicio', 'mark-from', 'Marcar inicio', { 'aria-keyshortcuts': 'I' });
  const markToButton = button('Marcar el tiempo actual como final', 'mark-to', 'Marcar final', { 'aria-keyshortcuts': 'O' });
  const createFragmentButton = button('Crear un fragmento con la selección', 'create-fragment', 'Crear fragmento');
  const openLabButton = button('Abrir el editor de audio', 'open-lab', 'Abrir Audio Lab');

  const fromField = el('input', {
    class: 'audio-lab-time-field',
    type: 'text',
    value: formatTimestamp(selection.from),
    inputMode: 'decimal',
    attrs: { 'aria-label': 'Inicio de la selección', spellcheck: 'false' },
  });
  const toField = el('input', {
    class: 'audio-lab-time-field',
    type: 'text',
    value: formatTimestamp(selection.to),
    inputMode: 'decimal',
    attrs: { 'aria-label': 'Final de la selección', spellcheck: 'false' },
  });
  const selectionLength = el('output', {
    class: 'audio-lab-selection-length',
    attrs: { 'aria-label': 'Duración seleccionada' },
  });

  const node = el('section', {
    class: 'audio-lab-player',
    dataset: { disabled: String(disabled), peaks: normalizePeakStatus(config.peaksStatus, peaks.length > 0) },
    attrs: {
      'aria-labelledby': titleId,
      'aria-describedby': helpId,
      'aria-disabled': String(disabled),
      'aria-keyshortcuts': 'Space L I O ArrowLeft ArrowRight',
      tabindex: '0',
    },
  }, [
    media,
    el('header', { class: 'audio-lab-head' }, [
      el('div', { class: 'audio-lab-heading' }, [
        el('span', { text: 'Reproducción local' }),
        nameNode,
      ]),
      openLabButton,
    ]),
    track,
    el('div', { class: 'audio-lab-transport', attrs: { role: 'group', 'aria-label': 'Controles de reproducción' } }, [
      el('span', { class: 'audio-lab-control-label', text: 'Transporte', attrs: { 'aria-hidden': 'true' } }),
      backButton,
      playButton,
      forwardButton,
      timeOutput,
      loopButton,
    ]),
    el('div', { class: 'audio-lab-zoom-controls', attrs: { role: 'group', 'aria-label': 'Zoom de la forma de onda' } }, [
      el('span', { class: 'audio-lab-control-label', text: 'Vista', attrs: { 'aria-hidden': 'true' } }),
      zoomOutButton,
      zoomInButton,
      fitButton,
      fitSelectionButton,
      zoomOutput,
    ]),
    el('div', { class: 'audio-lab-selection-controls', attrs: { role: 'group', 'aria-label': 'Selección de audio' } }, [
      el('span', { class: 'audio-lab-control-label', text: 'Región', attrs: { 'aria-hidden': 'true' } }),
      el('label', {}, [el('span', { text: 'Inicio' }), fromField]),
      el('span', { text: '→', attrs: { 'aria-hidden': 'true' } }),
      el('label', {}, [el('span', { text: 'Final' }), toField]),
      selectionLength,
      markFromButton,
      markToButton,
      createFragmentButton,
    ]),
    help,
    live,
  ]);

  const buttons = Array.from(node.querySelectorAll('button'));
  const removeListeners = [];

  function announce(message) {
    live.textContent = '';
    queueMicrotask(() => {
      if (!destroyed) live.textContent = message;
    });
  }

  function requestFrame(callback) {
    if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(callback);
    return globalThis.setTimeout(() => callback(globalThis.performance?.now?.() || Date.now()), 16);
  }

  function cancelFrame(id) {
    if (id == null) return;
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
    else globalThis.clearTimeout(id);
  }

  function stopPlaybackMonitor() {
    if (frameId == null) return;
    cancelFrame(frameId);
    frameId = null;
  }

  function setStyle(element, property, value) {
    if (element.style?.setProperty) element.style.setProperty(property, value);
    else if (element.style) element.style[property] = value;
  }

  function sourceAvailable() {
    return Boolean(installedSourceUrl);
  }

  function currentTime() {
    return clamp(finiteTime(media.currentTime), 0, duration || Number.MAX_SAFE_INTEGER);
  }

  function selectionLimits(bounds = config.selectionBounds, total = duration) {
    return normalizeAudioSelectionBounds(bounds, total);
  }

  function contextView() {
    const limits = selectionLimits();
    return limits.to > limits.from ? { start: limits.from, end: limits.to } : fit(0);
  }

  function viewForRange(range) {
    const limits = selectionLimits();
    const contextSpan = Math.max(0, limits.to - limits.from);
    if (!(contextSpan > 0)) return fit(0);
    const wanted = Math.min(
      contextSpan,
      Math.max(Math.min(MIN_SPAN, contextSpan), finiteTime(range?.to) - finiteTime(range?.from)),
    );
    const start = clamp(finiteTime(range?.from, limits.from), limits.from, limits.to - wanted);
    return { start, end: start + wanted };
  }

  function revealInContext(currentView, time) {
    const limits = selectionLimits();
    const width = Math.min(spanOf(currentView), Math.max(0, limits.to - limits.from));
    if (!(width > 0)) return contextView();
    if (time >= currentView.start && time <= currentView.end) return currentView;
    const start = clamp(time < currentView.start ? time : time - width, limits.from, limits.to - width);
    return { start, end: start + width };
  }

  function followInContext(currentView, time) {
    const limits = selectionLimits();
    const width = Math.min(spanOf(currentView), Math.max(0, limits.to - limits.from));
    if (!(width > 0)) return contextView();
    const start = clamp(time - width / 2, limits.from, limits.to - width);
    const next = { start, end: start + width };
    return next.start === currentView.start && next.end === currentView.end ? currentView : next;
  }

  function selectionCoversLimits() {
    const limits = selectionLimits();
    return Math.abs(selection.from - limits.from) <= LOOP_EPSILON
      && Math.abs(selection.to - limits.to) <= LOOP_EPSILON;
  }

  function clampMediaClockToContext() {
    if (!(duration > 0)) return;
    const limits = selectionLimits();
    const target = clamp(currentTime(), limits.from, limits.to);
    if (Math.abs(target - currentTime()) <= 1e-9) return;
    try { media.currentTime = target; } catch { /* an unloaded media clock is best-effort */ }
  }

  function intendedPlaybackScope() {
    return looping || Boolean(config.preferSelectionPlayback) || !selectionCoversLimits()
      ? 'selection'
      : 'all';
  }

  function normalizedFragmentDepth() {
    const value = Number(config.fragmentDepth);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  function normalizedFragmentAccent() {
    if (config.fragmentAccent === 'source') return 'source';
    const value = Number(config.fragmentAccent);
    return Number.isInteger(value) && value >= 0 && value <= 5 ? String(value) : 'source';
  }

  function renderTransport() {
    const playing = media.paused === false && media.ended !== true;
    const visibleScope = playing ? playbackScope : intendedPlaybackScope();
    const limits = selectionLimits();
    const hasSubselection = !selectionCoversLimits();
    playButton.textContent = playing ? '❚❚' : '▶';
    const playLabel = playing ? 'Pausar' : visibleScope === 'selection' ? 'Reproducir selección' : 'Reproducir';
    playButton.setAttribute('aria-label', playLabel);
    playButton.setAttribute('title', playLabel);
    playButton.setAttribute('aria-pressed', String(playing));
    loopButton.setAttribute('aria-pressed', String(looping));
    loopButton.dataset.active = String(looping);
    timeOutput.textContent = clockLabel(currentTime(), duration);
    node.dataset.playbackScope = visibleScope;

    const canUseMedia = !disabled && sourceAvailable();
    const canUseRange = canUseMedia && duration > 0 && selection.to > selection.from;
    playButton.disabled = !canUseMedia;
    backButton.disabled = !canUseMedia || currentTime() <= limits.from + LOOP_EPSILON;
    forwardButton.disabled = !canUseMedia || currentTime() >= limits.to - LOOP_EPSILON;
    loopButton.disabled = !canUseRange;
    const canCreateFragment = canUseRange
      && hasSubselection
      && !fragmentCreationPending
      && typeof config.onCreateFragment === 'function';
    createFragmentButton.disabled = !canCreateFragment;
    createFragmentButton.textContent = fragmentCreationPending
      ? 'Creando fragmento…'
      : canCreateFragment
      ? `Crear fragmento · ${formatAudioLabDuration(lengthOf(selection))}`
      : 'Crear fragmento';
    createFragmentButton.setAttribute(
      'aria-label',
      fragmentCreationPending
        ? 'Creando fragmento'
        : canCreateFragment
        ? `Crear fragmento de ${formatAudioLabDurationAria(lengthOf(selection))}`
        : 'Seleccioná un rango más pequeño para crear un fragmento',
    );
    openLabButton.disabled = disabled || typeof config.onOpenLab !== 'function';
    openLabButton.hidden = typeof config.onOpenLab !== 'function';
    createFragmentButton.hidden = typeof config.onCreateFragment !== 'function';
  }

  function renderGeometry() {
    const limits = selectionLimits();
    const visibleSpan = spanOf(view);
    const fraction = (time) => clamp(fractionOf(view, time), 0, 1);
    const from = fraction(selection.from);
    const to = fraction(selection.to);
    const needle = fraction(currentTime());
    setStyle(selectionBand, '--audio-lab-selection-left', `${from * 100}%`);
    setStyle(selectionBand, '--audio-lab-selection-width', `${Math.max(0, to - from) * 100}%`);
    setStyle(fromHandle, '--audio-lab-position', `${from * 100}%`);
    setStyle(toHandle, '--audio-lab-position', `${to * 100}%`);
    setStyle(playhead, '--audio-lab-position', `${needle * 100}%`);
    selectionBand.style.left = `${from * 100}%`;
    selectionBand.style.width = `${Math.max(0, to - from) * 100}%`;
    fromHandle.style.left = `${from * 100}%`;
    toHandle.style.left = `${to * 100}%`;
    playhead.style.left = `${needle * 100}%`;
    playhead.dataset.edge = needle <= 1e-6 ? 'start' : needle >= 1 - 1e-6 ? 'end' : 'inside';
    fromHandle.dataset.outside = selection.from < view.start ? 'before' : selection.from > view.end ? 'after' : 'false';
    toHandle.dataset.outside = selection.to < view.start ? 'before' : selection.to > view.end ? 'after' : 'false';
    fromHandle.dataset.edge = from <= 1e-6 ? 'start' : 'inside';
    toHandle.dataset.edge = to >= 1 - 1e-6 ? 'end' : 'inside';

    seekControl.setAttribute('aria-valuemin', String(limits.from));
    seekControl.setAttribute('aria-valuemax', String(limits.to));
    seekControl.setAttribute('aria-valuenow', String(currentTime()));
    seekControl.setAttribute('aria-valuetext', formatTimestamp(currentTime()));
    const least = Math.min(AUDIO_LAB_MIN_SELECTION, Math.max(0, limits.to - limits.from));
    for (const [handle, value, min, max] of [
      [fromHandle, selection.from, limits.from, Math.max(limits.from, selection.to - least)],
      [toHandle, selection.to, Math.min(limits.to, selection.from + least), limits.to],
    ]) {
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(max));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', formatTimestamp(value));
    }

    if (globalThis.document?.activeElement !== fromField) fromField.value = formatTimestamp(selection.from);
    if (globalThis.document?.activeElement !== toField) toField.value = formatTimestamp(selection.to);
    const selectedDuration = lengthOf(selection);
    selectionLength.textContent = formatAudioLabDuration(selectedDuration);
    selectionLength.setAttribute(
      'aria-label',
      `Duración de la selección: ${formatAudioLabDurationAria(selectedDuration)}`,
    );
    selectionBadge.textContent = formatAudioLabDuration(selectedDuration);
    const contextSpan = Math.max(0, limits.to - limits.from);
    const zoomTimes = contextSpan > 0 ? contextSpan / visibleSpan : 1;
    zoomOutput.textContent = `${zoomTimes < 1.02 ? 1 : zoomTimes < 10 ? zoomTimes.toFixed(1) : Math.round(zoomTimes)}×`;
    const wholeContextView = contextView();
    const selectionView = viewForRange(selection);
    const matchesView = (candidate) => (
      Math.abs(view.start - candidate.start) <= 1e-6
      && Math.abs(view.end - candidate.end) <= 1e-6
    );
    fitButton.disabled = disabled || !(duration > 0) || matchesView(wholeContextView);
    fitSelectionButton.disabled = disabled || !(selection.to > selection.from) || matchesView(selectionView);
    zoomInButton.disabled = disabled || !(duration > 0) || visibleSpan <= Math.min(MIN_SPAN, contextSpan) + 1e-6;
    zoomOutButton.disabled = disabled || !(duration > 0) || visibleSpan >= contextSpan - 1e-6;
    const fitLabel = config.preferSelectionPlayback ? 'Mostrar todo el fragmento' : 'Mostrar todo el audio';
    fitButton.setAttribute('aria-label', fitLabel);
    fitButton.setAttribute('title', fitLabel);
  }

  function paintWaveform() {
    const peakStatus = normalizePeakStatus(config.peaksStatus, peaks.length > 0);
    node.dataset.peaks = peakStatus;
    fallback.hidden = peakStatus === 'ready';
    fallbackText.textContent = peakStatus === 'loading'
      ? 'Analizando la forma de onda…'
      : peakStatus === 'unavailable'
        ? String(config.peaksMessage || 'No se pudo generar la forma de onda en este navegador.')
        : 'Preparando la forma de onda…';
    retryPeaksButton.hidden = peakStatus !== 'unavailable' || typeof config.onRetryPeaks !== 'function';
    retryPeaksButton.disabled = peakStatus === 'loading';
    const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!context) return;

    const cssWidth = Math.max(1, Math.round(canvas.clientWidth || 640));
    const cssHeight = Math.max(1, Math.round(canvas.clientHeight || 128));
    const ratio = clamp(Number(globalThis.devicePixelRatio) || 1, 1, 3);
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(cssHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    let identityColor = '';
    try {
      identityColor = globalThis.getComputedStyle?.(node)?.getPropertyValue('--audio-lab-identity')?.trim() || '';
    } catch { /* computed styles are best-effort in tests and detached DOM */ }
    context.strokeStyle = peaks.length ? identityColor || '#77ded0' : 'rgba(160, 180, 174, 0.45)';
    context.lineWidth = 1;
    context.beginPath();
    if (!peaks.length) {
      context.moveTo(0, cssHeight / 2);
      context.lineTo(cssWidth, cssHeight / 2);
    } else {
      const buckets = bucketNormalizedAudioPeaks(peaks, Math.max(1, Math.floor(cssWidth / 2)), view, duration);
      const center = cssHeight / 2;
      const scale = cssHeight * 0.44;
      buckets.forEach((peak, index) => {
        const x = ((index + 0.5) / buckets.length) * cssWidth;
        context.moveTo(x, center - peak.max * scale);
        context.lineTo(x, center - peak.min * scale);
      });
    }
    context.stroke();
  }

  function render() {
    if (destroyed) return;
    nameNode.textContent = String(config.name || 'Audio');
    node.dataset.disabled = String(disabled);
    node.dataset.loop = String(looping);
    node.dataset.fragmentDepth = String(normalizedFragmentDepth());
    node.dataset.accent = normalizedFragmentAccent();
    node.setAttribute('aria-disabled', String(disabled));
    fromField.disabled = disabled || !(duration > 0);
    toField.disabled = disabled || !(duration > 0);
    markFromButton.disabled = disabled || !(duration > 0);
    markToButton.disabled = disabled || !(duration > 0);
    seekControl.tabIndex = disabled ? -1 : 0;
    fromHandle.tabIndex = disabled ? -1 : 0;
    toHandle.tabIndex = disabled ? -1 : 0;
    for (const slider of [seekControl, fromHandle, toHandle]) {
      slider.setAttribute('aria-disabled', String(disabled || !(duration > 0)));
    }
    for (const control of buttons) {
      if (disabled) control.disabled = true;
    }
    renderTransport();
    renderGeometry();
  }

  function emitSelection(source, commit) {
    config.onSelectionChange?.({ ...selection }, { source, commit });
    if (commit) announce(`Selección de ${formatTimestamp(selection.from)} a ${formatTimestamp(selection.to)}.`);
  }

  function applySelection(next, { source = 'api', notify = false, commit = true } = {}) {
    if (destroyed) return;
    pendingSelection = next ? { ...next } : null;
    selection = normalizeBoundedAudioSelection(next, duration, config.selectionBounds);
    selectionFollowsBounds = next == null;
    render();
    if (notify) emitSelection(source, commit);
  }

  function setSelectionEdge(which, value, context) {
    if (!(duration > 0)) return;
    const limits = selectionLimits();
    const least = Math.min(AUDIO_LAB_MIN_SELECTION, Math.max(0, limits.to - limits.from));
    selection = which === 'from'
      ? { from: clamp(finiteTime(value), limits.from, Math.max(limits.from, selection.to - least)), to: selection.to }
      : { from: selection.from, to: clamp(finiteTime(value), Math.min(limits.to, selection.from + least), limits.to) };
    pendingSelection = { ...selection };
    selectionFollowsBounds = false;
    render();
    emitSelection(context.source, context.commit);
  }

  function seek(seconds, { follow = true } = {}) {
    if (destroyed || !(duration > 0)) return;
    const limits = selectionLimits();
    let target = clamp(finiteTime(seconds), limits.from, limits.to);
    if (playbackScope === 'selection' && media.paused === false) {
      target = clamp(target, selection.from, selection.to);
    }
    try { media.currentTime = target; } catch { return; }
    const previousView = view;
    if (follow) view = revealInContext(view, target);
    render();
    if (view !== previousView) paintWaveform();
  }

  function manualTimelineInteractionActive() {
    const focused = globalThis.document?.activeElement;
    return Boolean(stopPointerDrag || focused === fromHandle || focused === toHandle);
  }

  function reducedMotionPreferred() {
    const matchMedia = globalThis.matchMedia || globalThis.window?.matchMedia;
    if (typeof matchMedia !== 'function') return false;
    try {
      return matchMedia.call(globalThis.window || globalThis, '(prefers-reduced-motion: reduce)').matches === true;
    } catch {
      return false;
    }
  }

  function updatePlaybackView({ boundaryJump = false, final = false } = {}) {
    const previousView = view;
    const mayFollow = duration > 0
      && !manualTimelineInteractionActive()
      // A loop/rebase writes currentTime itself and browsers immediately expose
      // `seeking=true`. That boundary jump is already authoritative, so show it
      // now instead of leaving one stale frame on screen.
      && (final || boundaryJump || (media.paused === false && media.seeking !== true));
    if (mayFollow) {
      view = reducedMotionPreferred()
        ? revealInContext(view, currentTime())
        : followInContext(view, currentTime());
    }
    render();
    if (view !== previousView) paintWaveform();
  }

  function monitorPlayback() {
    frameId = null;
    if (destroyed || media.paused !== false) return;
    const boundary = enforceSelectionBoundary();
    if (boundary === 'stop') {
      // `enforceSelectionBoundary` has already fixed the media clock. Render
      // that final position even though pausing made ordinary follow inactive.
      updatePlaybackView({ final: true });
      return;
    }
    updatePlaybackView({ boundaryJump: boundary === 'loop' || boundary === 'rebase' });
    frameId = requestFrame(monitorPlayback);
  }

  function enforceSelectionBoundary() {
    const boundary = audioSelectionBoundary({
      currentTime: currentTime(),
      selection,
      playingSelection: playbackScope === 'selection',
      loop: looping,
    });
    if (boundary.action === 'loop' || boundary.action === 'rebase') {
      try { media.currentTime = boundary.time; } catch { /* media may have become unavailable */ }
    } else if (boundary.action === 'stop') {
      playbackScope = 'all';
      media.pause();
      try { media.currentTime = boundary.time; } catch { /* media may have become unavailable */ }
      stopPlaybackMonitor();
      render();
      return 'stop';
    }
    return boundary.action;
  }

  function startPlaybackMonitor() {
    if (frameId == null && !destroyed) frameId = requestFrame(monitorPlayback);
  }

  function startMedia() {
    if (disabled || !sourceAvailable()) return;
    let promise;
    try { promise = media.play(); } catch { render(); return; }
    if (promise && typeof promise.catch === 'function') promise.catch(() => render());
  }

  function togglePlayback() {
    if (media.paused === false) {
      media.pause();
      return;
    }
    playbackScope = intendedPlaybackScope();
    if (playbackScope === 'selection' && (currentTime() < selection.from || currentTime() >= selection.to)) {
      seek(selection.from, { follow: true });
    } else {
      const limits = selectionLimits();
      if (duration > 0 && currentTime() >= limits.to - LOOP_EPSILON) {
        seek(limits.from, { follow: true });
      }
    }
    startMedia();
  }

  function synchronizePlaybackScope() {
    if (media.paused !== false) return;
    playbackScope = intendedPlaybackScope();
    if (playbackScope === 'selection' && (currentTime() < selection.from || currentTime() >= selection.to)) {
      seek(selection.from, { follow: true });
    }
  }

  function toggleLoop(source) {
    if (disabled || !(selection.to > selection.from)) return;
    looping = !looping;
    synchronizePlaybackScope();
    render();
    announce(looping ? 'Loop de la selección activado.' : 'Loop desactivado.');
    config.onLoopChange?.(looping, { source });
  }

  function changeZoom(factor, at = currentTime()) {
    if (!(duration > 0)) return;
    const limits = selectionLimits();
    const contextSpan = Math.max(0, limits.to - limits.from);
    if (!(contextSpan > 0)) return;
    const minimum = Math.min(MIN_SPAN, contextSpan);
    const width = clamp(spanOf(view) * factor, minimum, contextSpan);
    const where = clamp(fractionOf(view, at), 0, 1);
    const start = clamp(at - where * width, limits.from, limits.to - width);
    view = { start, end: start + width };
    render();
    paintWaveform();
  }

  function eventTime(event) {
    const box = track.getBoundingClientRect?.();
    if (!box?.width) return currentTime();
    const fraction = clamp((finiteTime(event.clientX) - box.left) / box.width, 0, 1);
    return timeAt(view, fraction);
  }

  function waveformTime(event) {
    const limits = selectionLimits();
    const visibleFrom = clamp(view.start, limits.from, limits.to);
    const visibleTo = clamp(view.end, visibleFrom, limits.to);
    return clamp(eventTime(event), visibleFrom, visibleTo);
  }

  function stopDrag({ cancelled = false } = {}) {
    const active = stopPointerDrag;
    stopPointerDrag = null;
    active?.(cancelled);
  }

  function beginWaveformGesture(event) {
    if (
      disabled
      || !(duration > 0)
      || event.isPrimary === false
      || (event.button != null && event.button !== 0)
      || event.target?.closest?.('.audio-lab-selection-handle')
    ) return;
    const target = globalThis.window || globalThis;
    if (typeof target.addEventListener !== 'function') return;

    stopDrag({ cancelled: true });
    const pointerId = event.pointerId;
    const pointerType = String(event.pointerType || 'mouse');
    const originX = finiteTime(event.clientX);
    const originY = finiteTime(event.clientY);
    const anchor = waveformTime(event);
    const initial = { ...selection };
    const initialPending = pendingSelection ? { ...pendingSelection } : null;
    const initialFollowsBounds = selectionFollowsBounds;
    let selecting = false;
    let abandoned = false;
    let changed = false;

    const ownsPointer = (moveEvent) => (
      pointerId == null || moveEvent.pointerId == null || moveEvent.pointerId === pointerId
    );
    const sameSelection = (left, right) => (
      Math.abs(left.from - right.from) <= 1e-9 && Math.abs(left.to - right.to) <= 1e-9
    );
    const rangeAt = (moveEvent) => {
      const at = waveformTime(moveEvent);
      const limits = selectionLimits();
      const visibleFrom = clamp(view.start, limits.from, limits.to);
      const visibleTo = clamp(view.end, visibleFrom, limits.to);
      const minimum = Math.min(AUDIO_LAB_MIN_SELECTION, Math.max(0, visibleTo - visibleFrom));
      let from = Math.min(anchor, at);
      let to = Math.max(anchor, at);
      if (to - from < minimum) {
        if (at >= anchor) to = Math.min(visibleTo, from + minimum);
        else from = Math.max(visibleFrom, to - minimum);
      }
      return normalizeBoundedAudioSelection({ from, to }, duration, {
        from: visibleFrom,
        to: visibleTo,
      });
    };
    const updateRegion = (moveEvent) => {
      const next = rangeAt(moveEvent);
      if (sameSelection(next, selection)) return;
      changed = true;
      applySelection(next, { source: 'waveform', notify: true, commit: false });
    };
    const move = (moveEvent) => {
      if (!ownsPointer(moveEvent) || abandoned) return;
      const deltaX = Math.abs(finiteTime(moveEvent.clientX) - originX);
      const deltaY = Math.abs(finiteTime(moveEvent.clientY) - originY);
      if (!selecting) {
        if (pointerType === 'touch' && deltaY >= REGION_DRAG_THRESHOLD_PX && deltaY > deltaX) {
          abandoned = true;
          return;
        }
        if (deltaX < REGION_DRAG_THRESHOLD_PX) return;
        selecting = true;
        node.dataset.dragging = 'selection';
      }
      moveEvent.preventDefault?.();
      updateRegion(moveEvent);
    };
    const finish = (cancelled = false, upEvent = null) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      target.removeEventListener('keydown', escape);
      delete node.dataset.dragging;
      if (cancelled) {
        if (selecting && changed) {
          selection = initial;
          pendingSelection = initialPending;
          selectionFollowsBounds = initialFollowsBounds;
          render();
          if (!destroyed) emitSelection('waveform-cancel', true);
        }
      } else if (selecting) {
        if (upEvent) updateRegion(upEvent);
        if (!destroyed) {
          playbackScope = intendedPlaybackScope();
          seek(selection.from, { follow: false });
          emitSelection('waveform', true);
        }
      } else if (!abandoned && upEvent && !destroyed) {
        seek(waveformTime(upEvent), { follow: false });
      }
      if (!destroyed && !cancelled && !abandoned) seekControl.focus?.({ preventScroll: true });
    };
    const up = (upEvent) => {
      if (!ownsPointer(upEvent)) return;
      stopPointerDrag = null;
      finish(false, upEvent);
    };
    const cancel = (cancelEvent) => {
      if (!ownsPointer(cancelEvent)) return;
      stopPointerDrag = null;
      finish(true);
    };
    const escape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault?.();
      stopPointerDrag = null;
      finish(true);
    };
    stopPointerDrag = (cancelled) => finish(cancelled);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', cancel);
    target.addEventListener('keydown', escape);
  }

  function beginHandleDrag(event, which) {
    if (disabled || !(duration > 0) || (event.button != null && event.button !== 0)) return;
    const target = globalThis.window || globalThis;
    if (typeof target.addEventListener !== 'function') return;
    event.preventDefault?.();
    stopDrag({ cancelled: true });
    const initial = { ...selection };
    const initialPending = pendingSelection ? { ...pendingSelection } : null;
    const initialFollowsBounds = selectionFollowsBounds;
    let moved = false;
    const move = (moveEvent) => {
      moved = true;
      setSelectionEdge(which, eventTime(moveEvent), { source: 'pointer', commit: false });
    };
    const finish = (cancelled = false) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      target.removeEventListener('keydown', escape);
      if (cancelled) {
        selection = initial;
        pendingSelection = initialPending;
        selectionFollowsBounds = initialFollowsBounds;
        render();
        if (moved && !destroyed) emitSelection('pointer-cancel', true);
      } else if (moved) emitSelection('pointer', true);
    };
    const up = () => { stopPointerDrag = null; finish(false); };
    const cancel = () => { stopPointerDrag = null; finish(true); };
    const escape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      cancel();
    };
    stopPointerDrag = (cancelled) => finish(cancelled);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', cancel);
    target.addEventListener('keydown', escape);
  }

  function handleSelectionKey(event, which) {
    if (disabled || !(duration > 0)) return;
    const limits = selectionLimits();
    const least = Math.min(AUDIO_LAB_MIN_SELECTION, Math.max(0, limits.to - limits.from));
    const amount = event.altKey ? step('fine') : event.shiftKey ? step('second') : step('frame', null);
    let next = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = selection[which] - amount;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = selection[which] + amount;
    else if (event.key === 'Home') next = which === 'from' ? limits.from : selection.from + least;
    else if (event.key === 'End') next = which === 'to' ? limits.to : selection.to - least;
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectionEdge(which, next, { source: 'keyboard', commit: true });
  }

  function handleSeekKey(event) {
    if (disabled || !(duration > 0)) return;
    const limits = selectionLimits();
    let next = null;
    const amount = event.altKey ? step('fine') : event.shiftKey ? step('second') : step('frame', null);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = currentTime() - amount;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = currentTime() + amount;
    else if (event.key === 'PageDown') next = currentTime() - BUTTON_SEEK_SECONDS;
    else if (event.key === 'PageUp') next = currentTime() + BUTTON_SEEK_SECONDS;
    else if (event.key === 'Home') next = limits.from;
    else if (event.key === 'End') next = limits.to;
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    seek(next);
  }

  function commitTimeField(field, which) {
    const parsed = parseTimestamp(field.value);
    if (parsed == null) {
      field.value = formatTimestamp(selection[which]);
      announce('El tiempo escrito no es válido. Se restauró el valor anterior.');
      return;
    }
    setSelectionEdge(which, parsed, { source: 'field', commit: true });
    // `render()` preserves a focused field so typing is not interrupted. A
    // committed value is different: reflect the clamped canonical time now.
    field.value = formatTimestamp(selection[which]);
  }

  function shortcutAllowed(event) {
    if (event.ctrlKey || event.metaKey) return false;
    const tag = String(event.target?.tagName || '').toUpperCase();
    return !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) && !event.target?.isContentEditable;
  }

  function applyKnownDuration(nextDuration, previousBounds = config.selectionBounds) {
    const next = finiteDuration(nextDuration);
    if (!next) return;
    if (next === duration) {
      clampMediaClockToContext();
      render();
      return;
    }
    const oldDuration = duration;
    const oldLimits = normalizeAudioSelectionBounds(previousBounds, oldDuration);
    const wasWhole = selectionFollowsBounds || (
      oldDuration > 0
      && Math.abs(selection.from - oldLimits.from) < 1e-6
      && Math.abs(selection.to - oldLimits.to) < 1e-6
    );
    const oldContextView = { start: oldLimits.from, end: oldLimits.to };
    const viewWasContext = oldDuration <= 0 || (
      Math.abs(view.start - oldContextView.start) < 1e-6
      && Math.abs(view.end - oldContextView.end) < 1e-6
    );
    duration = next;
    config.duration = duration;
    const limits = selectionLimits();
    selection = oldDuration <= 0 && pendingSelection
      ? normalizeBoundedAudioSelection(pendingSelection, duration, config.selectionBounds)
      : wasWhole ? { ...limits } : normalizeBoundedAudioSelection(selection, duration, config.selectionBounds);
    selectionFollowsBounds = wasWhole;
    pendingSelection = selectionFollowsBounds ? null : { ...selection };
    if (viewWasContext) view = contextView();
    else {
      const contextSpan = Math.max(0, limits.to - limits.from);
      const width = Math.min(spanOf(view), contextSpan);
      const start = clamp(view.start, limits.from, limits.to - width);
      view = { start, end: start + width };
    }
    clampMediaClockToContext();
    render();
    paintWaveform();
  }

  function clearKnownDuration() {
    if (!selectionFollowsBounds && duration > 0) pendingSelection = { ...selection };
    duration = 0;
    selection = { from: 0, to: 0 };
    view = fit(0);
    playbackScope = 'all';
  }

  function releaseSource() {
    stopPlaybackMonitor();
    media.pause();
    media.removeAttribute('src');
    try { media.load?.(); } catch { /* resetting a failed media element is best-effort */ }
    try { media.currentTime = 0; } catch { /* an empty media element may reject a seek */ }
    if (ownedUrl && typeof globalThis.URL?.revokeObjectURL === 'function') {
      globalThis.URL.revokeObjectURL(ownedUrl);
    }
    ownedUrl = null;
    activeBlob = null;
    activeExternalUrl = null;
    installedSourceUrl = null;
  }

  function installSource() {
    const external = config.url == null || config.url === '' ? null : String(config.url);
    const blob = external ? null : config.blob || null;
    if (external === activeExternalUrl && blob === activeBlob) return;
    releaseSource();

    let source = external;
    activeExternalUrl = external;
    activeBlob = blob;
    if (!source && blob && typeof globalThis.URL?.createObjectURL === 'function') {
      try {
        ownedUrl = globalThis.URL.createObjectURL(blob);
        source = ownedUrl;
      } catch {
        ownedUrl = null;
      }
    }
    if (source) {
      try {
        media.src = source;
        media.load?.();
        installedSourceUrl = source;
        delete node.dataset.mediaError;
      } catch {
        media.removeAttribute('src');
        if (ownedUrl && typeof globalThis.URL?.revokeObjectURL === 'function') {
          globalThis.URL.revokeObjectURL(ownedUrl);
        }
        ownedUrl = null;
        installedSourceUrl = null;
      }
    }
  }

  function createSelectedFragment() {
    if (
      disabled
      || fragmentCreationPending
      || typeof config.onCreateFragment !== 'function'
      || selectionCoversLimits()
      || !(selection.to > selection.from)
    ) return;
    const range = { ...selection };
    const context = { name: String(config.name || 'Audio'), duration: lengthOf(range) };
    let outcome;
    try {
      outcome = config.onCreateFragment(range, context);
    } catch {
      announce('No se pudo crear el fragmento.');
      return;
    }
    if (!outcome || typeof outcome.then !== 'function') {
      announce(outcome === false
        ? 'No se pudo crear el fragmento.'
        : `Fragmento de ${formatAudioLabDurationAria(lengthOf(range))} creado.`);
      return;
    }
    fragmentCreationPending = true;
    render();
    Promise.resolve(outcome).then((created) => {
      if (destroyed) return;
      fragmentCreationPending = false;
      render();
      announce(created === true
        ? `Fragmento de ${formatAudioLabDurationAria(lengthOf(range))} creado.`
        : 'No se pudo crear el fragmento.');
    }).catch(() => {
      if (destroyed) return;
      fragmentCreationPending = false;
      render();
      announce('No se pudo crear el fragmento.');
    });
  }

  removeListeners.push(
    on(playButton, 'click', togglePlayback),
    on(backButton, 'click', () => seek(currentTime() - BUTTON_SEEK_SECONDS)),
    on(forwardButton, 'click', () => seek(currentTime() + BUTTON_SEEK_SECONDS)),
    on(loopButton, 'click', () => toggleLoop('button')),
    on(zoomInButton, 'click', () => changeZoom(0.5)),
    on(zoomOutButton, 'click', () => changeZoom(2)),
    on(fitButton, 'click', () => { view = contextView(); render(); paintWaveform(); }),
    on(fitSelectionButton, 'click', () => { view = viewForRange(selection); render(); paintWaveform(); }),
    on(markFromButton, 'click', () => setSelectionEdge('from', currentTime(), { source: 'mark', commit: true })),
    on(markToButton, 'click', () => setSelectionEdge('to', currentTime(), { source: 'mark', commit: true })),
    on(createFragmentButton, 'click', createSelectedFragment),
    on(retryPeaksButton, 'pointerdown', (event) => event.stopPropagation()),
    on(retryPeaksButton, 'click', (event) => {
      event.stopPropagation();
      if (disabled || typeof config.onRetryPeaks !== 'function') return;
      config.peaksStatus = 'loading';
      config.peaksMessage = null;
      paintWaveform();
      try {
        Promise.resolve(config.onRetryPeaks()).catch(() => {});
      } catch {
        config.peaksStatus = 'unavailable';
        config.peaksMessage = 'No se pudo reintentar el análisis de la forma de onda.';
        paintWaveform();
      }
    }),
    on(openLabButton, 'click', () => {
      if (disabled || typeof config.onOpenLab !== 'function') return;
      config.onOpenLab({
        selection: { ...selection },
        view: { ...view },
        currentTime: currentTime(),
        loop: looping,
      });
    }),
    on(track, 'pointerdown', beginWaveformGesture),
    on(track, 'wheel', (event) => {
      if (disabled || !(duration > 0)) return;
      if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const delta = event.ctrlKey || event.metaKey ? event.deltaY : event.deltaX;
      changeZoom(delta > 0 ? 1 / WHEEL_ZOOM : WHEEL_ZOOM, eventTime(event));
    }, { passive: false }),
    on(fromHandle, 'pointerdown', (event) => beginHandleDrag(event, 'from')),
    on(toHandle, 'pointerdown', (event) => beginHandleDrag(event, 'to')),
    on(fromHandle, 'keydown', (event) => handleSelectionKey(event, 'from')),
    on(toHandle, 'keydown', (event) => handleSelectionKey(event, 'to')),
    on(seekControl, 'keydown', handleSeekKey),
    on(fromField, 'change', () => commitTimeField(fromField, 'from')),
    on(toField, 'change', () => commitTimeField(toField, 'to')),
    on(fromField, 'keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitTimeField(fromField, 'from'); }
    }),
    on(toField, 'keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitTimeField(toField, 'to'); }
    }),
    on(node, 'keydown', (event) => {
      if (disabled || !shortcutAllowed(event)) return;
      const key = event.key;
      if (key === ' ') { event.preventDefault(); togglePlayback(); }
      else if (key === 'l' || key === 'L') { event.preventDefault(); toggleLoop('shortcut'); }
      else if (key === 'i' || key === 'I') {
        event.preventDefault();
        setSelectionEdge('from', currentTime(), { source: 'shortcut', commit: true });
      } else if (key === 'o' || key === 'O') {
        event.preventDefault();
        setSelectionEdge('to', currentTime(), { source: 'shortcut', commit: true });
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        const amount = event.altKey ? step('fine') : event.shiftKey ? step('second') : step('frame', null);
        seek(nudge(currentTime(), key === 'ArrowRight' ? amount : -amount, duration));
      }
    }),
    on(media, 'loadedmetadata', () => applyKnownDuration(media.duration)),
    on(media, 'durationchange', () => applyKnownDuration(media.duration)),
    on(media, 'timeupdate', () => {
      const boundary = enforceSelectionBoundary();
      if (boundary === 'stop') {
        updatePlaybackView({ final: true });
        return;
      }
      // `timeupdate` is the background-tab fallback for the animation monitor.
      // A paused update must not unexpectedly recenter the user's viewport.
      updatePlaybackView({ boundaryJump: boundary === 'loop' || boundary === 'rebase' });
    }),
    on(media, 'seeking', render),
    on(media, 'play', () => { render(); startPlaybackMonitor(); }),
    on(media, 'pause', () => { stopPlaybackMonitor(); render(); }),
    on(media, 'ended', () => {
      const boundary = enforceSelectionBoundary();
      if (boundary === 'loop' || boundary === 'rebase') {
        updatePlaybackView({ boundaryJump: true });
        startMedia();
      } else {
        // Native full-file playback reports `continue` here because there is
        // no selection boundary to enforce. It still needs the same final
        // viewport update as a one-shot selection before the monitor stops.
        updatePlaybackView({ final: true });
        stopPlaybackMonitor();
      }
    }),
    on(media, 'error', () => {
      stopPlaybackMonitor();
      playbackScope = 'all';
      media.pause();
      node.dataset.mediaError = 'true';
      announce('Este navegador no puede reproducir el audio, pero el archivo sigue disponible para procesar o descargar.');
      render();
    }),
  );

  if (typeof globalThis.ResizeObserver === 'function') {
    resizeObserver = new globalThis.ResizeObserver(() => paintWaveform());
    resizeObserver.observe(track);
  }

  installSource();
  clampMediaClockToContext();
  render();
  paintWaveform();

  return {
    node,
    media,
    update(next = {}) {
      if (destroyed) return;
      const previousBounds = config.selectionBounds;
      const sourcePatch = own(next, 'blob') || own(next, 'url');
      const desiredUrl = own(next, 'url') ? next.url : own(next, 'blob') ? null : config.url;
      const desiredBlob = own(next, 'blob') ? next.blob : own(next, 'url') ? null : config.blob;
      const sourceWillChange = sourcePatch && (
        desiredUrl !== config.url || desiredBlob !== config.blob
      );

      config = { ...config, ...next, url: desiredUrl, blob: desiredBlob };

      if (sourceWillChange) {
        if (!own(next, 'duration')) config.duration = null;
        if (!own(next, 'peaks')) config.peaks = null;
        if (!own(next, 'peaksStatus')) config.peaksStatus = 'idle';
        if (!own(next, 'peaksMessage')) config.peaksMessage = null;
        duration = finiteDuration(config.duration);
        peaks = normalizeAudioPeaks(config.peaks);
        pendingSelection = own(next, 'selection') && next.selection ? { ...next.selection } : null;
        selection = normalizeBoundedAudioSelection(pendingSelection, duration, config.selectionBounds);
        selectionFollowsBounds = !own(next, 'selection') || next.selection == null;
        view = contextView();
        playbackScope = 'all';
        installSource();
        clampMediaClockToContext();
      } else {
        if (own(next, 'duration')) {
          if (finiteDuration(next.duration)) applyKnownDuration(next.duration, previousBounds);
          else clearKnownDuration();
        }
        if (own(next, 'peaks')) peaks = normalizeAudioPeaks(next.peaks);
        const previousLimits = normalizeAudioSelectionBounds(previousBounds, duration);
        const nextLimits = selectionLimits();
        const boundsChanged = own(next, 'selectionBounds') && (
          Math.abs(previousLimits.from - nextLimits.from) > 1e-6
          || Math.abs(previousLimits.to - nextLimits.to) > 1e-6
        );
        if (boundsChanged && !own(next, 'selection')) {
          const followedPreviousBounds = selectionFollowsBounds || (
            Math.abs(selection.from - previousLimits.from) <= LOOP_EPSILON
            && Math.abs(selection.to - previousLimits.to) <= LOOP_EPSILON
          );
          selection = followedPreviousBounds
            ? { ...nextLimits }
            : normalizeBoundedAudioSelection(selection, duration, config.selectionBounds);
          selectionFollowsBounds = followedPreviousBounds;
          pendingSelection = selectionFollowsBounds ? null : { ...selection };
        }
        if (own(next, 'selection')) {
          pendingSelection = next.selection ? { ...next.selection } : null;
          selection = normalizeBoundedAudioSelection(next.selection, duration, config.selectionBounds);
          selectionFollowsBounds = next.selection == null;
        }
        if (boundsChanged) {
          view = contextView();
          try { media.currentTime = clamp(currentTime(), nextLimits.from, nextLimits.to); } catch { /* best-effort */ }
        }
      }
      if (own(next, 'loop')) looping = Boolean(next.loop);
      if (own(next, 'disabled')) {
        disabled = Boolean(next.disabled);
        if (disabled) media.pause();
      }
      if (
        own(next, 'selection')
        || own(next, 'selectionBounds')
        || own(next, 'preferSelectionPlayback')
        || own(next, 'loop')
      ) synchronizePlaybackScope();
      render();
      if (
        own(next, 'peaks')
        || own(next, 'peaksStatus')
        || own(next, 'peaksMessage')
        || own(next, 'onRetryPeaks')
        || own(next, 'duration')
        || own(next, 'selection')
        || own(next, 'selectionBounds')
        || own(next, 'fragmentAccent')
        || sourceWillChange
      ) paintWaveform();
    },
    selection: () => ({ ...selection }),
    view: () => ({ ...view }),
    seek: (seconds) => seek(seconds),
    togglePlayback,
    setSelection(next, notify = false) {
      applySelection(next, { source: 'api', notify: Boolean(notify), commit: true });
    },
    focus() {
      if (destroyed) return;
      playButton.focus?.({ preventScroll: true });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopDrag({ cancelled: true });
      stopPlaybackMonitor();
      resizeObserver?.disconnect();
      for (const remove of removeListeners) remove();
      releaseSource();
      node.replaceChildren();
    },
  };
}
