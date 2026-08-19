import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  audioSelectionBoundary,
  audioViewForSelection,
  bucketAudioPeaks,
  createAudioLabPlayer,
  normalizeAudioPeaks,
  normalizeAudioSelection,
} from '../src/ui/audio-lab-player.js';
import { spanOf } from '../src/media/timeline.js';

const close = (actual, expected, tolerance = 1e-8) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
};

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {
      setProperty: (name, value) => { this.style[name] = value; },
    };
    this.clientWidth = this.tagName === 'CANVAS' ? 640 : 0;
    this.clientHeight = this.tagName === 'CANVAS' ? 128 : 0;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.paused = true;
    this.ended = false;
    this.loadCount = 0;
    this.pauseCount = 0;
    this.playCount = 0;
  }

  append(...children) {
    for (const child of children) {
      if (child == null) continue;
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'tabindex') this.tabIndex = Number(value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type, details = {}) {
    const event = {
      target: this,
      key: '',
      button: 0,
      clientX: 0,
      deltaX: 0,
      deltaY: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      ...details,
    };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    return event;
  }

  play() {
    this.playCount += 1;
    this.paused = false;
    this.ended = false;
    this.dispatch('play');
    return Promise.resolve();
  }

  pause() {
    this.pauseCount += 1;
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatch('pause');
  }

  load() { this.loadCount += 1; }
  getContext() { return null; }
  getBoundingClientRect() { return { left: 0, width: 100, top: 0, height: 20 }; }

  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const data = selector.match(/^\[data-([a-z-]+)="([^"]+)"\]$/);
    if (data) {
      const key = data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] === data[2];
    }
    return this.tagName === selector.toUpperCase();
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches?.(selector)) return current;
    }
    return null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((entry) => entry.trim());
    const matches = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.nodeType === 1 && selectors.some((entry) => child.matches(entry))) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { globalThis.document.activeElement = this; }
}

const textNode = (value) => ({ nodeType: 3, textContent: String(value), parentElement: null });

function installBrowserFakes() {
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
    ResizeObserver: globalThis.ResizeObserver,
    matchMedia: globalThis.matchMedia,
  };
  const created = [];
  const revoked = [];
  const frames = new Map();
  let nextFrame = 1;
  const windowListeners = new Map();

  globalThis.document = {
    activeElement: null,
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: textNode,
  };
  globalThis.window = {
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { windowListeners.get(type)?.delete(handler); },
  };
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:audio-lab-${created.length + 1}`;
    created.push({ blob, url });
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.ResizeObserver = undefined;

  return {
    created,
    revoked,
    runNextFrame() {
      const entry = frames.entries().next().value;
      assert.ok(entry, 'expected a pending animation frame');
      frames.delete(entry[0]);
      entry[1](16);
    },
    dispatchWindow(type, details = {}) {
      for (const handler of [...(windowListeners.get(type) || [])]) handler(details);
    },
    pendingFrames: () => frames.size,
    restore() {
      globalThis.document = originals.document;
      globalThis.window = originals.window;
      globalThis.requestAnimationFrame = originals.requestAnimationFrame;
      globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
      globalThis.URL.createObjectURL = originals.createObjectURL;
      globalThis.URL.revokeObjectURL = originals.revokeObjectURL;
      globalThis.ResizeObserver = originals.ResizeObserver;
      globalThis.matchMedia = originals.matchMedia;
    },
  };
}

const action = (control, name) => (
  control.node.querySelector(`[data-audio-lab-action="${name}"]`)
);

test('peak normalization accepts amplitudes and min/max pairs without trusting invalid values', () => {
  assert.deepEqual(normalizeAudioPeaks([
    0.5,
    [-0.25, 0.75],
    { min: -2, max: 3 },
    Number.NaN,
  ]), [
    { min: -0.5, max: 0.5 },
    { min: -0.25, max: 0.75 },
    { min: -1, max: 1 },
    { min: 0, max: 0 },
  ]);
  assert.deepEqual(normalizeAudioPeaks(null), []);
  assert.deepEqual(normalizeAudioPeaks('0.5'), [], 'text is not a peak collection');
});

test('bucketing preserves visible transients and honors a zoomed timeline view', () => {
  const peaks = [0.1, 0.2, 1, 0.3, 0.4, 0.8, 0.2, 0.1];
  assert.deepEqual(bucketAudioPeaks(peaks, 2, { start: 0, end: 8 }, 8), [
    { min: -1, max: 1 },
    { min: -0.8, max: 0.8 },
  ]);
  assert.deepEqual(bucketAudioPeaks(peaks, 2, { start: 2, end: 6 }, 8), [
    { min: -1, max: 1 },
    { min: -0.8, max: 0.8 },
  ]);
  assert.deepEqual(bucketAudioPeaks([], 20, { start: 0, end: 1 }, 1), []);
});

test('selection, fit and playback-boundary helpers remain deterministic at bad edges', () => {
  assert.deepEqual(normalizeAudioSelection(null, 12), { from: 0, to: 12 });
  assert.deepEqual(normalizeAudioSelection({ from: -4, to: 20 }, 12), { from: 0, to: 12 });
  const inverted = normalizeAudioSelection({ from: 8, to: 3 }, 12);
  close(inverted.from, 2.99);
  assert.equal(inverted.to, 3);

  const selectedView = audioViewForSelection({ from: 20, to: 30 }, 100);
  close(spanOf(selectedView), 10);
  close(selectedView.start, 20);
  close(selectedView.end, 30);

  assert.deepEqual(audioSelectionBoundary({
    currentTime: 3,
    selection: { from: 2, to: 4 },
    playingSelection: true,
    loop: true,
  }), { action: 'continue', time: 3 });
  assert.deepEqual(audioSelectionBoundary({
    currentTime: 4,
    selection: { from: 2, to: 4 },
    playingSelection: true,
    loop: true,
  }), { action: 'loop', time: 2 });
  assert.deepEqual(audioSelectionBoundary({
    currentTime: 4,
    selection: { from: 2, to: 4 },
    playingSelection: true,
    loop: false,
  }), { action: 'stop', time: 4 });
  assert.deepEqual(audioSelectionBoundary({
    currentTime: 1,
    selection: { from: 2, to: 4 },
    playingSelection: true,
    loop: false,
  }), { action: 'rebase', time: 2 });
  assert.deepEqual(audioSelectionBoundary({
    currentTime: 1.98,
    selection: { from: 2, to: 4 },
    playingSelection: true,
    loop: false,
  }), { action: 'rebase', time: 2 });
  assert.deepEqual(audioSelectionBoundary({
    currentTime: 1.999,
    selection: { from: 2, to: 4 },
    playingSelection: true,
    loop: false,
  }), { action: 'continue', time: 1.999 });
});

test('the custom player exposes accessible controls and keyboard-driven fragment callbacks', () => {
  const env = installBrowserFakes();
  try {
    const selectionChanges = [];
    const loopChanges = [];
    const fragments = [];
    const opens = [];
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      name: 'Interview.mp3',
      duration: 100,
      onSelectionChange: (...args) => selectionChanges.push(args),
      onLoopChange: (...args) => loopChanges.push(args),
      onCreateFragment: (...args) => fragments.push(args),
      onOpenLab: (state) => opens.push(state),
    });

    assert.equal(control.media.controls, false);
    assert.equal(control.media.attributes.get('aria-hidden'), 'true');
    const track = control.node.querySelector('.audio-lab-waveform-track');
    const seek = control.node.querySelector('.audio-lab-seek-control');
    assert.equal(track.attributes.get('role'), 'group');
    assert.equal(seek.attributes.get('role'), 'slider');
    assert.equal(seek.attributes.get('aria-label'), 'Posición de reproducción');
    assert.equal(control.node.querySelector('.audio-lab-waveform-fallback').hidden, false);
    assert.deepEqual(control.selection(), { from: 0, to: 100 });
    assert.equal(control.node.querySelector('.audio-lab-selection-from').dataset.edge, 'start');
    assert.equal(control.node.querySelector('.audio-lab-selection-to').dataset.edge, 'end');

    control.media.currentTime = 20;
    control.node.dispatch('keydown', { target: control.node, key: 'i' });
    control.media.currentTime = 35;
    control.node.dispatch('keydown', { target: control.node, key: 'o' });
    assert.deepEqual(control.selection(), { from: 20, to: 35 });
    assert.equal(control.node.querySelector('.audio-lab-selection-from').dataset.edge, 'inside');
    assert.equal(control.node.querySelector('.audio-lab-selection-to').dataset.edge, 'inside');
    assert.deepEqual(selectionChanges.map(([range, context]) => [range, context.source, context.commit]), [
      [{ from: 20, to: 100 }, 'shortcut', true],
      [{ from: 20, to: 35 }, 'shortcut', true],
    ]);

    action(control, 'loop').dispatch('click');
    assert.equal(action(control, 'loop').attributes.get('aria-pressed'), 'true');
    assert.deepEqual(loopChanges, [[true, { source: 'button' }]]);
    control.update({ loop: false });
    assert.equal(loopChanges.length, 1, 'controlled updates are silent');
    control.node.dispatch('keydown', { target: control.node, key: 'L' });
    assert.deepEqual(loopChanges, [
      [true, { source: 'button' }],
      [true, { source: 'shortcut' }],
    ]);
    action(control, 'create-fragment').dispatch('click');
    assert.deepEqual(fragments, [[
      { from: 20, to: 35 },
      { name: 'Interview.mp3', duration: 15 },
    ]]);

    action(control, 'open-lab').dispatch('click');
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0].selection, { from: 20, to: 35 });
    assert.equal(opens[0].currentTime, 35);
    assert.equal(opens[0].loop, true);

    const before = control.media.currentTime;
    control.node.dispatch('keydown', { target: control.node, key: 'ArrowLeft', altKey: true });
    close(control.media.currentTime, before - 0.01);

    control.destroy();
  } finally {
    env.restore();
  }
});

test('selection playback loops and stops at its boundary through requestAnimationFrame', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 8,
      selection: { from: 2, to: 4 },
      loop: true,
    });

    action(control, 'play-selection').dispatch('click');
    assert.equal(control.media.paused, false);
    assert.equal(control.media.currentTime, 2);
    assert.equal(env.pendingFrames(), 1);

    control.media.currentTime = 4;
    env.runNextFrame();
    assert.equal(control.media.currentTime, 2);
    assert.equal(control.media.paused, false);
    assert.equal(env.pendingFrames(), 1);

    control.update({ loop: false });
    control.media.currentTime = 4;
    env.runNextFrame();
    assert.equal(control.media.currentTime, 4);
    assert.equal(control.media.paused, true);
    assert.equal(env.pendingFrames(), 0);

    control.destroy();
  } finally {
    env.restore();
  }
});

test('timeupdate enforces selection playback when animation frames are suspended', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 8,
      selection: { from: 2, to: 4 },
      loop: true,
    });
    action(control, 'play-selection').dispatch('click');

    control.media.currentTime = 4.25;
    control.media.dispatch('timeupdate');
    assert.equal(control.media.currentTime, 2, 'background playback loops at the selected edge');
    assert.equal(control.media.paused, false);

    control.update({ loop: false });
    control.media.currentTime = 4.25;
    control.media.dispatch('timeupdate');
    assert.equal(control.media.currentTime, 4);
    assert.equal(control.media.paused, true);
    assert.equal(env.pendingFrames(), 0);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('editing a playing selection ahead of the playhead rebases playback to its new start', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 100,
      selection: { from: 20, to: 80 },
    });
    action(control, 'play-selection').dispatch('click');
    control.media.currentTime = 40;
    control.setSelection({ from: 50, to: 80 });

    env.runNextFrame();
    assert.equal(control.media.currentTime, 50);
    assert.equal(control.media.paused, false);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('loop and rebase jumps follow immediately while the media element reports seeking', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 100,
      selection: { from: 30, to: 80 },
      loop: true,
    });
    action(control, 'zoom-in').dispatch('click');
    action(control, 'play-selection').dispatch('click');
    control.media.currentTime = 60;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 35, end: 85 });

    let clock = 80;
    Object.defineProperty(control.media, 'currentTime', {
      configurable: true,
      get: () => clock,
      set(value) {
        clock = value;
        control.media.seeking = true;
      },
    });
    control.media.seeking = false;
    env.runNextFrame();
    assert.equal(clock, 30);
    assert.equal(control.media.seeking, true);
    assert.deepEqual(control.view(), { start: 5, end: 55 }, 'rAF must show the wrapped clock immediately');

    control.media.seeking = false;
    clock = 60;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 35, end: 85 });
    clock = 80;
    control.media.dispatch('timeupdate');
    assert.equal(clock, 30);
    assert.equal(control.media.seeking, true);
    assert.deepEqual(control.view(), { start: 5, end: 55 }, 'timeupdate must show the wrapped clock immediately');
    control.destroy();
  } finally {
    env.restore();
  }
});

test('ended selection playback follows its loop or stop boundary before settling transport', () => {
  const env = installBrowserFakes();
  try {
    const looped = createAudioLabPlayer({
      url: 'blob:looped',
      duration: 100,
      selection: { from: 30, to: 100 },
      loop: true,
    });
    action(looped, 'zoom-in').dispatch('click');
    action(looped, 'play-selection').dispatch('click');
    looped.media.currentTime = 100;
    looped.media.ended = true;
    looped.media.dispatch('ended');
    assert.equal(looped.media.currentTime, 30);
    assert.equal(looped.media.paused, false);
    assert.deepEqual(looped.view(), { start: 5, end: 55 });
    looped.destroy();

    const stopped = createAudioLabPlayer({
      url: 'blob:stopped',
      duration: 100,
      selection: { from: 30, to: 100 },
      loop: false,
    });
    action(stopped, 'zoom-in').dispatch('click');
    action(stopped, 'play-selection').dispatch('click');
    stopped.media.currentTime = 100;
    stopped.media.ended = true;
    stopped.media.dispatch('ended');
    assert.equal(stopped.media.currentTime, 100);
    assert.equal(stopped.media.paused, true);
    assert.deepEqual(stopped.view(), { start: 50, end: 100 });
    assert.equal(stopped.node.querySelector('.audio-lab-playhead').dataset.edge, 'end');
    stopped.destroy();
  } finally {
    env.restore();
  }
});

test('ended full-file playback follows the final clock to the media edge', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 100,
    });
    action(control, 'zoom-in').dispatch('click');
    action(control, 'play').dispatch('click');
    control.media.currentTime = 100;
    control.media.ended = true;
    control.media.dispatch('ended');

    assert.deepEqual(control.view(), { start: 50, end: 100 });
    assert.equal(control.node.querySelector('.audio-lab-playhead').dataset.edge, 'end');
    assert.equal(env.pendingFrames(), 0);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('selection playback renders its exact stopped position and final followed viewport', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 100,
      selection: { from: 30, to: 80 },
      peaks: Array.from({ length: 100 }, () => 0.5),
    });
    let strokes = 0;
    control.node.querySelector('canvas').getContext = () => ({
      setTransform() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() { strokes += 1; },
    });
    action(control, 'zoom-in').dispatch('click');
    action(control, 'play-selection').dispatch('click');
    assert.equal(control.media.currentTime, 30);
    const beforeStop = strokes;

    control.media.currentTime = 80;
    env.runNextFrame();

    assert.equal(control.media.paused, true);
    assert.equal(control.media.currentTime, 80);
    assert.deepEqual(control.view(), { start: 50, end: 100 });
    close(Number.parseFloat(control.node.querySelector('.audio-lab-playhead').style.left), 60);
    assert.ok(strokes > beforeStop, 'the waveform must repaint for the final viewport');
    control.destroy();
  } finally {
    env.restore();
  }
});

test('a media error stops the playback monitor and leaves transport paused', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({ url: 'blob:caller-owned', duration: 8 });
    action(control, 'play').dispatch('click');
    assert.equal(env.pendingFrames(), 1);

    control.media.dispatch('error');
    assert.equal(control.media.paused, true);
    assert.equal(env.pendingFrames(), 0);
    assert.equal(control.node.dataset.mediaError, 'true');
    assert.equal(action(control, 'play').attributes.get('aria-label'), 'Reproducir');
    control.destroy();
  } finally {
    env.restore();
  }
});

test('object URLs are stable across ordinary updates and only owned URLs are revoked', () => {
  const env = installBrowserFakes();
  try {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    const control = createAudioLabPlayer({ blob, name: 'take.mp3', duration: 4, peaks: [0.2, 0.8] });
    assert.equal(env.created.length, 1);
    assert.equal(control.media.src, 'blob:audio-lab-1');

    control.media.currentTime = 1.5;
    control.update({ name: 'renamed.mp3', blob, peaks: [0.1, 0.9] });
    assert.equal(env.created.length, 1);
    assert.deepEqual(env.revoked, []);
    assert.equal(control.media.currentTime, 1.5);

    control.update({ url: null });
    assert.deepEqual(env.revoked, ['blob:audio-lab-1']);
    assert.equal(control.media.src, '');
    assert.equal(action(control, 'play').disabled, true);

    control.update({ url: 'https://example.test/audio.mp3', duration: 9 });
    assert.equal(control.media.src, 'https://example.test/audio.mp3');

    control.destroy();
    assert.deepEqual(env.revoked, ['blob:audio-lab-1'], 'caller-owned URLs must not be revoked');
    assert.equal(control.node.children.length, 0);
    assert.equal(env.pendingFrames(), 0);
  } finally {
    env.restore();
  }
});

test('seek and range sliders expose their real keyboard and aria bounds', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 8,
      selection: { from: 2, to: 4 },
    });
    const seek = control.node.querySelector('.audio-lab-seek-control');
    const from = control.node.querySelector('.audio-lab-selection-from');
    const to = control.node.querySelector('.audio-lab-selection-to');
    assert.equal(from.attributes.get('aria-valuemax'), '3.99');
    assert.equal(to.attributes.get('aria-valuemin'), '2.01');

    control.media.currentTime = 3;
    seek.dispatch('keydown', { key: 'End' });
    assert.equal(control.media.currentTime, 8);
    seek.dispatch('keydown', { key: 'Home' });
    assert.equal(control.media.currentTime, 0);
    seek.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
    assert.equal(control.media.currentTime, 1);
    seek.dispatch('keydown', { key: 'PageUp' });
    assert.equal(control.media.currentTime, 8);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('following a seek across a zoom boundary redraws peaks for the new viewport', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 8,
      peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    });
    let strokes = 0;
    const canvas = control.node.querySelector('canvas');
    canvas.getContext = () => ({
      setTransform() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() { strokes += 1; },
    });

    action(control, 'zoom-in').dispatch('click');
    const afterZoom = strokes;
    assert.ok(afterZoom > 0);
    control.seek(7);
    assert.ok(strokes > afterZoom, 'the revealed viewport must repaint the canvas');
    control.destroy();
  } finally {
    env.restore();
  }
});

test('zoomed playback centres the playhead, clamps at the edges, and leaves a paused view alone', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 100,
      peaks: Array.from({ length: 100 }, (_, index) => (index + 1) / 100),
    });

    action(control, 'zoom-in').dispatch('click');
    assert.deepEqual(control.view(), { start: 0, end: 50 });
    action(control, 'play').dispatch('click');

    control.media.currentTime = 10;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 0, end: 50 }, 'the beginning must not expose negative time');

    control.media.currentTime = 30;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 5, end: 55 });
    close(Number.parseFloat(control.node.querySelector('.audio-lab-playhead').style.left), 50);

    const fromHandle = control.node.querySelector('.audio-lab-selection-from');
    fromHandle.dispatch('pointerdown');
    control.media.currentTime = 40;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 5, end: 55 }, 'following pauses while a handle is dragged');
    env.dispatchWindow('pointerup');

    fromHandle.focus();
    control.media.currentTime = 45;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 5, end: 55 }, 'following pauses while a handle has focus');
    control.focus();

    control.media.currentTime = 90;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 50, end: 100 }, 'the end must not expose time after the file');

    action(control, 'play').dispatch('click');
    const pausedView = control.view();
    control.media.currentTime = 25;
    control.media.dispatch('timeupdate');
    assert.deepEqual(control.view(), pausedView, 'a passive paused update must not recenter the viewport');

    control.seek(25);
    assert.deepEqual(control.view(), { start: 25, end: 75 }, 'an explicit seek may reveal its target');
    control.destroy();
  } finally {
    env.restore();
  }
});

test('reduced-motion playback reveals only at an edge instead of continuously centring', () => {
  const env = installBrowserFakes();
  try {
    globalThis.matchMedia = (query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    });
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 100,
      peaks: [0.2, 0.4, 0.6, 0.8],
    });
    action(control, 'zoom-in').dispatch('click');
    action(control, 'play').dispatch('click');

    control.media.currentTime = 30;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 0, end: 50 }, 'visible playback must not pan');

    control.media.currentTime = 70;
    env.runNextFrame();
    assert.deepEqual(control.view(), { start: 20, end: 70 }, 'off-screen playback uses minimal reveal');
    close(Number.parseFloat(control.node.querySelector('.audio-lab-playhead').style.left), 100);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('time fields replace invalid or clamped input with the canonical value', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 8,
      selection: { from: 2, to: 4 },
    });
    const [from, to] = control.node.querySelectorAll('.audio-lab-time-field');

    globalThis.document.activeElement = from;
    from.value = '999';
    from.dispatch('change');
    assert.equal(from.value, '00:00:03.990');
    assert.equal(control.selection().from, 3.99);

    globalThis.document.activeElement = to;
    to.value = 'not-a-time';
    to.dispatch('change');
    assert.equal(to.value, '00:00:04.000');
    assert.equal(control.selection().to, 4);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('updates are silent, clamp state, and disabled mode can be reversed', () => {
  const env = installBrowserFakes();
  try {
    const changes = [];
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      duration: 20,
      selection: { from: 5, to: 15 },
      onSelectionChange: (...args) => changes.push(args),
      onOpenLab: () => {},
    });

    control.update({ duration: 10, selection: { from: 7, to: 50 }, disabled: true });
    assert.deepEqual(control.selection(), { from: 7, to: 10 });
    assert.equal(changes.length, 0);
    assert.equal(action(control, 'play').disabled, true);
    assert.equal(control.node.attributes.get('aria-disabled'), 'true');

    control.update({ disabled: false });
    assert.equal(action(control, 'play').disabled, false);
    assert.equal(action(control, 'open-lab').disabled, false);
    assert.equal(control.node.attributes.get('aria-disabled'), 'false');

    control.setSelection({ from: 1, to: 2 }, true);
    assert.deepEqual(changes, [[{ from: 1, to: 2 }, { source: 'api', commit: true }]]);
    control.destroy();
  } finally {
    env.restore();
  }
});

test('an explicit selection survives until metadata supplies an unknown duration', () => {
  const env = installBrowserFakes();
  try {
    const control = createAudioLabPlayer({
      url: 'blob:caller-owned',
      selection: { from: 12, to: 18 },
    });
    assert.deepEqual(control.selection(), { from: 0, to: 0 });

    control.media.duration = 30;
    control.media.dispatch('loadedmetadata');
    assert.deepEqual(control.selection(), { from: 12, to: 18 });

    control.update({ duration: null, selection: { from: 3, to: 6 } });
    assert.deepEqual(control.selection(), { from: 0, to: 0 });
    control.media.duration = 10;
    control.media.dispatch('durationchange');
    assert.deepEqual(control.selection(), { from: 3, to: 6 });
    control.destroy();
  } finally {
    env.restore();
  }
});
