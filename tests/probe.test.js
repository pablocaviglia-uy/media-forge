/**
 * Tests for the FFmpeg log parser.
 *
 * Every `LOG_*` constant below is real output, captured verbatim from FFmpeg —
 * mostly from a current build, with a couple of older layouts kept on purpose
 * because the compiled core lags the version on a developer's machine by
 * years, and the stream line has changed shape more than once (`tbc` vanished,
 * the `[0x1]` stream identifier appeared, `SAR` lost its brackets in Matroska).
 * Inventing these strings by hand would test the parser against my memory of
 * FFmpeg rather than against FFmpeg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClock,
  parseProbe,
  parseProbeJson,
  parseProgress,
  progressFraction,
  estimateRemaining,
} from '../src/media/probe.js';

/* ------------------------------------------------------------------ *
 * Captured logs
 * ------------------------------------------------------------------ */

const LOG_MP4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf62.12.102
  Duration: 00:00:03.00, start: 0.000000, bitrate: 923 kb/s
  Stream #0:0[0x1](und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 788 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      encoder         : Lavc62.28.102 libx264
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 123 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
At least one output file must be specified`;

const LOG_WEBM = `Input #0, matroska,webm, from 'sample.webm':
  Metadata:
    ENCODER         : Lavf62.12.102
  Duration: 00:00:03.03, start: 0.000000, bitrate: 296 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 30 fps, 30 tbr, 1k tbn (default)
    Metadata:
      ENCODER         : Lavc62.28.102 libvpx-vp9
      DURATION        : 00:00:03.000000000
  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp (default)
    Metadata:
      DURATION        : 00:00:03.026000000
At least one output file must be specified`;

const LOG_MP3 = `Input #0, mp3, from 'sample.mp3':
  Metadata:
    encoder         : Lavf62.12.102
  Duration: 00:00:03.02, start: 0.025057, bitrate: 196 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 192 kb/s, start 0.025057
At least one output file must be specified`;

const LOG_WAV = `[aist#0:0/pcm_s16le @ 0xa7f408180] Guessed Channel Layout: stereo
Input #0, wav, from 'sample.wav':
  Metadata:
    encoder         : Lavf62.12.102
  Duration: 00:00:03.02, bitrate: 1536 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, stereo, s16, 1536 kb/s
At least one output file must be specified`;

const LOG_FLAC = `Input #0, flac, from 'sample.flac':
  Duration: 00:00:03.02, start: 0.000000, bitrate: 438 kb/s
  Stream #0:0: Audio: flac, 44100 Hz, mono, s32 (24 bit)
At least one output file must be specified`;

const LOG_GIF = `Input #0, gif, from 'sample.gif':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 228 kb/s
  Stream #0:0: Video: gif, bgra, 160x120 [SAR 64:64 DAR 4:3], 10 fps, 10 tbr, 100 tbn
At least one output file must be specified`;

const LOG_NO_AUDIO = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'noaudio.mp4':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 794 kb/s
  Stream #0:0[0x1](und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 786 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
At least one output file must be specified`;

/** An FFmpeg 4/5-era line, which is what most compiled cores still print. */
const LOG_OLD_STYLE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'holiday.mp4':
  Duration: 00:01:23.45, start: 0.000000, bitrate: 1589 kb/s
  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 1452 kb/s, 29.97 fps, 29.97 tbr, 30k tbn, 59.94 tbc (default)
  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
At least one output file must be specified`;

/** Surround audio, and a subtitle track that must not be mistaken for either. */
const LOG_SURROUND = `Input #0, matroska,webm, from 'film.mkv':
  Duration: 01:52:07.98, start: 0.000000, bitrate: 8123 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 23.98 fps, 23.98 tbr, 1k tbn (default)
  Stream #0:1(eng): Audio: ac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
  Stream #0:2(eng): Subtitle: subrip (default)
At least one output file must be specified`;

/** An MP3 with cover art: the artwork is a video stream, but not a video. */
const LOG_COVER_ART = `Input #0, mp3, from 'song.mp3':
  Duration: 00:03:45.12, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`;

/* ------------------------------------------------------------------ *
 * Clocks
 * ------------------------------------------------------------------ */

test('clocks parse to seconds', () => {
  assert.equal(parseClock('00:00:03.00'), 3);
  assert.equal(parseClock('00:01:30.50'), 90.5);
  assert.equal(parseClock('01:52:07.98'), 6727.98);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('-577014:32:22.77'), -(577014 * 3600 + 32 * 60 + 22.77));
});

test('anything that is not a clock is null', () => {
  for (const value of ['N/A', '', null, undefined, 'abc', '3.00', '00:03.00']) {
    assert.equal(parseClock(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

test('an MP4 with video and audio is read completely', () => {
  const info = parseProbe(LOG_MP4);

  assert.equal(info.format, 'mov');
  assert.ok(info.formats.includes('mp4'));
  assert.equal(info.duration, 3);
  assert.equal(info.bitrate, 923_000);
  assert.equal(info.startTime, 0);
  assert.equal(info.streams.length, 2);

  assert.equal(info.hasVideo, true);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.video.profile, 'Constrained Baseline');
  assert.equal(info.video.width, 320);
  assert.equal(info.video.height, 240);
  assert.equal(info.video.displayAspect, '4:3');
  assert.equal(info.video.pixelFormat, 'yuv420p');
  assert.equal(info.video.fps, 30);
  assert.equal(info.video.bitrate, 788_000);
  assert.equal(info.video.startTime, null, 'the fallback must not invent a per-stream origin');

  assert.equal(info.hasAudio, true);
  assert.equal(info.audio.codec, 'aac');
  assert.equal(info.audio.profile, 'LC');
  assert.equal(info.audio.sampleRate, 44_100);
  assert.equal(info.audio.channels, 1);
  assert.equal(info.audio.channelLayout, 'mono');
  assert.equal(info.audio.sampleFormat, 'fltp');
  assert.equal(info.audio.bitrate, 123_000);
  assert.equal(info.audio.startTime, null, 'the fallback must not reuse the container start per stream');
});

test('ffprobe JSON preserves each stream start on a shared container timeline', () => {
  const info = parseProbeJson(JSON.stringify({
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '9.023000',
      start_time: '5.000000',
    },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 320,
        height: 240,
        duration: '3.000000',
        start_time: '5.000000',
        avg_frame_rate: '30/1',
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        duration: '3.023000',
        start_time: '6.000000',
        sample_rate: '48000',
        channels: 2,
      },
    ],
  }));

  assert.equal(info.startTime, 5);
  assert.equal(info.video.startTime, 5);
  assert.equal(info.audio.startTime, 6);
  assert.equal(info.streams[0].startTime, 5);
  assert.equal(info.streams[1].startTime, 6);
});

test('Matroska prints SAR without brackets and it still parses', () => {
  const info = parseProbe(LOG_WEBM);
  assert.equal(info.format, 'matroska');
  assert.equal(info.video.codec, 'vp9');
  assert.equal(info.video.width, 320);
  assert.equal(info.video.height, 240);
  assert.equal(info.video.fps, 30);
  assert.equal(info.video.pixelFormat, 'yuv420p');
  // Opus in Matroska carries no bitrate at all; that has to stay null rather
  // than becoming zero, which would read as "silence" in the UI.
  assert.equal(info.audio.codec, 'opus');
  assert.equal(info.audio.bitrate, null);
  assert.equal(info.audio.sampleRate, 48_000);
});

test('an audio-only file reports no video', () => {
  const info = parseProbe(LOG_MP3);
  assert.equal(info.hasVideo, false);
  assert.equal(info.video, null);
  assert.equal(info.audio.codec, 'mp3');
  assert.equal(info.audio.bitrate, 192_000);
  assert.equal(info.startTime, 0.025057);
});

test('a bracketed codec tag does not confuse the field split', () => {
  const info = parseProbe(LOG_WAV);
  assert.equal(info.audio.codec, 'pcm_s16le');
  assert.equal(info.audio.profile, null); // `[1][0][0][0] / 0x0001` is a tag
  assert.equal(info.audio.channels, 2);
  assert.equal(info.audio.sampleRate, 48_000);
  assert.equal(info.audio.bitrate, 1_536_000);
});

test('a stream with no bitrate and a bit-depth suffix parses', () => {
  const info = parseProbe(LOG_FLAC);
  assert.equal(info.audio.codec, 'flac');
  assert.equal(info.audio.sampleFormat, 's32');
  assert.equal(info.audio.bitrate, null);
});

test('a GIF is video with no audio', () => {
  const info = parseProbe(LOG_GIF);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, false);
  assert.equal(info.video.codec, 'gif');
  assert.equal(info.video.width, 160);
  assert.equal(info.video.height, 120);
  assert.equal(info.video.fps, 10);
  assert.equal(info.video.pixelFormat, 'bgra');
});

test('a silent video reports no audio', () => {
  const info = parseProbe(LOG_NO_AUDIO);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, false);
  assert.equal(info.audio, null);
});

test('the older stream layout, with tbc, still parses', () => {
  const info = parseProbe(LOG_OLD_STYLE);
  assert.equal(info.duration, 83.45);
  assert.equal(info.video.width, 1920);
  assert.equal(info.video.height, 1080);
  assert.equal(info.video.fps, 29.97);
  assert.equal(info.video.profile, 'High');
  assert.equal(info.video.pixelFormat, 'yuv420p');
  assert.equal(info.audio.channels, 2);
  assert.equal(info.audio.language, 'eng');
});

test('surround layouts count their channels, and subtitles stay out of the way', () => {
  const info = parseProbe(LOG_SURROUND);
  assert.equal(info.duration, 6727.98);
  assert.equal(info.video.codec, 'hevc');
  assert.equal(info.video.width, 3840);
  assert.equal(info.audio.channelLayout, '5.1(side)');
  assert.equal(info.audio.channels, 6);
  assert.equal(info.streams.length, 3);
  assert.equal(info.streams[2].kind, 'subtitle');
  assert.equal(info.streams[2].codec, 'subrip');
});

test('cover art does not make an MP3 into a video', () => {
  const info = parseProbe(LOG_COVER_ART);
  assert.equal(info.hasAudio, true);
  assert.equal(info.hasVideo, false, 'attached artwork was promoted to a video track');
  assert.equal(info.streams.length, 2);
});

test('an empty or unrecognised log yields an empty description rather than throwing', () => {
  for (const value of ['', null, undefined, 'ffmpeg: command not found']) {
    const info = parseProbe(value);
    assert.equal(info.duration, null);
    assert.equal(info.hasVideo, false);
    assert.equal(info.hasAudio, false);
    assert.deepEqual(info.streams, []);
  }
});

test('carriage returns in the log do not break line splitting', () => {
  assert.deepEqual(parseProbe(LOG_MP4.replace(/\n/g, '\r\n')), parseProbe(LOG_MP4));
});

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

test('a finished-encode status line parses', () => {
  const progress = parseProgress(
    'frame=   90 fps=0.0 q=-1.0 Lsize=     230KiB time=00:00:03.00 bitrate= 627.6kbits/s speed= 112x elapsed=0:00:00.02'
  );
  assert.equal(progress.frame, 90);
  assert.equal(progress.fps, 0);
  assert.equal(progress.time, 3);
  assert.equal(progress.speed, 112);
  assert.equal(progress.size, 230 * 1024);
  assert.equal(progress.bitrate, 627_600);
});

test('the mid-encode status line, with kB rather than KiB, parses', () => {
  const progress = parseProgress(
    'frame=  120 fps= 30 q=28.0 size=    1024kB time=00:00:04.00 bitrate=2097.2kbits/s speed=1.02x'
  );
  assert.equal(progress.frame, 120);
  assert.equal(progress.fps, 30);
  assert.equal(progress.size, 1_024_000);
  assert.equal(progress.speed, 1.02);
});

test('an audio-only status line has no frame count', () => {
  const progress = parseProgress('size=     512kB time=00:00:01.50 bitrate= 2796.2kbits/s speed=  25x');
  assert.equal(progress.frame, null);
  assert.equal(progress.time, 1.5);
  assert.equal(progress.speed, 25);
});

test('N/A fields become null instead of zero', () => {
  const progress = parseProgress('frame=    0 fps=0.0 q=0.0 size=N/A time=N/A bitrate=N/A speed=N/A');
  assert.equal(progress.size, null);
  assert.equal(progress.time, null);
  assert.equal(progress.bitrate, null);
  assert.equal(progress.speed, null);
});

test('the huge negative timestamp FFmpeg prints before the first frame is discarded', () => {
  const progress = parseProgress(
    'frame=    0 fps=0.0 q=0.0 size=       0kB time=-577014:32:22.77 bitrate=N/A speed=N/A'
  );
  assert.equal(progress.time, null, 'a negative timestamp would run the progress bar backwards');
});

test('lines that are not status lines are rejected', () => {
  for (const line of [
    '',
    'Input #0, mp3, from \'sample.mp3\':',
    '  Stream #0:0: Audio: mp3, 44100 Hz, mono',
    '[libx264 @ 0x7f8] frame I:1     Avg QP:25.00  size:  6164',
  ]) {
    assert.equal(parseProgress(line), null, `expected null for ${JSON.stringify(line)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Deriving progress and estimates
 * ------------------------------------------------------------------ */

test('progress is a clamped fraction of the expected duration', () => {
  assert.equal(progressFraction({ time: 3 }, 12), 0.25);
  assert.equal(progressFraction({ time: 20 }, 12), 1, 'progress past the end must clamp');
  assert.equal(progressFraction({ time: null }, 12), null);
  assert.equal(progressFraction(null, 12), null);
  assert.equal(progressFraction({ time: 3 }, 0), null);
  assert.equal(progressFraction({ time: 3 }, null), null);
});

test('the estimate divides the media left by the reported speed', () => {
  assert.equal(estimateRemaining({ time: 10, speed: 2 }, 30), 10);
  assert.equal(estimateRemaining({ time: 30, speed: 2 }, 30), 0);
  assert.equal(estimateRemaining({ time: 10, speed: 0 }, 30), null, 'a zero speed would divide by zero');
  assert.equal(estimateRemaining({ time: null, speed: 2 }, 30), null);
});
