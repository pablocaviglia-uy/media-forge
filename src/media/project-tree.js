/**
 * A compact, read-only projection of one media project.
 *
 * The queue used to flatten a project into a single row. Once that project
 * produced an output, the row still carried the source name while its size and
 * status described the output — which made the two files feel unrelated. This
 * module keeps the relationship explicit without changing the persistence
 * model:
 *
 *   source -> generated result -> generated result
 *
 * Results are newest first because the project history and result viewer use
 * that order. The source is always a separate, stable node and can therefore
 * remain navigable while any result is selected.
 */

import { mediaKindOf } from './results.js';

const finite = (value) => {
  if (value === null || value === undefined || value === '' || value === 'N/A') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const text = (value, fallback = '') => {
  const normalized = value === null || value === undefined ? '' : String(value).trim();
  return normalized || fallback;
};

function sourceMetadata(source) {
  const info = source?.info || {};
  return Object.freeze({
    duration: finite(info.duration),
    width: finite(info.video?.width),
    height: finite(info.video?.height),
    format: text(info.extension || info.format || source?.type),
  });
}

function resultMetadata(result) {
  const metadata = result?.metadata || {};
  return Object.freeze({
    duration: finite(metadata.duration),
    width: finite(metadata.width),
    height: finite(metadata.height),
    format: text(metadata.format),
  });
}

/**
 * @param {{
 *   projectId: string,
 *   source: object,
 *   results?: object[],
 *   selectedResultId?: string|null,
 *   previewMode?: 'source'|'result',
 * }} input
 */
export function buildProjectTree({
  projectId,
  source,
  results = [],
  selectedResultId = null,
  previewMode = 'source',
} = {}) {
  const id = text(projectId);
  if (!id) throw new TypeError('A project tree needs a project id.');

  const normalizedSelectedResultId = text(selectedResultId);
  const resultMode = previewMode === 'result' && results.some(
    (result) => text(result?.id) === normalizedSelectedResultId,
  );
  const sourceName = text(source?.name, 'Archivo original');
  const sourceNode = Object.freeze({
    id: `source:${id}`,
    projectId: id,
    type: 'source',
    name: sourceName,
    size: finite(source?.size) || 0,
    mediaKind: mediaKindOf(source || {}),
    metadata: sourceMetadata(source),
    current: !resultMode,
  });

  const children = [...results].reverse().map((result) => {
    const resultId = text(result?.id);
    const output = Array.isArray(result?.outputs) && result.outputs.length === 1
      ? result.outputs[0]
      : null;
    return Object.freeze({
      id: `result:${resultId}`,
      projectId: id,
      type: 'result',
      resultId,
      name: text(result?.downloadName || output?.name, 'Resultado generado'),
      size: finite(result?.totalSize) || finite(output?.blob?.size) || 0,
      mediaKind: text(result?.mediaKind, mediaKindOf(output || result || {})),
      metadata: resultMetadata(result),
      operation: text(result?.operation),
      createdAt: finite(result?.createdAt),
      current: resultMode && resultId === normalizedSelectedResultId,
    });
  });

  const active = children.find((node) => node.current) || sourceNode;
  return Object.freeze({
    projectId: id,
    source: sourceNode,
    children: Object.freeze(children),
    resultCount: children.length,
    activeNodeId: active.id,
  });
}
