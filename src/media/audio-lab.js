/**
 * Pure, persistent model for the focused Audio Lab workspace.
 *
 * The graph owns editing intent, never media bytes. Its root points to one
 * exact generated output id, while every other node is a virtual range inside
 * its parent. A fragment of a fragment therefore remains cheap to persist and
 * can always be resolved back to one absolute range of the root output.
 */

import { createPersistentId } from '../storage/ids.js';

export const AUDIO_LAB_SCHEMA_VERSION = 1;
export const AUDIO_LAB_MIN_FRAGMENT_SECONDS = 0.01;

const RANGE_EPSILON = 1e-9;

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const optionalText = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    throw new AudioLabModelError('invalid-metadata', 'Audio Lab text metadata must be a non-empty trimmed string.');
  }
  return value;
};

function requiredId(value, code, message) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new AudioLabModelError(code, message);
  }
  return value;
}

function positiveDuration(value, code = 'invalid-duration', label = 'duration') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AudioLabModelError(code, `Audio Lab ${label} must be a finite positive number.`);
  }
  return value;
}

function optionalSize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AudioLabModelError('invalid-size', 'Audio Lab source size must be a finite non-negative number.');
  }
  return value;
}

function defaultMakeId(prefix) {
  return createPersistentId(prefix);
}

function generatedId(makeId, prefix) {
  if (typeof makeId !== 'function') {
    throw new AudioLabModelError('invalid-id-factory', 'Audio Lab needs an id factory.');
  }
  return requiredId(
    makeId(prefix),
    'invalid-node-id',
    `Could not create a persistent ${prefix} id.`,
  );
}

function freezeRoot(node) {
  return Object.freeze(node);
}

function freezeFragment(node) {
  return Object.freeze({
    ...node,
    range: Object.freeze({ ...node.range }),
  });
}

function freezeState({ rootNodeId, selectedNodeId, nodes }) {
  return Object.freeze({
    schemaVersion: AUDIO_LAB_SCHEMA_VERSION,
    rootNodeId,
    selectedNodeId,
    nodes: Object.freeze(nodes),
  });
}

function canonicalRoot(candidate) {
  if (!isPlainObject(candidate)) {
    throw new AudioLabModelError('invalid-node', 'Every Audio Lab node must be a plain object.');
  }
  const id = requiredId(candidate.id, 'invalid-node-id', 'Every Audio Lab node needs a stable id.');
  if (candidate.kind !== 'root') {
    throw new AudioLabModelError('invalid-node-kind', `Node ${id} must be a root or fragment.`);
  }
  if (candidate.parentNodeId !== null) {
    throw new AudioLabModelError('invalid-root-parent', 'The Audio Lab root cannot have a parent.');
  }

  return freezeRoot({
    id,
    kind: 'root',
    parentNodeId: null,
    outputId: requiredId(
      candidate.outputId,
      'invalid-output-id',
      'The Audio Lab root needs the exact source output id.',
    ),
    projectId: optionalText(candidate.projectId),
    resultId: optionalText(candidate.resultId),
    name: optionalText(candidate.name) || 'Audio original',
    type: optionalText(candidate.type),
    size: optionalSize(candidate.size),
    duration: positiveDuration(candidate.duration),
  });
}

function canonicalFragment(candidate) {
  if (!isPlainObject(candidate)) {
    throw new AudioLabModelError('invalid-node', 'Every Audio Lab node must be a plain object.');
  }
  const id = requiredId(candidate.id, 'invalid-node-id', 'Every Audio Lab node needs a stable id.');
  if (candidate.kind !== 'fragment') {
    throw new AudioLabModelError('invalid-node-kind', `Node ${id} must be a root or fragment.`);
  }
  const parentNodeId = requiredId(
    candidate.parentNodeId,
    'invalid-parent-id',
    `Fragment ${id} needs a parent node id.`,
  );
  if (!isPlainObject(candidate.range)) {
    throw new AudioLabModelError('invalid-range', `Fragment ${id} needs a relative range.`);
  }
  const start = candidate.range.start;
  const end = candidate.range.end;
  if (
    typeof start !== 'number'
    || typeof end !== 'number'
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || end <= start
  ) {
    throw new AudioLabModelError('invalid-range', `Fragment ${id} has an invalid relative range.`);
  }
  if (end - start + RANGE_EPSILON < AUDIO_LAB_MIN_FRAGMENT_SECONDS) {
    throw new AudioLabModelError(
      'fragment-too-short',
      `Fragment ${id} must last at least ${AUDIO_LAB_MIN_FRAGMENT_SECONDS} seconds.`,
    );
  }

  return freezeFragment({
    id,
    kind: 'fragment',
    parentNodeId,
    label: optionalText(candidate.label) || 'Fragmento',
    range: { start, end },
  });
}

function nodeDuration(node) {
  return node.kind === 'root' ? node.duration : node.range.end - node.range.start;
}

function nodeMapOf(state) {
  return new Map(state.nodes.map((node) => [node.id, node]));
}

function requireNode(state, nodeId) {
  const id = requiredId(nodeId, 'invalid-node-id', 'Audio Lab needs a node id.');
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new AudioLabModelError('node-not-found', `Audio Lab node ${id} does not exist.`);
  return node;
}

function validateParentChains(nodes, root) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (node.kind === 'root') continue;
    if (!byId.has(node.parentNodeId)) {
      throw new AudioLabModelError(
        'parent-not-found',
        `Fragment ${node.id} points to missing parent ${node.parentNodeId}.`,
      );
    }
  }

  for (const node of nodes) {
    const path = new Set();
    let cursor = node;
    while (cursor.kind !== 'root') {
      if (path.has(cursor.id)) {
        throw new AudioLabModelError('cyclic-graph', `Audio Lab contains a cycle at ${cursor.id}.`);
      }
      path.add(cursor.id);
      cursor = byId.get(cursor.parentNodeId);
    }
    if (cursor.id !== root.id) {
      throw new AudioLabModelError('disconnected-node', `Node ${node.id} is disconnected from the root.`);
    }
  }

  for (const node of nodes) {
    if (node.kind === 'root') continue;
    const parent = byId.get(node.parentNodeId);
    const parentDuration = nodeDuration(parent);
    if (node.range.end > parentDuration + RANGE_EPSILON) {
      throw new AudioLabModelError(
        'range-out-of-bounds',
        `Fragment ${node.id} ends outside its parent ${parent.id}.`,
      );
    }
  }
}

export class AudioLabModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AudioLabModelError';
    this.code = code;
  }
}

/**
 * Strictly validate and freeze a JSON-shaped Audio Lab graph. Node order is
 * preserved and does not need to be topological, which keeps persistence free
 * to restore records in storage order.
 */
export function validateAudioLabState(candidate) {
  if (!isPlainObject(candidate)) {
    throw new AudioLabModelError('invalid-state', 'Audio Lab state must be a plain object.');
  }
  if (candidate.schemaVersion !== AUDIO_LAB_SCHEMA_VERSION) {
    throw new AudioLabModelError(
      'unsupported-schema',
      `Audio Lab schema ${candidate.schemaVersion ?? '(missing)'} is not supported.`,
    );
  }
  if (!Array.isArray(candidate.nodes) || !candidate.nodes.length) {
    throw new AudioLabModelError('missing-root', 'Audio Lab needs exactly one root node.');
  }

  const nodes = candidate.nodes.map((node) => {
    if (!isPlainObject(node)) {
      throw new AudioLabModelError('invalid-node', 'Every Audio Lab node must be a plain object.');
    }
    if (node.kind === 'root') return canonicalRoot(node);
    if (node.kind === 'fragment') return canonicalFragment(node);
    const id = typeof node.id === 'string' && node.id ? node.id : '(unknown)';
    throw new AudioLabModelError('invalid-node-kind', `Node ${id} must be a root or fragment.`);
  });

  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new AudioLabModelError('duplicate-node-id', `Audio Lab node id ${node.id} is repeated.`);
    }
    ids.add(node.id);
  }

  const roots = nodes.filter((node) => node.kind === 'root');
  if (roots.length !== 1) {
    throw new AudioLabModelError('invalid-root-count', 'Audio Lab needs exactly one root node.');
  }
  const root = roots[0];
  const rootNodeId = requiredId(
    candidate.rootNodeId,
    'invalid-root-id',
    'Audio Lab needs a root node id.',
  );
  if (root.id !== rootNodeId) {
    throw new AudioLabModelError('root-id-mismatch', 'Audio Lab rootNodeId does not identify its root node.');
  }

  validateParentChains(nodes, root);

  const selectedNodeId = requiredId(
    candidate.selectedNodeId,
    'invalid-selection',
    'Audio Lab needs a selected node id.',
  );
  if (!ids.has(selectedNodeId)) {
    throw new AudioLabModelError('selection-not-found', `Selected Audio Lab node ${selectedNodeId} does not exist.`);
  }

  return freezeState({ rootNodeId, selectedNodeId, nodes });
}

/** Create an empty Audio Lab graph tied to one exact generated output. */
export function createAudioLabState(source, { makeId = defaultMakeId } = {}) {
  if (!isPlainObject(source)) {
    throw new AudioLabModelError('invalid-source', 'Audio Lab needs a source output descriptor.');
  }
  if (source.outputId !== undefined && source.id !== undefined && source.outputId !== source.id) {
    throw new AudioLabModelError('conflicting-output-id', 'Audio Lab received two different source output ids.');
  }

  const rootNodeId = generatedId(makeId, 'audio-root');
  const root = {
    id: rootNodeId,
    kind: 'root',
    parentNodeId: null,
    outputId: source.outputId ?? source.id,
    projectId: source.projectId ?? null,
    resultId: source.resultId ?? null,
    name: source.name ?? 'Audio original',
    type: source.type ?? source.mediaType ?? null,
    size: source.size ?? source.blob?.size ?? null,
    duration: source.duration,
  };

  return validateAudioLabState({
    schemaVersion: AUDIO_LAB_SCHEMA_VERSION,
    rootNodeId,
    selectedNodeId: rootNodeId,
    nodes: [root],
  });
}

/**
 * Add and select a virtual fragment. `start` and `end` are seconds relative to
 * its parent, not the root; no Blob or byte buffer is copied.
 */
export function createAudioLabFragment(
  state,
  {
    parentNodeId = state?.selectedNodeId,
    start,
    end,
    label = null,
  } = {},
  { makeId = defaultMakeId } = {},
) {
  const current = validateAudioLabState(state);
  requireNode(current, parentNodeId);
  const id = generatedId(makeId, 'audio-fragment');
  const fragmentCount = current.nodes.filter((node) => node.kind === 'fragment').length;
  const fragment = {
    id,
    kind: 'fragment',
    parentNodeId,
    label: label ?? `Fragmento ${fragmentCount + 1}`,
    range: { start, end },
  };

  return validateAudioLabState({
    schemaVersion: AUDIO_LAB_SCHEMA_VERSION,
    rootNodeId: current.rootNodeId,
    selectedNodeId: id,
    nodes: [...current.nodes, fragment],
  });
}

/** Select any existing root or fragment without mutating the graph. */
export function selectAudioLabNode(state, nodeId) {
  const current = validateAudioLabState(state);
  const node = requireNode(current, nodeId);
  if (node.id === current.selectedNodeId) return current;
  return freezeState({
    rootNodeId: current.rootNodeId,
    selectedNodeId: node.id,
    nodes: current.nodes,
  });
}

/** Root-to-node lineage for breadcrumbs and hierarchical navigation. */
export function audioLabLineage(state, nodeId = state?.selectedNodeId) {
  const current = validateAudioLabState(state);
  const byId = nodeMapOf(current);
  let cursor = requireNode(current, nodeId);
  const lineage = [];
  while (cursor) {
    lineage.push(cursor);
    cursor = cursor.kind === 'root' ? null : byId.get(cursor.parentNodeId);
  }
  return Object.freeze(lineage.reverse());
}

/** Resolve a node's virtual nesting to seconds on the exact root output. */
export function resolveAudioLabRange(state, nodeId = state?.selectedNodeId) {
  const lineage = audioLabLineage(state, nodeId);
  const root = lineage[0];
  let start = 0;
  let end = root.duration;

  for (const node of lineage.slice(1)) {
    const parentStart = start;
    start = parentStart + node.range.start;
    end = parentStart + node.range.end;
  }

  return Object.freeze({ start, end, duration: end - start });
}

/** Compact display projection, ordered from the source through the selection. */
export function audioLabBreadcrumbs(state, nodeId = state?.selectedNodeId) {
  return Object.freeze(audioLabLineage(state, nodeId).map((node, depth) => Object.freeze({
    id: node.id,
    kind: node.kind,
    label: node.kind === 'root' ? node.name : node.label,
    depth,
    duration: nodeDuration(node),
  })));
}

/**
 * Byte-free handoff for playback or FFmpeg. The caller resolves `outputId` in
 * the result repository, then applies the absolute root range exactly once.
 */
export function audioLabSourceDescriptor(state, nodeId = state?.selectedNodeId) {
  const current = validateAudioLabState(state);
  const node = requireNode(current, nodeId);
  const root = requireNode(current, current.rootNodeId);
  const lineage = audioLabLineage(current, node.id);
  const range = resolveAudioLabRange(current, node.id);
  const relativeRange = node.kind === 'root'
    ? Object.freeze({ start: 0, end: root.duration, duration: root.duration })
    : Object.freeze({
      start: node.range.start,
      end: node.range.end,
      duration: nodeDuration(node),
    });

  return Object.freeze({
    outputId: root.outputId,
    projectId: root.projectId,
    resultId: root.resultId,
    rootNodeId: root.id,
    nodeId: node.id,
    parentNodeId: node.parentNodeId,
    name: root.name,
    type: root.type,
    size: root.size,
    rootDuration: root.duration,
    range,
    relativeRange,
    lineageNodeIds: Object.freeze(lineage.map((entry) => entry.id)),
  });
}

/** Remove a fragment and every descendant, retaining the nearest parent focus. */
export function removeAudioLabBranch(state, nodeId) {
  const current = validateAudioLabState(state);
  const target = requireNode(current, nodeId);
  if (target.kind === 'root') {
    throw new AudioLabModelError('cannot-delete-root', 'The Audio Lab root cannot be deleted.');
  }

  const removedIds = new Set([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of current.nodes) {
      if (node.kind === 'fragment' && removedIds.has(node.parentNodeId) && !removedIds.has(node.id)) {
        removedIds.add(node.id);
        changed = true;
      }
    }
  }

  return freezeState({
    rootNodeId: current.rootNodeId,
    selectedNodeId: removedIds.has(current.selectedNodeId)
      ? target.parentNodeId
      : current.selectedNodeId,
    nodes: Object.freeze(current.nodes.filter((node) => !removedIds.has(node.id))),
  });
}

/** JSON-only state for IndexedDB/local persistence; media bytes stay elsewhere. */
export function audioLabManifest(state) {
  const current = validateAudioLabState(state);
  return {
    schemaVersion: AUDIO_LAB_SCHEMA_VERSION,
    rootNodeId: current.rootNodeId,
    selectedNodeId: current.selectedNodeId,
    nodes: current.nodes.map((node) => (
      node.kind === 'root'
        ? {
          id: node.id,
          kind: 'root',
          parentNodeId: null,
          outputId: node.outputId,
          projectId: node.projectId,
          resultId: node.resultId,
          name: node.name,
          type: node.type,
          size: node.size,
          duration: node.duration,
        }
        : {
          id: node.id,
          kind: 'fragment',
          parentNodeId: node.parentNodeId,
          label: node.label,
          range: { start: node.range.start, end: node.range.end },
        }
    )),
  };
}

/** Restore, validate and deeply freeze one persisted Audio Lab manifest. */
export function restoreAudioLabState(manifest) {
  return validateAudioLabState(manifest);
}
