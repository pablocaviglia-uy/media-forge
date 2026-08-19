/**
 * Pure state for the focused "Agregar audio a video" workspace.
 *
 * A project has two named roles rather than an anonymous list: one file owns
 * the output picture and duration, and the other contributes the new sound.
 * Keeping those roles in every asset, source and snapshot makes the positional
 * worker protocol explicit and prevents a late probe from swapping inputs.
 */

import { audioTrackDuration, videoTrackDuration } from './probe.js';
import { createPersistentId } from '../storage/ids.js';

export const ADD_AUDIO_TOOL_ID = 'video-add-audio';
export const ADD_AUDIO_OPERATION = 'add-audio-to-video';

const MiB = 1024 * 1024;

export const ADD_AUDIO_LIMITS = Object.freeze({
  minGain: 0,
  maxGain: 2,
  minAudioBitrate: 64,
  maxAudioBitrate: 320,
  maxInputBytes: 350 * MiB,
  maxWorkingBytes: 500 * MiB,
});

/** Defaults for a video that already has sound. Silent videos switch below. */
export const ADD_AUDIO_DEFAULTS = Object.freeze({
  mixMode: 'mix',
  originalGain: 1,
  addedGain: 0.35,
  audioOffset: 0,
  audioFit: 'once',
  limiter: true,
  quality: 'balanced',
  speed: 'veryfast',
  audioBitrate: 192,
});

const ROLES = new Set(['video', 'audio']);
const MIX_MODES = new Set(['mix', 'replace']);
const AUDIO_FITS = new Set(['once', 'loop']);
const QUALITIES = new Set(['high', 'balanced', 'small']);
const SPEEDS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower']);

const stableNumber = (value) => Number(Number(value).toFixed(6));

const finiteTime = (value) => {
  if (value === null || value === undefined || value === '' || value === 'N/A') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const numericOption = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? stableNumber(number) : null;
};

const finiteBytes = (asset) => {
  const value = Number(asset?.size ?? asset?.file?.size);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= MiB) return `${Math.round((bytes / MiB) * 10) / 10} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
};

const cloneInfo = (info) => {
  if (!info || typeof info !== 'object') return null;
  return {
    ...info,
    formats: Array.isArray(info.formats) ? [...info.formats] : info.formats,
    streams: Array.isArray(info.streams)
      ? info.streams.map((stream) => ({ ...stream }))
      : info.streams,
    video: info.video ? { ...info.video } : null,
    audio: info.audio ? { ...info.audio } : null,
  };
};

const freezeInfo = (info) => {
  const copy = cloneInfo(info);
  if (!copy) return null;
  if (Array.isArray(copy.formats)) Object.freeze(copy.formats);
  if (Array.isArray(copy.streams)) {
    for (const stream of copy.streams) Object.freeze(stream);
    Object.freeze(copy.streams);
  }
  if (copy.video) Object.freeze(copy.video);
  if (copy.audio) Object.freeze(copy.audio);
  return Object.freeze(copy);
};

const normalizeEditState = (state = {}) => {
  const revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  const exportedRevision = Number.isInteger(state.exportedRevision) && state.exportedRevision >= 0
    ? state.exportedRevision
    : null;
  return { revision, exportedRevision };
};

const editState = (revision, exportedRevision) => Object.freeze({
  revision,
  exportedRevision,
  dirtySinceOutput: exportedRevision !== null && exportedRevision !== revision,
});

/** Make one role-bearing asset ready for the app's asynchronous probe. */
export function createAddAudioAsset(file, role, id = null) {
  if (!ROLES.has(role)) throw new TypeError('An add-audio asset needs the video or audio role.');
  if (!file || typeof file !== 'object') throw new TypeError(`The ${role} asset needs a File.`);

  const name = String(file.name || '').trim();
  const size = Number(file.size);
  if (!name) throw new TypeError(`The ${role} asset needs a file name.`);
  if (!Number.isFinite(size) || size < 0) throw new TypeError(`The ${role} asset needs a valid file size.`);

  const stableId = id === null || id === undefined || String(id).trim() === ''
    ? createPersistentId(`add-audio-${role}`)
    : String(id);

  return {
    id: stableId,
    role,
    file,
    name,
    size,
    info: null,
    status: 'pending',
    error: null,
  };
}

/** Start a project before its primary video has necessarily been probed. */
export function createAddAudioProject(videoFile, options = {}) {
  return {
    video: createAddAudioAsset(videoFile, 'video'),
    audio: null,
    // Raw choices stay raw until metadata is available: a silent primary has
    // a different mode and added-gain default from one with original audio.
    options: { ...options },
    ...createAddAudioEditState(),
  };
}

const asAsset = (value, role) => {
  if (value?.file) {
    if (value.role && value.role !== role) throw new TypeError(`Cannot use a ${value.role} asset as ${role}.`);
    const asset = createAddAudioAsset(value.file, role, value.id);
    return {
      ...asset,
      info: cloneInfo(value.info),
      status: value.status || (value.info ? 'ready' : 'pending'),
      error: value.error || null,
    };
  }
  return createAddAudioAsset(value, role);
};

/** Purely replace one role and advance the project's edit revision. */
export function setAddAudioAsset(project, role, fileOrAsset) {
  if (!ROLES.has(role)) throw new TypeError('An add-audio asset needs the video or audio role.');
  if (!project || typeof project !== 'object') throw new TypeError('An add-audio project is required.');
  if (fileOrAsset === null && role === 'video') throw new TypeError('The primary video cannot be removed.');

  const replacement = fileOrAsset === null ? null : asAsset(fileOrAsset, role);
  return {
    ...project,
    [role]: replacement,
    ...markAddAudioEdited(project),
  };
}

/**
 * Strictly normalise the options owned by this tool.
 *
 * A missing choice gets a useful default. A malformed or out-of-range choice
 * returns null instead of being silently clamped into a different edit.
 */
export function normalizeAddAudioOptions(videoInfo, options = {}) {
  const hasOriginalAudio = videoInfo?.hasAudio === true;
  const dynamicDefaults = hasOriginalAudio
    ? ADD_AUDIO_DEFAULTS
    : { ...ADD_AUDIO_DEFAULTS, mixMode: 'replace', addedGain: 1 };

  let mixMode = options.mixMode ?? dynamicDefaults.mixMode;
  if (!MIX_MODES.has(mixMode)) return null;
  if (!hasOriginalAudio) mixMode = 'replace';

  const originalGain = numericOption(options.originalGain, dynamicDefaults.originalGain);
  const addedGain = numericOption(options.addedGain, dynamicDefaults.addedGain);
  const audioOffset = numericOption(options.audioOffset, dynamicDefaults.audioOffset);
  const audioBitrate = numericOption(options.audioBitrate, dynamicDefaults.audioBitrate);
  if (originalGain === null || originalGain < ADD_AUDIO_LIMITS.minGain || originalGain > ADD_AUDIO_LIMITS.maxGain) return null;
  if (addedGain === null || addedGain < ADD_AUDIO_LIMITS.minGain || addedGain > ADD_AUDIO_LIMITS.maxGain) return null;
  if (audioOffset === null) return null;
  if (audioBitrate === null || audioBitrate < ADD_AUDIO_LIMITS.minAudioBitrate || audioBitrate > ADD_AUDIO_LIMITS.maxAudioBitrate) return null;

  const audioFit = options.audioFit ?? dynamicDefaults.audioFit;
  const quality = options.quality ?? dynamicDefaults.quality;
  const speed = options.speed ?? dynamicDefaults.speed;
  const limiter = options.limiter ?? dynamicDefaults.limiter;
  if (!AUDIO_FITS.has(audioFit) || !QUALITIES.has(quality) || !SPEEDS.has(speed)) return null;
  if (typeof limiter !== 'boolean') return null;

  return Object.freeze({
    mixMode,
    originalGain,
    addedGain,
    audioOffset,
    audioFit,
    limiter,
    quality,
    speed,
    audioBitrate: Math.round(audioBitrate),
  });
}

/**
 * Place the added track on the video-owned output timeline.
 *
 * Positive offsets delay it. Negative offsets skip its beginning. Looping
 * reduces a negative skip to the equivalent phase inside one repetition so a
 * huge signed offset never asks FFmpeg to decode thousands of throwaway loops.
 */
export function addAudioPlacement(videoInfo, audioInfo, options = {}) {
  const normalized = normalizeAddAudioOptions(videoInfo, options);
  const videoDuration = videoTrackDuration(videoInfo);
  const audioDuration = audioTrackDuration(audioInfo);
  if (!normalized || videoDuration === null || audioDuration === null) return null;

  const offset = normalized.audioOffset;
  const delay = Math.max(0, offset);
  if (delay >= videoDuration) return null;

  let trimStart = Math.max(0, -offset);
  if (normalized.audioFit === 'once') {
    if (trimStart >= audioDuration) return null;
  } else if (trimStart > 0) {
    trimStart = stableNumber(trimStart % audioDuration);
  }

  const available = normalized.audioFit === 'loop'
    ? videoDuration - delay
    : Math.min(audioDuration - trimStart, videoDuration - delay);
  if (!Number.isFinite(available) || available <= 0) return null;

  return Object.freeze({
    videoDuration: stableNumber(videoDuration),
    audioDuration: stableNumber(audioDuration),
    outputDuration: stableNumber(videoDuration),
    offset,
    delay: stableNumber(delay),
    trimStart,
    audibleDuration: stableNumber(available),
    loops: normalized.audioFit === 'loop',
  });
}

/** Position the primary video's own audio on its video-owned timeline. */
export function addAudioOriginalPlacement(videoInfo) {
  const outputDuration = videoTrackDuration(videoInfo);
  if (outputDuration === null || videoInfo?.hasAudio !== true) return null;

  const containerStart = finiteTime(videoInfo.startTime);
  const videoStart = finiteTime(videoInfo.video?.startTime) ?? containerStart;
  const audioStart = finiteTime(videoInfo.audio?.startTime) ?? containerStart;
  const offset = videoStart !== null && audioStart !== null ? audioStart - videoStart : 0;
  const duration = audioTrackDuration(videoInfo);
  const overlaps = duration === null
    || (offset < outputDuration && offset + duration > 0);

  return Object.freeze({
    outputDuration: stableNumber(outputDuration),
    offset: stableNumber(offset),
    delay: stableNumber(Math.max(0, offset)),
    trimStart: stableNumber(Math.max(0, -offset)),
    overlaps,
  });
}

/** Native-media position where the primary video track's project timeline begins. */
export function addAudioVideoTimelineStart(videoInfo) {
  const containerStart = finiteTime(videoInfo?.startTime) ?? 0;
  const videoStart = finiteTime(videoInfo?.video?.startTime) ?? containerStart;
  return stableNumber(Math.max(0, videoStart - containerStart));
}

/** Compressed bytes supplied to the worker in the two named roles. */
export function addAudioTotalBytes(projectOrSource) {
  return ['video', 'audio'].reduce((total, role) => {
    const bytes = finiteBytes(projectOrSource?.[role]);
    return total + (bytes ?? 0);
  }, 0);
}

const estimatedOutputBytes = (projectOrSource, options = {}) => {
  const video = projectOrSource?.video;
  const videoBytes = finiteBytes(video) ?? 0;
  const info = video?.info;
  const normalized = normalizeAddAudioOptions(info, options);
  const duration = videoTrackDuration(info);
  if (!normalized || duration === null) return videoBytes;

  // CRF output is not a fixed size. Use the known/derived source rate as a
  // floor, add the selected AAC rate, and never predict a result smaller than
  // the primary video file itself.
  const reportedVideoRate = Number(info?.video?.bitrate);
  const reportedContainerRate = Number(info?.bitrate);
  const derivedContainerRate = videoBytes > 0 ? (videoBytes * 8) / duration : 0;
  const pictureRate = Number.isFinite(reportedVideoRate) && reportedVideoRate > 0
    ? reportedVideoRate
    : (Number.isFinite(reportedContainerRate) && reportedContainerRate > 0
      ? reportedContainerRate
      : derivedContainerRate);
  const bitrateEstimate = Math.ceil(((Math.max(0, pictureRate) + (normalized.audioBitrate * 1000)) * duration) / 8);
  return Math.max(videoBytes, bitrateEstimate);
};

/** Estimated simultaneous MEMFS bytes: both inputs plus the encoded output. */
export function addAudioEstimatedWorkingBytes(projectOrSource, options = projectOrSource?.options || {}) {
  return addAudioTotalBytes(projectOrSource) + estimatedOutputBytes(projectOrSource, options);
}

/** Memory-only guard that is useful even before either asynchronous probe. */
export function addAudioPreflight(projectOrSource, options = projectOrSource?.options || {}) {
  const videoBytes = finiteBytes(projectOrSource?.video);
  const audioBytes = finiteBytes(projectOrSource?.audio);
  const inputBytes = addAudioTotalBytes(projectOrSource);
  const outputBytes = estimatedOutputBytes(projectOrSource, options);
  const workingBytes = inputBytes + outputBytes;
  const base = {
    inputBytes,
    estimatedOutputBytes: outputBytes,
    estimatedWorkingBytes: workingBytes,
    limits: ADD_AUDIO_LIMITS,
  };

  if (videoBytes === null || audioBytes === null) {
    return { ok: false, code: 'missing-files', message: 'Elegí un video y un audio para continuar.', ...base };
  }
  if (inputBytes > ADD_AUDIO_LIMITS.maxInputBytes) {
    return {
      ok: false,
      code: 'inputs-too-large',
      message: `Los archivos suman ${formatBytes(inputBytes)}. El máximo seguro es ${formatBytes(ADD_AUDIO_LIMITS.maxInputBytes)}.`,
      ...base,
    };
  }
  if (workingBytes > ADD_AUDIO_LIMITS.maxWorkingBytes) {
    return {
      ok: false,
      code: 'working-set-too-large',
      message: `La conversión necesitaría cerca de ${formatBytes(workingBytes)}. El límite seguro es ${formatBytes(ADD_AUDIO_LIMITS.maxWorkingBytes)}.`,
      ...base,
    };
  }

  return { ok: true, code: null, message: null, ...base };
}

/** Shared run guard with stable codes and Spanish copy for the editor. */
export function validateAddAudioProject(project, options = project?.options || {}) {
  const preflight = addAudioPreflight(project, options);
  const base = { ...preflight, options: null, placement: null };
  if (!project?.video) return { ...base, ok: false, code: 'missing-video', message: 'Elegí el video principal.' };
  if (!project?.audio) return { ...base, ok: false, code: 'missing-audio', message: 'Elegí el audio que querés agregar.' };
  if (!preflight.ok) return base;

  const failed = [project.video, project.audio].find((asset) => asset.status === 'failed' || asset.error);
  if (failed) {
    return { ...base, ok: false, code: 'probe-failed', message: `No pudimos analizar «${failed.name}». Reemplazalo para continuar.` };
  }
  const waiting = [project.video, project.audio].find((asset) => !asset.info || asset.status === 'pending' || asset.status === 'probing');
  if (waiting) {
    return { ...base, ok: false, code: 'waiting-for-probe', message: 'Esperá a que terminemos de analizar los dos archivos.' };
  }
  if (project.video.info.hasVideo !== true) {
    return { ...base, ok: false, code: 'video-track-missing', message: `«${project.video.name}» no contiene una pista de video.` };
  }
  if (project.audio.info.hasAudio !== true) {
    return { ...base, ok: false, code: 'audio-track-missing', message: `«${project.audio.name}» no contiene una pista de audio.` };
  }
  if (videoTrackDuration(project.video.info) === null) {
    return { ...base, ok: false, code: 'video-duration-missing', message: 'No pudimos determinar la duración de la pista de video.' };
  }
  if (audioTrackDuration(project.audio.info) === null) {
    return { ...base, ok: false, code: 'audio-duration-missing', message: 'No pudimos determinar la duración de la pista de audio.' };
  }

  const normalized = normalizeAddAudioOptions(project.video.info, options);
  if (!normalized) {
    return { ...base, ok: false, code: 'invalid-options', message: 'Revisá la mezcla, el volumen y el ajuste del audio.' };
  }
  const originalPlacement = addAudioOriginalPlacement(project.video.info);
  const audibleOriginal = normalized.mixMode === 'mix'
    && normalized.originalGain > 0
    && originalPlacement?.overlaps === true;
  if (normalized.addedGain === 0 && !audibleOriginal) {
    return { ...base, ok: false, code: 'inaudible-output', message: 'Subí el volumen de al menos una pista para crear un resultado audible.', options: normalized };
  }

  const placement = addAudioPlacement(project.video.info, project.audio.info, normalized);
  if (!placement) {
    return { ...base, ok: false, code: 'no-overlap', message: 'El audio queda completamente fuera de la duración del video.', options: normalized };
  }

  return { ...base, ok: true, code: null, message: null, options: normalized, placement };
}

const assetSource = (asset, role) => {
  if (!asset) return null;
  return {
    id: String(asset.id || ''),
    role,
    name: String(asset.name || asset.file?.name || ''),
    size: finiteBytes(asset) ?? 0,
    info: cloneInfo(asset.info),
  };
};

/** File-free, role-explicit description consumed by the command builder. */
export function addAudioProjectSource(project) {
  return {
    video: assetSource(project?.video, 'video'),
    audio: assetSource(project?.audio, 'audio'),
  };
}

const freezeAsset = (asset, role) => {
  if (!asset) return null;
  return Object.freeze({
    id: String(asset.id || ''),
    role,
    file: asset.file,
    name: String(asset.name || asset.file?.name || ''),
    size: finiteBytes(asset) ?? 0,
    info: freezeInfo(asset.info),
    status: asset.status || null,
    error: asset.error || null,
  });
};

/** Freeze the exact files, role order, options and revision an export starts. */
export function createAddAudioSnapshot(project) {
  const validation = validateAddAudioProject(project, project?.options || {});
  if (!validation.ok) throw new Error(validation.message || 'The add-audio project is not ready.');

  const video = freezeAsset(project.video, 'video');
  const audio = freezeAsset(project.audio, 'audio');
  const source = addAudioProjectSource({ video, audio });
  source.video.info = freezeInfo(source.video.info);
  source.audio.info = freezeInfo(source.audio.info);
  Object.freeze(source.video);
  Object.freeze(source.audio);
  Object.freeze(source);

  return Object.freeze({
    video,
    audio,
    files: Object.freeze([video.file, audio.file]),
    source,
    options: Object.freeze({ ...validation.options }),
    revision: normalizeEditState(project).revision,
  });
}

export function createAddAudioEditState() {
  return editState(0, null);
}

export function markAddAudioEdited(state) {
  const current = normalizeEditState(state);
  return editState(current.revision + 1, current.exportedRevision);
}

export function markAddAudioExported(state, exportedRevision = null) {
  const current = normalizeEditState(state);
  const revision = Number.isInteger(exportedRevision) && exportedRevision >= 0
    ? exportedRevision
    : current.revision;
  return editState(current.revision, revision);
}

export function addAudioHasUnexportedChanges(state) {
  const current = normalizeEditState(state);
  return current.exportedRevision !== null && current.exportedRevision !== current.revision;
}
