import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';

function result(projectId, id, name, payload) {
  const blob = new Blob([payload], { type: 'audio/mpeg' });
  const output = Object.freeze({
    id: `output-${id}`,
    schemaVersion: 1,
    projectId,
    resultId: id,
    position: 0,
    name,
    size: blob.size,
    type: blob.type,
    mediaKind: 'audio',
    blob,
  });
  return Object.freeze({
    id,
    schemaVersion: 1,
    projectId,
    createdAt: id === 'old' ? 1 : 2,
    operation: 'extract-audio',
    forgeToolId: null,
    revision: null,
    options: Object.freeze({}),
    metadata: Object.freeze({ format: 'MP3', duration: 12 }),
    downloadName: name,
    mediaKind: 'audio',
    totalSize: blob.size,
    outputIds: Object.freeze([output.id]),
    outputs: Object.freeze([output]),
  });
}

function navigationApp() {
  const app = Object.create(App.prototype);
  const old = result('project-1', 'old', 'concert-128.mp3', 'old');
  const newest = result('project-1', 'new', 'concert-192.mp3', 'new');
  const job = {
    id: 'project-1',
    name: 'concert.mp4',
    size: 10_000,
    type: 'video/mp4',
    status: 'done',
    previewMode: 'result',
    resultHistory: [old, newest],
    selectedResultId: newest.id,
    outputs: newest.outputs,
    downloadName: newest.downloadName,
    outputSize: newest.totalSize,
  };
  const calls = { queue: 0, detail: 0, release: 0, save: 0 };
  Object.assign(app, {
    jobs: [job],
    selectedId: job.id,
    paintQueue() { calls.queue += 1; },
    paintDetail() { calls.detail += 1; },
    releaseGeneratedResults() { calls.release += 1; },
    scheduleProjectSave() { calls.save += 1; },
  });
  return { app, job, old, newest, calls };
}

test('opening the source returns to the original without discarding generated versions', () => {
  const { app, job, newest, calls } = navigationApp();

  assert.equal(app.selectProjectSource(job.id), true);
  assert.equal(job.previewMode, 'source');
  assert.equal(app.selectedId, job.id);
  assert.deepEqual(job.resultHistory.map((entry) => entry.id), ['old', 'new']);
  assert.equal(job.selectedResultId, newest.id);
  assert.equal(job.outputs[0].blob, newest.outputs[0].blob);
  assert.deepEqual(calls, { queue: 1, detail: 1, release: 1, save: 0 });

  // Clicking an already visible source is intentionally a no-op so playback
  // and focus are not torn down needlessly.
  assert.equal(app.selectProjectSource(job.id), true);
  assert.deepEqual(calls, { queue: 1, detail: 1, release: 1, save: 0 });
});

test('opening a derived version selects it while compatibility downloads stay on the newest result', () => {
  const { app, job, old, newest, calls } = navigationApp();
  job.previewMode = 'source';

  assert.equal(app.selectProjectResult(job.id, old.id), true);
  assert.equal(job.previewMode, 'result');
  assert.equal(job.selectedResultId, old.id);
  assert.equal(job.outputs[0].blob, newest.outputs[0].blob);
  assert.equal(job.downloadName, newest.downloadName);
  assert.deepEqual(calls, { queue: 1, detail: 1, release: 0, save: 1 });

  assert.equal(app.selectProjectResult(job.id, old.id), true);
  assert.deepEqual(calls, { queue: 1, detail: 1, release: 0, save: 1 });
});

test('unknown projects and generated versions do not mutate navigation state', () => {
  const { app, job, newest, calls } = navigationApp();

  assert.equal(app.selectProjectSource('missing'), false);
  assert.equal(app.selectProjectResult(job.id, 'missing'), false);
  assert.equal(app.selectProjectResult('missing', newest.id), false);
  assert.equal(job.previewMode, 'result');
  assert.equal(job.selectedResultId, newest.id);
  assert.deepEqual(calls, { queue: 0, detail: 0, release: 0, save: 0 });
});

test('leaving the results workspace removes its root so the source preview can be rebuilt', () => {
  const app = Object.create(App.prototype);
  const calls = { destroy: 0, remove: 0 };
  app.generatedResults = {
    jobId: 'project-1',
    control: {
      node: { remove() { calls.remove += 1; } },
      destroy() { calls.destroy += 1; },
    },
  };

  app.releaseGeneratedResults();

  assert.deepEqual(calls, { destroy: 1, remove: 1 });
  assert.equal(app.generatedResults, null);
});
