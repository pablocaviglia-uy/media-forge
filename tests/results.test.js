import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESULT_HISTORY_SCHEMA_VERSION,
  ResultModelError,
  appendResult,
  canonicalResultDescriptor,
  deleteResult,
  flattenResultOutputs,
  hydrateResultHistory,
  latestResult,
  legacyResultId,
  mediaKindOf,
  normalizeResultHistory,
  replaceResult,
  resultCompatibilityPatch,
  resultHistoryManifest,
  selectResult,
  selectedResult,
} from '../src/media/results.js';
import {
  createMemoryProjectBackend,
  createProjectStore,
} from '../src/storage/projects.js';

function ids() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

const output = (contents, name, type = '') => ({
  name,
  blob: new Blob([contents], { type }),
});

const candidate = ({
  name = 'converted.mp3',
  contents = 'audio bytes',
  type = 'audio/mpeg',
  createdAt = 100,
  options = { format: 'mp3', trim: { from: 4, to: 12 } },
  metadata = { duration: 8, format: 'mp3', mime: 'audio/mpeg' },
  ...overrides
} = {}) => ({
  projectId: 'project-1',
  createdAt,
  operation: 'extract-audio',
  forgeToolId: 'extract-audio',
  revision: 2,
  options,
  metadata,
  downloadName: name,
  outputs: [output(contents, name, type)],
  ...overrides,
});

test('media kind selects the local preview from MIME and falls back to extension', () => {
  assert.equal(mediaKindOf({ type: 'audio/mpeg', name: 'opaque.bin' }), 'audio');
  assert.equal(mediaKindOf({ type: '', name: 'recording.M4A' }), 'audio');
  assert.equal(mediaKindOf({ type: '', name: 'clip.mkv' }), 'video');
  assert.equal(mediaKindOf({ type: '', name: 'frame.webp' }), 'image');
  assert.equal(mediaKindOf({ type: 'application/zip', name: 'frames.bin' }), 'archive');
  assert.equal(mediaKindOf({ type: '', name: 'result.dat' }), 'unknown');
});

test('legacy job outputs become one stable generation without losing multi-file grouping', () => {
  const job = {
    id: 'legacy-project',
    operation: 'extract-frames',
    forgeToolId: 'extract-frames',
    options: { format: 'png', fps: 2 },
    revision: 8,
    exportedRevision: 7,
    updatedAt: 456,
    downloadName: 'frames.zip',
    outputs: [
      output('one', 'frame-001.png', 'image/png'),
      output('two', 'frame-002.png', 'image/png'),
    ],
  };

  const first = normalizeResultHistory(job, { now: 999, makeId: ids() });
  const second = normalizeResultHistory(job, { now: 2_000, makeId: ids() });
  const result = first.resultHistory[0];

  assert.equal(first.schemaVersion, RESULT_HISTORY_SCHEMA_VERSION);
  assert.equal(result.id, legacyResultId(job.id));
  assert.equal(first.selectedResultId, result.id);
  assert.equal(result.createdAt, 456);
  assert.equal(result.revision, 7);
  assert.equal(result.downloadName, 'frames.zip');
  assert.equal(result.mediaKind, 'image');
  assert.deepEqual(result.outputs.map((entry) => entry.name), ['frame-001.png', 'frame-002.png']);
  assert.deepEqual(
    result.outputs.map((entry) => entry.id),
    ['output:legacy-project:legacy:0', 'output:legacy-project:legacy:1'],
  );
  assert.deepEqual(
    second.resultHistory[0].outputs.map((entry) => entry.id),
    result.outputs.map((entry) => entry.id),
  );
});

test('an empty initialized history does not hide a legacy output produced during migration', () => {
  const history = normalizeResultHistory({
    id: 'partly-migrated',
    resultHistory: [],
    outputs: [output('audio', 'audio.mp3', 'audio/mpeg')],
    downloadName: 'audio.mp3',
  });

  assert.equal(history.resultHistory.length, 1);
  assert.equal(history.resultHistory[0].id, legacyResultId('partly-migrated'));
});

test('append retains older generations, assigns durable ids and snapshots metadata', () => {
  const makeId = ids();
  const originalOptions = { format: 'mp3', trim: { from: 1, to: 5 } };
  const originalMetadata = { duration: 4, dimensions: { width: 0, height: 0 } };
  let history = normalizeResultHistory({ id: 'project-1', outputs: null }, { makeId });

  history = appendResult(history, candidate({
    options: originalOptions,
    metadata: originalMetadata,
  }), { makeId, now: 100 });
  const first = history.resultHistory[0];
  originalOptions.trim.from = 99;
  originalMetadata.dimensions.width = 1920;
  history = appendResult(history, candidate({
    name: 'converted.wav',
    contents: 'wave bytes',
    type: 'audio/wav',
    createdAt: 200,
    options: { format: 'wav' },
  }), { makeId, now: 200 });

  assert.equal(history.resultHistory.length, 2);
  assert.notEqual(history.resultHistory[0].id, history.resultHistory[1].id);
  assert.notEqual(history.resultHistory[0].outputs[0].id, history.resultHistory[1].outputs[0].id);
  assert.equal(first.options.trim.from, 1);
  assert.ok(Object.isFrozen(first.options.trim));
  assert.equal(first.metadata.dimensions.width, 0);
  assert.ok(Object.isFrozen(first.metadata.dimensions));
  assert.equal(history.selectedResultId, history.resultHistory[1].id);
  assert.equal(latestResult(history).downloadName, 'converted.wav');
});

test('selection browses an older result while compatibility aliases remain on the latest', () => {
  const makeId = ids();
  let history = normalizeResultHistory({ id: 'project-1' }, { makeId });
  history = appendResult(history, candidate({ name: 'first.mp3', contents: 'first' }), { makeId });
  const firstId = history.resultHistory[0].id;
  history = appendResult(history, candidate({
    name: 'second.wav', contents: 'second result', type: 'audio/wav', createdAt: 200,
  }), { makeId });
  history = selectResult(history, firstId);

  assert.equal(selectedResult(history).downloadName, 'first.mp3');
  const patch = resultCompatibilityPatch(history);
  assert.equal(patch.selectedResultId, firstId);
  assert.equal(patch.downloadName, 'second.wav');
  assert.equal(patch.outputs[0].name, 'second.wav');
  assert.equal(patch.outputSize, new Blob(['second result']).size);
});

test('replace preserves result identity and chronological position', () => {
  const makeId = ids();
  let history = normalizeResultHistory({ id: 'project-1' }, { makeId });
  history = appendResult(history, candidate({ name: 'first.mp3' }), { makeId });
  const firstId = history.resultHistory[0].id;
  const oldOutputId = history.resultHistory[0].outputs[0].id;
  history = appendResult(history, candidate({ name: 'second.mp3', createdAt: 200 }), { makeId });
  const selectedId = history.selectedResultId;

  history = replaceResult(history, firstId, candidate({
    name: 'first-fixed.flac', type: 'audio/flac', createdAt: 300,
  }), { makeId });

  assert.equal(history.resultHistory[0].id, firstId);
  assert.equal(history.resultHistory[0].downloadName, 'first-fixed.flac');
  assert.notEqual(history.resultHistory[0].outputs[0].id, oldOutputId);
  assert.equal(history.resultHistory[1].downloadName, 'second.mp3');
  assert.equal(history.selectedResultId, selectedId);
});

test('delete only removes the requested generation and repairs selection', () => {
  const makeId = ids();
  let history = normalizeResultHistory({ id: 'project-1' }, { makeId });
  history = appendResult(history, candidate({ name: 'first.mp3' }), { makeId });
  const firstId = history.selectedResultId;
  history = appendResult(history, candidate({ name: 'second.mp3' }), { makeId });
  const secondId = history.selectedResultId;
  history = selectResult(history, firstId);
  history = deleteResult(history, firstId);

  assert.deepEqual(history.resultHistory.map((result) => result.id), [secondId]);
  assert.equal(history.selectedResultId, secondId);
  assert.throws(
    () => deleteResult(history, 'missing'),
    (error) => error instanceof ResultModelError && error.code === 'result-not-found',
  );
});

test('manifests and flattened outputs round-trip multiple generations with Blobs', async () => {
  const makeId = ids();
  let history = normalizeResultHistory({ id: 'project-1' }, { makeId });
  history = appendResult(history, candidate({ name: 'song.mp3', contents: 'mp3' }), { makeId });
  const firstId = history.selectedResultId;
  history = appendResult(history, candidate({
    name: 'song.wav', contents: 'wav', type: 'audio/wav', createdAt: 200,
  }), { makeId });
  history = selectResult(history, firstId);

  const manifest = resultHistoryManifest(history);
  const flattened = flattenResultOutputs(history);
  for (const result of manifest) assert.equal('outputs' in result, false);
  assert.deepEqual(flattened.map((entry) => entry.resultPosition), [0, 1]);
  assert.deepEqual(flattened.map((entry) => entry.resultId), manifest.map((entry) => entry.id));

  const restored = hydrateResultHistory({
    projectId: 'project-1',
    resultHistory: structuredClone(manifest),
    selectedResultId: history.selectedResultId,
    outputs: flattened.map((entry) => ({ ...entry })),
  }, { makeId: ids(), now: 999 });

  assert.equal(restored.resultHistory.length, 2);
  assert.equal(restored.selectedResultId, firstId);
  assert.equal(await restored.resultHistory[0].outputs[0].blob.text(), 'mp3');
  assert.equal(await restored.resultHistory[1].outputs[0].blob.text(), 'wav');
  assert.deepEqual(resultHistoryManifest(restored), manifest);
  assert.deepEqual(restored.resultHistory[0].metadata, {
    duration: 8,
    format: 'mp3',
    mime: 'audio/mpeg',
  });
});

test('a full project-store round trip retains every generation and the selected result', async () => {
  const backend = createMemoryProjectBackend();
  const makeResultId = ids();
  let history = normalizeResultHistory({ id: 'durable-project' }, { makeId: makeResultId });
  history = appendResult(history, {
    ...candidate({ name: 'take.mp3', contents: 'first durable output' }),
    projectId: 'durable-project',
  }, { makeId: makeResultId });
  const selectedResultId = history.selectedResultId;
  history = appendResult(history, {
    ...candidate({ name: 'take.wav', contents: 'second durable output', type: 'audio/wav' }),
    projectId: 'durable-project',
  }, { makeId: makeResultId });
  history = selectResult(history, selectedResultId);

  const source = new File(['source'], 'take.mp4', { type: 'video/mp4', lastModified: 123 });
  const job = {
    id: 'durable-project',
    file: source,
    name: source.name,
    size: source.size,
    type: source.type,
    lastModified: source.lastModified,
    info: null,
    status: 'done',
    operation: 'extract-audio',
    options: { format: 'wav' },
    ...resultCompatibilityPatch(history),
  };
  const store = createProjectStore({
    backend,
    makeId: ids(),
    now: () => 1_800_000_000_000,
    channelFactory: () => null,
  });

  await store.saveWorkspace([job], { selectedId: job.id });
  const snapshot = backend.snapshot();
  assert.equal(snapshot.projects[0].resultHistory.length, 2);
  assert.equal(snapshot.outputs.length, 2);
  assert.deepEqual(
    snapshot.outputs.map((entry) => entry.resultId),
    snapshot.projects[0].resultHistory.map((entry) => entry.id),
  );

  const restored = (await store.loadWorkspace()).jobs[0];
  assert.equal(restored.resultHistory.length, 2);
  assert.equal(restored.selectedResultId, selectedResultId);
  assert.equal(selectedResult({
    resultHistory: restored.resultHistory,
    selectedResultId: restored.selectedResultId,
  }).downloadName, 'take.mp3');
  assert.equal(restored.downloadName, 'take.wav');
  assert.equal(await restored.resultHistory[0].outputs[0].blob.text(), 'first durable output');
  assert.equal(await restored.resultHistory[1].outputs[0].blob.text(), 'second durable output');
  store.close();
});

test('hydrate drops an unplayable manifest and selects the newest durable result', () => {
  const makeId = ids();
  let history = normalizeResultHistory({ id: 'project-1' }, { makeId });
  history = appendResult(history, candidate({ name: 'first.mp3' }), { makeId });
  history = appendResult(history, candidate({ name: 'second.mp3' }), { makeId });
  const manifest = resultHistoryManifest(history);
  const flattened = flattenResultOutputs(history).filter((outputEntry) => (
    outputEntry.resultId === manifest[0].id
  ));

  const restored = hydrateResultHistory({
    projectId: 'project-1',
    resultHistory: manifest,
    selectedResultId: manifest[1].id,
    outputs: flattened,
  });

  assert.deepEqual(restored.resultHistory.map((result) => result.id), [manifest[0].id]);
  assert.equal(restored.selectedResultId, manifest[0].id);
});

test('hydrate rejects a partially available multi-output generation and reports every missing output', () => {
  const makeId = ids();
  let history = normalizeResultHistory({ id: 'project-1' }, { makeId });
  history = appendResult(history, candidate({
    name: 'frames.zip',
    outputs: [
      output('one', 'frame-001.png', 'image/png'),
      output('two', 'frame-002.png', 'image/png'),
      output('three', 'frame-003.png', 'image/png'),
    ],
  }), { makeId });
  const manifest = resultHistoryManifest(history);
  const flattened = flattenResultOutputs(history);
  const issues = [];

  const restored = hydrateResultHistory({
    projectId: 'project-1',
    resultHistory: manifest,
    selectedResultId: history.selectedResultId,
    outputs: [flattened[0]],
  }, { onIssue: (issue) => issues.push(issue) });

  assert.deepEqual(restored.resultHistory, []);
  assert.equal(restored.selectedResultId, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'incomplete-result');
  assert.equal(issues[0].expectedOutputCount, 3);
  assert.equal(issues[0].availableOutputCount, 1);
  assert.deepEqual(issues[0].missingOutputIds, manifest[0].outputIds.slice(1));
});

test('hydrate understands a V1 project with no result manifest', () => {
  const legacyOutput = {
    id: 'output:old:0',
    name: 'old.mp3',
    blob: new Blob(['old'], { type: 'audio/mpeg' }),
  };
  const restored = hydrateResultHistory({
    projectId: 'old',
    outputs: [legacyOutput],
    legacy: {
      operation: 'extract-audio',
      options: { format: 'mp3' },
      downloadName: 'old.mp3',
      updatedAt: 123,
    },
  }, { now: 999 });

  assert.equal(restored.resultHistory[0].id, legacyResultId('old'));
  assert.equal(restored.resultHistory[0].outputs[0].id, legacyOutput.id);
  assert.equal(restored.resultHistory[0].createdAt, 123);
});

test('canonical descriptors reject empty generations, unsafe metadata and duplicate keys', () => {
  assert.throws(
    () => canonicalResultDescriptor({ outputs: [] }, { projectId: 'project-1' }),
    (error) => error.code === 'empty-result',
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalResultDescriptor(candidate({ options: cyclic }), { projectId: 'project-1' }),
    (error) => error.code === 'invalid-metadata',
  );

  const duplicate = candidate({
    id: 'result-a',
    outputs: [{ id: 'same', ...output('a', 'a.mp3', 'audio/mpeg') }],
  });
  assert.throws(
    () => normalizeResultHistory({
      id: 'project-1',
      resultHistory: [
        duplicate,
        { ...duplicate, id: 'result-b' },
      ],
    }),
    (error) => error.code === 'duplicate-output-id',
  );
});

test('an empty history projects the exact legacy no-result values', () => {
  const history = normalizeResultHistory({ id: 'empty-project', outputs: null });
  assert.deepEqual(resultCompatibilityPatch(history), {
    resultHistory: [],
    selectedResultId: null,
    outputs: null,
    downloadName: null,
    outputSize: 0,
  });
});
