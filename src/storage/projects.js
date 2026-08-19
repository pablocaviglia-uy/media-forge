/**
 * Durable, local-only project storage.
 *
 * Preferences deliberately remain in localStorage. Projects live in
 * IndexedDB because their source and result files are Blobs, and because a
 * project graph needs transactional updates. Binary records are kept in a
 * separate object store so changing an option never writes a large media file
 * again.
 */

import { mergeProjectInfo } from '../media/merge.js';
import { createPersistentId } from './ids.js';

export const PROJECT_DB_NAME = 'media-forge-projects';
export const PROJECT_DB_VERSION = 1;
export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_CHANNEL_NAME = 'media-forge-projects';

export const PROJECT_STORES = Object.freeze({
  projects: 'projects',
  assets: 'assets',
  outputs: 'outputs',
  blobs: 'blobs',
  meta: 'meta',
});

const WORKSPACE_META_KEY = 'workspace';
const PERSISTENCE_REF = Symbol('media-forge-persistence-ref');
const INTERRUPTED_STATUSES = new Set(['queued', 'running']);
const PROJECT_KINDS = new Set(['simple', 'merge', 'add-audio']);

const asString = (value, fallback = '') => {
  const text = value === null || value === undefined ? '' : String(value);
  return text || fallback;
};

const finiteInteger = (value, fallback = 0) => (
  Number.isInteger(value) && value >= 0 ? value : fallback
);

const finiteTimestamp = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const blobLike = (value) => Boolean(
  value
  && typeof value === 'object'
  && Number.isFinite(Number(value.size))
  && typeof value.arrayBuffer === 'function'
);

const persistenceRef = (value) => value?.[PERSISTENCE_REF] || null;

function rememberPersistenceRef(value, ref) {
  if (!value || typeof value !== 'object') return value;
  try {
    Object.defineProperty(value, PERSISTENCE_REF, {
      value: Object.freeze({ ...ref }),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Frozen domain snapshots can still be loaded. The repository's WeakMap
    // remembers their Blob identity even when the wrapper cannot carry a ref.
  }
  return value;
}

/** Copy JSON-shaped domain metadata while rejecting executable/cyclic state. */
function copyData(value, path = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || blobLike(value)) {
    throw new ProjectStoreError('validation-failed', `${path} is not serializable project metadata.`);
  }
  if (seen.has(value)) {
    throw new ProjectStoreError('validation-failed', `${path} contains a cycle.`);
  }
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map((entry, index) => {
      const next = copyData(entry, `${path}[${index}]`, seen);
      return next === undefined ? null : next;
    });
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(value);
      throw new ProjectStoreError('validation-failed', `${path} must be a plain object.`);
    }
    copy = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = copyData(entry, `${path}.${key}`, seen);
      if (next !== undefined) copy[key] = next;
    }
  }
  seen.delete(value);
  return copy;
}

function makeIssue(code, message, details = {}) {
  return Object.freeze({ code, message, recoverable: true, ...details });
}

function safeCopyData(value, path, issues, details, fallback) {
  try {
    const copy = copyData(value, path);
    return copy === undefined ? fallback : copy;
  } catch (error) {
    issues.push(makeIssue(
      'corrupt-data',
      `Se ignoraron datos dañados en ${path}.`,
      { ...details, causeCode: error.code || null },
    ));
    return fallback;
  }
}

export class ProjectStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ProjectStoreError';
    this.code = code;
    this.details = options.details || null;
  }
}

export function isQuotaExceededError(error) {
  if (!error) return false;
  if (error.code === 'quota-exceeded') return true;
  if (error.name === 'QuotaExceededError') return true;
  return error.cause && error.cause !== error ? isQuotaExceededError(error.cause) : false;
}

function storageError(error, operation) {
  if (error instanceof ProjectStoreError) return error;
  if (isQuotaExceededError(error)) {
    return new ProjectStoreError(
      'quota-exceeded',
      'No hay espacio local suficiente para guardar este proyecto.',
      { cause: error, details: { operation } },
    );
  }
  return new ProjectStoreError(
    'storage-unavailable',
    `No se pudo ${operation} el almacenamiento local de proyectos.`,
    { cause: error, details: { operation } },
  );
}

function defaultMakeId(prefix = 'record') {
  const readablePrefix = String(prefix || 'record')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'record';
  return createPersistentId(readablePrefix);
}

export function createBlobIdentityRegistry(makeId = defaultMakeId) {
  const ids = new WeakMap();
  return Object.freeze({
    idFor(blob, hint = 'blob', existingId = null) {
      if (!blobLike(blob)) return existingId ? String(existingId) : null;
      let remembered = ids.get(blob);
      if (!remembered) {
        remembered = new Map();
        ids.set(blob, remembered);
      }
      if (remembered.has(hint)) return remembered.get(hint);
      // `existingId` belongs to the Blob object hydrated from that record.
      // If a different File/Blob arrives with the same asset/output metadata
      // (replacement, relink or re-export), reusing the key would let the IDB
      // backend keep the old bytes while committing the new descriptor. The
      // exact hydrated object is registered through `remember()` and keeps
      // its key; every genuinely new binary identity gets a new key.
      const id = makeId(hint);
      remembered.set(hint, id);
      return id;
    },
    remember(blob, id, hint = 'blob') {
      if (blobLike(blob) && id) {
        let remembered = ids.get(blob);
        if (!remembered) {
          remembered = new Map();
          ids.set(blob, remembered);
        }
        remembered.set(hint, String(id));
      }
      return blob;
    },
  });
}

function projectKind(job) {
  if (job?.kind === 'video-add-audio' && job?.video?.role === 'video') return 'add-audio';
  if (Array.isArray(job?.clips) && job?.operation === 'join-videos') return 'merge';
  return 'simple';
}

function storedProjectStatus(status, hasOutputs) {
  if (INTERRUPTED_STATUSES.has(status)) return 'interrupted';
  if (status === 'done') return hasOutputs ? 'done' : 'ready';
  if (status === 'failed' || status === 'cancelled') return status;
  if (status === 'probing') return 'probing';
  return 'ready';
}

function storedAssetStatus(asset) {
  if (asset?.status === 'failed') return 'failed';
  return asset?.info ? 'ready' : 'pending';
}

function assetDescriptor({
  asset,
  id,
  projectId,
  role,
  position,
  registry,
  blobs,
  storedRef = null,
}) {
  const ref = storedRef || persistenceRef(asset);
  const file = asset?.file || null;
  const recordId = asString(ref?.recordId || id);
  if (!recordId) {
    throw new ProjectStoreError('validation-failed', `Project ${projectId} has an asset without an id.`);
  }
  const name = asString(asset?.name || file?.name, role === 'source' ? 'media' : role);
  const size = Number(asset?.size ?? file?.size ?? 0);
  const type = asString(asset?.type || file?.type);
  const lastModified = finiteTimestamp(asset?.lastModified ?? file?.lastModified, 0);
  const blobId = registry.idFor(file, `asset:${recordId}`, ref?.blobId);
  if (file && !blobLike(file)) {
    throw new ProjectStoreError('validation-failed', `Asset ${recordId} is not a File or Blob.`);
  }
  if (file && blobId) {
    blobs.push({
      id: blobId,
      projectId,
      ownerType: 'asset',
      ownerId: recordId,
      size: Number(file.size) || 0,
      type: asString(file.type),
      data: file,
    });
  }
  return {
    id: recordId,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    role,
    position,
    blobId,
    name,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    type,
    lastModified,
    info: copyData(asset?.info ?? null, `asset(${recordId}).info`),
    status: storedAssetStatus(asset),
  };
}

function outputDescriptor({ output, index, projectId, registry, blobs }) {
  const ref = persistenceRef(output);
  const blob = output?.blob || null;
  const id = asString(ref?.recordId || output?.id, `output:${projectId}:${index}`);
  const blobId = registry.idFor(blob, `output:${id}`, ref?.blobId);
  if (blob && !blobLike(blob)) {
    throw new ProjectStoreError('validation-failed', `Output ${id} is not a Blob.`);
  }
  if (blob && blobId) {
    blobs.push({
      id: blobId,
      projectId,
      ownerType: 'output',
      ownerId: id,
      size: Number(blob.size) || 0,
      type: asString(blob.type),
      data: blob,
    });
  }
  return {
    id,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    position: index,
    blobId,
    name: asString(output?.name, `output-${index + 1}`),
    size: Number(blob?.size ?? output?.size ?? 0) || 0,
    type: asString(blob?.type || output?.type),
  };
}

function duplicateIssues(records, kind) {
  const seen = new Set();
  const issues = [];
  for (const record of records) {
    if (!record.id || seen.has(record.id)) {
      issues.push(makeIssue(
        `duplicate-${kind}-id`,
        `El identificador ${record.id || '(vacío)'} está repetido.`,
        { projectId: record.projectId || record.id || null, recoverable: false },
      ));
    }
    seen.add(record.id);
  }
  return issues;
}

/**
 * Convert the mutable App jobs to the explicit, persistence-only record graph.
 * No progress, logs, object URLs, running handles, snapshots, focus hints or
 * preview state are copied.
 */
export function serializeWorkspace(
  jobs,
  {
    selectedId = null,
    now = Date.now(),
    registry = createBlobIdentityRegistry(),
    createdAtFor = null,
  } = {},
) {
  if (!Array.isArray(jobs)) {
    throw new ProjectStoreError('validation-failed', 'saveWorkspace expects an array of jobs.');
  }

  const projects = [];
  const assets = [];
  const outputs = [];
  const blobs = [];
  const issues = [];

  for (const [position, job] of jobs.entries()) {
    const id = asString(job?.id);
    if (!id) {
      issues.push(makeIssue('missing-project-id', 'Un proyecto no tiene identificador.', { recoverable: false }));
      continue;
    }
    const kind = projectKind(job);
    const projectAssets = [];
    try {
      if (kind === 'merge') {
        for (const [position, clip] of job.clips.entries()) {
          projectAssets.push(assetDescriptor({
            asset: clip,
            id: clip?.id || `clip:${id}:${position}`,
            projectId: id,
            role: 'clip',
            position,
            registry,
            blobs,
          }));
        }
      } else if (kind === 'add-audio') {
        if (job.video) {
          projectAssets.push(assetDescriptor({
            asset: job.video,
            id: job.video.id || `video:${id}`,
            projectId: id,
            role: 'video',
            position: 0,
            registry,
            blobs,
          }));
        }
        if (job.audio) {
          projectAssets.push(assetDescriptor({
            asset: job.audio,
            id: job.audio.id || `audio:${id}`,
            projectId: id,
            role: 'audio',
            position: 1,
            registry,
            blobs,
          }));
        }
      } else {
        projectAssets.push(assetDescriptor({
          asset: {
            ...job,
            file: job.file || null,
            info: job.info || null,
          },
          id: persistenceRef(job)?.recordId || `source:${id}`,
          projectId: id,
          role: 'source',
          position: 0,
          registry,
          blobs,
          storedRef: persistenceRef(job),
        }));
      }

      const projectOutputs = Array.from(job.outputs || []).map((output, index) => outputDescriptor({
        output, index, projectId: id, registry, blobs,
      }));
      assets.push(...projectAssets);
      outputs.push(...projectOutputs);

      const createdAt = finiteTimestamp(
        job.createdAt,
        typeof createdAtFor === 'function' ? createdAtFor(id, now) : now,
      );
      const record = {
        id,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        storageRevision: finiteInteger(job.storageRevision, 0),
        position,
        kind,
        name: asString(job.name, 'Proyecto sin título'),
        forgeToolId: job.forgeToolId ? String(job.forgeToolId) : null,
        operation: asString(job.operation, 'convert'),
        options: copyData(job.options || {}, `project(${id}).options`),
        status: storedProjectStatus(job.status, projectOutputs.length > 0),
        createdAt,
        updatedAt: finiteTimestamp(now, Date.now()),
        revision: finiteInteger(job.revision, 0),
        exportedRevision: Number.isInteger(job.exportedRevision) && job.exportedRevision >= 0
          ? job.exportedRevision
          : null,
        quickExportSignature: job.quickExportSignature ? String(job.quickExportSignature) : null,
        addAudioTouchedOptions: copyData(job.addAudioTouchedOptions || {}, `project(${id}).addAudioTouchedOptions`),
        selectedClipId: job.selectedClipId ? String(job.selectedClipId) : null,
        downloadName: job.downloadName ? String(job.downloadName) : null,
        assetIds: projectAssets.map((asset) => asset.id),
        outputIds: projectOutputs.map((output) => output.id),
      };
      projects.push(record);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      throw new ProjectStoreError('validation-failed', `No se pudo serializar el proyecto ${id}.`, { cause: error });
    }
  }

  issues.push(
    ...duplicateIssues(projects, 'project'),
    ...duplicateIssues(assets, 'asset'),
    ...duplicateIssues(outputs, 'output'),
    ...duplicateIssues(blobs, 'blob'),
  );
  const fatal = issues.filter((entry) => entry.recoverable === false);
  if (fatal.length) {
    throw new ProjectStoreError('validation-failed', 'El espacio de trabajo contiene identificadores inválidos.', {
      details: { issues: fatal },
    });
  }

  const projectIds = new Set(projects.map((project) => project.id));
  const safeSelectedId = selectedId && projectIds.has(String(selectedId)) ? String(selectedId) : null;
  if (selectedId && !safeSelectedId) {
    issues.push(makeIssue('selected-project-missing', 'El proyecto seleccionado ya no existe.'));
  }

  return {
    projects,
    assets,
    outputs,
    blobs,
    meta: {
      key: WORKSPACE_META_KEY,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      selectedId: safeSelectedId,
      updatedAt: finiteTimestamp(now, Date.now()),
    },
    issues,
  };
}

function validRecord(record, store, issues) {
  if (!record || typeof record !== 'object' || !asString(record.id)) {
    issues.push(makeIssue('invalid-record', `Se ignoró un registro inválido de ${store}.`, { store }));
    return false;
  }
  if (record.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    issues.push(makeIssue(
      record.schemaVersion > PROJECT_SCHEMA_VERSION ? 'newer-schema' : 'unsupported-schema',
      `El registro ${record.id} usa una versión de datos no compatible.`,
      { store, projectId: record.projectId || record.id },
    ));
    return false;
  }
  return true;
}

function toFile(blob, asset, FileClass) {
  if (!blobLike(blob)) return null;
  if (
    typeof FileClass === 'function'
    && blob instanceof FileClass
    && blob.name === asset.name
    && Number(blob.lastModified || 0) === Number(asset.lastModified || 0)
  ) return blob;
  if (typeof FileClass === 'function') {
    try {
      return new FileClass([blob], asset.name, {
        type: asset.type || blob.type || '',
        lastModified: asset.lastModified || 0,
      });
    } catch {
      // A Blob is still usable by FFmpeg. Name and size remain on the wrapper.
    }
  }
  return blob;
}

function hydrateAsset(record, blobMap, registry, FileClass, issues) {
  const storedBlob = record.blobId ? blobMap.get(record.blobId)?.data : null;
  const file = storedBlob ? toFile(storedBlob, record, FileClass) : null;
  if (file && record.blobId) registry.remember(file, record.blobId, `asset:${record.id}`);
  if (!file) {
    issues.push(makeIssue(
      'missing-asset-blob',
      `Falta la copia local de «${record.name}».`,
      { projectId: record.projectId, assetId: record.id, role: record.role },
    ));
  }
  const asset = {
    id: record.id,
    role: record.role,
    file,
    name: asString(record.name, 'archivo'),
    size: Number(record.size) || 0,
    type: asString(record.type),
    lastModified: finiteTimestamp(record.lastModified, 0),
    info: safeCopyData(
      record.info ?? null,
      `asset(${record.id}).info`,
      issues,
      { projectId: record.projectId, assetId: record.id },
      null,
    ),
    status: file ? (record.info ? 'ready' : 'pending') : 'failed',
    error: file ? null : 'Falta la copia local. Volvé a vincular este archivo.',
    needsRelink: !file,
  };
  rememberPersistenceRef(asset, { recordId: record.id, blobId: record.blobId });
  return asset;
}

function hydrateOutputs(records, blobMap, registry, issues) {
  const hydrated = [];
  for (const record of records.sort((a, b) => a.position - b.position)) {
    const blob = record.blobId ? blobMap.get(record.blobId)?.data : null;
    if (!blobLike(blob)) {
      issues.push(makeIssue(
        'missing-output-blob',
        `El resultado «${record.name}» ya no está disponible localmente.`,
        { projectId: record.projectId, outputId: record.id },
      ));
      continue;
    }
    registry.remember(blob, record.blobId, `output:${record.id}`);
    const output = { id: record.id, name: record.name, blob };
    rememberPersistenceRef(output, { recordId: record.id, blobId: record.blobId });
    hydrated.push(output);
  }
  return hydrated;
}

function restoredStatus(project, projectAssets, outputs, issues) {
  const missingSource = projectAssets.some((asset) => asset.needsRelink);
  if (missingSource) return 'failed';
  const needsProbe = projectAssets.some((asset) => asset.file && !asset.info);
  if (needsProbe) return 'probing';
  if (INTERRUPTED_STATUSES.has(project.status) || project.status === 'interrupted') {
    issues.push(makeIssue(
      'interrupted-run',
      `«${project.name}» se cerró durante el procesamiento y puede volver a iniciarse.`,
      { projectId: project.id },
    ));
    return 'ready';
  }
  if (project.status === 'done') return outputs.length ? 'done' : 'ready';
  if (project.status === 'failed' || project.status === 'cancelled') return project.status;
  return 'ready';
}

function commonJob(project, projectAssets, hydratedOutputs, issues) {
  const outputSize = hydratedOutputs.reduce((sum, output) => sum + Number(output.blob.size || 0), 0);
  const missing = projectAssets.some((asset) => asset.needsRelink);
  const status = restoredStatus(project, projectAssets, hydratedOutputs, issues);
  return {
    id: project.id,
    kind: project.kind === 'simple' ? undefined : (project.kind === 'merge' ? 'video-merge' : 'video-add-audio'),
    forgeToolId: project.forgeToolId || null,
    name: project.name,
    operation: project.operation,
    options: safeCopyData(
      project.options || {},
      `project(${project.id}).options`,
      issues,
      { projectId: project.id },
      {},
    ),
    status,
    progress: status === 'done' ? 1 : 0,
    speed: null,
    remaining: null,
    outputs: hydratedOutputs.length ? hydratedOutputs : null,
    outputSize,
    downloadName: project.downloadName || null,
    error: missing
      ? 'Faltan uno o más archivos locales. Volvé a vincularlos para continuar.'
      : (status === 'failed' ? 'La tarea anterior falló y puede volver a intentarse.' : null),
    log: [],
    revision: finiteInteger(project.revision, 0),
    exportedRevision: Number.isInteger(project.exportedRevision) ? project.exportedRevision : null,
    dirtySinceOutput: Number.isInteger(project.exportedRevision)
      && project.exportedRevision !== finiteInteger(project.revision, 0),
    quickExportSignature: project.quickExportSignature || null,
    addAudioTouchedOptions: safeCopyData(
      project.addAudioTouchedOptions || {},
      `project(${project.id}).addAudioTouchedOptions`,
      issues,
      { projectId: project.id },
      {},
    ),
    createdAt: finiteTimestamp(project.createdAt, 0),
    updatedAt: finiteTimestamp(project.updatedAt, 0),
    storageRevision: finiteInteger(project.storageRevision, 0),
    needsRelink: missing,
  };
}

/** Hydrate a persisted record graph into the exact job shapes App consumes. */
export function hydrateWorkspace(
  graph,
  {
    registry = createBlobIdentityRegistry(),
    FileClass = globalThis.File,
  } = {},
) {
  const issues = [];
  const rawProjects = Array.isArray(graph?.projects) ? graph.projects : [];
  const rawAssets = Array.isArray(graph?.assets) ? graph.assets : [];
  const rawOutputs = Array.isArray(graph?.outputs) ? graph.outputs : [];
  const rawBlobs = Array.isArray(graph?.blobs) ? graph.blobs : [];
  const projects = rawProjects.filter((record) => validRecord(record, 'projects', issues));
  const assets = rawAssets.filter((record) => validRecord(record, 'assets', issues));
  const outputs = rawOutputs.filter((record) => validRecord(record, 'outputs', issues));
  const blobs = rawBlobs.filter((record) => record && typeof record === 'object' && asString(record.id));

  const blobMap = new Map(blobs.map((record) => [record.id, record]));
  const assetsByProject = new Map();
  const outputsByProject = new Map();
  for (const record of assets) {
    if (!assetsByProject.has(record.projectId)) assetsByProject.set(record.projectId, []);
    assetsByProject.get(record.projectId).push(record);
  }
  for (const record of outputs) {
    if (!outputsByProject.has(record.projectId)) outputsByProject.set(record.projectId, []);
    outputsByProject.get(record.projectId).push(record);
  }

  const jobs = [];
  for (const project of projects.sort((a, b) => {
    const position = finiteInteger(a.position, Number.MAX_SAFE_INTEGER)
      - finiteInteger(b.position, Number.MAX_SAFE_INTEGER);
    if (position) return position;
    const updated = finiteTimestamp(a.updatedAt, 0) - finiteTimestamp(b.updatedAt, 0);
    return updated || String(a.id).localeCompare(String(b.id));
  })) {
    if (!PROJECT_KINDS.has(project.kind)) {
      issues.push(makeIssue('invalid-project-kind', `Se ignoró el proyecto ${project.id}.`, { projectId: project.id }));
      continue;
    }
    const availableAssetRecords = assetsByProject.get(project.id) || [];
    const assetRecordMap = new Map(availableAssetRecords.map((record) => [record.id, record]));
    const expectedAssetIds = Array.isArray(project.assetIds)
      ? project.assetIds.map(String)
      : availableAssetRecords.map((record) => record.id);
    if (!Array.isArray(project.assetIds)) {
      issues.push(makeIssue(
        'corrupt-project-refs',
        `El proyecto ${project.id} no tenía una lista válida de archivos.`,
        { projectId: project.id },
      ));
    }
    for (const assetId of expectedAssetIds) {
      if (!assetRecordMap.has(assetId)) {
        issues.push(makeIssue(
          'missing-asset-record',
          `Falta la descripción local del archivo ${assetId}.`,
          { projectId: project.id, assetId },
        ));
      }
    }
    const records = expectedAssetIds
      .map((id) => assetRecordMap.get(id))
      .filter(Boolean)
      .sort((a, b) => a.position - b.position);
    const projectAssets = records.map((record) => hydrateAsset(record, blobMap, registry, FileClass, issues));
    const availableOutputRecords = outputsByProject.get(project.id) || [];
    const outputRecordMap = new Map(availableOutputRecords.map((record) => [record.id, record]));
    const expectedOutputIds = Array.isArray(project.outputIds)
      ? project.outputIds.map(String)
      : availableOutputRecords.map((record) => record.id);
    if (!Array.isArray(project.outputIds)) {
      issues.push(makeIssue(
        'corrupt-project-refs',
        `El proyecto ${project.id} no tenía una lista válida de resultados.`,
        { projectId: project.id },
      ));
    }
    for (const outputId of expectedOutputIds) {
      if (!outputRecordMap.has(outputId)) {
        issues.push(makeIssue(
          'missing-output-record',
          `Falta la descripción local del resultado ${outputId}.`,
          { projectId: project.id, outputId },
        ));
      }
    }
    const outputRecords = expectedOutputIds.map((id) => outputRecordMap.get(id)).filter(Boolean);
    const projectOutputs = hydrateOutputs(outputRecords, blobMap, registry, issues);
    const common = commonJob(project, projectAssets, projectOutputs, issues);

    if (project.kind === 'merge') {
      const clips = projectAssets.filter((asset) => asset.role === 'clip');
      const first = clips[0] || null;
      jobs.push({
        ...common,
        clips,
        selectedClipId: clips.some((clip) => clip.id === project.selectedClipId)
          ? project.selectedClipId
          : first?.id || null,
        file: first?.file || null,
        size: clips.reduce((sum, clip) => sum + clip.size, 0),
        info: mergeProjectInfo(clips),
        validationError: null,
      });
      continue;
    }

    if (project.kind === 'add-audio') {
      const video = projectAssets.find((asset) => asset.role === 'video') || null;
      const audio = projectAssets.find((asset) => asset.role === 'audio') || null;
      jobs.push({
        ...common,
        video,
        audio,
        file: video?.file || null,
        name: video?.name || common.name,
        size: projectAssets.reduce((sum, asset) => sum + asset.size, 0),
        info: video?.info || null,
        validationError: null,
        validationCode: null,
      });
      continue;
    }

    const source = projectAssets.find((asset) => asset.role === 'source') || null;
    const job = {
      ...common,
      file: source?.file || null,
      name: project.name || source?.name || 'archivo',
      size: source?.size || 0,
      type: source?.type || '',
      lastModified: source?.lastModified || 0,
      info: source?.info || null,
    };
    if (!source) {
      job.status = 'failed';
      job.needsRelink = true;
      job.error = 'Falta la descripción del archivo de origen.';
      issues.push(makeIssue('missing-source-record', `El proyecto ${project.id} no tiene origen.`, { projectId: project.id }));
    } else {
      rememberPersistenceRef(job, persistenceRef(source));
    }
    jobs.push(job);
  }

  const ids = new Set(jobs.map((job) => job.id));
  const requestedSelectedId = graph?.meta?.selectedId ? String(graph.meta.selectedId) : null;
  const selectedId = requestedSelectedId && ids.has(requestedSelectedId)
    ? requestedSelectedId
    : jobs[0]?.id || null;
  if (requestedSelectedId && selectedId !== requestedSelectedId) {
    issues.push(makeIssue('selected-project-missing', 'El proyecto seleccionado ya no está disponible.'));
  }

  return {
    jobs,
    selectedId,
    storageRevision: finiteInteger(graph?.meta?.storageRevision, 0),
    issues,
  };
}

function cloneRecord(record) {
  if (!record) return record;
  if ('data' in record) return { ...record, data: record.data };
  return copyData(record);
}

function referencedBlobIds(assets, outputs) {
  return new Set([...assets, ...outputs].map((record) => record.blobId).filter(Boolean));
}

function quotaException() {
  try {
    return new DOMException('Quota exceeded', 'QuotaExceededError');
  } catch {
    const error = new Error('Quota exceeded');
    error.name = 'QuotaExceededError';
    return error;
  }
}

/** In-memory transactional backend used by unit tests and embedders. */
export function createMemoryProjectBackend({ quotaBytes = Infinity } = {}) {
  let opened = false;
  let state = {
    projects: new Map(), assets: new Map(), outputs: new Map(), blobs: new Map(), meta: new Map(),
  };

  const graph = () => ({
    projects: [...state.projects.values()].map(cloneRecord),
    assets: [...state.assets.values()].map(cloneRecord),
    outputs: [...state.outputs.values()].map(cloneRecord),
    blobs: [...state.blobs.values()].map(cloneRecord),
    meta: cloneRecord(state.meta.get(WORKSPACE_META_KEY)) || null,
  });

  return {
    async open() { opened = true; },
    async readGraph() { if (!opened) await this.open(); return graph(); },
    async listBlobIds() { if (!opened) await this.open(); return [...state.blobs.keys()]; },
    async saveGraph(nextGraph, { expectedStorageRevision = null, replace = true } = {}) {
      if (!opened) await this.open();
      const currentRevision = finiteInteger(state.meta.get(WORKSPACE_META_KEY)?.storageRevision, 0);
      if (expectedStorageRevision !== null && expectedStorageRevision !== currentRevision) {
        throw new ProjectStoreError('conflict', 'El proyecto cambió en otra pestaña.', {
          details: { expectedStorageRevision, actualStorageRevision: currentRevision },
        });
      }
      const next = replace
        ? { projects: new Map(), assets: new Map(), outputs: new Map(), blobs: new Map(state.blobs), meta: new Map() }
        : {
          projects: new Map(state.projects), assets: new Map(state.assets), outputs: new Map(state.outputs),
          blobs: new Map(state.blobs), meta: new Map(state.meta),
        };
      const storageRevision = currentRevision + 1;
      for (const record of nextGraph.projects) next.projects.set(record.id, { ...cloneRecord(record), storageRevision });
      for (const record of nextGraph.assets) next.assets.set(record.id, cloneRecord(record));
      for (const record of nextGraph.outputs) next.outputs.set(record.id, cloneRecord(record));
      for (const record of nextGraph.blobs) next.blobs.set(record.id, cloneRecord(record));
      const referenced = referencedBlobIds(next.assets.values(), next.outputs.values());
      for (const id of next.blobs.keys()) if (!referenced.has(id)) next.blobs.delete(id);
      const used = [...next.blobs.values()].reduce((sum, record) => sum + Number(record.size || record.data?.size || 0), 0);
      if (used > quotaBytes) throw quotaException();
      next.meta.set(WORKSPACE_META_KEY, {
        ...cloneRecord(nextGraph.meta), key: WORKSPACE_META_KEY, storageRevision,
      });
      state = next;
      return { storageRevision };
    },
    async deleteProject(projectId, { expectedStorageRevision = null } = {}) {
      const id = String(projectId);
      const currentRevision = finiteInteger(state.meta.get(WORKSPACE_META_KEY)?.storageRevision, 0);
      if (expectedStorageRevision !== null && expectedStorageRevision !== currentRevision) {
        throw new ProjectStoreError('conflict', 'El proyecto cambió en otra pestaña.', {
          details: { expectedStorageRevision, actualStorageRevision: currentRevision },
        });
      }
      state.projects.delete(id);
      for (const store of [state.assets, state.outputs, state.blobs]) {
        for (const [key, record] of store) if (record.projectId === id) store.delete(key);
      }
      const current = state.meta.get(WORKSPACE_META_KEY) || { key: WORKSPACE_META_KEY };
      const storageRevision = currentRevision + 1;
      state.meta.set(WORKSPACE_META_KEY, {
        ...current,
        selectedId: current.selectedId === id ? null : current.selectedId,
        storageRevision,
      });
      return { storageRevision };
    },
    async clear({ expectedStorageRevision = null } = {}) {
      const currentRevision = finiteInteger(state.meta.get(WORKSPACE_META_KEY)?.storageRevision, 0);
      if (expectedStorageRevision !== null && expectedStorageRevision !== currentRevision) {
        throw new ProjectStoreError('conflict', 'El espacio de trabajo cambió en otra pestaña.', {
          details: { expectedStorageRevision, actualStorageRevision: currentRevision },
        });
      }
      const storageRevision = currentRevision + 1;
      state = {
        projects: new Map(), assets: new Map(), outputs: new Map(), blobs: new Map(),
        meta: new Map([[
          WORKSPACE_META_KEY,
          { key: WORKSPACE_META_KEY, schemaVersion: PROJECT_SCHEMA_VERSION, selectedId: null, storageRevision },
        ]]),
      };
      return { storageRevision };
    },
    async cleanupOrphans() {
      const projectIds = new Set(state.projects.keys());
      const projectAssets = new Map([...state.projects.values()].map((project) => [
        project.id,
        Array.isArray(project.assetIds) ? new Set(project.assetIds) : null,
      ]));
      const projectOutputs = new Map([...state.projects.values()].map((project) => [
        project.id,
        Array.isArray(project.outputIds) ? new Set(project.outputIds) : null,
      ]));
      let assets = 0;
      let outputs = 0;
      let blobs = 0;
      for (const [id, record] of state.assets) {
        const refs = projectAssets.get(record.projectId);
        if (!projectIds.has(record.projectId) || (refs && !refs.has(id))) {
          state.assets.delete(id);
          assets += 1;
        }
      }
      for (const [id, record] of state.outputs) {
        const refs = projectOutputs.get(record.projectId);
        if (!projectIds.has(record.projectId) || (refs && !refs.has(id))) {
          state.outputs.delete(id);
          outputs += 1;
        }
      }
      const referenced = referencedBlobIds(state.assets.values(), state.outputs.values());
      for (const id of state.blobs.keys()) {
        if (!referenced.has(id)) { state.blobs.delete(id); blobs += 1; }
      }
      return { assets, outputs, blobs };
    },
    async stats() {
      const sourceBytes = [...state.blobs.values()]
        .filter((record) => record.ownerType === 'asset')
        .reduce((sum, record) => sum + Number(record.size || record.data?.size || 0), 0);
      const outputBytes = [...state.blobs.values()]
        .filter((record) => record.ownerType === 'output')
        .reduce((sum, record) => sum + Number(record.size || record.data?.size || 0), 0);
      return { managedBytes: sourceBytes + outputBytes, sourceBytes, outputBytes };
    },
    close() { opened = false; },
    /** Test-only snapshot; returned records cannot mutate backend state. */
    snapshot() { return graph(); },
  };
}

const requestPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionPromise = (transaction, manualError = () => null) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => {};
  transaction.onabort = () => reject(manualError() || transaction.error || new Error('IndexedDB transaction aborted.'));
});

function ensureSchema(database) {
  const projects = database.createObjectStore(PROJECT_STORES.projects, { keyPath: 'id' });
  projects.createIndex('updatedAt', 'updatedAt');
  const assets = database.createObjectStore(PROJECT_STORES.assets, { keyPath: 'id' });
  assets.createIndex('projectId', 'projectId');
  assets.createIndex('projectPosition', ['projectId', 'position']);
  const outputs = database.createObjectStore(PROJECT_STORES.outputs, { keyPath: 'id' });
  outputs.createIndex('projectId', 'projectId');
  outputs.createIndex('projectPosition', ['projectId', 'position']);
  const blobs = database.createObjectStore(PROJECT_STORES.blobs, { keyPath: 'id' });
  blobs.createIndex('projectId', 'projectId');
  database.createObjectStore(PROJECT_STORES.meta, { keyPath: 'key' });
}

/** Native IndexedDB V1 backend. Opening it is lazy and side-effect free on import. */
export function createIndexedDbProjectBackend({
  indexedDB = globalThis.indexedDB,
  name = PROJECT_DB_NAME,
} = {}) {
  let database = null;
  let opening = null;

  const open = async () => {
    if (database) return database;
    if (opening) return opening;
    if (!indexedDB?.open) {
      throw new ProjectStoreError('storage-unavailable', 'IndexedDB no está disponible en este navegador.');
    }
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, PROJECT_DB_VERSION);
      request.onupgradeneeded = (event) => {
        if (event.oldVersion === 0) ensureSchema(request.result);
      };
      request.onerror = () => reject(storageError(request.error, 'abrir'));
      request.onblocked = () => reject(new ProjectStoreError(
        'storage-unavailable',
        'Otra pestaña mantiene abierta una versión anterior del almacenamiento.',
      ));
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => {
          database?.close();
          database = null;
        };
        database.onclose = () => { database = null; };
        resolve(database);
      };
    }).finally(() => { opening = null; });
    return opening;
  };

  const readGraph = async () => {
    const db = await open();
    const names = Object.values(PROJECT_STORES);
    const transaction = db.transaction(names, 'readonly');
    const done = transactionPromise(transaction);
    const [projects, assets, outputs, blobs, meta] = await Promise.all([
      requestPromise(transaction.objectStore(PROJECT_STORES.projects).getAll()),
      requestPromise(transaction.objectStore(PROJECT_STORES.assets).getAll()),
      requestPromise(transaction.objectStore(PROJECT_STORES.outputs).getAll()),
      requestPromise(transaction.objectStore(PROJECT_STORES.blobs).getAll()),
      requestPromise(transaction.objectStore(PROJECT_STORES.meta).get(WORKSPACE_META_KEY)),
    ]);
    await done;
    return { projects, assets, outputs, blobs, meta: meta || null };
  };

  // Quota preflight only needs identity, not the Blob payloads. Keeping this
  // as a keys-only read avoids pulling a large saved workspace into memory on
  // every autosave.
  const listBlobIds = async () => {
    const db = await open();
    const transaction = db.transaction(PROJECT_STORES.blobs, 'readonly');
    const done = transactionPromise(transaction);
    const ids = await requestPromise(transaction.objectStore(PROJECT_STORES.blobs).getAllKeys());
    await done;
    return ids.map(String);
  };

  const saveGraph = async (graph, { expectedStorageRevision = null, replace = true } = {}) => {
    const db = await open();
    const names = Object.values(PROJECT_STORES);
    const transaction = db.transaction(names, 'readwrite');
    let explicitError = null;
    let result = null;
    const done = transactionPromise(transaction, () => explicitError);
    const stores = Object.fromEntries(names.map((storeName) => [storeName, transaction.objectStore(storeName)]));
    const requests = {
      projects: stores.projects.getAllKeys(),
      assets: stores.assets.getAllKeys(),
      outputs: stores.outputs.getAllKeys(),
      blobs: stores.blobs.getAllKeys(),
      meta: stores.meta.get(WORKSPACE_META_KEY),
    };
    let remaining = Object.keys(requests).length;

    const apply = () => {
      try {
        const currentRevision = finiteInteger(requests.meta.result?.storageRevision, 0);
        if (expectedStorageRevision !== null && expectedStorageRevision !== currentRevision) {
          explicitError = new ProjectStoreError('conflict', 'El espacio de trabajo cambió en otra pestaña.', {
            details: { expectedStorageRevision, actualStorageRevision: currentRevision },
          });
          transaction.abort();
          return;
        }
        const storageRevision = currentRevision + 1;
        const desired = {
          projects: new Set(graph.projects.map((record) => record.id)),
          assets: new Set(graph.assets.map((record) => record.id)),
          outputs: new Set(graph.outputs.map((record) => record.id)),
          blobs: referencedBlobIds(graph.assets, graph.outputs),
        };
        if (replace) {
          for (const storeName of ['projects', 'assets', 'outputs', 'blobs']) {
            for (const key of requests[storeName].result) {
              if (!desired[storeName].has(key)) stores[storeName].delete(key);
            }
          }
        }
        for (const record of graph.projects) stores.projects.put({ ...record, storageRevision });
        for (const record of graph.assets) stores.assets.put(record);
        for (const record of graph.outputs) stores.outputs.put(record);
        const existingBlobs = new Set(requests.blobs.result);
        for (const record of graph.blobs) {
          if (!existingBlobs.has(record.id)) stores.blobs.put(record);
        }
        stores.meta.put({ ...graph.meta, key: WORKSPACE_META_KEY, storageRevision });
        result = { storageRevision };
      } catch (error) {
        explicitError = error;
        transaction.abort();
      }
    };

    for (const request of Object.values(requests)) {
      request.onsuccess = () => { remaining -= 1; if (remaining === 0) apply(); };
      request.onerror = () => { explicitError = request.error; };
    }
    try {
      await done;
      return result;
    } catch (error) {
      throw storageError(error, 'guardar');
    }
  };

  const deleteProject = async (projectId, { expectedStorageRevision = null } = {}) => {
    const db = await open();
    const names = Object.values(PROJECT_STORES);
    const transaction = db.transaction(names, 'readwrite');
    let explicitError = null;
    let result = null;
    const done = transactionPromise(transaction, () => explicitError);
    const projects = transaction.objectStore(PROJECT_STORES.projects);
    const assets = transaction.objectStore(PROJECT_STORES.assets);
    const outputs = transaction.objectStore(PROJECT_STORES.outputs);
    const blobs = transaction.objectStore(PROJECT_STORES.blobs);
    const meta = transaction.objectStore(PROJECT_STORES.meta);
    const requests = [
      assets.index('projectId').getAllKeys(String(projectId)),
      outputs.index('projectId').getAllKeys(String(projectId)),
      blobs.index('projectId').getAllKeys(String(projectId)),
      meta.get(WORKSPACE_META_KEY),
    ];
    let remaining = requests.length;
    const apply = () => {
      const currentRevision = finiteInteger(requests[3].result?.storageRevision, 0);
      if (expectedStorageRevision !== null && expectedStorageRevision !== currentRevision) {
        explicitError = new ProjectStoreError('conflict', 'El proyecto cambió en otra pestaña.', {
          details: { expectedStorageRevision, actualStorageRevision: currentRevision },
        });
        transaction.abort();
        return;
      }
      projects.delete(String(projectId));
      for (const key of requests[0].result) assets.delete(key);
      for (const key of requests[1].result) outputs.delete(key);
      for (const key of requests[2].result) blobs.delete(key);
      const current = requests[3].result || { key: WORKSPACE_META_KEY };
      const storageRevision = currentRevision + 1;
      meta.put({
        ...current,
        selectedId: current.selectedId === String(projectId) ? null : current.selectedId,
        storageRevision,
      });
      result = { storageRevision };
    };
    for (const request of requests) {
      request.onsuccess = () => { remaining -= 1; if (remaining === 0) apply(); };
      request.onerror = () => { explicitError = request.error; };
    }
    try { await done; return result; } catch (error) { throw storageError(error, 'eliminar'); }
  };

  const clear = async ({ expectedStorageRevision = null } = {}) => {
    const db = await open();
    const transaction = db.transaction(Object.values(PROJECT_STORES), 'readwrite');
    let result = null;
    let explicitError = null;
    const done = transactionPromise(transaction, () => explicitError);
    const meta = transaction.objectStore(PROJECT_STORES.meta);
    const request = meta.get(WORKSPACE_META_KEY);
    request.onsuccess = () => {
      const currentRevision = finiteInteger(request.result?.storageRevision, 0);
      if (expectedStorageRevision !== null && expectedStorageRevision !== currentRevision) {
        explicitError = new ProjectStoreError('conflict', 'El espacio de trabajo cambió en otra pestaña.', {
          details: { expectedStorageRevision, actualStorageRevision: currentRevision },
        });
        transaction.abort();
        return;
      }
      const storageRevision = currentRevision + 1;
      for (const name of Object.values(PROJECT_STORES)) transaction.objectStore(name).clear();
      meta.put({
        key: WORKSPACE_META_KEY,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        selectedId: null,
        storageRevision,
      });
      result = { storageRevision };
    };
    request.onerror = () => { explicitError = request.error; };
    try { await done; return result; } catch (error) { throw storageError(error, 'vaciar'); }
  };

  const cleanupOrphans = async () => {
    const db = await open();
    const names = Object.values(PROJECT_STORES);
    const transaction = db.transaction(names, 'readwrite');
    let explicitError = null;
    let result = { assets: 0, outputs: 0, blobs: 0 };
    const done = transactionPromise(transaction, () => explicitError);
    const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
    const requests = [stores.projects.getAll(), stores.assets.getAll(), stores.outputs.getAll(), stores.blobs.getAllKeys()];
    let remaining = requests.length;
    const apply = () => {
      const projectIds = new Set(requests[0].result.map((project) => project.id));
      const projectAssets = new Map(requests[0].result.map((project) => [
        project.id,
        Array.isArray(project.assetIds) ? new Set(project.assetIds) : null,
      ]));
      const projectOutputs = new Map(requests[0].result.map((project) => [
        project.id,
        Array.isArray(project.outputIds) ? new Set(project.outputIds) : null,
      ]));
      const validAssets = requests[1].result.filter((record) => {
        const refs = projectAssets.get(record.projectId);
        if (projectIds.has(record.projectId) && (!refs || refs.has(record.id))) return true;
        stores.assets.delete(record.id);
        result.assets += 1;
        return false;
      });
      const validOutputs = requests[2].result.filter((record) => {
        const refs = projectOutputs.get(record.projectId);
        if (projectIds.has(record.projectId) && (!refs || refs.has(record.id))) return true;
        stores.outputs.delete(record.id);
        result.outputs += 1;
        return false;
      });
      const referenced = referencedBlobIds(validAssets, validOutputs);
      for (const id of requests[3].result) {
        if (!referenced.has(id)) { stores.blobs.delete(id); result.blobs += 1; }
      }
    };
    for (const request of requests) {
      request.onsuccess = () => { remaining -= 1; if (remaining === 0) apply(); };
      request.onerror = () => { explicitError = request.error; };
    }
    try { await done; return result; } catch (error) { throw storageError(error, 'reparar'); }
  };

  const stats = async () => {
    const db = await open();
    const transaction = db.transaction(PROJECT_STORES.blobs, 'readonly');
    const done = transactionPromise(transaction);
    const blobs = await requestPromise(transaction.objectStore(PROJECT_STORES.blobs).getAll());
    await done;
    const sourceBytes = blobs
      .filter((record) => record.ownerType === 'asset')
      .reduce((sum, record) => sum + Number(record.size || record.data?.size || 0), 0);
    const outputBytes = blobs
      .filter((record) => record.ownerType === 'output')
      .reduce((sum, record) => sum + Number(record.size || record.data?.size || 0), 0);
    return { managedBytes: sourceBytes + outputBytes, sourceBytes, outputBytes };
  };

  return {
    open,
    readGraph,
    listBlobIds,
    saveGraph,
    deleteProject,
    clear,
    cleanupOrphans,
    stats,
    close() { database?.close(); database = null; },
  };
}

function normalizeSaveArguments(jobsOrWorkspace, options) {
  if (Array.isArray(jobsOrWorkspace)) return { jobs: jobsOrWorkspace, options: options || {} };
  if (jobsOrWorkspace && Array.isArray(jobsOrWorkspace.jobs)) {
    return {
      jobs: jobsOrWorkspace.jobs,
      options: { selectedId: jobsOrWorkspace.selectedId ?? null, ...(options || {}) },
    };
  }
  throw new ProjectStoreError('validation-failed', 'saveWorkspace expects jobs or { jobs, selectedId }.');
}

/**
 * Keep a previously durable result when a newly produced result does not fit.
 * Source descriptors still follow the new project state: restoring an older
 * source under new edits would be dishonest, so a missing new source becomes
 * an explicit relink instead.
 */
function metadataOnlyGraph(nextGraph, previousGraph) {
  const previousProjects = new Map((previousGraph?.projects || []).map((record) => [record.id, record]));
  const previousOutputs = new Map();
  for (const output of previousGraph?.outputs || []) {
    if (!previousOutputs.has(output.projectId)) previousOutputs.set(output.projectId, []);
    previousOutputs.get(output.projectId).push(output);
  }
  const durableBlobIds = new Set((previousGraph?.blobs || []).map((record) => record.id));
  const nextOutputs = new Map();
  for (const output of nextGraph.outputs) {
    if (!nextOutputs.has(output.projectId)) nextOutputs.set(output.projectId, []);
    nextOutputs.get(output.projectId).push(output);
  }

  const outputs = [];
  const projects = nextGraph.projects.map((project) => {
    const requested = nextOutputs.get(project.id) || [];
    const allRequestedDurable = requested.every((output) => (
      output.blobId && durableBlobIds.has(output.blobId)
    ));
    if (!requested.length || allRequestedDurable) {
      outputs.push(...requested);
      return project;
    }

    const retained = (previousOutputs.get(project.id) || []).filter((output) => (
      output.blobId && durableBlobIds.has(output.blobId)
    ));
    outputs.push(...retained);
    const previous = previousProjects.get(project.id);
    return {
      ...project,
      status: 'ready',
      outputIds: retained.map((output) => output.id),
      exportedRevision: previous?.exportedRevision ?? null,
      quickExportSignature: previous?.quickExportSignature ?? null,
      downloadName: previous?.downloadName ?? project.downloadName,
    };
  });

  return {
    ...nextGraph,
    projects,
    outputs,
    blobs: [],
  };
}

function blobRecordBytes(record) {
  const bytes = Number(record?.data?.size ?? record?.size ?? 0);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function newBlobRequirements(nextGraph, durableIds) {
  const durable = durableIds instanceof Set ? durableIds : new Set(durableIds || []);
  const seen = new Set();
  let requiredBytes = 0;
  let newBlobCount = 0;
  for (const record of nextGraph?.blobs || []) {
    const id = asString(record?.id);
    if (!id || seen.has(id) || durable.has(id)) continue;
    seen.add(id);
    newBlobCount += 1;
    requiredBytes += blobRecordBytes(record);
  }
  return { newBlobCount, requiredBytes };
}

async function inspectQuota(storageManager, requirements) {
  if (!requirements.newBlobCount || !requirements.requiredBytes) return null;
  if (typeof storageManager?.estimate !== 'function') return null;
  let estimate;
  try { estimate = await storageManager.estimate(); } catch { return null; }
  const usage = estimate?.usage;
  const quota = estimate?.quota;
  if (
    typeof usage !== 'number'
    || typeof quota !== 'number'
    || !Number.isFinite(usage)
    || !Number.isFinite(quota)
    || usage < 0
    || quota < 0
  ) return null;
  const availableBytes = Math.max(0, quota - usage);
  return Object.freeze({
    checked: true,
    newBlobCount: requirements.newBlobCount,
    requiredBytes: requirements.requiredBytes,
    usage,
    quota,
    availableBytes,
    projectedUsage: usage + requirements.requiredBytes,
    // An exact fit is allowed through. Browser estimates are approximate; an
    // actual transaction-level QuotaExceededError remains the final boundary.
    insufficient: requirements.requiredBytes > availableBytes,
  });
}

function preflightQuotaError(report) {
  return new ProjectStoreError(
    'quota-exceeded',
    'No hay espacio local suficiente para guardar este proyecto.',
    { details: { operation: 'guardar', preflight: true, ...report } },
  );
}

/**
 * Public repository used by App. The backend is injectable so all project
 * semantics can be tested without pretending Node has a browser database.
 */
export function createProjectStore({
  backend = null,
  indexedDB = globalThis.indexedDB,
  storageManager = globalThis.navigator?.storage || null,
  channelFactory = (name) => (typeof globalThis.BroadcastChannel === 'function'
    ? new globalThis.BroadcastChannel(name)
    : null),
  now = () => Date.now(),
  makeId = defaultMakeId,
} = {}) {
  const storageBackend = backend || createIndexedDbProjectBackend({ indexedDB });
  const registry = createBlobIdentityRegistry(makeId);
  const listeners = new Set();
  const createdAt = new Map();
  const writerId = makeId('writer');
  let channel = null;
  let opened = false;
  let lastStorageRevision = null;

  const notify = (message) => {
    for (const listener of listeners) listener(message);
  };

  const broadcast = (message) => {
    const payload = { type: 'workspace-changed', writerId, ...message };
    channel?.postMessage?.(payload);
    notify({ ...payload, local: true });
  };

  const api = {
    async open() {
      if (opened) return api;
      try { await storageBackend.open(); }
      catch (error) { throw storageError(error, 'abrir'); }
      try {
        channel = channelFactory?.(PROJECT_CHANNEL_NAME) || null;
        if (channel) {
          channel.onmessage = (event) => {
            const message = event?.data;
            if (message?.type !== 'workspace-changed' || message.writerId === writerId) return;
            notify({ ...message, local: false });
          };
        }
      } catch {
        channel = null;
      }
      opened = true;
      return api;
    },

    async loadWorkspace({ cleanup = true } = {}) {
      await api.open();
      const issues = [];
      if (cleanup) {
        try {
          const removed = await storageBackend.cleanupOrphans();
          const count = Object.values(removed).reduce((sum, value) => sum + Number(value || 0), 0);
          if (count) issues.push(makeIssue('orphans-cleaned', `Se limpiaron ${count} registros locales huérfanos.`));
        } catch (error) {
          issues.push(makeIssue('orphan-cleanup-failed', storageError(error, 'reparar').message));
        }
      }
      let graph;
      try { graph = await storageBackend.readGraph(); } catch (error) { throw storageError(error, 'leer'); }
      const hydrated = hydrateWorkspace(graph, { registry });
      lastStorageRevision = hydrated.storageRevision;
      for (const job of hydrated.jobs) createdAt.set(job.id, job.createdAt || now());
      return {
        jobs: hydrated.jobs,
        selectedId: hydrated.selectedId,
        storageRevision: hydrated.storageRevision,
        issues: [...issues, ...hydrated.issues],
      };
    },

    /**
     * `quotaPreflight` is returned when the browser supplied a usable quota
     * estimate. A `quota-metadata-only` issue carries `preflight: true` when
     * that estimate (rather than the IndexedDB transaction) caused fallback.
     */
    async saveWorkspace(jobsOrWorkspace, options = {}) {
      await api.open();
      const normalized = normalizeSaveArguments(jobsOrWorkspace, options);
      const {
        selectedId = null,
        metadataOnly = false,
        allowMetadataFallback = true,
        expectedStorageRevision = lastStorageRevision,
        replace = true,
      } = normalized.options;
      const timestamp = now();
      const graph = serializeWorkspace(normalized.jobs, {
        selectedId,
        now: timestamp,
        registry,
        createdAtFor(id, fallback) {
          if (!createdAt.has(id)) createdAt.set(id, fallback);
          return createdAt.get(id);
        },
      });
      let usedMetadataFallback = Boolean(metadataOnly);
      let quotaPreflight = null;
      let result;

      const persistQuotaFallback = async (previousGraph, report = null) => {
        const fallbackGraph = metadataOnlyGraph(graph, previousGraph);
        const fallbackResult = await storageBackend.saveGraph(
          fallbackGraph,
          { expectedStorageRevision, replace },
        );
        usedMetadataFallback = true;
        graph.issues.push(makeIssue(
          'quota-metadata-only',
          'Se guardaron los ajustes, pero no todos los archivos. Será necesario volver a vincularlos.',
          report
            ? {
              preflight: true,
              requiredBytes: report.requiredBytes,
              availableBytes: report.availableBytes,
              projectedUsage: report.projectedUsage,
            }
            : { preflight: false },
        ));
        const previousOutputs = Array.isArray(previousGraph?.outputs) ? previousGraph.outputs : [];
        const retainedOutputs = fallbackGraph.outputs.filter((output) => (
          previousOutputs.some((previous) => (
            previous.id === output.id && previous.blobId === output.blobId
          ))
        ));
        if (retainedOutputs.length) {
          graph.issues.push(makeIssue(
            'quota-last-output-preserved',
            'El resultado nuevo quedó sólo en esta sesión; conservamos el último resultado guardado.',
            report ? { preflight: true } : { preflight: false },
          ));
        }
        return fallbackResult;
      };

      if (metadataOnly) {
        try {
          const previousGraph = await storageBackend.readGraph();
          result = await storageBackend.saveGraph(
            metadataOnlyGraph(graph, previousGraph),
            { expectedStorageRevision, replace },
          );
        } catch (error) {
          throw storageError(error, 'guardar');
        }
      } else {
        if (graph.blobs.length && typeof storageManager?.estimate === 'function') {
          try {
            const durableIds = typeof storageBackend.listBlobIds === 'function'
              ? await storageBackend.listBlobIds()
              : (await storageBackend.readGraph()).blobs.map((record) => record.id);
            quotaPreflight = await inspectQuota(
              storageManager,
              newBlobRequirements(graph, durableIds),
            );
          } catch {
            // Quota estimates are advisory. If keys/estimate cannot be read,
            // let IndexedDB make the authoritative decision atomically.
            quotaPreflight = null;
          }
        }

        if (quotaPreflight?.insufficient) {
          if (!allowMetadataFallback) throw preflightQuotaError(quotaPreflight);
          try {
            result = await persistQuotaFallback(
              await storageBackend.readGraph(),
              quotaPreflight,
            );
          } catch (error) {
            throw storageError(error, 'guardar');
          }
        } else {
          try {
            result = await storageBackend.saveGraph(
              graph,
              { expectedStorageRevision, replace },
            );
          } catch (error) {
            const normalizedError = storageError(error, 'guardar');
            if (!allowMetadataFallback || !isQuotaExceededError(normalizedError)) {
              throw normalizedError;
            }
            try {
              result = await persistQuotaFallback(await storageBackend.readGraph());
            } catch (fallbackError) {
              throw storageError(fallbackError, 'guardar');
            }
          }
        }
      }
      lastStorageRevision = result.storageRevision;
      broadcast({ storageRevision: result.storageRevision });
      return {
        saved: true,
        selectedId: graph.meta.selectedId,
        storageRevision: result.storageRevision,
        metadataOnly: usedMetadataFallback,
        quotaPreflight,
        issues: graph.issues,
      };
    },

    async deleteProject(projectId, { expectedStorageRevision = lastStorageRevision } = {}) {
      await api.open();
      if (!asString(projectId)) throw new ProjectStoreError('validation-failed', 'deleteProject necesita un id.');
      let result;
      try {
        result = await storageBackend.deleteProject(String(projectId), { expectedStorageRevision });
      }
      catch (error) { throw storageError(error, 'eliminar'); }
      createdAt.delete(String(projectId));
      lastStorageRevision = result.storageRevision;
      broadcast({ storageRevision: result.storageRevision, projectId: String(projectId), deleted: true });
      return { deleted: true, projectId: String(projectId), storageRevision: result.storageRevision };
    },

    async clear({ expectedStorageRevision = lastStorageRevision } = {}) {
      await api.open();
      let result;
      try { result = await storageBackend.clear({ expectedStorageRevision }); }
      catch (error) { throw storageError(error, 'vaciar'); }
      createdAt.clear();
      lastStorageRevision = result.storageRevision;
      broadcast({ storageRevision: result.storageRevision, cleared: true });
      return { cleared: true, storageRevision: result.storageRevision };
    },

    async cleanupOrphans() {
      await api.open();
      try { return await storageBackend.cleanupOrphans(); }
      catch (error) { throw storageError(error, 'reparar'); }
    },

    async estimate() {
      await api.open();
      let browser = {};
      try { browser = await storageManager?.estimate?.() || {}; } catch { browser = {}; }
      let persisted = false;
      try { persisted = Boolean(await storageManager?.persisted?.()); } catch { persisted = false; }
      const managed = await storageBackend.stats();
      const usage = Number.isFinite(Number(browser.usage)) ? Number(browser.usage) : null;
      const quota = Number.isFinite(Number(browser.quota)) ? Number(browser.quota) : null;
      return {
        usage,
        quota,
        available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
        persisted,
        ...managed,
      };
    },

    async requestPersistence() {
      if (!storageManager?.persist) {
        return { supported: false, persisted: false };
      }
      try {
        if (await storageManager.persisted?.()) return { supported: true, persisted: true };
        return { supported: true, persisted: Boolean(await storageManager.persist()) };
      } catch (error) {
        throw storageError(error, 'proteger');
      }
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe expects a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      channel?.close?.();
      channel = null;
      storageBackend.close?.();
      opened = false;
    },
  };

  return api;
}

// Convenient singleton exports keep App integration terse while the factory
// remains available for tests, multiple profiles and future storage drivers.
export const projectStore = createProjectStore();
export const open = (...args) => projectStore.open(...args);
export const loadWorkspace = (...args) => projectStore.loadWorkspace(...args);
export const saveWorkspace = (...args) => projectStore.saveWorkspace(...args);
export const deleteProject = (...args) => projectStore.deleteProject(...args);
export const clear = (...args) => projectStore.clear(...args);
export const estimate = (...args) => projectStore.estimate(...args);
export const requestPersistence = (...args) => projectStore.requestPersistence(...args);
