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

import { buildPlan } from '../src/media/commands.js';
import { parseProbeJson, parseProbe } from '../src/media/probe.js';
import { parseEncoders, parseMuxers, missingFor } from '../src/ffmpeg/capabilities.js';
import { VIDEO_FORMATS, AUDIO_FORMATS, IMAGE_FORMATS } from '../src/media/formats.js';

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
