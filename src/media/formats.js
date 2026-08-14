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

/* ------------------------------------------------------------------ *
 * Repackaging
 * ------------------------------------------------------------------ */

/**
 * Which codecs each container will carry untouched.
 *
 * Changing an MKV of H.264 and AAC into an MP4 does not require encoding
 * anything: the same two streams move into a different box. That takes seconds
 * instead of minutes and, unlike every other operation here, cannot lose a
 * single bit — which is the whole argument for having it.
 *
 * The table matters more than it looks, for two reasons.
 *
 * The first is that it decides what gets offered, and an offer that FFmpeg
 * then refuses is worse than no offer. Every `yes` below was produced by
 * running `-c copy` on this vendored core and checking that a non-empty file
 * came out; the refusals come back as a clean exit 1 and leave the core usable,
 * but they are still a job that failed for a reason the app could have known.
 *
 * The second is that the muxer accepting a stream is necessary and not
 * sufficient. This core will happily write AAC into a `.wav` and Vorbis into an
 * `.mp4` — both were tested and both succeeded — and neither file is one you
 * could hand to anybody. So these lists are the intersection of what the binary
 * accepted with what actually plays, and the second half is a judgement rather
 * than a measurement. Where they differ, a comment says so.
 *
 * This is also the only path in the app to codecs it cannot encode. `libx265`
 * is compiled in and listed by `-encoders`, and asking it to encode hangs the
 * core outright — no error, no CPU, no way out but terminating the worker — so
 * there is no HEVC output format and there should not be one. Copying never
 * invokes an encoder, so HEVC from a phone can still be repackaged. The same
 * goes for VP9, whose encoder traps on a fresh core.
 *
 * @typedef {object} Container
 * @property {string} id
 * @property {string} label
 * @property {string} extension
 * @property {string} muxer
 * @property {string} mime
 * @property {'video'|'audio'} kind   audio containers drop the picture
 * @property {string[]} [video]       video codecs it will carry
 * @property {string[]} audio         audio codecs it will carry
 * @property {string} [note]
 */

/** @type {Container[]} */
export const REMUX_CONTAINERS = [
  {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    muxer: 'mp4',
    mime: 'video/mp4',
    kind: 'video',
    // VP9 muxes into MP4 here and is deliberately left out: it is legal, and
    // outside Chromium almost nothing opens it. WebM and MKV are where a VP9
    // stream belongs.
    video: ['h264', 'hevc', 'mpeg4'],
    audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3'],
    note: 'Plays everywhere, and carries HEVC from a phone as-is.',
  },
  {
    id: 'mov',
    label: 'MOV',
    extension: 'mov',
    muxer: 'mov',
    mime: 'video/quicktime',
    kind: 'video',
    video: ['h264', 'hevc', 'mpeg4', 'prores'],
    audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3', 'pcm'],
    note: 'The container ProRes and uncompressed audio belong in.',
  },
  {
    id: 'mkv',
    label: 'MKV',
    extension: 'mkv',
    muxer: 'matroska',
    mime: 'video/x-matroska',
    kind: 'video',
    // Matroska took every stream it was offered, which is the point of it.
    video: ['h264', 'hevc', 'vp8', 'vp9', 'mpeg4', 'prores'],
    audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3', 'vorbis', 'opus', 'flac', 'pcm'],
    note: 'Takes anything. The safe answer when nothing else fits.',
  },
  {
    id: 'webm',
    label: 'WebM',
    extension: 'webm',
    muxer: 'webm',
    mime: 'video/webm',
    kind: 'video',
    video: ['vp8', 'vp9'],
    audio: ['vorbis', 'opus'],
    note: 'Strict about what it holds, and refuses the rest outright.',
  },
  {
    id: 'm4a',
    label: 'M4A · audio only',
    extension: 'm4a',
    muxer: 'ipod',
    mime: 'audio/mp4',
    kind: 'audio',
    // AC-3 muxes into `.m4a` and is left out: nothing that plays music opens it.
    audio: ['aac', 'alac'],
    note: 'The AAC track lifted out of a video, untouched.',
  },
  {
    id: 'mp3',
    label: 'MP3 · audio only',
    extension: 'mp3',
    muxer: 'mp3',
    mime: 'audio/mpeg',
    kind: 'audio',
    audio: ['mp3'],
  },
  {
    id: 'ogg',
    label: 'OGG · audio only',
    extension: 'ogg',
    muxer: 'ogg',
    mime: 'audio/ogg',
    kind: 'audio',
    audio: ['vorbis', 'opus', 'flac'],
  },
  {
    id: 'opus',
    label: 'Opus · audio only',
    extension: 'opus',
    muxer: 'opus',
    mime: 'audio/ogg',
    kind: 'audio',
    // Vorbis and FLAC both mux into a `.opus` file. Neither should.
    audio: ['opus'],
  },
  {
    id: 'flac',
    label: 'FLAC · audio only',
    extension: 'flac',
    muxer: 'flac',
    mime: 'audio/flac',
    kind: 'audio',
    audio: ['flac'],
  },
  {
    id: 'wav',
    label: 'WAV · audio only',
    extension: 'wav',
    muxer: 'wav',
    mime: 'audio/wav',
    kind: 'audio',
    audio: ['pcm'],
  },
];

/**
 * FFmpeg names every PCM variant after its sample format — `pcm_s16le`,
 * `pcm_s24le`, `pcm_f32be` and a few dozen more — and the containers that take
 * one take all of them. Collapsing the family to `pcm` keeps the table from
 * being mostly PCM.
 */
export function remuxCodec(codec) {
  const name = String(codec || '').toLowerCase();
  return name.startsWith('pcm_') ? 'pcm' : name;
}

/**
 * Every container that can hold this file's streams without re-encoding.
 *
 * A video container has to carry both streams; an audio container carries the
 * sound and drops the picture, which is how an AAC track comes out of an MP4
 * without being encoded a second time. The source's own container is left out,
 * because repackaging something as what it already is does nothing.
 *
 * @param {{hasVideo: boolean, hasAudio: boolean, video: object|null,
 *   audio: object|null, formats: string[], name?: string}} info
 * @param {string} [name] the file's own name, when it is not on `info`
 * @returns {Container[]}
 */
export function remuxTargets(info, name = info?.name) {
  if (!info) return [];

  const video = info.hasVideo ? remuxCodec(info.video?.codec) : null;
  const audio = info.hasAudio ? remuxCodec(info.audio?.codec) : null;
  if (!video && !audio) return [];

  return REMUX_CONTAINERS.filter((container) => {
    if (container.kind === 'audio') {
      // Dropping the picture is a deliberate choice, so it is only worth
      // offering when there is sound to keep.
      return Boolean(audio) && container.audio.includes(audio);
    }
    if (video && !(container.video || []).includes(video)) return false;
    if (audio && !container.audio.includes(audio)) return false;
    return true;
  }).filter((container) => !isSameContainer(container, info, name));
}

/**
 * Every container the ISO base media format's one demuxer answers to.
 *
 * `ffprobe` reports a format as the list of names its demuxer handles, and MP4,
 * MOV, M4A and 3GP all share one — so an MP4 and a MOV are described by exactly
 * the same string and cannot be told apart from it.
 */
const MP4_FAMILY = ['mp4', 'mov', 'm4a', '3gp', '3g2'];

const extensionOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))?.[1] || '').toLowerCase();

/**
 * Whether the file is already in this container, so that repackaging it as
 * itself is never offered.
 *
 * Straightforward everywhere except the MP4 family, where the format list says
 * `mov,mp4,m4a,3gp,3g2,mj2` whatever the file actually is. Taking that at face
 * value ruled out both MP4 and MOV for every file in the family, which quietly
 * removed the most useful case there is: turning a MOV from a camera into an
 * MP4. Inside the family the extension is the only thing that distinguishes
 * them — and it is also what the person who called it a MOV meant by it.
 */
function isSameContainer(container, info, name) {
  const names = (info.formats || []).map((format) => format.toLowerCase());
  if (!names.length) return false;

  // An audio container is never a no-op for a file that still has pictures:
  // dropping them is the point of choosing it.
  if (container.kind === 'audio' && info.hasVideo) return false;

  const ambiguous = MP4_FAMILY.filter((format) => names.includes(format)).length > 1;
  if (ambiguous && MP4_FAMILY.includes(container.extension)) {
    return extensionOf(name) === container.extension;
  }

  return names.includes(container.muxer);
}

const REMUX_BY_ID = new Map(REMUX_CONTAINERS.map((container) => [container.id, container]));

/** @returns {Container|null} */
export const remuxContainerById = (id) => REMUX_BY_ID.get(id) || null;
