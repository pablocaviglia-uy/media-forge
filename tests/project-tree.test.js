import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectTree } from '../src/media/project-tree.js';

const source = {
  name: 'concert.mp4',
  size: 10_000,
  type: 'video/mp4',
  info: { duration: 60, video: { width: 1920, height: 1080 } },
};

const results = [
  {
    id: 'old',
    downloadName: 'concert-128.mp3',
    totalSize: 1_000,
    mediaKind: 'audio',
    operation: 'extract-audio',
    createdAt: 1,
    metadata: { duration: 60, format: 'MP3' },
    outputs: [{ name: 'concert-128.mp3', blob: new Blob(['old'], { type: 'audio/mpeg' }) }],
  },
  {
    id: 'new',
    downloadName: 'concert-192.mp3',
    totalSize: 2_000,
    mediaKind: 'audio',
    operation: 'extract-audio',
    createdAt: 2,
    metadata: { duration: 60, format: 'MP3' },
    outputs: [{ name: 'concert-192.mp3', blob: new Blob(['new'], { type: 'audio/mpeg' }) }],
  },
];

test('a project tree keeps the original as a stable parent', () => {
  const tree = buildProjectTree({ projectId: 'project-1', source, results });

  assert.equal(tree.source.id, 'source:project-1');
  assert.equal(tree.source.name, 'concert.mp4');
  assert.equal(tree.source.mediaKind, 'video');
  assert.deepEqual(tree.source.metadata, {
    duration: 60,
    width: 1920,
    height: 1080,
    format: 'video/mp4',
  });
  assert.equal(tree.resultCount, 2);
});

test('generated children are newest first and retain their result ids', () => {
  const tree = buildProjectTree({ projectId: 'project-1', source, results });

  assert.deepEqual(tree.children.map((node) => node.resultId), ['new', 'old']);
  assert.deepEqual(tree.children.map((node) => node.name), ['concert-192.mp3', 'concert-128.mp3']);
  assert.equal(tree.children[0].mediaKind, 'audio');
  assert.equal(tree.children[0].metadata.format, 'MP3');
});

test('source and result selection never masquerade as each other', () => {
  const sourceView = buildProjectTree({
    projectId: 'project-1', source, results, selectedResultId: 'new', previewMode: 'source',
  });
  assert.equal(sourceView.source.current, true);
  assert.equal(sourceView.children.some((node) => node.current), false);
  assert.equal(sourceView.activeNodeId, 'source:project-1');

  const resultView = buildProjectTree({
    projectId: 'project-1', source, results, selectedResultId: 'old', previewMode: 'result',
  });
  assert.equal(resultView.source.current, false);
  assert.equal(resultView.children.find((node) => node.resultId === 'old').current, true);
  assert.equal(resultView.activeNodeId, 'result:old');
});

test('an invalid selected result falls back to the original node', () => {
  const tree = buildProjectTree({
    projectId: 'project-1', source, results, selectedResultId: 'missing', previewMode: 'result',
  });
  assert.equal(tree.activeNodeId, 'source:project-1');
  assert.equal(tree.children.some((node) => node.current), false);
});

test('the tree works before the first generation exists', () => {
  const tree = buildProjectTree({ projectId: 'project-1', source });
  assert.equal(tree.resultCount, 0);
  assert.deepEqual(tree.children, []);
  assert.equal(tree.activeNodeId, 'source:project-1');
});
