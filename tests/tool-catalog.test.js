import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_CATALOG,
  getToolById,
  listTools,
  searchTools,
} from '../src/catalog/tool-catalog.js';

const EXPECTED_AVAILABLE = [
  'audio-converter',
  'audio-trim',
  'video-add-audio',
  'video-converter',
  'video-crop',
  'video-flip',
  'video-loop',
  'video-merge',
  'video-resize',
  'video-rotate',
  'video-speed',
  'video-trim',
  'video-volume',
];

test('the canonical catalogue contains exactly 55 unique tools', () => {
  assert.equal(TOOL_CATALOG.length, 55);
  assert.equal(new Set(TOOL_CATALOG.map((tool) => tool.id)).size, 55);
});

test('catalogue totals match the approved category and extra map', () => {
  const count = (category) => TOOL_CATALOG.filter((tool) => tool.category === category).length;

  assert.deepEqual({
    video: count('video'),
    audio: count('audio'),
    pdf: count('pdf'),
    convert: count('convert'),
  }, {
    video: 19,
    audio: 10,
    pdf: 18,
    convert: 8,
  });
  assert.equal(TOOL_CATALOG.filter((tool) => tool.extra).length, 4);
});

test('every tool has Spanish copy, localized routes and execution metadata', () => {
  const validWorkspaces = new Set(['quick', 'studio', 'documents', 'batch']);
  const validModes = new Set(['L', 'HL', 'HR', 'R']);
  const validAvailability = new Set(['available', 'planned']);

  for (const tool of TOOL_CATALOG) {
    assert.match(tool.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${tool.id} is not a stable id`);
    assert.ok(tool.name.length > 0, `${tool.id} has no Spanish name`);
    assert.ok(tool.description.length > 0, `${tool.id} has no Spanish description`);
    assert.ok(validWorkspaces.has(tool.workspace), `${tool.id} has an unknown workspace`);
    assert.ok(validModes.has(tool.mode), `${tool.id} has an unknown execution mode`);
    assert.ok(validAvailability.has(tool.availability), `${tool.id} has an unknown availability`);
    assert.match(tool.route.es, /^\/es\/(?:video|audio|pdf|convertir)\/[a-z0-9-]+$/, `${tool.id} has an invalid ES route`);
    assert.match(tool.route.en, /^\/en\/(?:video|audio|pdf|convert)\/[a-z0-9-]+$/, `${tool.id} has an invalid EN route`);
    assert.equal(tool.route.es.endsWith(`/${tool.slug.es}`), true, `${tool.id} has a mismatched ES slug`);
    assert.equal(tool.route.en.endsWith(`/${tool.slug.en}`), true, `${tool.id} has a mismatched EN slug`);
    assert.ok(tool.implementation.key.length > 0, `${tool.id} has no implementation key`);
    assert.ok(tool.implementation.preset.length > 0, `${tool.id} has no preset`);
    assert.ok(tool.implementation.engines.length > 0, `${tool.id} has no engine`);
  }
});

test('localized routes are unique within each locale', () => {
  for (const locale of ['es', 'en']) {
    const routes = TOOL_CATALOG.map((tool) => tool.route[locale]);
    assert.equal(new Set(routes).size, routes.length, `${locale} contains a duplicate route`);
  }
});

test('only honest entry points backed by the current local engine are available', () => {
  const available = TOOL_CATALOG
    .filter((tool) => tool.availability === 'available')
    .map((tool) => tool.id)
    .sort();

  assert.deepEqual(available, EXPECTED_AVAILABLE);
  assert.equal(TOOL_CATALOG.filter((tool) => tool.availability === 'planned').length, 42);
});

test('lookup and listing helpers return canonical entries', () => {
  assert.equal(getToolById('video-trim'), TOOL_CATALOG.find((tool) => tool.id === 'video-trim'));
  assert.equal(getToolById('missing-tool'), null);
  assert.equal(listTools(), TOOL_CATALOG);
  assert.equal(listTools({ workspace: 'documents' }).length, 18);
  assert.deepEqual(
    listTools({ category: 'convert', availability: 'available' }).map((tool) => tool.id).sort(),
    ['audio-converter', 'video-converter'],
  );
});

test('search is accent-insensitive, uses synonyms and respects filters', () => {
  assert.ok(searchTools('edicion').some((tool) => tool.id === 'video-editor'));
  assert.ok(searchTools('karaoke').some((tool) => tool.id === 'audio-vocal-separation'));
  assert.ok(searchTools('/es/pdf/combinar').some((tool) => tool.id === 'pdf-merge'));
  assert.deepEqual(
    searchTools('girar', { workspace: 'quick' }).map((tool) => tool.id),
    ['video-rotate'],
  );
  assert.ok(searchTools('achicar PDFs').some((tool) => tool.id === 'pdf-compress'));
  assert.ok(searchTools('MOV a MP4').some((tool) => tool.id === 'video-converter'));
  assert.ok(searchTools('extraer audio').some((tool) => tool.id === 'audio-converter'));
});
