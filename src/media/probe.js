/**
 * Reading what a file actually is.
 *
 * There are two ways to ask, and this module implements both because neither
 * covers the other's failures.
 *
 * `ffprobe` is compiled into the core alongside `ffmpeg`, and asking it for
 * `-print_format json` gives exact, typed, unambiguous metadata. That is the
 * path the app takes. `parseProbeJson` normalises its output.
 *
 * It also, occasionally, refuses. A truncated download or a container with a
 * damaged index can make `ffprobe` produce nothing while `ffmpeg -i file`
 * still prints a perfectly good description of the streams before exiting
 * with an error about the missing output file. `parseProbe` reads that
 * description out of the log. It is less precise — FFmpeg rounds the duration
 * to hundredths and omits fields it considers uninteresting — but it is
 * strictly more tolerant, so it is worth having as the second attempt.
 *
 * Both produce the same shape, and the test suite runs them against each
 * other on the same files to keep it that way.
 *
 * The alternative to both — reading duration and dimensions from a hidden
 * `<video>` element — is cheaper but only knows the formats the browser can
 * decode, which excludes most of the interesting inputs. Shipping FFmpeg and
 * then asking the browser would be a strange way round.
 *
 * Everything here is a pure function over text, which is why it is testable
 * without a browser or a 30 MB WebAssembly module.
 */

/** `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':` */
const INPUT_LINE = /^Input #(\d+),\s*(.+?),\s*from\s+'(.*)':\s*$/;

/** `Duration: 00:00:03.00, start: 0.000000, bitrate: 923 kb/s` */
const DURATION_LINE = /^\s*Duration:\s*(N\/A|\d+:\d{2}:\d{2}(?:\.\d+)?)/;
const START_FIELD = /\bstart:\s*(-?[\d.]+)/;
const BITRATE_FIELD = /\bbitrate:\s*(\d+(?:\.\d+)?)\s*(k|m)?b\/s/i;

/**
 * A stream's own rate is an unlabelled field — `788 kb/s` — while the
 * container's is labelled `bitrate: 923 kb/s`. Matching the labelled form
 * against a stream field finds nothing, and matching the unlabelled form
 * against the duration line would pick up the wrong number, so they are
 * deliberately two patterns.
 *
 * The trailing `(...)` is FFmpeg's stream disposition — `(default)`,
 * `(forced)`, `(attached pic)` — which it appends to the final field without
 * a comma, so the last field of a line is regularly `123 kb/s (default)`.
 */
const RATE_FIELD = /^(\d+(?:\.\d+)?)\s*(k|m)?b\/s(?:\s*\(.*\))?$/i;
const FPS_FIELD = /^([\d.]+)\s*fps(?:\s*\(.*\))?$/;

/**
 * `Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, ...`
 *
 * The `[0x2]` identifier and the `(und)` language are both optional, and older
 * builds print neither.
 *
 * Above `info` verbosity FFmpeg also slips the stream's reference count and
 * time base in before the colon — `(und), 1, 1/44100:` — and that has to be
 * tolerated rather than avoided: verbosity in this build is a process global
 * that survives between invocations and that a later `-loglevel info` does
 * not reliably bring back down, so by the time this parser sees a log there
 * is no guarantee about which level produced it.
 */
const STREAM_LINE = /^\s*Stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?(?:,[\s\d/,]+)?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*(.*)$/;

/** `frame=  90 fps=0.0 q=-1.0 Lsize=  230KiB time=00:00:03.00 bitrate=627.6kbits/s speed=112x` */
const PROGRESS_TIME = /\btime=\s*(-?\d+:\d{2}:\d{2}(?:\.\d+)?|N\/A)/;
const PROGRESS_FRAME = /\bframe=\s*(\d+)/;
const PROGRESS_FPS = /\bfps=\s*([\d.]+)/;
const PROGRESS_SPEED = /\bspeed=\s*([\d.]+)\s*x/;
const PROGRESS_SIZE = /\b[Ll]?size=\s*(\d+(?:\.\d+)?)\s*(k|K|Ki|M|Mi|G|Gi)?B/;
const PROGRESS_BITRATE = /\bbitrate=\s*([\d.]+)\s*(k|m)?bits\/s/i;

/**
 * Split on commas that are not inside brackets. FFmpeg writes fields like
 * `yuv420p(tv, progressive)` and `Audio: pcm_s16le ([1][0][0][0] / 0x0001)`,
 * so a plain `split(',')` tears them apart.
 */
function splitFields(text) {
  const fields = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      fields.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  fields.push(text.slice(start).trim());
  return fields.filter(Boolean);
}

/** `00:00:03.00` and `1:02:03.5` alike; `N/A` and nonsense become null. */
export function parseClock(text) {
  const match = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(text || '').trim());
  if (!match) return null;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  return match[1] ? -seconds : seconds;
}

function scaleRate(value, unit) {
  const suffix = (unit || '').toLowerCase();
  return Number(value) * (suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1);
}

/** The container's rate, from the `Duration:` line. */
function parseBitrate(text) {
  const match = BITRATE_FIELD.exec(text);
  return match ? scaleRate(match[1], match[2]) : null;
}

/** One stream's rate, from an unlabelled `788 kb/s` field. */
function parseRate(field) {
  const match = RATE_FIELD.exec(field);
  return match ? scaleRate(match[1], match[2]) : null;
}

/**
 * The first field of a stream line is the codec, optionally followed by
 * parenthesised detail: `h264 (Constrained Baseline) (avc1 / 0x31637661)`.
 */
function parseCodecField(field) {
  const name = field.split(/[\s(]/)[0] || '';
  const profile = /^[\w.-]+\s+\(([^)]+)\)/.exec(field);
  return {
    codec: name,
    // `(avc1 / 0x31637661)` is a tag, not a profile; a profile never has a slash.
    profile: profile && !profile[1].includes('/') ? profile[1] : null,
  };
}

function parseVideoStream(fields) {
  const stream = { ...parseCodecField(fields[0]), width: null, height: null, pixelFormat: null, fps: null, bitrate: null };

  for (const field of fields.slice(1)) {
    const size = /^(\d{1,5})x(\d{1,5})\b/.exec(field);
    if (size && stream.width === null) {
      stream.width = Number(size[1]);
      stream.height = Number(size[2]);
      const dar = /DAR (\d+):(\d+)/.exec(field);
      if (dar) stream.displayAspect = `${dar[1]}:${dar[2]}`;
      continue;
    }

    const fps = FPS_FIELD.exec(field);
    if (fps) {
      stream.fps = Number(fps[1]);
      continue;
    }

    const rate = parseRate(field);
    if (rate !== null && stream.bitrate === null) {
      stream.bitrate = rate;
      continue;
    }

    // Anything left that looks like a pixel format: `yuv420p`, `yuvj420p(pc)`,
    // `yuv420p(tv, progressive)`, `bgra`. Take the first such field only.
    if (stream.pixelFormat === null && /^[a-z][a-z0-9]+(\([^)]*\))?$/.test(field) && !/^(tbr|tbn|tbc)$/.test(field)) {
      stream.pixelFormat = field.split('(')[0];
    }
  }

  return stream;
}

/** Channel descriptions FFmpeg prints, and how many channels each means. */
const CHANNEL_COUNTS = {
  mono: 1,
  stereo: 2,
  downmix: 2,
  '2.1': 3,
  '3.0': 3,
  '4.0': 4,
  quad: 4,
  '5.0': 5,
  '5.1': 6,
  '6.1': 7,
  '7.1': 8,
};

function parseAudioStream(fields) {
  const stream = {
    ...parseCodecField(fields[0]),
    sampleRate: null,
    channels: null,
    channelLayout: null,
    sampleFormat: null,
    bitrate: null,
  };

  for (const field of fields.slice(1)) {
    const rate = /^(\d+)\s*Hz$/.exec(field);
    if (rate) {
      stream.sampleRate = Number(rate[1]);
      continue;
    }

    // `5.1(side)` and `stereo` alike; the parenthesised part is a layout variant.
    const layout = field.replace(/\(.*\)$/, '');
    if (stream.channelLayout === null && layout in CHANNEL_COUNTS) {
      stream.channelLayout = field;
      stream.channels = CHANNEL_COUNTS[layout];
      continue;
    }
    const explicit = /^(\d+)\s*channels?$/.exec(field);
    if (explicit) {
      stream.channels = Number(explicit[1]);
      stream.channelLayout = field;
      continue;
    }

    const bitrate = parseRate(field);
    if (bitrate !== null && stream.bitrate === null) {
      stream.bitrate = bitrate;
      continue;
    }

    // `fltp`, `s16`, `s32 (24 bit)`.
    if (stream.sampleFormat === null && /^(u8|s16|s32|s64|flt|dbl)p?(\s|$|\()/.test(field)) {
      stream.sampleFormat = field.split(/\s|\(/)[0];
    }
  }

  return stream;
}

/**
 * Turn the log FFmpeg wrote while opening a file into something the UI can
 * show and the command builder can reason about.
 *
 * @param {string} log every line FFmpeg emitted, in order
 * @returns {{format: string|null, formats: string[], duration: number|null,
 *   bitrate: number|null, startTime: number|null, streams: object[],
 *   video: object|null, audio: object|null, hasVideo: boolean, hasAudio: boolean}}
 */
export function parseProbe(log) {
  const info = {
    format: null,
    formats: [],
    duration: null,
    bitrate: null,
    startTime: null,
    streams: [],
    video: null,
    audio: null,
    hasVideo: false,
    hasAudio: false,
  };

  let seenInput = false;

  for (const raw of String(log || '').split(/\r?\n/)) {
    const line = raw.replace(/\r/g, '');

    const input = INPUT_LINE.exec(line.trim());
    if (input) {
      // Only the first input is described; later ones belong to filters.
      if (seenInput) break;
      seenInput = true;
      info.formats = input[2].split(',').map((name) => name.trim()).filter(Boolean);
      info.format = info.formats[0] || null;
      continue;
    }

    const duration = DURATION_LINE.exec(line);
    if (duration && info.duration === null) {
      info.duration = parseClock(duration[1]);
      const start = START_FIELD.exec(line);
      if (start) info.startTime = Number(start[1]);
      info.bitrate = parseBitrate(line);
      continue;
    }

    const stream = STREAM_LINE.exec(line);
    if (!stream) continue;

    const kind = stream[4].toLowerCase();
    const fields = splitFields(stream[5]);
    const common = {
      index: Number(stream[2]),
      input: Number(stream[1]),
      language: stream[3] && stream[3] !== 'und' ? stream[3] : null,
      kind,
      default: /\(default\)/.test(stream[5]),
    };

    let parsed;
    if (kind === 'video') parsed = parseVideoStream(fields);
    else if (kind === 'audio') parsed = parseAudioStream(fields);
    else parsed = parseCodecField(fields[0] || '');

    const full = { ...common, ...parsed };
    info.streams.push(full);

    // An attached cover image is a video stream as far as FFmpeg is concerned.
    // Treating an MP3 with artwork as a video file would offer the user a list
    // of nonsense conversions, so those are recorded but never promoted.
    const isCoverArt = kind === 'video' && /^(mjpeg|png|bmp|gif)$/.test(parsed.codec) && !parsed.fps;
    if (kind === 'video' && !info.video && !isCoverArt) {
      info.video = full;
      info.hasVideo = true;
    }
    if (kind === 'audio' && !info.audio) {
      info.audio = full;
      info.hasAudio = true;
    }
  }

  return info;
}

/* ------------------------------------------------------------------ *
 * ffprobe JSON
 * ------------------------------------------------------------------ */

/** ffprobe writes every number as a string, and `N/A` for the ones it lacks. */
function num(value) {
  if (value === undefined || value === null || value === 'N/A') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Frame rates arrive as the exact rational FFmpeg holds: `30/1`, `30000/1001`, `0/0`. */
function ratio(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  const denominator = Number(match[2]);
  if (!denominator) return null;
  const rate = Number(match[1]) / denominator;
  // 29.97 rather than 29.969999999999999, without flattening 23.976 to 24.
  return Math.round(rate * 1000) / 1000;
}

/**
 * Normalise `ffprobe -print_format json -show_format -show_streams` into the
 * same description `parseProbe` produces.
 *
 * @param {string} json
 * @returns {object|null} null when the text is not usable, so a caller can
 *   fall back to the log parser rather than show an empty file.
 */
export function parseProbeJson(json) {
  let data;
  try {
    data = JSON.parse(String(json || ''));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.streams) || data.streams.length === 0) return null;

  const container = data.format || {};
  const formats = String(container.format_name || '').split(',').map((name) => name.trim()).filter(Boolean);

  const info = {
    format: formats[0] || null,
    formats,
    formatLabel: container.format_long_name || null,
    duration: num(container.duration),
    bitrate: num(container.bit_rate),
    startTime: num(container.start_time),
    streams: [],
    video: null,
    audio: null,
    hasVideo: false,
    hasAudio: false,
  };

  for (const raw of data.streams) {
    const kind = String(raw.codec_type || '').toLowerCase();
    const stream = {
      index: num(raw.index) ?? 0,
      input: 0,
      kind,
      codec: raw.codec_name || null,
      profile: raw.profile && raw.profile !== 'unknown' ? String(raw.profile) : null,
      language: raw.tags?.language && raw.tags.language !== 'und' ? raw.tags.language : null,
      default: raw.disposition?.default === 1,
      bitrate: num(raw.bit_rate),
      duration: num(raw.duration),
    };

    if (kind === 'video') {
      Object.assign(stream, {
        width: num(raw.width),
        height: num(raw.height),
        pixelFormat: raw.pix_fmt || null,
        // `avg_frame_rate` is the honest one for a variable-rate file;
        // `r_frame_rate` is the base rate the container advertises.
        fps: ratio(raw.avg_frame_rate) ?? ratio(raw.r_frame_rate),
        displayAspect: raw.display_aspect_ratio || null,
        rotation: num(raw.side_data_list?.find((item) => 'rotation' in item)?.rotation),
        attachedPicture: raw.disposition?.attached_pic === 1,
      });
    } else if (kind === 'audio') {
      Object.assign(stream, {
        sampleRate: num(raw.sample_rate),
        channels: num(raw.channels),
        channelLayout: raw.channel_layout || null,
        sampleFormat: raw.sample_fmt || null,
      });
    }

    info.streams.push(stream);

    // Cover art is a video stream with one frame in it. Promoting it would
    // offer to "convert this MP3 to WebM", which is not what anyone means.
    if (kind === 'video' && !info.video && !stream.attachedPicture) {
      info.video = stream;
      info.hasVideo = true;
    }
    if (kind === 'audio' && !info.audio) {
      info.audio = stream;
      info.hasAudio = true;
    }
  }

  // Some containers put the duration only on the streams.
  if (info.duration === null) {
    const durations = info.streams.map((stream) => stream.duration).filter((value) => value !== null);
    if (durations.length) info.duration = Math.max(...durations);
  }

  return info;
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * Parse one of the status lines FFmpeg overwrites in place while encoding.
 * They arrive carriage-return separated rather than newline separated, so the
 * caller usually splits on both.
 *
 * @returns {{time: number|null, frame: number|null, fps: number|null,
 *   speed: number|null, size: number|null, bitrate: number|null}|null}
 *   null when the line is not a status line at all.
 */
export function parseProgress(line) {
  const text = String(line || '');
  const time = PROGRESS_TIME.exec(text);
  if (!time && !PROGRESS_FRAME.test(text)) return null;

  const frame = PROGRESS_FRAME.exec(text);
  const fps = PROGRESS_FPS.exec(text);
  const speed = PROGRESS_SPEED.exec(text);
  const size = PROGRESS_SIZE.exec(text);
  const bitrate = PROGRESS_BITRATE.exec(text);

  const seconds = time ? parseClock(time[1]) : null;

  return {
    // FFmpeg prints a huge negative timestamp before the first frame lands.
    time: seconds !== null && seconds >= 0 ? seconds : null,
    frame: frame ? Number(frame[1]) : null,
    fps: fps ? Number(fps[1]) : null,
    speed: speed ? Number(speed[1]) : null,
    size: size ? Number(size[1]) * sizeUnit(size[2]) : null,
    bitrate: bitrate ? Number(bitrate[1]) * (bitrate[2]?.toLowerCase() === 'm' ? 1e6 : 1e3) : null,
  };
}

/* ------------------------------------------------------------------ *
 * The progress pipe
 * ------------------------------------------------------------------ */

/**
 * `-progress` writes one `key=value` per line, in blocks terminated by
 * `progress=continue` or `progress=end`.
 *
 * This exists because the status line does not survive the trip. FFmpeg
 * overwrites it in place with a carriage return and no newline, and the
 * runtime this core is compiled against only flushes its output buffer on a
 * newline — so every status line of a two-minute encode arrives at once, when
 * the encode is already over. The progress pipe is newline-terminated, so it
 * arrives while there is still something to report.
 *
 * @returns {{key: string, value: string}|null}
 */
export function parseProgressLine(line) {
  const match = /^([a-z_]+)=(.*)$/.exec(String(line || '').trim());
  return match ? { key: match[1], value: match[2] } : null;
}

/**
 * Turn one accumulated block into the same shape `parseProgress` produces.
 *
 * @param {Record<string, string>} report
 */
export function progressFromReport(report) {
  const microseconds = report.out_time_us ?? report.out_time_ms;
  // `out_time_ms` is misnamed in FFmpeg and holds microseconds too, which is
  // a trap worth only falling into once.
  const seconds = microseconds !== undefined && microseconds !== 'N/A' ? Number(microseconds) / 1e6 : null;
  const speed = /^([\d.]+)x$/.exec(report.speed || '');

  return {
    time: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
    frame: report.frame !== undefined && report.frame !== 'N/A' ? Number(report.frame) : null,
    fps: report.fps !== undefined && report.fps !== 'N/A' ? Number(report.fps) : null,
    speed: speed ? Number(speed[1]) : null,
    size: report.total_size !== undefined && report.total_size !== 'N/A' ? Number(report.total_size) : null,
    bitrate: null,
    done: report.progress === 'end',
  };
}

/** FFmpeg mixes `kB` (1000) and `KiB` (1024) across versions; honour both. */
function sizeUnit(suffix) {
  switch (suffix) {
    case 'Ki': return 1024;
    case 'Mi': return 1024 ** 2;
    case 'Gi': return 1024 ** 3;
    case 'k':
    case 'K': return 1000;
    case 'M': return 1e6;
    case 'G': return 1e9;
    default: return 1;
  }
}

/**
 * How far through the job we are, as a fraction. FFmpeg reports the output
 * timestamp it has reached, so the total has to come from the probe — and for
 * a trimmed job the total is the length of the trim, not of the file.
 */
export function progressFraction(progress, totalSeconds) {
  if (!progress || progress.time === null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  return Math.min(1, Math.max(0, progress.time / totalSeconds));
}

/**
 * Seconds of wall-clock work left, from the encoding speed FFmpeg reports.
 * `speed` is media-seconds per wall-second, so the arithmetic is direct.
 */
export function estimateRemaining(progress, totalSeconds) {
  if (!progress || !progress.speed || progress.time === null) return null;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  const left = totalSeconds - progress.time;
  if (left <= 0) return 0;
  return left / progress.speed;
}
