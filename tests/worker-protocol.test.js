import { test } from 'node:test';
import assert from 'node:assert/strict';

// The worker registers its message handler at module evaluation time. A tiny
// stand-in is enough to import and test the pure input-pairing boundary without
// loading WebAssembly or pretending Node is an actual Worker.
const previousSelf = globalThis.self;
globalThis.self = { addEventListener() {} };
const { pairRunInputs } = await import('../src/worker/ffmpeg.worker.js');
if (previousSelf === undefined) delete globalThis.self;
else globalThis.self = previousSelf;

const readable = (name) => ({ name, async arrayBuffer() { return new ArrayBuffer(0); } });

test('the run protocol keeps legacy single-file jobs compatible', () => {
  const file = readable('holiday.mp4');
  assert.deepEqual(pairRunInputs(['input.mp4'], file), [{ name: 'input.mp4', file }]);
  assert.deepEqual(pairRunInputs([], null), []);
});

test('the run protocol maps every multi-file input by ordered position', () => {
  const first = readable('first.mp4');
  const second = readable('second.webm');
  assert.deepEqual(
    pairRunInputs(['input-000.mp4', 'input-001.webm'], [first, second]),
    [
      { name: 'input-000.mp4', file: first },
      { name: 'input-001.webm', file: second },
    ]
  );
});

test('the run protocol refuses missing, extra, duplicate and unreadable inputs', () => {
  const file = readable('clip.mp4');
  assert.throws(() => pairRunInputs(['a.mp4', 'b.mp4'], [file]), /expects 2 input files, but received 1/);
  assert.throws(() => pairRunInputs(['a.mp4'], [file, file]), /expects 1 input file, but received 2/);
  assert.throws(() => pairRunInputs(['a.mp4', 'a.mp4'], [file, file]), /unique file name/);
  assert.throws(() => pairRunInputs(['a.mp4'], [{}]), /not a readable file/);
});
