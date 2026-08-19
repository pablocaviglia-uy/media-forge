/**
 * Focused quick-tool state.
 *
 * The catalogue says which tools exist; this module says which of those tools
 * already has a dedicated experience and translates the app's conversion
 * options into the small, predictable state that experience needs. Keeping it
 * pure lets the shell, inspector and tests agree without involving the DOM.
 */

import { formatBytes, formatDuration, formatTimestamp } from '../ui/dom.js';
import { RESOLUTIONS, VIDEO_FORMATS } from './formats.js';

const VIDEO_TRIM = Object.freeze({
  id: 'video-trim',
  title: 'Cortar video',
  operation: 'convert',
  accept: 'video/*',
  focus: 'trim',
  defaultOptions: Object.freeze({ trimStart: null, trimEnd: null }),
});

const VIDEO_ROTATE = Object.freeze({
  id: 'video-rotate',
  title: 'Girar video',
  operation: 'convert',
  accept: 'video/*',
  focus: 'rotate',
  defaultOptions: Object.freeze({ rotate: 90 }),
});

const VIDEO_FLIP = Object.freeze({
  id: 'video-flip',
  title: 'Voltear video',
  operation: 'convert',
  accept: 'video/*',
  focus: 'flip',
  defaultOptions: Object.freeze({ flip: 'horizontal' }),
});

const VIDEO_RESIZE = Object.freeze({
  id: 'video-resize',
  title: 'Redimensionar video',
  operation: 'convert',
  accept: 'video/*',
  focus: 'resize',
  defaultOptions: Object.freeze({ resolution: '720' }),
});

const VIDEO_CROP = Object.freeze({
  id: 'video-crop',
  title: 'Recortar encuadre',
  operation: 'convert',
  accept: 'video/*',
  focus: 'crop',
  // Null geometry means "use the full visible frame". It gives the cropper a
  // real initial selection once metadata arrives, while remaining a no-op for
  // the command builder until a handle moves or an aspect preset is chosen.
  defaultOptions: Object.freeze({
    cropAspect: 'free',
    cropX: null,
    cropY: null,
    cropWidth: null,
    cropHeight: null,
  }),
});

const VIDEO_VOLUME = Object.freeze({
  id: 'video-volume',
  title: 'Cambiar volumen',
  operation: 'convert',
  accept: 'video/*',
  focus: 'volume',
  defaultOptions: Object.freeze({ volumeGain: 1.5, mute: false }),
});

const VIDEO_SPEED = Object.freeze({
  id: 'video-speed',
  title: 'Cambiar velocidad',
  operation: 'convert',
  accept: 'video/*',
  focus: 'speed',
  // `speed` already means the video encoder preset in commands.js. Keeping
  // playback in its own field prevents a 2x choice from becoming `-preset 2`.
  defaultOptions: Object.freeze({ playbackRate: 1.5 }),
});

const VIDEO_LOOP = Object.freeze({
  id: 'video-loop',
  title: 'Repetir video',
  operation: 'convert',
  accept: 'video/*',
  focus: 'loop',
  defaultOptions: Object.freeze({ loopMode: 'count', loopCount: 2, loopDuration: null }),
});

const FOCUSED_TOOLS = new Map([
  [VIDEO_TRIM.id, VIDEO_TRIM],
  [VIDEO_ROTATE.id, VIDEO_ROTATE],
  [VIDEO_FLIP.id, VIDEO_FLIP],
  [VIDEO_RESIZE.id, VIDEO_RESIZE],
  [VIDEO_CROP.id, VIDEO_CROP],
  [VIDEO_VOLUME.id, VIDEO_VOLUME],
  [VIDEO_SPEED.id, VIDEO_SPEED],
  [VIDEO_LOOP.id, VIDEO_LOOP],
]);

const ROTATIONS = new Set([90, 180, 270]);
const FLIPS = new Set(['horizontal', 'vertical']);
const RESOLUTION_IDS = new Set(
  RESOLUTIONS.filter((resolution) => resolution.height !== null).map((resolution) => resolution.id),
);

/**
 * Ratios offered by the cropper. The resulting rectangle stays as close as an
 * even-pixel video frame can get to each ratio.
 */
export const CROP_ASPECT_PRESETS = Object.freeze([
  Object.freeze({ id: 'free', label: 'Libre', ratio: null }),
  Object.freeze({ id: '1:1', label: '1:1', ratio: 1 }),
  Object.freeze({ id: '16:9', label: '16:9', ratio: 16 / 9 }),
  Object.freeze({ id: '9:16', label: '9:16', ratio: 9 / 16 }),
  Object.freeze({ id: '4:5', label: '4:5', ratio: 4 / 5 }),
]);

const CROP_ASPECTS_BY_ID = new Map(CROP_ASPECT_PRESETS.map((preset) => [preset.id, preset]));

export const VOLUME_GAIN_LIMITS = Object.freeze({ min: 0, max: 2, default: 1.5 });
export const PLAYBACK_RATE_LIMITS = Object.freeze({ min: 0.25, max: 4, default: 1.5 });
export const VIDEO_LOOP_LIMITS = Object.freeze({
  minCount: 2,
  maxCount: 20,
  maxDuration: 30 * 60,
});

/**
 * A focused effect keeps both its source and its result in FFmpeg's MEMFS.
 * Stay well below the WebAssembly heap wall and keep deliberately expanding
 * operations bounded to a duration browsers can finish reliably.
 */
export const QUICK_EFFECT_PREFLIGHT_LIMITS = Object.freeze({
  maxOutputDuration: VIDEO_LOOP_LIMITS.maxDuration,
  maxMemfsBytes: 500 * 1024 * 1024,
});

export const VOLUME_GAIN_PRESETS = Object.freeze([
  Object.freeze({ value: 0, label: '0%' }),
  Object.freeze({ value: 0.5, label: '50%' }),
  Object.freeze({ value: 1, label: '100%' }),
  Object.freeze({ value: 1.5, label: '150%' }),
  Object.freeze({ value: 2, label: '200%' }),
]);

export const PLAYBACK_RATE_PRESETS = Object.freeze([
  Object.freeze({ value: 0.25, label: '0,25×' }),
  Object.freeze({ value: 0.5, label: '0,5×' }),
  Object.freeze({ value: 0.75, label: '0,75×' }),
  Object.freeze({ value: 1, label: '1×' }),
  Object.freeze({ value: 1.25, label: '1,25×' }),
  Object.freeze({ value: 1.5, label: '1,5×' }),
  Object.freeze({ value: 2, label: '2×' }),
  Object.freeze({ value: 3, label: '3×' }),
  Object.freeze({ value: 4, label: '4×' }),
]);

export const LOOP_COUNT_PRESETS = Object.freeze([2, 3, 4, 5, 10, 20]);

/** Return a focused tool's execution contract, or null for the generic flow. */
export function focusedQuickTool(toolId) {
  return FOCUSED_TOOLS.get(toolId) || null;
}

/** A focused video tool only becomes useful after probing a real video track. */
export function supportsFocusedQuickTool(toolId, info) {
  const tool = focusedQuickTool(toolId);
  if (!tool || !info?.hasVideo) return false;
  if (tool.focus === 'volume') return info.hasAudio === true;
  if (tool.focus === 'loop') return playableMediaDuration(info) !== null;
  return true;
}

function finiteOption(options, primary, alias) {
  if (Number.isFinite(options?.[primary])) return options[primary];
  if (Number.isFinite(options?.[alias])) return options[alias];
  return null;
}

/** Reduce arbitrary input to one of the orientations offered by the tool. */
export function normalizeRotation(value) {
  if (value === undefined || value === null || value === '') return VIDEO_ROTATE.defaultOptions.rotate;
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return null;
  const wrapped = ((degrees % 360) + 360) % 360;
  return ROTATIONS.has(wrapped) ? wrapped : null;
}

/** Horizontal and vertical are the only mirror operations FFmpeg receives. */
export function normalizeFlip(value) {
  if (value === undefined || value === null || value === '') return VIDEO_FLIP.defaultOptions.flip;
  return FLIPS.has(value) ? value : null;
}

/**
 * Height of the picture people actually see.
 *
 * Phones commonly store a landscape frame plus rotation metadata. FFmpeg
 * applies that orientation while decoding, so a quarter turn exchanges the
 * axes before our resize filter sees them.
 */
export function visibleVideoDimensions(info) {
  const storedWidth = info?.video?.width;
  const storedHeight = info?.video?.height;
  if (!Number.isFinite(storedWidth) || storedWidth <= 0) return null;
  if (!Number.isFinite(storedHeight) || storedHeight <= 0) return null;

  const width = Math.floor(storedWidth);
  const height = Math.floor(storedHeight);
  const rotation = ((Number(info.video.rotation) || 0) % 360 + 360) % 360;
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function visibleVideoHeight(info) {
  const height = info?.video?.height;
  if (!Number.isFinite(height) || height <= 0) return null;
  const rotation = ((Number(info.video.rotation) || 0) % 360 + 360) % 360;
  if (rotation !== 90 && rotation !== 270) return height;
  const width = info?.video?.width;
  return Number.isFinite(width) && width > 0 ? width : null;
}

/** The initial cropper selection, expressed in visible (auto-oriented) pixels. */
export function fullCropRect(info) {
  const dimensions = visibleVideoDimensions(info);
  return dimensions ? {
    cropX: 0,
    cropY: 0,
    cropWidth: dimensions.width,
    cropHeight: dimensions.height,
  } : null;
}

/** Reduce arbitrary UI state to one of the aspect buttons the cropper offers. */
export function normalizeCropAspect(value) {
  if (value === undefined || value === null || value === '') return VIDEO_CROP.defaultOptions.cropAspect;
  return CROP_ASPECTS_BY_ID.has(value) ? value : null;
}

const evenFloor = (value) => Math.floor(value / 2) * 2;
const evenNearest = (value) => Math.round(value / 2) * 2;
const hasCropGeometry = (options) => [
  ['cropX', 'x'],
  ['cropY', 'y'],
  ['cropWidth', 'width'],
  ['cropHeight', 'height'],
].some(([primary, alias]) => finiteOption(options, primary, alias) !== null);

/**
 * Clamp a rectangle to the visible frame and snap it to chroma-safe pixels.
 *
 * Coordinates and dimensions are all even. Besides keeping H.264/yuv420p
 * encodable, even origins prevent a crop from beginning halfway through a
 * chroma sample on common 4:2:0 sources.
 */
function safeCropRect(info, options = {}) {
  const frame = visibleVideoDimensions(info);
  if (!frame || frame.width < 2 || frame.height < 2) return null;

  const requestedX = finiteOption(options, 'cropX', 'x') ?? 0;
  const requestedY = finiteOption(options, 'cropY', 'y') ?? 0;
  const requestedWidth = finiteOption(options, 'cropWidth', 'width');
  const requestedHeight = finiteOption(options, 'cropHeight', 'height');
  if (requestedWidth !== null && requestedWidth <= 0) return null;
  if (requestedHeight !== null && requestedHeight <= 0) return null;

  const maxX = evenFloor(frame.width - 2);
  const maxY = evenFloor(frame.height - 2);
  const cropX = Math.min(maxX, evenFloor(Math.max(0, Math.round(requestedX))));
  const cropY = Math.min(maxY, evenFloor(Math.max(0, Math.round(requestedY))));
  const availableWidth = evenFloor(frame.width - cropX);
  const availableHeight = evenFloor(frame.height - cropY);
  const width = requestedWidth ?? frame.width - cropX;
  const height = requestedHeight ?? frame.height - cropY;
  const cropWidth = Math.min(availableWidth, Math.max(2, evenFloor(Math.round(width))));
  const cropHeight = Math.min(availableHeight, Math.max(2, evenFloor(Math.round(height))));

  return { cropX, cropY, cropWidth, cropHeight };
}

function cropRatio(value) {
  const preset = CROP_ASPECTS_BY_ID.get(value);
  if (preset) return preset;
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 0
    ? { id: null, ratio }
    : null;
}

/**
 * Fit an aspect ratio inside the visible frame, centred on the current crop.
 *
 * An arbitrary positive numeric ratio is accepted too. Passing `free` returns
 * the current safe rectangle (or the exact full frame when there is no current
 * selection).
 */
export function cropRectForAspect(info, ratio, current = null) {
  const frame = visibleVideoDimensions(info);
  if (!frame || frame.width < 2 || frame.height < 2) return null;

  const aspect = cropRatio(ratio ?? 'free');
  if (!aspect) return null;
  if (aspect.ratio === null) {
    return current && hasCropGeometry(current) ? safeCropRect(info, current) : fullCropRect(info);
  }

  let cropWidth;
  let cropHeight;
  if (frame.width / frame.height > aspect.ratio) {
    cropHeight = evenFloor(frame.height);
    cropWidth = Math.min(evenFloor(frame.width), evenNearest(cropHeight * aspect.ratio));
  } else {
    cropWidth = evenFloor(frame.width);
    cropHeight = Math.min(evenFloor(frame.height), evenNearest(cropWidth / aspect.ratio));
  }
  if (cropWidth < 2 || cropHeight < 2) return null;

  const anchor = current && hasCropGeometry(current)
    ? safeCropRect(info, current)
    : safeCropRect(info, fullCropRect(info));
  const centerX = anchor ? anchor.cropX + anchor.cropWidth / 2 : frame.width / 2;
  const centerY = anchor ? anchor.cropY + anchor.cropHeight / 2 : frame.height / 2;
  const maxX = evenFloor(frame.width - cropWidth);
  const maxY = evenFloor(frame.height - cropHeight);
  const cropX = Math.max(0, Math.min(maxX, Math.round((centerX - cropWidth / 2) / 2) * 2));
  const cropY = Math.max(0, Math.min(maxY, Math.round((centerY - cropHeight / 2) / 2) * 2));
  return { cropX, cropY, cropWidth, cropHeight };
}

/**
 * Turn cropper state into command options, or null for invalid/full-frame
 * selections. The public contract is visible-frame pixels:
 * `{ cropX, cropY, cropWidth, cropHeight }` (aliases x/y/width/height work too).
 */
export function normalizeCropRect(info, options = {}) {
  const aspectId = normalizeCropAspect(options.cropAspect);
  if (aspectId === null) return null;

  const requested = !hasCropGeometry(options) && aspectId !== 'free'
    ? cropRectForAspect(info, aspectId)
    : options;
  const rect = safeCropRect(info, requested);
  const frame = visibleVideoDimensions(info);
  if (!rect || !frame) return null;

  // Treat the largest encodable rectangle as the full frame too. For an odd
  // source, omitting crop and letting the final pad add one pixel preserves
  // more picture than silently shaving a row and column off.
  if (
    rect.cropX === 0
    && rect.cropY === 0
    && rect.cropWidth === evenFloor(frame.width)
    && rect.cropHeight === evenFloor(frame.height)
  ) return null;

  return rect;
}

/** Pick the largest preset that is strictly smaller than the visible picture. */
export function defaultResizeResolution(info) {
  const sourceHeight = visibleVideoHeight(info);
  if (sourceHeight === null) return null;
  return RESOLUTIONS.find((resolution) => (
    resolution.height !== null && resolution.height < sourceHeight
  ))?.id || null;
}

/** Resolve a height to a real preset that will reduce this source. */
export function normalizeResolution(value, info = null) {
  const missing = value === undefined || value === null || value === '';
  const fallback = info === null
    ? VIDEO_RESIZE.defaultOptions.resolution
    : defaultResizeResolution(info);
  if (missing) return fallback;

  const id = typeof value === 'number' ? String(value) : value;
  if (!RESOLUTION_IDS.has(id)) return null;

  const sourceHeight = visibleVideoHeight(info);
  if (info !== null && (sourceHeight === null || Number(id) >= sourceHeight)) return null;
  return id;
}

const stableDecimal = (value) => Number(Number(value).toFixed(6));

function numericChoice(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A linear gain from silence (0%) to the deliberately conservative 200%. */
export function normalizeVolumeGain(value) {
  const gain = numericChoice(value, VOLUME_GAIN_LIMITS.default);
  if (gain === null || gain < VOLUME_GAIN_LIMITS.min || gain > VOLUME_GAIN_LIMITS.max) return null;
  return stableDecimal(gain);
}

/** Playback rate accepted by both setpts and FFmpeg's chained atempo filters. */
export function normalizePlaybackRate(value) {
  const rate = numericChoice(value, PLAYBACK_RATE_LIMITS.default);
  if (rate === null || rate < PLAYBACK_RATE_LIMITS.min || rate > PLAYBACK_RATE_LIMITS.max) return null;
  return stableDecimal(rate);
}

/**
 * Playable seconds on the shared A/V timeline, preferring stream metadata over
 * a container end clock.
 *
 * Some muxers report a +5s stream that plays for 3s as an 8s container. The
 * stream duration remains 3s. When one selected stream deliberately starts
 * later than the other, that relative delay is part of what plays and must be
 * included in effect estimates, progress and safety limits.
 */
export function playableMediaDuration(info) {
  const containerStart = Number.isFinite(info?.startTime) ? info.startTime : null;
  const selectedStreams = [info?.video, info?.audio].filter(Boolean);
  const containerDuration = Number.isFinite(info?.duration) && info.duration > 0
    ? info.duration
    : null;

  // One known track cannot bound another selected track whose duration is
  // missing. Fall back to the container conservatively; if that is missing as
  // well, callers must treat the result as unknown instead of underestimating
  // a slow-motion or repeat job.
  if (selectedStreams.some((stream) => !Number.isFinite(stream.duration) || stream.duration <= 0)) {
    return containerDuration;
  }

  const streams = selectedStreams
    .map((stream) => ({
      duration: stream.duration,
      start: Number.isFinite(stream.startTime) ? stream.startTime : containerStart,
    }));
  if (streams.length) {
    const starts = streams.map(({ start }) => start).filter((start) => start !== null);
    const origin = starts.length ? Math.min(...starts) : null;
    return Math.max(...streams.map(({ duration, start }) => (
      duration + (origin !== null && start !== null ? Math.max(0, start - origin) : 0)
    )));
  }
  return containerDuration;
}

function knownPositiveDuration(info) {
  return playableMediaDuration(info);
}

/** Largest total play count that can still stay inside the 30-minute guard. */
export function maxLoopCountFor(info) {
  const duration = knownPositiveDuration(info);
  if (duration === null) return null;
  return Math.min(
    VIDEO_LOOP_LIMITS.maxCount,
    Math.floor((VIDEO_LOOP_LIMITS.maxDuration + 1e-9) / duration),
  );
}

/**
 * Pick a useful loop that is valid for this source.
 *
 * Two full plays are clearest when they fit. For a source between 15 and 30
 * minutes, a duration target repeats only enough of the beginning to add 50%
 * (or reach the guard), so the initial state remains runnable. At 30 minutes
 * there is no honest repeat that can stay under the limit.
 */
export function defaultVideoLoopOptions(info) {
  const duration = knownPositiveDuration(info);
  if (duration === null || duration >= VIDEO_LOOP_LIMITS.maxDuration) return null;
  if (maxLoopCountFor(info) >= VIDEO_LOOP_LIMITS.minCount) {
    return { loopMode: 'count', loopCount: 2, loopDuration: null };
  }

  const target = stableDecimal(Math.min(VIDEO_LOOP_LIMITS.maxDuration, duration * 1.5));
  return target > duration
    ? { loopMode: 'duration', loopCount: null, loopDuration: target }
    : null;
}

/**
 * Validate total plays or a target output duration against the source.
 * Values are rejected rather than silently clamped: the summary and the
 * generated command must never claim a different repeat than the user chose.
 */
export function normalizeVideoLoopOptions(info, options = {}) {
  const duration = knownPositiveDuration(info);
  if (duration === null) return null;

  const hasChoice = options.loopMode !== undefined
    || options.loopCount !== undefined
    || options.loopDuration !== undefined;
  const fallback = defaultVideoLoopOptions(info);
  if (!hasChoice) return fallback;

  const mode = options.loopMode ?? 'count';
  if (mode === 'count') {
    const count = numericChoice(options.loopCount, VIDEO_LOOP.defaultOptions.loopCount);
    if (!Number.isInteger(count)) return null;
    if (count < VIDEO_LOOP_LIMITS.minCount || count > VIDEO_LOOP_LIMITS.maxCount) return null;
    if (count > maxLoopCountFor(info)) return null;
    return { loopMode: 'count', loopCount: count, loopDuration: null };
  }

  if (mode === 'duration') {
    const target = numericChoice(options.loopDuration, null);
    if (target === null || target <= duration || target > VIDEO_LOOP_LIMITS.maxDuration) return null;
    const stableTarget = stableDecimal(target);
    return stableTarget > duration
      ? { loopMode: 'duration', loopCount: null, loopDuration: stableTarget }
      : null;
  }

  return null;
}

/** Exact planned duration of a valid loop, or null when it cannot run. */
export function loopOutputDuration(info, options = {}) {
  const normalized = normalizeVideoLoopOptions(info, options);
  if (!normalized) return null;
  return normalized.loopMode === 'count'
    ? knownPositiveDuration(info) * normalized.loopCount
    : normalized.loopDuration;
}

/**
 * Return only the command options owned by one focused tool.
 *
 * This prevents stale settings from a previous generic conversion leaking
 * into a one-purpose action. Trim bounds are normalised against the source
 * when metadata is available; the other tools fall back to useful defaults.
 */
export function normalizeFocusedQuickOptions(toolId, options = {}, info = null) {
  const tool = focusedQuickTool(toolId);
  if (!tool) return null;

  switch (tool.focus) {
    case 'trim': {
      const range = trimRange(info, options);
      const sourceDuration = Number.isFinite(info?.duration) && info.duration >= 0
        ? info.duration
        : null;
      return {
        trimStart: range.from > 0 ? range.from : null,
        trimEnd: range.to !== null && (sourceDuration === null || range.to < sourceDuration)
          ? range.to
          : null,
        evenDimensions: true,
      };
    }
    case 'rotate': {
      const rotate = normalizeRotation(options.rotate);
      return rotate === null ? null : { rotate, evenDimensions: true };
    }
    case 'flip': {
      const flip = normalizeFlip(options.flip);
      return flip === null ? null : { flip, evenDimensions: true };
    }
    case 'resize': {
      const resolution = normalizeResolution(options.resolution, info);
      return resolution === null ? null : { resolution, evenDimensions: true };
    }
    case 'crop': {
      const crop = normalizeCropRect(info, options);
      return crop === null ? null : { ...crop, evenDimensions: true };
    }
    case 'volume': {
      if (info !== null && info?.hasAudio !== true) return null;
      // Removing the track is different from encoding a silent track, and an
      // explicit mute always wins even if a stale gain value is malformed.
      if (options.mute === true) {
        return {
          volumeGain: normalizeVolumeGain(options.volumeGain) ?? VOLUME_GAIN_LIMITS.default,
          mute: true,
          evenDimensions: true,
        };
      }
      const volumeGain = normalizeVolumeGain(options.volumeGain);
      if (volumeGain === null || volumeGain === 1) return null;
      return { volumeGain, mute: false, evenDimensions: true };
    }
    case 'speed': {
      const playbackRate = normalizePlaybackRate(options.playbackRate);
      return playbackRate === null || playbackRate === 1
        ? null
        : { playbackRate, evenDimensions: true };
    }
    case 'loop': {
      const loop = normalizeVideoLoopOptions(info, options);
      return loop ? { ...loop, evenDimensions: true } : null;
    }
    default:
      return null;
  }
}

/**
 * Estimate a focused result without duplicating transformation math in UI.
 * Geometry and volume preserve time; trim, speed and loop own it explicitly.
 */
export function focusedQuickOutputDuration(toolId, options = {}, info = null) {
  const tool = focusedQuickTool(toolId);
  const sourceDuration = knownPositiveDuration(info);
  if (!tool || sourceDuration === null) return null;

  if (tool.focus === 'trim') return trimRange(info, options).duration;
  if (tool.focus === 'speed') {
    const rate = normalizePlaybackRate(options.playbackRate);
    return rate === null || rate === 1 ? null : sourceDuration / rate;
  }
  if (tool.focus === 'loop') return loopOutputDuration(info, options);
  return normalizeFocusedQuickOptions(toolId, options, info) ? sourceDuration : null;
}

/**
 * Duration expansion preflight for queue warnings and memory policy.
 *
 * The helper deliberately reports facts rather than choosing a warning
 * threshold: a 4x duration increase can be harmless for a two-second clip and
 * expensive for a long one. Callers get both absolute seconds and the ratio.
 */
export function focusedQuickExpansion(toolId, options = {}, info = null) {
  const sourceDuration = knownPositiveDuration(info);
  const outputDuration = focusedQuickOutputDuration(toolId, options, info);
  if (sourceDuration === null || outputDuration === null) return null;

  return {
    sourceDuration,
    outputDuration,
    durationDelta: stableDecimal(outputDuration - sourceDuration),
    factor: stableDecimal(outputDuration / sourceDuration),
    expands: outputDuration > sourceDuration,
  };
}

/**
 * Refuse focused effects that cannot fit their projected source + result in
 * FFmpeg's in-memory filesystem.
 *
 * This is intentionally conservative: re-encoding can make a short result
 * larger than the source, so the output estimate never drops below 1x the
 * input size even for faster playback. The estimate is not a promised output
 * size; it is a preflight budget used to avoid a dead worker or tab.
 */
export function focusedQuickPreflight(toolId, options = {}, info = null, inputBytes = null) {
  const tool = focusedQuickTool(toolId);
  const normalized = normalizeFocusedQuickOptions(toolId, options, info);
  const supportedFocus = tool && ['volume', 'speed', 'loop'].includes(tool.focus);
  const sourceDuration = knownPositiveDuration(info);
  const base = {
    sourceDuration,
    outputDuration: null,
    factor: null,
    inputBytes: Number.isFinite(inputBytes) && inputBytes >= 0 ? inputBytes : null,
    estimatedOutputBytes: null,
    estimatedMemfsBytes: null,
    limits: QUICK_EFFECT_PREFLIGHT_LIMITS,
  };

  if (!supportedFocus || !normalized) {
    return {
      ok: false,
      code: 'invalid-effect',
      message: 'Elegí un efecto válido antes de crear el resultado.',
      ...base,
    };
  }

  let factor = 1;
  if (tool.focus === 'speed') factor = stableDecimal(1 / normalized.playbackRate);
  if (tool.focus === 'loop') {
    const loopDuration = loopOutputDuration(info, normalized);
    factor = sourceDuration === null || loopDuration === null
      ? null
      : stableDecimal(loopDuration / sourceDuration);
  }
  const outputDuration = focusedQuickOutputDuration(toolId, normalized, info);
  const facts = { ...base, outputDuration, factor };

  if (tool.focus === 'speed' && factor > 1 && sourceDuration === null) {
    return {
      ok: false,
      code: 'unknown-duration',
      message: 'No pudimos calcular la duración final. Probá con un video cuya duración pueda leerse.',
      ...facts,
    };
  }

  if (
    (tool.focus === 'speed' || tool.focus === 'loop')
    && outputDuration !== null
    && outputDuration > QUICK_EFFECT_PREFLIGHT_LIMITS.maxOutputDuration
  ) {
    return {
      ok: false,
      code: 'duration-limit',
      message: `La salida duraría ${formatDuration(outputDuration)}. El máximo seguro es ${formatDuration(QUICK_EFFECT_PREFLIGHT_LIMITS.maxOutputDuration)}.`,
      ...facts,
    };
  }

  if (!Number.isFinite(inputBytes) || inputBytes < 0) {
    return {
      ok: false,
      code: 'invalid-input-size',
      message: 'No pudimos calcular el espacio necesario para procesar este video.',
      ...facts,
    };
  }

  const estimatedOutputBytes = Math.ceil(inputBytes * Math.max(1, factor));
  const estimatedMemfsBytes = inputBytes + estimatedOutputBytes;
  const estimates = { ...facts, estimatedOutputBytes, estimatedMemfsBytes };
  if (estimatedMemfsBytes > QUICK_EFFECT_PREFLIGHT_LIMITS.maxMemfsBytes) {
    return {
      ok: false,
      code: 'memory-limit',
      message: `La conversión necesitaría cerca de ${formatBytes(estimatedMemfsBytes)} entre el original y la salida. El límite seguro es ${formatBytes(QUICK_EFFECT_PREFLIGHT_LIMITS.maxMemfsBytes)}.`,
      ...estimates,
    };
  }

  return {
    ok: true,
    code: 'ok',
    message: null,
    ...estimates,
  };
}

/** Concise Spanish copy for the transformation summary beside the action. */
export function describeFocusedQuickTransformation(toolId, options = {}, info = null) {
  const normalized = normalizeFocusedQuickOptions(toolId, options, info);
  if (!normalized) return null;

  switch (focusedQuickTool(toolId).focus) {
    case 'trim': {
      const range = describeTrimRange(info, normalized);
      const end = range.to || 'el final';
      const length = range.duration ? ` · ${range.duration}` : '';
      return `Recorte: ${range.from} → ${end}${length}`;
    }
    case 'rotate':
      if (normalized.rotate === 90) return 'Giro de 90° a la derecha';
      if (normalized.rotate === 270) return 'Giro de 90° a la izquierda';
      return 'Giro de 180°';
    case 'flip':
      return normalized.flip === 'vertical' ? 'Espejo vertical' : 'Espejo horizontal';
    case 'resize':
      return `Salida de hasta ${normalized.resolution}p`;
    case 'crop':
      return `Encuadre: ${normalized.cropWidth} × ${normalized.cropHeight} px · x ${normalized.cropX}, y ${normalized.cropY}`;
    case 'volume':
      return normalized.mute ? 'Audio eliminado' : `Volumen: ${Math.round(normalized.volumeGain * 100)}%`;
    case 'speed': {
      const rate = String(normalized.playbackRate).replace('.', ',');
      const duration = focusedQuickOutputDuration(toolId, normalized, info);
      return `Velocidad: ${rate}×${duration === null ? '' : ` · salida ${formatDuration(duration)}`}`;
    }
    case 'loop': {
      const duration = loopOutputDuration(info, normalized);
      const choice = normalized.loopMode === 'count'
        ? `${normalized.loopCount} reproducciones`
        : `hasta ${formatDuration(normalized.loopDuration)}`;
      return `Repetición: ${choice}${duration === null ? '' : ` · salida ${formatDuration(duration)}`}`;
    }
    default:
      return null;
  }
}

/**
 * Normalise the current trim to seconds.
 *
 * `trimStart` and `trimEnd` are the names used by the conversion engine;
 * `from` and `to` are accepted as aliases so a timeline can feed this helper
 * directly. An unknown source duration leaves an unspecified end open rather
 * than inventing one.
 */
export function trimRange(info, options = {}) {
  const sourceDuration = Number.isFinite(info?.duration) && info.duration >= 0
    ? info.duration
    : null;
  const requestedFrom = finiteOption(options, 'trimStart', 'from');
  const requestedTo = finiteOption(options, 'trimEnd', 'to');

  let from = Math.max(0, requestedFrom ?? 0);
  if (sourceDuration !== null) from = Math.min(from, sourceDuration);

  let to;
  if (requestedTo !== null) {
    to = Math.max(0, requestedTo);
    if (sourceDuration !== null) to = Math.min(to, sourceDuration);
  } else {
    to = sourceDuration;
  }

  // A range may collapse to one instant, but it must never become inverted.
  if (to !== null && to < from) to = from;

  return {
    from,
    to,
    duration: to === null ? null : to - from,
  };
}

/** Format the normalised range for compact UI summaries. */
export function describeTrimRange(info, options = {}) {
  const range = trimRange(info, options);
  return {
    from: formatTimestamp(range.from),
    to: range.to === null ? null : formatTimestamp(range.to),
    duration: range.duration === null ? null : formatDuration(range.duration),
  };
}

/**
 * Return the exact command options for a valid trim, or null when there is no
 * playable range. This keeps the UI summary and the FFmpeg invocation from
 * disagreeing about inverted or out-of-bounds values.
 */
export function trimOptionsForRun(info, options = {}) {
  const range = trimRange(info, options);
  if (!(range.duration > 0) || range.to === null) return null;
  const sourceDuration = Number.isFinite(info?.duration) && info.duration >= 0 ? info.duration : null;
  return {
    trimStart: range.from > 0 ? range.from : null,
    trimEnd: sourceDuration !== null && range.to >= sourceDuration ? null : range.to,
    evenDimensions: true,
  };
}

/** Keep a video Quick Tool from inheriting an audio or GIF output preset. */
export function quickVideoFormat(formatId) {
  return VIDEO_FORMATS.some((format) => format.id === formatId && format.kind === 'video')
    ? formatId
    : 'mp4-h264';
}
