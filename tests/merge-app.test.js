import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import {
  MERGE_MAX_CLIPS,
  MERGE_SAFE_BYTES,
  createMergeSnapshot,
} from '../src/media/merge.js';

const file = (name, size = 1024, type = 'video/mp4') => ({ name, size, type });

const mediaInfo = ({ duration = 2, audio = true, width = 640, height = 360 } = {}) => ({
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  formats: ['mov', 'mp4'],
  duration,
  hasVideo: true,
  hasAudio: audio,
  video: { codec: 'h264', width, height, fps: 30 },
  audio: audio ? { codec: 'aac', channels: 2, sampleRate: 48_000 } : null,
  streams: [],
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function appWithoutDom(engine = {}) {
  const app = Object.create(App.prototype);
  Object.assign(app, {
    engine,
    jobs: [],
    selectedId: null,
    running: null,
    runningId: null,
    stopRequested: false,
    chain: Promise.resolve(),
    pickerIntent: null,
    nextPickerToken: 1,
    mergeSourcePreview: null,
    mergeSequence: null,
    quickOutputPreview: null,
    paintQueue() {},
    paintDetail() {},
    scheduleCommandPreview() {},
    appendLog() {},
    updateQuickProgress() {},
    updateMergeProgress() {},
    toast() {},
  });
  return app;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('addMergeProject creates one composite job and probes clips strictly in sequence', async () => {
  const intro = file('intro.mov', 100);
  const ending = file('ending.mp4', 200);
  const gates = new Map([
    [intro, deferred()],
    [ending, deferred()],
  ]);
  const calls = [];
  let activeProbes = 0;
  let peakProbes = 0;
  const app = appWithoutDom({
    async probe(source) {
      calls.push(source.name);
      activeProbes += 1;
      peakProbes = Math.max(peakProbes, activeProbes);
      try {
        return await gates.get(source).promise;
      } finally {
        activeProbes -= 1;
      }
    },
  });

  const job = app.addMergeProject([intro, ending]);

  assert.equal(app.jobs.length, 1);
  assert.equal(app.jobs[0], job);
  assert.equal(app.selectedId, job.id);
  assert.equal(job.operation, 'join-videos');
  assert.equal(job.forgeToolId, 'video-merge');
  assert.equal(job.status, 'probing');
  assert.deepEqual(job.clips.map((clip) => clip.file), [intro, ending]);

  await flushMicrotasks();
  assert.deepEqual(calls, ['intro.mov']);

  gates.get(intro).resolve(mediaInfo({ duration: 1.25 }));
  await flushMicrotasks();
  assert.deepEqual(calls, ['intro.mov', 'ending.mp4']);

  gates.get(ending).resolve(mediaInfo({ duration: 2.75, audio: false }));
  await app.chain;

  assert.equal(peakProbes, 1);
  assert.equal(job.status, 'ready');
  assert.equal(job.info.clipCount, 2);
  assert.equal(job.info.duration, 4);
  assert.equal(job.info.hasAudio, true);
  assert.equal(job.validationError, null);
  assert.deepEqual(job.clips.map((clip) => clip.status), ['ready', 'ready']);
});

test('append, reorder and remove edit the same merge project with stable clip identity', async () => {
  const first = file('first.mp4', 100);
  const second = file('second.mp4', 200);
  const third = file('third.webm', 300, 'video/webm');
  const app = appWithoutDom({
    async probe(source) {
      return mediaInfo({ duration: source === third ? 3 : 1 });
    },
  });
  const job = app.addMergeProject([first, second]);
  await app.chain;
  const originalIds = job.clips.map((clip) => clip.id);

  const [added] = app.appendMergeFiles(job, [third]);
  await app.chain;

  assert.equal(app.jobs.length, 1);
  assert.equal(app.jobs[0], job);
  assert.equal(job.selectedClipId, added.id);
  assert.deepEqual(job.clips.map((clip) => clip.file), [first, second, third]);
  assert.equal(job.revision, 1);

  app.moveMergeClip(job, added.id, 0);
  assert.deepEqual(job.clips.map((clip) => clip.file), [third, first, second]);
  assert.equal(job.clips[0].id, added.id);
  assert.deepEqual(job.clips.slice(1).map((clip) => clip.id), originalIds);
  assert.equal(job.revision, 2);

  app.removeMergeClip(job, added.id);
  assert.deepEqual(job.clips.map((clip) => clip.file), [first, second]);
  assert.equal(job.selectedClipId, originalIds[0]);
  assert.equal(job.revision, 3);
  assert.equal(job.status, 'ready');
  assert.equal(job.info.duration, 2);
  assert.equal(job.validationError, null);
});

test('runJob sends the immutable queued snapshot to the engine in its captured order', async () => {
  const first = file('first.mov', 100);
  const second = file('second.webm', 200, 'video/webm');
  const third = file('third.mp4', 300);
  let started = null;
  const app = appWithoutDom({
    async probe(source) {
      return mediaInfo({ duration: source === second ? 2 : 1, audio: source !== third });
    },
    start(plan, files, handlers) {
      started = { plan, files, handlers };
      return {
        finished: Promise.resolve({
          outputs: [{ name: 'output.mp4', bytes: new Uint8Array([1, 2, 3]) }],
        }),
        cancel() {},
      };
    },
  });
  const job = app.addMergeProject([first, second, third]);
  await app.chain;

  app.moveMergeClip(job, job.clips[2].id, 0);
  assert.deepEqual(job.clips.map((clip) => clip.file), [third, first, second]);

  job.pendingMergeSnapshot = createMergeSnapshot(job);
  job.status = 'queued';

  // A later accidental mutation of live editor state must not alter what the
  // already queued export consumes. The UI normally blocks this mutation;
  // doing it directly here proves the run boundary really is a snapshot.
  job.clips.reverse();
  await app.runJob(job);

  assert.ok(started);
  assert.deepEqual(started.files, [third, first, second]);
  assert.deepEqual(started.plan.inputNames, ['input-000.mp4', 'input-001.mov', 'input-002.webm']);
  assert.equal(started.plan.operation, 'join-videos');
  assert.equal(started.plan.duration, 4);
  assert.equal(job.status, 'done');
  assert.equal(job.outputs.length, 1);
  assert.equal(job.outputSize, 3);
  assert.equal(job.pendingMergeSnapshot, undefined);
});

test('merge limits reject excess bytes and cap clip count before probing', async () => {
  let probes = 0;
  const notices = [];
  const app = appWithoutDom({
    async probe() {
      probes += 1;
      return mediaInfo();
    },
  });
  app.toast = (message) => notices.push(message);

  assert.equal(app.addMergeProject([file('too-large.mp4', MERGE_SAFE_BYTES + 1)]), null);
  await app.chain;
  assert.equal(probes, 0);
  assert.match(notices.join(' '), /350 MB/);

  const many = Array.from({ length: MERGE_MAX_CLIPS + 3 }, (_, index) => file(`${index}.mp4`, 1));
  const job = app.addMergeProject(many);
  await app.chain;
  assert.equal(job.clips.length, MERGE_MAX_CLIPS);
  assert.equal(probes, MERGE_MAX_CLIPS);
  assert.match(notices.join(' '), /hasta 24 videos/);
});

test('an explicit new-tool intent cannot append to a selected merge project', async () => {
  const app = appWithoutDom({ async probe() { return mediaInfo(); } });
  const merge = app.addMergeProject([file('one.mp4'), file('two.mp4')]);
  await app.chain;
  app.setPickerIntent({ kind: 'merge-append', projectId: merge.id });

  const conversion = file('convert-me.mp4');
  app.addFiles([conversion], { forceNewJobs: true });
  await app.chain;

  assert.equal(app.pickerIntent, null);
  assert.equal(merge.clips.length, 2);
  assert.equal(app.jobs.length, 2);
  assert.equal(app.jobs[1].file, conversion);
  assert.equal(app.jobs[1].operation, 'convert');
});

test('dirty or invalid merge results are not treated as settled queue items', () => {
  const app = appWithoutDom();
  const merge = {
    operation: 'join-videos',
    clips: [],
    status: 'done',
    dirtySinceOutput: false,
    validationError: null,
  };
  assert.equal(app.jobIsSettledDone(merge), true);
  merge.dirtySinceOutput = true;
  assert.equal(app.jobIsSettledDone(merge), false);
  merge.dirtySinceOutput = false;
  merge.validationError = 'Revisar';
  assert.equal(app.jobIsSettledDone(merge), false);
  assert.equal(app.jobIsSettledDone({ status: 'done' }), true);
});
