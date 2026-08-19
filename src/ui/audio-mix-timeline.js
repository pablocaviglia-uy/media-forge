/**
 * Compact two-track timeline for the focused "Agregar audio al video" workspace.
 *
 * The application owns files, probing, media playback and export state. This
 * component only describes the two sources and turns pointer/keyboard gestures
 * into seek and signed-offset callbacks. It deliberately creates no object URLs
 * and no media elements, so App can keep one honest preview controller alive
 * while this view is repainted.
 */

import { el, formatBytes, formatDuration, on, truncateName } from './dom.js';

let nextAudioMixTimelineId = 1;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteDuration = (value) => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
};

const sourceDuration = (source, role = source?.role) => {
  const direct = finiteDuration(source?.duration);
  if (direct) return direct;
  if (role === 'video' || role === 'audio') {
    const stream = finiteDuration(source?.info?.[role]?.duration);
    if (stream) return stream;
    const otherRole = role === 'video' ? 'audio' : 'video';
    if (source?.info?.[otherRole]) return 0;
  }
  return finiteDuration(source?.info?.duration);
};
const sourceName = (source, fallback) => String(source?.name || source?.file?.name || fallback);

/** Signed, millisecond-precise copy for the offset control and live region. */
export function formatAudioMixOffset(value) {
  const seconds = Number(value);
  const safe = Number.isFinite(seconds) ? seconds : 0;
  const sign = safe < 0 ? '−' : safe > 0 ? '+' : '';
  const milliseconds = Math.round(Math.abs(safe) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const fraction = milliseconds % 1000;
  const pad = (number) => String(number).padStart(2, '0');
  const secondsCopy = fraction
    ? `${pad(wholeSeconds)}.${String(fraction).padStart(3, '0')}`
    : pad(wholeSeconds);
  return `${sign}${hours ? `${hours}:${pad(minutes)}` : minutes}:${secondsCopy}`;
}

/**
 * Keep a draggable track at least partly inside the video. The command-level
 * validator remains authoritative; this is only the useful interaction range.
 */
export function audioMixOffsetBounds(videoDuration, audioDuration, minimumOverlap = 0.01) {
  const video = finiteDuration(videoDuration);
  const audio = finiteDuration(audioDuration);
  if (!video || !audio) return Object.freeze({ min: 0, max: Math.max(0, video) });
  const overlap = Math.min(finiteDuration(minimumOverlap) || 0.01, video, audio);
  return Object.freeze({
    min: -audio + overlap,
    max: video - overlap,
  });
}

export function clampAudioMixOffset(value, videoDuration, audioDuration) {
  const bounds = audioMixOffsetBounds(videoDuration, audioDuration);
  const number = Number(value);
  return clamp(Number.isFinite(number) ? number : 0, bounds.min, bounds.max);
}

/** Pure geometry shared by the DOM renderer and its tests. */
export function audioMixTimelineMetrics({
  videoDuration,
  audioDuration,
  offset = 0,
  fit = 'once',
  currentTime = 0,
} = {}) {
  const video = finiteDuration(videoDuration);
  const audio = finiteDuration(audioDuration);
  const start = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const loops = fit === 'loop';
  const naturalEnd = start + audio;
  const visibleStart = video ? clamp(start, 0, video) : 0;
  const requestedEnd = loops && audio ? video : naturalEnd;
  const visibleEnd = video ? clamp(requestedEnd, 0, video) : 0;
  const visibleDuration = Math.max(0, visibleEnd - visibleStart);
  const playhead = video ? clamp(Number(currentTime) || 0, 0, video) : 0;
  const loopCount = loops && audio && video > start
    ? Math.max(1, Math.ceil((video - start) / audio))
    : 1;
  let outOfFrame = null;
  if (!loops && audio && naturalEnd <= 0) outOfFrame = 'before';
  else if (video && start >= video) outOfFrame = 'after';

  return Object.freeze({
    videoDuration: video,
    audioDuration: audio,
    offset: start,
    fit: loops ? 'loop' : 'once',
    naturalEnd,
    visibleStart,
    visibleEnd,
    visibleDuration,
    leftPercent: video ? (visibleStart / video) * 100 : 0,
    widthPercent: video ? (visibleDuration / video) * 100 : 0,
    playheadPercent: video ? (playhead / video) * 100 : 0,
    clippedStart: start < 0,
    clippedEnd: Boolean(video && (loops || naturalEnd > video)),
    loopCount,
    outOfFrame,
  });
}

/** Offset produced by one keyboard gesture, or null for an unrelated key. */
export function audioMixOffsetForKey(value, key, {
  videoDuration,
  audioDuration,
  shiftKey = false,
} = {}) {
  const bounds = audioMixOffsetBounds(videoDuration, audioDuration);
  const current = clampAudioMixOffset(value, videoDuration, audioDuration);
  const step = shiftKey ? 1 : 0.1;
  let next = null;
  if (key === 'ArrowLeft' || key === 'ArrowDown') next = current - step;
  else if (key === 'ArrowRight' || key === 'ArrowUp') next = current + step;
  else if (key === 'PageDown') next = current - 5;
  else if (key === 'PageUp') next = current + 5;
  else if (key === 'Home') next = bounds.min;
  else if (key === 'End') next = bounds.max;
  if (next === null) return null;
  return Math.round(clamp(next, bounds.min, bounds.max) * 1000) / 1000;
}

function sourceFacts(source, role) {
  if (!source) return role === 'video' ? 'Todavía falta el video.' : 'Elegí música, voz o efectos.';
  if (source.error) return source.error;
  if (source.status === 'probing' || source.status === 'pending') return 'Analizando…';
  const facts = [];
  const duration = sourceDuration(source, role);
  if (duration) facts.push(formatDuration(duration));
  const size = Number(source.size ?? source.file?.size);
  if (Number.isFinite(size) && size > 0) facts.push(formatBytes(size));
  if (role === 'video' && source.info?.video?.width && source.info?.video?.height) {
    facts.push(`${source.info.video.width}×${source.info.video.height}`);
  }
  return facts.join(' · ') || 'Esperando información';
}

function sourceCard({ source, role, disabled }) {
  const isVideo = role === 'video';
  const title = sourceName(source, isVideo ? 'Video principal' : 'Pista de audio');
  const action = !source
    ? (isVideo ? 'replace-video' : 'pick-audio')
    : (isVideo ? 'replace-video' : 'replace-audio');
  const actionLabel = source ? 'Reemplazar' : (isVideo ? 'Elegir video' : 'Elegir audio');
  const actions = [
    el('button', {
      type: 'button',
      class: `${source ? 'text-button' : 'primary-button'} audio-mix-source-action`,
      text: actionLabel,
      disabled,
      dataset: { audioMixAction: action, audioMixRole: role },
    }),
  ];
  if (source && !isVideo) {
    actions.push(el('button', {
      type: 'button',
      class: 'text-button audio-mix-source-action audio-mix-source-remove',
      text: 'Quitar',
      disabled,
      dataset: { audioMixAction: 'remove-audio', audioMixRole: role },
      attrs: { 'aria-label': `Quitar ${title}` },
    }));
  }

  return el('article', {
    class: `audio-mix-source-card${source?.error ? ' has-error' : ''}${source ? '' : ' is-empty'}`,
    dataset: { audioMixRole: role, status: source?.error ? 'failed' : (source?.status || (source ? 'ready' : 'empty')) },
  }, [
    el('span', {
      class: 'audio-mix-source-icon',
      text: isVideo ? '▶' : '♫',
      attrs: { 'aria-hidden': 'true' },
    }),
    el('div', { class: 'audio-mix-source-copy' }, [
      el('span', { text: isVideo ? 'Video' : 'Audio' }),
      el('strong', { text: truncateName(title, 38), title }),
      el('small', { text: sourceFacts(source, role) }),
    ]),
    el('div', { class: 'audio-mix-source-actions' }, actions),
  ]);
}

/**
 * @param {{
 *   video?: object|null,
 *   audio?: object|null,
 *   offset?: number,
 *   fit?: 'once'|'loop',
 *   currentTime?: number,
 *   disabled?: boolean,
 *   onSeek?: (seconds: number) => void,
 *   onOffsetInput?: (seconds: number) => void,
 *   onOffsetCommit?: (seconds: number) => void,
 *   onPickAudio?: () => void,
 *   onReplaceVideo?: () => void,
 *   onReplaceAudio?: () => void,
 *   onRemoveAudio?: () => void,
 * }} options
 * @returns {{
 *   node: HTMLElement,
 *   setOffset: (seconds: number) => void,
 *   setCurrentTime: (seconds: number) => void,
 *   setDisabled: (disabled: boolean) => void,
 *   focusOffset: () => void,
 *   destroy: () => void,
 * }}
 */
export function createAudioMixTimeline({
  video = null,
  audio = null,
  offset = 0,
  fit = 'once',
  currentTime = 0,
  disabled = false,
  onSeek,
  onOffsetInput,
  onOffsetCommit,
  onPickAudio,
  onReplaceVideo,
  onReplaceAudio,
  onRemoveAudio,
} = {}) {
  const instanceId = `audio-mix-timeline-${nextAudioMixTimelineId++}`;
  const headingId = `${instanceId}-title`;
  const helpId = `${instanceId}-help`;
  const videoDuration = sourceDuration(video, 'video');
  const audioDuration = sourceDuration(audio, 'audio');
  let activeOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  let activeTime = Number.isFinite(Number(currentTime)) ? Number(currentTime) : 0;
  let locked = Boolean(disabled);
  let destroyed = false;
  let pointerDrag = null;
  let stopPointer = null;
  const removeListeners = [];

  const heading = el('strong', { id: headingId, text: 'Pistas del proyecto' });
  const summary = el('span', { class: 'audio-mix-timeline-summary' });
  const live = el('p', {
    class: 'sr-only audio-mix-live',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const help = el('p', {
    id: helpId,
    class: 'sr-only',
    text: 'Para mover el audio, enfocá su bloque y usá las flechas. Shift mueve un segundo, Inicio y Fin van a los límites. También podés arrastrarlo.',
  });
  const sourceGrid = el('div', { class: 'audio-mix-source-grid' }, [
    sourceCard({ source: video, role: 'video', disabled: locked }),
    sourceCard({ source: audio, role: 'audio', disabled: locked }),
  ]);

  const videoPlayhead = el('span', { class: 'audio-mix-playhead', attrs: { 'aria-hidden': 'true' } });
  const audioPlayhead = el('span', { class: 'audio-mix-playhead', attrs: { 'aria-hidden': 'true' } });
  const videoLane = el('div', {
    class: 'audio-mix-track-lane audio-mix-track-lane-video',
    dataset: { audioMixRole: 'video' },
  }, [
    el('span', { class: 'audio-mix-track-grid', attrs: { 'aria-hidden': 'true' } }),
    el('span', {
      class: 'audio-mix-clip audio-mix-video-clip',
      attrs: { 'aria-hidden': 'true' },
    }, [el('strong', { text: truncateName(sourceName(video, 'Video'), 34) })]),
    videoPlayhead,
  ]);

  const audioLane = el('div', {
    class: 'audio-mix-track-lane audio-mix-track-lane-audio',
    dataset: { audioMixRole: 'audio' },
  });
  const audioClip = audio ? el('button', {
    type: 'button',
    class: 'audio-mix-clip audio-mix-audio-clip',
    disabled: locked,
    dataset: { audioMixAction: 'offset', audioMixRole: 'audio' },
    attrs: {
      role: 'slider',
      'aria-label': 'Inicio de la pista de audio',
      'aria-describedby': helpId,
      'aria-orientation': 'horizontal',
      'aria-keyshortcuts': 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End',
    },
  }, [
    el('span', { class: 'audio-mix-clip-grip', text: '⋮⋮', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'audio-mix-clip-copy' }, [
      el('strong', { text: truncateName(sourceName(audio, 'Audio'), 30) }),
      el('small', { dataset: { audioMixOffsetCopy: '' } }),
    ]),
    fit === 'loop'
      ? el('span', { class: 'audio-mix-loop-badge', text: '↻', title: 'Repetir hasta el final', attrs: { 'aria-hidden': 'true' } })
      : null,
  ]) : el('button', {
    type: 'button',
    class: 'audio-mix-track-empty',
    text: '+ Elegir audio',
    disabled: locked,
    dataset: { audioMixAction: 'pick-audio', audioMixRole: 'audio' },
  });
  audioLane.append(
    el('span', { class: 'audio-mix-track-grid', attrs: { 'aria-hidden': 'true' } }),
    audioClip,
    audioPlayhead,
  );

  const tracks = el('div', {
    class: 'audio-mix-tracks',
    dataset: { audioMixFit: fit === 'loop' ? 'loop' : 'once' },
    attrs: { 'aria-label': 'Línea de tiempo del video y el audio' },
  }, [
    el('div', { class: 'audio-mix-track-row' }, [
      el('span', { class: 'audio-mix-track-label', text: 'Video' }),
      videoLane,
    ]),
    el('div', { class: 'audio-mix-track-row' }, [
      el('span', { class: 'audio-mix-track-label', text: 'Audio' }),
      audioLane,
    ]),
  ]);
  const ruler = el('div', { class: 'audio-mix-ruler', attrs: { 'aria-hidden': 'true' } }, [
    el('span', { text: '0:00' }),
    el('span', { text: videoDuration ? formatDuration(videoDuration / 2) : '—' }),
    el('span', { text: videoDuration ? formatDuration(videoDuration) : '—' }),
  ]);
  const timelineBody = el('div', { class: 'audio-mix-timeline-body' }, [tracks, ruler]);
  const node = el('section', {
    class: 'audio-mix-timeline',
    dataset: { disabled: String(locked), fit: fit === 'loop' ? 'loop' : 'once' },
    attrs: {
      'aria-labelledby': headingId,
      'aria-disabled': String(locked),
    },
  }, [
    el('header', { class: 'audio-mix-timeline-head' }, [
      el('div', { class: 'audio-mix-timeline-copy' }, [heading, summary]),
      el('span', {
        class: 'audio-mix-fit-badge',
        text: fit === 'loop' ? 'Repetir hasta el final' : 'Una vez',
      }),
    ]),
    sourceGrid,
    timelineBody,
    help,
    live,
  ]);

  function announce(message) {
    live.textContent = '';
    queueMicrotask(() => {
      if (!destroyed) live.textContent = message;
    });
  }

  function renderGeometry() {
    const metrics = audioMixTimelineMetrics({
      videoDuration,
      audioDuration,
      offset: activeOffset,
      fit,
      currentTime: activeTime,
    });
    videoPlayhead.style.setProperty('--audio-mix-playhead', `${metrics.playheadPercent}%`);
    audioPlayhead.style.setProperty('--audio-mix-playhead', `${metrics.playheadPercent}%`);
    summary.textContent = audio
      ? `${formatDuration(videoDuration)} · audio ${formatAudioMixOffset(activeOffset)} · ${fit === 'loop' ? `${metrics.loopCount}×` : 'una vez'}`
      : `${formatDuration(videoDuration)} · falta audio`;

    if (!audio || !audioClip.matches('[role="slider"]')) return;
    const bounds = audioMixOffsetBounds(videoDuration, audioDuration);
    const visibleWidth = metrics.outOfFrame ? 0 : Math.max(metrics.widthPercent, 0);
    audioClip.style.setProperty('--audio-mix-left', `${metrics.leftPercent}%`);
    audioClip.style.setProperty('--audio-mix-width', `${visibleWidth}%`);
    audioClip.dataset.clippedStart = String(metrics.clippedStart);
    audioClip.dataset.clippedEnd = String(metrics.clippedEnd);
    audioClip.dataset.outOfFrame = metrics.outOfFrame || 'false';
    audioClip.setAttribute('aria-valuemin', String(bounds.min));
    audioClip.setAttribute('aria-valuemax', String(bounds.max));
    audioClip.setAttribute('aria-valuenow', String(activeOffset));
    audioClip.setAttribute('aria-valuetext', `Audio desde ${formatAudioMixOffset(activeOffset)}`);
    const copy = audioClip.querySelector('[data-audio-mix-offset-copy]');
    if (copy) {
      const crop = activeOffset < 0
        ? ` · ${formatAudioMixOffset(Math.abs(activeOffset)).replace(/^\+/, '')} recortado`
        : '';
      copy.textContent = `${formatAudioMixOffset(activeOffset)}${crop}`;
    }
  }

  function setOffset(next) {
    const number = Number(next);
    activeOffset = Number.isFinite(number) ? number : 0;
    renderGeometry();
  }

  function stopPointerMove({ cancel = false, silent = false } = {}) {
    if (!pointerDrag) return;
    const { initialOffset, moved } = pointerDrag;
    pointerDrag = null;
    stopPointer?.();
    stopPointer = null;
    if (cancel) {
      setOffset(initialOffset);
      if (!silent) {
        onOffsetInput?.(activeOffset);
        announce(`Movimiento cancelado. Audio desde ${formatAudioMixOffset(activeOffset)}.`);
      }
      return;
    }
    if (!moved) return;
    onOffsetCommit?.(activeOffset);
    announce(`Audio desde ${formatAudioMixOffset(activeOffset)}.`);
  }

  function beginPointerMove(event) {
    if (locked || !audio || event.button !== 0 || pointerDrag) return;
    const trackBox = audioLane.getBoundingClientRect();
    if (!trackBox.width || !videoDuration) return;
    const startX = event.clientX;
    const initialOffset = activeOffset;
    pointerDrag = { startX, initialOffset, moved: false };
    node.dataset.dragging = 'true';
    event.preventDefault();

    const move = (moveEvent) => {
      if (!pointerDrag) return;
      if (!pointerDrag.moved && Math.abs(moveEvent.clientX - startX) < 3) return;
      pointerDrag.moved = true;
      const seconds = ((moveEvent.clientX - startX) / trackBox.width) * videoDuration;
      const next = clampAudioMixOffset(initialOffset + seconds, videoDuration, audioDuration);
      setOffset(Math.round(next * 1000) / 1000);
      onOffsetInput?.(activeOffset);
    };
    const up = () => stopPointerMove();
    const cancel = () => stopPointerMove({ cancel: true });
    const keydown = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
    window.addEventListener('keydown', keydown);
    stopPointer = () => {
      delete node.dataset.dragging;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', keydown);
    };
  }

  removeListeners.push(on(node, 'click', (event) => {
    const actionNode = event.target.closest('[data-audio-mix-action]');
    if (actionNode) {
      if (actionNode.disabled) return;
      const action = actionNode.dataset.audioMixAction;
      if (action === 'pick-audio') onPickAudio?.();
      else if (action === 'replace-video') onReplaceVideo?.();
      else if (action === 'replace-audio') onReplaceAudio?.();
      else if (action === 'remove-audio') onRemoveAudio?.();
      return;
    }
    const lane = event.target.closest('.audio-mix-track-lane');
    if (!lane || !videoDuration) return;
    const box = lane.getBoundingClientRect();
    if (!box.width) return;
    onSeek?.(clamp(((event.clientX - box.left) / box.width) * videoDuration, 0, videoDuration));
  }));

  removeListeners.push(on(audioClip, 'pointerdown', (event) => {
    if (audioClip.matches('[role="slider"]')) beginPointerMove(event);
  }));

  removeListeners.push(on(audioClip, 'keydown', (event) => {
    if (locked || !audio || !audioClip.matches('[role="slider"]')) return;
    const next = audioMixOffsetForKey(activeOffset, event.key, {
      videoDuration,
      audioDuration,
      shiftKey: event.shiftKey,
    });
    if (next === null) return;
    event.preventDefault();
    setOffset(next);
    onOffsetInput?.(activeOffset);
    onOffsetCommit?.(activeOffset);
    announce(`Audio desde ${formatAudioMixOffset(activeOffset)}.`);
  }));

  renderGeometry();

  return {
    node,
    setOffset,
    setCurrentTime(seconds) {
      const number = Number(seconds);
      activeTime = Number.isFinite(number) ? number : 0;
      renderGeometry();
    },
    setDisabled(next) {
      locked = Boolean(next);
      node.dataset.disabled = String(locked);
      node.setAttribute('aria-disabled', String(locked));
      for (const control of node.querySelectorAll('button')) control.disabled = locked;
    },
    focusOffset() {
      if (audioClip.matches('[role="slider"]')) audioClip.focus({ preventScroll: true });
    },
    destroy() {
      destroyed = true;
      stopPointerMove({ cancel: true, silent: true });
      for (const remove of removeListeners) remove();
      node.replaceChildren();
    },
  };
}
