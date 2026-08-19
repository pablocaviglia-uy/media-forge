/**
 * The command builder, against the FFmpeg that actually ships.
 *
 * `commands.test.js` checks that the builder produces the arguments it is
 * supposed to. That is necessary and not sufficient: an argument list can be
 * perfectly well-formed and still be rejected by the binary, because the
 * encoder is not compiled in, or the filter changed its syntax three versions
 * ago, or the muxer will not accept that codec. The only way to know is to run
 * it.
 *
 * So this file loads the vendored core — the same 32 MB of WebAssembly the
 * deployed site loads — has it synthesise its own test clip with `lavfi`, and
 * runs every operation end to end. Nothing is committed to the repository to
 * make this work: no sample media, no golden files, and no locally installed
 * ffmpeg. The core is the fixture.
 *
 * It is the slow suite. It is also the one that would have caught every
 * mistake worth catching.
 */

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { isFatal } from '../src/ffmpeg/failures.js';

import { buildPlan, buildJoinVideosPlan, buildAddAudioPlan } from '../src/media/commands.js';
import { parseProbeJson, parseProbe } from '../src/media/probe.js';
import { parseEncoders, parseMuxers, missingFor } from '../src/ffmpeg/capabilities.js';
import { VIDEO_FORMATS, AUDIO_FORMATS, IMAGE_FORMATS, remuxTargets } from '../src/media/formats.js';

const CORE_DIRECTORY = new URL('../assets/ffmpeg/', import.meta.url);
const CORE_SCRIPT = new URL('ffmpeg-core.js', CORE_DIRECTORY);
const CORE_WASM = new URL('ffmpeg-core.wasm', CORE_DIRECTORY);

const VENDORED = existsSync(fileURLToPath(CORE_SCRIPT)) && existsSync(fileURLToPath(CORE_WASM));

let core = null;
let capabilities = null;
let lines = [];

/**
 * The core is compiled for a Web Worker: it reads `self.location.href` to
 * work out where its own `.wasm` sits. Node has neither, so both are supplied
 * before the import, and the WebAssembly is handed over directly rather than
 * fetched.
 */
async function loadCore() {
  globalThis.self = globalThis;
  globalThis.location = new URL(CORE_SCRIPT);

  const { default: createFFmpegCore } = await import(CORE_SCRIPT.href);
  const instance = await createFFmpegCore({ wasmBinary: readFileSync(CORE_WASM) });
  instance.setLogger(({ type, message }) => lines.push({ type, message }));
  return instance;
}

/** Run one FFmpeg invocation and return its exit code and everything it said. */
function exec(...args) {
  lines = [];
  core.reset();
  const code = core.exec(...args);
  const log = lines;
  lines = [];
  return { code, log, text: log.map((entry) => entry.message).join('\n') };
}

/**
 * Read ffprobe's report out of a file, exactly as the worker does. Taking it
 * off stdout looks simpler and works right up until a second invocation, at
 * which point this build interleaves decoder debug lines into the JSON.
 */
function ffprobeJson(name) {
  lines = [];
  core.reset();
  core.ffprobe('-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-o', 'report.json', name);
  lines = [];
  try {
    const json = new TextDecoder().decode(core.FS.readFile('report.json'));
    core.FS.unlink('report.json');
    return json;
  } catch {
    return '';
  }
}

/** Every step of a plan, in order, failing loudly with FFmpeg's own words. */
function runPlan(plan) {
  for (const step of plan.steps) {
    const { code, text } = exec(...step.args);
    assert.equal(
      code,
      0,
      `step "${step.label}" failed (exit ${code})\n  ffmpeg ${step.args.join(' ')}\n${text.split('\n').slice(-8).join('\n')}`
    );
  }
}

/** The argument that follows a flag, for asserting on what a plan asks for. */
const valueAfter = (args, flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const sizeOf = (name) => {
  try {
    return core.FS.readFile(name).length;
  } catch {
    return 0;
  }
};

const source = (name, info) => ({ name, info });

let clip = null; // the synthesised source, probed

before(async () => {
  if (!VENDORED) return;
  core = await loadCore();

  capabilities = {
    encoders: parseEncoders(exec('-hide_banner', '-loglevel', 'info', '-encoders').text),
    muxers: parseMuxers(exec('-hide_banner', '-loglevel', 'info', '-muxers').text),
  };

  // Three seconds of moving picture and a tone, small enough that a dozen
  // encodes stay quick and long enough that trimming and frame extraction
  // have something to work with.
  const { code, text } = exec(
    '-f', 'lavfi', '-i', 'testsrc2=size=192x144:rate=15:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest',
    'input.mp4'
  );
  assert.equal(code, 0, `could not synthesise the test clip:\n${text.split('\n').slice(-8).join('\n')}`);

  clip = source('holiday.mp4', parseProbeJson(ffprobeJson('input.mp4')));
});

describe('the vendored core', { skip: VENDORED ? false : 'assets/ffmpeg is empty — run `node tools/fetch-core.mjs`' }, () => {
  test('is the version the manifest claims', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', CORE_DIRECTORY), 'utf8'));
    const reported = /ffmpeg version (\S+)/.exec(exec('-hide_banner', '-loglevel', 'info', '-version').text)?.[1];
    assert.equal(reported, manifest.ffmpeg.version);
  });

  test('has every encoder and muxer the format table asks for', () => {
    const missing = [];
    for (const format of [...VIDEO_FORMATS, ...AUDIO_FORMATS, ...IMAGE_FORMATS]) {
      const absent = missingFor(capabilities, format);
      if (absent.length) missing.push(`${format.id} needs ${absent.join(', ')}`);
    }
    assert.deepEqual(missing, [], `formats.js offers what this core cannot do:\n  ${missing.join('\n  ')}`);
  });

  test('describes the synthesised clip the way it was asked for', () => {
    assert.equal(clip.info.hasVideo, true);
    assert.equal(clip.info.hasAudio, true);
    assert.equal(clip.info.video.width, 192);
    assert.equal(clip.info.video.height, 144);
    assert.equal(clip.info.video.fps, 15);
    assert.equal(clip.info.video.codec, 'h264');
    assert.equal(clip.info.audio.codec, 'aac');
    assert.ok(Math.abs(clip.info.duration - 3) < 0.2, `duration was ${clip.info.duration}`);
  });
});

describe('ffprobe and the log agree', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('on the same file, both parsers describe the same media', () => {
    const fromJson = parseProbeJson(ffprobeJson('input.mp4'));
    const fromLog = parseProbe(exec('-hide_banner', '-loglevel', 'info', '-i', 'input.mp4').text);

    assert.ok(fromJson, 'ffprobe produced nothing');
    assert.ok(fromLog.hasVideo, 'the log parser found no video');

    assert.equal(fromLog.hasVideo, fromJson.hasVideo);
    assert.equal(fromLog.hasAudio, fromJson.hasAudio);
    assert.equal(fromLog.video.codec, fromJson.video.codec);
    assert.equal(fromLog.video.width, fromJson.video.width);
    assert.equal(fromLog.video.height, fromJson.video.height);
    assert.equal(fromLog.video.fps, fromJson.video.fps);
    assert.equal(fromLog.video.pixelFormat, fromJson.video.pixelFormat);
    assert.equal(fromLog.audio.codec, fromJson.audio.codec);
    assert.equal(fromLog.audio.sampleRate, fromJson.audio.sampleRate);
    assert.equal(fromLog.audio.channels, fromJson.audio.channels);
    // The banner rounds to hundredths; ffprobe does not.
    assert.ok(Math.abs(fromLog.duration - fromJson.duration) < 0.02);
    assert.equal(fromLog.formats.includes('mp4'), fromJson.formats.includes('mp4'));
  });
});

describe('every operation runs', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('convert to MP4, scaled and re-rated', () => {
    const plan = buildPlan(clip, 'convert', { format: 'mp4-h264', resolution: '240', fps: '12', quality: 'small', speed: 'ultrafast' });
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.video.codec, 'h264');
    assert.equal(info.video.fps, 12);
    // 192×144 is already smaller than the 240p box, so it must not be grown.
    assert.equal(info.video.width, 192);
    assert.equal(info.video.height, 144);
    assert.equal(plan.downloadName, 'holiday.mp4');
  });

  test('convert to WebM with VP8 and Vorbis', () => {
    const plan = buildPlan(clip, 'convert', { format: 'webm-vp8', quality: 'small' });
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.video.codec, 'vp8');
    assert.equal(info.audio.codec, 'vorbis');
    assert.equal(plan.downloadName, 'holiday.webm');
  });

  test('convert to MKV and to MOV', () => {
    for (const [format, codecs] of [['mkv-h264', 'matroska'], ['mov-h264', 'mov']]) {
      const plan = buildPlan(clip, 'convert', { format, quality: 'small', speed: 'ultrafast' });
      runPlan(plan);
      const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
      assert.equal(info.video.codec, 'h264', format);
      assert.ok(info.formats.some((name) => name.includes(codecs)), `${format} produced ${info.formats.join(',')}`);
    }
  });

  test('mute drops the audio track entirely', () => {
    const plan = buildPlan(clip, 'convert', { format: 'mp4-h264', mute: true, speed: 'ultrafast' });
    runPlan(plan);
    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.hasAudio, false);
  });

  test('volume gain is applied by the vendored audio filter', () => {
    const level = (name) => {
      const report = exec(
        '-hide_banner', '-loglevel', 'info', '-i', name,
        '-af', 'volumedetect', '-vn', '-f', 'null', '-'
      ).text;
      return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(report)?.[1]);
    };
    const before = level('input.mp4');
    const plan = buildPlan(clip, 'convert', {
      format: 'mp4-h264', volumeGain: 1.5, evenDimensions: true, speed: 'ultrafast',
    });
    runPlan(plan);

    const after = level(plan.outputs[0]);
    assert.ok(Number.isFinite(before) && Number.isFinite(after));
    assert.ok(after - before > 3 && after - before < 4, `gain moved mean volume from ${before} dB to ${after} dB`);
  });

  test('speed keeps video and audio together through a chained atempo filter', () => {
    const plan = buildPlan(clip, 'convert', {
      format: 'mp4-h264', playbackRate: 4, evenDimensions: true, speed: 'ultrafast',
    });
    assert.match(valueAfter(plan.steps[0].args, '-af'), /atempo=2,atempo=2/);
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.ok(info.hasVideo && info.hasAudio);
    assert.ok(Math.abs(info.duration - plan.duration) < 0.2, `speed output was ${info.duration}, planned ${plan.duration}`);
    assert.ok(Math.abs(info.video.duration - info.audio.duration) < 0.2);
  });

  test('loop repeats both streams to the planned bounded duration', () => {
    const plan = buildPlan(clip, 'convert', {
      format: 'mp4-h264', loopMode: 'count', loopCount: 2, evenDimensions: true, speed: 'ultrafast',
    });
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.ok(info.hasVideo && info.hasAudio);
    assert.ok(Math.abs(info.duration - plan.duration) < 0.2, `loop output was ${info.duration}, planned ${plan.duration}`);
    assert.ok(Math.abs(info.video.duration - info.audio.duration) < 0.2);
  });

  test('trimming produces a shorter file', () => {
    const plan = buildPlan(clip, 'convert', { format: 'mp4-h264', trimStart: 0.5, trimEnd: 1.5, speed: 'ultrafast' });
    assert.equal(plan.duration, 1);
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.ok(Math.abs(info.duration - 1) < 0.25, `trimmed to ${info.duration}s, expected about 1s`);
  });

  test('rotating by 90 degrees swaps the dimensions', () => {
    const plan = buildPlan(clip, 'convert', { format: 'mp4-h264', rotate: 90, speed: 'ultrafast' });
    runPlan(plan);
    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.video.width, 144);
    assert.equal(info.video.height, 192);
  });

  for (const format of AUDIO_FORMATS) {
    test(`extract audio as ${format.label}`, () => {
      const plan = buildPlan(clip, 'extract-audio', { audioFormat: format.id, audioBitrate: 96 });
      runPlan(plan);

      const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
      assert.equal(info.hasVideo, false, `${format.id} kept a video stream`);
      assert.equal(info.hasAudio, true);
      assert.ok(sizeOf(plan.outputs[0]) > 0);
      assert.equal(plan.downloadName, `holiday.${format.extension}`);
    });
  }

  test('FLAC compression changes the file but not one sample of the audio', () => {
    const encode = (level, as) => {
      const plan = buildPlan(clip, 'extract-audio', { audioFormat: 'flac', flacCompression: level });
      assert.equal(valueAfter(plan.steps[0].args, '-compression_level'), String(level));
      runPlan(plan);
      core.FS.rename(plan.outputs[0], as);
      return sizeOf(as);
    };

    const fast = encode(0, 'fast.flac');
    const small = encode(12, 'small.flac');
    assert.ok(fast > 0 && small > 0);
    assert.ok(small <= fast, `level 12 produced ${small} bytes, more than level 0's ${fast}`);

    // The claim FLAC makes is that the samples survive the round trip exactly.
    // Decoding both back to raw PCM and comparing the bytes is the only way to
    // check that rather than take it on faith — and it is what makes hiding
    // the bitrate control for these formats correct rather than merely tidy.
    for (const [source, target] of [['fast.flac', 'fast.wav'], ['small.flac', 'small.wav']]) {
      const { code } = exec('-i', source, '-c:a', 'pcm_s16le', '-y', target);
      assert.equal(code, 0, `could not decode ${source}`);
    }

    const fastPcm = core.FS.readFile('fast.wav');
    const smallPcm = core.FS.readFile('small.wav');
    assert.equal(fastPcm.length, smallPcm.length, 'the two decodes are different lengths');
    assert.ok(
      fastPcm.every((byte, index) => byte === smallPcm[index]),
      'the decoded audio differs between compression levels, which would mean FLAC is not lossless here'
    );
  });

  test('a GIF is built in two passes and comes out a GIF', () => {
    const plan = buildPlan(clip, 'gif', { gifFps: 8, gifWidth: 120, trimEnd: 1 });
    assert.equal(plan.steps.length, 2);
    runPlan(plan);

    assert.ok(sizeOf('palette.png') > 0, 'no palette was written');
    const info = parseProbeJson(ffprobeJson('output.gif'));
    assert.equal(info.format, 'gif');
    assert.equal(info.video.width, 120);
  });

  test('compressing to a size lands near it', () => {
    const plan = buildPlan(clip, 'compress', { targetSize: 0.2, audioBitrate: 64, speed: 'ultrafast' });
    assert.equal(plan.steps.length, 2);
    runPlan(plan);

    const bytes = sizeOf('output.mp4');
    assert.ok(bytes > 0, 'nothing was produced');
    // Rate control is not exact, especially over three seconds; the claim is
    // "near", and landing under twice the target is the honest version of it.
    assert.ok(bytes < 0.2 * 1e6 * 2, `asked for 0.2 MB, got ${(bytes / 1e6).toFixed(2)} MB`);
  });

  test('frames are extracted at an interval', () => {
    const plan = buildPlan(clip, 'frames', { frameInterval: 1, imageFormat: 'png' });
    runPlan(plan);

    const written = core.FS.readdir('/').filter((name) => name.startsWith('frame-'));
    assert.ok(written.length >= 3, `expected about 3 frames, got ${written.length}`);
    assert.ok(sizeOf(written[0]) > 0);
  });

  test('a poster frame is one image from the middle', () => {
    const plan = buildPlan(clip, 'thumbnail', { at: 1.5, imageFormat: 'jpeg', resolution: '240' });
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.video.codec, 'mjpeg');
    assert.equal(plan.downloadName, 'holiday.jpg');
  });

  test('a raw command runs with the placeholders substituted', () => {
    const plan = buildPlan(clip, 'raw', { rawArguments: '-i $in -vn -c:a libmp3lame -b:a 64k $out.mp3' });
    assert.deepEqual(plan.steps[0].args, [
      '-hide_banner', '-loglevel', 'info', '-stats',
      '-i', 'input.mp4', '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', 'output.mp3',
    ]);
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson('output.mp3'));
    assert.equal(info.audio.codec, 'mp3');
    assert.equal(plan.downloadName, 'holiday.mp3');
  });
});

describe('speed timestamps on an isolated core', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('scales a one-second A/V start delay from a non-zero origin', async () => {
    const fresh = await loadCore();
    let freshLines = [];
    fresh.setLogger(({ message }) => freshLines.push(message));
    const runFresh = (...args) => {
      freshLines = [];
      fresh.reset();
      const code = fresh.exec(...args);
      return { code, text: freshLines.join('\n') };
    };
    const probeFresh = (name, reportName) => {
      freshLines = [];
      fresh.reset();
      fresh.ffprobe(
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
        '-o', reportName, name
      );
      const report = JSON.parse(new TextDecoder().decode(fresh.FS.readFile(reportName)));
      fresh.FS.unlink(reportName);
      return report;
    };

    const made = runFresh(
      '-f', 'lavfi', '-i', 'testsrc2=size=192x144:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=3',
      '-filter_complex', '[0:v]setpts=PTS+5/TB[v];[1:a]asetpts=PTS+6/TB[a]',
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-copyts', '-y', 'input.mp4'
    );
    assert.equal(made.code, 0, `could not synthesise offset input:\n${made.text.split('\n').slice(-8).join('\n')}`);

    const inputReport = probeFresh('input.mp4', 'offset-input.json');
    const inputVideo = Number(inputReport.streams.find((stream) => stream.codec_type === 'video')?.start_time);
    const inputAudio = Number(inputReport.streams.find((stream) => stream.codec_type === 'audio')?.start_time);
    assert.ok(Math.abs(inputVideo - 5) < 0.05, `input video started at ${inputVideo}`);
    assert.ok(Math.abs(inputAudio - 6) < 0.05, `input audio started at ${inputAudio}`);
    assert.ok(Math.abs((inputAudio - inputVideo) - 1) < 0.05, `input delay was ${inputAudio - inputVideo}`);
    const offsetInfo = parseProbeJson(JSON.stringify(inputReport));
    const plan = buildPlan(source('offset.mp4', offsetInfo), 'convert', {
      format: 'mp4-h264', playbackRate: 2, evenDimensions: true, speed: 'ultrafast',
    });
    for (const step of plan.steps) {
      const result = runFresh(...step.args);
      assert.equal(result.code, 0, `offset speed failed:\n${result.text.split('\n').slice(-10).join('\n')}`);
    }

    const outputReport = probeFresh(plan.outputs[0], 'offset-output.json');
    const outputVideo = Number(outputReport.streams.find((stream) => stream.codec_type === 'video')?.start_time);
    const outputAudio = Number(outputReport.streams.find((stream) => stream.codec_type === 'audio')?.start_time);
    assert.ok(Math.abs(outputVideo) < 0.05, `output video started at ${outputVideo}`);
    assert.ok(Math.abs(outputAudio - 0.5) < 0.06, `output audio started at ${outputAudio}`);
    assert.ok(
      Math.abs((outputAudio - outputVideo) - 0.5) < 0.06,
      `scaled A/V delay was ${outputAudio - outputVideo}`
    );
    const outputInfo = parseProbeJson(JSON.stringify(outputReport));
    assert.ok(
      Math.abs(outputInfo.duration - plan.duration) < 0.2,
      `offset speed output was ${outputInfo.duration}, planned ${plan.duration}`
    );
  });
});

/**
 * Crop gets a fresh core so this regression check does not perturb the long
 * shared invocation sequence above. The vendored build has a known lifetime
 * trap whose exact call count moves slightly; inserting one more encode into
 * that sequence can make a later, unrelated repackaging assertion inherit the
 * poisoned instance.
 */
describe('crop on an isolated core', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('produces the requested safe 128×96 rectangle', async () => {
    const fresh = await loadCore();
    let freshLines = [];
    fresh.setLogger(({ message }) => freshLines.push(message));

    const runFresh = (...args) => {
      freshLines = [];
      fresh.reset();
      const code = fresh.exec(...args);
      return { code, text: freshLines.join('\n') };
    };

    const made = runFresh(
      '-f', 'lavfi', '-i', 'testsrc2=size=192x144:rate=15:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-an', '-y', 'input.mp4'
    );
    assert.equal(made.code, 0, `could not make the isolated crop input:\n${made.text.split('\n').slice(-8).join('\n')}`);

    const cropSource = source('crop.mp4', {
      hasVideo: true,
      hasAudio: false,
      duration: 1,
      video: { codec: 'h264', width: 192, height: 144, fps: 15 },
    });
    const plan = buildPlan(cropSource, 'convert', {
      format: 'mp4-h264',
      cropX: 32,
      cropY: 24,
      cropWidth: 128,
      cropHeight: 96,
      speed: 'ultrafast',
    });
    for (const step of plan.steps) {
      const result = runFresh(...step.args);
      assert.equal(
        result.code,
        0,
        `isolated crop failed:\n  ffmpeg ${step.args.join(' ')}\n${result.text.split('\n').slice(-8).join('\n')}`
      );
    }

    fresh.reset();
    fresh.ffprobe(
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
      '-o', 'crop-report.json', plan.outputs[0]
    );
    const report = new TextDecoder().decode(fresh.FS.readFile('crop-report.json'));
    const info = parseProbeJson(report);
    assert.ok(info?.hasVideo, 'could not probe the isolated crop output');
    assert.equal(info.video.width, 128);
    assert.equal(info.video.height, 96);
  });
});

/**
 * Multi-input work gets its own core for the same reason crop does: adding
 * several synthesis, probe and encode calls to the shared instance moves the
 * vendored core's known lifetime trap and makes a later test inherit it.
 */
describe('video joining on an isolated core', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('normalises heterogeneous clips and fills a missing audio track with silence', async () => {
    const fresh = await loadCore();
    let freshLines = [];
    fresh.setLogger(({ message }) => freshLines.push(message));

    const runFresh = (...args) => {
      freshLines = [];
      fresh.reset();
      const code = fresh.exec(...args);
      return { code, text: freshLines.join('\n') };
    };
    const probeFresh = (name, reportName) => {
      freshLines = [];
      fresh.reset();
      fresh.ffprobe(
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
        '-o', reportName, name
      );
      const report = new TextDecoder().decode(fresh.FS.readFile(reportName));
      fresh.FS.unlink(reportName);
      return parseProbeJson(report);
    };

    const firstMade = runFresh(
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '1', '-b:a', '64k', '-shortest',
      '-y', 'input-000.mp4'
    );
    assert.equal(firstMade.code, 0, `could not make the first join input:\n${firstMade.text.split('\n').slice(-8).join('\n')}`);

    const secondMade = runFresh(
      '-f', 'lavfi', '-i', 'testsrc2=size=90x160:rate=15:duration=1',
      '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p',
      '-an', '-y', 'input-001.webm'
    );
    assert.equal(secondMade.code, 0, `could not make the second join input:\n${secondMade.text.split('\n').slice(-8).join('\n')}`);

    const firstInfo = probeFresh('input-000.mp4', 'join-first.json');
    const secondInfo = probeFresh('input-001.webm', 'join-second.json');
    assert.equal(firstInfo.video.codec, 'h264');
    assert.equal(firstInfo.audio.sampleRate, 44_100);
    assert.equal(firstInfo.audio.channels, 1);
    assert.equal(secondInfo.video.codec, 'vp8');
    assert.equal(secondInfo.hasAudio, false);

    const plan = buildJoinVideosPlan([
      source('first.mp4', firstInfo),
      source('second.webm', secondInfo),
    ], {
      fps: '30',
      speed: 'ultrafast',
      audioBitrate: 96,
    });

    for (const step of plan.steps) {
      const result = runFresh(...step.args);
      assert.equal(
        result.code,
        0,
        `isolated video join failed:\n  ffmpeg ${step.args.join(' ')}\n${result.text.split('\n').slice(-12).join('\n')}`
      );
    }

    const output = probeFresh(plan.outputs[0], 'join-output.json');
    assert.ok(output?.hasVideo, 'could not probe the joined output video');
    assert.equal(output.video.codec, 'h264');
    assert.equal(output.video.width, 160);
    assert.equal(output.video.height, 90);
    assert.equal(output.video.fps, 30);
    assert.equal(output.video.rotation, null);
    assert.ok(output.hasAudio, 'the audio stream disappeared when the second clip was silent');
    assert.equal(output.audio.codec, 'aac');
    assert.equal(output.audio.sampleRate, 48_000);
    assert.equal(output.audio.channels, 2);
    assert.ok(
      Math.abs(output.duration - plan.duration) <= (1 / plan.fps) + 0.03,
      `joined duration ${output.duration} differs from planned ${plan.duration}`
    );
    assert.ok(
      output.audio.duration >= plan.duration - 0.03,
      `audio ended at ${output.audio.duration}; the silent segment was not filled to ${plan.duration}`
    );
  });
});

/** Two-input audio editing gets a fresh core for the same lifetime reason. */
describe('adding audio on an isolated core', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('mixes a delayed short track and can loop it through a replacement', async () => {
    const fresh = await loadCore();
    let freshLines = [];
    fresh.setLogger(({ message }) => freshLines.push(message));

    const runFresh = (...args) => {
      freshLines = [];
      fresh.reset();
      const code = fresh.exec(...args);
      return { code, text: freshLines.join('\n') };
    };
    const probeFresh = (name, reportName) => {
      freshLines = [];
      fresh.reset();
      fresh.ffprobe(
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
        '-o', reportName, name
      );
      const report = new TextDecoder().decode(fresh.FS.readFile(reportName));
      fresh.FS.unlink(reportName);
      return parseProbeJson(report);
    };
    const runFreshPlan = (plan) => {
      for (const step of plan.steps) {
        const result = runFresh(...step.args);
        assert.equal(
          result.code,
          0,
          `isolated add-audio failed:\n  ffmpeg ${step.args.join(' ')}\n${result.text.split('\n').slice(-12).join('\n')}`
        );
      }
    };

    const videoMade = runFresh(
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=110:sample_rate=44100:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '1', '-b:a', '64k', '-shortest',
      '-y', 'input-video.mp4'
    );
    assert.equal(videoMade.code, 0, `could not make add-audio video:\n${videoMade.text.split('\n').slice(-8).join('\n')}`);

    const audioMade = runFresh(
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=32000:duration=0.75',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-y', 'input-audio.mp3'
    );
    assert.equal(audioMade.code, 0, `could not make added MP3:\n${audioMade.text.split('\n').slice(-8).join('\n')}`);

    const videoInfo = probeFresh('input-video.mp4', 'add-audio-video.json');
    const audioInfo = probeFresh('input-audio.mp3', 'add-audio-track.json');
    const addSource = {
      video: source('phone.mp4', videoInfo),
      audio: source('music.mp3', audioInfo),
    };

    const mixed = buildAddAudioPlan(addSource, {
      mixMode: 'mix',
      originalGain: 0.25,
      addedGain: 1,
      audioOffset: 1,
      speed: 'ultrafast',
      audioBitrate: 64,
    });
    runFreshPlan(mixed);
    const mixedInfo = probeFresh(mixed.outputs[0], 'add-audio-mix-output.json');
    assert.equal(mixedInfo.video.codec, 'h264');
    assert.equal(mixedInfo.audio.codec, 'aac');
    assert.equal(mixedInfo.audio.sampleRate, 48_000);
    assert.equal(mixedInfo.audio.channels, 2);
    assert.ok(Math.abs(mixedInfo.duration - 3) < 0.06, `mixed output duration was ${mixedInfo.duration}`);

    const windowRms = (start, name) => {
      const decoded = runFresh(
        '-i', mixed.outputs[0], '-ss', String(start), '-t', '0.2',
        '-map', '0:a:0', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', '-y', name
      );
      assert.equal(decoded.code, 0, `could not inspect mixed audio at ${start}s`);
      const pcm = fresh.FS.readFile(name);
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
      const energy = samples.reduce((sum, sample) => sum + (sample * sample), 0);
      return Math.sqrt(energy / samples.length);
    };
    const beforeAdded = windowRms(0.2, 'mix-before.pcm');
    const duringAdded = windowRms(1.1, 'mix-during.pcm');
    const afterAdded = windowRms(2.1, 'mix-after.pcm');
    assert.ok(duringAdded > beforeAdded * 1.7, 'the delayed added track was not audible during its window');
    assert.ok(
      Math.abs(afterAdded - beforeAdded) / beforeAdded < 0.1,
      'the short added track did not return to silence after playing once'
    );

    const looped = buildAddAudioPlan(addSource, {
      mixMode: 'replace',
      audioFit: 'loop',
      speed: 'ultrafast',
      audioBitrate: 64,
    });
    runFreshPlan(looped);
    const loopedInfo = probeFresh(looped.outputs[0], 'add-audio-loop-output.json');
    assert.ok(Math.abs(loopedInfo.duration - 3) < 0.06, `loop output duration was ${loopedInfo.duration}`);
    assert.ok(loopedInfo.audio.duration >= 2.95, `looped audio ended at ${loopedInfo.audio.duration}`);

    // The source track ends before 0.8s. Audible samples near 2.3s prove the
    // repeated replacement is not merely an AAC stream padded with silence.
    const lateAudio = runFresh(
      '-ss', '2.2', '-t', '0.2', '-i', looped.outputs[0],
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', '-y', 'late-loop.pcm'
    );
    assert.equal(lateAudio.code, 0, `could not inspect late loop audio:\n${lateAudio.text.split('\n').slice(-8).join('\n')}`);
    const pcm = fresh.FS.readFile('late-loop.pcm');
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const peak = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    assert.ok(peak > 100, `late loop audio was silent (PCM peak ${peak})`);
  });
});

/**
 * Repackaging, which is the one operation whose whole claim is about what it
 * does NOT do.
 *
 * Every other operation can be checked by looking at what came out. This one
 * promises that what came out is what went in, so the test has to prove a
 * negative: pull the raw H.264 back out of both files and compare the bytes. If
 * a single one differs, something re-encoded and the operation is lying.
 */
describe('repackaging', { skip: VENDORED ? false : 'core not vendored' }, () => {
  let mkv = null;

  before(() => {
    if (!VENDORED) return;
    // Matroska, so that MP4, MOV and M4A are all genuinely somewhere else. The
    // name matters: `buildPlan` derives `input.mkv` from the source's own
    // extension, and that is the file the worker would have written.
    const { code, text } = exec(
      '-f', 'lavfi', '-i', 'testsrc2=size=192x144:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-shortest', '-y', 'input.mkv'
    );
    assert.equal(code, 0, `could not synthesise the Matroska source:\n${text.split('\n').slice(-6).join('\n')}`);
    mkv = source('holiday.mkv', parseProbeJson(ffprobeJson('input.mkv')));
  });

  test('offers exactly the containers that can hold H.264 and AAC', () => {
    assert.equal(mkv.info.video.codec, 'h264');
    assert.equal(mkv.info.audio.codec, 'aac');
    // Matroska itself is absent because the file is already Matroska, and WebM
    // because it takes neither of these codecs.
    assert.deepEqual(remuxTargets(mkv.info).map((container) => container.id), ['mp4', 'mov', 'm4a']);
  });

  test('moves the streams into MP4 without changing one byte of the video', () => {
    const plan = buildPlan(mkv, 'remux', { remuxTarget: 'mp4' });
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.video.codec, 'h264');
    assert.equal(info.audio.codec, 'aac');
    assert.ok(info.formats.some((name) => name.includes('mp4')), `produced ${info.formats.join(',')}`);
    assert.equal(plan.downloadName, 'holiday.mp4');

    // The claim, tested rather than asserted in a comment. `-f h264` writes the
    // elementary stream with no container around it, so what comes back is the
    // encoded video and nothing else.
    const elementary = (from, to) => {
      const { code } = exec('-i', from, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', '-y', to);
      assert.equal(code, 0, `could not read the raw video back out of ${from}`);
      return core.FS.readFile(to);
    };
    const before = elementary('input.mkv', 'before.h264');
    const after = elementary(plan.outputs[0], 'after.h264');

    assert.equal(after.length, before.length, 'the repackaged video is a different length');
    assert.ok(
      before.every((byte, index) => byte === after[index]),
      'the video bytes changed, so something re-encoded and "nothing is lost" is false'
    );
  });

  test('lifts the AAC into an M4A and leaves the pictures behind', () => {
    const plan = buildPlan(mkv, 'remux', { remuxTarget: 'm4a' });
    runPlan(plan);

    const info = parseProbeJson(ffprobeJson(plan.outputs[0]));
    assert.equal(info.hasVideo, false, 'the video came along');
    assert.equal(info.audio.codec, 'aac', 'the audio was re-encoded on the way out');
    assert.equal(plan.downloadName, 'holiday.m4a');
  });

  test('a container the streams do not fit is never what actually runs', () => {
    // WebM cannot hold H.264 or AAC, and asking the core to try is a job that
    // fails a few seconds after someone chose it. The builder substitutes a
    // container that fits and says so, and this proves the substitute runs.
    const plan = buildPlan(mkv, 'remux', { remuxTarget: 'webm' });
    assert.equal(plan.container, 'mp4');
    runPlan(plan);
    assert.ok(sizeOf(plan.outputs[0]) > 0);

    // And the refusal it avoided is real, not theoretical.
    const { code } = exec('-i', 'input.mkv', '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'webm', '-y', 'refused.webm');
    assert.notEqual(code, 0, 'WebM now accepts H.264 — the container table should be revisited');
  });
});

/**
 * VP9, on a core that has not been warmed up.
 *
 * This needs its own instance, and that is the entire point. `libvpx-vp9`
 * traps on a freshly instantiated core and keeps trapping for the first few
 * dozen invocations; somewhere around forty it starts working and then works
 * every time. Running it at the end of the shared instance — which by then has
 * a hundred invocations behind it — reports success and tells you nothing
 * about what a user would see.
 *
 * What a user sees is always the fresh case: the engine is instantiated on
 * page load and replaced whenever a job is cancelled. So the test builds a
 * core of its own, and does it last because a trap makes that core unusable.
 */
describe('libvpx-vp9', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('is compiled in, and traps on a fresh core, which is why no format offers it', async () => {
    assert.ok(
      capabilities.encoders.some((encoder) => encoder.name === 'libvpx-vp9'),
      'the core no longer contains libvpx-vp9 at all'
    );
    assert.equal(
      VIDEO_FORMATS.some((format) => format.encoders.includes('libvpx-vp9')),
      false,
      'a format offers VP9 again — if that is deliberate, this test should go'
    );

    const fresh = await loadCore();
    const run = (...args) => {
      fresh.reset();
      try {
        return { code: fresh.exec(...args) };
      } catch (error) {
        return { code: 'trapped', error: error.message };
      }
    };

    const made = run(
      '-f', 'lavfi', '-i', 'testsrc2=size=192x144:rate=15:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', 'vp9-input.mp4'
    );
    assert.equal(made.code, 0, 'could not make an input on the fresh core');

    // Kept as a test rather than a comment so that the day a core ships with a
    // VP9 that survives its first invocation, this fails and someone goes and
    // adds WebM/VP9 back to the format table.
    const attempt = run('-i', 'vp9-input.mp4', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-an', '-y', 'vp9-probe.webm');
    assert.notEqual(
      attempt.code,
      0,
      'libvpx-vp9 encoded on a fresh core — VP9 can be offered again'
    );
    assert.match(
      String(attempt.error || ''),
      /memory access out of bounds|Aborted|unreachable/i,
      `expected a trap, got ${JSON.stringify(attempt)}`
    );
  });
});

/**
 * libx265, which is compiled in, listed, and must never be offered.
 *
 * `-encoders` reports `libx265`, `formats.js` carries CRF values for it, and
 * the configure line in the manifest asks for `--enable-libx265`. Everything
 * says HEVC output is available. It is not: asking this core to encode a single
 * frame of it never returns. Not slowly — at all. No error, no exit code, no
 * CPU. Four argument shapes were measured — bare, with a preset and CRF, with
 * x265's own logging turned off, and with `pools=none:frame-threads=1` — and
 * all four hang identically, so it is not the arguments and not simply a thread
 * pool waiting for threads this build does not have. Only the first is run
 * here, because each one costs the suite its whole timeout to prove a negative.
 *
 * That makes it worse than the VP9 trap next door. A trap at least ends: the
 * heap is poisoned, the worker reports it, the client replaces the instance. A
 * call that never returns takes the worker's event loop with it, so cancelling
 * cannot be heard, progress stops, and the only way out is terminating the
 * worker from the outside — which the user has no reason to think of, because
 * from the page it looks like a conversion that is merely taking a while.
 *
 * It has to be tested in a process of its own for the same reason: a
 * synchronous call into WebAssembly cannot be interrupted from the thread it is
 * running on, so a test that called it directly would hang the suite.
 */
/**
 * The child, as source, because it has to run in its own process and the suite
 * is `tests/*.test.js` — a second file beside it would either be collected as a
 * test that is not one, or hidden in a directory for a single string.
 *
 * It prints STARTED before entering the encode and ENCODED after leaving it.
 * Reaching the first and never the second is the whole finding.
 */
const CHILD = `
  import { readFileSync } from 'node:fs';
  const [directory, encoder, ...extra] = process.argv.slice(1);
  const script = new URL('ffmpeg-core.js', 'file://' + directory);
  globalThis.self = globalThis;
  globalThis.location = new URL(script);
  const { default: createFFmpegCore } = await import(script.href);
  const core = await createFFmpegCore({ wasmBinary: readFileSync(new URL('ffmpeg-core.wasm', 'file://' + directory)) });
  core.setLogger(() => {});
  core.reset();
  console.log('STARTED');
  const code = core.exec(
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=15:duration=1',
    '-c:v', encoder, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...extra,
    '-an', '-y', 'out.mp4'
  );
  let bytes = 0;
  try { bytes = core.FS.readFile('out.mp4').length; } catch {}
  console.log(code === 0 && bytes > 0 ? 'ENCODED ' + bytes : 'REFUSED ' + code);
`;

describe('libx265', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('is compiled in, and never returns, which is why no format offers HEVC', () => {
    assert.ok(
      capabilities.encoders.some((encoder) => encoder.name === 'libx265'),
      'the core no longer contains libx265 at all'
    );
    assert.equal(
      VIDEO_FORMATS.some((format) => format.encoders.includes('libx265')),
      false,
      'a format offers libx265 again — if that is deliberate, this test should go'
    );

    // The control and the suspect run the same way, so a timeout that fired for
    // both would mean the clock is too short rather than that x265 hangs.
    // Generous next to the control, which finishes in a fifth of a second, and
    // short enough that proving a negative does not dominate the suite.
    const attempt = (encoder) => spawnSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, fileURLToPath(CORE_DIRECTORY), encoder],
      { timeout: 15_000, killSignal: 'SIGKILL', encoding: 'utf8' }
    );

    const control = attempt('libx264');
    assert.match(control.stdout || '', /ENCODED/, `libx264 did not encode, so this test proves nothing:\n${control.stderr}`);

    const result = attempt('libx265');
    // Killed on the deadline: no exit code, and the signal in its place.
    assert.equal(
      result.signal,
      'SIGKILL',
      `libx265 returned — HEVC may be offerable now, and this test should be revisited: ${result.stdout}`
    );
    assert.match(result.stdout || '', /STARTED/, 'the child never reached the encode, so the timeout means nothing');
  });
});

/**
 * One core does not last forever, whatever it is asked to do.
 *
 * Running nothing but `-version` on a single instance traps at around the
 * seventieth call; a small MP3 encode at about the same; a small video encode
 * at roughly a hundred and sixty. The counts move between runs and the cause is
 * upstream, but every kind of work gets there eventually, and the app keeps one
 * instance for the whole session.
 *
 * Two things are worth pinning down. That it happens at all, so this fails the
 * day a core stops leaking and someone can delete the machinery around it. And
 * that the failure is one the worker recognises as fatal — because the app
 * surviving it depends entirely on that classification being right.
 */
describe('a long-lived core', { skip: VENDORED ? false : 'core not vendored' }, () => {
  test('eventually traps, and says so in words the worker treats as fatal', async () => {
    const own = await loadCore();
    const LIMIT = 400;

    let trappedAt = null;
    let message = '';
    for (let i = 1; i <= LIMIT; i += 1) {
      own.reset();
      try {
        own.exec('-hide_banner', '-loglevel', 'error', '-version');
      } catch (error) {
        trappedAt = i;
        message = error.message;
        break;
      }
    }

    assert.ok(
      trappedAt !== null,
      `the core survived ${LIMIT} invocations. If that is real rather than luck, the leak is fixed and ` +
      'the queue no longer needs to expect a dead engine mid-session.'
    );
    // The load-bearing half: the client only replaces the instance when the
    // worker marks the failure fatal, and it decides that from this string.
    assert.equal(isFatal(message), true, `the worker would carry on with a poisoned core after: ${message}`);
  });
});
