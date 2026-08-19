import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MERGE_TOOL_ID,
  MERGE_OPERATION,
  MERGE_MAX_CLIPS,
  MERGE_SAFE_BYTES,
  createMergeClip,
  mergeTotalBytes,
  mergeTotalDuration,
  mergeProjectInfo,
  validateMergeClips,
  reorderMergeClips,
  mergeProjectSource,
  createMergeSnapshot,
  createMergeEditState,
  markMergeEdited,
  markMergeExported,
  mergeHasUnexportedChanges,
} from '../src/media/merge.js';

const file = (name, size = 1024) => ({ name, size });
const info = ({ duration = 2, audio = true, width = 640, height = 360 } = {}) => ({
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  formats: ['mov', 'mp4'],
  duration,
  hasVideo: true,
  hasAudio: audio,
  video: { codec: 'h264', width, height, fps: 30 },
  audio: audio ? { codec: 'aac', channels: 2, sampleRate: 48_000 } : null,
  streams: [],
});

function readyClip(name, options = {}, id = name) {
  const clip = createMergeClip(file(name, options.size ?? 1024), id);
  clip.info = info(options);
  clip.status = 'ready';
  return clip;
}

test('merge constants match the public tool and bound browser memory', () => {
  assert.equal(MERGE_TOOL_ID, 'video-merge');
  assert.equal(MERGE_OPERATION, 'join-videos');
  assert.equal(MERGE_MAX_CLIPS, 24);
  assert.equal(MERGE_SAFE_BYTES, 350 * 1024 * 1024);
});

test('createMergeClip gives each clip stable identity and pending probe state', () => {
  const source = file('intro.mov', 4321);
  const first = createMergeClip(source, 'intro');
  const generatedA = createMergeClip(file('a.mp4'));
  const generatedB = createMergeClip(file('b.mp4'));

  assert.deepEqual(first, {
    id: 'intro',
    file: source,
    name: 'intro.mov',
    size: 4321,
    info: null,
    status: 'pending',
    error: null,
  });
  assert.notEqual(generatedA.id, generatedB.id);
  assert.match(
    generatedA.id,
    /^merge-clip-(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|legacy-[a-z0-9-]+)$/,
  );
  assert.equal(first.id, 'intro');
});

test('createMergeClip rejects values that cannot become trustworthy assets', () => {
  assert.throws(() => createMergeClip(null), /needs a File/);
  assert.throws(() => createMergeClip({ name: '', size: 1 }), /file name/);
  assert.throws(() => createMergeClip({ name: 'bad.mp4', size: NaN }), /file size/);
  assert.throws(() => createMergeClip({ name: 'bad.mp4', size: -1 }), /file size/);
});

test('totals follow current clip order and stay unknown until all durations are valid', () => {
  const clips = [
    readyClip('one.mp4', { size: 100, duration: 1.25 }),
    readyClip('two.mp4', { size: 250, duration: 2.75 }),
  ];
  assert.equal(mergeTotalBytes(clips), 350);
  assert.equal(mergeTotalBytes({ clips }), 350);
  assert.equal(mergeTotalDuration(clips), 4);
  assert.equal(mergeTotalDuration([]), 0);

  clips[1].info.duration = null;
  assert.equal(mergeTotalDuration(clips), null);
});

test('mergeProjectInfo describes the sequence without pretending every clip has audio', () => {
  const clips = [
    readyClip('portrait.mp4', { size: 120, duration: 1, width: 360, height: 640, audio: false }),
    readyClip('landscape.mp4', { size: 230, duration: 3, width: 1280, height: 720, audio: true }),
  ];
  const aggregate = mergeProjectInfo(clips);

  assert.deepEqual(aggregate, {
    format: 'sequence',
    formatLabel: 'Secuencia',
    clipCount: 2,
    size: 350,
    duration: 4,
    hasVideo: true,
    hasAudio: true,
    video: clips[0].info.video,
    audio: clips[1].info.audio,
  });
  assert.notEqual(aggregate.video, clips[0].info.video);
  assert.notEqual(aggregate.audio, clips[1].info.audio);
});

test('mergeProjectInfo stays honest while a clip is unprobed or invalid', () => {
  const pending = createMergeClip(file('pending.mp4'), 'pending');
  const invalid = readyClip('audio-only.m4a');
  invalid.info.hasVideo = false;
  invalid.info.video = null;

  assert.equal(mergeProjectInfo([readyClip('ok.mp4'), pending]).duration, null);
  assert.equal(mergeProjectInfo([readyClip('ok.mp4'), pending]).hasVideo, false);
  assert.equal(mergeProjectInfo([readyClip('ok.mp4'), invalid]).hasVideo, false);
  assert.deepEqual(mergeProjectInfo([]), {
    format: 'sequence',
    formatLabel: 'Secuencia',
    clipCount: 0,
    size: 0,
    duration: 0,
    hasVideo: false,
    hasAudio: false,
    video: null,
    audio: null,
  });
});

test('validation accepts two or more ready videos and returns useful totals', () => {
  const clips = [
    readyClip('one.mp4', { size: 100, duration: 1.5 }),
    readyClip('two.mp4', { size: 200, duration: 2.5, audio: false }),
  ];
  assert.deepEqual(validateMergeClips(clips), {
    ok: true,
    error: null,
    totalBytes: 300,
    totalDuration: 4,
  });
});

test('validation reports cardinality, count and aggregate memory limits in Spanish', () => {
  assert.equal(validateMergeClips([]).error, 'Agregá al menos dos videos para unirlos.');
  assert.equal(validateMergeClips([readyClip('only.mp4')]).error, 'Agregá al menos dos videos para unirlos.');

  const tooMany = Array.from({ length: MERGE_MAX_CLIPS + 1 }, (_, index) => readyClip(`${index}.mp4`));
  assert.equal(validateMergeClips(tooMany).error, `Podés unir hasta ${MERGE_MAX_CLIPS} videos por vez.`);

  const tooLarge = [
    readyClip('large.mp4', { size: MERGE_SAFE_BYTES }),
    readyClip('extra.mp4', { size: 1 }),
  ];
  assert.equal(
    validateMergeClips(tooLarge).error,
    'La selección supera el límite seguro de 350 MB para unir videos en este dispositivo.',
  );
  assert.equal(validateMergeClips([
    readyClip('exact.mp4', { size: MERGE_SAFE_BYTES - 1 }),
    readyClip('last.mp4', { size: 1 }),
  ]).ok, true);
});

test('validation distinguishes failed, pending, non-video and unknown-duration clips', () => {
  const ok = readyClip('ok.mp4');
  const failed = createMergeClip(file('roto.mov'), 'failed');
  failed.status = 'failed';
  failed.error = 'bad header';
  assert.equal(
    validateMergeClips([ok, failed]).error,
    'No pudimos analizar «roto.mov». Quitalo o reemplazalo para continuar.',
  );

  const pending = createMergeClip(file('esperando.mov'), 'pending');
  assert.equal(
    validateMergeClips([ok, pending]).error,
    'Esperá a que terminemos de analizar todos los videos.',
  );

  const audioOnly = readyClip('solo-audio.m4a');
  audioOnly.info.hasVideo = false;
  audioOnly.info.video = null;
  assert.equal(
    validateMergeClips([ok, audioOnly]).error,
    '«solo-audio.m4a» no contiene una pista de video.',
  );

  const live = readyClip('stream.webm');
  live.info.duration = null;
  assert.equal(
    validateMergeClips([ok, live]).error,
    'No pudimos determinar la duración de «stream.webm».',
  );
});

test('reordering uses stable ids, clamps the destination and never mutates the source', () => {
  const clips = [readyClip('a.mp4'), readyClip('b.mp4'), readyClip('c.mp4')];
  const original = [...clips];

  const moved = reorderMergeClips(clips, 'a.mp4', 2);
  assert.deepEqual(moved.map((clip) => clip.id), ['b.mp4', 'c.mp4', 'a.mp4']);
  assert.deepEqual(clips, original);
  assert.notEqual(moved, clips);
  assert.equal(moved[2], clips[0]);

  assert.deepEqual(reorderMergeClips(clips, 'c.mp4', -99).map((clip) => clip.id), ['c.mp4', 'a.mp4', 'b.mp4']);
  assert.deepEqual(reorderMergeClips(clips, 'a.mp4', 99).map((clip) => clip.id), ['b.mp4', 'c.mp4', 'a.mp4']);
  assert.deepEqual(reorderMergeClips(clips, 'missing', 1), clips);
  assert.notEqual(reorderMergeClips(clips, 'missing', 1), clips);
  assert.deepEqual(reorderMergeClips(clips, 'a.mp4', NaN), clips);
});

test('mergeProjectSource preserves order and detaches command metadata from live clips', () => {
  const first = readyClip('first.mov', { size: 10, duration: 1 });
  const second = readyClip('second.mp4', { size: 20, duration: 2 });
  const project = { name: 'mi-union.mp4', clips: [second, first] };
  const source = mergeProjectSource(project);

  assert.equal(source.name, 'mi-union.mp4');
  assert.deepEqual(source.inputs.map((input) => input.id), ['second.mp4', 'first.mov']);
  assert.deepEqual(source.inputs.map((input) => input.name), ['second.mp4', 'first.mov']);
  assert.deepEqual(source.inputs.map((input) => input.size), [20, 10]);
  assert.equal(source.info.duration, 3);

  second.info.video.width = 99;
  assert.notEqual(source.inputs[0].info.video.width, 99);
});

test('createMergeSnapshot freezes export order, files, options, metadata and revision', () => {
  const first = readyClip('first.mp4', { duration: 1 });
  const second = readyClip('second.mp4', { duration: 2 });
  const project = {
    name: 'resultado.mp4',
    clips: [first, second],
    options: { resolution: '720', quality: 'balanced' },
    revision: 7,
  };
  const snapshot = createMergeSnapshot(project);

  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.files, [first.file, second.file]);
  assert.deepEqual(snapshot.source.inputs.map((input) => input.id), ['first.mp4', 'second.mp4']);
  assert.deepEqual(snapshot.options, project.options);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.clips));
  assert.ok(Object.isFrozen(snapshot.files));
  assert.ok(Object.isFrozen(snapshot.options));
  assert.ok(Object.isFrozen(snapshot.source));
  assert.ok(Object.isFrozen(snapshot.source.inputs));
  assert.ok(Object.isFrozen(snapshot.source.inputs[0].info.video));

  project.clips.reverse();
  project.options.resolution = '1080';
  first.info.video.width = 42;
  assert.deepEqual(snapshot.source.inputs.map((input) => input.id), ['first.mp4', 'second.mp4']);
  assert.equal(snapshot.options.resolution, '720');
  assert.notEqual(snapshot.source.inputs[0].info.video.width, 42);
});

test('edit state tracks stale output, including edits made during an export', () => {
  const initial = createMergeEditState();
  assert.deepEqual(initial, { revision: 0, exportedRevision: null, dirtySinceOutput: false });
  assert.equal(mergeHasUnexportedChanges(initial), false);

  const firstEdit = markMergeEdited(initial);
  assert.deepEqual(firstEdit, { revision: 1, exportedRevision: null, dirtySinceOutput: false });

  const exported = markMergeExported(firstEdit);
  assert.deepEqual(exported, { revision: 1, exportedRevision: 1, dirtySinceOutput: false });
  assert.equal(mergeHasUnexportedChanges(exported), false);

  const editedWhileExporting = markMergeEdited(markMergeEdited(exported));
  assert.deepEqual(editedWhileExporting, { revision: 3, exportedRevision: 1, dirtySinceOutput: true });
  const olderExportFinishes = markMergeExported(editedWhileExporting, 2);
  assert.deepEqual(olderExportFinishes, { revision: 3, exportedRevision: 2, dirtySinceOutput: true });
  assert.equal(mergeHasUnexportedChanges(olderExportFinishes), true);

  const currentExportFinishes = markMergeExported(olderExportFinishes, 3);
  assert.deepEqual(currentExportFinishes, { revision: 3, exportedRevision: 3, dirtySinceOutput: false });
  assert.equal(mergeHasUnexportedChanges(currentExportFinishes), false);
  assert.ok(Object.isFrozen(currentExportFinishes));
});
