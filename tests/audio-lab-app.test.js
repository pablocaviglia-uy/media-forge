import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import { resolveAudioLabRange } from '../src/media/audio-lab.js';

function audioResult(
  projectId,
  resultId,
  outputId,
  duration = 60,
  audioMetadata = { sampleRate: 48_000, channels: 2 },
) {
  const blob = new Blob([`${resultId}-audio`], { type: 'audio/mpeg' });
  const output = Object.freeze({
    id: outputId,
    schemaVersion: 1,
    projectId,
    resultId,
    position: 0,
    name: `${resultId}.mp3`,
    size: blob.size,
    type: blob.type,
    mediaKind: 'audio',
    blob,
  });
  return Object.freeze({
    id: resultId,
    schemaVersion: 1,
    projectId,
    createdAt: 1,
    operation: 'extract-audio',
    forgeToolId: null,
    revision: null,
    options: Object.freeze({}),
    metadata: Object.freeze({ duration, mime: 'audio/mpeg', format: 'MP3', ...audioMetadata }),
    downloadName: output.name,
    mediaKind: 'audio',
    totalSize: output.size,
    outputIds: Object.freeze([output.id]),
    outputs: Object.freeze([output]),
  });
}

function audioLabApp(results = [audioResult('project-audio', 'result-one', 'output-one')]) {
  const app = Object.create(App.prototype);
  const latest = results.at(-1);
  const saves = [];
  const toasts = [];
  const updates = [];
  const job = {
    id: 'project-audio',
    name: 'concert.mp4',
    resultHistory: results,
    selectedResultId: latest.id,
    outputs: latest.outputs,
    downloadName: latest.downloadName,
    outputSize: latest.totalSize,
    audioLabStates: {},
    audioLabSessions: {},
  };
  Object.assign(app, {
    jobs: [job],
    selectedId: job.id,
    audioPeakCache: new WeakMap(),
    audioPeakTask: null,
    scheduleProjectSave(options) { saves.push(options || {}); },
    toast(message) { toasts.push(message); },
    generatedResults: {
      jobId: job.id,
      control: { update(value) { updates.push(value); } },
    },
  });
  return { app, job, results, saves, toasts, updates };
}

test('opening an audio result creates a byte-free graph and bounded persisted session', () => {
  const { app, job, results } = audioLabApp();
  const context = app.audioLabSessionFor(job, results[0].id);

  assert.equal(context.key, 'output-one');
  assert.equal(context.state.nodes[0].outputId, 'output-one');
  assert.equal(context.state.nodes[0].resultId, 'result-one');
  assert.deepEqual(context.session.selection, { from: 0, to: 60 });
  assert.equal(context.session.loop, false);
  assert.equal(JSON.stringify(job.audioLabStates).includes('result-one-audio'), false);
  assert.equal(JSON.stringify(job.audioLabStates).includes('blob'), false);
});

test('fragments nest on the selected node and selecting an ancestor restores its range', () => {
  const { app, job, results, saves, toasts } = audioLabApp();
  const resultId = results[0].id;

  assert.equal(app.createAudioLabFragment(job, resultId, { from: 10, to: 30 }), true);
  let context = app.audioLabSessionFor(job, resultId);
  assert.equal(context.state.nodes.length, 2);
  assert.deepEqual(resolveAudioLabRange(context.state), { start: 10, end: 30, duration: 20 });

  app.setAudioLabSession(job, resultId, { selection: { from: 12, to: 18 } }, { commit: false });
  assert.equal(app.createAudioLabFragment(job, resultId, { from: 12, to: 18 }), true);
  context = app.audioLabSessionFor(job, resultId);
  assert.equal(context.state.nodes.length, 3);
  assert.deepEqual(context.state.nodes[2].range, { start: 2, end: 8 });
  assert.deepEqual(resolveAudioLabRange(context.state), { start: 12, end: 18, duration: 6 });

  assert.equal(app.selectAudioLabNode(job, resultId, context.state.rootNodeId), true);
  context = app.audioLabSessionFor(job, resultId);
  assert.deepEqual(context.session.selection, { from: 0, to: 60 });
  assert.equal(saves.filter((entry) => entry.immediate).length, 2);
  assert.equal(toasts.length, 2);
});

test('live selection is clamped to the selected fragment and saves only on commit', () => {
  const { app, job, results, saves } = audioLabApp();
  const resultId = results[0].id;
  app.createAudioLabFragment(job, resultId, { from: 20, to: 40 });
  saves.length = 0;

  const live = app.setAudioLabSession(
    job,
    resultId,
    { selection: { from: 0, to: 55 }, loop: true },
    { commit: false },
  );
  assert.deepEqual(live.session.selection, { from: 20, to: 40 });
  assert.equal(live.session.loop, true);
  assert.equal(saves.length, 0);

  app.setAudioLabSession(job, resultId, { selection: { from: 22, to: 24 } });
  assert.deepEqual(job.audioLabSessions['output-one'].selection, { from: 22, to: 24 });
  assert.equal(saves.length, 1);
});

test('waveform analysis is race-safe and only publishes the currently requested result', async () => {
  const first = audioResult('project-audio', 'result-one', 'output-one', 30);
  const second = audioResult('project-audio', 'result-two', 'output-two', 45);
  const { app, job, updates } = audioLabApp([first, second]);
  const requests = [];
  app.audioPeaksExtractor = (blob, {
    duration,
    signal,
    sampleRate,
    channels,
  }) => new Promise((resolve, reject) => {
    const request = { blob, duration, signal, sampleRate, channels, resolve, reject };
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      error.code = 'aborted';
      reject(error);
    }, { once: true });
    requests.push(request);
  });

  const firstRun = app.prepareAudioPeaks(job, first.id);
  await Promise.resolve();
  const secondRun = app.prepareAudioPeaks(job, second.id);
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].sampleRate, 48_000);
  assert.equal(requests[1].channels, 2);

  const peaks = Object.freeze([{ min: -0.5, max: 0.75 }]);
  requests[1].resolve({ status: 'ready', peaks, duration: 45 });
  assert.equal(await firstRun, null);
  assert.equal((await secondRun).peaks, peaks);
  assert.equal(app.audioPeakCache.get(first.outputs[0].blob), undefined);
  assert.equal(app.audioPeakCache.get(second.outputs[0].blob).status, 'ready');
  assert.ok(updates.some((entry) => entry.audioLabStateByResult?.['output-two']?.peaks === peaks));
});

test('removing one generation clears only its virtual Audio Lab records', () => {
  const first = audioResult('project-audio', 'result-one', 'output-one');
  const second = audioResult('project-audio', 'result-two', 'output-two');
  const { app, job } = audioLabApp([first, second]);
  app.audioLabSessionFor(job, first.id);
  app.audioLabSessionFor(job, second.id);
  job.audioLabStates[first.id] = job.audioLabStates['output-one'];
  job.audioLabSessions[first.id] = { ...job.audioLabSessions['output-one'] };

  app.clearAudioLabForResult(job, first);

  assert.deepEqual(Object.keys(job.audioLabStates), ['output-two']);
  assert.deepEqual(Object.keys(job.audioLabSessions), ['output-two']);
});
