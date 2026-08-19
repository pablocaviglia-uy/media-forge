import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADD_AUDIO_DEFAULTS,
  ADD_AUDIO_LIMITS,
  ADD_AUDIO_OPERATION,
  ADD_AUDIO_TOOL_ID,
  addAudioEstimatedWorkingBytes,
  addAudioHasUnexportedChanges,
  addAudioPlacement,
  addAudioPreflight,
  addAudioProjectSource,
  addAudioTotalBytes,
  addAudioVideoTimelineStart,
  createAddAudioAsset,
  createAddAudioEditState,
  createAddAudioProject,
  createAddAudioSnapshot,
  markAddAudioEdited,
  markAddAudioExported,
  normalizeAddAudioOptions,
  setAddAudioAsset,
  validateAddAudioProject,
} from '../src/media/add-audio.js';

const MiB = 1024 * 1024;
const file = (name, size = 1024) => ({ name, size });

const VIDEO_INFO = {
  duration: 3.02,
  bitrate: 800_000,
  startTime: 0,
  hasVideo: true,
  hasAudio: true,
  video: { kind: 'video', duration: 3, startTime: 0, width: 320, height: 241, fps: 30, codec: 'h264' },
  audio: { kind: 'audio', duration: 3.02, startTime: 0, sampleRate: 44_100, channels: 1, codec: 'aac' },
  streams: [],
};

const SILENT_VIDEO_INFO = {
  ...VIDEO_INFO,
  duration: 3,
  hasAudio: false,
  audio: null,
};

const AUDIO_INFO = {
  duration: 1,
  bitrate: 128_000,
  startTime: 0,
  hasVideo: false,
  hasAudio: true,
  video: null,
  audio: { kind: 'audio', duration: 1, startTime: 0, sampleRate: 32_000, channels: 1, codec: 'mp3' },
  streams: [],
};

const readyAsset = (name, role, info, size = 1024) => ({
  ...createAddAudioAsset(file(name, size), role, `${role}-asset`),
  info,
  status: 'ready',
});

const readyProject = (options = {}, sizes = {}) => ({
  video: readyAsset('holiday.mp4', 'video', VIDEO_INFO, sizes.video ?? 10 * MiB),
  audio: readyAsset('song.mp3', 'audio', AUDIO_INFO, sizes.audio ?? 1 * MiB),
  options,
  ...createAddAudioEditState(),
});

test('the add-audio foundation publishes stable ids, defaults and memory limits', () => {
  assert.equal(ADD_AUDIO_TOOL_ID, 'video-add-audio');
  assert.equal(ADD_AUDIO_OPERATION, 'add-audio-to-video');
  assert.deepEqual(ADD_AUDIO_DEFAULTS, {
    mixMode: 'mix',
    originalGain: 1,
    addedGain: 0.35,
    audioOffset: 0,
    audioFit: 'once',
    limiter: true,
    quality: 'balanced',
    speed: 'veryfast',
    audioBitrate: 192,
  });
  assert.equal(ADD_AUDIO_LIMITS.maxInputBytes, 350 * MiB);
  assert.equal(ADD_AUDIO_LIMITS.maxWorkingBytes, 500 * MiB);
  assert.equal(ADD_AUDIO_LIMITS.minGain, 0);
  assert.equal(ADD_AUDIO_LIMITS.maxGain, 2);
});

test('assets carry an explicit role and projects start with revision state', () => {
  const project = createAddAudioProject(file('clip.mov'));
  assert.equal(project.video.role, 'video');
  assert.equal(project.video.status, 'pending');
  assert.equal(project.audio, null);
  assert.deepEqual(project.options, {});
  assert.equal(project.revision, 0);
  assert.equal(project.dirtySinceOutput, false);

  assert.throws(() => createAddAudioAsset(file('x.bin'), 'other'), /video or audio role/);
  assert.throws(() => createAddAudioAsset(file('', 1), 'audio'), /file name/);
  assert.throws(() => createAddAudioAsset(file('x.mp3', -1), 'audio'), /file size/);
});

test('replacing a role is pure, typed and marks an exported project dirty', () => {
  const initial = { ...createAddAudioProject(file('clip.mp4')), ...markAddAudioExported(createAddAudioEditState()) };
  const next = setAddAudioAsset(initial, 'audio', file('song.wav'));

  assert.equal(initial.audio, null);
  assert.equal(next.audio.role, 'audio');
  assert.equal(next.revision, 1);
  assert.equal(next.dirtySinceOutput, true);
  assert.throws(() => setAddAudioAsset(next, 'audio', next.video), /Cannot use a video asset as audio/);
  assert.throws(() => setAddAudioAsset(next, 'video', null), /cannot be removed/);
});

test('normalisation uses quiet mixing defaults and switches silent video to replacement', () => {
  assert.deepEqual(normalizeAddAudioOptions(VIDEO_INFO), ADD_AUDIO_DEFAULTS);
  assert.deepEqual(normalizeAddAudioOptions(SILENT_VIDEO_INFO), {
    ...ADD_AUDIO_DEFAULTS,
    mixMode: 'replace',
    addedGain: 1,
  });
  assert.deepEqual(
    normalizeAddAudioOptions(SILENT_VIDEO_INFO, { mixMode: 'mix', addedGain: '0.5', audioOffset: '-0.25' }),
    { ...ADD_AUDIO_DEFAULTS, mixMode: 'replace', addedGain: 0.5, audioOffset: -0.25 }
  );
});

test('normalisation rejects malformed enums, booleans, gains, rates and offsets', () => {
  for (const options of [
    { mixMode: 'duck' },
    { audioFit: 'stretch' },
    { limiter: 'true' },
    { originalGain: -0.01 },
    { addedGain: 2.01 },
    { audioOffset: Infinity },
    { audioBitrate: 63 },
    { audioBitrate: 321 },
    { quality: 'lossless' },
    { speed: 'instant' },
  ]) {
    assert.equal(normalizeAddAudioOptions(VIDEO_INFO, options), null, JSON.stringify(options));
  }
});

test('once placement delays positive offsets, trims negative ones and refuses no-overlap', () => {
  assert.deepEqual(addAudioPlacement(VIDEO_INFO, AUDIO_INFO, { audioOffset: 1 }), {
    videoDuration: 3,
    audioDuration: 1,
    outputDuration: 3,
    offset: 1,
    delay: 1,
    trimStart: 0,
    audibleDuration: 1,
    loops: false,
  });
  assert.deepEqual(addAudioPlacement(VIDEO_INFO, AUDIO_INFO, { audioOffset: -0.25 }), {
    videoDuration: 3,
    audioDuration: 1,
    outputDuration: 3,
    offset: -0.25,
    delay: 0,
    trimStart: 0.25,
    audibleDuration: 0.75,
    loops: false,
  });
  assert.equal(addAudioPlacement(VIDEO_INFO, AUDIO_INFO, { audioOffset: 3 }), null);
  assert.equal(addAudioPlacement(VIDEO_INFO, AUDIO_INFO, { audioOffset: -1 }), null);
});

test('loop placement fills the remaining video and folds a huge negative offset to one phase', () => {
  assert.deepEqual(addAudioPlacement(VIDEO_INFO, AUDIO_INFO, { audioFit: 'loop', audioOffset: 0.5 }), {
    videoDuration: 3,
    audioDuration: 1,
    outputDuration: 3,
    offset: 0.5,
    delay: 0.5,
    trimStart: 0,
    audibleDuration: 2.5,
    loops: true,
  });
  const negative = addAudioPlacement(VIDEO_INFO, AUDIO_INFO, { audioFit: 'loop', audioOffset: -1000.25 });
  assert.equal(negative.trimStart, 0.25);
  assert.equal(negative.audibleDuration, 3);
});

test('preflight guards 350 MiB of inputs and a 500 MiB estimated working set', () => {
  const safe = readyProject({}, { video: 100 * MiB, audio: 10 * MiB });
  assert.equal(addAudioTotalBytes(safe), 110 * MiB);
  assert.equal(addAudioEstimatedWorkingBytes(safe), 210 * MiB);
  assert.equal(addAudioPreflight(safe).ok, true);

  const inputHeavy = readyProject({}, { video: 340 * MiB, audio: 11 * MiB });
  assert.equal(addAudioPreflight(inputHeavy).code, 'inputs-too-large');

  const outputHeavy = readyProject({}, { video: 250 * MiB, audio: 1 * MiB });
  const result = addAudioPreflight(outputHeavy);
  assert.equal(result.inputBytes, 251 * MiB);
  assert.equal(result.estimatedOutputBytes, 250 * MiB);
  assert.equal(result.estimatedWorkingBytes, 501 * MiB);
  assert.equal(result.code, 'working-set-too-large');
});

test('validation distinguishes missing, waiting, wrong-track and no-overlap projects', () => {
  const missing = createAddAudioProject(file('clip.mp4'));
  assert.equal(validateAddAudioProject(missing).code, 'missing-audio');

  const waiting = { ...missing, audio: createAddAudioAsset(file('song.mp3'), 'audio') };
  assert.equal(validateAddAudioProject(waiting).code, 'waiting-for-probe');

  const wrongVideo = readyProject();
  wrongVideo.video.info = AUDIO_INFO;
  assert.equal(validateAddAudioProject(wrongVideo).code, 'video-track-missing');

  const noOverlap = readyProject({ audioOffset: 3 });
  assert.equal(validateAddAudioProject(noOverlap).code, 'no-overlap');

  const inaudible = readyProject({ mixMode: 'replace', addedGain: 0 });
  assert.equal(validateAddAudioProject(inaudible).code, 'inaudible-output');

  const delayedOriginal = readyProject({ mixMode: 'mix', originalGain: 1, addedGain: 0 });
  delayedOriginal.video.info = {
    ...VIDEO_INFO,
    video: { ...VIDEO_INFO.video, startTime: 0, duration: 3 },
    audio: { ...VIDEO_INFO.audio, startTime: 5, duration: 1 },
  };
  assert.equal(validateAddAudioProject(delayedOriginal).code, 'inaudible-output');

  const containerOriginFallback = readyProject({ mixMode: 'mix', originalGain: 1, addedGain: 0 });
  containerOriginFallback.video.info = {
    ...VIDEO_INFO,
    startTime: 5,
    video: { ...VIDEO_INFO.video, startTime: null, duration: 3 },
    audio: { ...VIDEO_INFO.audio, startTime: 6, duration: 1 },
  };
  assert.equal(
    validateAddAudioProject(containerOriginFallback).ok,
    true,
    'a missing stream start must inherit the container origin instead of becoming zero',
  );
});

test('native preview starts where the video track begins, not at container preroll', () => {
  assert.equal(addAudioVideoTimelineStart(VIDEO_INFO), 0);
  assert.equal(addAudioVideoTimelineStart({
    ...VIDEO_INFO,
    startTime: 2,
    video: { ...VIDEO_INFO.video, startTime: 5 },
  }), 3);
  assert.equal(addAudioVideoTimelineStart({
    ...VIDEO_INFO,
    startTime: 5,
    video: { ...VIDEO_INFO.video, startTime: null },
  }), 0);
});

test('source and snapshot preserve named roles and freeze files in video/audio order', () => {
  const project = readyProject({ audioFit: 'loop', limiter: false });
  const source = addAudioProjectSource(project);
  assert.equal(source.video.role, 'video');
  assert.equal(source.audio.role, 'audio');
  assert.equal(source.video.name, 'holiday.mp4');
  assert.equal(source.audio.name, 'song.mp3');

  const snapshot = createAddAudioSnapshot(project);
  assert.deepEqual(snapshot.files, [project.video.file, project.audio.file]);
  assert.equal(snapshot.source.video.name, 'holiday.mp4');
  assert.equal(snapshot.options.audioFit, 'loop');
  assert.equal(snapshot.options.limiter, false);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.files));
  assert.ok(Object.isFrozen(snapshot.source));
  assert.ok(Object.isFrozen(snapshot.options));

  project.video.name = 'changed.mp4';
  project.options.audioFit = 'once';
  assert.equal(snapshot.source.video.name, 'holiday.mp4');
  assert.equal(snapshot.options.audioFit, 'loop');
});

test('revision helpers keep an in-flight export stale when editing continues', () => {
  const initial = createAddAudioEditState();
  const edited = markAddAudioEdited(initial);
  const exported = markAddAudioExported(edited);
  const changedAgain = markAddAudioEdited(exported);

  assert.equal(addAudioHasUnexportedChanges(initial), false);
  assert.equal(addAudioHasUnexportedChanges(exported), false);
  assert.equal(addAudioHasUnexportedChanges(changedAgain), true);
  assert.equal(markAddAudioExported(changedAgain, exported.revision).dirtySinceOutput, true);
});
