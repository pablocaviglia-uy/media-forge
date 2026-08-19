/**
 * Safe, dependency-free waveform extraction for Audio Lab.
 *
 * Decoding compressed audio expands it to PCM, often by orders of magnitude.
 * Callers therefore need to provide the media duration and every source is
 * checked before `Blob.arrayBuffer()` or Web Audio are touched. Decoded bytes
 * and AudioBuffers are never cached: only small, immutable peak summaries are.
 */

export const AUDIO_PEAKS_DEFAULT_BUCKETS = 2_048;
const WEB_AUDIO_BYTES_PER_SAMPLE = 4;

export const AUDIO_PEAKS_DEFAULT_LIMITS = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxDurationSeconds: 15 * 60,
  maxEstimatedPcmBytes: 256 * 1024 * 1024,
  maxBuckets: 8_192,
  // When trusted probe metadata is unavailable, assume high-resolution 7.1.
  // This is intentionally stricter than the common 48 kHz stereo case: a
  // compressed source's byte size cannot bound Web Audio's PCM allocation.
  estimateSampleRate: 96_000,
  estimateChannels: 8,
  bytesPerSample: 4,
});

let peakCache = new WeakMap();
let inFlightCache = new WeakMap();
// Web Audio decoding can transiently allocate the whole PCM source. Keep a
// process-wide gate so rapid navigation between different Blobs cannot overlap
// those allocations while an abandoned AudioContext is still closing.
let decodeQueueTail = Promise.resolve();

const DURATION_HINT_TOLERANCE_SECONDS = 1;
const DURATION_HINT_TOLERANCE_RATIO = 0.05;
const TRUSTED_SAMPLE_RATE_FLOOR = 48_000;
const TRUSTED_CHANNELS_FLOOR = 2;

const finitePositive = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

const isBlobLike = (value) => (
  value !== null
  && typeof value === 'object'
  && typeof value.size === 'number'
  && Number.isFinite(value.size)
  && value.size >= 0
  && typeof value.arrayBuffer === 'function'
);

const isChannel = (value) => (
  value !== null
  && typeof value !== 'string'
  && typeof value.length === 'number'
  && Number.isInteger(value.length)
  && value.length >= 0
);

const clampSample = (value) => {
  const sample = Number(value);
  if (!Number.isFinite(sample)) return 0;
  return Math.min(1, Math.max(-1, sample));
};

const frozenDetails = (details) => Object.freeze({ ...details });

export class AudioPeaksError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = code === 'aborted' ? 'AbortError' : 'AudioPeaksError';
    this.code = code;
    this.details = frozenDetails(details);
  }
}

function fail(code, message, details) {
  throw new AudioPeaksError(code, message, details);
}

function normalizeLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    fail('invalid-limits', 'Los límites de la forma de onda no son válidos.');
  }
  const limits = { ...AUDIO_PEAKS_DEFAULT_LIMITS, ...overrides };
  for (const key of [
    'maxSourceBytes',
    'maxDurationSeconds',
    'maxEstimatedPcmBytes',
    'maxBuckets',
    'estimateSampleRate',
    'estimateChannels',
    'bytesPerSample',
  ]) {
    if (!finitePositive(limits[key])) {
      fail('invalid-limits', `El límite ${key} debe ser un número positivo.`, { key, value: limits[key] });
    }
  }
  if (!Number.isInteger(limits.maxBuckets) || !Number.isInteger(limits.estimateChannels)) {
    fail('invalid-limits', 'maxBuckets y estimateChannels deben ser enteros positivos.');
  }
  // Runtime overrides may tighten the safety envelope but cannot silently
  // weaken it. Raising an estimate is conservative; raising a maximum is not.
  for (const key of ['maxSourceBytes', 'maxDurationSeconds', 'maxEstimatedPcmBytes', 'maxBuckets']) {
    if (limits[key] > AUDIO_PEAKS_DEFAULT_LIMITS[key]) {
      fail('unsafe-limits', `El límite ${key} no puede superar el máximo seguro incorporado.`, {
        key,
        requested: limits[key],
        safeMaximum: AUDIO_PEAKS_DEFAULT_LIMITS[key],
      });
    }
  }
  for (const key of ['estimateSampleRate', 'estimateChannels', 'bytesPerSample']) {
    if (limits[key] < AUDIO_PEAKS_DEFAULT_LIMITS[key]) {
      fail('unsafe-limits', `La estimación ${key} no puede reducir el margen seguro incorporado.`, {
        key,
        requested: limits[key],
        safeMinimum: AUDIO_PEAKS_DEFAULT_LIMITS[key],
      });
    }
  }
  return Object.freeze(limits);
}

function normalizeBucketCount(value, limits) {
  const buckets = value === undefined
    ? Math.min(AUDIO_PEAKS_DEFAULT_BUCKETS, limits.maxBuckets)
    : value;
  if (!Number.isInteger(buckets) || buckets <= 0 || buckets > limits.maxBuckets) {
    fail(
      'invalid-bucket-count',
      `La cantidad de bloques debe estar entre 1 y ${limits.maxBuckets}.`,
      { requested: buckets, max: limits.maxBuckets },
    );
  }
  return buckets;
}

function normalizeDuration(value) {
  if (!finitePositive(value)) {
    fail(
      'duration-required',
      'Se necesita una duración válida para calcular la forma de onda de manera segura.',
      { duration: value ?? null },
    );
  }
  return value;
}

function normalizePcmHint(options, limits) {
  const providedSampleRate = options.sampleRate !== undefined;
  const providedChannels = options.channels !== undefined;
  if (providedSampleRate && !finitePositive(options.sampleRate)) {
    fail('invalid-pcm-hint', 'La frecuencia informada para estimar PCM no es válida.', {
      sampleRate: options.sampleRate,
    });
  }
  if (providedChannels && (!Number.isInteger(options.channels) || options.channels <= 0)) {
    fail('invalid-pcm-hint', 'La cantidad de canales informada para estimar PCM no es válida.', {
      channels: options.channels,
    });
  }
  return Object.freeze({
    sampleRate: providedSampleRate
      ? Math.max(options.sampleRate, TRUSTED_SAMPLE_RATE_FLOOR)
      : limits.estimateSampleRate,
    channels: providedChannels
      ? Math.max(options.channels, TRUSTED_CHANNELS_FLOOR)
      : limits.estimateChannels,
    usedFallbackSampleRate: !providedSampleRate,
    usedFallbackChannels: !providedChannels,
  });
}

function validateSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (
    typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
  ) {
    fail('invalid-signal', 'La señal de cancelación no es válida.');
  }
  return signal;
}

function aborted(stage) {
  return new AudioPeaksError(
    'aborted',
    'Se canceló el análisis de la forma de onda.',
    { stage },
  );
}

function throwIfAborted(signal, stage) {
  if (signal?.aborted) throw aborted(stage);
}

/** Estimate the uncompressed Float32 PCM footprint used by Web Audio. */
export function estimateAudioPcmBytes(duration, options = {}) {
  if (!finitePositive(duration)) {
    fail('invalid-duration', 'La duración para estimar PCM debe ser positiva.', { duration });
  }
  const sampleRate = options.sampleRate ?? AUDIO_PEAKS_DEFAULT_LIMITS.estimateSampleRate;
  const channels = options.channels ?? AUDIO_PEAKS_DEFAULT_LIMITS.estimateChannels;
  const bytesPerSample = options.bytesPerSample ?? AUDIO_PEAKS_DEFAULT_LIMITS.bytesPerSample;
  if (!finitePositive(sampleRate) || !Number.isInteger(channels) || channels <= 0 || !finitePositive(bytesPerSample)) {
    fail('invalid-pcm-estimate', 'Los datos para estimar PCM no son válidos.', {
      sampleRate,
      channels,
      bytesPerSample,
    });
  }
  return Math.ceil(duration * sampleRate * channels * bytesPerSample);
}

function validateBeforeRead(blob, duration, limits, pcmHint) {
  if (blob.size > limits.maxSourceBytes) {
    fail(
      'source-too-large',
      'El archivo es demasiado grande para calcular su forma de onda de forma segura.',
      { actualBytes: blob.size, maxBytes: limits.maxSourceBytes },
    );
  }
  if (duration > limits.maxDurationSeconds) {
    fail(
      'duration-too-long',
      'El audio es demasiado largo para calcular su forma de onda de forma segura.',
      { actualSeconds: duration, maxSeconds: limits.maxDurationSeconds },
    );
  }
  const estimatedPcmBytes = estimateAudioPcmBytes(duration, {
    sampleRate: pcmHint.sampleRate,
    channels: pcmHint.channels,
    bytesPerSample: limits.bytesPerSample,
  });
  if (estimatedPcmBytes > limits.maxEstimatedPcmBytes) {
    fail(
      'estimated-pcm-too-large',
      'El audio ocuparía demasiada memoria una vez decodificado.',
      {
        estimatedPcmBytes,
        maxBytes: limits.maxEstimatedPcmBytes,
        sampleRate: pcmHint.sampleRate,
        channels: pcmHint.channels,
        usedFallbackSampleRate: pcmHint.usedFallbackSampleRate,
        usedFallbackChannels: pcmHint.usedFallbackChannels,
      },
    );
  }
  return estimatedPcmBytes;
}

function validateDecodedSummary(summary, limits) {
  if (summary.duration > limits.maxDurationSeconds) {
    fail('decoded-duration-too-long', 'La duración decodificada supera el límite seguro.', {
      actualSeconds: summary.duration,
      maxSeconds: limits.maxDurationSeconds,
    });
  }
  if (summary.pcmBytes > limits.maxEstimatedPcmBytes) {
    fail('decoded-pcm-too-large', 'El audio decodificado supera el límite seguro de memoria.', {
      actualBytes: summary.pcmBytes,
      maxBytes: limits.maxEstimatedPcmBytes,
    });
  }
}

function validateDurationHint(summary, hintedDuration) {
  const tolerance = Math.max(
    DURATION_HINT_TOLERANCE_SECONDS,
    hintedDuration * DURATION_HINT_TOLERANCE_RATIO,
  );
  if (summary.duration > hintedDuration + tolerance) {
    fail('duration-hint-mismatch', 'La duración real supera de forma insegura la duración informada.', {
      hintedSeconds: hintedDuration,
      decodedSeconds: summary.duration,
      toleranceSeconds: tolerance,
    });
  }
}

/**
 * Pure min/max downsampling across every supplied channel. Every input frame
 * belongs to exactly one output bucket so a one-frame transient is preserved.
 */
export function downsampleAudioPeaks(channels, bucketCount = AUDIO_PEAKS_DEFAULT_BUCKETS) {
  if (!Array.isArray(channels) || !channels.length || !channels.every(isChannel)) {
    fail('invalid-channel-data', 'Se necesita al menos un canal de audio válido.');
  }
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    fail('invalid-bucket-count', 'La cantidad de bloques debe ser un entero positivo.', {
      requested: bucketCount,
    });
  }

  const frameCount = channels[0].length;
  if (!frameCount) return Object.freeze([]);
  if (channels.some((channel) => channel.length !== frameCount)) {
    fail('channel-length-mismatch', 'Todos los canales deben tener la misma cantidad de muestras.', {
      lengths: channels.map((channel) => channel.length),
    });
  }

  const outputCount = Math.min(bucketCount, frameCount);
  const peaks = new Array(outputCount);
  for (let bucket = 0; bucket < outputCount; bucket += 1) {
    const from = Math.floor((bucket * frameCount) / outputCount);
    const to = Math.floor(((bucket + 1) * frameCount) / outputCount);
    let min = 1;
    let max = -1;
    for (const channel of channels) {
      for (let frame = from; frame < to; frame += 1) {
        const sample = clampSample(channel[frame]);
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
    }
    peaks[bucket] = Object.freeze({ min, max });
  }
  return Object.freeze(peaks);
}

function downsampleAudioBuffer(audioBuffer, bucketCount) {
  const channels = [];
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    channels.push(audioBuffer.getChannelData(channel));
  }
  return downsampleAudioPeaks(channels, bucketCount);
}

function decodeAudioDataCompat(context, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      // Supplying callbacks retains compatibility with Safari's older Web
      // Audio shape; current engines also return a Promise from this call.
      const result = context.decodeAudioData(bytes, resolveOnce, rejectOnce);
      if (result && typeof result.then === 'function') result.then(resolveOnce, rejectOnce);
    } catch (error) {
      rejectOnce(error);
    }
  });
}

function raceWithAbort(promise, signal, stage) {
  if (!signal) return promise;
  throwIfAborted(signal, stage);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, aborted(stage));
    signal.addEventListener('abort', onAbort, { once: true });
    // Abort can happen between the check above and listener registration.
    if (signal.aborted) onAbort();
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function defaultAudioContextFactory(contextOptions) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextClass !== 'function') {
    fail('audio-context-unavailable', 'Este navegador no ofrece Web Audio para generar la forma de onda.');
  }
  return new AudioContextClass(contextOptions);
}

function validateAudioContextSampleRate(context, requestedSampleRate) {
  if (!finitePositive(context?.sampleRate)) {
    fail('invalid-audio-context', 'El contexto Web Audio no informó una frecuencia válida.');
  }
  if (context.sampleRate > requestedSampleRate) {
    fail(
      'audio-context-sample-rate-too-high',
      'El navegador no pudo respetar la frecuencia segura solicitada para analizar el audio.',
      {
        requestedSampleRate,
        actualSampleRate: context.sampleRate,
      },
    );
  }
  return context.sampleRate;
}

function validateAudioBuffer(audioBuffer) {
  const duration = audioBuffer?.duration;
  const sampleRate = audioBuffer?.sampleRate;
  const channelCount = audioBuffer?.numberOfChannels;
  const frameCount = audioBuffer?.length;
  if (
    !finitePositive(duration)
    || !finitePositive(sampleRate)
    || !Number.isInteger(channelCount)
    || channelCount <= 0
    || !Number.isInteger(frameCount)
    || frameCount <= 0
    || typeof audioBuffer.getChannelData !== 'function'
  ) {
    fail('invalid-decoded-audio', 'El navegador devolvió audio decodificado no válido.');
  }
  return { duration, sampleRate, channelCount, frameCount };
}

function publicResult(metadata, peaks) {
  return Object.freeze({
    status: 'ready',
    peaks,
    duration: metadata.duration,
    sampleRate: metadata.sampleRate,
    channelCount: metadata.channelCount,
    frameCount: metadata.frameCount,
    pcmBytes: metadata.pcmBytes,
    bucketCount: peaks.length,
  });
}

function cacheResult(blob, bucketCount, result) {
  let entries = peakCache.get(blob);
  if (!entries) {
    entries = new Map();
    peakCache.set(blob, entries);
  }
  entries.set(bucketCount, result);
}

function removeInFlightEntry(entry) {
  const entries = inFlightCache.get(entry.blob);
  if (!entries || entries.get(entry.key) !== entry) return;
  entries.delete(entry.key);
  if (!entries.size) inFlightCache.delete(entry.blob);
}

function serializeDecode(signal, operation) {
  const queued = decodeQueueTail.then(() => {
    throwIfAborted(signal, 'before-serialized-decode');
    return operation();
  });
  // The tail carries neither decoded results nor failures once this turn is
  // done, and a failed decode can never poison the following queued source.
  decodeQueueTail = queued.then(() => undefined, () => undefined);
  return queued;
}

function sharedExtraction(blob, bucketCount, createAudioContext, contextSampleRate) {
  let entries = inFlightCache.get(blob);
  if (!entries) {
    entries = new Map();
    inFlightCache.set(blob, entries);
  }
  const key = bucketCount;
  const existing = entries.get(key);
  if (existing) return existing;

  // Each consumer keeps its own AbortSignal, but the shared decode also owns
  // a controller. It is cancelled only when its final consumer leaves. That
  // preserves coalescing for surviving callers while ensuring abandoned
  // decodes close their AudioContext and never warm the cache.
  const controller = new AbortController();
  const entry = {
    blob,
    key,
    controller,
    consumers: 0,
    cancelled: false,
    settled: false,
    operation: null,
  };
  entries.set(key, entry);

  const decoding = serializeDecode(controller.signal, () => decodePeaks(
    blob,
    bucketCount,
    AUDIO_PEAKS_DEFAULT_LIMITS,
    controller.signal,
    createAudioContext,
    contextSampleRate,
  ))
    .then((result) => {
      throwIfAborted(controller.signal, 'no-consumers');
      cacheResult(blob, bucketCount, result);
      return result;
    });
  entry.operation = decoding.then(
    (result) => {
      entry.settled = true;
      removeInFlightEntry(entry);
      return result;
    },
    (error) => {
      entry.settled = true;
      removeInFlightEntry(entry);
      throw error;
    },
  );
  return entry;
}

async function consumeSharedExtraction(
  blob,
  bucketCount,
  createAudioContext,
  contextSampleRate,
  signal,
) {
  // A new caller can arrive while an abandoned context is closing. Wait for
  // that cleanup before replacing the entry so two decodes for the same Blob
  // and bucket cannot overlap.
  let entry = sharedExtraction(blob, bucketCount, createAudioContext, contextSampleRate);
  while (entry.cancelled && !entry.settled) {
    await raceWithAbort(entry.operation.catch(() => undefined), signal, 'waiting-for-cancelled-decode');
    entry = sharedExtraction(blob, bucketCount, createAudioContext, contextSampleRate);
  }

  entry.consumers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.consumers = Math.max(0, entry.consumers - 1);
    if (!entry.consumers && !entry.settled && !entry.cancelled) {
      entry.cancelled = true;
      entry.controller.abort();
    }
  };

  try {
    return await raceWithAbort(entry.operation, signal, 'extracting');
  } finally {
    release();
  }
}

async function decodePeaks(
  blob,
  bucketCount,
  limits,
  signal,
  createAudioContext,
  contextSampleRate,
) {
  throwIfAborted(signal, 'before-read');
  let bytes;
  try {
    bytes = await raceWithAbort(blob.arrayBuffer(), signal, 'reading');
  } catch (error) {
    if (error instanceof AudioPeaksError) throw error;
    throw new AudioPeaksError('read-failed', 'No se pudo leer el audio local.', {
      cause: error?.message || String(error),
    });
  }
  if (!(bytes instanceof ArrayBuffer)) {
    fail('invalid-array-buffer', 'La lectura del audio no devolvió bytes válidos.');
  }

  throwIfAborted(signal, 'before-decode');
  let context;
  let primaryError = null;
  try {
    try {
      context = createAudioContext({ sampleRate: contextSampleRate });
    } catch (error) {
      if (error instanceof AudioPeaksError) throw error;
      throw new AudioPeaksError('audio-context-create-failed', 'No se pudo iniciar el contexto de audio.', {
        cause: error?.message || String(error),
      });
    }
    if (!context || typeof context.decodeAudioData !== 'function' || typeof context.close !== 'function') {
      fail('invalid-audio-context', 'La implementación de Web Audio no es válida.');
    }
    validateAudioContextSampleRate(context, contextSampleRate);
    let audioBuffer;
    try {
      audioBuffer = await raceWithAbort(decodeAudioDataCompat(context, bytes), signal, 'decoding');
    } catch (error) {
      if (error instanceof AudioPeaksError) throw error;
      throw new AudioPeaksError('decode-failed', 'No se pudo decodificar este archivo de audio.', {
        cause: error?.message || String(error),
      });
    }
    throwIfAborted(signal, 'before-downsample');
    const metadata = validateAudioBuffer(audioBuffer);
    metadata.pcmBytes = metadata.frameCount * metadata.channelCount * WEB_AUDIO_BYTES_PER_SAMPLE;
    validateDecodedSummary(metadata, limits);
    let peaks;
    try {
      peaks = downsampleAudioBuffer(audioBuffer, bucketCount);
    } catch (error) {
      if (error instanceof AudioPeaksError) throw error;
      throw new AudioPeaksError('peak-generation-failed', 'No se pudieron calcular los picos del audio.', {
        cause: error?.message || String(error),
      });
    }
    throwIfAborted(signal, 'after-downsample');
    return publicResult(metadata, peaks);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (context && typeof context.close === 'function') {
      try {
        await context.close();
      } catch (error) {
        if (!primaryError) {
          throw new AudioPeaksError('context-close-failed', 'No se pudo cerrar el contexto de audio.', {
            cause: error?.message || String(error),
          });
        }
      }
    }
  }
}

/**
 * Decode a small-enough local Blob and return immutable min/max peaks.
 *
 * `duration` is deliberately required: without it, compressed size alone
 * cannot provide a safe upper bound for Web Audio's decoded PCM allocation.
 * It is a trust boundary and should come from MediaForge's own probe/result
 * metadata, not user-entered text. `sampleRate` and `channels` may likewise be
 * supplied from trusted probe metadata. Missing values fall back independently
 * to a conservative 96 kHz / 8-channel estimate; callers must not pass
 * user-entered values to relax that preflight.
 * `createAudioContext` is injectable for tests and receives the same standard
 * `{ sampleRate }` options object used by the native AudioContext constructor.
 */
export async function extractAudioPeaks(blob, options = {}) {
  const signal = validateSignal(options.signal);
  throwIfAborted(signal, 'start');
  if (!isBlobLike(blob)) fail('invalid-blob', 'Se necesita un Blob de audio local válido.');
  const limits = normalizeLimits(options.limits);
  const bucketCount = normalizeBucketCount(options.bucketCount, limits);
  const duration = normalizeDuration(options.duration);
  const pcmHint = normalizePcmHint(options, limits);
  validateBeforeRead(blob, duration, limits, pcmHint);

  const cached = peakCache.get(blob)?.get(bucketCount);
  if (cached) {
    validateDecodedSummary(cached, limits);
    validateDurationHint(cached, duration);
    throwIfAborted(signal, 'cache');
    return cached;
  }

  const createAudioContext = options.createAudioContext ?? defaultAudioContextFactory;
  if (typeof createAudioContext !== 'function') {
    fail('invalid-audio-context-factory', 'El creador del contexto de audio no es válido.');
  }

  const result = await consumeSharedExtraction(
    blob,
    bucketCount,
    createAudioContext,
    pcmHint.sampleRate,
    signal,
  );
  validateDecodedSummary(result, limits);
  validateDurationHint(result, duration);
  throwIfAborted(signal, 'complete');
  return result;
}

/** Drop one Blob's summaries, or replace the WeakMap during tests/logout. */
export function clearAudioPeaksCache(blob) {
  if (blob === undefined) {
    peakCache = new WeakMap();
    inFlightCache = new WeakMap();
    return;
  }
  if (blob && typeof blob === 'object') {
    peakCache.delete(blob);
    inFlightCache.delete(blob);
  }
}
