/**
 * The timeline model, on its own terms.
 *
 * A scrubber is judged entirely on feel, and feel is arithmetic. The instant
 * under the pointer must not move while zooming towards it. The window must not
 * change width because it happened to be near the beginning. The two ends of a
 * selection must not swap places when one is dragged past the other. Every one
 * of those is a number, and every one of them is easier to get wrong than to
 * notice — so they are checked here, without a DOM and without a file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SPAN, fit, spanOf, fractionOf, timeAt, zoom, pan,
  step, nudge, setFrom, setTo, selectAll, lengthOf, reveal,
} from '../src/media/timeline.js';

/** An hour, which is where the arithmetic gets uncomfortable. */
const HOUR = 3600;

const close = (actual, expected, within, message) =>
  assert.ok(Math.abs(actual - expected) < within, `${message}: expected about ${expected}, got ${actual}`);

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

test('a timeline starts showing the whole file', () => {
  assert.deepEqual(fit(HOUR), { start: 0, end: HOUR });
  assert.equal(spanOf(fit(HOUR)), HOUR);

  // A file shorter than the smallest window still gets a usable one rather
  // than a window of zero width that every division would fall through.
  assert.equal(spanOf(fit(0.05)), MIN_SPAN);
  for (const nothing of [0, null, undefined, NaN]) {
    assert.equal(spanOf(fit(nothing)), MIN_SPAN, String(nothing));
  }
});

test('a time maps across the window and back again', () => {
  const view = { start: 100, end: 200 };

  assert.equal(fractionOf(view, 100), 0);
  assert.equal(fractionOf(view, 150), 0.5);
  assert.equal(fractionOf(view, 200), 1);
  assert.equal(timeAt(view, 0.25), 125);

  // Outside the window is reported as outside, not clamped to the edge: a
  // component has to know the selection ends off to the right to draw it.
  assert.equal(fractionOf(view, 250), 1.5);
  assert.equal(fractionOf(view, 50), -0.5);
});

/* ------------------------------------------------------------------ *
 * Zoom, which is what makes the precision reachable at all
 * ------------------------------------------------------------------ */

test('zooming holds the instant it was aimed at exactly still', () => {
  // The whole feel of a scrubber. If the frame under the pointer slides away
  // while zooming towards it, every adjustment becomes a chase.
  let view = fit(HOUR);
  const target = 2400; // 40 minutes in

  for (let i = 0; i < 12; i += 1) {
    const before = fractionOf(view, target);
    view = zoom(view, 0.5, target, HOUR);
    close(fractionOf(view, target), before, 1e-9, `the target moved on zoom ${i}`);
  }

  // And twelve halvings really did get somewhere useful.
  assert.ok(spanOf(view) < 2, `after twelve zooms the window is still ${spanOf(view)}s wide`);
});

test('zoom reaches milliseconds and refuses to collapse past them', () => {
  let view = fit(HOUR);
  for (let i = 0; i < 40; i += 1) view = zoom(view, 0.5, 1800, HOUR);

  // Not an exact comparison, and it cannot be: a window is stored as two
  // instants, so recovering its width half an hour into a file goes through a
  // subtraction that loses the low bits. The error is bounded rather than
  // accumulating — the clamp puts the width back on the floor every time — and
  // it lands around a hundredth of a femtosecond, which is nobody's problem.
  close(spanOf(view), MIN_SPAN, 1e-9, 'the narrowest window');
  assert.ok(spanOf(view) >= MIN_SPAN, 'the window collapsed past the floor');

  // A fifth of a second across a thousand pixels is a fifth of a millisecond
  // each, so the limit is never what stops someone being exact.
  assert.ok(MIN_SPAN / 1000 < 0.001);
});

test('zooming out stops at the whole file rather than past its ends', () => {
  let view = zoom(fit(HOUR), 0.01, 1800, HOUR);
  for (let i = 0; i < 40; i += 1) view = zoom(view, 2, 1800, HOUR);

  assert.deepEqual(view, { start: 0, end: HOUR });
});

test('zooming at the very beginning does not widen the window to compensate', () => {
  // Clamping the two edges separately is the obvious implementation and it is
  // wrong: `start` stops at zero, `end` carries on, and the window silently
  // grows. Being near the start of a file must not change how much you see.
  const view = zoom({ start: 0, end: 100 }, 0.5, 0, HOUR);

  close(spanOf(view), 50, 1e-9, 'the window changed width');
  assert.equal(view.start, 0);
});

test('zooming at the very end does not walk off it', () => {
  const view = zoom({ start: HOUR - 100, end: HOUR }, 0.5, HOUR, HOUR);

  close(spanOf(view), 50, 1e-9, 'the window changed width');
  assert.equal(view.end, HOUR);
  assert.ok(view.start >= 0);
});

/* ------------------------------------------------------------------ *
 * Panning
 * ------------------------------------------------------------------ */

test('panning moves the window without resizing it, and stops at both ends', () => {
  const view = { start: 100, end: 200 };

  assert.deepEqual(pan(view, 50, HOUR), { start: 150, end: 250 });
  // Into the beginning: it stops, and stays a hundred seconds wide.
  assert.deepEqual(pan(view, -500, HOUR), { start: 0, end: 100 });
  // And into the end.
  assert.deepEqual(pan(view, HOUR, HOUR), { start: HOUR - 100, end: HOUR });
});

test('a window wider than the file is pulled back to the file', () => {
  assert.deepEqual(pan({ start: -50, end: 250 }, 0, 100), { start: 0, end: 100 });
});

/* ------------------------------------------------------------------ *
 * Stepping
 * ------------------------------------------------------------------ */

test('one press of an arrow key moves by something that means something', () => {
  close(step('frame', 25), 0.04, 1e-9, 'a frame at 25 fps');
  close(step('frame', 30), 1 / 30, 1e-9, 'a frame at 30 fps');
  assert.equal(step('second', 25), 1);
  assert.equal(step('fine', 25), 0.01);

  // Audio has no frames, and a probe that did not say leaves the same gap.
  // Inventing a frame rate would move by an amount nothing corresponds to.
  for (const missing of [null, undefined, 0, NaN, -1]) {
    assert.equal(step('frame', missing), 0.04, String(missing));
  }
});

test('nudging stays inside the file', () => {
  assert.equal(nudge(10, 1, 60), 11);
  assert.equal(nudge(0, -1, 60), 0);
  assert.equal(nudge(60, 1, 60), 60);
  assert.equal(nudge(30, 0.01, 60), 30.01);
});

/* ------------------------------------------------------------------ *
 * The selection
 * ------------------------------------------------------------------ */

test('a file starts with all of it selected', () => {
  assert.deepEqual(selectAll(120), { from: 0, to: 120 });
  assert.equal(lengthOf(selectAll(120)), 120);
});

test('the two ends of a selection cannot cross', () => {
  const selection = { from: 10, to: 20 };

  // Dragged past the far end, the near one stops short of it. Letting them
  // swap roles mid-drag is disorienting in a way that is obvious to use and
  // hard to describe afterwards.
  const pushed = setFrom(selection, 50, { duration: 60, least: 1 });
  assert.equal(pushed.from, 19);
  assert.equal(pushed.to, 20);

  const pulled = setTo(selection, 2, { duration: 60, least: 1 });
  assert.equal(pulled.from, 10);
  assert.equal(pulled.to, 11);
});

test('a selection stays inside the file', () => {
  assert.equal(setFrom({ from: 10, to: 20 }, -5, { duration: 60 }).from, 0);
  assert.equal(setTo({ from: 10, to: 20 }, 999, { duration: 60 }).to, 60);
});

test('the gap the two ends must leave is the caller’s to choose', () => {
  // One frame at 25 fps, which is the smallest selection worth having on video.
  const frame = step('frame', 25);
  const tight = setFrom({ from: 0, to: 10 }, 10, { duration: 60, least: frame });

  close(tight.from, 10 - frame, 1e-9, 'a one-frame selection should survive');
  close(lengthOf(tight), frame, 1e-9, 'and be exactly one frame long');
});

/* ------------------------------------------------------------------ *
 * Following the playhead
 * ------------------------------------------------------------------ */

test('a time already on screen moves nothing', () => {
  const view = { start: 100, end: 200 };
  assert.equal(reveal(view, 150, HOUR), view);
});

test('a time off the edge brings the window to it, and no further', () => {
  const view = { start: 100, end: 200 };

  // Stepping off the right edge scrolls by as little as possible rather than
  // recentring, because recentring throws away the context nobody asked to
  // lose. The instant lands on the edge it went off.
  const right = reveal(view, 220, HOUR);
  close(right.end, 220, 1e-9, 'should have followed to exactly the edge');
  close(spanOf(right), 100, 1e-9, 'and not resized');

  const left = reveal(view, 60, HOUR);
  close(left.start, 60, 1e-9, 'should have followed backwards to the edge');
  close(spanOf(left), 100, 1e-9, 'and not resized');
});
