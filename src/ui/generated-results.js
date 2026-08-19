/**
 * A self-contained, local-first result surface.
 *
 * The application owns project/output persistence. This component owns the
 * presentation of one source and all the files derived from it: active media
 * playback, metadata, selection and result actions. Object URLs created from
 * result Blobs are revoked on update/destroy; caller-provided URLs remain the
 * caller's responsibility.
 */

import { el, formatBitrate, formatBytes, formatDuration, on, truncateName } from './dom.js';

let nextGeneratedResultsId = 1;

const AUDIO_EXTENSIONS = new Set(['aac', 'aiff', 'alac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm']);
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp']);

const MEDIA_KIND_LABELS = Object.freeze({
  audio: 'Audio',
  video: 'Video',
  image: 'Imagen',
  file: 'Archivo',
});

const MEDIA_KIND_ICONS = Object.freeze({
  audio: '♫',
  video: '▶',
  image: '▧',
  file: '↓',
});

const OPERATION_LABELS = Object.freeze({
  convert: 'Conversión',
  'extract-audio': 'Audio extraído',
  'extract-frames': 'Fotogramas extraídos',
  'join-videos': 'Videos unidos',
  'add-audio': 'Audio agregado',
  trim: 'Recorte exportado',
  crop: 'Encuadre exportado',
});

const finitePositive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const extensionOf = (name) => {
  const match = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match?.[1] || '';
};

const primaryOutputOf = (result) => (
  Array.isArray(result?.outputs) && result.outputs.length ? result.outputs[0] : result
);

const blobOf = (result) => result?.blob || primaryOutputOf(result)?.blob || null;

const mimeOf = (result) => String(
  result?.mime
  || result?.type
  || blobOf(result)?.type
  || primaryOutputOf(result)?.mime
  || primaryOutputOf(result)?.type
  || result?.metadata?.mime
  || result?.info?.mime
  || ''
).toLowerCase().split(';')[0].trim();

/** Infer the browser preview family without depending on a populated Blob type. */
export function generatedMediaKind(result = {}) {
  const output = primaryOutputOf(result);
  const explicit = String(result.kind || result.mediaKind || output?.kind || output?.mediaKind || '').toLowerCase();
  if (['audio', 'video', 'image', 'file'].includes(explicit)) return explicit;
  if (['archive', 'mixed'].includes(explicit)) return 'file';

  const mime = mimeOf(result);
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';

  const extension = extensionOf(result.name || result.downloadName || output?.name || result.url || output?.url);
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'file';
}

/** Normalized metadata used by both the hero and compact history rows. */
export function generatedResultMetadata(result = {}) {
  const kind = generatedMediaKind(result);
  const metadata = result.metadata || {};
  const info = result.info || {};
  const stream = kind === 'audio' ? (info.audio || {}) : (info.video || {});
  const extension = extensionOf(result.name || result.downloadName || primaryOutputOf(result)?.name);
  const rawFormat = result.format || metadata.format || info.formatLabel || extension;
  const format = String(rawFormat || MEDIA_KIND_LABELS[kind]).toUpperCase();
  const size = finitePositive(result.size ?? result.totalSize ?? blobOf(result)?.size ?? metadata.size);
  const duration = finitePositive(result.duration ?? metadata.duration ?? info.duration ?? stream.duration);
  const width = finitePositive(result.width ?? metadata.width ?? info.video?.width);
  const height = finitePositive(result.height ?? metadata.height ?? info.video?.height);
  const codec = String(result.codec || metadata.codec || stream.codec || '').toUpperCase();
  const bitrate = finitePositive(result.bitrate ?? metadata.bitrate ?? stream.bitrate ?? info.bitrate);
  const channels = finitePositive(result.channels ?? metadata.channels ?? info.audio?.channels);
  const sampleRate = finitePositive(result.sampleRate ?? metadata.sampleRate ?? info.audio?.sampleRate);

  return Object.freeze({
    kind,
    mime: mimeOf(result),
    format,
    size,
    duration,
    width,
    height,
    codec,
    bitrate,
    channels,
    sampleRate,
  });
}

/** Label/value facts, intentionally stable enough to render or unit test. */
export function generatedResultFacts(result = {}) {
  const metadata = generatedResultMetadata(result);
  const facts = [{ key: 'format', label: 'Formato', value: metadata.format }];
  if (metadata.size) facts.push({ key: 'size', label: 'Tamaño', value: formatBytes(metadata.size) });
  if (metadata.duration && ['audio', 'video'].includes(metadata.kind)) {
    facts.push({ key: 'duration', label: 'Duración', value: formatDuration(metadata.duration) });
  }
  if (metadata.width && metadata.height && ['image', 'video'].includes(metadata.kind)) {
    facts.push({ key: 'dimensions', label: 'Resolución', value: `${metadata.width}×${metadata.height}` });
  }
  if (metadata.bitrate && ['audio', 'video'].includes(metadata.kind)) {
    facts.push({ key: 'bitrate', label: 'Bitrate', value: formatBitrate(metadata.bitrate) });
  }
  if (metadata.codec && metadata.codec !== metadata.format) {
    facts.push({ key: 'codec', label: 'Códec', value: metadata.codec });
  }
  if (metadata.kind === 'audio' && metadata.channels) {
    const value = metadata.channels === 1 ? 'Mono' : metadata.channels === 2 ? 'Estéreo' : `${metadata.channels} canales`;
    facts.push({ key: 'channels', label: 'Canales', value });
  }
  if (metadata.kind === 'audio' && metadata.sampleRate) {
    const value = metadata.sampleRate >= 1000
      ? `${Number((metadata.sampleRate / 1000).toFixed(1))} kHz`
      : `${metadata.sampleRate} Hz`;
    facts.push({ key: 'sample-rate', label: 'Muestreo', value });
  }
  return facts;
}

/**
 * Add stable display ids while preserving the original result for callbacks.
 * Caller-provided ids are preferred; duplicate/missing ids receive a suffix.
 */
export function normalizeGeneratedResults(results = []) {
  const used = new Set();
  return (Array.isArray(results) ? results : []).filter(Boolean).map((result, index) => {
    const seed = String(result.id ?? result.name ?? `resultado-${index + 1}`);
    let id = seed;
    let suffix = 2;
    while (used.has(id)) id = `${seed}-${suffix++}`;
    used.add(id);
    return Object.freeze({
      ...result,
      id,
      name: String(result.name || result.downloadName || primaryOutputOf(result)?.name || `resultado-${index + 1}`),
      original: result,
      metadataView: generatedResultMetadata(result),
    });
  });
}

/** Selection policy shared with update(): explicit, current/fresh, then first. */
export function pickGeneratedResultId(results, preferredId = null) {
  const normalized = normalizeGeneratedResults(results);
  if (!normalized.length) return null;
  const preferred = preferredId == null ? null : String(preferredId);
  if (preferred && normalized.some((result) => result.id === preferred)) return preferred;
  return normalized.find((result) => result.current || result.fresh)?.id || normalized[0].id;
}

/**
 * Honest copy for the durability boundary. App may pass its existing
 * `projectStorageState` values (`saving`, `saved`, `error`, `off`). Unknown or
 * missing state is deliberately treated as session-only, never as persisted.
 */
export function generatedStorageStatus(value) {
  const state = String(value || '').toLowerCase();
  if (state === 'saved' || state === 'persisted') {
    return Object.freeze({
      state: 'persisted',
      badge: 'Guardado',
      title: 'Guardado en este navegador',
      message: 'Guardado en este dispositivo · no se subió a ningún servidor.',
    });
  }
  if (state === 'saving') {
    return Object.freeze({
      state: 'saving',
      badge: 'Guardando',
      title: 'Guardando en este navegador',
      message: 'Disponible en esta sesión mientras termina el guardado local.',
    });
  }
  if (state === 'error') {
    return Object.freeze({
      state: 'error',
      badge: 'Solo sesión',
      title: 'El guardado local necesita atención',
      message: 'Disponible en esta sesión. Descargalo antes de cerrar esta pestaña.',
    });
  }
  return Object.freeze({
    state: 'session',
    badge: 'Solo sesión',
    title: 'Disponible en esta sesión',
    message: 'Todavía no está guardado de forma persistente. Descargalo antes de cerrar esta pestaña.',
  });
}

function timestampLabel(value) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-UY', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function compactResultFacts(result) {
  const metadata = result.metadataView || generatedResultMetadata(result);
  const facts = [metadata.format];
  if (metadata.size) facts.push(formatBytes(metadata.size));
  if (metadata.duration && ['audio', 'video'].includes(metadata.kind)) facts.push(formatDuration(metadata.duration));
  const created = timestampLabel(result.createdAt || result.completedAt);
  if (created) facts.push(created);
  return facts.join(' · ');
}

function originFacts(source) {
  if (!source) return 'Archivo fuente';
  const metadata = generatedResultMetadata(source);
  const facts = [];
  if (metadata.size) facts.push(formatBytes(metadata.size));
  if (metadata.duration && ['audio', 'video'].includes(metadata.kind)) facts.push(formatDuration(metadata.duration));
  if (metadata.width && metadata.height && metadata.kind === 'video') facts.push(`${metadata.width}×${metadata.height}`);
  return facts.join(' · ') || 'Archivo fuente';
}

function resultStatusLabel(result) {
  if (result.stale || result.status === 'previous') return 'Resultado anterior';
  if (result.status === 'restored') return 'Resultado recuperado';
  return 'Resultado listo';
}

function operationLabel(operation) {
  const value = String(operation || '').trim();
  if (!value) return 'Archivo generado';
  return OPERATION_LABELS[value] || value.replaceAll('-', ' ');
}

function metadataGrid(result) {
  return el('dl', { class: 'generated-result-facts' }, generatedResultFacts(result).map((fact) =>
    el('div', { class: 'generated-result-fact', dataset: { fact: fact.key } }, [
      el('dt', { text: fact.label }),
      el('dd', { text: fact.value }),
    ])
  ));
}

function sourceNode(source, selectable = false) {
  const name = String(source?.name || 'Archivo original');
  const kind = generatedMediaKind(source || {});
  return el(selectable ? 'button' : 'div', {
    class: `generated-lineage-origin${selectable ? ' is-actionable' : ''}`,
    ...(selectable ? {
      type: 'button',
      dataset: { generatedAction: 'select-source' },
      title: `Abrir el archivo original: ${name}`,
      attrs: { 'aria-label': `Abrir el archivo original: ${name}` },
    } : {}),
  }, [
    el('span', { class: 'generated-lineage-icon', text: MEDIA_KIND_ICONS[kind], attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'generated-lineage-copy' }, [
      el('span', { text: 'Fuente' }),
      el('strong', { text: truncateName(name, 42), title: name }),
      el('small', { text: originFacts(source) }),
    ]),
    selectable ? el('span', { class: 'generated-lineage-source-action' }, [
      el('span', { text: 'Abrir original' }),
      el('span', { text: '←', attrs: { 'aria-hidden': 'true' } }),
    ]) : null,
  ]);
}

/**
 * @typedef {object} GeneratedResult
 * @property {string|number} [id] Stable id, strongly recommended.
 * @property {string} name Display and default download name.
 * @property {Blob} [blob] Local bytes. The component owns any URL it creates.
 * @property {Array<{name: string, blob: Blob, type?: string}>} [outputs] Optional generation shape; its first output is previewed.
 * @property {string} [url] Caller-owned media URL, used instead of `blob`.
 * @property {'audio'|'video'|'image'|'file'} [kind] Optional explicit preview family.
 * @property {string} [mime]
 * @property {number} [size]
 * @property {number} [duration] Seconds.
 * @property {object} [metadata] Optional width/height/codec/bitrate/channels/sampleRate.
 * @property {string|number|Date} [createdAt]
 * @property {boolean} [fresh] Marks the result that should become active.
 */

/**
 * @param {{
 *   source?: object|null,
 *   results?: GeneratedResult[],
 *   activeId?: string|number|null,
 *   title?: string,
 *   followLatest?: boolean,
 *   allowRemove?: boolean,
 *   storageStatus?: 'saving'|'saved'|'error'|'off'|'persisted'|'session',
 *   onSelectSource?: (source: object|null) => void,
 *   onSelect?: (result: GeneratedResult, context: {id: string, index: number}) => void,
 *   onDownload?: (result: GeneratedResult, context: {id: string, url: string|null, downloadName: string}) => void,
 *   onRemove?: (result: GeneratedResult, context: {id: string, index: number}) => void,
 *   onCreateAnother?: (source: object|null) => void,
 *   onMediaError?: (result: GeneratedResult) => void,
 *   onMediaEvent?: (type: 'play'|'pause'|'ended', result: GeneratedResult, media: HTMLMediaElement) => void,
 * }} options
 * @returns {{
 *   node: HTMLElement,
 *   update: (next: object) => void,
 *   select: (id: string|number, notify?: boolean) => void,
 *   getActiveId: () => string|null,
 *   focus: () => void,
 *   destroy: () => void,
 * }}
 */
export function createGeneratedResults(options = {}) {
  const instanceId = `generated-results-${nextGeneratedResultsId++}`;
  const titleId = `${instanceId}-title`;
  const liveId = `${instanceId}-live`;
  const root = el('section', {
    class: 'generated-results',
    dataset: { generatedResults: '' },
    attrs: { 'aria-labelledby': titleId },
  });
  const live = el('p', {
    id: liveId,
    class: 'sr-only',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  root.append(live);

  let config = {
    source: null,
    results: [],
    activeId: null,
    title: 'Tu resultado está listo',
    followLatest: true,
    allowRemove: true,
    storageStatus: 'session',
    ...options,
  };
  let results = normalizeGeneratedResults(config.results);
  let activeId = pickGeneratedResultId(results, config.activeId);
  let ownedUrls = new Set();
  let activeMedia = null;
  let destroyed = false;
  let lastVisualSignature = null;
  let lastActiveAsset = null;
  let lastStorageState = null;

  const resultById = (id) => results.find((result) => result.id === String(id));
  const resultIndex = (id) => results.findIndex((result) => result.id === String(id));
  const activeAsset = (result) => {
    const output = primaryOutputOf(result);
    return result?.url || output?.url || blobOf(result) || null;
  };
  const visualSignature = () => {
    const active = resultById(activeId) || results[0] || null;
    return JSON.stringify({
      source: config.source ? {
        name: config.source.name,
        facts: originFacts(config.source),
      } : null,
      activeId: active?.id || null,
      title: config.title,
      createAnother: Boolean(config.onCreateAnother),
      sourceSelectable: Boolean(config.onSelectSource),
      removable: Boolean(config.allowRemove && config.onRemove),
      results: results.map((result) => ({
        id: result.id,
        name: result.name,
        operation: result.operation,
        status: result.status,
        stale: Boolean(result.stale),
        current: Boolean(result.current),
        compact: compactResultFacts(result),
        facts: generatedResultFacts(result),
      })),
    });
  };

  const releaseMedia = () => {
    if (activeMedia && ['AUDIO', 'VIDEO'].includes(activeMedia.tagName)) {
      activeMedia.pause();
      activeMedia.removeAttribute('src');
      activeMedia.load();
    } else if (activeMedia) {
      activeMedia.removeAttribute('src');
    }
    activeMedia = null;
    for (const url of ownedUrls) URL.revokeObjectURL(url);
    ownedUrls = new Set();
  };

  const paintStorageStatus = (storage) => {
    const badge = root.querySelector('.generated-result-local');
    const privacy = root.querySelector('.generated-result-privacy');
    if (badge) {
      badge.textContent = storage.badge;
      badge.title = storage.title;
      badge.dataset.state = storage.state;
    }
    if (privacy) {
      privacy.textContent = storage.message;
      privacy.dataset.state = storage.state;
    }
    lastStorageState = storage.state;
  };

  const mediaUrlFor = (result) => {
    const output = primaryOutputOf(result);
    if (result.url || output?.url) return String(result.url || output.url);
    const blob = blobOf(result);
    if (!blob || typeof globalThis.URL?.createObjectURL !== 'function') return null;
    const url = globalThis.URL.createObjectURL(blob);
    ownedUrls.add(url);
    return url;
  };

  const renderMedia = (result) => {
    const kind = result.metadataView.kind;
    const url = mediaUrlFor(result);
    const fallback = el('div', {
      class: 'generated-result-unavailable',
      hidden: Boolean(url),
    }, [
      el('span', { class: 'generated-result-file-icon', text: MEDIA_KIND_ICONS[kind], attrs: { 'aria-hidden': 'true' } }),
      el('strong', { text: url ? 'No se puede reproducir este formato' : 'Vista previa no disponible' }),
      el('p', {
        text: url
          ? 'El archivo está listo y se puede descargar normalmente.'
          : 'Los datos del resultado no están disponibles en este dispositivo.',
      }),
    ]);

    if (!url || kind === 'file') {
      fallback.hidden = false;
      return el('div', { class: 'generated-result-media-shell', dataset: { kind } }, [fallback]);
    }

    let media;
    if (kind === 'image') {
      media = el('img', {
        class: 'generated-result-image',
        src: url,
        alt: result.alt || `Resultado ${result.name}`,
        loading: 'eager',
      });
    } else {
      media = el(kind, {
        class: `generated-result-media generated-result-${kind}`,
        src: url,
        controls: true,
        preload: 'metadata',
        ...(kind === 'video' ? { playsInline: true, poster: result.poster || '' } : {}),
        attrs: { 'aria-label': `Reproducir ${result.name}` },
      });
      for (const type of ['play', 'pause', 'ended']) {
        media.addEventListener(type, () => config.onMediaEvent?.(type, result.original, media));
      }
    }
    let shell;
    if (kind !== 'audio') {
      shell = el('div', { class: 'generated-result-media-shell', dataset: { kind } }, [media, fallback]);
    } else {
      const waveform = el('div', { class: 'generated-audio-waveform', attrs: { 'aria-hidden': 'true' } },
        [32, 48, 68, 42, 78, 56, 88, 46, 64, 92, 58, 72, 38, 82, 52, 96, 62, 44, 76, 54, 86, 48, 70, 90]
          .map((height) => el('i', { style: `--wave:${height}%` }))
      );
      const artwork = el('div', { class: 'generated-audio-artwork', attrs: { 'aria-hidden': 'true' } }, [
        el('span', { class: 'generated-audio-note', text: '♫' }),
        waveform,
      ]);
      shell = el('div', { class: 'generated-result-media-shell generated-audio-player', dataset: { kind } }, [
        artwork,
        el('div', { class: 'generated-audio-controls' }, [
          el('div', { class: 'generated-audio-copy' }, [
            el('span', { text: 'Reproducción local' }),
            el('strong', { text: truncateName(result.name, 54), title: result.name }),
          ]),
          media,
          el('small', { text: 'Este audio se reproduce desde tu navegador y no se sube a ningún servidor.' }),
        ]),
        fallback,
      ]);
    }
    activeMedia = media;
    media.addEventListener('error', () => {
      media.hidden = true;
      shell.dataset.error = 'true';
      fallback.hidden = false;
      live.textContent = `${result.name} está listo, pero este navegador no puede reproducirlo.`;
      config.onMediaError?.(result.original);
    });
    return shell;
  };

  const historyRow = (result, index) => {
    const selected = result.id === activeId;
    const kind = result.metadataView.kind;
    const select = el('button', {
      type: 'button',
      class: 'generated-lineage-select',
      dataset: { generatedAction: 'select', resultId: result.id },
      attrs: {
        'aria-pressed': String(selected),
        'aria-label': `${selected ? 'Viendo' : 'Ver'} ${result.name}`,
      },
    }, [
      el('span', { class: 'generated-lineage-icon', text: MEDIA_KIND_ICONS[kind], attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'generated-lineage-copy' }, [
        el('span', { text: index === 0 ? 'Último resultado' : `Resultado ${results.length - index}` }),
        el('strong', { text: truncateName(result.name, 38), title: result.name }),
        el('small', { text: compactResultFacts(result) }),
      ]),
      selected ? el('span', { class: 'generated-lineage-current', text: 'Viendo' }) : null,
    ]);
    const actions = el('div', { class: 'generated-lineage-actions' }, [
      el('button', {
        type: 'button',
        class: 'generated-lineage-action',
        text: '↓',
        title: `Descargar ${result.name}`,
        dataset: { generatedAction: 'download', resultId: result.id },
        attrs: { 'aria-label': `Descargar ${result.name}` },
      }),
      config.allowRemove && config.onRemove ? el('button', {
        type: 'button',
        class: 'generated-lineage-action generated-lineage-remove',
        text: '×',
        title: `Quitar ${result.name}`,
        dataset: { generatedAction: 'remove', resultId: result.id },
        attrs: { 'aria-label': `Quitar ${result.name} del proyecto` },
      }) : null,
    ]);
    return el('article', {
      class: `generated-lineage-item${selected ? ' is-active' : ''}`,
      dataset: { resultId: result.id },
      attrs: { role: 'listitem' },
    }, [select, actions]);
  };

  const render = ({ announce = false } = {}) => {
    if (destroyed) return;
    releaseMedia();
    const active = resultById(activeId) || results[0] || null;
    root.dataset.empty = String(!active);
    root.dataset.kind = active?.metadataView.kind || 'file';
    root.replaceChildren(live);

    if (!active) {
      root.append(el('div', { class: 'generated-results-empty' }, [
        el('span', { class: 'generated-result-file-icon', text: '◇', attrs: { 'aria-hidden': 'true' } }),
        el('h2', { id: titleId, text: 'Tus resultados aparecerán acá' }),
        el('p', { text: 'Cuando termine la conversión vas a poder reproducir, revisar y descargar cada archivo.' }),
      ]));
      lastVisualSignature = visualSignature();
      lastActiveAsset = null;
      lastStorageState = null;
      return;
    }

    const sourceName = String(config.source?.name || 'archivo original');
    const status = resultStatusLabel(active);
    const storage = generatedStorageStatus(active.storageStatus || config.storageStatus);
    const download = el('button', {
      type: 'button',
      class: 'primary-button generated-result-download',
      dataset: { generatedAction: 'download', resultId: active.id },
      attrs: { 'aria-describedby': `${instanceId}-privacy` },
    }, [
      el('span', { text: 'Descargar resultado' }),
      el('span', { class: 'generated-result-download-icon', text: '↓', attrs: { 'aria-hidden': 'true' } }),
    ]);
    const headerActions = [download];
    if (config.onCreateAnother) {
      headerActions.unshift(el('button', {
        type: 'button',
        class: 'text-button',
        text: 'Trabajar desde el original',
        dataset: { generatedAction: 'create-another' },
      }));
    }
    const header = el('header', { class: 'generated-results-head' }, [
      el('div', { class: 'generated-results-heading' }, [
        el('span', { class: 'generated-results-kicker' }, [
          el('i', { attrs: { 'aria-hidden': 'true' } }),
          el('span', { text: status, attrs: { role: 'status' } }),
        ]),
        el('h2', { id: titleId, text: config.title }),
        el('p', { text: `${sourceName} → ${active.name}` }),
      ]),
      el('div', { class: 'generated-results-head-actions' }, headerActions),
    ]);

    const viewer = el('article', {
      class: 'generated-result-viewer',
      attrs: { 'aria-label': `Resultado seleccionado: ${active.name}` },
    }, [
      el('div', { class: 'generated-result-stage', dataset: { kind: active.metadataView.kind } }, [
        el('span', { class: 'generated-result-stage-badge', text: MEDIA_KIND_LABELS[active.metadataView.kind] }),
        renderMedia(active),
      ]),
      el('div', { class: 'generated-result-summary' }, [
        el('div', { class: 'generated-result-title' }, [
          el('div', {}, [
            el('span', { text: operationLabel(active.operation) }),
            el('h3', { text: active.name, title: active.name }),
          ]),
          el('span', {
            class: 'generated-result-local',
            text: storage.badge,
            title: storage.title,
            dataset: { state: storage.state },
          }),
        ]),
        metadataGrid(active),
        el('p', {
          id: `${instanceId}-privacy`,
          class: 'generated-result-privacy',
          text: storage.message,
          dataset: { state: storage.state },
        }),
      ]),
    ]);

    const derivedLabel = `${results.length} ${results.length === 1 ? 'resultado generado' : 'resultados generados'}`;
    const lineage = el('aside', {
      class: 'generated-lineage',
      attrs: { 'aria-label': `Archivos generados a partir de ${sourceName}` },
    }, [
      el('header', { class: 'generated-lineage-head' }, [
        el('div', {}, [
          el('span', { text: 'Historial del proyecto' }),
          el('h3', { text: `Derivados de ${truncateName(sourceName, 30)}`, title: sourceName }),
        ]),
        el('span', { class: 'generated-lineage-count', text: String(results.length), attrs: { 'aria-label': derivedLabel } }),
      ]),
      el('div', { class: 'generated-lineage-flow' }, [
        sourceNode(config.source, Boolean(config.onSelectSource)),
        el('span', { class: 'generated-lineage-connector', text: '↓', attrs: { 'aria-hidden': 'true' } }),
        el('div', { class: 'generated-lineage-list', attrs: { role: 'list' } }, results.map(historyRow)),
      ]),
    ]);

    root.append(header, el('div', { class: 'generated-results-body' }, [viewer, lineage]));
    if (announce) live.textContent = `${status}: ${active.name}. ${derivedLabel}.`;
    lastVisualSignature = visualSignature();
    lastActiveAsset = activeAsset(active);
    lastStorageState = storage.state;
  };

  const focusHistoryResult = (id) => {
    const restore = () => {
      const target = Array.from(root.querySelectorAll('[data-generated-action="select"]'))
        .find((button) => button.dataset.resultId === String(id));
      target?.focus();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(restore);
    else queueMicrotask(restore);
  };

  const select = (id, notify = true) => {
    const result = resultById(id);
    if (!result || result.id === activeId) return;
    activeId = result.id;
    render({ announce: true });
    focusHistoryResult(result.id);
    if (notify) config.onSelect?.(result.original, { id: result.id, index: resultIndex(result.id) });
  };

  const download = (result) => {
    if (!result) return;
    const output = primaryOutputOf(result);
    const singleOutput = !Array.isArray(result.outputs) || result.outputs.length === 1;
    let url = result.url || (singleOutput ? output?.url : null);
    if (url) url = String(url);
    let temporary = false;
    const blob = singleOutput ? blobOf(result) : null;
    if (!url && blob && typeof globalThis.URL?.createObjectURL === 'function') {
      url = globalThis.URL.createObjectURL(blob);
      temporary = true;
    }
    const downloadName = String(result.downloadName || result.name);
    if (config.onDownload) config.onDownload(result.original, { id: result.id, url, downloadName });
    else if (url) {
      const anchor = el('a', { href: url, download: downloadName });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }
    if (temporary && url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const stopClick = on(root, 'click', (event) => {
    const action = event.target.closest('[data-generated-action]');
    if (!action || !root.contains(action)) return;
    const result = resultById(action.dataset.resultId);
    if (action.dataset.generatedAction === 'select') select(action.dataset.resultId);
    else if (action.dataset.generatedAction === 'select-source') config.onSelectSource?.(config.source);
    else if (action.dataset.generatedAction === 'download') download(result);
    else if (action.dataset.generatedAction === 'remove' && result) {
      config.onRemove?.(result.original, { id: result.id, index: resultIndex(result.id) });
    } else if (action.dataset.generatedAction === 'create-another') config.onCreateAnother?.(config.source);
  });

  const stopKeydown = on(root, 'keydown', (event) => {
    const selectButton = event.target.closest('[data-generated-action="select"]');
    if (!selectButton || !root.contains(selectButton)) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(root.querySelectorAll('[data-generated-action="select"]'));
    if (!buttons.length) return;
    const current = Math.max(0, buttons.indexOf(selectButton));
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else next = (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    const nextId = buttons[next].dataset.resultId;
    select(nextId);
  });

  const update = (next = {}) => {
    if (destroyed) return;
    const previousIds = new Set(results.map((result) => result.id));
    const activeWas = activeId;
    config = { ...config, ...next };
    results = normalizeGeneratedResults(config.results);
    const explicit = Object.prototype.hasOwnProperty.call(next, 'activeId')
      ? (next.activeId == null ? null : String(next.activeId))
      : null;
    const newResult = results.find((result) => !previousIds.has(result.id));
    if (explicit && resultById(explicit)) activeId = explicit;
    else if (newResult && config.followLatest !== false) activeId = newResult.id;
    else if (activeWas && resultById(activeWas)) activeId = activeWas;
    else activeId = pickGeneratedResultId(results, explicit);
    const nextSignature = visualSignature();
    const nextActive = resultById(activeId) || results[0] || null;
    const nextActiveAsset = activeAsset(nextActive);
    if (nextSignature === lastVisualSignature && nextActiveAsset === lastActiveAsset) {
      const storage = generatedStorageStatus(nextActive?.storageStatus || config.storageStatus);
      if (storage.state !== lastStorageState) paintStorageStatus(storage);
      return;
    }
    render({ announce: Boolean(newResult) });
  };

  render({ announce: Boolean(results.length) });

  return {
    node: root,
    update,
    select,
    getActiveId: () => activeId,
    focus: () => root.querySelector('.generated-result-download, [data-generated-action="select"]')?.focus(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopClick();
      stopKeydown();
      releaseMedia();
      root.replaceChildren();
    },
  };
}
