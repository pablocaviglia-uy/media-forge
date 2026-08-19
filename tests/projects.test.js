import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_DB_NAME,
  PROJECT_DB_VERSION,
  PROJECT_SCHEMA_VERSION,
  PROJECT_STORES,
  ProjectStoreError,
  createBlobIdentityRegistry,
  createMemoryProjectBackend,
  createProjectStore,
  hydrateWorkspace,
  isQuotaExceededError,
  serializeWorkspace,
} from '../src/storage/projects.js';

const mediaInfo = ({ duration = 3, audio = true } = {}) => ({
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  formats: ['mov', 'mp4'],
  duration,
  bitrate: 800_000,
  hasVideo: true,
  hasAudio: audio,
  video: { kind: 'video', codec: 'h264', width: 640, height: 360, fps: 30, duration },
  audio: audio ? { kind: 'audio', codec: 'aac', channels: 2, sampleRate: 48_000, duration } : null,
  streams: [],
});

const audioInfo = ({ duration = 2 } = {}) => ({
  format: 'mp3',
  formats: ['mp3'],
  duration,
  bitrate: 128_000,
  hasVideo: false,
  hasAudio: true,
  video: null,
  audio: { kind: 'audio', codec: 'mp3', channels: 2, sampleRate: 44_100, duration },
  streams: [],
});

const file = (contents, name, type = 'video/mp4', lastModified = 1_700_000_000_000) => (
  new File([contents], name, { type, lastModified })
);

function ids() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function simpleJob(overrides = {}) {
  const source = overrides.file || file('source bytes', 'holiday.mp4');
  return {
    id: 'project-simple',
    file: source,
    name: source.name,
    size: source.size,
    info: mediaInfo(),
    status: 'ready',
    operation: 'convert',
    options: { format: 'mp4-h264', quality: 'balanced' },
    progress: 0.73,
    speed: 1.2,
    remaining: 14,
    outputs: null,
    error: null,
    log: ['private runtime log'],
    previewUrl: 'blob:https://example.invalid/runtime',
    pendingMergeSnapshot: { should: 'never persist' },
    ...overrides,
  };
}

function mergeJob(overrides = {}) {
  const first = file('first', 'first.mov', 'video/quicktime', 101);
  const second = file('second', 'second.mp4', 'video/mp4', 202);
  return {
    id: 'project-merge',
    kind: 'video-merge',
    forgeToolId: 'video-merge',
    clips: [
      { id: 'clip-a', file: first, name: first.name, size: first.size, info: mediaInfo({ duration: 1 }), status: 'ready' },
      { id: 'clip-b', file: second, name: second.name, size: second.size, info: mediaInfo({ duration: 2, audio: false }), status: 'ready' },
    ],
    selectedClipId: 'clip-b',
    file: first,
    name: 'Videos unidos',
    size: first.size + second.size,
    info: null,
    status: 'ready',
    operation: 'join-videos',
    options: { format: 'mp4-h264', mergeFit: 'contain' },
    outputs: null,
    progress: 0,
    log: [],
    revision: 4,
    exportedRevision: 2,
    dirtySinceOutput: true,
    ...overrides,
  };
}

function addAudioJob(overrides = {}) {
  const video = file('video', 'picture.mp4', 'video/mp4', 303);
  const audio = file('audio', 'music.mp3', 'audio/mpeg', 404);
  return {
    id: 'project-add-audio',
    kind: 'video-add-audio',
    forgeToolId: 'video-add-audio',
    operation: 'add-audio-to-video',
    video: {
      id: 'video-role', role: 'video', file: video, name: video.name, size: video.size,
      info: mediaInfo({ duration: 8 }), status: 'ready', error: null,
    },
    audio: {
      id: 'audio-role', role: 'audio', file: audio, name: audio.name, size: audio.size,
      info: audioInfo({ duration: 4 }), status: 'ready', error: null,
    },
    file: video,
    name: video.name,
    size: video.size + audio.size,
    info: mediaInfo({ duration: 8 }),
    status: 'ready',
    options: { format: 'mp4-h264', mixMode: 'mix', addedGain: 0.35 },
    addAudioTouchedOptions: { addedGain: true },
    outputs: null,
    progress: 0,
    log: [],
    revision: 3,
    exportedRevision: null,
    ...overrides,
  };
}

function storeWith(backend, options = {}) {
  return createProjectStore({
    backend,
    makeId: ids(),
    now: () => 1_800_000_000_000,
    channelFactory: () => null,
    ...options,
  });
}

test('storage namespace and V1 store names are stable', () => {
  assert.equal(PROJECT_DB_NAME, 'media-forge-projects');
  assert.equal(PROJECT_DB_VERSION, 1);
  assert.equal(PROJECT_SCHEMA_VERSION, 1);
  assert.deepEqual(Object.values(PROJECT_STORES), ['projects', 'assets', 'outputs', 'blobs', 'meta']);
});

test('a browser that rejects IndexedDB open degrades with a stable error', async () => {
  const store = storeWith({
    async open() { throw new DOMException('blocked', 'InvalidStateError'); },
  });
  await assert.rejects(
    store.open(),
    (error) => error instanceof ProjectStoreError && error.code === 'storage-unavailable',
  );
});

test('the default project id path survives an exposed randomUUID that throws', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      randomUUID() { throw new Error('restricted browser context'); },
    },
  });
  let store;
  try {
    store = createProjectStore({
      backend: createMemoryProjectBackend(),
      now: () => 1_800_000_000_000,
      channelFactory: () => null,
    });
    const saved = await store.saveWorkspace([simpleJob()]);
    assert.equal(saved.saved, true);
    assert.equal(saved.storageRevision, 1);
  } finally {
    store?.close();
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('simple project serialization is explicit and keeps bytes out of metadata records', () => {
  const source = file('abc', 'clip.mp4', 'video/mp4', 123);
  const result = new Blob(['result'], { type: 'video/webm' });
  const job = simpleJob({
    file: source,
    status: 'done',
    outputs: [{ name: 'clip.webm', blob: result }],
    outputSize: result.size,
    downloadName: 'clip.webm',
    quickExportSignature: 'ffmpeg -i input output.webm',
  });
  const graph = serializeWorkspace([job], {
    selectedId: job.id,
    now: 111,
    registry: createBlobIdentityRegistry(ids()),
  });

  assert.equal(graph.projects.length, 1);
  assert.equal(graph.assets.length, 1);
  assert.equal(graph.outputs.length, 1);
  assert.equal(graph.blobs.length, 2);
  assert.equal(graph.meta.selectedId, job.id);
  assert.equal(graph.projects[0].kind, 'simple');
  assert.equal(graph.projects[0].status, 'done');
  assert.equal(graph.assets[0].role, 'source');
  assert.equal(graph.assets[0].name, 'clip.mp4');
  assert.equal(graph.outputs[0].name, 'clip.webm');
  assert.equal(graph.blobs[0].data, source);
  assert.equal(graph.blobs[1].data, result);

  for (const key of [
    'file', 'outputs', 'progress', 'speed', 'remaining', 'log', 'error', 'previewUrl',
    'pendingMergeSnapshot', 'pendingAddAudioSnapshot', 'pendingQuickFocus', 'previewMode',
  ]) {
    assert.equal(key in graph.projects[0], false, `${key} leaked into project metadata`);
  }
  assert.equal('data' in graph.assets[0], false);
  assert.equal('data' in graph.outputs[0], false);
});

test('one Blob reused by different projects receives owner-specific record ids', () => {
  const shared = file('shared', 'shared.mp4');
  const registry = createBlobIdentityRegistry(ids());
  const graph = serializeWorkspace([
    simpleJob({ id: 'one', file: shared, name: shared.name, size: shared.size }),
    simpleJob({ id: 'two', file: shared, name: shared.name, size: shared.size }),
  ], { registry });

  assert.equal(graph.blobs.length, 2);
  assert.notEqual(graph.blobs[0].id, graph.blobs[1].id);
  assert.deepEqual(new Set(graph.blobs.map((entry) => entry.projectId)), new Set(['one', 'two']));
});

test('the registry gives repeated metadata saves stable blob references', () => {
  const registry = createBlobIdentityRegistry(ids());
  const job = simpleJob();
  const first = serializeWorkspace([job], { registry });
  job.options.quality = 'high';
  job.progress = 0.9;
  const second = serializeWorkspace([job], { registry });

  assert.equal(first.assets[0].blobId, second.assets[0].blobId);
  assert.equal(first.blobs[0].id, second.blobs[0].id);
  assert.equal(second.projects[0].options.quality, 'high');
  assert.equal('progress' in second.projects[0], false);
});

test('merge codec preserves clip roles, identity and order', () => {
  const job = mergeJob();
  const graph = serializeWorkspace([job], { registry: createBlobIdentityRegistry(ids()) });
  const restored = hydrateWorkspace(graph);
  const result = restored.jobs[0];

  assert.equal(graph.projects[0].kind, 'merge');
  assert.deepEqual(graph.assets.map((asset) => asset.role), ['clip', 'clip']);
  assert.deepEqual(graph.assets.map((asset) => asset.position), [0, 1]);
  assert.deepEqual(result.clips.map((clip) => clip.id), ['clip-a', 'clip-b']);
  assert.deepEqual(result.clips.map((clip) => clip.file.name), ['first.mov', 'second.mp4']);
  assert.equal(result.selectedClipId, 'clip-b');
  assert.equal(result.file, result.clips[0].file);
  assert.equal(result.info.clipCount, 2);
  assert.equal(result.info.duration, 3);
  assert.equal(result.revision, 4);
  assert.equal(result.exportedRevision, 2);
  assert.equal(result.dirtySinceOutput, true);
});

test('add-audio codec restores named roles and touched options', () => {
  const job = addAudioJob();
  const graph = serializeWorkspace([job], { registry: createBlobIdentityRegistry(ids()) });
  const restored = hydrateWorkspace(graph).jobs[0];

  assert.equal(graph.projects[0].kind, 'add-audio');
  assert.deepEqual(graph.assets.map((asset) => asset.role), ['video', 'audio']);
  assert.equal(restored.kind, 'video-add-audio');
  assert.equal(restored.video.role, 'video');
  assert.equal(restored.video.file.name, 'picture.mp4');
  assert.equal(restored.audio.role, 'audio');
  assert.equal(restored.audio.file.name, 'music.mp3');
  assert.equal(restored.file, restored.video.file);
  assert.deepEqual(restored.addAudioTouchedOptions, { addedGain: true });
});

test('File metadata and result Blobs survive a full codec round trip', async () => {
  const source = file('source', 'camera.MOV', 'video/quicktime', 987_654);
  const output = new Blob(['finished'], { type: 'video/mp4' });
  const graph = serializeWorkspace([
    simpleJob({
      file: source,
      name: source.name,
      size: source.size,
      status: 'done',
      outputs: [{ name: 'camera.mp4', blob: output }],
      downloadName: 'camera.mp4',
    }),
  ], { registry: createBlobIdentityRegistry(ids()) });
  const restored = hydrateWorkspace(graph).jobs[0];

  assert.ok(restored.file instanceof File);
  assert.equal(restored.file.name, 'camera.MOV');
  assert.equal(restored.file.type, 'video/quicktime');
  assert.equal(restored.file.lastModified, 987_654);
  assert.equal(await restored.file.text(), 'source');
  assert.ok(restored.outputs[0].blob instanceof Blob);
  assert.equal(await restored.outputs[0].blob.text(), 'finished');
  assert.equal(restored.downloadName, 'camera.mp4');
  assert.equal(restored.status, 'done');
});

test('queued and running jobs restore ready with an interrupted-run issue', () => {
  for (const status of ['queued', 'running']) {
    const graph = serializeWorkspace([simpleJob({ status })], { registry: createBlobIdentityRegistry(ids()) });
    assert.equal(graph.projects[0].status, 'interrupted');
    const restored = hydrateWorkspace(graph);
    assert.equal(restored.jobs[0].status, 'ready');
    assert.equal(restored.jobs[0].progress, 0);
    assert.equal(restored.jobs[0].speed, null);
    assert.deepEqual(restored.jobs[0].log, []);
    assert.ok(restored.issues.some((issue) => issue.code === 'interrupted-run'));
  }
});

test('a probing source with metadata becomes ready; one without metadata remains probing', () => {
  const withInfo = serializeWorkspace([simpleJob({ id: 'known', status: 'probing' })], {
    registry: createBlobIdentityRegistry(ids()),
  });
  const withoutInfo = serializeWorkspace([simpleJob({ id: 'unknown', status: 'probing', info: null })], {
    registry: createBlobIdentityRegistry(ids()),
  });

  assert.equal(hydrateWorkspace(withInfo).jobs[0].status, 'ready');
  assert.equal(hydrateWorkspace(withoutInfo).jobs[0].status, 'probing');
});

test('a missing source Blob produces a metadata-only project that can be relinked', () => {
  const registry = createBlobIdentityRegistry(ids());
  const graph = serializeWorkspace([simpleJob()], { registry });
  const originalBlobId = graph.assets[0].blobId;
  graph.blobs = [];
  const restored = hydrateWorkspace(graph, { registry });
  const job = restored.jobs[0];

  assert.equal(job.file, null);
  assert.equal(job.needsRelink, true);
  assert.equal(job.status, 'failed');
  assert.equal(job.lastModified, 1_700_000_000_000);
  assert.match(job.error, /Volvé a vincularlos/);
  assert.ok(restored.issues.some((issue) => issue.code === 'missing-asset-blob'));

  const stillMetadataOnly = serializeWorkspace([job], { registry });
  assert.equal(stillMetadataOnly.assets[0].blobId, originalBlobId);
  assert.equal(stillMetadataOnly.blobs.length, 0);

  const replacement = file('replacement', job.name, 'video/mp4', 999);
  job.file = replacement;
  job.size = replacement.size;
  const relinked = serializeWorkspace([job], { registry });
  assert.notEqual(relinked.assets[0].blobId, originalBlobId);
  assert.equal(relinked.blobs[0].data, replacement);
});

test('replacing a hydrated Blob allocates a new key so native IDB writes new bytes', async () => {
  const registry = createBlobIdentityRegistry(ids());
  const original = serializeWorkspace([simpleJob()], { registry });
  const originalBlobId = original.assets[0].blobId;
  const job = hydrateWorkspace(original, { registry }).jobs[0];
  const replacement = file('NEW source bytes', job.name, job.type, job.lastModified);

  job.file = replacement;
  job.size = replacement.size;
  const changed = serializeWorkspace([job], { registry });

  assert.notEqual(changed.assets[0].blobId, originalBlobId);
  assert.equal(changed.blobs[0].id, changed.assets[0].blobId);
  assert.equal(await changed.blobs[0].data.text(), 'NEW source bytes');
});

test('a missing result is dropped without making the editable source unusable', () => {
  const output = new Blob(['done'], { type: 'video/mp4' });
  const graph = serializeWorkspace([
    simpleJob({ status: 'done', outputs: [{ name: 'done.mp4', blob: output }] }),
  ], { registry: createBlobIdentityRegistry(ids()) });
  graph.blobs = graph.blobs.filter((record) => record.ownerType !== 'output');

  const restored = hydrateWorkspace(graph);
  assert.equal(restored.jobs[0].file.name, 'holiday.mp4');
  assert.equal(restored.jobs[0].outputs, null);
  assert.equal(restored.jobs[0].status, 'ready');
  assert.ok(restored.issues.some((issue) => issue.code === 'missing-output-blob'));
});

test('a partially missing multi-output result is discarded instead of restoring a misleading archive', () => {
  const graph = serializeWorkspace([
    simpleJob({
      status: 'done',
      downloadName: 'frames.zip',
      outputs: [
        { name: 'frame-001.png', blob: new Blob(['one'], { type: 'image/png' }) },
        { name: 'frame-002.png', blob: new Blob(['two'], { type: 'image/png' }) },
      ],
    }),
  ], { registry: createBlobIdentityRegistry(ids()) });
  const missingOutput = graph.outputs[1];
  graph.blobs = graph.blobs.filter((record) => record.id !== missingOutput.blobId);

  const restored = hydrateWorkspace(graph);
  const job = restored.jobs[0];
  const incomplete = restored.issues.find((issue) => issue.code === 'incomplete-result');

  assert.deepEqual(job.resultHistory, []);
  assert.equal(job.outputs, null);
  assert.equal(job.status, 'ready');
  assert.equal(incomplete.projectId, job.id);
  assert.equal(incomplete.expectedOutputCount, 2);
  assert.equal(incomplete.availableOutputCount, 1);
  assert.deepEqual(incomplete.missingOutputIds, [missingOutput.id]);
});

test('a corrupt nested result history is isolated to its project and protects the workspace', () => {
  const graph = serializeWorkspace([
    simpleJob({ id: 'healthy-project', name: 'healthy.mp4' }),
    simpleJob({
      id: 'corrupt-project',
      name: 'corrupt.mp4',
      status: 'done',
      downloadName: 'corrupt-result.mp4',
      outputs: [{ name: 'corrupt-result.mp4', blob: new Blob(['result'], { type: 'video/mp4' }) }],
    }),
  ], { registry: createBlobIdentityRegistry(ids()) });
  const corruptProject = graph.projects.find((project) => project.id === 'corrupt-project');
  corruptProject.resultHistory.push({ ...corruptProject.resultHistory[0] });

  const restored = hydrateWorkspace(graph);
  const healthy = restored.jobs.find((job) => job.id === 'healthy-project');
  const corrupt = restored.jobs.find((job) => job.id === 'corrupt-project');
  const issue = restored.issues.find((entry) => (
    entry.code === 'invalid-record' && entry.store === 'resultHistory'
  ));

  assert.equal(restored.jobs.length, 2);
  assert.ok(healthy.file);
  assert.ok(corrupt.file);
  assert.deepEqual(corrupt.resultHistory, []);
  assert.equal(corrupt.outputs, null);
  assert.equal(corrupt.status, 'ready');
  assert.equal(issue.projectId, 'corrupt-project');
  assert.equal(issue.causeCode, 'duplicate-result-id');
});

test('a future result-history schema is preserved behind the protected workspace gate', () => {
  const graph = serializeWorkspace([
    simpleJob({
      id: 'future-result-project',
      status: 'done',
      downloadName: 'future.mp3',
      outputs: [{ name: 'future.mp3', blob: new Blob(['future'], { type: 'audio/mpeg' }) }],
    }),
  ], { registry: createBlobIdentityRegistry(ids()) });
  graph.projects[0].resultHistory[0].schemaVersion = 2;

  const restored = hydrateWorkspace(graph);
  const issue = restored.issues.find((entry) => entry.code === 'unsupported-schema');

  assert.equal(restored.jobs.length, 1);
  assert.deepEqual(restored.jobs[0].resultHistory, []);
  assert.equal(restored.jobs[0].outputs, null);
  assert.equal(issue.store, 'resultHistory');
  assert.equal(issue.projectId, 'future-result-project');
  assert.equal(issue.schemaVersion, 2);
});

test('newer schemas and malformed records are reported instead of crashing restore', () => {
  const restored = hydrateWorkspace({
    projects: [
      { id: 'future', schemaVersion: PROJECT_SCHEMA_VERSION + 1, kind: 'simple' },
      null,
    ],
    assets: [],
    outputs: [],
    blobs: [],
    meta: { selectedId: 'future' },
  });

  assert.deepEqual(restored.jobs, []);
  assert.ok(restored.issues.some((issue) => issue.code === 'newer-schema'));
  assert.ok(restored.issues.some((issue) => issue.code === 'invalid-record'));
  assert.ok(restored.issues.some((issue) => issue.code === 'selected-project-missing'));
});

test('cyclic corrupt metadata is isolated to issues and safe defaults on restore', () => {
  const graph = serializeWorkspace([simpleJob()], { registry: createBlobIdentityRegistry(ids()) });
  const corruptInfo = {};
  corruptInfo.self = corruptInfo;
  const corruptOptions = {};
  corruptOptions.self = corruptOptions;
  graph.assets[0].info = corruptInfo;
  graph.projects[0].options = corruptOptions;

  const restored = hydrateWorkspace(graph);
  assert.equal(restored.jobs.length, 1);
  assert.equal(restored.jobs[0].info, null);
  assert.deepEqual(restored.jobs[0].options, {});
  assert.equal(restored.jobs[0].status, 'probing');
  assert.equal(restored.issues.filter((issue) => issue.code === 'corrupt-data').length, 2);
});

test('cyclic or executable option state fails with a stable validation code', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => serializeWorkspace([simpleJob({ options: cyclic })]),
    (error) => error instanceof ProjectStoreError && error.code === 'validation-failed',
  );
  assert.throws(
    () => serializeWorkspace([simpleJob({ options: { callback() {} } })]),
    (error) => error instanceof ProjectStoreError && error.code === 'validation-failed',
  );
});

test('repository saves and restores an entire selected workspace', async () => {
  const backend = createMemoryProjectBackend();
  const writer = storeWith(backend);
  const jobs = [simpleJob(), mergeJob(), addAudioJob()];

  const saved = await writer.saveWorkspace(jobs, { selectedId: 'project-merge' });
  assert.equal(saved.saved, true);
  assert.equal(saved.storageRevision, 1);
  assert.equal(saved.metadataOnly, false);

  writer.close();
  const reader = storeWith(backend);
  const restored = await reader.loadWorkspace();
  assert.deepEqual(restored.jobs.map((job) => job.id), jobs.map((job) => job.id));
  assert.equal(restored.selectedId, 'project-merge');
  assert.equal(restored.storageRevision, 1);
  assert.deepEqual(restored.issues, []);
  reader.close();
});

test('queue position survives equal timestamps and non-lexical project ids', async () => {
  const backend = createMemoryProjectBackend();
  const store = storeWith(backend);
  const jobs = [
    simpleJob({ id: 'z-last-lexically' }),
    simpleJob({ id: 'a-first-lexically', file: file('two', 'two.mp4'), name: 'two.mp4' }),
    simpleJob({ id: 'm-middle', file: file('three', 'three.mp4'), name: 'three.mp4' }),
  ];
  await store.saveWorkspace(jobs);

  assert.deepEqual(
    backend.snapshot().projects.map((project) => project.position),
    [0, 1, 2],
  );
  assert.deepEqual(
    (await store.loadWorkspace()).jobs.map((job) => job.id),
    jobs.map((job) => job.id),
  );
  store.close();
});

test('saveWorkspace also accepts the { jobs, selectedId } integration shape', async () => {
  const store = storeWith(createMemoryProjectBackend());
  await store.saveWorkspace({ jobs: [simpleJob()], selectedId: 'project-simple' });
  const restored = await store.loadWorkspace();
  assert.equal(restored.selectedId, 'project-simple');
  store.close();
});

test('quota failure falls back atomically to metadata and relink state', async () => {
  const backend = createMemoryProjectBackend({ quotaBytes: 2 });
  const store = storeWith(backend);
  const saved = await store.saveWorkspace([simpleJob()], {
    selectedId: 'project-simple',
    allowMetadataFallback: true,
  });

  assert.equal(saved.metadataOnly, true);
  assert.ok(saved.issues.some((issue) => issue.code === 'quota-metadata-only'));
  const snapshot = backend.snapshot();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.blobs.length, 0);
  const restored = await store.loadWorkspace();
  assert.equal(restored.jobs[0].needsRelink, true);
  store.close();
});

test('quota fallback preserves the previous durable output when a replacement does not fit', async () => {
  const backend = createMemoryProjectBackend({ quotaBytes: 25 });
  const store = storeWith(backend);
  const job = simpleJob({ file: file('1234567890', 'ten.mp4') });
  job.name = job.file.name;
  job.size = job.file.size;
  job.status = 'done';
  job.outputs = [{ name: 'old.mp4', blob: new Blob(['12345']) }];
  await store.saveWorkspace([job]);

  job.outputs = [{ name: 'large.mp4', blob: new Blob(['abcdefghijklmnop']) }];
  const saved = await store.saveWorkspace([job]);
  assert.equal(saved.metadataOnly, true);
  assert.ok(saved.issues.some((issue) => issue.code === 'quota-last-output-preserved'));

  const snapshot = backend.snapshot();
  assert.equal(snapshot.blobs.length, 2);
  assert.ok(snapshot.blobs.some((record) => record.ownerType === 'asset'));
  assert.ok(snapshot.blobs.some((record) => record.ownerType === 'output'));
  const restored = await store.loadWorkspace();
  assert.ok(restored.jobs[0].file);
  assert.equal(restored.jobs[0].outputs[0].name, 'old.mp4');
  assert.equal(await restored.jobs[0].outputs[0].blob.text(), '12345');
  assert.equal(restored.jobs[0].status, 'ready');
  store.close();
});

test('quota preflight falls back before attempting a binary transaction', async () => {
  const memory = createMemoryProjectBackend();
  const attemptedBlobCounts = [];
  const backend = {
    ...memory,
    async saveGraph(graph, options) {
      attemptedBlobCounts.push(graph.blobs.length);
      return memory.saveGraph(graph, options);
    },
  };
  const storageManager = {
    async estimate() { return { usage: 95, quota: 100 }; },
  };
  const source = file('123456', 'six.mp4');
  const job = simpleJob({ file: source, name: source.name, size: source.size });
  const store = storeWith(backend, { storageManager });

  const saved = await store.saveWorkspace([job]);

  assert.equal(saved.metadataOnly, true);
  assert.deepEqual(attemptedBlobCounts, [0]);
  assert.deepEqual(saved.quotaPreflight, {
    checked: true,
    newBlobCount: 1,
    requiredBytes: 6,
    usage: 95,
    quota: 100,
    availableBytes: 5,
    projectedUsage: 101,
    insufficient: true,
  });
  const issue = saved.issues.find((entry) => entry.code === 'quota-metadata-only');
  assert.equal(issue.preflight, true);
  assert.equal(issue.requiredBytes, 6);
  assert.equal(issue.availableBytes, 5);
  assert.equal(memory.snapshot().blobs.length, 0);
  store.close();
});

test('quota preflight returns the stable error without writing when fallback is disabled', async () => {
  const memory = createMemoryProjectBackend();
  let saveCalls = 0;
  const backend = {
    ...memory,
    async saveGraph(graph, options) {
      saveCalls += 1;
      return memory.saveGraph(graph, options);
    },
  };
  const store = storeWith(backend, {
    storageManager: { async estimate() { return { usage: 95, quota: 100 }; } },
  });
  const source = file('123456', 'six.mp4');

  await assert.rejects(
    store.saveWorkspace([
      simpleJob({ file: source, name: source.name, size: source.size }),
    ], { allowMetadataFallback: false }),
    (error) => error.code === 'quota-exceeded'
      && isQuotaExceededError(error)
      && error.details.preflight === true
      && error.details.requiredBytes === 6
      && error.details.availableBytes === 5,
  );
  assert.equal(saveCalls, 0);
  store.close();
});

test('quota preflight preserves the exact-fit boundary', async () => {
  const memory = createMemoryProjectBackend();
  const attemptedBlobCounts = [];
  const backend = {
    ...memory,
    async saveGraph(graph, options) {
      attemptedBlobCounts.push(graph.blobs.length);
      return memory.saveGraph(graph, options);
    },
  };
  const store = storeWith(backend, {
    storageManager: { async estimate() { return { usage: 95, quota: 100 }; } },
  });
  const source = file('12345', 'five.mp4');

  const saved = await store.saveWorkspace([
    simpleJob({ file: source, name: source.name, size: source.size }),
  ]);

  assert.equal(saved.metadataOnly, false);
  assert.equal(saved.quotaPreflight.insufficient, false);
  assert.equal(saved.quotaPreflight.requiredBytes, 5);
  assert.equal(saved.quotaPreflight.availableBytes, 5);
  assert.deepEqual(attemptedBlobCounts, [1]);
  assert.equal(memory.snapshot().blobs.length, 1);
  store.close();
});

test('quota preflight does not count a durable Blob again on metadata autosave', async () => {
  const backend = createMemoryProjectBackend();
  let reported = { usage: 0, quota: 100 };
  let estimateCalls = 0;
  const storageManager = {
    async estimate() {
      estimateCalls += 1;
      return reported;
    },
  };
  const source = file('12345', 'five.mp4');
  const job = simpleJob({ file: source, name: source.name, size: source.size });
  const store = storeWith(backend, { storageManager });
  await store.saveWorkspace([job]);

  reported = { usage: 100, quota: 100 };
  job.options.quality = 'high';
  const saved = await store.saveWorkspace([job]);

  assert.equal(saved.metadataOnly, false);
  assert.equal(saved.quotaPreflight, null);
  assert.equal(estimateCalls, 1);
  assert.equal(backend.snapshot().blobs.length, 1);
  store.close();
});

test('quota preflight uses the same fallback that retains the last durable output', async () => {
  const backend = createMemoryProjectBackend();
  let reported = { usage: 0, quota: 1_000 };
  const store = storeWith(backend, {
    storageManager: { async estimate() { return reported; } },
  });
  const source = file('1234567890', 'ten.mp4');
  const job = simpleJob({
    file: source,
    name: source.name,
    size: source.size,
    status: 'done',
    outputs: [{ name: 'old.mp4', blob: new Blob(['12345']) }],
  });
  await store.saveWorkspace([job]);

  reported = { usage: 995, quota: 1_000 };
  job.outputs = [{ name: 'new.mp4', blob: new Blob(['abcdefghijklmnop']) }];
  const saved = await store.saveWorkspace([job]);

  assert.equal(saved.metadataOnly, true);
  assert.equal(saved.quotaPreflight.requiredBytes, 16);
  assert.ok(saved.issues.some((issue) => (
    issue.code === 'quota-last-output-preserved' && issue.preflight === true
  )));
  const restored = await store.loadWorkspace();
  assert.equal(restored.jobs[0].outputs[0].name, 'old.mp4');
  assert.equal(await restored.jobs[0].outputs[0].blob.text(), '12345');
  store.close();
});

test('quota errors have a stable public code when fallback is disabled', async () => {
  const store = storeWith(createMemoryProjectBackend({ quotaBytes: 1 }));
  await assert.rejects(
    store.saveWorkspace([simpleJob()], { allowMetadataFallback: false }),
    (error) => error.code === 'quota-exceeded' && isQuotaExceededError(error),
  );
  store.close();
});

test('storageRevision compare-and-swap prevents a stale tab from overwriting newer state', async () => {
  const backend = createMemoryProjectBackend();
  const first = storeWith(backend);
  const second = storeWith(backend);
  await first.loadWorkspace();
  await second.loadWorkspace();

  await first.saveWorkspace([simpleJob()]);
  await assert.rejects(
    second.saveWorkspace([simpleJob({ options: { format: 'webm-vp8' } })]),
    (error) => error.code === 'conflict'
      && error.details.expectedStorageRevision === 0
      && error.details.actualStorageRevision === 1,
  );
  first.close();
  second.close();
});

test('storageRevision compare-and-swap prevents a stale tab from deleting newer state', async () => {
  const backend = createMemoryProjectBackend();
  const writer = storeWith(backend);
  const stale = storeWith(backend);
  await writer.loadWorkspace();
  await stale.loadWorkspace();
  await writer.saveWorkspace([simpleJob()]);

  await assert.rejects(
    stale.deleteProject('project-simple'),
    (error) => error.code === 'conflict'
      && error.details.expectedStorageRevision === 0
      && error.details.actualStorageRevision === 1,
  );
  assert.deepEqual(backend.snapshot().projects.map((project) => project.id), ['project-simple']);
  writer.close();
  stale.close();
});

test('deleteProject removes its metadata and bytes without touching other projects', async () => {
  const backend = createMemoryProjectBackend();
  const store = storeWith(backend);
  await store.saveWorkspace([
    simpleJob({ id: 'keep' }),
    simpleJob({ id: 'delete', file: file('other', 'other.mp4'), name: 'other.mp4' }),
  ], { selectedId: 'delete' });

  const removed = await store.deleteProject('delete');
  assert.equal(removed.deleted, true);
  const snapshot = backend.snapshot();
  assert.deepEqual(snapshot.projects.map((record) => record.id), ['keep']);
  assert.deepEqual(new Set(snapshot.assets.map((record) => record.projectId)), new Set(['keep']));
  assert.deepEqual(new Set(snapshot.blobs.map((record) => record.projectId)), new Set(['keep']));
  assert.equal(snapshot.meta.selectedId, null);
  store.close();
});

test('orphan cleanup removes dangling descriptors and unreferenced bytes', async () => {
  const backend = createMemoryProjectBackend();
  await backend.open();
  const orphanBlob = new Blob(['orphan']);
  await backend.saveGraph({
    projects: [],
    assets: [{
      id: 'orphan-asset', schemaVersion: 1, projectId: 'missing', role: 'source', position: 0,
      blobId: 'orphan-blob', name: 'lost.mp4', size: orphanBlob.size, type: 'video/mp4',
      lastModified: 0, info: null, status: 'pending',
    }],
    outputs: [],
    blobs: [{
      id: 'orphan-blob', projectId: 'missing', ownerType: 'asset', ownerId: 'orphan-asset',
      size: orphanBlob.size, type: '', data: orphanBlob,
    }],
    meta: { key: 'workspace', selectedId: null, schemaVersion: 1 },
  }, { replace: false });

  const removed = await backend.cleanupOrphans();
  assert.deepEqual(removed, { assets: 1, outputs: 0, blobs: 1 });
  assert.equal(backend.snapshot().assets.length, 0);
  assert.equal(backend.snapshot().blobs.length, 0);
});

test('clear removes projects atomically and advances the conflict revision', async () => {
  const backend = createMemoryProjectBackend();
  const store = storeWith(backend);
  await store.saveWorkspace([simpleJob()], { selectedId: 'project-simple' });
  const result = await store.clear();
  assert.equal(result.cleared, true);
  assert.equal(result.storageRevision, 2);
  const snapshot = backend.snapshot();
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.assets.length, 0);
  assert.equal(snapshot.outputs.length, 0);
  assert.equal(snapshot.blobs.length, 0);
  assert.equal(snapshot.meta.selectedId, null);
  assert.equal(snapshot.meta.storageRevision, 2);
  store.close();
});

test('a stale tab cannot clear a workspace saved by another tab', async () => {
  const backend = createMemoryProjectBackend();
  const writer = storeWith(backend);
  const stale = storeWith(backend);
  await writer.loadWorkspace();
  await stale.loadWorkspace();
  await writer.saveWorkspace([simpleJob()]);

  await assert.rejects(
    stale.clear(),
    (error) => error.code === 'conflict'
      && error.details.expectedStorageRevision === 0
      && error.details.actualStorageRevision === 1,
  );
  assert.deepEqual(backend.snapshot().projects.map((project) => project.id), ['project-simple']);
  writer.close();
  stale.close();
});

test('metadata-only records do not inflate managed byte estimates', async () => {
  const backend = createMemoryProjectBackend({ quotaBytes: 0 });
  const store = storeWith(backend);
  await store.saveWorkspace([simpleJob()]);
  const estimate = await store.estimate();
  assert.equal(estimate.sourceBytes, 0);
  assert.equal(estimate.outputBytes, 0);
  assert.equal(estimate.managedBytes, 0);
  store.close();
});

test('estimate combines browser quota with project-owned byte accounting', async () => {
  const backend = createMemoryProjectBackend();
  const storageManager = {
    async estimate() { return { usage: 40, quota: 100 }; },
    async persisted() { return true; },
  };
  const store = storeWith(backend, { storageManager });
  const job = simpleJob({ file: file('12345', 'five.mp4') });
  job.name = job.file.name;
  job.size = job.file.size;
  job.outputs = [{ name: 'two.mp4', blob: new Blob(['12']) }];
  job.status = 'done';
  await store.saveWorkspace([job]);

  const estimate = await store.estimate();
  assert.deepEqual(estimate, {
    usage: 40,
    quota: 100,
    available: 60,
    persisted: true,
    managedBytes: 7,
    sourceBytes: 5,
    outputBytes: 2,
  });
  store.close();
});

test('requestPersistence reports unsupported, existing and newly granted modes', async () => {
  const unsupported = storeWith(createMemoryProjectBackend(), { storageManager: {} });
  assert.deepEqual(await unsupported.requestPersistence(), { supported: false, persisted: false });
  unsupported.close();

  const existing = storeWith(createMemoryProjectBackend(), {
    storageManager: { async persisted() { return true; }, async persist() { throw new Error('not called'); } },
  });
  assert.deepEqual(await existing.requestPersistence(), { supported: true, persisted: true });
  existing.close();

  let requested = 0;
  const granted = storeWith(createMemoryProjectBackend(), {
    storageManager: {
      async persisted() { return false; },
      async persist() { requested += 1; return true; },
    },
  });
  assert.deepEqual(await granted.requestPersistence(), { supported: true, persisted: true });
  assert.equal(requested, 1);
  granted.close();
});

test('subscribers receive local invalidations without filenames or project contents', async () => {
  const store = storeWith(createMemoryProjectBackend());
  const events = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  await store.saveWorkspace([simpleJob()]);
  unsubscribe();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'workspace-changed');
  assert.equal(events[0].local, true);
  assert.equal(events[0].storageRevision, 1);
  assert.equal('jobs' in events[0], false);
  assert.equal('name' in events[0], false);
  store.close();
});
