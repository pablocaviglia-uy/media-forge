import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conversionControlModel,
  conversionCta,
  conversionSummary,
  deriveConversionIntent,
  effectiveConversionOptions,
  effectiveConversionOperation,
} from '../src/media/conversion-workspace.js';
import { buildPlan } from '../src/media/commands.js';

const video = {
  hasVideo: true,
  hasAudio: true,
  duration: 120,
  video: { width: 1920, height: 1080, fps: 29.97, codec: 'h264', rotation: 0 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
};

const audio = {
  hasVideo: false,
  hasAudio: true,
  duration: 90,
  audio: { codec: 'flac', channels: 2, sampleRate: 48_000 },
};

describe('conversion workspace intent and visible controls', () => {
  test('video to MP4 exposes only the simple video path initially', () => {
    const model = conversionControlModel({
      info: video,
      operation: 'convert',
      options: { format: 'mp4-h264', quality: 'balanced' },
    });
    assert.equal(model.intent, 'video');
    assert.deepEqual(model.primary, ['format', 'quality']);
    assert.deepEqual(model.duration, ['trim']);
    assert.deepEqual(model.advanced, ['resolution', 'fps', 'mute', 'audioBitrate', 'speed']);
    assert.equal(conversionCta(model), 'Convertir a MP4');
  });

  test('video to WAV/MP3 exposes no video, mute or bitrate controls for lossless output', () => {
    for (const format of ['wav', 'flac']) {
      const model = conversionControlModel({ info: video, operation: 'convert', options: { format } });
      assert.equal(model.intent, 'audio');
      assert.deepEqual(model.primary, ['format']);
      assert.deepEqual(model.advanced, format === 'flac' ? ['flacCompression'] : []);
      assert.ok(![...model.primary, ...model.advanced].some((id) => ['resolution', 'fps', 'quality', 'mute', 'audioBitrate'].includes(id)));
    }
    const mp3 = conversionControlModel({ info: video, operation: 'convert', options: { format: 'mp3' } });
    assert.deepEqual(mp3.primary, ['format', 'audioBitrate']);
    assert.equal(conversionCta(mp3), 'Extraer MP3');
  });

  test('GIF owns width, fluency, dither and trim only', () => {
    const model = conversionControlModel({ info: video, operation: 'gif', options: {} });
    assert.equal(model.intent, 'gif');
    assert.deepEqual(model.primary, ['gifWidth', 'gifFps']);
    assert.deepEqual(model.duration, ['trim']);
    assert.deepEqual(model.advanced, ['dither']);
  });

  test('an audio source remains an audio conversion even with a stale extract operation', () => {
    assert.equal(deriveConversionIntent(audio, 'extract-audio', { audioFormat: 'mp3' }), 'audio');
    const model = conversionControlModel({ info: audio, operation: 'extract-audio', options: { audioFormat: 'mp3' } });
    assert.equal(model.title, 'Convertir audio');
    assert.deepEqual(model.intents.map((item) => item.id), ['audio']);
  });

  test('an invalid restored audio target falls back to audio instead of showing a video format', () => {
    const model = conversionControlModel({
      info: audio,
      operation: 'extract-audio',
      options: { audioFormat: 'mp4-h264' },
    });
    const effective = effectiveConversionOptions({
      info: audio,
      operation: 'extract-audio',
      options: { audioFormat: 'mp4-h264' },
    });
    assert.equal(model.target.id, 'mp3');
    assert.equal(effective.audioFormat, 'mp3');
    assert.equal(conversionCta(model), 'Convertir a MP3');
  });

  test('compression is not offered when the source duration is unknown', () => {
    const model = conversionControlModel({
      info: { ...video, duration: null },
      operation: 'convert',
      options: { format: 'mp4-h264' },
    });
    assert.ok(!model.moreActions.some((item) => item.id === 'compress'));
    const restored = conversionControlModel({
      info: { ...video, duration: null },
      operation: 'compress',
      options: { format: 'mp4-h264' },
    });
    assert.equal(effectiveConversionOperation({ ...video, duration: null }, 'compress'), 'convert');
    assert.equal(restored.operation, 'convert');
    assert.equal(restored.intent, 'video');
    assert.equal(conversionCta(restored), 'Convertir a MP4');
  });

  test('resolution and frame-rate menus never promise upscaling', () => {
    const model = conversionControlModel({
      info: { ...video, video: { ...video.video, width: 320, height: 180, fps: 24 } },
      operation: 'convert',
      options: { format: 'mp4-h264' },
    });
    assert.deepEqual(model.resolutions.map((item) => item.id), ['source']);
    assert.deepEqual(model.frameRates.map((item) => item.id), ['source', '24', '15', '12']);
  });
});

describe('effective conversion options', () => {
  const contaminated = {
    format: 'mp3', audioFormat: 'mp3', audioBitrate: 128,
    resolution: '720', fps: '60', quality: 'high', speed: 'slow', mute: true,
    trimStart: 2, trimEnd: 8,
    rotate: 90, flip: 'horizontal',
    cropAspect: '1:1', cropX: 2, cropY: 2, cropWidth: 100, cropHeight: 100,
    volumeGain: 1.7, playbackRate: 0.5, loopMode: 'count', loopCount: 4,
    gifFps: 15, gifWidth: 640, dither: false,
    targetSize: 12, frameInterval: 3, imageFormat: 'jpeg', at: 7,
    rawArguments: '-i $in -c copy $out.mkv',
  };

  test('audio output neutralises every hidden video/effect option without mutating the draft', () => {
    const before = structuredClone(contaminated);
    const effective = effectiveConversionOptions({ info: video, operation: 'convert', options: contaminated });
    assert.equal(effective.format, 'mp3');
    assert.equal(effective.audioBitrate, 128);
    assert.equal(effective.trimStart, 2);
    assert.equal(effective.resolution, 'source');
    assert.equal(effective.fps, 'source');
    assert.equal(effective.mute, false);
    assert.equal(effective.rotate, 0);
    assert.equal(effective.cropWidth, null);
    assert.equal(effective.playbackRate, 1);
    assert.equal(effective.loopCount, 1);
    assert.deepEqual(contaminated, before);
    assert.ok(Object.isFrozen(effective));
  });

  test('GIF keeps its visible choices and drops stale transforms', () => {
    const effective = effectiveConversionOptions({ info: video, operation: 'gif', options: contaminated });
    assert.equal(effective.gifFps, 15);
    assert.equal(effective.gifWidth, 640);
    assert.equal(effective.dither, false);
    assert.equal(effective.trimStart, 2);
    assert.equal(effective.rotate, 0);
    assert.equal(effective.cropWidth, null);
    assert.equal(effective.mute, false);
  });

  test('special operations consume only controls they expose', () => {
    const compress = effectiveConversionOptions({ info: video, operation: 'compress', options: contaminated });
    assert.equal(compress.targetSize, 12);
    assert.equal(compress.resolution, '720');
    assert.equal(compress.mute, true);
    assert.equal(compress.fps, 'source');
    assert.equal(compress.speed, 'veryfast');
    assert.equal(compress.rotate, 0);

    const raw = effectiveConversionOptions({ info: video, operation: 'raw', options: contaminated });
    assert.equal(raw.rawArguments, contaminated.rawArguments);
    assert.equal(raw.trimStart, null);
    assert.equal(raw.trimEnd, null);
  });

  test('a restored upscale or invented frame rate is shown and run as original', () => {
    const small = { ...video, video: { ...video.video, width: 1280, height: 720, fps: 24 } };
    const draft = { format: 'mp4-h264', quality: 'balanced', resolution: '2160', fps: '60' };
    const model = conversionControlModel({ info: small, operation: 'convert', options: draft });
    const effective = effectiveConversionOptions({ info: small, operation: 'convert', options: draft });
    assert.ok(!model.resolutions.some((item) => item.id === '2160'));
    assert.ok(!model.frameRates.some((item) => item.id === '60'));
    assert.equal(effective.resolution, 'source');
    assert.equal(effective.fps, 'source');
    const command = buildPlan({ name: 'small.mp4', info: small }, 'convert', effective)
      .steps.flatMap((step) => step.args).join(' ');
    assert.doesNotMatch(command, /fps=60|scale=.*2160/);
  });

  test('summary says exactly what the simple screen will create', () => {
    const model = conversionControlModel({ info: video, operation: 'extract-audio', options: { audioFormat: 'mp3', audioBitrate: 192, trimStart: null, trimEnd: null } });
    assert.equal(conversionSummary(model, { audioBitrate: 192 }), 'MP3 · 192 kbps · Archivo completo');
  });

  test('the effective audio snapshot cannot leak hidden video transforms into FFmpeg', () => {
    const options = effectiveConversionOptions({ info: video, operation: 'convert', options: contaminated });
    const plan = buildPlan({ name: 'source.mp4', info: video }, 'convert', options);
    const command = plan.steps.flatMap((step) => step.args).join(' ');
    assert.match(command, /libmp3lame/);
    assert.doesNotMatch(command, /scale=|fps=|transpose=|crop=|setpts=|volume=/);
    assert.doesNotMatch(command, / -an(?: |$)/);
  });

  test('the effective GIF snapshot uses only its visible animation settings', () => {
    const options = effectiveConversionOptions({ info: video, operation: 'gif', options: contaminated });
    const plan = buildPlan({ name: 'source.mp4', info: video }, 'gif', options);
    const command = plan.steps.flatMap((step) => step.args).join(' ');
    assert.match(command, /fps=15/);
    assert.match(command, /scale=640:-1/);
    assert.doesNotMatch(command, /transpose=|crop=|setpts=|volume=/);
  });
});
