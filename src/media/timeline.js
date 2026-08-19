/**
 * The state behind a timeline: what part of the media is on screen, and what
 * part of it is selected.
 *
 * Kept pure and kept here rather than in the component that draws it, because
 * this is where a scrubber is actually wrong. Dragging a handle is easy; what
 * is not easy is that zooming under the pointer has to leave the instant under
 * the pointer exactly where it was, that panning must not walk off the end of
 * the media, that a selection cannot invert when you drag the start past the
 * finish, and that the whole thing has to stay honest at both extremes — a
 * ninety-minute recording and a two-second one, on the same control.
 *
 * The reason any of this matters is arithmetic. A one-hour file across a
 * thousand pixels is 3.6 seconds per pixel: at that scale nobody can pick a
 * second by dragging, let alone the milliseconds people actually want. Keyboard
 * nudging alone does not fix it, because you still cannot see what you picked.
 * Zoom is what makes the precision reachable, and it is the part that has to be
 * right.
 *
 * Times are seconds throughout, as floats. Pixels never appear.
 */

/**
 * The narrowest the visible window may get.
 *
 * At a typical thousand-pixel width this is a fifth of a millisecond per pixel,
 * finer than a frame of any frame rate anyone uses, so the limit is never what
 * stops someone being precise. It exists so that zoom cannot collapse to zero
 * and take every division with it.
 */
export const MIN_SPAN = 0.2;

/** @typedef {{start: number, end: number}} View a visible window, in seconds */
/** @typedef {{from: number, to: number}} Selection */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The whole media, which is where a timeline starts. */
export const fit = (duration) => ({ start: 0, end: Math.max(MIN_SPAN, duration || 0) });

export const spanOf = (view) => view.end - view.start;

/**
 * Where a time sits across the window, as 0 to 1.
 *
 * Deliberately not clamped: a component needs to know that the selection's end
 * is off to the right at 1.4 so it can draw the edge of it, and clamping here
 * would report it as sitting exactly on the boundary instead.
 */
export const fractionOf = (view, time) => (time - view.start) / spanOf(view);

/** The inverse: what instant is this far across the window. */
export const timeAt = (view, fraction) => view.start + fraction * spanOf(view);

/**
 * Zoom, keeping one instant nailed to the spot it is already on.
 *
 * This is the whole feel of a scrubber. Zooming towards the middle of the
 * window, or towards zero, means the frame someone is looking at slides out
 * from under them and they have to chase it — so the instant under the pointer
 * (or under the playhead, for a keyboard zoom) is the fixed point, and the
 * window grows or shrinks around it.
 *
 * @param {View} view
 * @param {number} factor  below 1 zooms in, above 1 zooms out
 * @param {number} at      the instant to hold still
 * @param {number} duration
 */
export function zoom(view, factor, at, duration) {
  const total = Math.max(MIN_SPAN, duration || 0);
  const wanted = clamp(spanOf(view) * factor, MIN_SPAN, total);

  // Where the fixed point sits in the window now; it must sit there afterwards
  // too, which is what decides the new start.
  const where = clamp(fractionOf(view, at), 0, 1);
  return place(at - where * wanted, wanted, 0, total);
}

/** Move the window along without changing how much of the media it shows. */
export function pan(view, seconds, duration) {
  return place(view.start + seconds, spanOf(view), 0, Math.max(MIN_SPAN, duration || 0));
}

/**
 * Put a window of a given width inside the media.
 *
 * The width is carried in rather than read back off the window, because
 * recovering it as `end - start` loses the low bits: forty halvings around the
 * fortieth minute of an hour drift the narrowest window from 0.2 to
 * 0.20000000000004547. Harmless on its own, and it accumulates.
 *
 * Sliding rather than clamping each edge separately is the other half.
 * Clamping `start` to zero while leaving `end` alone silently widens the
 * window, and a zoom that shows you more because you happened to be near the
 * beginning is a scrubber that fights you.
 */
function place(start, span, low, high) {
  const width = Math.min(span, high - low);
  let at = start;
  if (at < low) at = low;
  if (at + width > high) at = high - width;
  return { start: at, end: at + width };
}

/**
 * How far one press of an arrow key should move.
 *
 * A frame is the useful unit for video and the only one that lands on
 * something you can actually see; `fine` exists for audio, where frames are
 * meaningless and people genuinely do want ten milliseconds.
 *
 * @param {'frame'|'second'|'fine'} kind
 * @param {number|null} fps
 */
export function step(kind, fps) {
  if (kind === 'second') return 1;
  if (kind === 'fine') return 0.01;
  // Without a frame rate — audio, or a probe that did not say — a frame is not
  // a thing, and pretending it is would move by a made-up amount.
  return fps && Number.isFinite(fps) && fps > 0 ? 1 / fps : 0.04;
}

/** Move an instant, staying inside the media. */
export const nudge = (time, by, duration) => clamp(time + by, 0, Math.max(0, duration || 0));

/**
 * Move the start of the selection.
 *
 * The two edges cannot cross, and the alternative to refusing that is letting
 * them swap roles halfway through a drag, which is disorienting in a way that
 * is hard to describe and instantly obvious to use. `least` is how much has to
 * survive between them — one frame, normally.
 */
export function setFrom(selection, time, { duration, least = MIN_SPAN }) {
  const from = clamp(time, 0, Math.max(0, (selection.to ?? duration) - least));
  return { from, to: selection.to };
}

export function setTo(selection, time, { duration, least = MIN_SPAN }) {
  const to = clamp(time, (selection.from ?? 0) + least, Math.max(0, duration));
  return { from: selection.from, to };
}

/** The selection a file starts with: all of it. */
export const selectAll = (duration) => ({ from: 0, to: Math.max(0, duration || 0) });

export const lengthOf = (selection) => Math.max(0, selection.to - selection.from);

/**
 * Bring an instant into view, moving as little as possible.
 *
 * Used when the playhead is nudged past the edge of a zoomed-in window: the
 * window should follow, but it should not recentre, because recentring throws
 * away the context someone was looking at for no reason they asked for.
 */
export function reveal(view, time, duration) {
  if (time >= view.start && time <= view.end) return view;
  const span = spanOf(view);
  const edge = time < view.start ? time : time - span;
  return place(edge, span, 0, Math.max(MIN_SPAN, duration || 0));
}

/**
 * Keep a playing instant in the middle of a zoomed window when there is room.
 *
 * Playback follow is intentionally different from `reveal`: an explicit seek
 * should preserve as much of the user's chosen context as possible, while a
 * moving playhead is easier to read when the waveform travels beneath a fixed
 * centre marker. At the media boundaries the window is clamped, so the marker
 * naturally travels from the left edge to the centre at the beginning and
 * from the centre to the right edge at the end without exposing empty space.
 */
export function followPlayback(view, time, duration) {
  const total = Math.max(MIN_SPAN, duration || 0);
  const width = spanOf(view);
  const next = place(time - width / 2, width, 0, total);
  return next.start === view.start && next.end === view.end ? view : next;
}
