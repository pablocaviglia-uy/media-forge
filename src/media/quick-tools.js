/**
 * Focused quick-tool state.
 *
 * The catalogue says which tools exist; this module says which of those tools
 * already has a dedicated experience and translates the app's conversion
 * options into the small, predictable state that experience needs. Keeping it
 * pure lets the shell, inspector and tests agree without involving the DOM.
 */

import { formatDuration, formatTimestamp } from '../ui/dom.js';
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

const FOCUSED_TOOLS = new Map([
  [VIDEO_TRIM.id, VIDEO_TRIM],
  [VIDEO_ROTATE.id, VIDEO_ROTATE],
  [VIDEO_FLIP.id, VIDEO_FLIP],
  [VIDEO_RESIZE.id, VIDEO_RESIZE],
  [VIDEO_CROP.id, VIDEO_CROP],
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

/** Return a focused tool's execution contract, or null for the generic flow. */
export function focusedQuickTool(toolId) {
  return FOCUSED_TOOLS.get(toolId) || null;
}

/** A focused video tool only becomes useful after probing a real video track. */
export function supportsFocusedQuickTool(toolId, info) {
  return Boolean(focusedQuickTool(toolId) && info?.hasVideo);
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
    default:
      return null;
  }
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
