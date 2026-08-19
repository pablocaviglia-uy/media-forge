import test from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/app.js';
import { keyboardResizeRect, pointerResizeRect } from '../src/ui/cropper.js';

const FRAME = { width: 640, height: 360 };

test('keyboard handles resize both axes when an aspect ratio is locked', () => {
  const start = { x: 140, y: 0, width: 360, height: 360 };
  const next = keyboardResizeRect(start, 'nw', 'ArrowRight', 2, FRAME, 1);

  assert.deepEqual(next, { x: 142, y: 2, width: 358, height: 358 });
});

test('keyboard handles keep their free-axis behaviour without an aspect ratio', () => {
  const start = { x: 40, y: 20, width: 400, height: 300 };
  const next = keyboardResizeRect(start, 'se', 'ArrowLeft', 10, FRAME, null);

  assert.deepEqual(next, { x: 40, y: 20, width: 390, height: 300 });
});

test('keyboard resizing stays inside the visible video frame', () => {
  const start = { x: 140, y: 0, width: 360, height: 360 };
  const next = keyboardResizeRect(start, 'nw', 'ArrowLeft', 10, FRAME, 1);

  assert.deepEqual(next, start);
});

test('pointer resizing does not jump when the press starts inside a large handle', () => {
  const start = { x: 140, y: 0, width: 360, height: 360 };
  const origin = { x: 158, y: 18 };

  assert.deepEqual(pointerResizeRect(start, 'nw', origin, origin, FRAME, 1), start);
  assert.deepEqual(
    pointerResizeRect(start, 'nw', origin, { x: 160, y: 20 }, FRAME, 1),
    { x: 142, y: 2, width: 358, height: 358 },
  );
});

test('Crop cannot run when its visual preview is unavailable', () => {
  const app = Object.create(App.prototype);
  const job = {
    forgeToolId: 'video-crop',
    status: 'ready',
    info: {
      hasVideo: true,
      video: { width: 640, height: 360, rotation: 0 },
    },
    options: {
      cropAspect: '1:1',
      cropX: 140,
      cropY: 0,
      cropWidth: 360,
      cropHeight: 360,
    },
  };

  assert.equal(app.quickJobRunnable(job), true);
  job.cropPreviewUnavailable = true;
  assert.equal(app.quickJobRunnable(job), false);
});
