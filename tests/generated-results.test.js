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
    this.pauseCount = 0;
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

  pause() { this.pauseCount += 1; }
  load() { this.loadCount += 1; }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const data = selector.match(/^\[data-([a-z-]+)="([^"]+)"\]$/);
    if (data) {
      const key = data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] === data[2];
    }
    return this.tagName === selector.toUpperCase();
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
