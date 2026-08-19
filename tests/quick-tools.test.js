import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CROP_ASPECT_PRESETS,
  LOOP_COUNT_PRESETS,
  PLAYBACK_RATE_LIMITS,
  PLAYBACK_RATE_PRESETS,
  QUICK_EFFECT_PREFLIGHT_LIMITS,
  VIDEO_LOOP_LIMITS,
  VOLUME_GAIN_LIMITS,
  VOLUME_GAIN_PRESETS,
  cropRectForAspect,
  defaultVideoLoopOptions,
  defaultResizeResolution,
  describeFocusedQuickTransformation,
  describeTrimRange,
  focusedQuickExpansion,
  focusedQuickOutputDuration,
  focusedQuickPreflight,
  focusedQuickTool,
  fullCropRect,
  loopOutputDuration,
  maxLoopCountFor,
  normalizeCropAspect,
  normalizeCropRect,
  normalizeFlip,
  normalizeFocusedQuickOptions,
  normalizePlaybackRate,
  normalizeResolution,
  normalizeRotation,
  normalizeVideoLoopOptions,
  normalizeVolumeGain,
  playableMediaDuration,
  supportsFocusedQuickTool,
  trimRange,
  trimOptionsForRun,
  quickVideoFormat,
  visibleVideoDimensions,
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
  assert.deepEqual(focusedQuickTool('video-crop'), {
    id: 'video-crop',
    title: 'Recortar encuadre',
    operation: 'convert',
    accept: 'video/*',
    focus: 'crop',
    defaultOptions: {
      cropAspect: 'free',
      cropX: null,
      cropY: null,
      cropWidth: null,
      cropHeight: null,
    },
  });
  assert.deepEqual(focusedQuickTool('video-volume'), {
    id: 'video-volume',
    title: 'Cambiar volumen',
    operation: 'convert',
    accept: 'video/*',
    focus: 'volume',
    defaultOptions: { volumeGain: 1.5, mute: false },
  });
  assert.deepEqual(focusedQuickTool('video-speed'), {
    id: 'video-speed',
    title: 'Cambiar velocidad',
    operation: 'convert',
    accept: 'video/*',
    focus: 'speed',
    defaultOptions: { playbackRate: 1.5 },
  });
  assert.deepEqual(focusedQuickTool('video-loop'), {
    id: 'video-loop',
    title: 'Repetir video',
    operation: 'convert',
    accept: 'video/*',
    focus: 'loop',
    defaultOptions: { loopMode: 'count', loopCount: 2, loopDuration: null },
  });
  assert.equal(focusedQuickTool('audio-trim'), null);
  assert.equal(focusedQuickTool('missing-tool'), null);
});

test('every focused tool requires a probed video track', () => {
  for (const toolId of ['video-trim', 'video-rotate', 'video-flip', 'video-resize', 'video-crop', 'video-speed']) {
    assert.equal(supportsFocusedQuickTool(toolId, { hasVideo: true }), true);
    assert.equal(supportsFocusedQuickTool(toolId, { hasVideo: false }), false);
    assert.equal(supportsFocusedQuickTool(toolId, null), false);
  }
  assert.equal(supportsFocusedQuickTool('video-volume', { hasVideo: true, hasAudio: true }), true);
  assert.equal(supportsFocusedQuickTool('video-volume', { hasVideo: true, hasAudio: false }), false);
  assert.equal(supportsFocusedQuickTool('video-loop', { hasVideo: true, duration: 4 }), true);
  assert.equal(supportsFocusedQuickTool('video-loop', {
    hasVideo: true,
    duration: null,
    video: { duration: 4 },
  }), true, 'a measured stream duration is sufficient even when the container clock is missing');
  assert.equal(supportsFocusedQuickTool('video-loop', { hasVideo: true, duration: null }), false);
  assert.equal(supportsFocusedQuickTool('video-loop', { hasVideo: true, duration: 0 }), false);
  assert.equal(supportsFocusedQuickTool('audio-trim', { hasVideo: true }), false);
});

test('effect presets expose the same bounded choices their normalizers accept', () => {
  assert.deepEqual(VOLUME_GAIN_LIMITS, { min: 0, max: 2, default: 1.5 });
  assert.deepEqual(VOLUME_GAIN_PRESETS.map(({ value }) => value), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(PLAYBACK_RATE_LIMITS, { min: 0.25, max: 4, default: 1.5 });
  assert.deepEqual(
    PLAYBACK_RATE_PRESETS.map(({ value }) => value),
    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4],
  );
  assert.deepEqual(VIDEO_LOOP_LIMITS, { minCount: 2, maxCount: 20, maxDuration: 1800 });
  assert.deepEqual(LOOP_COUNT_PRESETS, [2, 3, 4, 5, 10, 20]);
});

test('volume is strict, keeps explicit mute, and never invites gain beyond 200%', () => {
  assert.equal(normalizeVolumeGain(undefined), 1.5);
  assert.equal(normalizeVolumeGain('0.75'), 0.75);
  assert.equal(normalizeVolumeGain(0), 0);
  assert.equal(normalizeVolumeGain(2), 2);
  assert.equal(normalizeVolumeGain(-0.01), null);
  assert.equal(normalizeVolumeGain(2.01), null);
  assert.equal(normalizeVolumeGain(2.0000001), null);
  assert.equal(normalizeVolumeGain('loud'), null);

  const audioVideo = { hasVideo: true, hasAudio: true, duration: 10 };
  assert.deepEqual(normalizeFocusedQuickOptions('video-volume', {}, audioVideo), {
    volumeGain: 1.5,
    mute: false,
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-volume', {
    volumeGain: 99,
    mute: true,
  }, audioVideo), {
    volumeGain: 1.5,
    mute: true,
    evenDimensions: true,
  });
  assert.deepEqual(normalizeFocusedQuickOptions('video-volume', {
    volumeGain: 0,
    mute: false,
  }, audioVideo), {
    volumeGain: 0,
    mute: false,
    evenDimensions: true,
  });
  assert.equal(normalizeFocusedQuickOptions('video-volume', { volumeGain: 1 }, audioVideo), null);
  assert.equal(normalizeFocusedQuickOptions('video-volume', {}, { hasVideo: true, hasAudio: false }), null);
});

test('playback speed spans 0.25x through 4x and treats 1x as a no-op', () => {
  assert.equal(normalizePlaybackRate(undefined), 1.5);
  assert.equal(normalizePlaybackRate('0.25'), 0.25);
  assert.equal(normalizePlaybackRate(4), 4);
  assert.equal(normalizePlaybackRate(0.249), null);
  assert.equal(normalizePlaybackRate(0.2499999), null);
  assert.equal(normalizePlaybackRate(4.001), null);
  assert.equal(normalizePlaybackRate(Infinity), null);
  assert.deepEqual(normalizeFocusedQuickOptions('video-speed', {}, { duration: 120 }), {
    playbackRate: 1.5,
    evenDimensions: true,
  });
  assert.equal(normalizeFocusedQuickOptions('video-speed', { playbackRate: 1 }, { duration: 120 }), null);
  assert.equal(focusedQuickOutputDuration('video-speed', { playbackRate: 1.5 }, { duration: 120 }), 80);
  assert.equal(focusedQuickOutputDuration('video-speed', { playbackRate: 0.25 }, { duration: 120 }), 480);
});

test('effect expansion preflight reports absolute and relative duration costs', () => {
  assert.deepEqual(focusedQuickExpansion('video-speed', { playbackRate: 0.25 }, { duration: 120 }), {
    sourceDuration: 120,
    outputDuration: 480,
    durationDelta: 360,
    factor: 4,
    expands: true,
  });
  assert.deepEqual(focusedQuickExpansion('video-loop', {
    loopMode: 'count', loopCount: 3,
  }, { duration: 90 }), {
    sourceDuration: 90,
    outputDuration: 270,
    durationDelta: 180,
    factor: 3,
    expands: true,
  });
  assert.deepEqual(focusedQuickExpansion('video-volume', { volumeGain: 1.5 }, {
    hasAudio: true, duration: 10,
  }), {
    sourceDuration: 10,
    outputDuration: 10,
    durationDelta: 0,
    factor: 1,
    expands: false,
  });
  assert.equal(focusedQuickExpansion('video-speed', { playbackRate: 1 }, { duration: 10 }), null);
  assert.equal(focusedQuickExpansion('video-loop', {}, { duration: null }), null);
});

test('focused effect preflight shares a conservative 500 MiB MEMFS budget', () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(QUICK_EFFECT_PREFLIGHT_LIMITS, {
    maxOutputDuration: 1800,
    maxMemfsBytes: 500 * MiB,
  });

  assert.deepEqual(
    focusedQuickPreflight(
      'video-volume',
      { volumeGain: 1.5 },
      { hasVideo: true, hasAudio: true, duration: 120 },
      250 * MiB,
    ),
    {
      ok: true,
      code: 'ok',
      message: null,
      sourceDuration: 120,
      outputDuration: 120,
      factor: 1,
      inputBytes: 250 * MiB,
      estimatedOutputBytes: 250 * MiB,
      estimatedMemfsBytes: 500 * MiB,
      limits: QUICK_EFFECT_PREFLIGHT_LIMITS,
    },
  );

  const tooLarge = focusedQuickPreflight(
    'video-loop',
    { loopMode: 'count', loopCount: 3 },
    { hasVideo: true, duration: 10 },
    126 * MiB,
  );
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'memory-limit');
  assert.equal(tooLarge.factor, 3);
  assert.equal(tooLarge.estimatedOutputBytes, 378 * MiB);
  assert.equal(tooLarge.estimatedMemfsBytes, 504 * MiB);
  assert.match(tooLarge.message, /504 MB/);
  assert.match(tooLarge.message, /500 MB/);
});

test('focused effect preflight blocks overlong expansion and unknown slow output', () => {
  const MiB = 1024 * 1024;
  const overlong = focusedQuickPreflight(
    'video-speed',
    { playbackRate: 0.25 },
    { hasVideo: true, duration: 600 },
    MiB,
  );
  assert.equal(overlong.ok, false);
  assert.equal(overlong.code, 'duration-limit');
  assert.equal(overlong.outputDuration, 2400);
  assert.match(overlong.message, /40:00/);
  assert.match(overlong.message, /30:00/);

  const unknown = focusedQuickPreflight(
    'video-speed',
    { playbackRate: 0.5 },
    { hasVideo: true, duration: null },
    MiB,
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown-duration');
  assert.equal(unknown.factor, 2);
  assert.match(unknown.message, /duración final/);
});

test('faster playback still reserves at least one input-sized result', () => {
  const MiB = 1024 * 1024;
  const safe = focusedQuickPreflight(
    'video-speed',
    { playbackRate: 4 },
    { hasVideo: true, duration: 120 },
    250 * MiB,
  );
  assert.equal(safe.ok, true);
  assert.equal(safe.factor, 0.25);
  assert.equal(safe.outputDuration, 30);
  assert.equal(safe.estimatedOutputBytes, 250 * MiB);
  assert.equal(safe.estimatedMemfsBytes, 500 * MiB);

  const invalidSize = focusedQuickPreflight(
    'video-volume',
    { mute: true },
    { hasVideo: true, hasAudio: true, duration: 10 },
  );
  assert.equal(invalidSize.ok, false);
  assert.equal(invalidSize.code, 'invalid-input-size');
  assert.match(invalidSize.message, /espacio necesario/);

  const invalidEffect = focusedQuickPreflight(
    'video-speed',
    { playbackRate: 1 },
    { hasVideo: true, duration: 10 },
    MiB,
  );
  assert.equal(invalidEffect.ok, false);
  assert.equal(invalidEffect.code, 'invalid-effect');
});

test('effect duration prefers playable stream length over an offset container clock', () => {
  const offset = {
    duration: 8.023,
    startTime: 5,
    video: { duration: 3 },
    audio: { duration: 3.023 },
  };
  assert.equal(playableMediaDuration(offset), 3.023);
  assert.equal(focusedQuickOutputDuration('video-speed', { playbackRate: 2 }, offset), 1.5115);
  assert.deepEqual(defaultVideoLoopOptions(offset), {
    loopMode: 'count', loopCount: 2, loopDuration: null,
  });
  assert.equal(focusedQuickOutputDuration('video-loop', {
    loopMode: 'count', loopCount: 2,
  }, offset), 6.046);
  const delayedAudio = {
    ...offset,
    video: { ...offset.video, startTime: 5 },
    audio: { ...offset.audio, startTime: 6 },
  };
  assert.equal(playableMediaDuration(delayedAudio), 4.023);
  assert.equal(focusedQuickOutputDuration('video-speed', { playbackRate: 2 }, delayedAudio), 2.0115);
  const partial = {
    duration: 1900,
    startTime: 0,
    hasVideo: true,
    hasAudio: true,
    video: { duration: 100, startTime: 0 },
    audio: { duration: null, startTime: 0 },
  };
  assert.equal(playableMediaDuration(partial), 1900, 'an unknown selected track falls back to the container');
  assert.equal(playableMediaDuration({ ...partial, duration: null }), null);
  assert.equal(
    focusedQuickPreflight('video-speed', { playbackRate: 0.25 }, partial, 1024 * 1024).code,
    'duration-limit',
  );
  assert.equal(normalizeVideoLoopOptions(partial, { loopMode: 'count', loopCount: 2 }), null);
  assert.equal(playableMediaDuration({ duration: 8, video: { duration: null } }), 8);
  assert.equal(playableMediaDuration({ duration: null }), null);
});

test('loop defaults stay runnable and every result is capped at 30 minutes', () => {
  assert.deepEqual(defaultVideoLoopOptions({ duration: 120 }), {
    loopMode: 'count', loopCount: 2, loopDuration: null,
  });
  assert.deepEqual(defaultVideoLoopOptions({ duration: 1200 }), {
    loopMode: 'duration', loopCount: null, loopDuration: 1800,
  });
  assert.equal(defaultVideoLoopOptions({ duration: 1800 }), null);
  assert.equal(defaultVideoLoopOptions({ duration: null }), null);
  assert.equal(maxLoopCountFor({ duration: 90 }), 20);
  assert.equal(maxLoopCountFor({ duration: 600 }), 3);
  assert.equal(maxLoopCountFor({ duration: 901 }), 1);

  assert.deepEqual(normalizeVideoLoopOptions({ duration: 90 }, {}), {
    loopMode: 'count', loopCount: 2, loopDuration: null,
  });
  assert.deepEqual(normalizeVideoLoopOptions({ duration: 90 }, {
    loopMode: 'count', loopCount: '20',
  }), {
    loopMode: 'count', loopCount: 20, loopDuration: null,
  });
  assert.equal(normalizeVideoLoopOptions({ duration: 91 }, { loopMode: 'count', loopCount: 20 }), null);
  assert.equal(normalizeVideoLoopOptions({ duration: 10 }, { loopMode: 'count', loopCount: 2.5 }), null);
  assert.equal(normalizeVideoLoopOptions({ duration: 10 }, { loopMode: 'count', loopCount: 21 }), null);
  assert.deepEqual(normalizeVideoLoopOptions({ duration: 1200 }, {
    loopMode: 'duration', loopDuration: '1500',
  }), {
    loopMode: 'duration', loopCount: null, loopDuration: 1500,
  });
  assert.equal(normalizeVideoLoopOptions({ duration: 1200 }, { loopMode: 'duration', loopDuration: 1200 }), null);
  assert.equal(normalizeVideoLoopOptions({ duration: 1200 }, { loopMode: 'duration', loopDuration: 1801 }), null);
  assert.equal(loopOutputDuration({ duration: 90 }, { loopMode: 'count', loopCount: 3 }), 270);
  assert.equal(loopOutputDuration({ duration: 90 }, { loopMode: 'duration', loopDuration: 200 }), 200);
  assert.equal(focusedQuickOutputDuration('video-loop', {}, { duration: 120 }), 240);
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

test('crop exposes a small stable set of aspect presets', () => {
  assert.deepEqual(CROP_ASPECT_PRESETS.map(({ id, label }) => ({ id, label })), [
    { id: 'free', label: 'Libre' },
    { id: '1:1', label: '1:1' },
    { id: '16:9', label: '16:9' },
    { id: '9:16', label: '9:16' },
    { id: '4:5', label: '4:5' },
  ]);
  assert.equal(normalizeCropAspect(undefined), 'free');
  assert.equal(normalizeCropAspect('9:16'), '9:16');
  assert.equal(normalizeCropAspect('3:2'), null);
});

test('crop geometry uses the auto-oriented dimensions people see', () => {
  const video = (rotation = 0) => ({
    hasVideo: true,
    video: { width: 1920, height: 1080, rotation },
  });
  assert.deepEqual(visibleVideoDimensions(video()), { width: 1920, height: 1080 });
  assert.deepEqual(visibleVideoDimensions(video(90)), { width: 1080, height: 1920 });
  assert.deepEqual(visibleVideoDimensions(video(-90)), { width: 1080, height: 1920 });
  assert.deepEqual(fullCropRect(video(270)), {
    cropX: 0,
    cropY: 0,
    cropWidth: 1080,
    cropHeight: 1920,
  });
  assert.equal(visibleVideoDimensions({ video: { width: null, height: 1080 } }), null);
  assert.equal(fullCropRect(null), null);
});

test('aspect helpers return the largest safe even rectangles centred in the frame', () => {
  const info = { hasVideo: true, video: { width: 1920, height: 1080 } };
  assert.deepEqual(cropRectForAspect(info, 'free'), fullCropRect(info));
  assert.deepEqual(cropRectForAspect(info, '1:1'), {
    cropX: 420,
    cropY: 0,
    cropWidth: 1080,
    cropHeight: 1080,
  });
  assert.deepEqual(cropRectForAspect(info, '16:9'), fullCropRect(info));
  assert.deepEqual(cropRectForAspect(info, '9:16'), {
    cropX: 656,
    cropY: 0,
    cropWidth: 608,
    cropHeight: 1080,
  });
  assert.deepEqual(cropRectForAspect(info, '4:5'), {
    cropX: 528,
    cropY: 0,
    cropWidth: 864,
    cropHeight: 1080,
  });
  assert.deepEqual(cropRectForAspect(info, 2), {
    cropX: 0,
    cropY: 60,
    cropWidth: 1920,
    cropHeight: 960,
  });
  assert.equal(cropRectForAspect(info, 'not-a-ratio'), null);
});

test('changing crop ratio preserves the current centre as far as the frame allows', () => {
  const info = { hasVideo: true, video: { width: 1920, height: 1080 } };
  assert.deepEqual(cropRectForAspect(info, '1:1', {
    cropX: 1200,
    cropY: 100,
    cropWidth: 600,
    cropHeight: 600,
  }), {
    cropX: 840,
    cropY: 0,
    cropWidth: 1080,
    cropHeight: 1080,
  });
  assert.deepEqual(cropRectForAspect(info, 'free', {
    cropX: 101,
    cropY: 51,
    cropWidth: 799,
    cropHeight: 601,
  }), {
    cropX: 100,
    cropY: 50,
    cropWidth: 798,
    cropHeight: 600,
  });
});

test('crop normalisation clamps, rounds and rejects full-frame no-ops', () => {
  const info = { hasVideo: true, video: { width: 1920, height: 1080 } };
  assert.equal(normalizeCropRect(info, {}), null);
  assert.equal(normalizeCropRect(info, fullCropRect(info)), null);
  assert.deepEqual(normalizeCropRect(info, { cropAspect: '1:1' }), {
    cropX: 420,
    cropY: 0,
    cropWidth: 1080,
    cropHeight: 1080,
  });
  assert.deepEqual(normalizeCropRect(info, {
    cropX: 101,
    cropY: -5,
    cropWidth: 999,
    cropHeight: 2000,
  }), {
    cropX: 100,
    cropY: 0,
    cropWidth: 998,
    cropHeight: 1080,
  });
  assert.deepEqual(normalizeCropRect(info, { x: 10, y: 20, width: 400, height: 300 }), {
    cropX: 10,
    cropY: 20,
    cropWidth: 400,
    cropHeight: 300,
  });
  assert.deepEqual(normalizeCropRect(info, { cropX: 1919, cropY: 1079 }), {
    cropX: 1918,
    cropY: 1078,
    cropWidth: 2,
    cropHeight: 2,
  });
  assert.equal(normalizeCropRect(info, { cropWidth: 0, cropHeight: 200 }), null);
  assert.equal(normalizeCropRect(info, { cropAspect: '3:2' }), null);
  assert.equal(normalizeCropRect(null, { cropWidth: 400, cropHeight: 300 }), null);
});

test('an odd full frame stays a no-op instead of losing its last row and column', () => {
  const info = { hasVideo: true, video: { width: 1919, height: 1079 } };
  assert.equal(normalizeCropRect(info, fullCropRect(info)), null);
  assert.deepEqual(normalizeCropRect(info, { cropX: 2, cropY: 2 }), {
    cropX: 2,
    cropY: 2,
    cropWidth: 1916,
    cropHeight: 1076,
  });
});

test('focused options contain only the transformation owned by that tool', () => {
  const stale = {
    rotate: 180,
    flip: 'vertical',
    resolution: '1080',
    quality: 'high',
    cropX: 100,
    cropY: 50,
    cropWidth: 800,
    cropHeight: 600,
  };
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
  assert.deepEqual(normalizeFocusedQuickOptions('video-crop', stale, {
    hasVideo: true,
    video: { width: 1920, height: 1080 },
  }), {
    cropX: 100,
    cropY: 50,
    cropWidth: 800,
    cropHeight: 600,
    evenDimensions: true,
  });
  assert.equal(normalizeFocusedQuickOptions('video-crop', {}, {
    hasVideo: true,
    video: { width: 1920, height: 1080 },
  }), null);
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
  assert.equal(
    describeFocusedQuickTransformation('video-crop', {
      cropX: 420,
      cropY: 0,
      cropWidth: 1080,
      cropHeight: 1080,
    }, { hasVideo: true, video: { width: 1920, height: 1080 } }),
    'Encuadre: 1080 × 1080 px · x 420, y 0',
  );
  assert.equal(
    describeFocusedQuickTransformation('video-crop', {}, {
      hasVideo: true,
      video: { width: 1920, height: 1080 },
    }),
    null,
  );
  assert.equal(
    describeFocusedQuickTransformation('video-volume', { volumeGain: 1.5 }, {
      hasVideo: true, hasAudio: true, duration: 120,
    }),
    'Volumen: 150%',
  );
  assert.equal(
    describeFocusedQuickTransformation('video-volume', { mute: true, volumeGain: 1.5 }, {
      hasVideo: true, hasAudio: true, duration: 120,
    }),
    'Audio eliminado',
  );
  assert.equal(
    describeFocusedQuickTransformation('video-speed', { playbackRate: 1.5 }, { duration: 120 }),
    'Velocidad: 1,5× · salida 1:20',
  );
  assert.equal(
    describeFocusedQuickTransformation('video-loop', {
      loopMode: 'count', loopCount: 2,
    }, { duration: 120 }),
    'Repetición: 2 reproducciones · salida 4:00',
  );
  assert.equal(
    describeFocusedQuickTransformation('video-loop', {
      loopMode: 'duration', loopDuration: 300,
    }, { duration: 120 }),
    'Repetición: hasta 5:00 · salida 5:00',
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
