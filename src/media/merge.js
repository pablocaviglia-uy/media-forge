/**
 * Pure state for the focused "Unir videos" workspace.
 *
 * A merge project is one queue job containing several clips. Clip ids belong
 * to the clip, not its position, so reordering never changes identity and an
 * in-flight export can keep an immutable snapshot while the editor moves on.
 * No DOM, File reads or FFmpeg calls live here.
 */

import { createPersistentId } from '../storage/ids.js';

export const MERGE_TOOL_ID = 'video-merge';
export const MERGE_OPERATION = 'join-videos';

// Besides keeping the UI manageable, 24 probes leave useful headroom before
// the current long-lived WebAssembly core reaches its known invocation limit.
export const MERGE_MAX_CLIPS = 24;

// Every input and the complete output coexist in MEMFS. Reading the output
// also makes a transferable copy, so an aggregate guard must be stricter than
// the converter's per-file limit.
export const MERGE_SAFE_BYTES = 350 * 1024 * 1024;

const clipsOf = (projectOrClips) => {
  if (Array.isArray(projectOrClips)) return projectOrClips;
  if (Array.isArray(projectOrClips?.clips)) return projectOrClips.clips;
  if (Array.isArray(projectOrClips?.inputs)) return projectOrClips.inputs;
  return [];
};

const finiteBytes = (clip) => {
  const value = Number(clip?.size ?? clip?.file?.size);
  return Number.isFinite(value) && value > 0 ? value : 0;
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

/** Create a clip whose identity survives every later reorder. */
export function createMergeClip(file, id = null) {
  if (!file || typeof file !== 'object') throw new TypeError('A merge clip needs a File.');

  const name = String(file.name || '').trim();
  const size = Number(file.size);
  if (!name) throw new TypeError('A merge clip needs a file name.');
  if (!Number.isFinite(size) || size < 0) throw new TypeError('A merge clip needs a valid file size.');

  const stableId = id === null || id === undefined || String(id).trim() === ''
    ? createPersistentId('merge-clip')
    : String(id);

  return {
    id: stableId,
    file,
    name,
    size,
    info: null,
    status: 'pending',
    error: null,
  };
}

/** Total compressed input bytes held by a project. */
export function mergeTotalBytes(projectOrClips) {
  return clipsOf(projectOrClips).reduce((total, clip) => total + finiteBytes(clip), 0);
}

/**
 * Sum of clip durations, or null until every duration is known and positive.
 * The empty sum is zero; cardinality is reported separately by validation.
 */
export function mergeTotalDuration(projectOrClips) {
  const clips = clipsOf(projectOrClips);
  if (!clips.length) return 0;

  let total = 0;
  for (const clip of clips) {
    const duration = Number(clip?.info?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    total += duration;
  }
  return total;
}

/** Metadata the existing queue can use to describe one compound job. */
export function mergeProjectInfo(projectOrClips) {
  const clips = clipsOf(projectOrClips);
  const firstVideo = clips.find((clip) => clip?.info?.video)?.info?.video || null;
  const firstAudio = clips.find((clip) => clip?.info?.audio)?.info?.audio || null;

  return {
    format: 'sequence',
    formatLabel: 'Secuencia',
    clipCount: clips.length,
    size: mergeTotalBytes(clips),
    duration: mergeTotalDuration(clips),
    hasVideo: clips.length > 0 && clips.every((clip) => clip?.info?.hasVideo === true),
    hasAudio: clips.some((clip) => clip?.info?.hasAudio === true),
    video: firstVideo ? { ...firstVideo } : null,
    audio: firstAudio ? { ...firstAudio } : null,
  };
}

/**
 * Validate a project without throwing so the same Spanish copy can drive the
 * editor, the footer and the final run guard.
 */
export function validateMergeClips(projectOrClips) {
  const clips = clipsOf(projectOrClips);
  const totalBytes = mergeTotalBytes(clips);
  const totalDuration = mergeTotalDuration(clips);
  let error = null;

  if (clips.length < 2) {
    error = 'Agregá al menos dos videos para unirlos.';
  } else if (clips.length > MERGE_MAX_CLIPS) {
    error = `Podés unir hasta ${MERGE_MAX_CLIPS} videos por vez.`;
  } else if (totalBytes > MERGE_SAFE_BYTES) {
    error = `La selección supera el límite seguro de ${MERGE_SAFE_BYTES / 1024 / 1024} MB para unir videos en este dispositivo.`;
  } else {
    const failed = clips.find((clip) => clip?.status === 'failed' || clip?.error);
    const waiting = clips.find((clip) => !clip?.info || clip?.status === 'pending' || clip?.status === 'probing');
    const withoutVideo = clips.find((clip) => clip?.info && clip.info.hasVideo !== true);
    const withoutDuration = clips.find((clip) => {
      const duration = Number(clip?.info?.duration);
      return clip?.info && (!Number.isFinite(duration) || duration <= 0);
    });

    if (failed) {
      error = `No pudimos analizar «${failed.name || 'uno de los archivos'}». Quitalo o reemplazalo para continuar.`;
    } else if (waiting) {
      error = 'Esperá a que terminemos de analizar todos los videos.';
    } else if (withoutVideo) {
      error = `«${withoutVideo.name || 'Uno de los archivos'}» no contiene una pista de video.`;
    } else if (withoutDuration) {
      error = `No pudimos determinar la duración de «${withoutDuration.name || 'uno de los videos'}».`;
    }
  }

  return { ok: error === null, error, totalBytes, totalDuration };
}

/** Move one stable clip id to a (clamped) index without mutating the source. */
export function reorderMergeClips(projectOrClips, clipId, targetIndex) {
  const source = clipsOf(projectOrClips);
  const reordered = [...source];
  const fromIndex = reordered.findIndex((clip) => String(clip?.id) === String(clipId));
  const numericTarget = Number(targetIndex);
  if (fromIndex < 0 || !Number.isFinite(numericTarget) || !reordered.length) return reordered;

  const toIndex = Math.min(reordered.length - 1, Math.max(0, Math.trunc(numericTarget)));
  const [clip] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, clip);
  return reordered;
}

/** Ordered, file-free source description consumed by the pure command builder. */
export function mergeProjectSource(project) {
  const clips = clipsOf(project);
  return {
    name: String(project?.name || clips[0]?.name || 'videos-unidos.mp4'),
    info: mergeProjectInfo(clips),
    inputs: clips.map((clip) => ({
      id: String(clip.id),
      name: String(clip.name || clip.file?.name || ''),
      size: finiteBytes(clip),
      info: cloneInfo(clip.info),
    })),
  };
}

/**
 * Freeze the exact order, files, options and revision an export started with.
 * File objects are immutable blobs and intentionally remain shared references;
 * every mutable metadata wrapper is copied.
 */
export function createMergeSnapshot(project) {
  const clips = clipsOf(project).map((clip) => Object.freeze({
    id: String(clip.id),
    file: clip.file,
    name: String(clip.name || clip.file?.name || ''),
    size: finiteBytes(clip),
    info: freezeInfo(clip.info),
  }));
  const frozenClips = Object.freeze(clips);
  const source = mergeProjectSource({ name: project?.name, clips: frozenClips });

  for (const input of source.inputs) {
    if (input.info) input.info = freezeInfo(input.info);
    Object.freeze(input);
  }
  Object.freeze(source.inputs);
  source.info = freezeInfo(source.info);
  Object.freeze(source);

  return Object.freeze({
    clips: frozenClips,
    files: Object.freeze(clips.map((clip) => clip.file)),
    source,
    options: Object.freeze({ ...(project?.options || {}) }),
    revision: Number.isInteger(project?.revision) && project.revision >= 0 ? project.revision : 0,
  });
}

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

export function createMergeEditState() {
  return editState(0, null);
}

/** Record a real project mutation. Before the first export there is no stale output. */
export function markMergeEdited(state) {
  const current = normalizeEditState(state);
  return editState(current.revision + 1, current.exportedRevision);
}

/**
 * Record which revision an export represents. Passing the revision captured at
 * start keeps `dirtySinceOutput` true if editing continued during the encode.
 */
export function markMergeExported(state, exportedRevision = null) {
  const current = normalizeEditState(state);
  const revision = Number.isInteger(exportedRevision) && exportedRevision >= 0
    ? exportedRevision
    : current.revision;
  return editState(current.revision, revision);
}

export function mergeHasUnexportedChanges(state) {
  const current = normalizeEditState(state);
  return current.exportedRevision !== null && current.exportedRevision !== current.revision;
}
