/**
 * Turning a choice in the UI into an FFmpeg command line.
 *
 * This is the part of the app most worth getting right, and the part most
 * worth keeping pure. Nothing here touches the DOM, WebAssembly or a file: it
 * takes a description of the source and what the user asked for, and returns
 * the exact arguments to run. That makes every operation testable without a
 * browser, and it makes the "show me the command" button in the inspector
 * honest — it prints the same array that is about to be executed, not a
 * plausible-looking reconstruction of it.
 *
 * A plan can contain more than one invocation. Two operations genuinely need
 * it: a good GIF requires building a colour palette from the source before
 * quantising against it, and hitting a target file size requires measuring the
 * video before committing to a bitrate. Both are two passes in every FFmpeg
 * tutorial ever written, and pretending otherwise produces visibly worse
 * output.
 */

import {
  formatById,
  crfFor,
  AUDIO_ENCODERS,
  FLAC_COMPRESSION,
  remuxTargets,
  remuxContainerById,
} from './formats.js';
import { formatTimestamp } from '../ui/dom.js';
import { normalizeCropRect } from './quick-tools.js';

/**
 * @typedef {object} Plan
 * @property {Array<{args: string[], label: string}>} steps
 * @property {string[]} inputNames   what the worker must write into the core
 * @property {string[]} outputs      files to read back when it finishes
 * @property {string} [outputPrefix] read every file starting with this instead
 * @property {string} mime
 * @property {string} downloadName   what the file is called once saved
 * @property {number|null} duration  media seconds each step will cover
 */

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

/**
 * The catalogue. `controls` drives the inspector, so adding an operation is a
 * matter of describing it here and writing its builder — the UI needs no
 * knowledge of what any particular operation means.
 */
export const OPERATIONS = [
  {
    id: 'convert',
    label: 'Convert',
    summary: 'Change the format, the resolution, the quality or all three.',
    accepts: 'any',
    controls: ['format', 'resolution', 'fps', 'quality', 'audio', 'trim', 'rotate'],
  },
  {
    id: 'remux',
    label: 'Repackage',
    summary: 'Move the same streams into a different container. Seconds, and nothing is lost.',
    accepts: 'any',
    // Offered only when some container can take this file's streams as they
    // are. There is no general answer — it depends entirely on what is inside.
    available: (info) => remuxTargets(info).length > 0,
    // No trimming here, and that is a decision rather than an omission. See the
    // note on `buildRemux`.
    controls: ['remuxTarget'],
  },
  {
    id: 'extract-audio',
    label: 'Extract audio',
    summary: 'Take the sound out of a video and leave the pictures behind.',
    accepts: 'video',
    controls: ['audioFormat', 'audio', 'trim'],
  },
  {
    id: 'gif',
    label: 'Animated GIF',
    summary: 'Two passes: build a palette from the clip, then quantise against it.',
    accepts: 'video',
    controls: ['gifFps', 'gifWidth', 'dither', 'trim'],
  },
  {
    id: 'compress',
    label: 'Compress to a size',
    summary: 'Work out the bitrate that lands near a target, then encode twice.',
    accepts: 'video',
    controls: ['targetSize', 'resolution', 'audio', 'trim'],
  },
  {
    id: 'frames',
    label: 'Extract frames',
    summary: 'Save stills at an interval, as images.',
    accepts: 'video',
    controls: ['frameInterval', 'imageFormat', 'resolution', 'trim'],
  },
  {
    id: 'thumbnail',
    label: 'Poster frame',
    summary: 'One still, from wherever you point at.',
    accepts: 'video',
    controls: ['at', 'imageFormat', 'resolution'],
  },
  {
    id: 'raw',
    label: 'Raw command',
    summary: 'Your own arguments. $in and $out stand for the files.',
    accepts: 'any',
    controls: ['rawArguments'],
  },
];

const OPERATIONS_BY_ID = new Map(OPERATIONS.map((operation) => [operation.id, operation]));

export const operationById = (id) => OPERATIONS_BY_ID.get(id) || null;

/** Which operations make sense for this file. */
export function operationsFor(info) {
  const hasVideo = Boolean(info?.hasVideo);
  return OPERATIONS.filter((operation) => {
    if (operation.accepts === 'video' && !hasVideo) return false;
    // Some operations depend on what is inside the file rather than merely on
    // whether it has pictures: repackaging is only possible when a container
    // exists that can carry these exact streams.
    return operation.available ? operation.available(info) : true;
  });
}

export const DEFAULT_OPTIONS = {
  format: 'mp4-h264',
  audioFormat: 'mp3',
  // Null rather than a container id: which containers are possible depends on
  // the file, so the builder picks the first one that fits rather than carrying
  // a default that might not apply to what was dropped.
  remuxTarget: null,
  imageFormat: 'png',
  resolution: 'source',
  fps: 'source',
  quality: 'balanced',
  speed: 'veryfast',
  audioBitrate: 192,
  flacCompression: FLAC_COMPRESSION.default,
  mute: false,
  trimStart: null,
  trimEnd: null,
  rotate: 0, // degrees clockwise: 0, 90, 180, 270
  flip: 'none', // none | horizontal | vertical
  // Visible-frame pixels. FFmpeg auto-applies the file's orientation before
  // filters, so these coordinates match the cropper even for phone videos.
  cropAspect: 'free',
  cropX: null,
  cropY: null,
  cropWidth: null,
  cropHeight: null,
  evenDimensions: false,
  mergeFit: 'contain', // contain | cover
  gifFps: 12,
  gifWidth: 480,
  dither: true,
  targetSize: 8, // megabytes
  frameInterval: 1, // seconds between stills
  at: 0, // seconds, for the poster frame
  rawArguments: '-i $in -c copy $out',
};

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return match ? match[1].toLowerCase() : 'bin';
};

const stemOf = (name) => String(name || 'output').replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'output';

/**
 * How long the output will be, which is what the progress bar divides by.
 * Trimming changes it; nothing else does.
 */
function outputDuration(info, options) {
  const total = Number.isFinite(info?.duration) ? info.duration : null;
  const start = Number.isFinite(options.trimStart) ? Math.max(0, options.trimStart) : 0;
  const end = Number.isFinite(options.trimEnd) ? options.trimEnd : null;

  if (end !== null && end > start) return end - start;
  if (total === null) return null;
  return Math.max(0, total - start);
}

/**
 * Seeking arguments.
 *
 * `-ss` goes before `-i` so FFmpeg jumps to the position rather than decoding
 * and discarding everything up to it, and the length is expressed as `-t`
 * rather than `-to` because `-to` means different things depending on which
 * side of `-i` the seek was on, and has changed meaning between versions.
 * A duration is unambiguous everywhere.
 */
function seekArguments(options, duration) {
  const args = [];
  const start = Number.isFinite(options.trimStart) ? Math.max(0, options.trimStart) : 0;
  if (start > 0) args.push('-ss', formatTimestamp(start));
  const end = Number.isFinite(options.trimEnd) ? options.trimEnd : null;
  if (end !== null && end > start) args.push('-t', formatTimestamp(end - start));
  else if (duration !== null && start > 0 && Number.isFinite(duration)) {
    // nothing further to add: the rest of the file is what we want
  }
  return args;
}

/**
 * Bound the frame to a height, and to the width that height implies at 16:9,
 * without ever making anything bigger than it was.
 *
 * `min(iw,W)` rather than a plain `W` is the part people leave out:
 * `force_original_aspect_ratio=decrease` on its own will happily upscale a
 * 320×240 clip to fill a 1280×720 box. `force_divisible_by=2` keeps both
 * dimensions even, which H.264 in yuv420p requires and which an odd source
 * height would otherwise break.
 */
function scaleFilter(height) {
  if (!height) return null;
  const width = Math.round((height * 16) / 9 / 2) * 2;
  return `scale='min(iw,${width})':'min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

function rotationFilters(options) {
  const filters = [];
  const degrees = ((Number(options.rotate) || 0) % 360 + 360) % 360;
  if (degrees === 90) filters.push('transpose=1');
  else if (degrees === 180) filters.push('transpose=1', 'transpose=1');
  else if (degrees === 270) filters.push('transpose=2');

  if (options.flip === 'horizontal') filters.push('hflip');
  else if (options.flip === 'vertical') filters.push('vflip');
  return filters;
}

/**
 * The video filter chain, in the order that costs least and surprises least:
 * drop frames first so nothing downstream works on frames that get thrown
 * away, then crop the auto-oriented picture, then rotate, then scale — so both
 * the crop coordinates and a chosen height describe the picture the user
 * actually sees, not its stored orientation.
 * Optional padding stays last so it repairs the dimensions produced by every
 * earlier geometric transformation without changing their proportions.
 */
function videoFilters(options, { height = null, fps = null, info = null } = {}) {
  const filters = [];
  if (fps) filters.push(`fps=${fps}`);
  const crop = normalizeCropRect(info, options);
  if (crop) filters.push(`crop=${crop.cropWidth}:${crop.cropHeight}:${crop.cropX}:${crop.cropY}`);
  filters.push(...rotationFilters(options));
  const scale = scaleFilter(height);
  if (scale) filters.push(scale);
  if (options.evenDimensions) filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  return filters;
}

const resolutionHeight = (id) => (id && id !== 'source' ? Number(id) || null : null);
const frameRate = (id) => (id && id !== 'source' ? Number(id) || null : null);

/** Constant-quality arguments for whichever video encoder the format uses. */
function videoQualityArguments(encoder, options) {
  const crf = crfFor(encoder, options.quality);
  switch (encoder) {
    case 'libx264':
    case 'libx265':
      return ['-crf', String(crf), '-preset', options.speed || 'veryfast', '-pix_fmt', 'yuv420p'];
    case 'libvpx-vp9':
      // `-b:v 0` is what turns VP9's CRF into true constant quality; without
      // it CRF is only an upper bound and the file comes out much larger.
      return ['-crf', String(crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1'];
    case 'libvpx':
      // VP8 has no `-b:v 0` equivalent, so quality is constrained by a cap.
      return ['-crf', String(crf), '-b:v', '2M', '-deadline', 'good', '-cpu-used', '4'];
    default:
      return [];
  }
}

/** Arguments for an audio encoder, or `-an` when the user asked for silence. */
function audioArguments(formatId, options, { allowNone = true } = {}) {
  if (allowNone && options.mute) return ['-an'];

  const encoder = AUDIO_ENCODERS[formatId] || 'aac';
  const bitrate = Number(options.audioBitrate) || 192;

  switch (encoder) {
    case 'pcm_s16le':
      return ['-c:a', 'pcm_s16le'];
    case 'flac': {
      // Not a quality setting: every level decodes to the same samples. It
      // only decides how hard the encoder looks for a smaller representation.
      const level = Number(options.flacCompression);
      const clamped = Number.isFinite(level)
        ? Math.min(FLAC_COMPRESSION.max, Math.max(FLAC_COMPRESSION.min, Math.round(level)))
        : FLAC_COMPRESSION.default;
      return ['-c:a', 'flac', '-compression_level', String(clamped)];
    }
    case 'libvorbis':
      return ['-c:a', 'libvorbis', '-b:a', `${bitrate}k`];
    default:
      return ['-c:a', encoder, '-b:a', `${bitrate}k`];
  }
}

/** MP4 and MOV keep their index at the end of the file unless told otherwise. */
const faststart = (format) => (format.muxer === 'mp4' || format.muxer === 'mov' || format.muxer === 'ipod' ? ['-movflags', '+faststart'] : []);

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

function buildConvert(source, options, names) {
  const format = formatById(options.format) || formatById(DEFAULT_OPTIONS.format);
  if (format.kind === 'audio') return buildExtractAudio(source, { ...options, audioFormat: format.id }, names);
  if (format.id === 'gif') return buildGif(source, options, names);

  const duration = outputDuration(source.info, options);
  const encoder = format.encoders[0];
  const filters = videoFilters(options, {
    height: resolutionHeight(options.resolution),
    fps: frameRate(options.fps),
    info: source.info,
  });

  const args = [
    ...seekArguments(options, duration),
    '-i', names.input,
    '-c:v', encoder,
    ...videoQualityArguments(encoder, options),
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...(source.info?.hasAudio ? audioArguments(format.encoders[1] === 'libopus' ? 'opus' : format.encoders[1] === 'libvorbis' ? 'ogg' : 'm4a', options) : ['-an']),
    ...faststart(format),
    names.output,
  ];

  return {
    steps: [{ args, label: `Encoding ${format.label}` }],
    inputNames: [names.input],
    outputs: [names.output],
    mime: format.mime,
    downloadName: `${stemOf(source.name)}.${format.extension}`,
    duration,
  };
}

/**
 * The same streams, in a different container.
 *
 * Nothing is decoded and nothing is encoded, so this is bounded by how fast the
 * bytes can be copied rather than by how fast a codec runs — seconds where a
 * conversion is minutes, and bit-for-bit identical output. It is also the only
 * way this app can deal with HEVC or VP9 at all, because both are codecs whose
 * encoders are unusable here while their streams copy perfectly well.
 *
 * The streams are mapped explicitly instead of relying on a bare `-c copy`.
 * `-c copy` takes everything the source has, including subtitle and data
 * tracks, and a subtitle track that the destination muxer will not accept
 * fails the whole job — for a stream nobody asked about, in a file the
 * inspector never mentioned. `0:v:0?` and `0:a:0?` take the first of each, and
 * the trailing `?` makes each one optional so an audio-only source does not
 * fail for want of a picture.
 *
 * There is deliberately no trimming.
 *
 * It looks nearly free — the same copy with `-ss` and `-t` in front — and it is
 * not. A copied stream cannot be cut anywhere except a keyframe, so the cut
 * moves to the previous one, and on a ten-second clip with a keyframe every two
 * seconds, asking for 3.00→5.00 gives a file that reports 2.02 seconds and
 * carries 144 KB where an accurate cut of the same range is 56 KB: the extra
 * second before the mark is in there, hidden ahead of the start offset. Seeking
 * after `-i` instead reports the length correctly and produces the smaller
 * file, but it can leave the output beginning on a frame that references a
 * keyframe which is no longer present, which plays as garbage rather than as a
 * clean cut.
 *
 * Neither is wrong, exactly; both are surprising, and which one is right
 * depends on a keyframe map the user cannot see. So trimming stays with
 * `convert`, where it re-encodes and lands where it was asked to, until there
 * is a timeline that can draw the keyframes and let someone choose against
 * them knowingly.
 */
function buildRemux(source, options, names) {
  const targets = remuxTargets(source.info, source.name);
  if (!targets.length) {
    throw new Error('Nothing here can hold these streams as they are. Convert it instead.');
  }

  // Resolved against what this file can actually become, not against the whole
  // table: a container remembered from the last file may be impossible for this
  // one, and offering it would be a job that fails for a knowable reason.
  const chosen = targets.find((container) => container.id === options.remuxTarget) || targets[0];
  const requested = remuxContainerById(options.remuxTarget);

  const output = `output.${chosen.extension}`;
  const keepsVideo = chosen.kind === 'video' && Boolean(source.info?.hasVideo);

  const args = [
    '-i', names.input,
    ...(keepsVideo ? ['-map', '0:v:0?'] : []),
    ...(source.info?.hasAudio ? ['-map', '0:a:0?'] : []),
    '-c', 'copy',
    ...faststart(chosen),
    output,
  ];

  return {
    steps: [{ args, label: `Repackaging as ${chosen.label}` }],
    inputNames: [names.input],
    outputs: [output],
    mime: chosen.mime,
    downloadName: `${stemOf(source.name)}.${chosen.extension}`,
    // The whole file, always: the progress bar has a total even though a copy
    // finishes long before anyone reads it.
    duration: Number.isFinite(source.info?.duration) ? source.info.duration : null,
    container: chosen.id,
    note: requested && requested.id !== chosen.id
      ? `${requested.label} cannot hold these streams, so this is ${chosen.label}.`
      : undefined,
  };
}

function buildExtractAudio(source, options, names) {
  const format = formatById(options.audioFormat) || formatById('mp3');
  const duration = outputDuration(source.info, options);
  const output = `output.${format.extension}`;

  const args = [
    ...seekArguments(options, duration),
    '-i', names.input,
    '-vn',
    ...audioArguments(format.id, options, { allowNone: false }),
    ...faststart(format),
    output,
  ];

  return {
    steps: [{ args, label: `Encoding ${format.label}` }],
    inputNames: [names.input],
    outputs: [output],
    mime: format.mime,
    downloadName: `${stemOf(source.name)}.${format.extension}`,
    duration,
  };
}

/**
 * A GIF, properly.
 *
 * The single-pass version — `-vf fps=12,scale=480:-1` straight to `.gif` —
 * quantises each frame against a fixed 256-colour web palette and produces
 * the banded, dithered mess people associate with the format. Generating a
 * palette from the actual clip first and then quantising against it is two
 * runs of FFmpeg instead of one, and the difference is not subtle.
 */
function buildGif(source, options, names) {
  const duration = outputDuration(source.info, options);
  const fps = Number(options.gifFps) || 12;
  const width = Number(options.gifWidth) || 480;
  const seek = seekArguments(options, duration);

  const chain = [`fps=${fps}`, ...rotationFilters(options), `scale=${width}:-1:flags=lanczos`].join(',');
  const dither = options.dither === false ? 'dither=none' : 'dither=bayer:bayer_scale=5';

  return {
    steps: [
      {
        label: 'Building a colour palette',
        args: [...seek, '-i', names.input, '-vf', `${chain},palettegen=stats_mode=diff`, '-y', 'palette.png'],
      },
      {
        label: 'Quantising against the palette',
        args: [
          ...seek,
          '-i', names.input,
          '-i', 'palette.png',
          '-lavfi', `${chain}[x];[x][1:v]paletteuse=${dither}:diff_mode=rectangle`,
          '-loop', '0',
          '-y', 'output.gif',
        ],
      },
    ],
    inputNames: [names.input],
    outputs: ['output.gif'],
    mime: 'image/gif',
    downloadName: `${stemOf(source.name)}.gif`,
    duration,
  };
}

/**
 * Aim at a file size.
 *
 * Size is bitrate times duration, so the bitrate falls straight out of the
 * target — minus what the audio will take, and minus a few percent for
 * container overhead, which is real and is why single-pass attempts at this
 * always land slightly over.
 */
function buildCompress(source, options, names) {
  const duration = outputDuration(source.info, options);
  if (!duration || duration <= 0) {
    throw new Error('Compressing to a size needs to know how long the file is, and this one does not say.');
  }

  const targetBytes = Math.max(0.1, Number(options.targetSize) || 8) * 1_000_000;
  const audioKbps = source.info?.hasAudio && !options.mute ? Number(options.audioBitrate) || 128 : 0;
  const overhead = 0.97;
  const totalKbps = (targetBytes * 8 * overhead) / duration / 1000;
  const videoKbps = Math.max(64, Math.round(totalKbps - audioKbps));

  const filters = videoFilters(options, {
    height: resolutionHeight(options.resolution),
    fps: frameRate(options.fps),
    info: source.info,
  });
  const shared = [
    ...seekArguments(options, duration),
    '-i', names.input,
    '-c:v', 'libx264',
    '-b:v', `${videoKbps}k`,
    '-preset', options.speed || 'veryfast',
    '-pix_fmt', 'yuv420p',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
  ];

  return {
    steps: [
      // The first pass writes only statistics; `-f null -` throws the encoded
      // frames away, which is the point — it is measuring, not producing.
      { label: 'Measuring', args: [...shared, '-pass', '1', '-an', '-f', 'null', '-'] },
      {
        label: 'Encoding to size',
        args: [
          ...shared,
          '-pass', '2',
          ...(audioKbps ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`] : ['-an']),
          '-movflags', '+faststart',
          'output.mp4',
        ],
      },
    ],
    inputNames: [names.input],
    outputs: ['output.mp4'],
    mime: 'video/mp4',
    downloadName: `${stemOf(source.name)}.mp4`,
    duration,
    note: `About ${videoKbps} kbps of video${audioKbps ? ` and ${audioKbps} kbps of audio` : ''}.`,
  };
}

function buildFrames(source, options, names) {
  const format = formatById(options.imageFormat) || formatById('png');
  const duration = outputDuration(source.info, options);
  const interval = Math.max(0.02, Number(options.frameInterval) || 1);
  const filters = videoFilters(options, { height: resolutionHeight(options.resolution), info: source.info });

  const args = [
    ...seekArguments(options, duration),
    '-i', names.input,
    '-vf', [`fps=1/${interval}`, ...filters.filter((filter) => !filter.startsWith('fps='))].join(','),
    ...(format.id === 'jpeg' ? ['-q:v', '3'] : []),
    `frame-%04d.${format.extension}`,
  ];

  return {
    steps: [{ args, label: 'Saving frames' }],
    inputNames: [names.input],
    outputs: [],
    outputPrefix: 'frame-',
    mime: format.mime,
    downloadName: `${stemOf(source.name)}-frames.zip`,
    duration,
  };
}

function buildThumbnail(source, options, names) {
  const format = formatById(options.imageFormat) || formatById('png');
  const at = Math.max(0, Number(options.at) || 0);
  const filters = videoFilters(options, { height: resolutionHeight(options.resolution), info: source.info });
  const output = `output.${format.extension}`;

  return {
    steps: [
      {
        label: 'Grabbing a frame',
        args: [
          ...(at > 0 ? ['-ss', formatTimestamp(at)] : []),
          '-i', names.input,
          '-frames:v', '1',
          ...(filters.length ? ['-vf', filters.join(',')] : []),
          ...(format.id === 'jpeg' ? ['-q:v', '2'] : []),
          '-y', output,
        ],
      },
    ],
    inputNames: [names.input],
    outputs: [output],
    mime: format.mime,
    downloadName: `${stemOf(source.name)}.${format.extension}`,
    duration: null,
  };
}

/**
 * Split a command line the way a shell would, minus the parts a shell does
 * that would be dangerous here: no globbing, no variable expansion, no
 * subshells. Only quoting and escaping, because those are what someone
 * pasting an FFmpeg command from the internet will have relied on.
 */
export function splitArguments(text) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];

    if (quote) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"' && i + 1 < text.length) {
        i += 1;
        current += text[i];
      } else current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\' && i + 1 < text.length) {
      i += 1;
      current += text[i];
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }

  if (quote) throw new Error(`Unbalanced ${quote === '"' ? 'double' : 'single'} quote.`);
  if (started) args.push(current);
  return args;
}

function buildRaw(source, options, names) {
  const written = String(options.rawArguments || '').trim();
  if (!written) throw new Error('Nothing to run. Write the arguments you would pass to ffmpeg.');

  const args = splitArguments(written);
  if (!args.some((argument) => argument.includes('$in'))) {
    throw new Error('The command has to read $in somewhere, or there is nothing to convert.');
  }
  const outputArgument = args.find((argument) => argument.includes('$out'));
  if (!outputArgument) {
    throw new Error('The command has to write $out somewhere, or there is nothing to download.');
  }

  // The extension the user wrote after $out decides what the output is called
  // and how the browser will treat it: `$out.mp4` means an MP4.
  const suffix = outputArgument.slice(outputArgument.indexOf('$out') + 4);
  const extension = /^\.[A-Za-z0-9]{1,8}$/.test(suffix) ? suffix.slice(1) : extensionOf(source.name);
  const output = `output.${extension}`;

  return {
    steps: [
      {
        label: 'Running your command',
        args: args.map((argument) => argument.replace(/\$in/g, names.input).replace(/\$out[A-Za-z0-9.]*/g, output)),
      },
    ],
    inputNames: [names.input],
    outputs: [output],
    mime: formatById(extension)?.mime || 'application/octet-stream',
    downloadName: `${stemOf(source.name)}.${extension}`,
    duration: outputDuration(source.info, options),
  };
}

/* ------------------------------------------------------------------ *
 * Multi-file builders
 * ------------------------------------------------------------------ */

/** A stable decimal for filter arguments, without floating-point tails. */
const filterNumber = (value) => String(Number(Number(value).toFixed(6)));

const evenFloor = (value) => Math.max(2, Math.floor(Number(value) / 2) * 2);

/**
 * The first clip defines the canvas. This is predictable when clips have
 * different orientations, and means reordering the project also reorders the
 * one decision that has to win. Display aspect is used when it is available so
 * anamorphic sources become square-pixel output without looking stretched.
 */
function joinCanvas(info, options) {
  const video = info?.video;
  const storedWidth = Number(video?.width);
  const storedHeight = Number(video?.height);
  if (!(storedWidth > 0) || !(storedHeight > 0)) {
    throw new Error('Joining videos needs the dimensions of the first clip.');
  }

  const rotation = ((Number(video.rotation) || 0) % 360 + 360) % 360;
  const quarterTurn = rotation === 90 || rotation === 270;
  const visibleWidth = quarterTurn ? storedHeight : storedWidth;
  const visibleHeight = quarterTurn ? storedWidth : storedHeight;

  const display = /^(\d+):(\d+)$/.exec(String(video.displayAspect || ''));
  let ratio = visibleWidth / visibleHeight;
  if (display && Number(display[1]) > 0 && Number(display[2]) > 0) {
    ratio = Number(display[1]) / Number(display[2]);
    if (quarterTurn) ratio = 1 / ratio;
  }

  const requestedHeight = resolutionHeight(options.resolution);
  const height = evenFloor(requestedHeight ? Math.min(visibleHeight, requestedHeight) : visibleHeight);
  const width = evenFloor(height * ratio);
  return { width, height };
}

function joinFrameRate(first, options) {
  const requested = frameRate(options.fps);
  const sourceRate = Number(first?.info?.video?.fps);
  const chosen = requested || (Number.isFinite(sourceRate) && sourceRate > 0 ? sourceRate : 30);
  // The UI tops out at 60 fps. Keeping the pure builder bounded as well avoids
  // an accidental or hand-written option turning one browser job into 1000 fps.
  return Math.min(60, Math.max(1, chosen));
}

/**
 * Build one normalising concat-filter invocation for two or more video files.
 *
 * This deliberately re-encodes instead of using the concat demuxer with
 * `-c copy`. Matching codec names do not prove matching stream parameters or
 * timestamps, and a heterogeneous copy can exit zero while producing corrupt
 * media. Normalising every segment gives one dependable MP4 across dimensions,
 * frame rates, orientation metadata, sample rates and missing audio tracks.
 *
 * Kept out of `OPERATIONS`: that catalogue drives the single-file inspector,
 * while this builder consumes an ordered project of files.
 *
 * @param {Array<{name: string, info: object}>} sources ordered input clips
 * @param {object} options
 * @returns {Plan}
 */
export function buildJoinVideosPlan(sources, options = {}) {
  if (!Array.isArray(sources) || sources.length < 2) {
    throw new Error('Choose at least two videos to join.');
  }

  for (const source of sources) {
    if (!source?.info?.hasVideo) throw new Error(`${source?.name || 'One input'} has no video track.`);
    if (!Number.isFinite(source.info.duration) || source.info.duration <= 0) {
      throw new Error(`${source.name || 'One input'} does not report a usable duration.`);
    }
  }

  const merged = { ...DEFAULT_OPTIONS, ...options };
  const canvas = joinCanvas(sources[0].info, merged);
  const fps = joinFrameRate(sources[0], merged);
  const fit = merged.mergeFit === 'cover' ? 'cover' : 'contain';
  const keepsAudio = merged.mute !== true && sources.some((source) => source.info.hasAudio);
  const inputNames = sources.map((source, index) => (
    `input-${String(index).padStart(3, '0')}.${extensionOf(source.name)}`
  ));
  const durations = sources.map((source) => Number(source.info.duration));
  const alignedDurations = durations.map((duration) => Math.ceil((duration * fps) - 1e-9) / fps);

  const inputs = inputNames.flatMap((name) => ['-i', name]);
  const filters = [];
  const concatInputs = [];

  for (let index = 0; index < sources.length; index += 1) {
    const duration = filterNumber(durations[index]);
    const aligned = filterNumber(alignedDurations[index]);
    const videoLabel = `v${index}`;
    const audioLabel = `a${index}`;

    const fitFilters = fit === 'cover'
      ? `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
        `crop=${canvas.width}:${canvas.height}:(iw-ow)/2:(ih-oh)/2`
      : `scale='min(iw,${canvas.width})':'min(ih,${canvas.height})':` +
        `force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:black`;

    filters.push(
      `[${index}:v:0]trim=duration=${duration},setpts=PTS-STARTPTS,` +
      `fps=${filterNumber(fps)},tpad=stop_mode=clone:stop_duration=${aligned},` +
      `trim=duration=${aligned},setpts=PTS-STARTPTS,` +
      `scale=trunc(iw*sar/2)*2:ih,setsar=1,${fitFilters},setsar=1,format=yuv420p[${videoLabel}]`
    );
    concatInputs.push(`[${videoLabel}]`);

    if (!keepsAudio) continue;
    if (sources[index].info.hasAudio) {
      filters.push(
        `[${index}:a:0]aresample=48000,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `asetpts=PTS-STARTPTS,apad,atrim=duration=${aligned}[${audioLabel}]`
      );
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${aligned},` +
        `asetpts=PTS-STARTPTS[${audioLabel}]`
      );
    }
    concatInputs.push(`[${audioLabel}]`);
  }

  filters.push(`${concatInputs.join('')}concat=n=${sources.length}:v=1:a=${keepsAudio ? 1 : 0}[v]${keepsAudio ? '[a]' : ''}`);

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(keepsAudio ? ['-map', '[a]'] : []),
    '-map_metadata', '-1',
    '-metadata:s:v:0', 'rotate=0',
    '-c:v', 'libx264',
    ...videoQualityArguments('libx264', merged),
    ...(keepsAudio ? audioArguments('m4a', merged) : ['-an']),
    '-movflags', '+faststart',
    '-y', 'output.mp4',
  ];

  const plan = {
    steps: [{ args, label: `Joining ${sources.length} videos` }],
    inputNames,
    outputs: ['output.mp4'],
    mime: 'video/mp4',
    downloadName: `${stemOf(sources[0].name)}-joined.mp4`,
    duration: durations.reduce((total, duration) => total + duration, 0),
    width: canvas.width,
    height: canvas.height,
    fps,
    fit,
  };

  return finalisePlan('join-videos', plan);
}

const BUILDERS = {
  convert: buildConvert,
  remux: buildRemux,
  'extract-audio': buildExtractAudio,
  gif: buildGif,
  compress: buildCompress,
  frames: buildFrames,
  thumbnail: buildThumbnail,
  raw: buildRaw,
};

function finalisePlan(operation, plan) {
  return {
    operation,
    ...plan,
    // Prepended to every invocation rather than set once, because FFmpeg's
    // verbosity is a process global and this core keeps one process alive for
    // the whole session: a `-v quiet` from an earlier probe, or a debug level
    // left over from anything else, would otherwise decide how much this job
    // prints. At debug level the status line changes shape and progress stops
    // being readable, so the level is stated every time.
    steps: plan.steps.map((step) => ({ ...step, args: ['-hide_banner', '-loglevel', 'info', '-stats', ...step.args] })),
  };
}

/**
 * Build the plan for one job.
 *
 * @param {{name: string, info: object}} source
 * @param {string} operation
 * @param {object} options
 * @returns {Plan}
 */
export function buildPlan(source, operation, options = {}) {
  const build = BUILDERS[operation];
  if (!build) throw new Error(`There is no "${operation}" operation.`);

  const merged = { ...DEFAULT_OPTIONS, ...options };
  const names = { input: `input.${extensionOf(source.name)}`, output: null };
  names.output = `output.${formatById(merged.format)?.extension || 'mp4'}`;

  const plan = build(source, merged, names);

  return finalisePlan(operation, plan);
}

/** The plan as one line, for the command preview and for copying. */
export function planToCommand(plan) {
  const quote = (argument) => (/[\s"'$*?|&;<>()[\]{}\\]/.test(argument) ? `'${argument.replace(/'/g, `'\\''`)}'` : argument);
  return plan.steps.map((step) => `ffmpeg ${step.args.map(quote).join(' ')}`).join('\n');
}
