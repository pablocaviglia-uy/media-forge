import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';

const videoInfo = {
  hasVideo: true,
  hasAudio: true,
  duration: 12,
  format: 'mov',
  video: { codec: 'h264', width: 1280, height: 720, fps: 30, rotation: 0 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
};

function conversionApp() {
  const app = Object.create(App.prototype);
  Object.assign(app, {
    capabilities: null,
    marked: 0,
    painted: 0,
    markConversionEdited() { this.marked += 1; },
    paintDetail() { this.painted += 1; },
  });
  return app;
}

test('a generic queued snapshot freezes effective options and leaves the editable draft intact', () => {
  const app = conversionApp();
  const job = {
    operation: 'convert',
    info: videoInfo,
    options: {
      format: 'mp3', audioFormat: 'mp3', audioBitrate: 192,
      trimStart: 2, trimEnd: 8,
      resolution: '720', fps: '60', quality: 'high', mute: true,
      rotate: 90, cropWidth: 300, playbackRate: 0.5, loopCount: 4,
    },
  };
  const snapshot = app.createConversionSnapshot(job);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.options));
  assert.equal(snapshot.operation, 'convert');
  assert.equal(snapshot.options.format, 'mp3');
  assert.equal(snapshot.options.audioBitrate, 192);
  assert.equal(snapshot.options.trimStart, 2);
  assert.equal(snapshot.options.resolution, 'source');
  assert.equal(snapshot.options.fps, 'source');
  assert.equal(snapshot.options.mute, false);
  assert.equal(snapshot.options.rotate, 0);
  assert.equal(snapshot.options.cropWidth, null);
  assert.equal(snapshot.options.playbackRate, 1);
  assert.equal(job.options.rotate, 90);

  job.options.audioBitrate = 64;
  assert.equal(snapshot.options.audioBitrate, 192);
});

test('the result chooser changes one coherent intent instead of stacking operations', () => {
  const app = conversionApp();
  const job = {
    status: 'ready',
    operation: 'convert',
    info: videoInfo,
    options: { format: 'mp4-h264', audioFormat: 'flac' },
  };

  app.setConversionIntent(job, 'audio');
  assert.equal(job.operation, 'extract-audio');
  assert.equal(job.options.format, 'flac');
  assert.equal(job.options.audioFormat, 'flac');
  assert.deepEqual(job.pendingConversionFocus, { key: 'intent', value: 'audio' });

  app.setConversionIntent(job, 'video');
  assert.equal(job.operation, 'convert');
  assert.equal(job.options.format, 'mp4-h264');
  assert.equal(app.marked, 2);
  assert.equal(app.painted, 2);
});

test('audio-only input stays in the audio family and cannot select video-only tasks', () => {
  const app = conversionApp();
  const job = {
    status: 'ready',
    operation: 'extract-audio',
    info: {
      hasVideo: false,
      hasAudio: true,
      duration: 3,
      audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
    },
    options: { format: 'mp3', audioFormat: 'mp3' },
  };

  app.setConversionIntent(job, 'video');
  assert.equal(job.operation, 'extract-audio');
  app.setConversionOperation(job, 'compress');
  assert.equal(job.operation, 'extract-audio');
  assert.equal(app.marked, 0);
});

test('contextual sanitizing never erases a focused Quick transformation', () => {
  const app = conversionApp();
  const cases = [
    ['video-rotate', { rotate: 90 }],
    ['video-crop', { cropX: 20, cropY: 10, cropWidth: 640, cropHeight: 360 }],
    ['video-speed', { playbackRate: 2 }],
    ['video-volume', { volumeGain: 1.5 }],
    ['video-loop', { loopMode: 'count', loopCount: 3 }],
  ];

  for (const [forgeToolId, effect] of cases) {
    const job = {
      forgeToolId,
      status: 'ready',
      operation: 'convert',
      info: videoInfo,
      options: { format: 'mp4-h264', ...effect },
    };
    const snapshot = app.createConversionSnapshot(job);
    for (const [key, value] of Object.entries(effect)) assert.equal(snapshot.options[key], value);
    assert.ok(Object.isFrozen(snapshot.options));
  }
});

test('the visible target and queued snapshot share the first format this core supports', () => {
  const app = conversionApp();
  app.capabilities = {
    encoders: [
      { name: 'libx264', experimental: false },
      { name: 'aac', experimental: false },
      { name: 'libmp3lame', experimental: false },
    ],
    muxers: [{ name: 'mp4' }, { name: 'mp3' }],
  };
  const job = {
    status: 'ready',
    operation: 'convert',
    info: videoInfo,
    options: { format: 'webm-vp8', quality: 'balanced' },
  };
  assert.equal(app.conversionModel(job).target.id, 'mp4-h264');
  assert.equal(app.createConversionSnapshot(job).options.format, 'mp4-h264');
  assert.equal(job.options.format, 'webm-vp8', 'the saved draft is not mutated during render');
});

test('a stale impossible operation resolves identically in the UI and queued plan', () => {
  const app = conversionApp();
  const job = {
    status: 'ready',
    operation: 'extract-audio',
    info: { ...videoInfo, hasAudio: false, audio: null },
    options: { format: 'mp4-h264', audioFormat: 'mp3', quality: 'balanced' },
  };
  const model = app.conversionModel(job);
  const snapshot = app.createConversionSnapshot(job);
  assert.equal(model.operation, 'convert');
  assert.equal(model.intent, 'video');
  assert.equal(model.target.id, 'mp4-h264');
  assert.equal(snapshot.operation, 'convert');
  assert.equal(snapshot.options.format, 'mp4-h264');
});
