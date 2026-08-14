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
 * @param {{file: File, info: object, onChange?: (selection: {from: number, to: number}) => void}} options
 * @returns {{node: HTMLElement, destroy: () => void, selection: () => {from: number, to: number}}}
 */
export function createScrubber({ file, info, onChange }) {
  const duration = Number.isFinite(info?.duration) ? info.duration : 0;
  const fps = info?.video?.fps || null;
  const least = step('frame', fps);

  let view = fit(duration);
  let selection = selectAll(duration);
  let playhead = 0;
  let looping = false;
  let strip = null; // AbortController for the filmstrip being drawn

  const url = URL.createObjectURL(file);
  const video = el('video', { class: 'scrub-video', src: url, preload: 'auto', playsInline: true });
  video.muted = false;

  const frames = el('div', { class: 'scrub-frames' });
  const shade = el('div', { class: 'scrub-shade' });
  const band = el('div', { class: 'scrub-band' });
  const handleFrom = el('div', { class: 'scrub-handle scrub-handle-from', attrs: { role: 'slider', tabindex: '0', 'aria-label': 'Selection start' } });
  const handleTo = el('div', { class: 'scrub-handle scrub-handle-to', attrs: { role: 'slider', tabindex: '0', 'aria-label': 'Selection end' } });
  const needle = el('div', { class: 'scrub-needle' });
  const track = el('div', { class: 'scrub-track', attrs: { tabindex: '0' } }, [frames, shade, band, handleFrom, handleTo, needle]);

  const fromField = el('input', { class: 'scrub-time', attrs: { 'aria-label': 'Selection start', spellcheck: 'false' } });
  const toField = el('input', { class: 'scrub-time', attrs: { 'aria-label': 'Selection end', spellcheck: 'false' } });
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

    const times = duration / spanOf(view);
    zoomOut.textContent = times < 1.02 ? 'whole file' : `${times < 10 ? times.toFixed(1) : Math.round(times)}× zoom`;
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
    strip = new AbortController();

    const width = track.clientWidth || 640;
    const count = fitCount(width);
    const drawn = await drawStrip(video, { from: view.start, to: view.end, count, signal: strip.signal });
    if (strip.signal.aborted) return;

    frames.textContent = '';
    for (const frame of drawn) {
      frame.canvas.className = 'scrub-frame';
      frames.append(frame.canvas);
    }
    // Seeking to build the strip moved the playhead; put the picture back where
    // the person left it.
    video.currentTime = playhead;
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

  /** Dragging: whichever handle is grabbed, or the playhead on bare track. */
  function startDrag(event, what) {
    event.preventDefault();
    track.focus();

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
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  const off = [
    on(handleFrom, 'pointerdown', (event) => startDrag(event, 'from')),
    on(handleTo, 'pointerdown', (event) => startDrag(event, 'to')),
    on(track, 'pointerdown', (event) => {
      if (event.target === handleFrom || event.target === handleTo) return;
      startDrag(event, 'playhead');
    }),

    on(track, 'wheel', (event) => {
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
    on(fromField, 'change', () => {
      const time = parseTimestamp(fromField.value);
      if (time === null) { paint(); return; }
      selection = setFrom(selection, time, { duration, least });
      setPlayhead(selection.from);
      change();
    }),
    on(toField, 'change', () => {
      const time = parseTimestamp(toField.value);
      if (time === null) { paint(); return; }
      selection = setTo(selection, time, { duration, least });
      setPlayhead(selection.to);
      change();
    }),

    // Looping the selection is the only way to actually check the edges before
    // committing to them, which is what most simple trimmers leave out.
    on(video, 'timeupdate', () => {
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
      note.textContent =
        'This browser cannot decode this file, so there are no thumbnails and no preview. ' +
        'The timeline still works, and so does everything downstream of it.';
      note.hidden = false;
    }),
  ];

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
    destroy() {
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
