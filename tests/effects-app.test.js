import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import { DEFAULT_OPTIONS } from '../src/media/commands.js';

const mediaInfo = ({ duration = 12, audio = true } = {}) => ({
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  formats: ['mov', 'mp4'],
  duration,
  hasVideo: true,
  hasAudio: audio,
  video: { codec: 'h264', width: 640, height: 360, fps: 30 },
  audio: audio ? { codec: 'aac', channels: 2, sampleRate: 48_000 } : null,
  streams: [],
});

function quickJob(toolId, {
  id = toolId,
  info = mediaInfo(),
  status = 'ready',
  options = {},
} = {}) {
  return {
    id,
    forgeToolId: toolId,
    file: { name: `${id}.mp4`, size: 1024, type: 'video/mp4' },
    name: `${id}.mp4`,
    size: 1024,
    info,
    status,
    operation: 'convert',
    options: { ...DEFAULT_OPTIONS, ...options },
    progress: 0,
    speed: null,
    remaining: null,
    outputs: null,
    error: null,
    validationError: null,
    log: [],
    previewMode: 'source',
    dirtySinceOutput: false,
  };
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
    quickSourcePreview: null,
    quickOutputPreview: null,
    notices: [],
    paintQueue() {},
    paintDetail() {},
    scheduleCommandPreview() {},
    appendLog() {},
    updateQuickProgress() {},
    updateMergeProgress() {},
    toast(message) { this.notices.push(message); },
  });
  return app;
}

test('probing initialises volume, speed and a duration-aware loop default', async () => {
  const volume = quickJob('video-volume', { info: null, status: 'probing' });
  const speed = quickJob('video-speed', { info: null, status: 'probing' });
  const loop = quickJob('video-loop', { info: null, status: 'probing' });
  const probed = new Map([
    [volume.file, mediaInfo({ duration: 30, audio: true })],
    [speed.file, mediaInfo({ duration: 30, audio: false })],
    [loop.file, mediaInfo({ duration: 1200, audio: false })],
  ]);
  const app = appWithoutDom({ async probe(file) { return probed.get(file); } });
  app.jobs.push(volume, speed, loop);

  await app.probeJob(volume);
  await app.probeJob(speed);
  await app.probeJob(loop);

  assert.deepEqual(
    { initialised: volume.quickToolInitialised, gain: volume.options.volumeGain, mute: volume.options.mute },
    { initialised: 'video-volume', gain: 1.5, mute: false },
  );
  assert.deepEqual(
    { initialised: speed.quickToolInitialised, rate: speed.options.playbackRate, mute: speed.options.mute },
    { initialised: 'video-speed', rate: 1.5, mute: false },
  );
  assert.deepEqual(
    {
      initialised: loop.quickToolInitialised,
      mode: loop.options.loopMode,
      count: loop.options.loopCount,
      duration: loop.options.loopDuration,
    },
    { initialised: 'video-loop', mode: 'duration', count: null, duration: 1800 },
  );
  assert.equal(app.quickJobRunnable(volume), true);
  assert.equal(app.quickJobRunnable(speed), true, 'speed remains useful for a silent video');
  assert.equal(app.quickJobRunnable(loop), true);
});

test('unsupported volume and loop intents fall back after probing with an actionable notice', async () => {
  const silentVolume = quickJob('video-volume', { info: null, status: 'probing' });
  const unknownLoop = quickJob('video-loop', { info: null, status: 'probing' });
  const probed = new Map([
    [silentVolume.file, mediaInfo({ duration: 8, audio: false })],
    [unknownLoop.file, mediaInfo({ duration: null, audio: true })],
  ]);
  const app = appWithoutDom({ async probe(file) { return probed.get(file); } });
  app.jobs.push(silentVolume, unknownLoop);

  await app.probeJob(silentVolume);
  await app.probeJob(unknownLoop);

  assert.equal(silentVolume.status, 'ready');
  assert.equal(silentVolume.forgeToolId, null);
  assert.equal(silentVolume.quickToolInitialised, undefined);
  assert.equal(unknownLoop.status, 'ready');
  assert.equal(unknownLoop.forgeToolId, null);
  assert.equal(unknownLoop.quickToolInitialised, undefined);
  for (const job of [silentVolume, unknownLoop]) {
    assert.deepEqual(
      {
        volumeGain: job.options.volumeGain,
        playbackRate: job.options.playbackRate,
        loopCount: job.options.loopCount,
        evenDimensions: job.options.evenDimensions,
      },
      { volumeGain: 1, playbackRate: 1, loopCount: 1, evenDimensions: false },
    );
  }
  assert.match(app.notices[0], /no tiene una pista de audio/);
  assert.match(app.notices[1], /medir una duración segura/);
});

test('effect jobs reject neutral choices and accept real bounded changes', () => {
  const app = appWithoutDom();
  const volume = quickJob('video-volume', { options: { volumeGain: 1, mute: false } });
  const speed = quickJob('video-speed', {
    info: mediaInfo({ audio: false }),
    options: { playbackRate: 1 },
  });
  const loop = quickJob('video-loop', {
    info: mediaInfo({ duration: 20, audio: false }),
    options: { loopMode: 'count', loopCount: 1, loopDuration: null },
  });

  assert.equal(app.quickJobRunnable(volume), false);
  volume.options.mute = true;
  assert.equal(app.quickJobRunnable(volume), true);

  assert.equal(app.quickJobRunnable(speed), false);
  speed.options.playbackRate = 0.25;
  assert.equal(app.quickJobRunnable(speed), true);

  assert.equal(app.quickJobRunnable(loop), false);
  loop.options.loopCount = 2;
  assert.equal(app.quickJobRunnable(loop), true);
  loop.options = { ...loop.options, loopMode: 'duration', loopCount: null, loopDuration: 20 };
  assert.equal(app.quickJobRunnable(loop), false, 'a target equal to the source is still a no-op');
});

test('focused effect source facts use playable stream duration instead of an offset container clock', () => {
  const app = appWithoutDom();
  const info = mediaInfo({ duration: 8, audio: true });
  Object.assign(info, { startTime: 5 });
  Object.assign(info.video, { duration: 3, startTime: 5 });
  Object.assign(info.audio, { duration: 3.02, startTime: 6 });
  const loop = quickJob('video-loop', {
    info,
    options: { loopMode: 'count', loopCount: 2 },
  });

  const description = app.describeSource(loop);
  assert.match(description, /0:04/);
  assert.doesNotMatch(description, /0:08/);
  assert.equal(app.quickJobRunnable(loop), true);
});

test('validation writes only normalized effect values into runnable command options', () => {
  const app = appWithoutDom();
  const cases = [
    {
      job: quickJob('video-volume', {
        options: { format: 'mp3', volumeGain: '0.3333333333', mute: false },
      }),
      expected: { volumeGain: 0.333333, mute: false },
    },
    {
      job: quickJob('video-speed', {
        info: mediaInfo({ audio: false }),
        options: { format: 'flac', playbackRate: '1.3333333333' },
      }),
      expected: { playbackRate: 1.333333 },
    },
    {
      job: quickJob('video-loop', {
        info: mediaInfo({ duration: 40, audio: false }),
        options: { format: 'gif', loopMode: 'count', loopCount: '3', loopDuration: 999 },
      }),
      expected: { loopMode: 'count', loopCount: 3, loopDuration: null },
    },
  ];

  for (const { job, expected } of cases) {
    Object.assign(job.options, {
      cropAspect: '1:1',
      cropX: 10,
      cropY: 20,
      cropWidth: 300,
      cropHeight: 300,
    });
    app.jobs = [job];

    assert.equal(app.validateQuickJob(job, { notify: false }), true);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, job.options[key]])),
      expected,
    );
    assert.equal(job.options.evenDimensions, true);
    assert.equal(job.options.format, 'mp4-h264');
    assert.deepEqual(
      [job.options.cropAspect, job.options.cropX, job.options.cropY, job.options.cropWidth, job.options.cropHeight],
      ['free', null, null, null, null],
    );
    assert.equal(job.validationError, null);
  }
});

test('editing a completed quick effect makes it unsettled without discarding its output', () => {
  const app = appWithoutDom();
  const previous = [{ name: 'previous.mp4', blob: new Blob(['previous']) }];
  const cases = [
    ['video-volume', 'volumeGain', 0.5, mediaInfo()],
    ['video-speed', 'playbackRate', 2, mediaInfo({ audio: false })],
    ['video-loop', 'loopCount', 3, mediaInfo({ duration: 15, audio: false })],
  ];

  for (const [toolId, key, value, info] of cases) {
    const job = quickJob(toolId, { info, status: 'done' });
    job.outputs = previous;
    app.jobs = [job];

    assert.equal(app.jobIsSettledDone(job), true);
    app.setQuickEffectLiveOption(job, key, value);

    assert.equal(job.dirtySinceOutput, true);
    assert.equal(app.jobIsSettledDone(job), false);
    assert.equal(job.outputs, previous);
  }
});

test('canonical Quick signatures keep active and reverted presets settled while invalid choices stay dirty', () => {
  const app = appWithoutDom();
  const previous = [{ name: 'exported.mp4', blob: new Blob(['exported']) }];
  const cases = [
    {
      job: quickJob('video-volume', { status: 'done', options: { volumeGain: 1.5 } }),
      key: 'volumeGain',
      exported: 1.5,
      changed: 0.5,
      invalid: 2.5,
    },
    {
      job: quickJob('video-speed', {
        info: mediaInfo({ audio: false }),
        status: 'done',
        options: { playbackRate: 1.5 },
      }),
      key: 'playbackRate',
      exported: 1.5,
      changed: 2,
      invalid: 5,
    },
    {
      job: quickJob('video-loop', {
        info: mediaInfo({ duration: 15, audio: false }),
        status: 'done',
        options: { loopMode: 'count', loopCount: 2, loopDuration: null },
      }),
      key: 'loopCount',
      exported: 2,
      changed: 3,
      invalid: 21,
    },
  ];

  for (const { job, key, exported, changed, invalid } of cases) {
    job.outputs = previous;
    app.jobs = [job];
    job.quickExportSignature = App.prototype.quickPlanSignature.call(app, job);
    assert.match(job.quickExportSignature, /^ffmpeg /);

    // Reassigning the preset that produced the output is semantically a no-op.
    job.options[key] = exported;
    App.prototype.syncQuickDirty.call(app, job);
    assert.equal(job.dirtySinceOutput, false);
    assert.equal(app.jobIsSettledDone(job), true);

    job.options[key] = changed;
    App.prototype.syncQuickDirty.call(app, job);
    assert.equal(job.dirtySinceOutput, true);
    assert.equal(app.jobIsSettledDone(job), false);

    // Returning from A to B and back to A restores the exported plan exactly.
    job.options[key] = exported;
    App.prototype.syncQuickDirty.call(app, job);
    assert.equal(job.dirtySinceOutput, false);
    assert.equal(app.jobIsSettledDone(job), true);

    job.options[key] = invalid;
    assert.equal(App.prototype.quickPlanSignature.call(app, job), null);
    App.prototype.syncQuickDirty.call(app, job);
    assert.equal(job.dirtySinceOutput, true);
    assert.equal(app.jobIsSettledDone(job), false);
  }
});

test('App blocks unsafe Quick expansion before it reaches the worker', () => {
  const app = appWithoutDom();
  const memoryHeavy = quickJob('video-loop', {
    options: { loopMode: 'count', loopCount: 3 },
    info: mediaInfo({ duration: 10, audio: false }),
  });
  memoryHeavy.size = 126 * 1024 * 1024;
  const loopTool = app.quickToolFor(memoryHeavy);
  assert.equal(app.quickJobRunnable(memoryHeavy, loopTool), false);
  assert.match(app.quickInvalidMessage(loopTool, memoryHeavy), /504 MB/);
  assert.equal(app.validateQuickJob(memoryHeavy, { notify: false }), false);
  assert.match(memoryHeavy.validationError, /límite seguro es 500 MB/);

  const overlong = quickJob('video-speed', {
    options: { playbackRate: 0.25 },
    info: mediaInfo({ duration: 600, audio: true }),
  });
  const speedTool = app.quickToolFor(overlong);
  assert.equal(app.quickJobRunnable(overlong, speedTool), false);
  assert.match(app.quickInvalidMessage(speedTool, overlong), /40:00/);
});

test('the queue reruns a dirty completed quick effect but skips a clean completed result', async () => {
  const app = appWithoutDom();
  const dirty = quickJob('video-speed', {
    id: 'dirty-speed',
    status: 'done',
    options: { playbackRate: 2 },
  });
  dirty.dirtySinceOutput = true;
  const clean = quickJob('video-speed', {
    id: 'clean-speed',
    status: 'done',
    options: { playbackRate: 2 },
  });
  const processed = [];
  app.jobs.push(dirty, clean);
  app.runJob = async (job) => { processed.push(job.id); };

  assert.equal(app.jobPendingForRun(dirty), true);
  assert.equal(app.jobPendingForRun(clean), false);

  await app.runQueue();

  assert.deepEqual(processed, ['dirty-speed']);
});

test('a failed retry preserves the previous quick-effect result for download', async () => {
  const failure = new Error('encoder stopped');
  const app = appWithoutDom({
    start() {
      return {
        finished: Promise.reject(failure),
        cancel() {},
      };
    },
  });
  const previous = [{ name: 'previous.mp4', blob: new Blob(['previous']) }];
  const job = quickJob('video-speed', {
    status: 'queued',
    options: { playbackRate: 2 },
  });
  job.outputs = previous;
  job.outputSize = previous[0].blob.size;
  job.dirtySinceOutput = true;
  app.jobs.push(job);

  await app.runJob(job);

  assert.equal(job.status, 'failed');
  assert.equal(job.error, failure.message);
  assert.equal(job.outputs, previous);
  assert.equal(job.dirtySinceOutput, true);
  assert.equal(app.jobIsSettledDone(job), false);
  assert.match(app.quickStatusCopy(job).detail, /resultado anterior sigue disponible/i);
});
