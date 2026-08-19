/**
 * Canonical public-tool registry.
 *
 * A tool is a localized entry point into one of four shared workspaces, not a
 * bespoke implementation. Keep `id` stable: routes and labels may be
 * localized or renamed, while persisted recents and presets resolve by id.
 */

const ROUTE_ROOTS = Object.freeze({
  video: Object.freeze({ es: 'video', en: 'video' }),
  audio: Object.freeze({ es: 'audio', en: 'audio' }),
  pdf: Object.freeze({ es: 'pdf', en: 'pdf' }),
  convert: Object.freeze({ es: 'convertir', en: 'convert' }),
});

/**
 * These are the public entry points the current local engine can fulfil
 * honestly. They are product routes, not a one-to-one mapping to command
 * builders: focused tools and multi-file projects share the same engine.
 */
const AVAILABLE_ENTRY_POINTS = new Set([
  'video-converter',
  'audio-converter',
  'video-merge',
  'video-trim',
  'video-crop',
  'audio-trim',
  'video-rotate',
  'video-flip',
  'video-resize',
]);

function defineTool(
  id,
  category,
  slugEs,
  slugEn,
  name,
  description,
  workspace,
  mode,
  implementation,
  engines,
  { extra = false, keywords = [] } = {},
) {
  const separator = implementation.indexOf(':');
  const implementationKey = implementation.slice(0, separator);
  const preset = implementation.slice(separator + 1);
  const roots = ROUTE_ROOTS[category];

  return Object.freeze({
    id,
    name,
    description,
    category,
    workspace,
    mode,
    slug: Object.freeze({ es: slugEs, en: slugEn }),
    route: Object.freeze({
      es: `/es/${roots.es}/${slugEs}`,
      en: `/en/${roots.en}/${slugEn}`,
    }),
    availability: AVAILABLE_ENTRY_POINTS.has(id) ? 'available' : 'planned',
    keywords: Object.freeze(keywords),
    extra,
    implementation: Object.freeze({
      key: implementationKey,
      preset,
      engines: Object.freeze(engines.split(' ')),
    }),
  });
}

export const TOOL_CATALOG = Object.freeze([
  // Video — 18 baseline routes plus one extra.
  defineTool('video-editor', 'video', 'editar', 'edit', 'Editor de video', 'Editá clips, pistas, audio, imágenes y texto en una línea de tiempo.', 'studio', 'HL', 'media-studio:blank-video', 'TL MX AE FF', { keywords: ['montar', 'edición', 'timeline'] }),
  defineTool('screen-recorder', 'video', 'grabar-pantalla', 'screen-recorder', 'Grabar pantalla', 'Capturá una pantalla, ventana o pestaña con audio opcional.', 'quick', 'L', 'capture:screen', 'CAP FF', { keywords: ['capturar', 'screencast'] }),
  defineTool('text-to-speech', 'video', 'texto-a-voz', 'text-to-speech', 'Texto a voz', 'Convertí texto escrito en una pista de voz lista para descargar o editar.', 'quick', 'R', 'speech:synthesize', 'TTS AE', { keywords: ['tts', 'narración', 'locución'] }),
  defineTool('video-merge', 'video', 'unir', 'merge', 'Unir videos', 'Ordená y combiná varios videos en una sola pieza.', 'studio', 'HL', 'media-studio:sequential-video', 'TL FF', { keywords: ['combinar', 'concatenar'] }),
  defineTool('video-trim', 'video', 'cortar', 'trim', 'Cortar video', 'Elegí el inicio y el final de un clip para conservar sólo lo que importa.', 'quick', 'HL', 'quick-video:trim', 'VT FF', { keywords: ['recortar tiempo', 'acortar'] }),
  defineTool('video-add-audio', 'video', 'agregar-audio', 'add-audio', 'Agregar audio al video', 'Sumá música, voz o efectos y ajustalos sobre el video.', 'studio', 'HL', 'media-studio:audio-track', 'TL AE FF', { keywords: ['música', 'banda sonora'] }),
  defineTool('video-add-image', 'video', 'agregar-imagen', 'add-image', 'Agregar imagen al video', 'Superponé una imagen y controlá su posición, tamaño y duración.', 'studio', 'HL', 'media-studio:image-overlay', 'TL MX FF', { keywords: ['overlay', 'marca de agua'] }),
  defineTool('video-add-text', 'video', 'agregar-texto', 'add-text', 'Agregar texto al video', 'Creá títulos y textos con posición y duración ajustables.', 'studio', 'HL', 'media-studio:text-overlay', 'TL MX FF', { keywords: ['títulos', 'subtítulos'] }),
  defineTool('video-remove-logo', 'video', 'quitar-logo', 'remove-logo', 'Quitar logo de un video', 'Ocultá una zona fija mediante recorte o una máscara configurada por vos.', 'studio', 'HL', 'media-studio:mask-or-crop', 'TL MX FF', { keywords: ['marca de agua', 'máscara'] }),
  defineTool('video-crop', 'video', 'recortar-encuadre', 'crop', 'Recortar encuadre', 'Reencuadrá el video para eliminar bordes o destacar una zona.', 'quick', 'HL', 'quick-video:crop', 'VT FF', { keywords: ['crop', 'encuadrar'] }),
  defineTool('video-rotate', 'video', 'girar', 'rotate', 'Girar video', 'Rotá el video 90, 180 o 270 grados.', 'quick', 'HL', 'quick-video:rotate', 'VT FF', { keywords: ['rotar', 'orientación'] }),
  defineTool('video-flip', 'video', 'voltear', 'flip', 'Voltear video', 'Reflejá el video en sentido horizontal o vertical.', 'quick', 'HL', 'quick-video:flip', 'VT FF', { keywords: ['espejo', 'reflejar'] }),
  defineTool('video-resize', 'video', 'redimensionar', 'resize', 'Redimensionar video', 'Cambiá la resolución manteniendo la proporción de la imagen.', 'quick', 'HL', 'quick-video:resize', 'VT FF', { keywords: ['resolución', 'escala'] }),
  defineTool('video-loop', 'video', 'repetir', 'loop', 'Repetir video', 'Repetí un clip varias veces y exportalo como una sola pieza.', 'quick', 'HL', 'quick-video:loop', 'VT FF', { keywords: ['bucle', 'loop'] }),
  defineTool('video-volume', 'video', 'cambiar-volumen', 'change-volume', 'Cambiar volumen del video', 'Subí, bajá o silenciá el audio de un video.', 'quick', 'HL', 'quick-video:volume', 'VT AE FF', { keywords: ['audio', 'silenciar'] }),
  defineTool('video-speed', 'video', 'cambiar-velocidad', 'change-speed', 'Cambiar velocidad del video', 'Acelerá o ralentizá imagen y sonido de forma sincronizada.', 'quick', 'HL', 'quick-video:speed', 'VT AE FF', { keywords: ['acelerar', 'cámara lenta'] }),
  defineTool('video-stabilize', 'video', 'estabilizar', 'stabilize', 'Estabilizar video', 'Reducí movimientos bruscos mediante análisis de movimiento en dos pasadas.', 'studio', 'HR', 'media-studio:stabilize', 'TL STAB FF', { keywords: ['temblor', 'movimiento'] }),
  defineTool('webcam-recorder', 'video', 'grabar-webcam', 'webcam-recorder', 'Grabar webcam', 'Grabá la cámara y el micrófono directamente desde el navegador.', 'quick', 'L', 'capture:camera', 'CAP FF', { keywords: ['cámara', 'capturar'] }),
  defineTool('video-green-screen', 'video', 'pantalla-verde', 'green-screen', 'Pantalla verde', 'Eliminá un fondo de color y componé el video sobre otra imagen.', 'studio', 'HL', 'media-studio:chroma-key', 'TL MX FF', { extra: true, keywords: ['croma', 'chroma key'] }),

  // Audio — eight baseline routes plus two extras.
  defineTool('audio-trim', 'audio', 'cortar', 'trim', 'Cortar audio', 'Conservá sólo el tramo que necesitás indicando inicio y final.', 'quick', 'HL', 'quick-audio:trim', 'AE FF', { keywords: ['recortar', 'acortar'] }),
  defineTool('audio-volume', 'audio', 'cambiar-volumen', 'change-volume', 'Cambiar volumen del audio', 'Ajustá la intensidad o silenciá una grabación.', 'quick', 'HL', 'quick-audio:volume', 'AE FF', { keywords: ['ganancia', 'normalizar'] }),
  defineTool('audio-speed', 'audio', 'cambiar-velocidad', 'change-speed', 'Cambiar velocidad del audio', 'Acelerá o ralentizá una pista sin editarla manualmente.', 'quick', 'HL', 'quick-audio:tempo', 'AE FF', { keywords: ['tempo', 'acelerar'] }),
  defineTool('audio-pitch', 'audio', 'cambiar-tono', 'change-pitch', 'Cambiar tono del audio', 'Subí o bajá el tono de una pista con controles simples.', 'quick', 'HL', 'quick-audio:pitch', 'AE FF', { keywords: ['pitch', 'afinación'] }),
  defineTool('audio-equalizer', 'audio', 'ecualizar', 'equalize', 'Ecualizar audio', 'Realzá o atenuá frecuencias para equilibrar el sonido.', 'quick', 'HL', 'quick-audio:equalizer', 'AE FF', { keywords: ['frecuencias', 'ecualizador'] }),
  defineTool('audio-reverse', 'audio', 'invertir', 'reverse', 'Invertir audio', 'Reproducí una pista desde el final hacia el principio.', 'quick', 'HL', 'quick-audio:reverse', 'AE FF', { keywords: ['reversa', 'al revés'] }),
  defineTool('voice-recorder', 'audio', 'grabar-voz', 'voice-recorder', 'Grabar voz', 'Capturá el micrófono y descargá la grabación desde el navegador.', 'quick', 'L', 'capture:voice', 'CAP AE FF', { keywords: ['micrófono', 'grabadora'] }),
  defineTool('audio-merge', 'audio', 'unir', 'merge', 'Unir audios', 'Ordená y combiná varias pistas en un único archivo.', 'studio', 'HL', 'media-studio:sequential-audio', 'TL AE FF', { keywords: ['combinar', 'concatenar'] }),
  defineTool('audio-vocal-separation', 'audio', 'separar-voz-y-musica', 'separate-vocals', 'Separar voz y música', 'Obtené pistas independientes de voz e instrumental.', 'studio', 'R', 'audio-ml:two-stems', 'ML-A AE FF', { extra: true, keywords: ['stems', 'instrumental', 'karaoke'] }),
  defineTool('audio-denoise', 'audio', 'eliminar-ruido', 'denoise', 'Eliminar ruido', 'Reducí ruido de fondo con un proceso especializado.', 'studio', 'R', 'audio-ml:denoise', 'ML-A AE FF', { extra: true, keywords: ['limpiar', 'ruido de fondo'] }),

  // PDF — 17 baseline routes plus one extra.
  defineTool('pdf-split', 'pdf', 'dividir', 'split', 'Dividir PDF', 'Separá páginas o rangos en nuevos archivos PDF.', 'documents', 'L', 'pdf-pages:split', 'PDF', { keywords: ['separar', 'extraer páginas'] }),
  defineTool('pdf-merge', 'pdf', 'combinar', 'merge', 'Combinar PDF', 'Ordená y uní varios documentos en un solo PDF.', 'documents', 'L', 'pdf-pages:merge', 'PDF', { keywords: ['unir', 'juntar'] }),
  defineTool('pdf-compress', 'pdf', 'comprimir', 'compress', 'Comprimir PDF', 'Reducí el peso del archivo equilibrando calidad y tamaño.', 'documents', 'HR', 'pdf-optimize:compress', 'PDF PDF-R IMG', { keywords: ['optimizar', 'reducir tamaño', 'achicar'] }),
  defineTool('pdf-unlock', 'pdf', 'desbloquear', 'unlock', 'Desbloquear PDF', 'Quitá la protección con una contraseña válida suministrada por vos.', 'documents', 'L', 'pdf-security:decrypt', 'PDF', { keywords: ['contraseña', 'descifrar'] }),
  defineTool('pdf-protect', 'pdf', 'proteger', 'protect', 'Proteger PDF', 'Agregá una contraseña para controlar el acceso al documento.', 'documents', 'L', 'pdf-security:encrypt', 'PDF', { keywords: ['contraseña', 'cifrar'] }),
  defineTool('pdf-rotate', 'pdf', 'girar', 'rotate', 'Girar páginas de PDF', 'Rotá una página, un rango o todo el documento.', 'documents', 'L', 'pdf-pages:rotate', 'PDF', { keywords: ['rotar', 'orientación'] }),
  defineTool('pdf-page-numbers', 'pdf', 'numerar-paginas', 'add-page-numbers', 'Numerar páginas', 'Agregá numeración con posición y formato configurables.', 'documents', 'L', 'pdf-pages:number', 'PDF', { keywords: ['folios', 'paginación'] }),
  defineTool('pdf-to-word', 'pdf', 'a-word', 'to-word', 'PDF a Word', 'Convertí un PDF en un documento Word editable.', 'documents', 'R', 'document-convert:pdf-docx', 'OFF', { keywords: ['docx', 'documento'] }),
  defineTool('pdf-to-excel', 'pdf', 'a-excel', 'to-excel', 'PDF a Excel', 'Convertí tablas de un PDF en una hoja de cálculo.', 'documents', 'R', 'document-convert:pdf-xlsx', 'OFF', { keywords: ['xlsx', 'planilla', 'tablas'] }),
  defineTool('pdf-to-jpg', 'pdf', 'a-jpg', 'to-jpg', 'PDF a JPG', 'Renderizá cada página como una imagen JPG.', 'documents', 'L', 'pdf-render-images:jpg', 'PDF-R IMG', { keywords: ['imagen', 'jpeg'] }),
  defineTool('pdf-to-png', 'pdf', 'a-png', 'to-png', 'PDF a PNG', 'Renderizá cada página como una imagen PNG.', 'documents', 'L', 'pdf-render-images:png', 'PDF-R IMG', { keywords: ['imagen', 'transparencia'] }),
  defineTool('pdf-to-html', 'pdf', 'a-html', 'to-html', 'PDF a HTML', 'Transformá el contenido de un PDF en una página web.', 'documents', 'R', 'document-convert:pdf-html', 'OFF PDF-R', { keywords: ['web', 'página'] }),
  defineTool('word-to-pdf', 'pdf', 'word-a-pdf', 'word-to-pdf', 'Word a PDF', 'Convertí un documento Word a PDF conservando su diseño.', 'documents', 'R', 'document-convert:docx-pdf', 'OFF', { keywords: ['docx', 'documento'] }),
  defineTool('jpg-to-pdf', 'pdf', 'jpg-a-pdf', 'jpg-to-pdf', 'JPG a PDF', 'Ordená imágenes JPG y reunilas en un documento PDF.', 'documents', 'L', 'images-to-pdf:jpg', 'IMG PDF', { keywords: ['jpeg', 'imágenes'] }),
  defineTool('excel-to-pdf', 'pdf', 'excel-a-pdf', 'excel-to-pdf', 'Excel a PDF', 'Convertí una hoja de cálculo a un PDF listo para compartir.', 'documents', 'R', 'document-convert:xlsx-pdf', 'OFF', { keywords: ['xlsx', 'planilla'] }),
  defineTool('powerpoint-to-pdf', 'pdf', 'powerpoint-a-pdf', 'powerpoint-to-pdf', 'PowerPoint a PDF', 'Convertí una presentación en un documento PDF.', 'documents', 'R', 'document-convert:pptx-pdf', 'OFF', { keywords: ['pptx', 'presentación'] }),
  defineTool('png-to-pdf', 'pdf', 'png-a-pdf', 'png-to-pdf', 'PNG a PDF', 'Ordená imágenes PNG y reunilas en un documento PDF.', 'documents', 'L', 'images-to-pdf:png', 'IMG PDF', { keywords: ['imágenes', 'documento'] }),
  defineTool('pdf-to-powerpoint', 'pdf', 'a-powerpoint', 'to-powerpoint', 'PDF a PowerPoint', 'Convertí un PDF en una presentación editable.', 'documents', 'R', 'document-convert:pdf-pptx', 'OFF', { extra: true, keywords: ['pptx', 'presentación'] }),

  // Conversion — eight baseline routes.
  defineTool('audio-converter', 'convert', 'audio', 'audio', 'Convertir audio', 'Convertí pistas entre formatos de audio con ajustes de calidad.', 'batch', 'HL', 'batch-convert:audio', 'CVT AE FF', { keywords: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'formato', 'extraer audio'] }),
  defineTool('video-converter', 'convert', 'video', 'video', 'Convertir video', 'Convertí videos entre formatos, resoluciones y calidades.', 'batch', 'HL', 'batch-convert:video', 'CVT VT FF', { keywords: ['mp4', 'mov', 'avi', 'webm', 'mkv', 'formato'] }),
  defineTool('image-converter', 'convert', 'imagenes', 'images', 'Convertir imágenes', 'Procesá una o muchas imágenes y cambiá su formato.', 'batch', 'HL', 'batch-convert:image', 'CVT IMG', { keywords: ['jpg', 'png', 'webp', 'lote'] }),
  defineTool('document-converter', 'convert', 'documentos', 'documents', 'Convertir documentos', 'Transformá documentos de oficina entre formatos compatibles.', 'batch', 'R', 'batch-convert:document', 'CVT OFF', { keywords: ['word', 'excel', 'office'] }),
  defineTool('font-converter', 'convert', 'fuentes', 'fonts', 'Convertir fuentes', 'Cambiá archivos tipográficos entre formatos de fuente.', 'batch', 'R', 'batch-convert:font', 'CVT FNT', { keywords: ['ttf', 'otf', 'woff'] }),
  defineTool('archive-converter', 'convert', 'archivos-comprimidos', 'archives', 'Convertir archivos comprimidos', 'Cambiá el formato de un archivo comprimido de manera segura.', 'batch', 'HR', 'batch-convert:archive', 'CVT ARC', { keywords: ['zip', 'tar', '7z'] }),
  defineTool('ebook-converter', 'convert', 'ebooks', 'ebooks', 'Convertir ebooks', 'Convertí libros electrónicos entre formatos de lectura.', 'batch', 'R', 'batch-convert:ebook', 'CVT EBK', { keywords: ['epub', 'mobi', 'libro'] }),
  defineTool('archive-extractor', 'convert', 'extraer-archivos', 'extract-archives', 'Extraer archivos', 'Abrí un archivo comprimido y descargá su contenido de forma segura.', 'batch', 'HL', 'batch-convert:extract', 'CVT ARC', { keywords: ['descomprimir', 'zip', 'extraer'] }),
]);

const TOOLS_BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));

const normalize = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es')
  .trim();

/** Return one canonical entry, or null when the id is unknown. */
export function getToolById(id) {
  return TOOLS_BY_ID.get(String(id)) ?? null;
}

/**
 * List tools with optional exact-match filters.
 * Supported filters: category, workspace, mode and availability.
 */
export function listTools(filters = {}) {
  const filterEntries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null);
  if (filterEntries.length === 0) return TOOL_CATALOG;

  return TOOL_CATALOG.filter((tool) => filterEntries.every(([key, value]) => tool[key] === value));
}

/** Search Spanish copy, localized routes, ids and explicit synonyms. */
export function searchTools(query, filters = {}) {
  const needles = normalize(query).split(/\s+/).filter(Boolean);
  const tools = listTools(filters);
  if (!needles.length) return tools;

  return tools.filter((tool) => {
    const haystack = normalize([
      tool.id,
      tool.name,
      tool.description,
      tool.slug.es,
      tool.slug.en,
      tool.route.es,
      tool.route.en,
      ...tool.keywords,
    ].join(' '));
    return needles.every((needle) => (
      haystack.includes(needle)
      || (needle.length > 3 && needle.endsWith('s') && haystack.includes(needle.slice(0, -1)))
    ));
  });
}
