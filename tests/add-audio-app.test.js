import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import {
  ADD_AUDIO_LIMITS,
  createAddAudioAsset,
  createAddAudioSnapshot,
  markAddAudioEdited,
} from '../src/media/add-audio.js';

const MiB = 1024 * 1024;

const file = (name, size = 1024, type = 'video/mp4') => ({ name, size, type });

const videoInfo = ({ duration = 8, audio = true } = {}) => ({
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  formats: ['mov', 'mp4'],
  duration,
  bitrate: 800_000,
  startTime: 0,
  hasVideo: true,
  hasAudio: audio,
  video: {
    kind: 'video', codec: 'h264', width: 640, height: 360, fps: 30,
    duration, startTime: 0, bitrate: 650_000,
  },
  audio: audio ? {
    kind: 'audio', codec: 'aac', channels: 2, sampleRate: 48_000,
    duration, startTime: 0, bitrate: 128_000,
  } : null,
  streams: [],
});

const audioInfo = ({ duration = 3, codec = 'mp3' } = {}) => ({
  format: codec,
  formats: [codec],
  duration,
  bitrate: 128_000,
  startTime: 0,
  hasVideo: false,
  hasAudio: true,
  video: null,
  audio: {
    kind: 'audio', codec, channels: 2, sampleRate: 44_100,
    duration, startTime: 0, bitrate: 128_000,
  },
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
  const notices = [];
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
    quickOutputPreview: null,
    audioMixPreview: null,
    audioMixTimeline: null,
    notices,
    dom: {
      fileInput: {
        accept: '',
        multiple: true,
        clicks: 0,
        click() { this.clicks += 1; },
      },
    },
    paintQueue() {},
    paintDetail() {},
    scheduleCommandPreview() {},
    appendLog() {},
    updateQuickProgress() {},
    updateMergeProgress() {},
    updateAddAudioProgress() {},
    releaseAudioMixPreview() {},
    toast(message) { notices.push(message); },
  });
  return app;
}

async function waitUntil(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

async function readyProject(app, videoFile, audioFile) {
  const job = app.addAudioProject(videoFile);
  await app.chain;
  app.replaceAddAudioAsset(job, 'audio', audioFile);
  await app.chain;
  assert.equal(job.status, 'ready');
  assert.equal(job.validationError, null);
  return job;
}

test('one add-audio project owns both roles and serial probes discard a replaced asset result', async () => {
  const primary = file('picture.mov', 4 * MiB, 'video/quicktime');
  const firstSong = file('first-song.mp3', 1 * MiB, 'audio/mpeg');
  const finalSong = file('final-song.wav', 2 * MiB, 'audio/wav');
  const gates = new Map([
    [primary, deferred()],
    [firstSong, deferred()],
    [finalSong, deferred()],
  ]);
  const calls = [];
  let active = 0;
  let peak = 0;
  const app = appWithoutDom({
    async probe(source) {
      calls.push(source);
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await gates.get(source).promise;
      } finally {
        active -= 1;
      }
    },
  });

  const job = app.addAudioProject(primary);
  const staleAsset = app.replaceAddAudioAsset(job, 'audio', firstSong);

  assert.equal(app.jobs.length, 1);
  assert.equal(app.jobs[0], job);
  assert.equal(job.video.role, 'video');
  assert.equal(job.audio, staleAsset);
  assert.equal(job.audio.role, 'audio');
  await waitUntil(() => calls.length === 1);
  assert.deepEqual(calls, [primary]);

  gates.get(primary).resolve(videoInfo());
  await waitUntil(() => calls.length === 2);
  assert.deepEqual(calls, [primary, firstSong]);

  // Replacement is allowed while metadata is being read. The old probe may
  // finish, but its result must never land in the new role-bearing asset.
  const currentAsset = app.replaceAddAudioAsset(job, 'audio', finalSong);
  gates.get(firstSong).resolve(audioInfo({ duration: 1 }));
  await waitUntil(() => calls.length === 3);

  assert.equal(job.audio, currentAsset);
  assert.equal(job.audio.info, null);
  assert.equal(staleAsset.info, null);
  assert.deepEqual(calls, [primary, firstSong, finalSong]);

  gates.get(finalSong).resolve(audioInfo({ duration: 4, codec: 'pcm_s16le' }));
  await app.chain;

  assert.equal(peak, 1);
  assert.equal(app.jobs.length, 1);
  assert.equal(job.status, 'ready');
  assert.equal(job.validationError, null);
  assert.equal(job.video.file, primary);
  assert.equal(job.audio.file, finalSong);
  assert.equal(job.audio.info.audio.duration, 4);
});

test('typed picker intents route one role, while cancel and force-new cannot hijack the project', async () => {
  const app = appWithoutDom({
    async probe(source) {
      return source.type.startsWith('audio/') ? audioInfo() : videoInfo();
    },
  });
  const primary = file('primary.mp4');
  const song = file('song.mp3', 2000, 'audio/mpeg');
  const job = app.addAudioProject(primary);
  await app.chain;

  app.openAddAudioPicker(job, 'audio');
  assert.deepEqual(
    {
      kind: app.pickerIntent.kind,
      projectId: app.pickerIntent.projectId,
      role: app.pickerIntent.role,
      token: app.pickerIntent.token,
      accept: app.dom.fileInput.accept,
      multiple: app.dom.fileInput.multiple,
    },
    {
      kind: 'add-audio-asset',
      projectId: job.id,
      role: 'audio',
      token: 1,
      accept: 'audio/*',
      multiple: false,
    },
  );
  app.addFiles([song]);
  await app.chain;
  assert.equal(app.jobs.length, 1, 'the second source belongs to the compound project');
  assert.equal(job.audio.file, song);

  const videoBeforeCancel = job.video;
  app.openAddAudioPicker(job, 'video');
  app.clearPickerIntent(); // equivalent to the file input's cancel event
  const unrelatedAfterCancel = file('after-cancel.mp4');
  app.addFiles([unrelatedAfterCancel]);
  await app.chain;
  assert.equal(job.video, videoBeforeCancel);
  assert.equal(app.jobs.length, 2);
  assert.equal(app.jobs[1].file, unrelatedAfterCancel);

  const audioBeforeForceNew = job.audio;
  app.openAddAudioPicker(job, 'audio');
  const explicitNewToolFile = file('new-tool.mp4');
  app.addFiles([explicitNewToolFile], { forceNewJobs: true });
  await app.chain;
  assert.equal(app.pickerIntent, null);
  assert.equal(job.audio, audioBeforeForceNew);
  assert.equal(app.jobs.length, 3);
  assert.equal(app.jobs[2].file, explicitNewToolFile);
  assert.equal(app.dom.fileInput.clicks, 3);
});

test('aggregate working-set limits reject files before an audio probe is enqueued', async () => {
  let probes = 0;
  const app = appWithoutDom({
    async probe() {
      probes += 1;
      return videoInfo();
    },
  });

  assert.equal(
    app.addAudioProject(file('too-heavy.mp4', (ADD_AUDIO_LIMITS.maxWorkingBytes / 2) + 1)),
    null,
  );
  assert.equal(probes, 0);
  assert.match(app.notices.join(' '), /500 MB/);

  // 250 MiB of video is admissible by itself (500 MiB working estimate), but
  // adding even one more MiB would exceed the cap before metadata exists.
  const primary = file('edge.mp4', ADD_AUDIO_LIMITS.maxWorkingBytes / 2);
  const job = app.addAudioProject(primary);
  const refused = app.replaceAddAudioAsset(job, 'audio', file('one-more.mp3', MiB, 'audio/mpeg'));
  assert.equal(refused, null);
  assert.equal(job.audio, null);
  await app.chain;
  assert.equal(probes, 1, 'only the accepted primary video was probed');
  assert.match(app.notices.join(' '), /501 MB|límite seguro/i);
});

test('a queued snapshot fixes [video, audio] and stays dirty when live state changes before the run', async () => {
  const primary = file('holiday.mov', 4 * MiB, 'video/quicktime');
  const originalSong = file('theme.mp3', MiB, 'audio/mpeg');
  const replacementSong = file('replacement.wav', 2 * MiB, 'audio/wav');
  const finished = deferred();
  let started = null;
  const app = appWithoutDom({
    async probe(source) {
      return source.type.startsWith('audio/') ? audioInfo({ duration: 3 }) : videoInfo({ duration: 8 });
    },
    start(plan, files, handlers) {
      started = { plan, files, handlers };
      return { finished: finished.promise, cancel() {} };
    },
  });
  const job = await readyProject(app, primary, originalSong);
  const queuedRevision = job.revision;
  job.pendingAddAudioSnapshot = createAddAudioSnapshot(job);
  job.status = 'queued';

  // Simulate a stale UI callback mutating the live editor after queuing. The
  // engine must still receive the immutable snapshot captured by start-one.
  job.audio = {
    ...createAddAudioAsset(replacementSong, 'audio'),
    info: audioInfo({ duration: 5, codec: 'pcm_s16le' }),
    status: 'ready',
  };
  job.options = { ...job.options, audioOffset: 1, audioFit: 'loop' };
  Object.assign(job, markAddAudioEdited(job));
  app.syncAddAudioProject(job);

  const running = app.runJob(job);
  assert.ok(started);
  assert.deepEqual(started.files, [primary, originalSong]);
  assert.deepEqual(started.plan.inputNames, ['input-video.mov', 'input-audio.mp3']);
  assert.equal(started.plan.options.audioOffset, 0);
  assert.equal(started.plan.options.audioFit, 'once');

  finished.resolve({ outputs: [{ name: 'output.mp4', bytes: new Uint8Array([1, 2, 3]) }] });
  await running;

  assert.equal(job.status, 'done');
  assert.equal(job.pendingAddAudioSnapshot, undefined);
  assert.equal(job.revision, queuedRevision + 1);
  assert.equal(job.exportedRevision, queuedRevision);
  assert.equal(job.dirtySinceOutput, true);
  assert.equal(app.jobIsSettledDone(job), false);
  assert.equal(app.jobPendingForRun(job), true);
  assert.equal(job.audio.file, replacementSong);
});

test('clean exports settle; editing and a failed retry preserve the previous output', async () => {
  const failure = new Error('encoder stopped');
  let shouldFail = false;
  const app = appWithoutDom({
    async probe(source) {
      return source.type.startsWith('audio/') ? audioInfo() : videoInfo();
    },
    start() {
      return {
        finished: shouldFail
          ? Promise.reject(failure)
          : Promise.resolve({ outputs: [{ name: 'output.mp4', bytes: new Uint8Array([4, 5, 6]) }] }),
        cancel() {},
      };
    },
  });
  const job = await readyProject(
    app,
    file('clip.mp4', 4096, 'video/mp4'),
    file('voice.m4a', 1024, 'audio/mp4'),
  );

  await app.runJob(job);
  const previous = job.outputs;
  assert.equal(job.status, 'done');
  assert.equal(job.dirtySinceOutput, false);
  assert.equal(app.jobIsSettledDone(job), true);

  job.options.addedGain = 0.8;
  app.markAddAudioJobEdited(job);
  assert.equal(job.outputs, previous);
  assert.equal(job.dirtySinceOutput, true);
  assert.equal(app.jobIsSettledDone(job), false);
  assert.equal(app.jobPendingForRun(job), true);

  shouldFail = true;
  await app.runJob(job);

  assert.equal(job.status, 'failed');
  assert.equal(job.error, failure.message);
  assert.equal(job.outputs, previous);
  assert.equal(job.dirtySinceOutput, true);
  assert.equal(app.jobIsSettledDone(job), false);
  assert.match(app.addAudioStatusCopy(job).detail, /resultado anterior sigue disponible/i);
});

test('queuing an add-audio export pauses native preview and suspends WebAudio', async () => {
  const app = appWithoutDom();
  const calls = { videoPause: 0, audioPause: 0, suspend: 0, sync: 0 };
  const video = {
    controls: true,
    muted: false,
    volume: 1,
    pause() { calls.videoPause += 1; },
  };
  const audio = {
    loop: false,
    volume: 1,
    pause() { calls.audioPause += 1; },
  };
  app.audioMixPreview = {
    jobId: 'project-1',
    video,
    audio,
    context: {
      suspend() {
        calls.suspend += 1;
        return Promise.resolve();
      },
    },
    sync() { calls.sync += 1; },
  };
  const job = {
    id: 'project-1',
    status: 'queued',
    video: { info: videoInfo() },
    options: { mixMode: 'mix', originalGain: 1, addedGain: 0.35, audioFit: 'once' },
  };

  app.updateAudioMixPreview(job, { forceSync: true });
  await Promise.resolve();

  assert.equal(video.controls, false);
  assert.deepEqual(calls, { videoPause: 1, audioPause: 1, suspend: 1, sync: 0 });

  job.status = 'ready';
  app.updateAudioMixPreview(job, { forceSync: true });
  assert.equal(video.controls, true);
  assert.equal(calls.sync, 1);
});
