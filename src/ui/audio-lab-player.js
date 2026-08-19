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
  fit,
  followPlayback,
  fractionOf,
  lengthOf,
  nudge,
  pan,
  reveal,
  selectAll,
  setFrom,
  setTo,
  spanOf,
  step,
  timeAt,
  zoom,
} from '../media/timeline.js';

export const AUDIO_LAB_MIN_SELECTION = 0.01;

const WHEEL_ZOOM = 0.82;
const BUTTON_SEEK_SECONDS = 10;
const LOOP_EPSILON = 0.008;

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

/**
 * Clamp a proposed range to an audio duration without allowing its edges to
 * cross. Missing ranges mean the whole file, matching MediaForge's scrubber.
 */
export function normalizeAudioSelection(selection, duration, least = AUDIO_LAB_MIN_SELECTION) {
  const total = finiteDuration(duration);
  if (!total) return { from: 0, to: 0 };

  const minimum = Math.min(total, Math.max(0, finiteTime(least, AUDIO_LAB_MIN_SELECTION)));
  if (!selection) return selectAll(total);

  const requestedFrom = finiteTime(selection.from, 0);
  const requestedTo = finiteTime(selection.to, total);
  let normalized = selectAll(total);
  // Set the far edge first. If an inverted external range arrives, the start
  // is then stopped just before it instead of silently swapping edge roles.
  normalized = setTo(normalized, requestedTo, { duration: total, least: minimum });
  normalized = setFrom(normalized, requestedFrom, { duration: total, least: minimum });
  return normalized;
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
 * @param {AudioLabSelection|null} [options.selection]
 * @param {boolean} [options.loop]
 * @param {boolean} [options.disabled]
 * @param {(selection: AudioLabSelection, context: {source: string, commit: boolean}) => void} [options.onSelectionChange]
 * @param {(loop: boolean, context: {source: 'button'|'shortcut'}) => void} [options.onLoopChange]
 * @param {(selection: AudioLabSelection, context: {name: string, duration: number}) => void} [options.onCreateFragment]
 * @param {(state: {selection: AudioLabSelection, view: AudioLabView, currentTime: number, loop: boolean}) => void} [options.onOpenLab]
 * @returns {{
 *   node: HTMLElement,
 *   media: HTMLAudioElement,
 *   update: (next: object) => void,
 *   selection: () => AudioLabSelection,
 *   view: () => AudioLabView,
 *   seek: (seconds: number) => void,
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
    selection: null,
    loop: false,
    disabled: false,
    onSelectionChange: null,
    onLoopChange: null,
    onCreateFragment: null,
    onOpenLab: null,
    ...options,
  };
  let duration = finiteDuration(config.duration);
  let pendingSelection = config.selection ? { ...config.selection } : null;
  let selection = normalizeAudioSelection(config.selection, duration);
  let selectionFollowsDuration = config.selection == null;
  let view = fit(duration);
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
    text: 'Espacio reproduce o pausa. L activa el loop. I y O marcan inicio y final. Las flechas mueven el cabezal; Shift mueve un segundo y Alt diez milisegundos.',
  });

  const canvas = el('canvas', {
    class: 'audio-lab-waveform-canvas',
    width: 960,
    height: 180,
    attrs: { 'aria-hidden': 'true' },
  });
  const fallback = el('p', {
    class: 'audio-lab-waveform-fallback',
    text: 'La forma de onda todavía no está disponible. Podés reproducir y elegir tiempos igualmente.',
  });
  const selectionBand = el('span', { class: 'audio-lab-selection-band', attrs: { 'aria-hidden': 'true' } });
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
  const track = el('div', {
    class: 'audio-lab-waveform-track',
    attrs: {
      role: 'group',
      'aria-label': 'Forma de onda y selección',
    },
  }, [canvas, selectionBand, playhead, seekControl, fromHandle, toHandle, fallback]);

  const playButton = button('Reproducir', 'play', '▶', { 'aria-keyshortcuts': 'Space' });
  const backButton = button(`Retroceder ${BUTTON_SEEK_SECONDS} segundos`, 'back', `−${BUTTON_SEEK_SECONDS}`);
  const forwardButton = button(`Avanzar ${BUTTON_SEEK_SECONDS} segundos`, 'forward', `+${BUTTON_SEEK_SECONDS}`);
  const timeOutput = el('output', { class: 'audio-lab-time', text: clockLabel(0, duration), attrs: { 'aria-live': 'off' } });
  const playSelectionButton = button('Reproducir la selección', 'play-selection', 'Reproducir selección');
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
    dataset: { disabled: String(disabled), peaks: peaks.length ? 'ready' : 'unavailable' },
    attrs: {
      'aria-labelledby': titleId,
      'aria-describedby': helpId,
      'aria-disabled': String(disabled),
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
      backButton,
      playButton,
      forwardButton,
      timeOutput,
      playSelectionButton,
      loopButton,
    ]),
    el('div', { class: 'audio-lab-zoom-controls', attrs: { role: 'group', 'aria-label': 'Zoom de la forma de onda' } }, [
      zoomOutButton,
      zoomInButton,
      fitButton,
      fitSelectionButton,
      zoomOutput,
    ]),
    el('div', { class: 'audio-lab-selection-controls', attrs: { role: 'group', 'aria-label': 'Selección de audio' } }, [
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

  function renderTransport() {
    const playing = media.paused === false && media.ended !== true;
    playButton.textContent = playing ? '❚❚' : '▶';
    playButton.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    playButton.setAttribute('aria-pressed', String(playing));
    loopButton.setAttribute('aria-pressed', String(looping));
    loopButton.dataset.active = String(looping);
    timeOutput.textContent = clockLabel(currentTime(), duration);

    const canUseMedia = !disabled && sourceAvailable();
    const canUseRange = canUseMedia && duration > 0 && selection.to > selection.from;
    playButton.disabled = !canUseMedia;
    backButton.disabled = !canUseMedia;
    forwardButton.disabled = !canUseMedia;
    playSelectionButton.disabled = !canUseRange;
    loopButton.disabled = !canUseRange;
    createFragmentButton.disabled = !canUseRange || typeof config.onCreateFragment !== 'function';
    openLabButton.disabled = disabled || typeof config.onOpenLab !== 'function';
    openLabButton.hidden = typeof config.onOpenLab !== 'function';
    createFragmentButton.hidden = typeof config.onCreateFragment !== 'function';
  }

  function renderGeometry() {
    const total = duration || 1;
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

    seekControl.setAttribute('aria-valuemin', '0');
    seekControl.setAttribute('aria-valuemax', String(duration));
    seekControl.setAttribute('aria-valuenow', String(currentTime()));
    seekControl.setAttribute('aria-valuetext', formatTimestamp(currentTime()));
    const least = Math.min(AUDIO_LAB_MIN_SELECTION, duration);
    for (const [handle, value, min, max] of [
      [fromHandle, selection.from, 0, Math.max(0, selection.to - least)],
      [toHandle, selection.to, Math.min(duration, selection.from + least), duration],
    ]) {
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(max));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', formatTimestamp(value));
    }

    if (globalThis.document?.activeElement !== fromField) fromField.value = formatTimestamp(selection.from);
    if (globalThis.document?.activeElement !== toField) toField.value = formatTimestamp(selection.to);
    selectionLength.textContent = formatDuration(lengthOf(selection));
    const zoomTimes = duration > 0 ? duration / visibleSpan : 1;
    zoomOutput.textContent = `${zoomTimes < 1.02 ? 1 : zoomTimes < 10 ? zoomTimes.toFixed(1) : Math.round(zoomTimes)}×`;
    fitButton.disabled = disabled || !(duration > 0) || visibleSpan >= total - 1e-6;
    fitSelectionButton.disabled = disabled || !(selection.to > selection.from);
    zoomInButton.disabled = disabled || !(duration > 0) || visibleSpan <= AUDIO_LAB_MIN_SELECTION + 1e-6;
    zoomOutButton.disabled = disabled || !(duration > 0) || visibleSpan >= total - 1e-6;
  }

  function paintWaveform() {
    node.dataset.peaks = peaks.length ? 'ready' : 'unavailable';
    fallback.hidden = peaks.length > 0;
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
    context.strokeStyle = peaks.length ? '#77ded0' : 'rgba(160, 180, 174, 0.45)';
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
    selection = normalizeAudioSelection(next, duration);
    selectionFollowsDuration = false;
    render();
    if (notify) emitSelection(source, commit);
  }

  function setSelectionEdge(which, value, context) {
    if (!(duration > 0)) return;
    const least = Math.min(AUDIO_LAB_MIN_SELECTION, duration);
    selection = which === 'from'
      ? setFrom(selection, value, { duration, least })
      : setTo(selection, value, { duration, least });
    pendingSelection = { ...selection };
    selectionFollowsDuration = false;
    render();
    emitSelection(context.source, context.commit);
  }

  function seek(seconds, { follow = true } = {}) {
    if (destroyed || !(duration > 0)) return;
    let target = clamp(finiteTime(seconds), 0, duration);
    if (playbackScope === 'selection' && media.paused === false) {
      target = clamp(target, selection.from, selection.to);
    }
    try { media.currentTime = target; } catch { return; }
    const previousView = view;
    if (follow) view = reveal(view, target, duration);
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
        ? reveal(view, currentTime(), duration)
        : followPlayback(view, currentTime(), duration);
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
    playbackScope = looping ? 'selection' : 'all';
    if (playbackScope === 'selection' && (currentTime() < selection.from || currentTime() >= selection.to)) {
      seek(selection.from, { follow: true });
    } else if (duration > 0 && currentTime() >= duration - LOOP_EPSILON) {
      seek(0, { follow: true });
    }
    startMedia();
  }

  function playSelection() {
    if (disabled || !(selection.to > selection.from) || !sourceAvailable()) return;
    playbackScope = 'selection';
    if (currentTime() < selection.from || currentTime() >= selection.to - LOOP_EPSILON) {
      seek(selection.from, { follow: true });
    }
    startMedia();
  }

  function toggleLoop(source) {
    if (disabled || !(selection.to > selection.from)) return;
    looping = !looping;
    if (looping && media.paused === false) {
      playbackScope = 'selection';
      if (currentTime() < selection.from || currentTime() >= selection.to) seek(selection.from);
    }
    render();
    announce(looping ? 'Loop de la selección activado.' : 'Loop desactivado.');
    config.onLoopChange?.(looping, { source });
  }

  function changeZoom(factor, at = currentTime()) {
    if (!(duration > 0)) return;
    view = zoom(view, factor, at, duration);
    render();
    paintWaveform();
  }

  function eventTime(event) {
    const box = track.getBoundingClientRect?.();
    if (!box?.width) return currentTime();
    const fraction = clamp((finiteTime(event.clientX) - box.left) / box.width, 0, 1);
    return timeAt(view, fraction);
  }

  function stopDrag({ cancelled = false } = {}) {
    const active = stopPointerDrag;
    stopPointerDrag = null;
    active?.(cancelled);
  }

  function beginHandleDrag(event, which) {
    if (disabled || !(duration > 0) || (event.button != null && event.button !== 0)) return;
    const target = globalThis.window || globalThis;
    if (typeof target.addEventListener !== 'function') return;
    event.preventDefault?.();
    stopDrag({ cancelled: true });
    const initial = { ...selection };
    const initialPending = pendingSelection ? { ...pendingSelection } : null;
    const initialFollowsDuration = selectionFollowsDuration;
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
        selectionFollowsDuration = initialFollowsDuration;
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
    const amount = event.altKey ? step('fine') : event.shiftKey ? step('second') : step('frame', null);
    let next = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = selection[which] - amount;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = selection[which] + amount;
    else if (event.key === 'Home') next = which === 'from' ? 0 : selection.from + Math.min(AUDIO_LAB_MIN_SELECTION, duration);
    else if (event.key === 'End') next = which === 'to' ? duration : selection.to - Math.min(AUDIO_LAB_MIN_SELECTION, duration);
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectionEdge(which, next, { source: 'keyboard', commit: true });
  }

  function handleSeekKey(event) {
    if (disabled || !(duration > 0)) return;
    let next = null;
    const amount = event.altKey ? step('fine') : event.shiftKey ? step('second') : step('frame', null);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = currentTime() - amount;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = currentTime() + amount;
    else if (event.key === 'PageDown') next = currentTime() - BUTTON_SEEK_SECONDS;
    else if (event.key === 'PageUp') next = currentTime() + BUTTON_SEEK_SECONDS;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = duration;
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

  function applyKnownDuration(nextDuration) {
    const next = finiteDuration(nextDuration);
    if (!next || next === duration) return;
    const oldDuration = duration;
    const wasWhole = selectionFollowsDuration
      || (oldDuration > 0 && Math.abs(selection.from) < 1e-6 && Math.abs(selection.to - oldDuration) < 1e-6);
    const viewWasWhole = oldDuration <= 0
      || (Math.abs(view.start) < 1e-6 && Math.abs(view.end - Math.max(oldDuration, spanOf(fit(oldDuration)))) < 1e-6);
    duration = next;
    config.duration = duration;
    selection = oldDuration <= 0 && pendingSelection
      ? normalizeAudioSelection(pendingSelection, duration)
      : wasWhole ? selectAll(duration) : normalizeAudioSelection(selection, duration);
    selectionFollowsDuration = wasWhole;
    pendingSelection = selectionFollowsDuration ? null : { ...selection };
    view = viewWasWhole ? fit(duration) : pan(fit(Math.min(spanOf(view), duration)), view.start, duration);
    render();
    paintWaveform();
  }

  function clearKnownDuration() {
    if (!selectionFollowsDuration && duration > 0) pendingSelection = { ...selection };
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

  removeListeners.push(
    on(playButton, 'click', togglePlayback),
    on(backButton, 'click', () => seek(currentTime() - BUTTON_SEEK_SECONDS)),
    on(forwardButton, 'click', () => seek(currentTime() + BUTTON_SEEK_SECONDS)),
    on(playSelectionButton, 'click', playSelection),
    on(loopButton, 'click', () => toggleLoop('button')),
    on(zoomInButton, 'click', () => changeZoom(0.5)),
    on(zoomOutButton, 'click', () => changeZoom(2)),
    on(fitButton, 'click', () => { view = fit(duration); render(); paintWaveform(); }),
    on(fitSelectionButton, 'click', () => { view = audioViewForSelection(selection, duration); render(); paintWaveform(); }),
    on(markFromButton, 'click', () => setSelectionEdge('from', currentTime(), { source: 'mark', commit: true })),
    on(markToButton, 'click', () => setSelectionEdge('to', currentTime(), { source: 'mark', commit: true })),
    on(createFragmentButton, 'click', () => {
      if (disabled || typeof config.onCreateFragment !== 'function' || !(selection.to > selection.from)) return;
      const range = { ...selection };
      config.onCreateFragment?.(range, { name: String(config.name || 'Audio'), duration: lengthOf(range) });
      announce(`Fragmento de ${formatDuration(lengthOf(range))} creado.`);
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
    on(track, 'pointerdown', (event) => {
      if (disabled || event.target === fromHandle || event.target === toHandle) return;
      seek(eventTime(event), { follow: false });
    }),
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
  render();
  paintWaveform();

  return {
    node,
    media,
    update(next = {}) {
      if (destroyed) return;
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
        duration = finiteDuration(config.duration);
        peaks = normalizeAudioPeaks(config.peaks);
        pendingSelection = own(next, 'selection') && next.selection ? { ...next.selection } : null;
        selection = normalizeAudioSelection(pendingSelection, duration);
        selectionFollowsDuration = !own(next, 'selection') || next.selection == null;
        view = fit(duration);
        playbackScope = 'all';
        installSource();
      } else {
        if (own(next, 'duration')) {
          if (finiteDuration(next.duration)) applyKnownDuration(next.duration);
          else clearKnownDuration();
        }
        if (own(next, 'peaks')) peaks = normalizeAudioPeaks(next.peaks);
        if (own(next, 'selection')) {
          pendingSelection = next.selection ? { ...next.selection } : null;
          selection = normalizeAudioSelection(next.selection, duration);
          selectionFollowsDuration = next.selection == null;
        }
      }
      if (own(next, 'loop')) looping = Boolean(next.loop);
      if (own(next, 'disabled')) {
        disabled = Boolean(next.disabled);
        if (disabled) media.pause();
      }
      render();
      if (own(next, 'peaks') || own(next, 'duration') || own(next, 'selection') || sourceWillChange) paintWaveform();
    },
    selection: () => ({ ...selection }),
    view: () => ({ ...view }),
    seek: (seconds) => seek(seconds),
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
