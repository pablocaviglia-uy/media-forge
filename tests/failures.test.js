/**
 * Telling a failed job apart from a poisoned engine.
 *
 * This is a four-line function guarding the difference between "that file did
 * not work" and "every file after this one is now suspect", so it gets a test
 * of its own. Getting it wrong in the permissive direction throws away a
 * working core and costs a few seconds; getting it wrong in the other direction
 * hands the next job an instance whose heap is undefined, and whatever comes
 * out of that is not worth having.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failedMessage, isFatal } from '../src/ffmpeg/failures.js';

test('a trap inside WebAssembly means the instance is finished', () => {
  // The one this core produces on its own once an instance has been alive long
  // enough — around seventy invocations of anything, in measurements here.
  assert.equal(isFatal(new Error('memory access out of bounds')), true);

  for (const message of [
    'Aborted(). Build with -sASSERTIONS for more info.',
    'RuntimeError: unreachable',
    'Array buffer allocation failed',
    'Out of memory',
    'abort(OOM) at Error',
  ]) {
    assert.equal(isFatal(new Error(message)), true, message);
  }
});

test('FFmpeg declining to do something is not a reason to throw the core away', () => {
  // Every one of these is an ordinary refusal: the core is untouched and the
  // next job runs normally. Replacing the instance for any of them would mean
  // recompiling 32 MB because someone picked the wrong container.
  for (const message of [
    'Unknown encoder \'libaom-av1\'',
    'Could not write header for output file #0 (incorrect codec parameters ?)',
    'Invalid argument',
    'No such file or directory',
    'Error initializing output stream 0:0',
    'FFmpeg exited with code 1.',
    'Cancelled.',
  ]) {
    assert.equal(isFatal(new Error(message)), false, message);
  }
});

test('it takes a message as readily as an error, and refuses to guess at nothing', () => {
  assert.equal(isFatal('memory access out of bounds'), true);
  for (const nothing of ['', null, undefined, 0, {}, []]) {
    assert.equal(isFatal(nothing), false, String(nothing));
  }
});

test('worker failure replies make traps part of the recovery protocol', () => {
  const reply = failedMessage('job-7', new WebAssembly.RuntimeError('memory access out of bounds'), {
    log: ['frame=12', 'memory access out of bounds'],
  });

  assert.deepEqual(reply, {
    type: 'failed',
    id: 'job-7',
    error: 'memory access out of bounds',
    fatal: true,
    log: ['frame=12', 'memory access out of bounds'],
  });
});

test('ordinary FFmpeg refusals use the same reply without discarding the core', () => {
  const reply = failedMessage('job-8', new Error('Invalid argument'), { log: ['Invalid argument'] });

  assert.equal(reply.type, 'failed');
  assert.equal(reply.id, 'job-8');
  assert.equal(reply.error, 'Invalid argument');
  assert.equal(reply.fatal, false);
  assert.deepEqual(reply.log, ['Invalid argument']);
});

test('failure reply invariants cannot be overwritten by incidental details', () => {
  const reply = failedMessage('job-9', new Error('RuntimeError: unreachable'), {
    type: 'done',
    id: 'another-job',
    error: 'looks fine',
    fatal: false,
  });

  assert.deepEqual(reply, {
    type: 'failed',
    id: 'job-9',
    error: 'RuntimeError: unreachable',
    fatal: true,
  });
});
