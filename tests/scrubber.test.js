import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScrubber } from '../src/ui/scrubber.js';

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
    this.style = {};
    this.clientWidth = 0;
    this.value = '';
    this.paused = true;
    this.readyState = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.duration = Number.NaN;
    this.src = '';
    this.currentSrc = '';
    this._currentTime = 0;
    this.autoSeek = false;
    this.pauseCount = 0;
    this.loadCount = 0;
    this.removedSourceCount = 0;
  }

  get currentTime() { return this._currentTime; }

  set currentTime(value) {
    this._currentTime = Number(value);
    if (this.autoSeek) queueMicrotask(() => this.dispatch('seeked'));
  }

  append(...children) {
    for (const child of children) {
      if (child == null) continue;
      child.parentElement = this;
      this.children.push(child);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'tabindex') this.tabIndex = Number(value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') {
      this.removedSourceCount += 1;
      this.src = '';
      this.currentSrc = '';
    }
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
      preventDefault() {},
      stopPropagation() {},
      ...details,
    };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    return event;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains?.(candidate));
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.matches?.(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { left: 0, width: 100 }; }
  getContext() { return { drawImage() {} }; }
  focus() { globalThis.document.activeElement = this; }
  select() {}

  pause() {
    this.pauseCount += 1;
    this.paused = true;
  }

  play() {
    this.paused = false;
    this.dispatch('play');
    return Promise.resolve();
  }

  load() { this.loadCount += 1; }
}

const textNode = (value) => ({ nodeType: 3, textContent: String(value), parentElement: null });

function installDom() {
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
  };
  const createdElements = [];
  const createdUrls = [];
  const revokedUrls = [];
  const windowListeners = new Map();

  globalThis.document = {
    activeElement: null,
    createElement(tag) {
      const element = new FakeElement(tag);
      createdElements.push(element);
      return element;
    },
    createTextNode: textNode,
  };
  globalThis.window = {
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { windowListeners.get(type)?.delete(handler); },
  };
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:scrubber-${createdUrls.length + 1}`;
    createdUrls.push({ blob, url });
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => revokedUrls.push(url);

  return {
    createdElements,
    createdUrls,
    revokedUrls,
    restore() {
      globalThis.document = originals.document;
      globalThis.window = originals.window;
      globalThis.URL.createObjectURL = originals.createObjectURL;
      globalThis.URL.revokeObjectURL = originals.revokeObjectURL;
    },
  };
}

function sharedVideo({ ready = false, autoSeek = false } = {}) {
  const video = new FakeElement('video');
  video.src = 'blob:owned-by-preview';
  video.currentSrc = 'blob:owned-by-preview';
  video.duration = 20;
  video._currentTime = 7;
  video.readyState = ready ? 2 : 0;
  video.videoWidth = ready ? 640 : 0;
  video.videoHeight = ready ? 360 : 0;
  video.autoSeek = autoSeek;
  video.controls = true;
  video.muted = true;
  return video;
}

const options = (extra = {}) => ({
  file: new Blob(['video'], { type: 'video/mp4' }),
  info: { duration: 20, video: { fps: 25 } },
  ...extra,
});

test('a borrowed preview creates no media or URL and survives scrubber teardown untouched', () => {
  const env = installDom();
  try {
    const media = sharedVideo();
    const control = createScrubber(options({ mediaElement: media }));

    assert.equal(env.createdElements.filter((node) => node.tagName === 'VIDEO').length, 0);
    assert.equal(env.createdUrls.length, 0);
    assert.equal(control.node.contains(media), false, 'borrowed media is never reparented into the scrubber');
    assert.equal(media.controls, true);
    assert.equal(media.muted, true, 'caller playback configuration is preserved');

    control.destroy();
    assert.equal(media.pauseCount, 0);
    assert.equal(media.removedSourceCount, 0);
    assert.equal(media.loadCount, 0);
    assert.equal(media.src, 'blob:owned-by-preview');
    assert.deepEqual(env.revokedUrls, []);
  } finally {
    env.restore();
  }
});

test('the legacy scrubber still owns, renders and fully releases its private video', () => {
  const env = installDom();
  try {
    const file = new Blob(['legacy'], { type: 'video/mp4' });
    const control = createScrubber(options({ file, mediaControls: true }));
    const media = env.createdElements.find((node) => node.tagName === 'VIDEO');

    assert.ok(media);
    assert.equal(env.createdUrls.length, 1);
    assert.equal(env.createdUrls[0].blob, file);
    assert.equal(control.node.children[0], media);
    assert.equal(media.controls, true);
    assert.equal(media.muted, false);

    control.destroy();
    assert.equal(media.pauseCount, 1);
    assert.equal(media.removedSourceCount, 1);
    assert.equal(media.loadCount, 1);
    assert.deepEqual(env.revokedUrls, ['blob:scrubber-1']);
  } finally {
    env.restore();
  }
});

test('showVideo false keeps an owned decoder out of the node without changing ownership', () => {
  const env = installDom();
  try {
    const control = createScrubber(options({ showVideo: false }));
    const media = env.createdElements.find((node) => node.tagName === 'VIDEO');

    assert.ok(media);
    assert.equal(control.node.contains(media), false);
    assert.equal(env.createdUrls.length, 1);
    control.destroy();
    assert.deepEqual(env.revokedUrls, ['blob:scrubber-1']);
  } finally {
    env.restore();
  }
});

test('selection handles keep their full hit target inside both track edges', () => {
  const env = installDom();
  try {
    const control = createScrubber(options({ initialSelection: { from: 0, to: 20 } }));
    const handles = control.node.querySelectorAll('.scrub-handle');
    assert.equal(handles[0].dataset.edge, 'start');
    assert.equal(handles[1].dataset.edge, 'end');
    control.destroy();

    const inset = createScrubber(options({ initialSelection: { from: 4, to: 16 } }));
    const insetHandles = inset.node.querySelectorAll('.scrub-handle');
    assert.equal(insetHandles[0].dataset.edge, 'inside');
    assert.equal(insetHandles[1].dataset.edge, 'inside');
    inset.destroy();
  } finally {
    env.restore();
  }
});

test('filmstrip seeks restore a paused borrowed preview to its existing playhead', async () => {
  const env = installDom();
  try {
    const media = sharedVideo({ ready: true, autoSeek: true });
    const control = createScrubber(options({ mediaElement: media, showVideo: false }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(media.currentTime, 7);
    assert.ok(control.node.querySelectorAll('.scrub-frame').length > 0);

    control.destroy();
    assert.equal(media.currentTime, 7);
    assert.equal(media.pauseCount, 0);
    assert.equal(media.src, 'blob:owned-by-preview');
  } finally {
    env.restore();
  }
});

test('destroying during a borrowed filmstrip restores the clock without owning the source', async () => {
  const env = installDom();
  try {
    const media = sharedVideo({ ready: true, autoSeek: false });
    const control = createScrubber(options({ mediaElement: media }));

    await Promise.resolve();
    assert.notEqual(media.currentTime, 7, 'thumbnail generation has begun seeking the shared decoder');
    control.destroy();

    assert.equal(media.currentTime, 7);
    assert.equal(media.pauseCount, 0);
    assert.equal(media.removedSourceCount, 0);
    assert.deepEqual(env.revokedUrls, []);
  } finally {
    env.restore();
  }
});

test('a borrowed source replacement is never overwritten by stale filmstrip cleanup', async () => {
  const env = installDom();
  try {
    const media = sharedVideo({ ready: true, autoSeek: false });
    const control = createScrubber(options({ mediaElement: media }));

    await Promise.resolve();
    media.src = 'blob:new-owner-source';
    media.currentSrc = 'blob:new-owner-source';
    media._currentTime = 3;
    control.destroy();

    assert.equal(media.currentTime, 3);
    assert.equal(media.src, 'blob:new-owner-source');
    assert.equal(media.removedSourceCount, 0);
    assert.deepEqual(env.revokedUrls, []);
  } finally {
    env.restore();
  }
});
