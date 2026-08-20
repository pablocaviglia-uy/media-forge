import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_PEAKS_DEFAULT_BUCKETS,
  AUDIO_PEAKS_DEFAULT_LIMITS,
  AUDIO_PEAKS_DEFAULT_TIMEOUTS,
  AudioPeaksError,
  estimateAudioPcmBytes,
  downsampleAudioPeaks,
  extractAudioPeaks,
  clearAudioPeaksCache,
} from '../src/media/audio-peaks.js';

beforeEach(() => clearAudioPeaksCache());

const errorCode = (code) => (error) => error instanceof AudioPeaksError && error.code === code;

const testLimits = (overrides = {}) => ({
  maxSourceBytes: 1_024,
  maxDurationSeconds: 100,
  maxEstimatedPcmBytes: 10_000_000,
  maxBuckets: 32,
  estimateSampleRate: 96_000,
  estimateChannels: 8,
  bytesPerSample: 4,
  ...overrides,
});

function decodedBuffer(channels, sampleRate = 4, duration = channels[0].length / sampleRate) {
  return {
    duration,
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData(index) {
      return channels[index];
    },
  };
}

function contextHarness({
  buffer,
  decodeError,
  closeError,
  closePending = false,
  callbackOnly = false,
  pending = false,
  actualSampleRate,
} = {}) {
  const state = { created: 0, decoded: 0, closed: 0, contextOptions: [] };
  let resolveDecode;
  let rejectDecode;
  let resolveClose;
  const factory = (contextOptions = {}) => {
    state.created += 1;
    state.contextOptions.push({ ...contextOptions });
    return {
      sampleRate: actualSampleRate ?? contextOptions.sampleRate,
      decodeAudioData(_bytes, onSuccess, onFailure) {
        state.decoded += 1;
        if (pending) {
          const promise = new Promise((resolve, reject) => {
            resolveDecode = (value) => {
              onSuccess?.(value);
              resolve(value);
            };
            rejectDecode = (error) => {
              onFailure?.(error);
              reject(error);
            };
          });
          return callbackOnly ? undefined : promise;
        }
        if (callbackOnly) {
          queueMicrotask(() => (decodeError ? onFailure(decodeError) : onSuccess(buffer)));
          return undefined;
        }
        return decodeError ? Promise.reject(decodeError) : Promise.resolve(buffer);
      },
      async close() {
        state.closed += 1;
        if (closeError) throw closeError;
        if (closePending) return new Promise((resolve) => { resolveClose = resolve; });
      },
    };
  };
  return {
    state,
    factory,
    resolveDecode: (value = buffer) => resolveDecode?.(value),
    rejectDecode: (error) => rejectDecode?.(error),
    resolveClose: () => resolveClose?.(),
  };
}

const smallBuffer = () => decodedBuffer([
  Float32Array.from([-0.5, 0.25, -0.1, 0.75]),
  Float32Array.from([0.1, -0.8, 0.4, -0.2]),
]);

test('public defaults are conservative and PCM estimates are deterministic', () => {
  assert.equal(AUDIO_PEAKS_DEFAULT_BUCKETS, 2_048);
  assert.equal(AUDIO_PEAKS_DEFAULT_LIMITS.maxSourceBytes, 64 * 1024 * 1024);
  assert.equal(AUDIO_PEAKS_DEFAULT_LIMITS.maxDurationSeconds, 15 * 60);
  assert.equal(AUDIO_PEAKS_DEFAULT_LIMITS.maxEstimatedPcmBytes, 256 * 1024 * 1024);
  assert.equal(AUDIO_PEAKS_DEFAULT_LIMITS.estimateSampleRate, 96_000);
  assert.equal(AUDIO_PEAKS_DEFAULT_LIMITS.estimateChannels, 8);
  assert.equal(AUDIO_PEAKS_DEFAULT_TIMEOUTS.readMs, 30_000);
  assert.equal(AUDIO_PEAKS_DEFAULT_TIMEOUTS.decodeMs, 120_000);
  assert.equal(AUDIO_PEAKS_DEFAULT_TIMEOUTS.closeMs, 2_000);
  assert.equal(estimateAudioPcmBytes(1, { sampleRate: 10, channels: 2, bytesPerSample: 4 }), 80);
  assert.equal(estimateAudioPcmBytes(1.01, { sampleRate: 10, channels: 2, bytesPerSample: 4 }), 81);
  assert.ok(Object.isFrozen(AUDIO_PEAKS_DEFAULT_LIMITS));
  assert.ok(Object.isFrozen(AUDIO_PEAKS_DEFAULT_TIMEOUTS));
});

test('downsampling merges channels into min/max buckets and preserves one-frame transients', () => {
  const peaks = downsampleAudioPeaks([
    Float32Array.from([0, 0, 0.9, 0]),
    Float32Array.from([0, -1, 0, 0]),
  ], 2);

  assert.deepEqual(peaks, [
    { min: -1, max: 0 },
    { min: 0, max: 0.8999999761581421 },
  ]);
  assert.ok(Object.isFrozen(peaks));
  assert.ok(peaks.every(Object.isFrozen));
});

test('downsampling visits every frame once, clamps samples and never invents empty buckets', () => {
  const peaks = downsampleAudioPeaks([[2, Number.NaN, -2]], 20);
  assert.deepEqual(peaks, [
    { min: 1, max: 1 },
    { min: 0, max: 0 },
    { min: -1, max: -1 },
  ]);
  assert.throws(
    () => downsampleAudioPeaks([[0, 1], [0]], 1),
    errorCode('channel-length-mismatch'),
  );
});

test('source byte limit admits the exact boundary and rejects +1 before reading', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  const exact = new Blob([new Uint8Array(4)]);
  const tooLarge = new Blob([new Uint8Array(5)]);
  let reads = 0;
  const originalRead = tooLarge.arrayBuffer.bind(tooLarge);
  tooLarge.arrayBuffer = () => {
    reads += 1;
    return originalRead();
  };

  await extractAudioPeaks(exact, {
    duration: 1,
    sampleRate: 48_000,
    channels: 2,
    bucketCount: 2,
    limits: testLimits({ maxSourceBytes: 4 }),
    createAudioContext: harness.factory,
  });
  await assert.rejects(
    extractAudioPeaks(tooLarge, {
      duration: 1,
      bucketCount: 2,
      limits: testLimits({ maxSourceBytes: 4 }),
      createAudioContext: harness.factory,
    }),
    errorCode('source-too-large'),
  );
  assert.equal(reads, 0);
  assert.equal(harness.state.created, 1);
});

test('duration limit admits the exact boundary and rejects +1 before reading', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  const exact = new Blob([new Uint8Array(1)]);
  const tooLong = new Blob([new Uint8Array(1)]);
  let reads = 0;
  tooLong.arrayBuffer = () => {
    reads += 1;
    return Promise.resolve(new ArrayBuffer(1));
  };

  await extractAudioPeaks(exact, {
    duration: 10,
    sampleRate: 48_000,
    channels: 2,
    bucketCount: 2,
    limits: testLimits({ maxDurationSeconds: 10 }),
    createAudioContext: harness.factory,
  });
  await assert.rejects(
    extractAudioPeaks(tooLong, {
      duration: 11,
      bucketCount: 2,
      limits: testLimits({ maxDurationSeconds: 10 }),
      createAudioContext: harness.factory,
    }),
    errorCode('duration-too-long'),
  );
  assert.equal(reads, 0);
});

test('estimated PCM limit admits exact bytes and rejects one estimated byte more before reading', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  const exact = new Blob([new Uint8Array(1)]);
  const plusOne = new Blob([new Uint8Array(1)]);
  let reads = 0;
  plusOne.arrayBuffer = () => {
    reads += 1;
    return Promise.resolve(new ArrayBuffer(1));
  };
  const limits = testLimits({ maxEstimatedPcmBytes: 384_000 });

  await extractAudioPeaks(exact, {
    duration: 1,
    sampleRate: 48_000,
    channels: 2,
    bucketCount: 2,
    limits,
    createAudioContext: harness.factory,
  });
  await assert.rejects(
    extractAudioPeaks(plusOne, {
      duration: 384_001 / 384_000,
      sampleRate: 48_000,
      channels: 2,
      bucketCount: 2,
      limits,
      createAudioContext: harness.factory,
    }),
    errorCode('estimated-pcm-too-large'),
  );
  assert.equal(reads, 0);
});

test('7.1 96 kHz preflight rejects an unsafe allocation before reading or decoding', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  const blob = new Blob([new Uint8Array(1)]);
  let reads = 0;
  blob.arrayBuffer = () => {
    reads += 1;
    return Promise.resolve(new ArrayBuffer(1));
  };

  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 88,
      sampleRate: 96_000,
      channels: 8,
      createAudioContext: harness.factory,
    }),
    (error) => errorCode('estimated-pcm-too-large')(error)
      && error.details.estimatedPcmBytes === 88 * 96_000 * 8 * 4
      && error.details.sampleRate === 96_000
      && error.details.channels === 8,
  );
  assert.equal(reads, 0);
  assert.equal(harness.state.created, 0);
});

test('missing PCM metadata falls back to 96 kHz 7.1 and trusted low values retain a stereo 48 kHz floor', async () => {
  const fallbackBlob = new Blob([new Uint8Array(1)]);
  let fallbackReads = 0;
  fallbackBlob.arrayBuffer = () => {
    fallbackReads += 1;
    return Promise.resolve(new ArrayBuffer(1));
  };
  await assert.rejects(
    extractAudioPeaks(fallbackBlob, { duration: 88 }),
    (error) => errorCode('estimated-pcm-too-large')(error)
      && error.details.sampleRate === 96_000
      && error.details.channels === 8
      && error.details.usedFallbackSampleRate === true
      && error.details.usedFallbackChannels === true,
  );
  assert.equal(fallbackReads, 0);

  const flooredBlob = new Blob([new Uint8Array(1)]);
  let flooredReads = 0;
  flooredBlob.arrayBuffer = () => {
    flooredReads += 1;
    return Promise.resolve(new ArrayBuffer(1));
  };
  await assert.rejects(
    extractAudioPeaks(flooredBlob, {
      duration: 2,
      sampleRate: 8_000,
      channels: 1,
      limits: testLimits({ maxEstimatedPcmBytes: 384_000 }),
    }),
    (error) => errorCode('estimated-pcm-too-large')(error)
      && error.details.estimatedPcmBytes === 768_000
      && error.details.sampleRate === 48_000
      && error.details.channels === 2
      && error.details.usedFallbackSampleRate === false
      && error.details.usedFallbackChannels === false,
  );
  assert.equal(flooredReads, 0);
});

test('the requested context rate matches preflight and a browser-raised rate is rejected before decode', async () => {
  const raised = contextHarness({ buffer: smallBuffer(), actualSampleRate: 96_000 });
  await assert.rejects(
    extractAudioPeaks(new Blob([new Uint8Array(1)]), {
      duration: 1,
      sampleRate: 48_000,
      channels: 2,
      limits: testLimits(),
      createAudioContext: raised.factory,
    }),
    (error) => errorCode('audio-context-sample-rate-too-high')(error)
      && error.details.requestedSampleRate === 48_000
      && error.details.actualSampleRate === 96_000,
  );
  assert.deepEqual(raised.state.contextOptions, [{ sampleRate: 48_000 }]);
  assert.equal(raised.state.decoded, 0);
  assert.equal(raised.state.closed, 1);

  const fallback = contextHarness({ buffer: smallBuffer(), actualSampleRate: 96_000 });
  assert.equal((await extractAudioPeaks(new Blob([new Uint8Array(1)]), {
    duration: 1,
    limits: testLimits(),
    createAudioContext: fallback.factory,
  })).status, 'ready');
  assert.deepEqual(fallback.state.contextOptions, [{ sampleRate: 96_000 }]);
  assert.equal(fallback.state.decoded, 1);
});

test('async extraction returns clear immutable metadata and works with Safari callback decoding', async () => {
  const harness = contextHarness({ buffer: smallBuffer(), callbackOnly: true });
  const result = await extractAudioPeaks(new Blob([new Uint8Array(3)]), {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: harness.factory,
  });

  assert.deepEqual(result, {
    status: 'ready',
    peaks: [
      { min: -0.800000011920929, max: 0.25 },
      { min: -0.20000000298023224, max: 0.75 },
    ],
    duration: 1,
    sampleRate: 4,
    channelCount: 2,
    frameCount: 4,
    pcmBytes: 32,
    bucketCount: 2,
  });
  assert.ok(Object.isFrozen(result));
  assert.equal(harness.state.closed, 1);
});

test('cache keys by Blob identity and bucket count without retaining decoded buffers', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const sameBytesDifferentBlob = new Blob([new Uint8Array([1, 2, 3])]);
  const options = {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: harness.factory,
  };

  const first = await extractAudioPeaks(blob, options);
  const cached = await extractAudioPeaks(blob, options);
  await extractAudioPeaks(blob, { ...options, bucketCount: 1 });
  await extractAudioPeaks(sameBytesDifferentBlob, options);

  assert.equal(cached, first);
  assert.equal(harness.state.decoded, 3);
  assert.equal(harness.state.closed, 3);
  assert.equal(Object.hasOwn(first, 'blob'), false);
  assert.equal(Object.hasOwn(first, 'audioBuffer'), false);
});

test('an already-aborted request does not read bytes or create a context', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  const controller = new AbortController();
  controller.abort();
  const blob = new Blob([new Uint8Array(1)]);
  let reads = 0;
  blob.arrayBuffer = () => {
    reads += 1;
    return Promise.resolve(new ArrayBuffer(1));
  };

  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 1,
      limits: testLimits(),
      signal: controller.signal,
      createAudioContext: harness.factory,
    }),
    (error) => errorCode('aborted')(error) && error.name === 'AbortError',
  );
  assert.equal(reads, 0);
  assert.equal(harness.state.created, 0);
});

test('a lone consumer abort cancels the shared decode, closes it and never warms cache', async () => {
  const pending = contextHarness({ buffer: smallBuffer(), pending: true });
  const controller = new AbortController();
  const blob = new Blob([new Uint8Array(1)]);
  const request = extractAudioPeaks(blob, {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    signal: controller.signal,
    createAudioContext: pending.factory,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(request, errorCode('aborted'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.state.closed, 1);

  const retry = contextHarness({ buffer: smallBuffer() });
  await extractAudioPeaks(blob, {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: retry.factory,
  });
  assert.equal(retry.state.created, 1);
  assert.equal(retry.state.decoded, 1);
  pending.resolveDecode();
});

test('abort serializes a replacement decode behind asynchronous context cleanup', async () => {
  const controller = new AbortController();
  const blob = new Blob([new Uint8Array(1)]);
  let closeStarted = 0;
  let finishClose;
  let decodeCount = 0;
  const factory = (contextOptions) => ({
    sampleRate: contextOptions.sampleRate,
    decodeAudioData() {
      decodeCount += 1;
      return Promise.resolve(smallBuffer());
    },
    close() {
      closeStarted += 1;
      return new Promise((resolve) => { finishClose = resolve; });
    },
  });
  const request = extractAudioPeaks(blob, {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    signal: controller.signal,
    createAudioContext: factory,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeStarted, 1);
  const abortedRequest = assert.rejects(request, errorCode('aborted'));
  controller.abort();
  await abortedRequest;

  const retry = contextHarness({ buffer: smallBuffer() });
  const retryRequest = extractAudioPeaks(blob, {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: retry.factory,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retry.state.created, 0);

  finishClose();
  await retryRequest;
  assert.equal(decodeCount, 1);
  assert.equal(retry.state.decoded, 1);
});

test('the global decode gate serializes different Blobs until an abandoned context closes', async () => {
  const firstController = new AbortController();
  const firstBlob = new Blob([new Uint8Array([1])]);
  const secondBlob = new Blob([new Uint8Array([2])]);
  let firstCloseStarted = 0;
  let finishFirstClose;
  const firstFactory = (contextOptions) => ({
    sampleRate: contextOptions.sampleRate,
    decodeAudioData: () => Promise.resolve(smallBuffer()),
    close() {
      firstCloseStarted += 1;
      return new Promise((resolve) => { finishFirstClose = resolve; });
    },
  });
  const first = extractAudioPeaks(firstBlob, {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    signal: firstController.signal,
    createAudioContext: firstFactory,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstCloseStarted, 1);

  firstController.abort();
  await assert.rejects(first, errorCode('aborted'));
  const secondHarness = contextHarness({ buffer: smallBuffer() });
  const second = extractAudioPeaks(secondBlob, {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: secondHarness.factory,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondHarness.state.created, 0);
  assert.equal(secondHarness.state.decoded, 0);

  finishFirstClose();
  assert.equal((await second).status, 'ready');
  assert.equal(secondHarness.state.created, 1);
  assert.equal(secondHarness.state.decoded, 1);
});

test('concurrent consumers share one decode and one abort never contaminates the other', async () => {
  const harness = contextHarness({ buffer: smallBuffer(), pending: true });
  const controller = new AbortController();
  const blob = new Blob([new Uint8Array(1)]);
  const options = {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: harness.factory,
  };
  const cancelled = extractAudioPeaks(blob, { ...options, signal: controller.signal });
  const survivor = extractAudioPeaks(blob, options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state.created, 1);
  assert.equal(harness.state.decoded, 1);

  controller.abort();
  await assert.rejects(cancelled, errorCode('aborted'));
  harness.resolveDecode();
  const result = await survivor;

  assert.equal(result.status, 'ready');
  assert.equal(harness.state.closed, 1);
  assert.equal(await extractAudioPeaks(blob, options), result);
});

test('a coalesced decode is cancelled only when its final consumer aborts', async () => {
  const pending = contextHarness({ buffer: smallBuffer(), pending: true });
  const firstController = new AbortController();
  const finalController = new AbortController();
  const blob = new Blob([new Uint8Array(1)]);
  const options = {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    createAudioContext: pending.factory,
  };
  const first = extractAudioPeaks(blob, { ...options, signal: firstController.signal });
  const final = extractAudioPeaks(blob, { ...options, signal: finalController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.state.decoded, 1);

  firstController.abort();
  await assert.rejects(first, errorCode('aborted'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.state.closed, 0);

  finalController.abort();
  await assert.rejects(final, errorCode('aborted'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.state.closed, 1);

  const retry = contextHarness({ buffer: smallBuffer() });
  const result = await extractAudioPeaks(blob, {
    ...options,
    createAudioContext: retry.factory,
  });
  assert.equal(result.status, 'ready');
  assert.equal(retry.state.decoded, 1);
  pending.resolveDecode();
});

test('concurrent consumers share bytes even when one applies a stricter post-decode limit', async () => {
  const harness = contextHarness({ buffer: smallBuffer(), pending: true });
  const blob = new Blob([new Uint8Array(1)]);
  const common = {
    bucketCount: 2,
    createAudioContext: harness.factory,
  };
  const strict = extractAudioPeaks(blob, {
    ...common,
    duration: 0.00001,
    limits: testLimits({ maxEstimatedPcmBytes: 31 }),
  });
  const ordinary = extractAudioPeaks(blob, {
    ...common,
    duration: 1,
    limits: testLimits(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state.decoded, 1);
  harness.resolveDecode();

  await assert.rejects(strict, errorCode('decoded-pcm-too-large'));
  assert.equal((await ordinary).status, 'ready');
  assert.equal(harness.state.closed, 1);
});

test('decode failures remain public errors and always close the AudioContext', async () => {
  const harness = contextHarness({ decodeError: new Error('codec exploded') });
  await assert.rejects(
    extractAudioPeaks(new Blob([new Uint8Array(1)]), {
      duration: 1,
      limits: testLimits(),
      createAudioContext: harness.factory,
    }),
    (error) => (
      errorCode('decode-failed')(error)
      && error.details.cause === 'codec exploded'
      && /decodificar/.test(error.message)
    ),
  );
  assert.equal(harness.state.closed, 1);
});

test('a close failure never discards ready peaks or hides a decode failure', async () => {
  const closeOnly = contextHarness({ buffer: smallBuffer(), closeError: new Error('cannot close') });
  const result = await extractAudioPeaks(new Blob([new Uint8Array(1)]), {
    duration: 1,
    limits: testLimits(),
    createAudioContext: closeOnly.factory,
  });
  assert.equal(result.status, 'ready');
  assert.equal(closeOnly.state.closed, 1);

  const both = contextHarness({
    decodeError: new Error('bad codec'),
    closeError: new Error('cannot close'),
  });
  await assert.rejects(
    extractAudioPeaks(new Blob([new Uint8Array(1)]), {
      duration: 1,
      limits: testLimits(),
      createAudioContext: both.factory,
    }),
    errorCode('decode-failed'),
  );
  assert.equal(both.state.closed, 1);
});

test('a never-settling Blob read fails with a stable timeout and releases the global queue', async () => {
  const blocked = new Blob([new Uint8Array(1)]);
  let finishRead;
  blocked.arrayBuffer = () => new Promise((resolve) => { finishRead = resolve; });

  await assert.rejects(
    extractAudioPeaks(blocked, {
      duration: 1,
      sampleRate: 48_000,
      channels: 2,
      limits: testLimits(),
      timeouts: { readMs: 15, decodeMs: 100, closeMs: 15 },
      createAudioContext: contextHarness({ buffer: smallBuffer() }).factory,
    }),
    (error) => errorCode('read-timeout')(error)
      && error.message === 'La lectura del audio tardó demasiado.'
      && error.details.stage === 'reading'
      && error.details.timeoutMs === 15,
  );

  const survivor = contextHarness({ buffer: smallBuffer() });
  const result = await extractAudioPeaks(new Blob([new Uint8Array(2)]), {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    timeouts: { readMs: 100, decodeMs: 100, closeMs: 15 },
    createAudioContext: survivor.factory,
  });
  assert.equal(result.status, 'ready');
  assert.equal(survivor.state.decoded, 1);
  finishRead?.(new ArrayBuffer(1));
});

test('never-settling decode and close promises time out without poisoning the global queue', async () => {
  const blocked = contextHarness({
    buffer: smallBuffer(),
    pending: true,
    closePending: true,
  });

  await assert.rejects(
    extractAudioPeaks(new Blob([new Uint8Array(1)]), {
      duration: 1,
      bucketCount: 2,
      limits: testLimits(),
      timeouts: { readMs: 100, decodeMs: 15, closeMs: 15 },
      createAudioContext: blocked.factory,
    }),
    (error) => errorCode('decode-timeout')(error)
      && error.message === 'La decodificación del audio tardó demasiado.'
      && error.details.stage === 'decoding'
      && error.details.timeoutMs === 15,
  );
  assert.equal(blocked.state.decoded, 1);
  assert.equal(blocked.state.closed, 1);

  const survivor = contextHarness({ buffer: smallBuffer() });
  const result = await extractAudioPeaks(new Blob([new Uint8Array(2)]), {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    timeouts: { readMs: 100, decodeMs: 100, closeMs: 15 },
    createAudioContext: survivor.factory,
  });
  assert.equal(result.status, 'ready');
  assert.equal(survivor.state.decoded, 1);

  blocked.resolveDecode();
  blocked.resolveClose();
});

test('a never-settling close keeps ready peaks and releases the next decode', async () => {
  const blocked = contextHarness({ buffer: smallBuffer(), closePending: true });
  const result = await extractAudioPeaks(new Blob([new Uint8Array(1)]), {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    timeouts: { readMs: 100, decodeMs: 100, closeMs: 15 },
    createAudioContext: blocked.factory,
  });
  assert.equal(result.status, 'ready');
  assert.equal(blocked.state.closed, 1);

  const survivor = contextHarness({ buffer: smallBuffer() });
  assert.equal((await extractAudioPeaks(new Blob([new Uint8Array(2)]), {
    duration: 1,
    bucketCount: 2,
    limits: testLimits(),
    timeouts: { readMs: 100, decodeMs: 100, closeMs: 15 },
    createAudioContext: survivor.factory,
  })).status, 'ready');
  assert.equal(survivor.state.decoded, 1);
  blocked.resolveClose();
});

test('context creation and peak access failures use public codes, closing whenever possible', async () => {
  const blob = new Blob([new Uint8Array(1)]);
  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 1,
      limits: testLimits(),
      createAudioContext: () => { throw new Error('construction blocked'); },
    }),
    (error) => errorCode('audio-context-create-failed')(error)
      && error.details.cause === 'construction blocked',
  );

  let closes = 0;
  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 1,
      limits: testLimits(),
      createAudioContext: (contextOptions) => ({
        sampleRate: contextOptions.sampleRate,
        decodeAudioData: () => Promise.resolve({
          duration: 1,
          sampleRate: 4,
          numberOfChannels: 1,
          length: 4,
          getChannelData: () => { throw new Error('detached channel'); },
        }),
        close: async () => { closes += 1; },
      }),
    }),
    (error) => errorCode('peak-generation-failed')(error)
      && error.details.cause === 'detached channel',
  );
  assert.equal(closes, 1);
});

test('decoded PCM accounting always uses Web Audio Float32 bytes', async () => {
  const harness = contextHarness({ buffer: smallBuffer() });
  await assert.rejects(
    extractAudioPeaks(new Blob([new Uint8Array(1)]), {
      duration: 0.00001,
      bucketCount: 2,
      limits: testLimits({
        maxEstimatedPcmBytes: 31,
      }),
      createAudioContext: harness.factory,
    }),
    errorCode('decoded-pcm-too-large'),
  );
  assert.equal(harness.state.closed, 1);
});

test('unsafe limit overrides cannot weaken built-in read and PCM assumptions', async () => {
  const blob = new Blob([new Uint8Array(1)]);
  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 1,
      limits: testLimits({ maxSourceBytes: AUDIO_PEAKS_DEFAULT_LIMITS.maxSourceBytes + 1 }),
    }),
    errorCode('unsafe-limits'),
  );
  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 1,
      limits: testLimits({ estimateChannels: 1 }),
    }),
    errorCode('unsafe-limits'),
  );
});

test('decoded duration detects an understated trusted hint and still closes', async () => {
  const harness = contextHarness({ buffer: decodedBuffer([new Float32Array(12)], 1, 12) });
  await assert.rejects(
    extractAudioPeaks(new Blob([new Uint8Array(1)]), {
      duration: 1,
      bucketCount: 2,
      limits: testLimits(),
      createAudioContext: harness.factory,
    }),
    (error) => errorCode('duration-hint-mismatch')(error)
      && error.details.hintedSeconds === 1
      && error.details.decodedSeconds === 12,
  );
  assert.equal(harness.state.closed, 1);
});

test('invalid duration, bucket count and decoded PCM are rejected with stable codes', async () => {
  const blob = new Blob([new Uint8Array(1)]);
  await assert.rejects(extractAudioPeaks(blob, { limits: testLimits() }), errorCode('duration-required'));
  await assert.rejects(
    extractAudioPeaks(blob, { duration: 1, bucketCount: 33, limits: testLimits() }),
    errorCode('invalid-bucket-count'),
  );

  const oversized = contextHarness({
    buffer: decodedBuffer([new Float32Array(20), new Float32Array(20)], 20, 1),
  });
  await assert.rejects(
    extractAudioPeaks(blob, {
      duration: 0.0001,
      sampleRate: 48_000,
      channels: 2,
      bucketCount: 2,
      limits: testLimits({ maxEstimatedPcmBytes: 100 }),
      createAudioContext: oversized.factory,
    }),
    errorCode('decoded-pcm-too-large'),
  );
  assert.equal(oversized.state.closed, 1);
});
