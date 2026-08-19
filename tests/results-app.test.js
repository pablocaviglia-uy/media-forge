import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import { DEFAULT_OPTIONS } from '../src/media/commands.js';

const mediaInfo = {
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  formats: ['mov', 'mp4'],
  duration: 4,
  bitrate: 800_000,
  hasVideo: true,
  hasAudio: true,
  video: { codec: 'h264', width: 320, height: 180, fps: 24, duration: 4 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48_000, duration: 4 },
  streams: [],
};

function appForResults(payloads) {
  const app = Object.create(App.prototype);
  let index = 0;
  Object.assign(app, {
    jobs: [],
    selectedId: null,
    running: null,
    runningId: null,
    stopRequested: false,
    quickOutputPreview: null,
    generatedResults: null,
    engine: {
      start(plan) {
        const bytes = new TextEncoder().encode(payloads[index++]);
        return {
          finished: Promise.resolve({
            outputs: [{ name: plan.outputs[0], bytes }],
          }),
          cancel() {},
        };
      },
    },
    paintQueue() {},
    paintDetail() {},
    scheduleProjectSave() {},
    appendLog() {},
    updateQuickProgress() {},
    updateMergeProgress() {},
    updateAddAudioProgress() {},
    toast() {},
  });
  return app;
}

test('successful reruns append persistent result generations instead of replacing the first output', async () => {
  const app = appForResults(['first mp3', 'second mp3']);
  const file = { name: 'concert.mp4', size: 1_024, type: 'video/mp4' };
  const job = {
    id: 'result-project',
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    info: mediaInfo,
    status: 'ready',
    operation: 'extract-audio',
    options: { ...DEFAULT_OPTIONS, audioFormat: 'mp3', trimStart: 1, trimEnd: 3 },
    progress: 0,
    speed: null,
    remaining: null,
    resultHistory: [],
    selectedResultId: null,
    outputs: null,
    error: null,
    log: [],
    previewMode: 'source',
  };
  app.jobs.push(job);

  await app.runJob(job);
  const firstId = job.resultHistory[0].id;
  const firstBlob = job.resultHistory[0].outputs[0].blob;

  job.status = 'queued';
  job.options.audioBitrate = 128;
  await app.runJob(job);

  assert.equal(job.status, 'done');
  assert.equal(job.previewMode, 'result');
  assert.equal(job.resultHistory.length, 2);
  assert.notEqual(job.resultHistory[1].id, firstId);
  assert.equal(await firstBlob.text(), 'first mp3');
  assert.equal(await job.outputs[0].blob.text(), 'second mp3');
  assert.equal(job.outputs, job.resultHistory[1].outputs);
  assert.equal(job.selectedResultId, job.resultHistory[1].id);
  assert.equal(job.resultHistory[1].metadata.duration, 2);
  assert.equal(job.resultHistory[1].metadata.mime, 'audio/mpeg');
  assert.equal(job.resultHistory[1].metadata.format, 'MP3');
  assert.equal(job.resultHistory[1].metadata.codec, 'libmp3lame');
  assert.equal(job.resultHistory[1].metadata.bitrate, 128_000);
});

test('browsing an older generation never changes the compatibility download alias', () => {
  const app = appForResults([]);
  const newestOutputs = [{ id: 'out-new', name: 'new.mp3', blob: new Blob(['new'], { type: 'audio/mpeg' }) }];
  const job = {
    id: 'history-project',
    outputs: newestOutputs,
    downloadName: 'new.mp3',
    outputSize: 3,
    selectedResultId: 'old',
    resultHistory: [
      {
        id: 'old', schemaVersion: 1, projectId: 'history-project', createdAt: 1,
        operation: 'extract-audio', forgeToolId: null, revision: null, options: {}, metadata: {},
        downloadName: 'old.mp3', mediaKind: 'audio', totalSize: 3,
        outputIds: ['out-old'],
        outputs: [{ id: 'out-old', name: 'old.mp3', blob: new Blob(['old'], { type: 'audio/mpeg' }) }],
      },
      {
        id: 'new', schemaVersion: 1, projectId: 'history-project', createdAt: 2,
        operation: 'extract-audio', forgeToolId: null, revision: null, options: {}, metadata: {},
        downloadName: 'new.mp3', mediaKind: 'audio', totalSize: 3,
        outputIds: ['out-new'], outputs: newestOutputs,
      },
    ],
  };

  const history = app.resultHistoryFor(job);
  assert.equal(history.selectedResultId, 'old');
  assert.equal(job.downloadName, 'new.mp3');
  assert.equal(job.outputs, newestOutputs);
});

test('removing one generated version is confirmed, preserves siblings and frees the last result cleanly', async () => {
  const app = appForResults(['first mp3', 'second mp3']);
  const file = { name: 'concert.mp4', size: 1_024, type: 'video/mp4' };
  const job = {
    id: 'removable-results',
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    info: mediaInfo,
    status: 'ready',
    operation: 'extract-audio',
    options: { ...DEFAULT_OPTIONS, audioFormat: 'mp3' },
    progress: 0,
    speed: null,
    remaining: null,
    resultHistory: [],
    selectedResultId: null,
    outputs: null,
    error: null,
    log: [],
    previewMode: 'source',
  };
  app.jobs.push(job);
  app.selectedId = job.id;

  await app.runJob(job);
  job.status = 'queued';
  await app.runJob(job);
  const [first, second] = job.resultHistory;
  const saves = [];
  app.confirm = async () => true;
  app.releaseGeneratedResults = () => {};
  app.scheduleProjectSave = (options) => saves.push(options);

  await app.removeGeneratedResult(job, first.id);
  assert.deepEqual(job.resultHistory.map((result) => result.id), [second.id]);
  assert.equal(job.outputs, job.resultHistory[0].outputs);
  assert.equal(await job.outputs[0].blob.text(), 'second mp3');
  assert.equal(job.status, 'done');

  await app.removeGeneratedResult(job, second.id);
  assert.equal(job.resultHistory.length, 0);
  assert.equal(job.outputs, null);
  assert.equal(job.downloadName, null);
  assert.equal(job.outputSize, 0);
  assert.equal(job.status, 'ready');
  assert.equal(job.previewMode, 'source');
  assert.deepEqual(saves, [
    { immediate: true, force: true },
    { immediate: true, force: true },
  ]);
});
