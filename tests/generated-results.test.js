import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGeneratedResults,
  generatedMediaKind,
  generatedResultFacts,
  generatedResultMetadata,
  generatedStorageStatus,
  normalizeGeneratedResults,
  pickGeneratedResultId,
} from '../src/ui/generated-results.js';

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
    this.clientHeight = this.tagName === 'CANVAS' ? 150 : 0;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.paused = true;
    this.ended = false;
    this.pauseCount = 0;
    this.playCount = 0;
    this.loadCount = 0;
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
      preventDefault() {},
      stopPropagation() {},
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
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const dataPresence = selector.match(/^\[data-([a-z-]+)\]$/);
    if (dataPresence) {
      const key = dataPresence[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.prototype.hasOwnProperty.call(this.dataset, key);
    }
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

const textNode = (text) => ({ nodeType: 3, textContent: String(text), parentElement: null });

function installFakeDocument() {
  const originalDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: textNode,
  };
  return () => { globalThis.document = originalDocument; };
}

function dispatchFrom(root, type, target, details = {}) {
  const event = { target, ...details };
  for (const handler of root.listeners.get(type) || []) handler(event);
}

const canonicalAudioLabState = (selectedNodeId = 'fragment-1') => ({
  schemaVersion: 1,
  rootNodeId: 'root-1',
  selectedNodeId,
  nodes: [
    {
      id: 'root-1',
      kind: 'root',
      parentNodeId: null,
      outputId: 'output-audio-1',
      projectId: 'project-1',
      resultId: 'audio-1',
      name: 'session.mp3',
      type: 'audio/mpeg',
      size: 48_000,
      duration: 12,
    },
    {
      id: 'fragment-1',
      kind: 'fragment',
      parentNodeId: 'root-1',
      label: 'Estribillo',
      range: { start: 2, end: 8 },
    },
  ],
});

test('generated media kind recognizes browser media from MIME or filename', () => {
  assert.equal(generatedMediaKind({ name: 'concert.mp3' }), 'audio');
  assert.equal(generatedMediaKind({ name: 'concert.unknown', blob: { type: 'audio/mpeg' } }), 'audio');
  assert.equal(generatedMediaKind({ name: 'poster.webp' }), 'image');
  assert.equal(generatedMediaKind({ name: 'clip.MP4' }), 'video');
  assert.equal(generatedMediaKind({ name: 'archive.zip' }), 'file');
});

test('explicit kind and MIME win over a misleading extension', () => {
  assert.equal(generatedMediaKind({ name: 'audio.mp4', mime: 'audio/mp4' }), 'audio');
  assert.equal(generatedMediaKind({ name: 'preview.mp3', kind: 'video' }), 'video');
});

test('audio result metadata accepts probe-shaped information', () => {
  const metadata = generatedResultMetadata({
    name: 'live-set.mp3',
    size: 4_981_801,
    info: {
      duration: 207.49,
      bitrate: 192_000,
      audio: { codec: 'mp3', channels: 2, sampleRate: 48_000 },
    },
  });

  assert.deepEqual(metadata, {
    kind: 'audio',
    mime: '',
    format: 'MP3',
    size: 4_981_801,
    duration: 207.49,
    width: null,
    height: null,
    codec: 'MP3',
    bitrate: 192_000,
    channels: 2,
    sampleRate: 48_000,
  });
});

test('a canonical generation previews its first output and uses aggregate metadata', () => {
  const metadata = generatedResultMetadata({
    downloadName: 'frames.zip',
    mediaKind: 'image',
    totalSize: 24_000,
    metadata: { width: 640, height: 360 },
    outputs: [
      { name: 'frame-001.png', type: 'image/png', blob: { size: 10_000, type: 'image/png' } },
      { name: 'frame-002.png', type: 'image/png', blob: { size: 14_000, type: 'image/png' } },
    ],
  });

  assert.equal(metadata.kind, 'image');
  assert.equal(metadata.mime, 'image/png');
  assert.equal(metadata.format, 'ZIP');
  assert.equal(metadata.size, 24_000);
  assert.equal(metadata.width, 640);
  assert.equal(metadata.height, 360);
});

test('result facts expose useful audio playback metadata without duplicate codec', () => {
  assert.deepEqual(generatedResultFacts({
    name: 'live-set.mp3',
    size: 4_981_801,
    duration: 207.49,
    bitrate: 192_000,
    codec: 'mp3',
    channels: 2,
    sampleRate: 44_100,
  }), [
    { key: 'format', label: 'Formato', value: 'MP3' },
    { key: 'size', label: 'Tamaño', value: '4.8 MB' },
    { key: 'duration', label: 'Duración', value: '3:27' },
    { key: 'bitrate', label: 'Bitrate', value: '192 kbps' },
    { key: 'channels', label: 'Canales', value: 'Estéreo' },
    { key: 'sample-rate', label: 'Muestreo', value: '44.1 kHz' },
  ]);
});

test('video and image facts include dimensions while invalid values are ignored', () => {
  const facts = generatedResultFacts({
    name: 'crop.png',
    metadata: { width: 1080, height: 1080, bitrate: -1 },
  });
  assert.deepEqual(facts, [
    { key: 'format', label: 'Formato', value: 'PNG' },
    { key: 'dimensions', label: 'Resolución', value: '1080×1080' },
  ]);
});

test('normalization makes duplicate fallback ids unique and preserves callback values', () => {
  const first = { name: 'output.mp3', size: 10 };
  const second = { name: 'output.mp3', size: 20 };
  const normalized = normalizeGeneratedResults([first, second]);

  assert.deepEqual(normalized.map((result) => result.id), ['output.mp3', 'output.mp3-2']);
  assert.equal(normalized[0].original, first);
  assert.equal(normalized[1].original, second);
});

test('selection prefers an explicit id, then a fresh result, then the first result', () => {
  const results = [
    { id: 'old', name: 'old.mp3' },
    { id: 'new', name: 'new.mp3', fresh: true },
  ];

  assert.equal(pickGeneratedResultId(results, 'old'), 'old');
  assert.equal(pickGeneratedResultId(results, 'missing'), 'new');
  assert.equal(pickGeneratedResultId(results.map(({ fresh, ...result }) => result)), 'old');
  assert.equal(pickGeneratedResultId([]), null);
});

test('storage copy never promises persistence without an explicit saved state', () => {
  assert.deepEqual(generatedStorageStatus(), {
    state: 'session',
    badge: 'Solo sesión',
    title: 'Disponible en esta sesión',
    message: 'Todavía no está guardado de forma persistente. Descargalo antes de cerrar esta pestaña.',
  });
  assert.equal(generatedStorageStatus('off').state, 'session');
  assert.equal(generatedStorageStatus('saving').state, 'saving');
  assert.equal(generatedStorageStatus('error').state, 'error');
  assert.deepEqual(generatedStorageStatus('saved'), {
    state: 'persisted',
    badge: 'Guardado',
    title: 'Guardado en este navegador',
    message: 'Guardado en este dispositivo · no se subió a ningún servidor.',
  });
});

test('equivalent updates and storage transitions preserve the active audio and object URL', () => {
  const originalDocument = globalThis.document;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  globalThis.document = {
    activeElement: null,
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: textNode,
  };
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:test-${created.length + 1}`;
    created.push({ blob, url });
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    const firstBlob = new Blob(['first'], { type: 'audio/mpeg' });
    const result = { id: 'result-1', name: 'take.mp3', blob: firstBlob, duration: 8 };
    const control = createGeneratedResults({ results: [result], storageStatus: 'saving' });
    const audio = control.node.querySelector('audio');
    audio.currentTime = 4.5;

    control.update({
      results: [{ ...result }],
      storageStatus: 'saved',
    });

    assert.equal(created.length, 1);
    assert.equal(revoked.length, 0);
    assert.equal(control.node.querySelector('audio'), audio);
    assert.equal(audio.currentTime, 4.5);
    assert.equal(control.node.querySelector('.generated-result-local').textContent, 'Guardado');

    const secondBlob = new Blob(['other'], { type: 'audio/mpeg' });
    control.update({ results: [{ ...result, blob: secondBlob }] });
    assert.equal(created.length, 2);
    assert.deepEqual(revoked, ['blob:test-1']);
    assert.notEqual(control.node.querySelector('audio'), audio);

    control.destroy();
    assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
  } finally {
    globalThis.document = originalDocument;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('the lineage source is presentational until source navigation is enabled', () => {
  const restoreDocument = installFakeDocument();

  try {
    const source = { name: 'camera-original.mp4', size: 28_000, duration: 12 };
    const control = createGeneratedResults({
      source,
      results: [{ id: 'audio-1', name: 'camera-original.mp3' }],
    });

    const origin = control.node.querySelector('.generated-lineage-origin');
    assert.equal(origin.tagName, 'DIV');
    assert.equal(origin.dataset.generatedAction, undefined);
    assert.equal(origin.querySelector('.generated-lineage-source-action'), null);

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('the lineage source becomes an accessible button and releases its delegated listener', () => {
  const restoreDocument = installFakeDocument();

  try {
    const source = { name: 'camera-original.mp4', size: 28_000, duration: 12 };
    const selectedSources = [];
    const control = createGeneratedResults({
      source,
      results: [{ id: 'audio-1', name: 'camera-original.mp3' }],
      onCreateAnother: () => {},
    });

    assert.equal(
      control.node.querySelector('[data-generated-action="create-another"]').textContent,
      'Trabajar desde el original',
    );

    control.update({ onSelectSource: (selected) => selectedSources.push(selected) });
    const origin = control.node.querySelector('.generated-lineage-origin');
    const hint = origin.querySelector('.generated-lineage-source-action');

    assert.equal(origin.tagName, 'BUTTON');
    assert.equal(origin.type, 'button');
    assert.equal(origin.dataset.generatedAction, 'select-source');
    assert.equal(origin.attributes.get('aria-label'), 'Abrir el archivo original: camera-original.mp4');
    assert.equal(hint.children[0].textContent, 'Abrir original');

    origin.focus();
    assert.equal(globalThis.document.activeElement, origin);
    dispatchFrom(control.node, 'click', hint.children[0]);
    assert.deepEqual(selectedSources, [source]);

    control.destroy();
    assert.equal(control.node.listeners.get('click')?.size, 0);
    assert.equal(control.node.listeners.get('keydown')?.size, 0);
    dispatchFrom(control.node, 'click', origin);
    assert.deepEqual(selectedSources, [source]);
  } finally {
    restoreDocument();
  }
});

test('audio results use the custom waveform player without native chrome or legacy artwork', () => {
  const restoreDocument = installFakeDocument();

  try {
    const control = createGeneratedResults({
      results: [{ id: 'audio-1', name: 'session.mp3', url: 'blob:caller-audio', duration: 12 }],
      audioLabStateByResult: {
        'audio-1': { peaks: [0.2, 0.6, 1, 0.4], selection: { from: 2, to: 8 }, loop: true },
      },
    });

    const audio = control.node.querySelector('audio');
    assert.ok(audio);
    assert.equal(audio.controls, false);
    assert.equal(control.node.querySelector('.audio-lab-player') != null, true);
    assert.equal(control.node.querySelector('.audio-lab-waveform-canvas') != null, true);
    assert.equal(control.node.querySelector('.generated-audio-artwork'), null);
    assert.equal(control.node.querySelector('.generated-result-audio'), null);
    assert.equal(control.node.querySelector('.audio-lab-loop').attributes.get('aria-pressed'), 'true');
    assert.equal(control.node.querySelector('.audio-lab-time-field').value, '00:00:02.000');
    assert.equal(control.node.querySelector('[data-audio-lab-action="create-fragment"]').hidden, true);

    audio.currentTime = 3;
    control.update({ onCreateAudioFragment: () => {} });
    assert.equal(control.node.querySelector('audio'), audio);
    assert.equal(audio.currentTime, 3);
    assert.equal(control.node.querySelector('[data-audio-lab-action="create-fragment"]').hidden, false);

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('same-source state and callback updates preserve a duration learned from media metadata', () => {
  const restoreDocument = installFakeDocument();

  try {
    const control = createGeneratedResults({
      results: [{ id: 'audio-1', name: 'unknown-length.mp3', url: 'blob:caller-audio' }],
    });
    const audio = control.node.querySelector('audio');
    audio.duration = 9;
    audio.dispatch('loadedmetadata');
    assert.equal(control.node.querySelectorAll('.audio-lab-time-field')[1].value, '00:00:09.000');

    control.update({ onCreateAudioFragment: () => {} });
    assert.equal(control.node.querySelector('audio'), audio);
    assert.equal(control.node.querySelectorAll('.audio-lab-time-field')[1].value, '00:00:09.000');

    control.update({ audioLabStateByResult: { 'audio-1': { loop: true } } });
    assert.equal(control.node.querySelector('audio'), audio);
    assert.equal(control.node.querySelectorAll('.audio-lab-time-field')[1].value, '00:00:09.000');

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('a Blob URL installation failure falls back instead of showing a dead player', () => {
  const restoreDocument = installFakeDocument();
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = () => { throw new Error('quota'); };

  try {
    const control = createGeneratedResults({
      results: [{ id: 'audio-1', name: 'broken.mp3', blob: new Blob(['audio'], { type: 'audio/mpeg' }) }],
    });
    assert.equal(control.node.querySelector('audio'), null);
    assert.equal(control.node.querySelector('.generated-result-unavailable').hidden, false);
    assert.equal(control.node.querySelector('.generated-audio-lab-shell').dataset.error, 'true');
    control.destroy();
  } finally {
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    restoreDocument();
  }
});

test('Audio Lab expands in place, returns to the result and forwards editing callbacks with result context', () => {
  const restoreDocument = installFakeDocument();
  const selections = [];
  const loopChanges = [];
  const fragments = [];
  const openings = [];
  const expansionChanges = [];

  try {
    const result = { id: 'audio-1', name: 'session.mp3', url: 'blob:caller-audio', duration: 12 };
    const control = createGeneratedResults({
      results: [result],
      audioLabState: canonicalAudioLabState(),
      audioLabStateByResult: {
        'audio-1': { selection: { from: 1, to: 8 } },
      },
      onAudioSelectionChange: (...args) => selections.push(args),
      onAudioLoopChange: (...args) => loopChanges.push(args),
      onCreateAudioFragment: (...args) => fragments.push(args),
      onOpenAudioLab: (...args) => openings.push(args),
      onAudioLabExpandedChange: (...args) => expansionChanges.push(args),
    });

    const audio = control.node.querySelector('audio');
    audio.currentTime = 2;
    control.node.querySelector('[data-audio-lab-action="mark-from"]').dispatch('click');
    assert.deepEqual(selections[0][1], { from: 2, to: 8 });
    assert.deepEqual(
      { id: selections[0][2].id, source: selections[0][2].source, commit: selections[0][2].commit },
      { id: 'audio-1', source: 'mark', commit: true },
    );

    control.node.querySelector('[data-audio-lab-action="loop"]').dispatch('click');
    assert.equal(loopChanges[0][0], result);
    assert.equal(loopChanges[0][1], true);
    assert.deepEqual(
      { id: loopChanges[0][2].id, index: loopChanges[0][2].index },
      { id: 'audio-1', index: 0 },
    );
    assert.equal(loopChanges[0][2].audioLabState.selectedNodeId, 'fragment-1');
    control.update({
      audioLabStateByResult: { 'audio-1': { selection: { from: 2, to: 7 }, loop: false } },
    });
    assert.equal(loopChanges.length, 1, 'persisted loop updates do not echo through the callback');

    control.node.querySelector('[data-audio-lab-action="create-fragment"]').dispatch('click');
    assert.equal(fragments[0][0], result);
    assert.deepEqual(fragments[0][1], { from: 2, to: 7 });
    assert.equal(fragments[0][2].parentNodeId, 'fragment-1');

    control.node.querySelector('[data-audio-lab-action="open-lab"]').dispatch('click');
    assert.equal(control.node.dataset.audioLabExpanded, 'true');
    assert.equal(control.getAudioLabExpandedId(), 'audio-1');
    assert.equal(
      control.node.attributes.get('aria-labelledby'),
      control.node.querySelector('.generated-audio-lab-workspace-head').querySelector('strong').id,
    );
    assert.equal(control.node.querySelector('.generated-audio-lab-workspace-head').hidden, false);
    assert.equal(control.node.querySelector('.generated-audio-lab-navigation').hidden, false);
    assert.equal(openings[0][0], result);
    assert.equal(openings[0][2].audioLabState.selectedNodeId, 'fragment-1');
    assert.equal(expansionChanges[0][0], 'audio-1');
    assert.equal(expansionChanges[0][1].reason, 'open');

    const back = control.node.querySelector('[data-generated-action="close-audio-lab"]');
    dispatchFrom(control.node, 'click', back);
    assert.equal(control.node.dataset.audioLabExpanded, 'false');
    assert.equal(control.getAudioLabExpandedId(), null);
    assert.equal(control.node.attributes.get('aria-labelledby'), control.node.querySelector('.generated-results-heading').querySelector('h2').id);
    assert.equal(expansionChanges[1][0], null);
    assert.equal(expansionChanges[1][1].reason, 'close');

    control.node.querySelector('[data-audio-lab-action="open-lab"]').dispatch('click');
    control.update({ results: [] });
    assert.equal(control.getAudioLabExpandedId(), null);
    assert.equal(control.node.dataset.audioLabExpanded, 'false');
    assert.equal(
      control.node.attributes.get('aria-labelledby'),
      control.node.querySelector('.generated-results-empty').querySelector('h2').id,
    );

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('canonical Audio Lab state renders breadcrumbs and selectable fragment nodes', () => {
  const restoreDocument = installFakeDocument();
  const selected = [];

  try {
    const result = { id: 'audio-1', name: 'session.mp3', url: 'blob:caller-audio', duration: 12 };
    const control = createGeneratedResults({
      results: [result],
      audioLabState: canonicalAudioLabState(),
      audioLabExpandedId: 'audio-1',
      onSelectAudioNode: (...args) => selected.push(args),
    });

    assert.equal(control.node.dataset.audioLabExpanded, 'true');
    assert.equal(control.node.querySelectorAll('.generated-audio-lab-breadcrumbs')[0].children.length, 2);
    const nodes = control.node.querySelectorAll('.generated-audio-lab-node');
    assert.equal(nodes.length, 2);
    assert.equal(nodes[1].className.includes('is-selected'), true);

    nodes[0].focus();
    dispatchFrom(control.node, 'click', nodes[0]);
    assert.equal(selected[0][0], 'root-1');
    assert.equal(selected[0][1].result, result);
    assert.equal(selected[0][1].id, 'audio-1');
    assert.equal(selected[0][1].node.kind, 'root');

    const audio = control.node.querySelector('audio');
    audio.currentTime = 4.25;
    control.update({
      audioLabState: canonicalAudioLabState('root-1'),
      audioLabStateByResult: { 'audio-1': { selection: { from: 0, to: 6 }, peaks: [0.5, 1] } },
    });
    assert.equal(control.node.querySelector('audio'), audio);
    assert.equal(audio.currentTime, 4.25);
    assert.equal(control.node.dataset.audioLabExpanded, 'true');
    assert.equal(control.node.querySelectorAll('.generated-audio-lab-node')[0].className.includes('is-selected'), true);
    assert.equal(control.node.querySelector('.audio-lab-time-field').value, '00:00:00.000');
    assert.equal(globalThis.document.activeElement.dataset.audioNodeId, 'root-1');

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('the active fragment owns playback, color identity and keyboard navigation', () => {
  const restoreDocument = installFakeDocument();
  const selected = [];

  try {
    const control = createGeneratedResults({
      results: [{ id: 'audio-1', name: 'session.mp3', url: 'blob:caller-audio', duration: 12 }],
      audioLabState: canonicalAudioLabState(),
      audioLabStateByResult: {
        'audio-1': { selection: { from: 2, to: 8 }, loop: false },
      },
      audioLabExpandedId: 'audio-1',
      onSelectAudioNode: (...args) => selected.push(args),
    });

    const nodes = control.node.querySelectorAll('.generated-audio-lab-node');
    const fragment = nodes[1];
    const player = control.node.querySelector('.audio-lab-player');
    const audio = control.node.querySelector('audio');
    assert.match(fragment.dataset.accent, /^[0-5]$/);
    assert.equal(player.dataset.accent, fragment.dataset.accent);
    assert.equal(fragment.querySelector('.generated-audio-lab-node-current').textContent, 'Activo · Espacio');

    let prevented = 0;
    dispatchFrom(control.node, 'keydown', fragment, {
      key: ' ',
      preventDefault: () => { prevented += 1; },
      stopPropagation() {},
    });
    assert.equal(prevented, 1);
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, 2, 'fragment playback starts at its own beginning');

    dispatchFrom(control.node, 'keydown', fragment, {
      key: ' ',
      preventDefault: () => { prevented += 1; },
      stopPropagation() {},
    });
    assert.equal(audio.paused, true);

    dispatchFrom(control.node, 'keydown', fragment, {
      key: 'ArrowUp',
      preventDefault: () => { prevented += 1; },
      stopPropagation() {},
    });
    assert.equal(selected.at(-1)[0], 'root-1');
    assert.equal(selected.at(-1)[1].node.kind, 'root');
    assert.equal(globalThis.document.activeElement.dataset.audioNodeId, 'root-1');

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('fragment navigation renders real tree order with absolute ranges', () => {
  const restoreDocument = installFakeDocument();

  try {
    const base = canonicalAudioLabState();
    const graph = {
      ...base,
      selectedNodeId: 'fragment-a1',
      nodes: [
        base.nodes[0],
        { ...base.nodes[1], id: 'fragment-a', label: 'A' },
        {
          id: 'fragment-c',
          kind: 'fragment',
          parentNodeId: 'root-1',
          label: 'B',
          range: { start: 8.125, end: 8.375 },
        },
        {
          id: 'fragment-a1',
          kind: 'fragment',
          parentNodeId: 'fragment-a',
          label: 'A1',
          range: { start: 1, end: 2 },
        },
      ],
    };
    const control = createGeneratedResults({
      results: [{ id: 'audio-1', name: 'session.mp3', url: 'blob:caller-audio', duration: 12 }],
      audioLabState: graph,
      audioLabExpandedId: 'audio-1',
      onSelectAudioNode() {},
    });

    const nodes = control.node.querySelectorAll('.generated-audio-lab-node');
    assert.deepEqual(
      nodes.map((node) => node.dataset.audioNodeId),
      ['root-1', 'fragment-a', 'fragment-a1', 'fragment-c'],
    );
    assert.equal(nodes[2].querySelector('small').textContent, '0:03–0:04 · 0:01');
    assert.equal(nodes[3].querySelector('small').textContent, '0:08.125–0:08.375 · 0.250 s');
    assert.match(nodes[3].attributes.get('aria-label'), /00:00:08\.125 a 00:00:08\.375/);
    assert.notEqual(nodes[1].dataset.accent, nodes[2].dataset.accent);
    assert.notEqual(nodes[2].dataset.accent, nodes[3].dataset.accent);
    assert.equal(control.node.querySelector('.audio-lab-name').textContent, 'A1');

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('selecting a different audio result destroys the previous player before installing the next one', () => {
  const restoreDocument = installFakeDocument();

  try {
    const control = createGeneratedResults({
      results: [
        { id: 'audio-1', name: 'one.mp3', url: 'blob:caller-one', duration: 4 },
        { id: 'audio-2', name: 'two.mp3', url: 'blob:caller-two', duration: 5 },
      ],
    });
    const first = control.node.querySelector('audio');
    first.currentTime = 2;

    control.select('audio-2', false);
    const second = control.node.querySelector('audio');
    assert.notEqual(second, first);
    assert.equal(first.pauseCount > 0, true);
    assert.equal(first.loadCount > 0, true);
    assert.equal(first.src, '');

    control.destroy();
    assert.equal(second.pauseCount > 0, true);
    assert.equal(second.loadCount > 0, true);
  } finally {
    restoreDocument();
  }
});

test('a canonical graph is never exposed through a different active audio result', () => {
  const restoreDocument = installFakeDocument();

  try {
    const control = createGeneratedResults({
      results: [
        { id: 'audio-1', name: 'one.mp3', url: 'blob:caller-one', duration: 12 },
        { id: 'audio-2', name: 'two.mp3', url: 'blob:caller-two', duration: 12 },
      ],
      audioLabState: canonicalAudioLabState(),
    });

    assert.equal(control.node.querySelectorAll('.generated-audio-lab-node').length, 2);
    control.select('audio-2', false);
    control.setAudioLabExpanded('audio-2');

    assert.equal(control.node.querySelectorAll('.generated-audio-lab-node').length, 0);
    assert.equal(
      control.node.querySelector('.generated-audio-lab-map-empty').querySelector('strong').textContent,
      'Este resultado todavía no tiene un mapa',
    );

    control.update({
      results: [{ id: 'audio-2', name: 'two.bin', kind: 'file', url: 'blob:caller-two' }],
    });
    assert.equal(control.getAudioLabExpandedId(), null);
    assert.equal(control.node.dataset.audioLabExpanded, 'false');

    control.destroy();
  } finally {
    restoreDocument();
  }
});

test('canonical graph binding prefers an exact preview output but supports a flat legacy output id', () => {
  const restoreDocument = installFakeDocument();

  try {
    const base = canonicalAudioLabState();
    const graphFor = (outputId, resultId) => ({
      ...base,
      nodes: base.nodes.map((node) => node.kind === 'root' ? { ...node, outputId, resultId } : node),
    });
    const multi = createGeneratedResults({
      results: [{
        id: 'audio-1',
        name: 'bundle.mp3',
        kind: 'audio',
        outputs: [
          { id: 'output-primary', name: 'primary.mp3', url: 'blob:caller-primary', type: 'audio/mpeg' },
          { id: 'output-secondary', name: 'secondary.mp3', url: 'blob:caller-secondary', type: 'audio/mpeg' },
        ],
      }],
      audioLabState: graphFor('output-secondary', 'audio-1'),
    });
    assert.equal(multi.node.querySelectorAll('.generated-audio-lab-node').length, 0);
    assert.equal(
      multi.node.querySelector('.generated-audio-lab-map-empty').querySelector('strong').textContent,
      'Este resultado todavía no tiene un mapa',
    );
    multi.update({ audioLabState: graphFor('output-primary', 'another-result') });
    assert.equal(multi.node.querySelectorAll('.generated-audio-lab-node').length, 0);
    multi.update({ audioLabState: graphFor('output-primary', 'audio-1') });
    assert.equal(multi.node.querySelectorAll('.generated-audio-lab-node').length, 2);
    multi.destroy();

    const flat = createGeneratedResults({
      results: [{ id: 'audio-1', name: 'flat.mp3', url: 'blob:caller-flat', duration: 12 }],
      audioLabState: graphFor('audio-1', null),
    });
    assert.equal(flat.node.querySelectorAll('.generated-audio-lab-node').length, 2);
    const flatAudio = flat.node.querySelector('audio');
    flat.update({
      results: [{ id: 'audio-1', outputId: 'output-rekeyed', name: 'flat.mp3', url: 'blob:caller-flat', duration: 12 }],
    });
    assert.equal(flat.node.querySelector('audio'), flatAudio);
    assert.equal(flat.node.querySelectorAll('.generated-audio-lab-node').length, 0);
    flat.destroy();
  } finally {
    restoreDocument();
  }
});
