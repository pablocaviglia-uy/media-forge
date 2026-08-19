/**
 * Presentation contract for the generic conversion workspace.
 *
 * Command builders intentionally accept a broad options object because quick
 * tools and restored projects share it. A generic form must be stricter: every
 * visible control must affect the selected result, and an old hidden option
 * must never change a new export. This module is the pure boundary between the
 * two. It contains no DOM and never mutates the project it receives.
 */

import {
  AUDIO_FORMATS,
  FRAME_RATES,
  QUALITIES,
  RESOLUTIONS,
  VIDEO_FORMATS,
  formatById,
  remuxTargets,
} from './formats.js';

const VIDEO_FORMAT_IDS = new Set(VIDEO_FORMATS.filter((item) => item.kind === 'video').map((item) => item.id));
const AUDIO_FORMAT_IDS = new Set(AUDIO_FORMATS.map((item) => item.id));

const INTENT_COPY = Object.freeze({
  video: Object.freeze({ id: 'video', label: 'Video', detail: 'Para reproducir o compartir' }),
  audio: Object.freeze({ id: 'audio', label: 'Audio', detail: 'Solo el sonido' }),
  gif: Object.freeze({ id: 'gif', label: 'GIF', detail: 'Una animación breve' }),
  images: Object.freeze({ id: 'images', label: 'Imágenes', detail: 'Fotogramas del video' }),
  more: Object.freeze({ id: 'more', label: 'Otra tarea', detail: 'Acción especializada' }),
});

const SPECIAL_COPY = Object.freeze({
  remux: Object.freeze({ label: 'Reempaquetar sin perder calidad', detail: 'Cambia el contenedor sin volver a codificar.' }),
  compress: Object.freeze({ label: 'Comprimir a un tamaño', detail: 'Ajusta el bitrate para acercarse al peso indicado.' }),
  frames: Object.freeze({ label: 'Extraer varios fotogramas', detail: 'Guarda imágenes a un intervalo regular.' }),
  thumbnail: Object.freeze({ label: 'Capturar un fotograma', detail: 'Guarda una sola imagen del instante elegido.' }),
  raw: Object.freeze({ label: 'Comando FFmpeg', detail: 'Control manual para usuarios avanzados.' }),
});

const QUALITY_LABELS = Object.freeze({ high: 'Alta', balanced: 'Equilibrada', small: 'Archivo liviano' });

const finiteDuration = (info) => {
  const value = Number(info?.duration);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const trimText = (info, options) => {
  const duration = finiteDuration(info);
  if (!duration) return 'Duración desconocida';
  const numeric = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const from = numeric(options?.trimStart) ? Math.max(0, Number(options.trimStart)) : 0;
  const to = numeric(options?.trimEnd) ? Math.min(duration, Number(options.trimEnd)) : duration;
  if (from <= 0 && to >= duration) return 'Archivo completo';
  const seconds = Math.max(0, to - from);
  if (duration < 10 || seconds < 1) {
    return `${from.toFixed(2)}–${to.toFixed(2)} s · ${seconds.toFixed(2)} s`;
  }
  const clock = (value) => {
    const whole = Math.round(value);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = String(whole % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  };
  return `${clock(from)}–${clock(to)} · ${clock(seconds)}`;
};

const selectedAudioFormat = (operation, options) => {
  const selected = formatById(operation === 'extract-audio' ? options?.audioFormat : options?.format);
  return selected?.kind === 'audio' ? selected : formatById('mp3');
};

const selectedVideoFormat = (options) => {
  const format = formatById(options?.format);
  return format?.kind === 'video' ? format : formatById('mp4-h264');
};

export function effectiveConversionOperation(info, operation = 'convert') {
  if (operation === 'compress' && !finiteDuration(info)) return 'convert';
  if (operation === 'extract-audio' && !info?.hasAudio) return 'convert';
  if (['gif', 'frames', 'thumbnail', 'compress'].includes(operation) && !info?.hasVideo) return 'convert';
  if (operation === 'remux' && !remuxTargets(info).length) return 'convert';
  if (!['convert', 'extract-audio', 'gif', 'remux', 'compress', 'frames', 'thumbnail', 'raw'].includes(operation)) {
    return 'convert';
  }
  return operation;
}

export function deriveConversionIntent(info, operation = 'convert', options = {}) {
  if (operation === 'extract-audio') return 'audio';
  if (operation === 'gif') return 'gif';
  if (operation === 'frames' || operation === 'thumbnail') return 'images';
  if (operation !== 'convert') return 'more';

  const target = formatById(options.format);
  if (target?.id === 'gif') return 'gif';
  if (target?.kind === 'audio' || !info?.hasVideo) return 'audio';
  return 'video';
}

function visibleSourceHeight(info) {
  const video = info?.video;
  if (!video) return null;
  const rotation = ((Number(video.rotation) || 0) % 360 + 360) % 360;
  const value = rotation === 90 || rotation === 270 ? Number(video.width) : Number(video.height);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function availableIntents(info) {
  const items = [];
  if (info?.hasVideo) items.push(INTENT_COPY.video);
  if (info?.hasAudio) items.push(INTENT_COPY.audio);
  if (info?.hasVideo) items.push(INTENT_COPY.gif, INTENT_COPY.images);
  return Object.freeze(items);
}

function availableMoreActions(info) {
  const ids = [];
  if (remuxTargets(info).length) ids.push('remux');
  if (info?.hasVideo && finiteDuration(info)) ids.push('compress');
  if (info?.hasVideo) ids.push('frames', 'thumbnail');
  ids.push('raw');
  return Object.freeze(ids.map((id) => Object.freeze({ id, ...SPECIAL_COPY[id] })));
}

function availableResolutions(info) {
  const sourceHeight = visibleSourceHeight(info);
  return Object.freeze(RESOLUTIONS
    .filter((item) => item.id === 'source' || !sourceHeight || item.height <= sourceHeight)
    .map((item) => Object.freeze({ ...item, label: item.id === 'source' ? 'Original' : item.label })));
}

function availableFrameRates(info) {
  const sourceRate = Number(info?.video?.fps);
  return Object.freeze(FRAME_RATES
    .filter((item) => item.id === 'source' || !Number.isFinite(sourceRate) || item.fps <= sourceRate + 0.01)
    .map((item) => Object.freeze({ ...item, label: item.id === 'source' ? 'Original' : item.label })));
}

/**
 * Exact controls owned by the selected output. IDs deliberately match the
 * renderer, not the old operation catalogue's broad compound controls.
 */
export function conversionControlModel({ info, operation = 'convert', options = {} } = {}) {
  operation = effectiveConversionOperation(info, operation);
  const intent = deriveConversionIntent(info, operation, options);
  const primary = [];
  const duration = [];
  const advanced = [];
  let target = null;
  let title = INTENT_COPY[intent]?.label || 'Resultado';
  let detail = INTENT_COPY[intent]?.detail || '';

  if (intent === 'video') {
    target = selectedVideoFormat(options);
    primary.push('format', 'quality');
    duration.push('trim');
    advanced.push('resolution', 'fps');
    if (info?.hasAudio) advanced.push('mute', 'audioBitrate');
    advanced.push('speed');
  } else if (intent === 'audio') {
    target = selectedAudioFormat(operation, options);
    primary.push(operation === 'extract-audio' ? 'audioFormat' : 'format');
    if (!target.lossless) primary.push('audioBitrate');
    duration.push('trim');
    if (target.id === 'flac') advanced.push('flacCompression');
    title = info?.hasVideo ? 'Extraer audio' : 'Convertir audio';
    detail = info?.hasVideo ? 'Crea un archivo solo con el sonido.' : 'Cambia el formato del archivo de audio.';
  } else if (intent === 'gif') {
    target = formatById('gif');
    primary.push('gifWidth', 'gifFps');
    duration.push('trim');
    advanced.push('dither');
  } else if (operation === 'remux') {
    primary.push('remuxTarget');
    ({ label: title, detail } = SPECIAL_COPY.remux);
  } else if (operation === 'compress') {
    target = formatById('mp4-h264');
    primary.push('targetSize');
    duration.push('trim');
    advanced.push('resolution');
    if (info?.hasAudio) advanced.push('mute', 'audioBitrate');
    ({ label: title, detail } = SPECIAL_COPY.compress);
  } else if (operation === 'frames') {
    primary.push('frameInterval', 'imageFormat');
    duration.push('trim');
    advanced.push('resolution');
    ({ label: title, detail } = SPECIAL_COPY.frames);
  } else if (operation === 'thumbnail') {
    primary.push('at', 'imageFormat');
    advanced.push('resolution');
    ({ label: title, detail } = SPECIAL_COPY.thumbnail);
  } else {
    primary.push('rawArguments');
    ({ label: title, detail } = SPECIAL_COPY.raw);
  }

  return Object.freeze({
    intent,
    operation,
    title,
    detail,
    target,
    primary: Object.freeze(primary),
    duration: Object.freeze(duration),
    advanced: Object.freeze(advanced),
    intents: availableIntents(info),
    moreActions: availableMoreActions(info),
    resolutions: availableResolutions(info),
    frameRates: availableFrameRates(info),
    trimSummary: trimText(info, options),
  });
}

export function conversionCta(model) {
  if (!model) return 'Crear resultado';
  const format = model.target?.extension?.toUpperCase() || model.target?.label || '';
  if (model.intent === 'video') return `Convertir a ${format || 'video'}`;
  if (model.intent === 'audio') return `${model.title.startsWith('Extraer') ? 'Extraer' : 'Convertir a'} ${format || 'audio'}`;
  if (model.intent === 'gif') return 'Crear GIF';
  if (model.operation === 'remux') return 'Reempaquetar archivo';
  if (model.operation === 'compress') return 'Comprimir video';
  if (model.operation === 'frames') return 'Extraer fotogramas';
  if (model.operation === 'thumbnail') return 'Guardar fotograma';
  return 'Ejecutar comando';
}

export function conversionSummary(model, options = {}) {
  if (!model) return 'Resultado listo para configurar';
  const parts = [];
  if (model.target) parts.push(model.target.label);
  if (model.intent === 'video') parts.push(QUALITY_LABELS[options.quality] || QUALITY_LABELS.balanced);
  if (model.intent === 'audio' && !model.target?.lossless) parts.push(`${Number(options.audioBitrate) || 192} kbps`);
  if (model.intent === 'audio' && model.target?.lossless) parts.push('Sin pérdida');
  if (model.operation === 'compress') parts.push(`${Number(options.targetSize) || 8} MB aprox.`);
  if (model.operation === 'frames') parts.push(`cada ${Number(options.frameInterval) || 1} s`);
  if (model.duration.includes('trim')) parts.push(model.trimSummary);
  return parts.length ? parts.join(' · ') : model.title;
}

const NEUTRAL = Object.freeze({
  resolution: 'source',
  fps: 'source',
  quality: 'balanced',
  speed: 'veryfast',
  audioBitrate: 192,
  flacCompression: 5,
  mute: false,
  trimStart: null,
  trimEnd: null,
  rotate: 0,
  flip: 'none',
  cropAspect: 'free',
  cropX: null,
  cropY: null,
  cropWidth: null,
  cropHeight: null,
  evenDimensions: false,
  volumeGain: 1,
  playbackRate: 1,
  loopMode: 'count',
  loopCount: 1,
  loopDuration: null,
});

/**
 * Returns the options the builder may consume for this exact workspace.
 * Draft values remain on the project for later, while effects owned by a
 * different tool are neutralised in the immutable execution snapshot.
 */
export function effectiveConversionOptions({ info, operation = 'convert', options = {} } = {}) {
  const model = conversionControlModel({ info, operation, options });
  const next = { ...options, ...NEUTRAL };

  // Restore only controls that belong to the selected operation.
  for (const key of [...model.primary, ...model.duration, ...model.advanced]) {
    if (key === 'trim') {
      next.trimStart = options.trimStart ?? null;
      next.trimEnd = options.trimEnd ?? null;
    } else if (key === 'resolution') {
      const allowed = model.resolutions.some((item) => item.id === String(options.resolution));
      next.resolution = allowed ? String(options.resolution) : 'source';
    } else if (key === 'fps') {
      const allowed = model.frameRates.some((item) => item.id === String(options.fps));
      next.fps = allowed ? String(options.fps) : 'source';
    } else if (key === 'mute') {
      next.mute = options.mute === true;
    } else if (Object.prototype.hasOwnProperty.call(options, key)) {
      next[key] = options[key];
    }
  }

  // Format selection is represented by two legacy keys, depending on the
  // builder. Preserve only the one the current plan actually reads.
  if (model.primary.includes('format')) next.format = model.target?.id || options.format;
  if (model.primary.includes('audioFormat')) next.audioFormat = model.target?.id || options.audioFormat;

  return Object.freeze(next);
}

export const CONVERSION_QUALITY_CHOICES = Object.freeze(QUALITIES.map((item) => Object.freeze({
  id: item.id,
  label: QUALITY_LABELS[item.id] || item.label,
})));

export const CONVERSION_VIDEO_FORMAT_IDS = VIDEO_FORMAT_IDS;
export const CONVERSION_AUDIO_FORMAT_IDS = AUDIO_FORMAT_IDS;
