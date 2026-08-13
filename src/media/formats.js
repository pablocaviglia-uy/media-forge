/**
 * What this app can produce, and what each output needs from the core.
 *
 * Kept apart from the command builder because it is a table, not logic: the
 * settings UI reads it to draw the format menu, the engine reads `encoders` to
 * grey out anything the compiled core cannot actually do, and the builder
 * reads the rest to assemble arguments. A build of FFmpeg without `libvpx`
 * should hide WebM rather than fail halfway through a job, and it can only do
 * that if the requirement is written down somewhere.
 */

/**
 * @typedef {object} Format
 * @property {string} id
 * @property {string} label      shown in the menu
 * @property {string} extension  no leading dot
 * @property {'video'|'audio'|'image'} kind
 * @property {string} mime
 * @property {string} muxer      the FFmpeg format name, for the capability check
 * @property {string[]} encoders every encoder the default settings will ask for
 * @property {string} [note]     one line explaining when to pick this
 */

/** @type {Format[]} */
export const VIDEO_FORMATS = [
  {
    id: 'mp4-h264',
    label: 'MP4 · H.264',
    extension: 'mp4',
    kind: 'video',
    mime: 'video/mp4',
    muxer: 'mp4',
    encoders: ['libx264', 'aac'],
    note: 'Plays everywhere. The right answer unless you have a reason.',
  },
  // There is no VP9 entry, and its absence is deliberate.
  //
  // `libvpx-vp9` is compiled into the core and listed by `-encoders`, but on a
  // freshly instantiated core it traps with "memory access out of bounds"
  // before the first frame, whatever the settings — constant quality, fixed
  // bitrate, one thread, no tiling. It is not simply broken: after roughly
  // forty invocations on the same instance it starts working and keeps
  // working, which is how it slipped past the first round of testing here.
  //
  // That makes it worse than broken, not better. The engine is instantiated
  // fresh on every page load and replaced whenever a job is cancelled, so a
  // real first conversion is always in the range where it traps — and a trap
  // takes the whole instance down rather than failing one job. VP8 through the
  // same library is unaffected, so the WebM option below is VP8.
  {
    id: 'webm-vp8',
    label: 'WebM · VP8',
    extension: 'webm',
    kind: 'video',
    mime: 'video/webm',
    muxer: 'webm',
    encoders: ['libvpx', 'libvorbis'],
    note: 'Open and royalty-free. Larger than H.264 at the same quality.',
  },
  {
    id: 'mkv-h264',
    label: 'MKV · H.264',
    extension: 'mkv',
    kind: 'video',
    mime: 'video/x-matroska',
    muxer: 'matroska',
    encoders: ['libx264', 'aac'],
    note: 'Same video as MP4 in a container that holds anything.',
  },
  {
    id: 'mov-h264',
    label: 'MOV · H.264',
    extension: 'mov',
    kind: 'video',
    mime: 'video/quicktime',
    muxer: 'mov',
    encoders: ['libx264', 'aac'],
    note: 'For editors that insist on QuickTime.',
  },
  {
    id: 'gif',
    label: 'GIF',
    extension: 'gif',
    kind: 'image',
    mime: 'image/gif',
    muxer: 'gif',
    encoders: ['gif'],
    note: 'Silent, 256 colours, and far larger than the video it came from.',
  },
];

/** @type {Format[]} */
export const AUDIO_FORMATS = [
  {
    id: 'mp3',
    label: 'MP3',
    extension: 'mp3',
    kind: 'audio',
    mime: 'audio/mpeg',
    muxer: 'mp3',
    encoders: ['libmp3lame'],
    note: 'Plays on anything with a speaker.',
  },
  {
    id: 'm4a',
    label: 'M4A · AAC',
    extension: 'm4a',
    kind: 'audio',
    mime: 'audio/mp4',
    muxer: 'ipod',
    encoders: ['aac'],
    note: 'Better than MP3 at the same size.',
  },
  {
    id: 'opus',
    label: 'Opus',
    extension: 'opus',
    kind: 'audio',
    mime: 'audio/ogg',
    muxer: 'opus',
    encoders: ['libopus'],
    note: 'The best quality per byte, if what you play it on supports it.',
  },
  {
    id: 'ogg',
    label: 'OGG · Vorbis',
    extension: 'ogg',
    kind: 'audio',
    mime: 'audio/ogg',
    muxer: 'ogg',
    encoders: ['libvorbis'],
  },
  {
    id: 'wav',
    label: 'WAV',
    extension: 'wav',
    kind: 'audio',
    mime: 'audio/wav',
    muxer: 'wav',
    encoders: ['pcm_s16le'],
    lossless: true,
    note: 'Uncompressed. Large, lossless, and universally readable.',
  },
  {
    id: 'flac',
    label: 'FLAC',
    extension: 'flac',
    kind: 'audio',
    mime: 'audio/flac',
    muxer: 'flac',
    encoders: ['flac'],
    lossless: true,
    note: 'Lossless and about half the size of WAV.',
  },
];

/** @type {Format[]} */
export const IMAGE_FORMATS = [
  { id: 'png', label: 'PNG', extension: 'png', kind: 'image', mime: 'image/png', muxer: 'image2', encoders: ['png'] },
  { id: 'jpeg', label: 'JPEG', extension: 'jpg', kind: 'image', mime: 'image/jpeg', muxer: 'image2', encoders: ['mjpeg'] },
  { id: 'webp', label: 'WebP', extension: 'webp', kind: 'image', mime: 'image/webp', muxer: 'webp', encoders: ['libwebp'] },
];

export const FORMATS = [...VIDEO_FORMATS, ...AUDIO_FORMATS, ...IMAGE_FORMATS];

const BY_ID = new Map(FORMATS.map((format) => [format.id, format]));

/** @returns {Format|null} */
export function formatById(id) {
  return BY_ID.get(id) || null;
}

/**
 * Resolutions offered for video. `null` height means "leave it alone".
 * Heights rather than widths, because that is how people say it.
 */
export const RESOLUTIONS = [
  { id: 'source', label: 'Same as source', height: null },
  { id: '2160', label: '2160p · 4K', height: 2160 },
  { id: '1440', label: '1440p', height: 1440 },
  { id: '1080', label: '1080p', height: 1080 },
  { id: '720', label: '720p', height: 720 },
  { id: '480', label: '480p', height: 480 },
  { id: '360', label: '360p', height: 360 },
  { id: '240', label: '240p', height: 240 },
];

export const FRAME_RATES = [
  { id: 'source', label: 'Same as source', fps: null },
  { id: '60', label: '60 fps', fps: 60 },
  { id: '30', label: '30 fps', fps: 30 },
  { id: '24', label: '24 fps', fps: 24 },
  { id: '15', label: '15 fps', fps: 15 },
  { id: '12', label: '12 fps', fps: 12 },
];

/**
 * Quality, as three choices rather than a number nobody outside video
 * encoding can interpret. The CRF values behind them are per-encoder because
 * the scales are not comparable: 23 is ordinary for x264 and unusably coarse
 * for VP9.
 */
export const QUALITIES = [
  { id: 'high', label: 'High', note: 'Close to the original. Largest file.' },
  { id: 'balanced', label: 'Balanced', note: 'What most people want.' },
  { id: 'small', label: 'Small', note: 'Visibly softer, much smaller.' },
];

const CRF = {
  libx264: { high: 18, balanced: 23, small: 28 },
  libx265: { high: 22, balanced: 28, small: 32 },
  'libvpx-vp9': { high: 28, balanced: 33, small: 40 },
  libvpx: { high: 6, balanced: 10, small: 20 },
};

/** @returns {number} the constant-quality value for this encoder and choice. */
export function crfFor(encoder, quality) {
  const scale = CRF[encoder] || CRF.libx264;
  return scale[quality] ?? scale.balanced;
}

/**
 * x264 and x265 presets trade encode time for compression. `veryfast` is the
 * default rather than FFmpeg's own `medium` because this runs in a browser
 * tab on one thread more often than not, and `medium` turns a two-minute clip
 * into a coffee break for a few percent of file size.
 */
export const SPEED_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower'];

export const AUDIO_BITRATES = [
  { id: '320', label: '320 kbps', kbps: 320 },
  { id: '256', label: '256 kbps', kbps: 256 },
  { id: '192', label: '192 kbps', kbps: 192 },
  { id: '128', label: '128 kbps', kbps: 128 },
  { id: '96', label: '96 kbps', kbps: 96 },
  { id: '64', label: '64 kbps', kbps: 64 },
];

/**
 * FLAC trades encoding time for size at a fixed quality — the audio that comes
 * back out is identical at every level, because that is what lossless means.
 *
 * The default is 5 because the curve flattens hard after it. On a ten-second
 * sample: level 0 is 182 KB, level 5 is 128 KB, and level 12 is 127.6 KB for
 * six times the work. The control exists for people who want the last half a
 * percent, not because most people should touch it.
 */
export const FLAC_COMPRESSION = { min: 0, max: 12, default: 5 };

/**
 * Whether a codec already threw information away.
 *
 * Used to warn before wrapping lossy audio in a lossless container, which is
 * the most common mistake people make with FLAC: it cannot recover anything,
 * and it roughly triples the file. Unknown codecs report `unknown` rather than
 * guessing, because a wrong warning is worse than no warning.
 *
 * @returns {'lossless'|'lossy'|'unknown'}
 */
export function audioFidelity(codec) {
  const name = String(codec || '').toLowerCase();
  if (!name) return 'unknown';
  // Every raw PCM variant, of which FFmpeg has dozens.
  if (name.startsWith('pcm_')) return 'lossless';
  if (LOSSLESS_AUDIO.has(name)) return 'lossless';
  if (LOSSY_AUDIO.has(name)) return 'lossy';
  return 'unknown';
}

const LOSSLESS_AUDIO = new Set(['flac', 'alac', 'wavpack', 'tta', 'tak', 'ape', 'mlp', 'truehd', 'ralf', 'shorten']);

const LOSSY_AUDIO = new Set([
  'mp3', 'mp3float', 'mp2', 'mp1', 'aac', 'aac_latm', 'vorbis', 'opus',
  'ac3', 'eac3', 'dts', 'wmav1', 'wmav2', 'wmapro', 'wmavoice',
  'amr_nb', 'amr_wb', 'speex', 'gsm', 'gsm_ms', 'qdm2', 'cook', 'sipr',
  'atrac1', 'atrac3', 'atrac3p', 'nellymoser', 'musepack7', 'musepack8',
]);

/** Which encoder each audio format uses, and the arguments it needs. */
export const AUDIO_ENCODERS = {
  mp3: 'libmp3lame',
  m4a: 'aac',
  opus: 'libopus',
  ogg: 'libvorbis',
  wav: 'pcm_s16le',
  flac: 'flac',
};
