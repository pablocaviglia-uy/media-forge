import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_LAB_SCHEMA_VERSION,
  AUDIO_LAB_MIN_FRAGMENT_SECONDS,
  AudioLabModelError,
  validateAudioLabState,
  createAudioLabState,
  createAudioLabFragment,
  selectAudioLabNode,
  audioLabLineage,
  audioLabBreadcrumbs,
  resolveAudioLabRange,
  audioLabSourceDescriptor,
  removeAudioLabBranch,
  audioLabManifest,
  restoreAudioLabState,
} from '../src/media/audio-lab.js';

const idFactory = () => {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
};

const source = (overrides = {}) => ({
  outputId: 'output-exact-mix',
  projectId: 'project-video',
  resultId: 'result-mp3',
  name: 'concert.mp3',
  type: 'audio/mpeg',
  size: 4_981_175,
  duration: 207.491678,
  ...overrides,
});

const errorCode = (code) => (error) => (
  error instanceof AudioLabModelError && error.code === code
);

function graphWithNestedFragment() {
  const makeId = idFactory();
  const root = createAudioLabState(source({ duration: 120 }), { makeId });
  const first = createAudioLabFragment(root, {
    start: 20,
    end: 80,
    label: 'Solo',
  }, { makeId });
  return createAudioLabFragment(first, {
    start: 5,
    end: 15,
    label: 'Compás favorito',
  }, { makeId });
}

test('constants version the persisted graph and define a useful 10 ms minimum', () => {
  assert.equal(AUDIO_LAB_SCHEMA_VERSION, 1);
  assert.equal(AUDIO_LAB_MIN_FRAGMENT_SECONDS, 0.01);
});

test('createAudioLabState binds a frozen root to one exact output without retaining its Blob', () => {
  const blob = new Blob([new Uint8Array(1024 * 1024)], { type: 'audio/mpeg' });
  const state = createAudioLabState({
    ...source({ size: blob.size }),
    blob,
  });
  const root = state.nodes[0];

  assert.match(root.id, /^audio-root-/);
  assert.equal(state.rootNodeId, root.id);
  assert.equal(state.selectedNodeId, root.id);
  assert.equal(root.outputId, 'output-exact-mix');
  assert.equal(root.duration, 207.491678);
  assert.equal(root.size, blob.size);
  assert.equal(Object.hasOwn(root, 'blob'), false);
  assert.equal(Object.hasOwn(state, 'blob'), false);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.nodes));
  assert.ok(Object.isFrozen(root));
  assert.throws(() => state.nodes.push({}), TypeError);
});

test('a source output descriptor may use its canonical id field', () => {
  const state = createAudioLabState({
    id: 'output-from-result-model',
    duration: 3,
    name: 'clip.wav',
  }, { makeId: idFactory() });
  assert.equal(state.nodes[0].outputId, 'output-from-result-model');
});

test('source validation rejects ambiguous ids, invalid duration and invalid scalar metadata', () => {
  assert.throws(
    () => createAudioLabState(null),
    errorCode('invalid-source'),
  );
  assert.throws(
    () => createAudioLabState(source({ outputId: '' })),
    errorCode('invalid-output-id'),
  );
  assert.throws(
    () => createAudioLabState({ ...source(), id: 'another-output' }),
    errorCode('conflicting-output-id'),
  );
  assert.throws(
    () => createAudioLabState(source({ duration: 0 })),
    errorCode('invalid-duration'),
  );
  assert.throws(
    () => createAudioLabState(source({ duration: Number.NaN })),
    errorCode('invalid-duration'),
  );
  assert.throws(
    () => createAudioLabState(source({ size: -1 })),
    errorCode('invalid-size'),
  );
});

test('createAudioLabFragment stores a parent-relative range, selects it and leaves prior state unchanged', () => {
  const makeId = idFactory();
  const rootState = createAudioLabState(source({ duration: 60 }), { makeId });
  const fragmentState = createAudioLabFragment(rootState, {
    start: 12.5,
    end: 31.75,
    label: 'Estribillo',
  }, { makeId });
  const fragment = fragmentState.nodes[1];

  assert.equal(rootState.nodes.length, 1);
  assert.equal(rootState.selectedNodeId, rootState.rootNodeId);
  assert.equal(fragment.id, 'audio-fragment-2');
  assert.equal(fragment.parentNodeId, rootState.rootNodeId);
  assert.deepEqual(fragment.range, { start: 12.5, end: 31.75 });
  assert.equal(fragment.label, 'Estribillo');
  assert.equal(fragmentState.selectedNodeId, fragment.id);
  assert.ok(Object.isFrozen(fragmentState));
  assert.ok(Object.isFrozen(fragment));
  assert.ok(Object.isFrozen(fragment.range));
});

test('fragment creation defaults to the selected node and supports a fragment inside a fragment', () => {
  const state = graphWithNestedFragment();
  const [root, parent, child] = state.nodes;

  assert.equal(parent.parentNodeId, root.id);
  assert.equal(child.parentNodeId, parent.id);
  assert.equal(state.selectedNodeId, child.id);
  assert.deepEqual(resolveAudioLabRange(state, parent.id), {
    start: 20,
    end: 80,
    duration: 60,
  });
  assert.deepEqual(resolveAudioLabRange(state), {
    start: 25,
    end: 35,
    duration: 10,
  });
});

test('lineage and breadcrumbs describe nested navigation from root to selection', () => {
  const state = graphWithNestedFragment();
  const lineage = audioLabLineage(state);
  const breadcrumbs = audioLabBreadcrumbs(state);

  assert.deepEqual(lineage.map((node) => node.id), [
    'audio-root-1',
    'audio-fragment-2',
    'audio-fragment-3',
  ]);
  assert.deepEqual(breadcrumbs, [
    { id: 'audio-root-1', kind: 'root', label: 'concert.mp3', depth: 0, duration: 120 },
    { id: 'audio-fragment-2', kind: 'fragment', label: 'Solo', depth: 1, duration: 60 },
    { id: 'audio-fragment-3', kind: 'fragment', label: 'Compás favorito', depth: 2, duration: 10 },
  ]);
  assert.ok(Object.isFrozen(lineage));
  assert.ok(Object.isFrozen(breadcrumbs));
  assert.ok(breadcrumbs.every(Object.isFrozen));
});

test('processing descriptor resolves the exact root output and one absolute trim range', () => {
  const state = graphWithNestedFragment();
  const descriptor = audioLabSourceDescriptor(state);

  assert.deepEqual(descriptor, {
    outputId: 'output-exact-mix',
    projectId: 'project-video',
    resultId: 'result-mp3',
    rootNodeId: 'audio-root-1',
    nodeId: 'audio-fragment-3',
    parentNodeId: 'audio-fragment-2',
    name: 'concert.mp3',
    type: 'audio/mpeg',
    size: 4_981_175,
    rootDuration: 120,
    range: { start: 25, end: 35, duration: 10 },
    relativeRange: { start: 5, end: 15, duration: 10 },
    lineageNodeIds: ['audio-root-1', 'audio-fragment-2', 'audio-fragment-3'],
  });
  assert.equal(Object.hasOwn(descriptor, 'blob'), false);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.range));
  assert.ok(Object.isFrozen(descriptor.relativeRange));
  assert.ok(Object.isFrozen(descriptor.lineageNodeIds));

  const rootDescriptor = audioLabSourceDescriptor(state, state.rootNodeId);
  assert.deepEqual(rootDescriptor.range, { start: 0, end: 120, duration: 120 });
  assert.deepEqual(rootDescriptor.relativeRange, { start: 0, end: 120, duration: 120 });
});

test('selection is immutable and rejects unknown nodes', () => {
  const nested = graphWithNestedFragment();
  const selected = selectAudioLabNode(nested, nested.rootNodeId);

  assert.equal(nested.selectedNodeId, 'audio-fragment-3');
  assert.equal(selected.selectedNodeId, nested.rootNodeId);
  assert.deepEqual(selected.nodes, nested.nodes);
  assert.notEqual(selected, nested);
  assert.throws(
    () => selectAudioLabNode(nested, 'missing'),
    errorCode('node-not-found'),
  );
});

test('removing a branch deletes all descendants and moves selection to the nearest surviving parent', () => {
  const makeId = idFactory();
  let state = createAudioLabState(source({ duration: 120 }), { makeId });
  state = createAudioLabFragment(state, { start: 10, end: 70, label: 'Rama' }, { makeId });
  const branchId = state.selectedNodeId;
  state = createAudioLabFragment(state, { start: 5, end: 15, label: 'Nieto' }, { makeId });
  const descendantId = state.selectedNodeId;
  state = createAudioLabFragment(state, {
    parentNodeId: state.rootNodeId,
    start: 80,
    end: 100,
    label: 'Hermano',
  }, { makeId });
  state = selectAudioLabNode(state, descendantId);

  const pruned = removeAudioLabBranch(state, branchId);

  assert.deepEqual(pruned.nodes.map((node) => node.label || node.name), ['concert.mp3', 'Hermano']);
  assert.equal(pruned.selectedNodeId, pruned.rootNodeId);
  assert.equal(state.nodes.length, 4);
  assert.throws(
    () => removeAudioLabBranch(state, state.rootNodeId),
    errorCode('cannot-delete-root'),
  );
  assert.throws(
    () => removeAudioLabBranch(state, 'missing'),
    errorCode('node-not-found'),
  );
});

test('removing an unselected branch preserves the current selection', () => {
  const makeId = idFactory();
  let state = createAudioLabState(source({ duration: 30 }), { makeId });
  state = createAudioLabFragment(state, { start: 1, end: 5 }, { makeId });
  const removable = state.selectedNodeId;
  state = createAudioLabFragment(state, {
    parentNodeId: state.rootNodeId,
    start: 10,
    end: 20,
  }, { makeId });
  const retained = state.selectedNodeId;

  const pruned = removeAudioLabBranch(state, removable);
  assert.equal(pruned.selectedNodeId, retained);
  assert.deepEqual(pruned.nodes.map((node) => node.id), [state.rootNodeId, retained]);
});

test('manifest survives a JSON round trip without duplicating or serializing media bytes', () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  bytes[0] = 99;
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const makeId = idFactory();
  let state = createAudioLabState({
    ...source({ type: 'audio/wav', size: blob.size, duration: 12 }),
    blob,
    byteBuffer: bytes,
  }, { makeId });
  state = createAudioLabFragment(state, { start: 1, end: 8 }, { makeId });
  state = createAudioLabFragment(state, { start: 2, end: 4 }, { makeId });

  const manifest = audioLabManifest(state);
  const json = JSON.stringify(manifest);
  const restored = restoreAudioLabState(JSON.parse(json));

  assert.deepEqual(restored, state);
  assert.deepEqual(audioLabManifest(restored), manifest);
  assert.ok(json.length < 1_500, `manifest unexpectedly contains ${json.length} characters`);
  assert.equal(json.includes('blob'), false);
  assert.equal(json.includes('byteBuffer'), false);
  assert.equal(blob.size, 2 * 1024 * 1024);
});

test('fragment ranges enforce finite bounds and the minimum useful duration', () => {
  const root = createAudioLabState(source({ duration: 10 }), { makeId: idFactory() });
  const add = (range) => createAudioLabFragment(root, range, { makeId: idFactory() });

  assert.throws(() => add({ start: -1, end: 2 }), errorCode('invalid-range'));
  assert.throws(() => add({ start: 2, end: 2 }), errorCode('invalid-range'));
  assert.throws(() => add({ start: 2, end: Number.POSITIVE_INFINITY }), errorCode('invalid-range'));
  assert.throws(() => add({ start: 9, end: 10.001 }), errorCode('range-out-of-bounds'));
  assert.throws(() => add({ start: 1, end: 1.009 }), errorCode('fragment-too-short'));

  const minimum = add({ start: 1, end: 1.01 });
  assert.equal(minimum.nodes[1].range.end - minimum.nodes[1].range.start, 0.010000000000000009);
});

test('nested fragment bounds are relative to the immediate parent duration', () => {
  const makeId = idFactory();
  let state = createAudioLabState(source({ duration: 100 }), { makeId });
  state = createAudioLabFragment(state, { start: 30, end: 50 }, { makeId });

  assert.throws(
    () => createAudioLabFragment(state, { start: 15, end: 21 }, { makeId }),
    errorCode('range-out-of-bounds'),
  );
  const child = createAudioLabFragment(state, { start: 15, end: 20 }, { makeId });
  assert.deepEqual(resolveAudioLabRange(child), { start: 45, end: 50, duration: 5 });
});

test('strict restoration rejects duplicate ids, missing parents and cycles', () => {
  const base = audioLabManifest(createAudioLabState(source({ duration: 30 }), { makeId: idFactory() }));
  const fragment = (id, parentNodeId, start = 0, end = 5) => ({
    id,
    kind: 'fragment',
    parentNodeId,
    label: id,
    range: { start, end },
  });

  assert.throws(
    () => restoreAudioLabState({
      ...base,
      nodes: [...base.nodes, fragment(base.rootNodeId, base.rootNodeId)],
    }),
    errorCode('duplicate-node-id'),
  );
  assert.throws(
    () => restoreAudioLabState({
      ...base,
      nodes: [...base.nodes, fragment('orphan', 'missing')],
      selectedNodeId: 'orphan',
    }),
    errorCode('parent-not-found'),
  );
  assert.throws(
    () => restoreAudioLabState({
      ...base,
      nodes: [
        ...base.nodes,
        fragment('cycle-a', 'cycle-b'),
        fragment('cycle-b', 'cycle-a'),
      ],
      selectedNodeId: 'cycle-a',
    }),
    errorCode('cyclic-graph'),
  );
});

test('strict restoration rejects malformed root identity and selection', () => {
  const base = audioLabManifest(createAudioLabState(source({ duration: 30 }), { makeId: idFactory() }));

  assert.throws(
    () => validateAudioLabState({ ...base, schemaVersion: 99 }),
    errorCode('unsupported-schema'),
  );
  assert.throws(
    () => validateAudioLabState({ ...base, rootNodeId: 'missing' }),
    errorCode('root-id-mismatch'),
  );
  assert.throws(
    () => validateAudioLabState({ ...base, selectedNodeId: 'missing' }),
    errorCode('selection-not-found'),
  );
  assert.throws(
    () => validateAudioLabState({ ...base, selectedNodeId: '' }),
    errorCode('invalid-selection'),
  );
  assert.throws(
    () => validateAudioLabState({
      ...base,
      nodes: [...base.nodes, { ...base.nodes[0], id: 'second-root' }],
    }),
    errorCode('invalid-root-count'),
  );
});

test('restoration accepts non-topological storage order after validating the graph', () => {
  const state = graphWithNestedFragment();
  const manifest = audioLabManifest(state);
  manifest.nodes = [manifest.nodes[2], manifest.nodes[0], manifest.nodes[1]];

  const restored = restoreAudioLabState(manifest);
  assert.deepEqual(resolveAudioLabRange(restored), { start: 25, end: 35, duration: 10 });
  assert.deepEqual(restored.nodes.map((node) => node.id), [
    'audio-fragment-3',
    'audio-root-1',
    'audio-fragment-2',
  ]);
});

test('a colliding id factory cannot create an invalid graph', () => {
  const state = createAudioLabState(source({ duration: 10 }), {
    makeId: () => 'same-id',
  });
  assert.throws(
    () => createAudioLabFragment(state, { start: 0, end: 1 }, {
      makeId: () => 'same-id',
    }),
    errorCode('duplicate-node-id'),
  );
});
