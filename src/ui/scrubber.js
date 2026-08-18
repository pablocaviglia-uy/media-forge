/**
 * Choosing a piece of a file by looking at it.
 *
 * Typing timestamps works and is miserable: you cannot see what you picked
 * until after you have converted it. This is the other way round — a strip of
 * frames, two handles, and a preview that shows exactly the instant under
 * whichever one you are moving.
 *
 * The part that makes it usable on a long file is zoom. An hour across a
 * thousand pixels is 3.6 seconds per pixel, so no amount of careful dragging
 * gets you a second, let alone the milliseconds people actually want. Zooming
 * narrows the window until a pixel is worth a frame, and the keyboard covers
 * the last stretch. All of that arithmetic lives in `media/timeline.js`, tested
 * on its own; this file is the part that has to touch the DOM.
 *
 * Nothing here goes near FFmpeg. The frames come from the browser's own
 * decoder, which costs the engine nothing and leaves it free for the queue.
 */

import { el, on, formatTimestamp, parseTimestamp } from './dom.js';
import {
  fit, spanOf, fractionOf, timeAt, zoom, pan,
  step, nudge, setFrom, setTo, selectAll, lengthOf, reveal,
} from '../media/timeline.js';
import { drawStrip, fitCount, canDraw } from './filmstrip.js';

/** Zoom per wheel notch. Gentle enough that a trackpad is not a catapult. */
const WHEEL = 0.88;

/**
 * @param {{file: File, info: object,
 *   initialSelection?: {from: number, to: number}, mediaControls?: boolean,
 *   locale?: 'en' | 'es',
 *   onChange?: (selection: {from: number, to: number}) => void}} options
 * @returns {{node: HTMLElement, destroy: () => void,
 *   selection: () => {from: number, to: number}, setDisabled: (disabled: boolean) => void}}
 */
export function createScrubber({ file, info, initialSelection = null, mediaControls = false, locale = 'en', onChange }) {
  const duration = Number.isFinite(info?.duration) ? info.duration : 0;
  const fps = info?.video?.fps || null;
  const least = step('frame', fps);
  const copy = locale === 'es'
    ? {
        from: 'Inicio de la selección',
        to: 'Final de la selección',
        timeline: 'Timeline del video',
        whole: 'archivo completo',
        zoom: 'de zoom',
        decodeError: 'Este navegador no puede reproducir el archivo, por eso no hay miniaturas ni vista previa. El timeline y el procesamiento siguen disponibles.',
      }
    : {
        from: 'Selection start',
        to: 'Selection end',
        timeline: 'Video timeline',
        whole: 'whole file',
        zoom: 'zoom',
        decodeError: 'This browser cannot decode this file, so there are no thumbnails and no preview. The timeline still works, and so does everything downstream of it.',
      };

  let view = fit(duration);
  let selection = selectAll(duration);
  if (initialSelection) {
    selection = setFrom(selection, initialSelection.from, { duration, least });
    selection = setTo(selection, initialSelection.to, { duration, least });
  }
  let playhead = selection.from;
  let looping = false;
  let disabled = false;
  let stripSeeks = 0;
  let strip = null; // AbortController for the filmstrip being drawn
  let stopDrag = null;

  const url = URL.createObjectURL(file);
  const video = el('video', {
    class: 'scrub-video',
    src: url,
    preload: 'auto',
    playsInline: true,
    controls: mediaControls,
  });
  video.muted = false;

  const frames = el('div', { class: 'scrub-frames' });
  const shade = el('div', { class: 'scrub-shade' });
  const band = el('div', { class: 'scrub-band' });
  const handleFrom = el('div', { class: 'scrub-handle scrub-handle-from', attrs: { role: 'slider', tabindex: '0', 'aria-label': copy.from } });
  const handleTo = el('div', { class: 'scrub-handle scrub-handle-to', attrs: { role: 'slider', tabindex: '0', 'aria-label': copy.to } });
  const needle = el('div', { class: 'scrub-needle' });
  const track = el('div', { class: 'scrub-track', attrs: { tabindex: '0', 'aria-label': copy.timeline } }, [frames, shade, band, handleFrom, handleTo, needle]);

  const fromField = el('input', { class: 'scrub-time', attrs: { 'aria-label': copy.from, spellcheck: 'false' } });
  const toField = el('input', { class: 'scrub-time', attrs: { 'aria-label': copy.to, spellcheck: 'false' } });
  const lengthOut = el('span', { class: 'scrub-length' });
  const zoomOut = el('span', { class: 'scrub-zoom' });
  const note = el('p', { class: 'scrub-note' });

  const node = el('div', { class: 'scrubber' }, [
    video,
    track,
    el('div', { class: 'scrub-bar' }, [
      fromField,
      el('span', { class: 'scrub-sep', text: '→' }),
      toField,
      lengthOut,
      el('span', { class: 'scrub-spacer' }),
      zoomOut,
    ]),
    note,
  ]);

  /* ---------------------------------------------------------------- *
   * Painting
   * ---------------------------------------------------------------- */

  const place = (element, time) => {
    element.style.left = `${fractionOf(view, time) * 100}%`;
  };

  function paint() {
    place(handleFrom, selection.from);
    place(handleTo, selection.to);
    place(needle, playhead);

    const left = fractionOf(view, selection.from);
    const right = fractionOf(view, selection.to);
    band.style.left = `${left * 100}%`;
    band.style.width = `${(right - left) * 100}%`;
    // Two shadows would be two elements; one gradient is one, and it is the
    // same picture.
    shade.style.background =
      `linear-gradient(to right, var(--scrub-shade) 0 ${left * 100}%, transparent ${left * 100}% ${right * 100}%, var(--scrub-shade) ${right * 100}% 100%)`;

    if (document.activeElement !== fromField) fromField.value = formatTimestamp(selection.from);
    if (document.activeElement !== toField) toField.value = formatTimestamp(selection.to);
    lengthOut.textContent = `${lengthOf(selection).toFixed(2)}s`;

    for (const [handle, value] of [[handleFrom, selection.from], [handleTo, selection.to]]) {
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', String(duration));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', formatTimestamp(value));
    }

    const times = duration / spanOf(view);
    zoomOut.textContent = times < 1.02 ? copy.whole : `${times < 10 ? times.toFixed(1) : Math.round(times)}× ${copy.zoom}`;
  }

  /** The strip is redrawn whenever the window changes, but not while it is still changing. */
  let stripTimer = null;
  function scheduleStrip() {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(renderStrip, 180);
  }

  async function renderStrip() {
    if (!canDraw(video)) return;
    strip?.abort();
    const controller = new AbortController();
    strip = controller;

    const width = track.clientWidth || 640;
    const count = fitCount(width);
    stripSeeks += 1;
    try {
      const drawn = await drawStrip(video, {
        from: view.start,
        to: view.end,
        count,
        signal: controller.signal,
      });
      // A newer zoom owns the strip now. Checking the local controller (and
      // its identity) prevents an older async draw from painting over it.
      if (controller.signal.aborted || strip !== controller) return;

      frames.textContent = '';
      for (const frame of drawn) {
        frame.canvas.className = 'scrub-frame';
        frames.append(frame.canvas);
      }
    } finally {
      stripSeeks = Math.max(0, stripSeeks - 1);
      // Thumbnail seeks are implementation detail, not user navigation. The
      // desired playhead may have changed while drawing, so restore its latest
      // value rather than whichever thumbnail happened to be drawn last.
      if (!controller.signal.aborted && strip === controller) video.currentTime = playhead;
    }
  }

  /* ---------------------------------------------------------------- *
   * Moving things
   * ---------------------------------------------------------------- */

  const timeAtEvent = (event) => {
    const box = track.getBoundingClientRect();
    return timeAt(view, Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
  };

  function setPlayhead(time, { follow = true } = {}) {
    playhead = Math.max(0, Math.min(duration, time));
    if (follow) view = reveal(view, playhead, duration);
    if (Math.abs(video.currentTime - playhead) > 0.001) video.currentTime = playhead;
    paint();
  }

  function change() {
    onChange?.({ ...selection });
    paint();
  }

  function commitField(field, which) {
    const time = parseTimestamp(field.value);
    if (time === null) {
      paint();
      return;
    }

    const before = selection[which];
    if (which === 'from') selection = setFrom(selection, time, { duration, least });
    else selection = setTo(selection, time, { duration, least });
    setPlayhead(selection[which]);
    if (Math.abs(selection[which] - before) > 0.0005) change();
    else paint();
  }

  function commitOnEnter(event, field, which) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitField(field, which);
    field.select();
  }

  /** Dragging: whichever handle is grabbed, or the playhead on bare track. */
  function startDrag(event, what) {
    if (disabled) return;
    event.preventDefault();
    track.focus();
    stopDrag?.();

    const move = (moveEvent) => {
      const time = timeAtEvent(moveEvent);
      if (what === 'from') { selection = setFrom(selection, time, { duration, least }); setPlayhead(selection.from, { follow: false }); }
      else if (what === 'to') { selection = setTo(selection, time, { duration, least }); setPlayhead(selection.to, { follow: false }); }
      else setPlayhead(time, { follow: false });
      if (what !== 'playhead') change(); else paint();
    };

    move(event);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      if (stopDrag === stop) stopDrag = null;
    };
    stopDrag = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  const off = [
    on(handleFrom, 'pointerdown', (event) => startDrag(event, 'from')),
    on(handleTo, 'pointerdown', (event) => startDrag(event, 'to')),
    on(handleFrom, 'keydown', (event) => nudgeHandle(event, 'from')),
    on(handleTo, 'keydown', (event) => nudgeHandle(event, 'to')),
    on(track, 'pointerdown', (event) => {
      if (event.target === handleFrom || event.target === handleTo) return;
      startDrag(event, 'playhead');
    }),

    on(track, 'wheel', (event) => {
      if (disabled) return;
      // Only when it is a zoom gesture; a plain vertical wheel should still
      // scroll the page it is sitting on.
      if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const delta = event.ctrlKey || event.metaKey ? event.deltaY : event.deltaX;
      view = zoom(view, delta > 0 ? 1 / WHEEL : WHEEL, timeAtEvent(event), duration);
      paint();
      scheduleStrip();
    }, { passive: false }),

    on(track, 'keydown', (event) => {
      if (disabled) return;
      const size = event.altKey ? step('fine', fps) : event.shiftKey ? step('second', fps) : step('frame', fps);
      const key = event.key;

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        setPlayhead(nudge(playhead, key === 'ArrowRight' ? size : -size, duration));
        return;
      }
      if (key === 'i' || key === 'I') {
        event.preventDefault();
        if (event.shiftKey) setPlayhead(selection.from);
        else { selection = setFrom(selection, playhead, { duration, least }); change(); }
        return;
      }
      if (key === 'o' || key === 'O') {
        event.preventDefault();
        if (event.shiftKey) setPlayhead(selection.to);
        else { selection = setTo(selection, playhead, { duration, least }); change(); }
        return;
      }
      if (key === ' ') {
        event.preventDefault();
        toggleLoop();
        return;
      }
      if (key === '+' || key === '=' || key === '-') {
        event.preventDefault();
        view = zoom(view, key === '-' ? 1 / WHEEL ** 3 : WHEEL ** 3, playhead, duration);
        paint();
        scheduleStrip();
        return;
      }
      if (key === 'Home' || key === 'End') {
        event.preventDefault();
        view = pan(view, key === 'Home' ? -duration : duration, duration);
        paint();
        scheduleStrip();
      }
    }),

    // Typed timestamps, for when the number is already known and dragging to it
    // would be silly.
    on(fromField, 'change', () => commitField(fromField, 'from')),
    on(toField, 'change', () => commitField(toField, 'to')),
    on(fromField, 'blur', () => commitField(fromField, 'from')),
    on(toField, 'blur', () => commitField(toField, 'to')),
    on(fromField, 'keydown', (event) => commitOnEnter(event, fromField, 'from')),
    on(toField, 'keydown', (event) => commitOnEnter(event, toField, 'to')),

    // Looping the selection is the only way to actually check the edges before
    // committing to them, which is what most simple trimmers leave out.
    on(video, 'timeupdate', () => {
      if (stripSeeks > 0) return;
      playhead = video.currentTime;
      if (looping && playhead >= selection.to) {
        video.currentTime = selection.from;
        playhead = selection.from;
      }
      view = reveal(view, playhead, duration);
      paint();
    }),

    // `loadedmetadata` is the wrong event to draw on, and it is the obvious
    // one to reach for. It fires at readyState 1 — the duration and the
    // dimensions are known, and there is no picture yet — so a strip drawn
    // there is blank, and a strip that checks for a picture first is never
    // drawn at all. `loadeddata` is the one that means there is a frame.
    on(video, 'loadedmetadata', paint),
    on(video, 'loadeddata', () => { renderStrip(); paint(); }),
    on(video, 'error', () => {
      note.textContent = copy.decodeError;
      note.hidden = false;
    }),
  ];

  function nudgeHandle(event, which) {
    if (disabled) return;
    const size = event.altKey ? step('fine', fps) : event.shiftKey ? step('second', fps) : step('frame', fps);
    let target = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      target = selection[which] - size;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      target = selection[which] + size;
    } else if (event.key === 'Home') {
      target = which === 'from' ? 0 : selection.from;
    } else if (event.key === 'End') {
      target = which === 'to' ? duration : selection.to;
    }
    if (target === null) return;

    event.preventDefault();
    event.stopPropagation();
    if (which === 'from') selection = setFrom(selection, target, { duration, least });
    else selection = setTo(selection, target, { duration, least });
    setPlayhead(selection[which]);
    change();
  }

  function toggleLoop() {
    looping = !looping;
    if (!looping) { video.pause(); return; }
    if (playhead < selection.from || playhead >= selection.to) setPlayhead(selection.from);
    video.play().catch(() => { looping = false; });
  }

  note.hidden = true;
  paint();

  // A media element loads on its own schedule, and a file that came out of a
  // blob URL can be ready before this function has finished running — in which
  // case `loadedmetadata` fired into an empty room and waiting for it means
  // waiting forever. Asking directly covers the case the event already missed.
  if (canDraw(video)) renderStrip();

  return {
    node,
    selection: () => ({ ...selection }),
    setDisabled(value) {
      disabled = Boolean(value);
      if (disabled) video.pause();
      node.inert = disabled;
      node.dataset.disabled = String(disabled);
      node.setAttribute('aria-disabled', String(disabled));
      track.tabIndex = disabled ? -1 : 0;
      handleFrom.tabIndex = disabled ? -1 : 0;
      handleTo.tabIndex = disabled ? -1 : 0;
      fromField.disabled = disabled;
      toField.disabled = disabled;
    },
    destroy() {
      stopDrag?.();
      for (const remove of off) remove?.();
      clearTimeout(stripTimer);
      strip?.abort();
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}
