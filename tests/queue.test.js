import { test } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';

function appWithoutDom(jobs) {
  const app = Object.create(App.prototype);
  Object.assign(app, {
    jobs,
    stopRequested: false,
    running: null,
    runningId: null,
    quickOutputPreview: null,
    paintQueue() {},
    paintDetail() {},
    appendLog() {},
    updateQuickProgress() {},
  });
  return app;
}

test('runQueue does not skip the next job when the live queue shrinks while it awaits', async () => {
  const completed = { id: 'completed', status: 'done' };
  const current = { id: 'current', status: 'ready' };
  const next = { id: 'next', status: 'ready' };
  const app = appWithoutDom([completed, current, next]);
  const executed = [];
  let markCurrentStarted;
  let finishCurrent;
  const currentStarted = new Promise((resolve) => { markCurrentStarted = resolve; });
  const currentFinished = new Promise((resolve) => { finishCurrent = resolve; });

  app.runJob = async (job) => {
    executed.push(job.id);
    if (job === current) {
      markCurrentStarted();
      await currentFinished;
    }
  };

  const running = app.runQueue();
  await currentStarted;
  app.jobs.splice(app.jobs.indexOf(completed), 1);
  finishCurrent();
  await running;

  assert.deepEqual(executed, ['current', 'next']);
});

test('a stale individual task cannot rerun a job already consumed by runQueue', async () => {
  const job = {
    id: 'clip',
    file: new Blob(['input'], { type: 'video/mp4' }),
    name: 'clip.mp4',
    info: {
      hasVideo: true,
      hasAudio: true,
      duration: 2,
      video: { codec: 'h264', width: 640, height: 360, fps: 30 },
      audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
    },
    operation: 'convert',
    options: { format: 'mp4-h264' },
    status: 'queued',
    progress: 0,
    outputs: null,
    log: [],
  };
  const app = appWithoutDom([job]);
  let starts = 0;
  app.engine = {
    start() {
      starts += 1;
      return {
        finished: Promise.resolve({
          outputs: [{ name: 'output.mp4', bytes: new Uint8Array([1, 2, 3]) }],
        }),
      };
    },
  };

  // This is the order produced when "Process queue" is enqueued first and an
  // individual click enqueues another task for the same, now-queued job.
  await app.runQueue();
  await app.runJob(job);

  assert.equal(starts, 1);
  assert.equal(job.status, 'done');
});
