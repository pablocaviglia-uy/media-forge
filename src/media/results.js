/**
 * Pure model for completed media generations.
 *
 * A job's `outputs` array is one FFmpeg invocation, not an export history: a
 * frame extraction can produce many files in that single invocation.  This
 * module adds the missing level explicitly:
 *
 *   source project -> result generation -> one or more output files
 *
 * `resultHistory` is ordered oldest to newest. `selectedResultId` is a UI
 * choice and may point at an older generation. The compatibility projection
 * deliberately keeps `job.outputs`, `job.downloadName` and `job.outputSize`
 * attached to the newest generation so existing queue and download code does
 * not silently change meaning when a user browses the history.
 */

import { createPersistentId } from '../storage/ids.js';

export const RESULT_HISTORY_SCHEMA_VERSION = 1;

const MEDIA_KINDS = new Set(['audio', 'video', 'image', 'archive', 'mixed', 'unknown']);

const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm']);
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'tar', 'tgz', 'zip']);

const text = (value, fallback = '') => {
  const normalized = value === null || value === undefined ? '' : String(value).trim();
  return normalized || fallback;
};

const timestamp = (value, fallback) => {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : fallback;
};

const nonNegativeInteger = (value) => (
  Number.isInteger(value) && value >= 0 ? value : null
);

const blobLike = (value) => Boolean(
  value
  && typeof value === 'object'
  && Number.isFinite(Number(value.size))
  && typeof value.arrayBuffer === 'function'
);

function defaultMakeId(prefix) {
  return createPersistentId(prefix);
}

function metadataCopy(value, path = 'metadata', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || blobLike(value)) {
    throw new ResultModelError('invalid-metadata', `${path} is not serializable result metadata.`);
  }
  if (seen.has(value)) {
    throw new ResultModelError('invalid-metadata', `${path} contains a cycle.`);
  }

  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map((entry, index) => {
      const next = metadataCopy(entry, `${path}[${index}]`, seen);
      return next === undefined ? null : next;
    });
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(value);
      throw new ResultModelError('invalid-metadata', `${path} must be a plain object.`);
    }
    copy = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = metadataCopy(entry, `${path}.${key}`, seen);
      if (next !== undefined) copy[key] = next;
    }
  }
  seen.delete(value);
  return copy;
}

function extensionOf(name) {
  const match = text(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function generatedId(makeId, prefix) {
  const id = text(makeId(prefix));
  if (!id) throw new ResultModelError('invalid-id', `Could not create a persistent ${prefix} id.`);
  return id;
}

function requireProjectId(projectId) {
  const normalized = text(projectId);
  if (!normalized) throw new ResultModelError('missing-project-id', 'A result needs a source project id.');
  return normalized;
}

function freezeOutput(output) {
  return Object.freeze(output);
}

function freezeData(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) freezeData(entry);
  return Object.freeze(value);
}

function freezeResult(result) {
  return Object.freeze({
    ...result,
    options: freezeData(result.options),
    metadata: freezeData(result.metadata),
    outputs: Object.freeze(result.outputs),
    outputIds: Object.freeze(result.outputIds),
  });
}

function freezeHistory(history) {
  return Object.freeze({
    schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
    resultHistory: Object.freeze(history.resultHistory),
    selectedResultId: history.selectedResultId,
  });
}

function assertUniqueIds(results) {
  const resultIds = new Set();
  const outputIds = new Set();
  for (const result of results) {
    if (resultIds.has(result.id)) {
      throw new ResultModelError('duplicate-result-id', `Result id ${result.id} is repeated.`);
    }
    resultIds.add(result.id);
    for (const output of result.outputs) {
      if (outputIds.has(output.id)) {
        throw new ResultModelError('duplicate-output-id', `Output id ${output.id} is repeated.`);
      }
      outputIds.add(output.id);
    }
  }
}

function canonicalSelection(results, selectedResultId) {
  const requested = text(selectedResultId);
  if (requested && results.some((result) => result.id === requested)) return requested;
  return results.at(-1)?.id || null;
}

export class ResultModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResultModelError';
    this.code = code;
  }
}

/** A deterministic bridge for V1 projects that only persisted `outputIds`. */
export function legacyResultId(projectId) {
  return `result:${requireProjectId(projectId)}:legacy`;
}

/** Infer which local player/preview surface can consume an output. */
export function mediaKindOf(output) {
  const type = text(output?.type || output?.blob?.type).toLowerCase();
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (type.includes('zip') || type.includes('tar') || type.includes('compressed')) return 'archive';

  const extension = extensionOf(output?.name);
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'unknown';
}

/**
 * Produce the runtime descriptor shared by history, playback and persistence.
 * Existing ids are retained; genuinely new outputs receive durable ids.
 */
export function canonicalOutputDescriptor(
  output,
  {
    projectId,
    resultId,
    position = 0,
    makeId = defaultMakeId,
    fallbackId = null,
  } = {},
) {
  const ownerProjectId = requireProjectId(projectId || output?.projectId);
  const ownerResultId = text(resultId || output?.resultId);
  if (!ownerResultId) throw new ResultModelError('missing-result-id', 'An output needs a result id.');
  const blob = output?.blob || null;
  if (blob && !blobLike(blob)) {
    throw new ResultModelError('invalid-output-blob', 'An output blob must be a Blob or File.');
  }
  const id = text(output?.id || fallbackId) || generatedId(makeId, 'output');
  const sizeCandidate = Number(blob?.size ?? output?.size ?? 0);
  const size = Number.isFinite(sizeCandidate) && sizeCandidate >= 0 ? sizeCandidate : 0;
  const type = text(blob?.type || output?.type);
  const name = text(output?.name, `output-${Number(position) + 1}`);
  return freezeOutput({
    id,
    schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
    projectId: ownerProjectId,
    resultId: ownerResultId,
    position: nonNegativeInteger(position) ?? 0,
    name,
    size,
    type,
    mediaKind: mediaKindOf({ name, type, blob }),
    blob,
  });
}

/** Canonicalize one completed FFmpeg invocation and all files it produced. */
export function canonicalResultDescriptor(
  candidate,
  {
    projectId,
    now = Date.now(),
    makeId = defaultMakeId,
    id = null,
    legacyOutputIds = null,
  } = {},
) {
  const ownerProjectId = requireProjectId(projectId || candidate?.projectId);
  const resultId = text(id || candidate?.id) || generatedId(makeId, 'result');
  const rawOutputs = Array.isArray(candidate?.outputs) ? candidate.outputs : [];
  if (!rawOutputs.length) {
    throw new ResultModelError('empty-result', 'A completed result needs at least one output.');
  }
  const outputs = rawOutputs.map((output, position) => canonicalOutputDescriptor(output, {
    projectId: ownerProjectId,
    resultId,
    position,
    makeId,
    fallbackId: legacyOutputIds?.[position] || null,
  }));
  const kinds = new Set(outputs.map((output) => output.mediaKind));
  const inferredKind = kinds.size === 1 ? outputs[0].mediaKind : 'mixed';
  const requestedKind = text(candidate?.mediaKind);
  const mediaKind = MEDIA_KINDS.has(requestedKind) ? requestedKind : inferredKind;
  const totalSize = outputs.reduce((sum, output) => sum + output.size, 0);
  const options = metadataCopy(candidate?.options || {}, `result(${resultId}).options`) || {};
  const metadata = metadataCopy(candidate?.metadata || {}, `result(${resultId}).metadata`) || {};
  return freezeResult({
    id: resultId,
    schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
    projectId: ownerProjectId,
    createdAt: timestamp(candidate?.createdAt, timestamp(now, Date.now())),
    operation: text(candidate?.operation, 'convert'),
    forgeToolId: text(candidate?.forgeToolId) || null,
    revision: nonNegativeInteger(candidate?.revision),
    options,
    metadata,
    downloadName: text(candidate?.downloadName, outputs.length === 1 ? outputs[0].name : 'media-forge.zip'),
    mediaKind,
    totalSize,
    outputIds: outputs.map((output) => output.id),
    outputs,
  });
}

function legacyResultFromJob(job, options) {
  const projectId = requireProjectId(options.projectId || job?.id);
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  if (!outputs.length) return null;
  return canonicalResultDescriptor({
    id: legacyResultId(projectId),
    projectId,
    createdAt: job?.updatedAt ?? job?.createdAt,
    operation: job?.operation,
    forgeToolId: job?.forgeToolId,
    revision: job?.exportedRevision ?? job?.revision,
    options: job?.options,
    metadata: job?.resultMetadata,
    downloadName: job?.downloadName,
    outputs,
  }, {
    ...options,
    projectId,
    id: legacyResultId(projectId),
    // Old in-memory jobs have no output ids. Deterministic ids make repeated
    // autosave normalization stable until the canonical model is attached.
    legacyOutputIds: outputs.map((output, index) => (
      output?.id || `output:${projectId}:legacy:${index}`
    )),
  });
}

/**
 * Normalize either a job or a `{ resultHistory, selectedResultId }` state.
 * Jobs saved before result history existed are losslessly represented as one
 * legacy generation containing their whole `outputs` array.
 */
export function normalizeResultHistory(
  source,
  {
    projectId = source?.id || source?.projectId || source?.resultHistory?.[0]?.projectId || null,
    now = Date.now(),
    makeId = defaultMakeId,
  } = {},
) {
  const ownerProjectId = requireProjectId(projectId);
  const rawHistory = Array.isArray(source?.resultHistory) ? source.resultHistory : null;
  let resultHistory;
  // An integration may initialize the new field to `[]` before its processing
  // path is upgraded. Preserve a concurrently populated legacy `outputs`
  // alias instead of treating that empty initializer as authoritative.
  if (rawHistory?.length || (rawHistory && !source?.outputs?.length)) {
    resultHistory = rawHistory.map((result) => canonicalResultDescriptor(result, {
      projectId: ownerProjectId,
      now,
      makeId,
    }));
  } else {
    const legacy = legacyResultFromJob(source, { projectId: ownerProjectId, now, makeId });
    resultHistory = legacy ? [legacy] : [];
  }
  assertUniqueIds(resultHistory);
  return freezeHistory({
    resultHistory,
    selectedResultId: canonicalSelection(resultHistory, source?.selectedResultId),
  });
}

export function latestResult(history) {
  return history?.resultHistory?.at(-1) || null;
}

export function selectedResult(history) {
  const selectedId = text(history?.selectedResultId);
  return history?.resultHistory?.find((result) => result.id === selectedId)
    || latestResult(history);
}

/** Append a new generation and select it. Older generated bytes are retained. */
export function appendResult(
  history,
  candidate,
  {
    projectId = candidate?.projectId || history?.resultHistory?.[0]?.projectId || null,
    now = Date.now(),
    makeId = defaultMakeId,
  } = {},
) {
  const current = normalizeResultHistory(history || { resultHistory: [] }, { projectId, now, makeId });
  const next = canonicalResultDescriptor(candidate, { projectId, now, makeId });
  const resultHistory = [...current.resultHistory, next];
  assertUniqueIds(resultHistory);
  return freezeHistory({ resultHistory, selectedResultId: next.id });
}

/** Replace a generation in place while preserving its persistent identity. */
export function replaceResult(
  history,
  resultId,
  candidate,
  {
    projectId = candidate?.projectId || history?.resultHistory?.[0]?.projectId || null,
    now = Date.now(),
    makeId = defaultMakeId,
  } = {},
) {
  const current = normalizeResultHistory(history, { projectId, now, makeId });
  const id = text(resultId);
  const index = current.resultHistory.findIndex((result) => result.id === id);
  if (index < 0) throw new ResultModelError('result-not-found', `Result ${id || '(empty)'} does not exist.`);
  const replacement = canonicalResultDescriptor({ ...candidate, id }, { projectId, now, makeId, id });
  const resultHistory = current.resultHistory.map((result, position) => (
    position === index ? replacement : result
  ));
  assertUniqueIds(resultHistory);
  return freezeHistory({ resultHistory, selectedResultId: current.selectedResultId });
}

/** Delete exactly one generation. If selected, focus the newest one left. */
export function deleteResult(history, resultId, options = {}) {
  const projectId = options.projectId || history?.resultHistory?.[0]?.projectId || null;
  const current = normalizeResultHistory(history, { ...options, projectId });
  const id = text(resultId);
  if (!current.resultHistory.some((result) => result.id === id)) {
    throw new ResultModelError('result-not-found', `Result ${id || '(empty)'} does not exist.`);
  }
  const resultHistory = current.resultHistory.filter((result) => result.id !== id);
  const selectedResultId = current.selectedResultId === id
    ? resultHistory.at(-1)?.id || null
    : canonicalSelection(resultHistory, current.selectedResultId);
  return freezeHistory({ resultHistory, selectedResultId });
}

export function selectResult(history, resultId, options = {}) {
  const projectId = options.projectId || history?.resultHistory?.[0]?.projectId || null;
  const current = normalizeResultHistory(history, { ...options, projectId });
  const id = text(resultId);
  if (!current.resultHistory.some((result) => result.id === id)) {
    throw new ResultModelError('result-not-found', `Result ${id || '(empty)'} does not exist.`);
  }
  return freezeHistory({ resultHistory: current.resultHistory, selectedResultId: id });
}

/**
 * Fields to spread onto a mutable App job while its callers still consume the
 * original single-generation contract.
 */
export function resultCompatibilityPatch(history) {
  const newest = latestResult(history);
  return {
    resultHistory: history?.resultHistory || Object.freeze([]),
    selectedResultId: newest ? canonicalSelection(history.resultHistory, history.selectedResultId) : null,
    outputs: newest?.outputs || null,
    downloadName: newest?.downloadName || null,
    outputSize: newest?.totalSize || 0,
  };
}

/** JSON-shaped per-generation records suitable for a project metadata row. */
export function resultHistoryManifest(history) {
  const results = history?.resultHistory || [];
  return results.map((result, position) => ({
    id: result.id,
    schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
    projectId: result.projectId,
    position,
    createdAt: result.createdAt,
    operation: result.operation,
    forgeToolId: result.forgeToolId,
    revision: result.revision,
    options: metadataCopy(result.options, `result(${result.id}).options`) || {},
    metadata: metadataCopy(result.metadata, `result(${result.id}).metadata`) || {},
    downloadName: result.downloadName,
    mediaKind: result.mediaKind,
    totalSize: result.totalSize,
    outputIds: [...result.outputIds],
  }));
}

/**
 * Flatten generations for the repository output codec. The Blob deliberately
 * remains attached here; `projects.js` owns splitting it into output metadata
 * and the existing binary store. The lineage fields themselves are additive,
 * so the V1 object store and indexes remain valid.
 */
export function flattenResultOutputs(history) {
  return (history?.resultHistory || []).flatMap((result, resultPosition) => (
    result.outputs.map((output, position) => ({
      ...output,
      projectId: result.projectId,
      resultId: result.id,
      resultPosition,
      position,
    }))
  ));
}

/** Rejoin persisted manifests with already-hydrated output Blobs. */
export function hydrateResultHistory(
  {
    projectId,
    resultHistory: manifests,
    selectedResultId = null,
    outputs = [],
    legacy = null,
  },
  {
    now = Date.now(),
    makeId = defaultMakeId,
    onIssue = null,
  } = {},
) {
  const ownerProjectId = requireProjectId(projectId);
  if (!Array.isArray(manifests)) {
    return normalizeResultHistory({
      id: ownerProjectId,
      ...(legacy || {}),
      outputs,
      selectedResultId,
    }, { projectId: ownerProjectId, now, makeId });
  }

  const outputMap = new Map(outputs.map((output) => [text(output?.id), output]));
  const candidates = [];
  for (const manifest of [...manifests].sort((a, b) => (
    (nonNegativeInteger(a?.position) ?? Number.MAX_SAFE_INTEGER)
      - (nonNegativeInteger(b?.position) ?? Number.MAX_SAFE_INTEGER)
  ))) {
    if (!manifest) continue;
    if (manifest.schemaVersion !== RESULT_HISTORY_SCHEMA_VERSION) {
      if (typeof onIssue === 'function') {
        onIssue(Object.freeze({
          code: 'unsupported-result-schema',
          projectId: ownerProjectId,
          resultId: text(manifest.id) || null,
          schemaVersion: manifest.schemaVersion ?? null,
          supportedSchemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
        }));
      }
      continue;
    }
    const expectedOutputIds = Array.isArray(manifest.outputIds)
      ? manifest.outputIds.map((id) => text(id))
      : null;
    const joined = expectedOutputIds
      ? expectedOutputIds.map((id) => outputMap.get(id)).filter(Boolean)
      : outputs.filter((output) => text(output?.resultId) === text(manifest.id));
    if (expectedOutputIds && joined.length !== expectedOutputIds.length) {
      const available = new Set(joined.map((output) => text(output?.id)));
      if (typeof onIssue === 'function') {
        onIssue(Object.freeze({
          code: 'incomplete-result',
          projectId: ownerProjectId,
          resultId: text(manifest.id) || null,
          expectedOutputCount: expectedOutputIds.length,
          availableOutputCount: joined.length,
          missingOutputIds: Object.freeze(expectedOutputIds.filter((id) => !available.has(id))),
        }));
      }
      continue;
    }
    // A manifest without any durable output is not a playable/downloadable
    // result. Its missing records remain a storage issue for the repository.
    if (!joined.length) continue;
    candidates.push(canonicalResultDescriptor({ ...manifest, outputs: joined }, {
      projectId: ownerProjectId,
      now,
      makeId,
      id: manifest.id,
    }));
  }
  assertUniqueIds(candidates);
  return freezeHistory({
    resultHistory: candidates,
    selectedResultId: canonicalSelection(candidates, selectedResultId),
  });
}
