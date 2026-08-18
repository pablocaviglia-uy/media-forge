import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultResizeResolution,
  describeFocusedQuickTransformation,
  describeTrimRange,
  focusedQuickTool,
  normalizeFlip,
  normalizeFocusedQuickOptions,
  normalizeResolution,
  normalizeRotation,
  supportsFocusedQuickTool,
  trimRange,
  trimOptionsForRun,
  quickVideoFormat,
} from '../src/media/quick-tools.js';

test('focused video tools expose their Spanish execution contracts', () => {
  assert.deepEqual(focusedQuickTool('video-trim'), {
    id: 'video-trim',
    title: 'Cortar video',
    operation: 'convert',
    accept: 'video/*',
    focus: 'trim',
    defaultOptions: { trimStart: null, trimEnd: null },
  });
  assert.deepEqual(focusedQuickTool('video-rotate'), {
    id: 'video-rotate',
    title: 'Girar video',
    operation: 'convert',
    accept: 'video/*',
    focus: 'rotate',
    defaultOptions: { rotate: 90 },
  });
  assert.deepEqual(focusedQuickTool('video-flip'), {
    id: 'video-flip',
    title: 'Voltear video',
    operation: 'convert',
    accept: 'video/*',
    focus: 'flip',
    defaultOptions: { flip: 'horizontal' },
  });
  assert.deepEqual(focusedQuickTool('video-resize'), {
    id: 'video-resize',
    title: 'Redimensionar video',
    operation: 'convert',
    accept: 'video/*',
    focus: 'resize',
    defaultOptions: { resolution: '720' },
  });
  assert.equal(focusedQuickTool('audio-trim'), null);
  assert.equal(focusedQuickTool('missing-tool'), null);
});

test('every focused tool requires a probed video track', () => {
  for (const toolId of ['video-trim', 'video-rotate', 'video-flip', 'video-resize']) {
    assert.equal(supportsFocusedQuickTool(toolId, { hasVideo: true }), true);
    assert.equal(supportsFocusedQuickTool(toolId, { hasVideo: false }), false);
    assert.equal(supportsFocusedQuickTool(toolId, null), false);
  }
  assert.equal(supportsFocusedQuickTool('audio-trim', { hasVideo: true }), false);
});

test('focused transform values are reduced to options the engine understands', () => {
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(45), null);
  assert.equal(normalizeRotation(0), null);
  assert.equal(normalizeRotation('nonsense'), null);
  assert.equal(normalizeRotation(undefined), 90);

  assert.equal(normalizeFlip('vertical'), 'vertical');
  assert.equal(normalizeFlip('none'), null);
  assert.equal(normalizeFlip(undefined), 'horizontal');
  assert.equal(normalizeResolution(1080), '1080');
  assert.equal(normalizeResolution('240'), '240');
  assert.equal(normalizeResolution('source'), null);
  assert.equal(normalizeResolution('123'), null);
  assert.equal(normalizeResolution(undefined), '720');
});

test('resize defaults to the largest preset that really reduces the video', () => {
  const video = (height, width = 1920, rotation = 0) => ({
    hasVideo: true,
    video: { width, height, rotation },
  });
  assert.equal(defaultResizeResolution(video(2160)), '1440');
  assert.equal(defaultResizeResolution(video(1080)), '720');
  assert.equal(defaultResizeResolution(video(360)), '240');
  assert.equal(defaultResizeResolution(video(240)), null);
  assert.equal(defaultResizeResolution(null), null);

  assert.deepEqual(normalizeFocusedQuickOptions('video-resize', {}, video(2160)), {
    resolution: '1440',
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-resize', {}, video(1080)), {
    resolution: '720',
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-resize', {}, video(360)), {
    resolution: '240',
    evenDimensions: true,
  });
  assert.equal(normalizeFocusedQuickOptions('video-resize', {}, video(240)), null);
  assert.equal(normalizeFocusedQuickOptions('video-resize', { resolution: '1080' }, video(720)), null);
});

test('resize uses visible dimensions after orientation metadata', () => {
  const rotated = (rotation) => ({
    hasVideo: true,
    video: { width: 1920, height: 1080, rotation },
  });
  assert.equal(defaultResizeResolution(rotated(90)), '1440');
  assert.equal(defaultResizeResolution(rotated(270)), '1440');
  assert.equal(defaultResizeResolution(rotated(-90)), '1440');
  assert.equal(defaultResizeResolution(rotated(0)), '720');

  assert.equal(normalizeResolution('1440', rotated(90)), '1440');
  assert.equal(normalizeResolution('1440', rotated(0)), null);
});

test('focused options contain only the transformation owned by that tool', () => {
  const stale = { rotate: 180, flip: 'vertical', resolution: '1080', quality: 'high' };
  assert.deepEqual(normalizeFocusedQuickOptions('video-rotate', stale), {
    rotate: 180,
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-flip', stale), {
    flip: 'vertical',
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-resize', stale), {
    resolution: '1080',
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-trim', {
    trimStart: -5,
    trimEnd: 80,
  }, { duration: 60 }), {
    trimStart: null,
    trimEnd: null,
    evenDimensions: true,
  });
  assert.equal(normalizeFocusedQuickOptions('missing-tool', stale), null);
});

test('focused transformations have concise Spanish summaries', () => {
  assert.equal(describeFocusedQuickTransformation('video-rotate', { rotate: 90 }), 'Giro de 90° a la derecha');
  assert.equal(describeFocusedQuickTransformation('video-rotate', { rotate: 270 }), 'Giro de 90° a la izquierda');
  assert.equal(describeFocusedQuickTransformation('video-rotate', { rotate: 180 }), 'Giro de 180°');
  assert.equal(describeFocusedQuickTransformation('video-flip', { flip: 'horizontal' }), 'Espejo horizontal');
  assert.equal(describeFocusedQuickTransformation('video-flip', { flip: 'vertical' }), 'Espejo vertical');
  assert.equal(
    describeFocusedQuickTransformation('video-resize', {}, { hasVideo: true, video: { height: 1080 } }),
    'Salida de hasta 720p',
  );
  assert.equal(
    describeFocusedQuickTransformation('video-resize', {}, { hasVideo: true, video: { height: 240 } }),
    null,
  );
  assert.equal(
    describeFocusedQuickTransformation('video-trim', { trimStart: 2, trimEnd: 8 }, { duration: 10 }),
    'Recorte: 00:00:02.000 → 00:00:08.000 · 0:06',
  );
  assert.equal(describeFocusedQuickTransformation('missing-tool', {}), null);
});

test('no-op rotate and flip choices are invalid focused executions', () => {
  assert.equal(normalizeFocusedQuickOptions('video-rotate', { rotate: 0 }), null);
  assert.equal(normalizeFocusedQuickOptions('video-flip', { flip: 'none' }), null);
  assert.equal(describeFocusedQuickTransformation('video-rotate', { rotate: 0 }), null);
  assert.equal(describeFocusedQuickTransformation('video-flip', { flip: 'none' }), null);
});

test('a trim defaults to the whole known source', () => {
  assert.deepEqual(trimRange({ duration: 83.45 }, {}), {
    from: 0,
    to: 83.45,
    duration: 83.45,
  });
});

test('trim options are clamped to the source and cannot invert', () => {
  assert.deepEqual(trimRange({ duration: 60 }, { trimStart: -4, trimEnd: 80 }), {
    from: 0,
    to: 60,
    duration: 60,
  });
  assert.deepEqual(trimRange({ duration: 60 }, { trimStart: 25, trimEnd: 10 }), {
    from: 25,
    to: 25,
    duration: 0,
  });
  assert.deepEqual(trimRange({ duration: 60 }, { trimStart: 90 }), {
    from: 60,
    to: 60,
    duration: 0,
  });
});

test('timeline aliases produce the same normalised range', () => {
  assert.deepEqual(
    trimRange({ duration: 120 }, { from: 10.5, to: 25.75 }),
    trimRange({ duration: 120 }, { trimStart: 10.5, trimEnd: 25.75 }),
  );
});

test('unknown source durations keep an open end honest', () => {
  assert.deepEqual(trimRange({ duration: null }, { trimStart: 12 }), {
    from: 12,
    to: null,
    duration: null,
  });
  assert.deepEqual(trimRange({}, { trimStart: 12, trimEnd: 20 }), {
    from: 12,
    to: 20,
    duration: 8,
  });
  assert.deepEqual(trimRange({}, { trimStart: 12, trimEnd: 5 }), {
    from: 12,
    to: 12,
    duration: 0,
  });
});

test('invalid numeric metadata and options do not leak NaN or infinity', () => {
  assert.deepEqual(trimRange({ duration: -1 }, { trimStart: NaN, trimEnd: Infinity }), {
    from: 0,
    to: null,
    duration: null,
  });
});

test('descriptions use precise timestamps and omit unknowable values', () => {
  assert.deepEqual(describeTrimRange({ duration: 90 }, { trimStart: 1.25, trimEnd: 61.5 }), {
    from: '00:00:01.250',
    to: '00:01:01.500',
    duration: '1:00',
  });
  assert.deepEqual(describeTrimRange({ duration: null }, { trimStart: 10 }), {
    from: '00:00:10.000',
    to: null,
    duration: null,
  });
});

test('run options use the same normalised range and reject empty selections', () => {
  assert.deepEqual(trimOptionsForRun({ duration: 60 }, { trimStart: -4, trimEnd: 80 }), {
    trimStart: null,
    trimEnd: null,
    evenDimensions: true,
  });
  assert.deepEqual(trimOptionsForRun({ duration: 60 }, { trimStart: 5, trimEnd: 12 }), {
    trimStart: 5,
    trimEnd: 12,
    evenDimensions: true,
  });
  assert.equal(trimOptionsForRun({ duration: 60 }, { trimStart: 25, trimEnd: 10 }), null);
  assert.equal(trimOptionsForRun({}, { trimStart: 10 }), null);
});

test('video quick tools cannot inherit an audio or image output preset', () => {
  assert.equal(quickVideoFormat('mov-h264'), 'mov-h264');
  assert.equal(quickVideoFormat('mp3'), 'mp4-h264');
  assert.equal(quickVideoFormat('gif'), 'mp4-h264');
  assert.equal(quickVideoFormat('missing'), 'mp4-h264');
});
