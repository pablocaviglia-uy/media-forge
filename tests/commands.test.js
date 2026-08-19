/**
 * The command builder, on its own terms.
 *
 * `core.test.js` puts every plan through the FFmpeg that actually ships and
 * proves the arguments are accepted. That is a different question from whether
 * they are the arguments that were meant: `-ss` after `-i` decodes and discards
 * everything up to the seek point and still exits zero, a plain `scale=1280:720`
 * happily blows a 320-pixel clip up to fill the box and still exits zero, and a
 * GIF quantised against a palette built from different frames than it quantises
 * is a perfectly valid GIF that looks wrong.
 *
 * So this file asks the other half of the question, and asks it of pure
 * functions: no WebAssembly, no filesystem, no media. Every source below is a
 * description of a file that does not exist. That is what makes this suite fast
 * enough to run on every save and deterministic enough to believe when it goes
 * red — if something here fails, the builder changed, not the weather.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATIONS,
  buildAddAudioPlan,
  buildPlan,
  buildJoinVideosPlan,
  planToCommand,
  splitArguments,
  operationsFor,
} from '../src/media/commands.js';
import { AUDIO_FORMATS, AUDIO_ENCODERS, RESOLUTIONS, FLAC_COMPRESSION, crfFor, audioFidelity, remuxTargets } from '../src/media/formats.js';
import { formatTimestamp } from '../src/ui/dom.js';

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

const source = (name, info) => ({ name, info });

/**
 * Two minutes of 1080p with a stereo track: the ordinary case.
 *
 * It names its codecs and its container because a real file does, and because
 * repackaging is offered on the strength of exactly those two facts. A source
 * that leaves them out is a probe that failed, which is a different case and
 * has its own fixtures below.
 */
const VIDEO = source('holiday.mp4', {
  hasVideo: true,
  hasAudio: true,
  duration: 120,
  formats: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
  video: { codec: 'h264', width: 1920, height: 1080, fps: 30 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
});

/** A minute of video with no audio stream at all. */
const SILENT = source('timelapse.mov', { hasVideo: true, hasAudio: false, duration: 60 });

/** Exactly a minute, so the compression arithmetic can be checked by hand. */
const MINUTE = source('clip.mp4', { hasVideo: true, hasAudio: true, duration: 60 });

/**
 * A file whose length nobody knows. Some containers genuinely do not say, and
 * a probe that fails leaves the app in the same position.
 */
const UNKNOWN = source('stream.mkv', { hasVideo: true, hasAudio: true, duration: null });

/**
 * The ordinary case for repackaging: H.264 and AAC sitting in a Matroska file,
 * which is the pair every container in the table has an opinion about. Unlike
 * the sources above it names its codecs and its container, because that is
 * exactly what decides whether a stream can be copied anywhere.
 */
const REMUXABLE = source('holiday.mkv', {
  hasVideo: true,
  hasAudio: true,
  duration: 120,
  formats: ['matroska', 'webm'],
  video: { codec: 'h264', width: 1920, height: 1080, fps: 30 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
});

const PORTRAIT_SILENT = source('phone.webm', {
  hasVideo: true,
  hasAudio: false,
  duration: 60,
  formats: ['matroska', 'webm'],
  video: { codec: 'vp8', width: 1080, height: 1920, fps: 15 },
});

const LANDSCAPE_SILENT = source('camera.mov', {
  hasVideo: true,
  hasAudio: false,
  duration: 30,
  formats: ['mov', 'mp4'],
  video: { codec: 'h264', width: 1280, height: 720, fps: 24 },
});

/* ------------------------------------------------------------------ *
 * Reading a plan
 * ------------------------------------------------------------------ */

/** Prepended to every invocation by `buildPlan`, and not interesting after that. */
const PREFIX = ['-hide_banner', '-loglevel', 'info', '-stats'];

/** One step's arguments with the fixed prefix taken off, so offsets mean something. */
const body = (plan, index = 0) => plan.steps[index].args.slice(PREFIX.length);

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

/** The `-vf` chain of a single-step plan, which is what most tests here are about. */
const chainOf = (options, operation = 'convert', from = VIDEO) => valueAfter(body(buildPlan(from, operation, options)), '-vf');

/* ------------------------------------------------------------------ *
 * The shape of a plan
 * ------------------------------------------------------------------ */

test('every operation returns a plan the worker can act on without special cases', () => {
  for (const operation of OPERATIONS) {
    const plan = buildPlan(VIDEO, operation.id, {});

    assert.equal(plan.operation, operation.id);
    assert.ok(Array.isArray(plan.steps) && plan.steps.length > 0, `${operation.id} planned nothing to run`);
    for (const step of plan.steps) {
      assert.equal(typeof step.label, 'string', `${operation.id} has a step with no label for the progress line`);
      assert.ok(step.label.length > 0, `${operation.id} has an empty label`);
      assert.ok(Array.isArray(step.args), `${operation.id} has a step with no arguments`);
      // Anything that is not a string reaches the core as `undefined` or as
      // "[object Object]", which fails in a way that reads as an FFmpeg bug.
      for (const argument of step.args) assert.equal(typeof argument, 'string', `${operation.id} passes a non-string: ${argument}`);
    }

    assert.deepEqual(plan.inputNames, ['input.mp4'], `${operation.id} asked for the wrong input`);
    assert.ok(Array.isArray(plan.outputs), `${operation.id} has no outputs array`);
    // Frames are the one operation that cannot name its outputs in advance, so
    // it names a prefix instead; everything else must list them.
    assert.ok(
      plan.outputs.length > 0 || typeof plan.outputPrefix === 'string',
      `${operation.id} tells the worker neither what to read back nor where to look`
    );
    assert.ok(/^[a-z]+\/[\w.+-]+$/.test(plan.mime), `${operation.id} has no usable MIME type: ${plan.mime}`);
    assert.ok(plan.downloadName.length > 0, `${operation.id} produced a file with no name`);
    assert.ok(
      plan.duration === null || Number.isFinite(plan.duration),
      `${operation.id} gave the progress bar a duration it cannot divide by: ${plan.duration}`
    );
  }
});

test('every invocation states the banner and the log level for itself', () => {
  for (const operation of OPERATIONS) {
    const plan = buildPlan(VIDEO, operation.id, {});
    for (const [index, step] of plan.steps.entries()) {
      // The core is one long-lived process, so verbosity set by an earlier job
      // would otherwise decide how much this one prints — and at debug level
      // the status line changes shape and progress stops parsing.
      assert.deepEqual(step.args.slice(0, PREFIX.length), PREFIX, `${operation.id} step ${index} does not set its own log level`);
    }
  }
});

test('the core works on fixed names while the download keeps the one the user knows', () => {
  const plan = buildPlan(source('My Holiday: 2019 (final).MP4', VIDEO.info), 'convert', { format: 'webm-vp8' });

  // Punctuation, spaces and case all belong to the download name; the names
  // handed to the core stay boring, because they become paths in its filesystem.
  assert.deepEqual(plan.inputNames, ['input.mp4']);
  assert.deepEqual(plan.outputs, ['output.webm']);
  assert.equal(plan.downloadName, 'My Holiday: 2019 (final).webm');
});

test('an operation nobody offers is refused by name', () => {
  assert.throws(() => buildPlan(VIDEO, 'transcode-to-betamax', {}), /no "transcode-to-betamax" operation/);
});

/* ------------------------------------------------------------------ *
 * Joining videos
 * ------------------------------------------------------------------ */

test('joining videos is a specialised ordered plan, not a single-file operation', () => {
  assert.equal(OPERATIONS.some((operation) => operation.id === 'join-videos'), false);

  const plan = buildJoinVideosPlan([VIDEO, PORTRAIT_SILENT], { audioBitrate: 128 });
  const args = body(plan);

  assert.equal(plan.operation, 'join-videos');
  assert.deepEqual(plan.inputNames, ['input-000.mp4', 'input-001.webm']);
  assert.deepEqual(args.slice(0, 4), ['-i', 'input-000.mp4', '-i', 'input-001.webm']);
  assert.deepEqual(plan.outputs, ['output.mp4']);
  assert.equal(plan.mime, 'video/mp4');
  assert.equal(plan.downloadName, 'holiday-joined.mp4');
  assert.equal(plan.duration, 180);
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.equal(plan.fps, 30);
  assert.equal(valueAfter(args, '-c:v'), 'libx264');
  assert.equal(valueAfter(args, '-c:a'), 'aac');
  assert.equal(valueAfter(args, '-b:a'), '128k');
  assert.equal(valueAfter(args, '-movflags'), '+faststart');
});

test('the join graph normalises video, real audio and a missing audio track', () => {
  const args = body(buildJoinVideosPlan([VIDEO, PORTRAIT_SILENT]));
  const graph = valueAfter(args, '-filter_complex');

  assert.match(graph, /\[0:v:0\].*setpts=PTS-STARTPTS.*fps=30/);
  assert.match(graph, /scale=trunc\(iw\*sar\/2\)\*2:ih,setsar=1/);
  assert.match(graph, /format=yuv420p\[v0\]/);
  assert.match(graph, /\[0:a:0\]aresample=48000/);
  assert.match(graph, /channel_layouts=stereo/);
  assert.match(graph, /asetpts=PTS-STARTPTS,apad,atrim=duration=120\[a0\]/);
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=duration=60,asetpts=PTS-STARTPTS\[a1\]/);
  assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/);
  assert.deepEqual(args.filter((argument) => argument === '-map').length, 2);
});

test('contain letterboxes without enlarging while cover fills and crops centrally', () => {
  const contain = valueAfter(body(buildJoinVideosPlan([VIDEO, PORTRAIT_SILENT])), '-filter_complex');
  assert.match(contain, /scale='min\(iw,1920\)':'min\(ih,1080\)'/);
  assert.match(contain, /force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:black/);
  assert.doesNotMatch(contain, /force_original_aspect_ratio=increase/);

  const coverPlan = buildJoinVideosPlan([VIDEO, PORTRAIT_SILENT], { mergeFit: 'cover' });
  const cover = valueAfter(body(coverPlan), '-filter_complex');
  assert.equal(coverPlan.fit, 'cover');
  assert.match(cover, /scale=1920:1080:force_original_aspect_ratio=increase:force_divisible_by=2/);
  assert.match(cover, /crop=1920:1080:\(iw-ow\)\/2:\(ih-oh\)\/2/);
  assert.doesNotMatch(cover, /pad=1920:1080/);
});

test('the first visible frame defines an even canvas after orientation and resolution', () => {
  const rotated = source('portrait.mp4', {
    hasVideo: true,
    hasAudio: false,
    duration: 10,
    video: {
      codec: 'h264', width: 1920, height: 1080, fps: 24,
      rotation: 90, displayAspect: '16:9',
    },
  });
  const plan = buildJoinVideosPlan([rotated, LANDSCAPE_SILENT], { resolution: '720', fps: '60' });

  assert.equal(plan.width, 404);
  assert.equal(plan.height, 720);
  assert.equal(plan.fps, 60);
  assert.match(valueAfter(body(plan), '-filter_complex'), /pad=404:720/);
});

test('an anamorphic first clip becomes a square-pixel canvas at its display aspect', () => {
  const anamorphic = source('anamorphic.mp4', {
    hasVideo: true,
    hasAudio: false,
    duration: 10,
    video: { codec: 'h264', width: 144, height: 108, fps: 25, displayAspect: '16:9' },
  });
  const plan = buildJoinVideosPlan([anamorphic, LANDSCAPE_SILENT]);

  assert.equal(plan.width, 192);
  assert.equal(plan.height, 108);
  assert.equal(plan.fps, 25);
});

test('all-silent and muted joins do not manufacture an audio stream', () => {
  for (const plan of [
    buildJoinVideosPlan([LANDSCAPE_SILENT, PORTRAIT_SILENT]),
    buildJoinVideosPlan([VIDEO, PORTRAIT_SILENT], { mute: true }),
  ]) {
    const args = body(plan);
    const graph = valueAfter(args, '-filter_complex');
    assert.match(graph, /concat=n=2:v=1:a=0\[v\]$/);
    assert.doesNotMatch(graph, /anullsrc|\[a\]/);
    assert.ok(args.includes('-an'));
    assert.equal(args.includes('-c:a'), false);
  }
});

test('a join refuses incomplete projects before it reaches FFmpeg', () => {
  assert.throws(() => buildJoinVideosPlan([VIDEO]), /at least two videos/);
  assert.throws(
    () => buildJoinVideosPlan([VIDEO, source('song.mp3', { hasVideo: false, hasAudio: true, duration: 3 })]),
    /song\.mp3 has no video track/
  );
  assert.throws(
    () => buildJoinVideosPlan([VIDEO, source('stream.mkv', { hasVideo: true, duration: null })]),
    /does not report a usable duration/
  );
});

/* ------------------------------------------------------------------ *
 * Adding audio to video
 * ------------------------------------------------------------------ */

const ADD_AUDIO_VIDEO = {
  name: 'odd-phone.mov',
  size: 10_000_000,
  info: {
    hasVideo: true,
    hasAudio: true,
    duration: 7,
    startTime: 5,
    bitrate: 900_000,
    video: { codec: 'h264', width: 321, height: 241, fps: 30, duration: 3, startTime: 5 },
    audio: { codec: 'aac', channels: 1, sampleRate: 44_100, duration: 6, startTime: 6 },
  },
};

const ADD_AUDIO_TRACK = {
  name: 'music.mp3',
  size: 1_000_000,
  info: {
    hasVideo: false,
    hasAudio: true,
    duration: 1,
    startTime: 0.025,
    video: null,
    audio: { codec: 'mp3', channels: 1, sampleRate: 32_000, duration: 1, startTime: 0.025 },
  },
};

const addAudioSource = (video = ADD_AUDIO_VIDEO, audio = ADD_AUDIO_TRACK) => ({ video, audio });

test('add-audio is a specialised role-ordered MP4 plan whose duration belongs to video', () => {
  assert.equal(OPERATIONS.some((operation) => operation.id === 'add-audio-to-video'), false);
  const plan = buildAddAudioPlan(addAudioSource(), { audioOffset: 0.5 });
  const args = body(plan);

  assert.equal(plan.operation, 'add-audio-to-video');
  assert.deepEqual(plan.inputNames, ['input-video.mov', 'input-audio.mp3']);
  assert.deepEqual(args.slice(0, 4), ['-i', 'input-video.mov', '-i', 'input-audio.mp3']);
  assert.deepEqual(plan.outputs, ['output.mp4']);
  assert.equal(plan.mime, 'video/mp4');
  assert.equal(plan.downloadName, 'odd-phone-con-audio.mp4');
  assert.equal(plan.duration, 3, 'the longer original audio/container must not define output length');
  assert.equal(plan.mixMode, 'mix');
  assert.equal(plan.audioFit, 'once');
  assert.equal(valueAfter(args, '-c:v'), 'libx264');
  assert.equal(valueAfter(args, '-c:a'), 'aac');
  assert.equal(valueAfter(args, '-b:a'), '192k');
  assert.equal(valueAfter(args, '-ar'), '48000');
  assert.equal(valueAfter(args, '-ac'), '2');
  assert.equal(valueAfter(args, '-t'), '3');
  assert.equal(valueAfter(args, '-movflags'), '+faststart');
});

test('mix preserves original A/V offset and applies quiet added gain, delay and limiter', () => {
  const graph = valueAfter(body(buildAddAudioPlan(addAudioSource(), { audioOffset: 0.5 })), '-filter_complex');

  assert.match(graph, /^\[0:v:0\]trim=duration=3,setpts=PTS-STARTPTS,pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2,format=yuv420p\[v\]/);
  assert.match(graph, /\[0:a:0\]aresample=48000,aformat=.*channel_layouts=stereo,volume=1,asetpts=PTS-STARTPTS,adelay=1000:all=1,apad,atrim=duration=3\[original\]/);
  assert.match(graph, /\[1:a:0\]atrim=duration=1,aresample=48000,aformat=.*volume=0\.35,asetpts=PTS-STARTPTS,adelay=500:all=1,apad,atrim=duration=3\[added\]/);
  assert.match(graph, /\[original\]\[added\]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0\.95:level=false:latency=true/);
});

test('replace ignores original audio and a negative once offset trims the added track', () => {
  const plan = buildAddAudioPlan(addAudioSource(), {
    mixMode: 'replace',
    audioOffset: -0.25,
    addedGain: 1.5,
    limiter: false,
    audioBitrate: 128,
  });
  const args = body(plan);
  const graph = valueAfter(args, '-filter_complex');

  assert.equal(plan.mixMode, 'replace');
  assert.doesNotMatch(graph, /\[0:a:0\]|amix|alimiter/);
  assert.match(graph, /\[1:a:0\]atrim=start=0\.25:duration=0\.75/);
  assert.match(graph, /volume=1\.5,asetpts=PTS-STARTPTS,apad/);
  assert.equal(valueAfter(args, '-b:a'), '128k');
});

test('a silent primary dynamically becomes full-volume replace', () => {
  const silent = {
    ...ADD_AUDIO_VIDEO,
    name: 'silent.webm',
    info: {
      ...ADD_AUDIO_VIDEO.info,
      hasAudio: false,
      audio: null,
      duration: 3,
      startTime: 0,
      video: { ...ADD_AUDIO_VIDEO.info.video, startTime: 0 },
    },
  };
  const plan = buildAddAudioPlan(addAudioSource(silent));
  const graph = valueAfter(body(plan), '-filter_complex');

  assert.equal(plan.mixMode, 'replace');
  assert.equal(plan.options.addedGain, 1);
  assert.doesNotMatch(graph, /\[0:a:0\]|amix/);
  assert.match(graph, /volume=1,/);
});

test('loop is an input option on added audio and fills only the video timeline', () => {
  const plan = buildAddAudioPlan(addAudioSource(), {
    mixMode: 'replace',
    audioFit: 'loop',
    audioOffset: -10.25,
  });
  const args = body(plan);
  const graph = valueAfter(args, '-filter_complex');

  assert.deepEqual(args.slice(0, 6), ['-i', 'input-video.mov', '-stream_loop', '-1', '-i', 'input-audio.mp3']);
  assert.equal(plan.placement.trimStart, 0.25, 'negative loop offset should fold to one phase');
  assert.equal(plan.placement.audibleDuration, 3);
  assert.match(graph, /\[1:a:0\]atrim=start=0\.25:duration=3/);
  assert.equal(valueAfter(args, '-t'), '3');
});

test('add-audio refuses wrong roles, unknown track duration, bad options and no-overlap', () => {
  assert.throws(
    () => buildAddAudioPlan(addAudioSource({ ...ADD_AUDIO_VIDEO, info: { hasVideo: false } })),
    /primary file with a video track/,
  );
  assert.throws(
    () => buildAddAudioPlan(addAudioSource(ADD_AUDIO_VIDEO, { ...ADD_AUDIO_TRACK, info: { hasAudio: false } })),
    /second file with an audio track/,
  );
  assert.throws(
    () => buildAddAudioPlan(addAudioSource({
      ...ADD_AUDIO_VIDEO,
      info: { ...ADD_AUDIO_VIDEO.info, video: { ...ADD_AUDIO_VIDEO.info.video, duration: null } },
    })),
    /usable track duration/,
  );
  assert.throws(() => buildAddAudioPlan(addAudioSource(), { addedGain: 2.1 }), /options are invalid/);
  assert.throws(() => buildAddAudioPlan(addAudioSource(), { audioOffset: 3 }), /does not overlap/);
  assert.throws(() => buildAddAudioPlan(addAudioSource(), { audioOffset: -1 }), /does not overlap/);
  const delayedOriginal = {
    ...ADD_AUDIO_VIDEO,
    info: {
      ...ADD_AUDIO_VIDEO.info,
      startTime: 0,
      video: { ...ADD_AUDIO_VIDEO.info.video, startTime: 0, duration: 3 },
      audio: { ...ADD_AUDIO_VIDEO.info.audio, startTime: 5, duration: 1 },
    },
  };
  assert.throws(
    () => buildAddAudioPlan(addAudioSource(delayedOriginal), { mixMode: 'mix', originalGain: 1, addedGain: 0 }),
    /silent output/,
  );
});

/* ------------------------------------------------------------------ *
 * Quick video effects
 * ------------------------------------------------------------------ */

test('volume gain filters audio while explicit mute removes the track', () => {
  const gained = buildPlan(VIDEO, 'convert', { volumeGain: 1.5, evenDimensions: true });
  const gainedArgs = body(gained);
  assert.equal(valueAfter(gainedArgs, '-af'), 'volume=1.5');
  assert.equal(valueAfter(gainedArgs, '-vf'), 'pad=ceil(iw/2)*2:ceil(ih/2)*2');
  assert.equal(gained.duration, VIDEO.info.duration);

  const mutedArgs = body(buildPlan(VIDEO, 'convert', {
    volumeGain: 999,
    mute: true,
    evenDimensions: true,
  }));
  assert.ok(mutedArgs.includes('-an'));
  assert.equal(mutedArgs.includes('-af'), false);
  assert.throws(() => buildPlan(VIDEO, 'convert', { volumeGain: 2.01 }), /between 0% and 200%/);
  assert.throws(() => buildPlan(SILENT, 'convert', { volumeGain: 1.5 }), /needs an audio track/);
});

test('speed changes picture and sound together, chaining atempo at both extremes', () => {
  const slow = buildPlan(VIDEO, 'convert', { playbackRate: 0.25, evenDimensions: true });
  const slowArgs = body(slow);
  assert.equal(
    valueAfter(slowArgs, '-vf'),
    'setpts=(PTS-STARTPTS)/0.25,pad=ceil(iw/2)*2:ceil(ih/2)*2',
  );
  assert.equal(valueAfter(slowArgs, '-af'), 'atempo=0.5,atempo=0.5,asetpts=PTS-STARTPTS');
  assert.equal(slow.duration, 480);

  const fast = buildPlan(VIDEO, 'convert', { playbackRate: 4 });
  const fastArgs = body(fast);
  assert.equal(valueAfter(fastArgs, '-vf'), 'setpts=(PTS-STARTPTS)/4');
  assert.equal(valueAfter(fastArgs, '-af'), 'atempo=2,atempo=2,asetpts=PTS-STARTPTS');
  assert.equal(fast.duration, 30);

  const silentArgs = body(buildPlan(SILENT, 'convert', { playbackRate: 1.5 }));
  assert.equal(valueAfter(silentArgs, '-vf'), 'setpts=(PTS-STARTPTS)/1.5');
  assert.equal(silentArgs.includes('-af'), false);
  assert.ok(silentArgs.includes('-an'));
  assert.throws(() => buildPlan(VIDEO, 'convert', { playbackRate: 0.249 }), /between 0.25x and 4x/);
  assert.throws(() => buildPlan(VIDEO, 'convert', { playbackRate: 4.01 }), /between 0.25x and 4x/);
});

test('speed rebases a non-zero origin and preserves a relative A/V delay', () => {
  const offset = source('broadcast.mov', {
    ...VIDEO.info,
    startTime: 5,
    duration: 9.023,
    video: { ...VIDEO.info.video, startTime: 5, duration: 3 },
    audio: { ...VIDEO.info.audio, startTime: 6, duration: 3.023 },
  });
  const plan = buildPlan(offset, 'convert', { playbackRate: 2 });
  const args = body(plan);

  assert.equal(valueAfter(args, '-vf'), 'setpts=(PTS-STARTPTS)/2');
  assert.equal(valueAfter(args, '-af'), 'atempo=2,asetpts=PTS-STARTPTS+0.5/TB');
  assert.ok(args.indexOf('-af') < args.indexOf('-c:a'));
  assert.equal(plan.duration, 2.0115);
});

test('speed refuses unbounded or overlong slow-motion plans before FFmpeg starts', () => {
  const long = source('lecture.mp4', { hasVideo: true, hasAudio: false, duration: 600 });
  assert.throws(
    () => buildPlan(long, 'convert', { playbackRate: 0.25 }),
    /at or below 30 minutes/,
  );
  assert.throws(
    () => buildPlan(UNKNOWN, 'convert', { playbackRate: 0.5 }),
    /needs a source duration/,
  );
  assert.doesNotThrow(() => buildPlan(UNKNOWN, 'convert', { playbackRate: 2 }));

  const partial = source('partial-duration.mp4', {
    hasVideo: true,
    hasAudio: true,
    duration: 1900,
    startTime: 0,
    video: { ...VIDEO.info.video, duration: 100, startTime: 0 },
    audio: { ...VIDEO.info.audio, duration: null, startTime: 0 },
  });
  assert.throws(
    () => buildPlan(partial, 'convert', { playbackRate: 0.25 }),
    /at or below 30 minutes/,
  );
  const unboundedFast = buildPlan(source('partial-unknown.mp4', {
    ...partial.info,
    duration: null,
  }), 'convert', { playbackRate: 2 });
  assert.equal(unboundedFast.duration, null, 'one known stream must not bound another unknown stream');
});

test('loop repeats the input by total count or exact duration within hard limits', () => {
  const counted = buildPlan(VIDEO, 'convert', {
    loopMode: 'count',
    loopCount: 3,
    evenDimensions: true,
  });
  const countArgs = body(counted);
  assert.equal(valueAfter(countArgs, '-stream_loop'), '2');
  assert.ok(countArgs.indexOf('-stream_loop') < countArgs.indexOf('-i'));
  assert.equal(valueAfter(countArgs, '-t'), '00:06:00.000');
  assert.equal(counted.duration, 360);

  const targeted = buildPlan(VIDEO, 'convert', {
    loopMode: 'duration',
    loopDuration: 275.5,
  });
  const targetArgs = body(targeted);
  assert.equal(valueAfter(targetArgs, '-stream_loop'), '-1');
  assert.equal(valueAfter(targetArgs, '-t'), '00:04:35.500');
  assert.equal(targeted.duration, 275.5);

  assert.throws(
    () => buildPlan(VIDEO, 'convert', { loopMode: 'count', loopCount: 16 }),
    /at or below 30 minutes/,
  );
  assert.throws(
    () => buildPlan(VIDEO, 'convert', { loopMode: 'duration', loopDuration: 1801 }),
    /at or below 30 minutes/,
  );
  assert.throws(
    () => buildPlan(UNKNOWN, 'convert', { loopMode: 'count', loopCount: 2 }),
    /at or below 30 minutes/,
  );
});

/* ------------------------------------------------------------------ *
 * Trimming
 * ------------------------------------------------------------------ */

test('trimming seeks before the input, and asks for a duration rather than an end', () => {
  const args = body(buildPlan(VIDEO, 'convert', { trimStart: 5, trimEnd: 12.5 }));

  assert.deepEqual(args.slice(0, 4), ['-ss', '00:00:05.000', '-t', '00:00:07.500']);
  // Before `-i` the seek is a jump; after it, FFmpeg decodes and throws away
  // everything up to the mark, which on a long file takes as long as it sounds.
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'the seek landed after the input');
  // `-to` means different things on either side of `-i` and has changed meaning
  // between versions; a duration is unambiguous in every build.
  assert.equal(args.includes('-to'), false, '-to came back');
});

test('timestamps are written the way the rest of the app writes them', () => {
  const args = body(buildPlan(VIDEO, 'convert', { trimStart: 3661.5, trimEnd: 3661.75 }));

  assert.equal(args[1], '01:01:01.500');
  assert.equal(args[3], '00:00:00.250');
  // Stated as an identity as well as a literal: if `formatTimestamp` ever
  // rounds to whole seconds, trimming would jump and this would catch it.
  assert.equal(args[1], formatTimestamp(3661.5));
  assert.equal(args[3], formatTimestamp(0.25));
});

test('the planned duration follows from the trim, and from what the file admits to', () => {
  const durationOf = (options, from = VIDEO) => buildPlan(from, 'convert', options).duration;

  assert.equal(durationOf({}), 120, 'no trim means the whole file');
  assert.equal(durationOf({ trimStart: 30 }), 90, 'a start alone leaves the rest of the file');
  assert.equal(durationOf({ trimEnd: 30 }), 30, 'an end alone counts from zero');
  assert.equal(durationOf({ trimStart: 10, trimEnd: 25 }), 15);
  // The progress bar divides by this, so an unknown length has to stay null
  // rather than become zero, which would read as "already finished".
  assert.equal(durationOf({}, UNKNOWN), null);
  assert.equal(durationOf({ trimEnd: 8 }, UNKNOWN), 8, 'an end is knowable even when the total is not');
});

test('an end before the start is ignored rather than producing a negative length', () => {
  const plan = buildPlan(VIDEO, 'convert', { trimStart: 60, trimEnd: 10 });
  const args = body(plan);

  assert.equal(plan.duration, 60, 'the nonsensical end was honoured');
  assert.deepEqual(args.slice(0, 2), ['-ss', '00:01:00.000']);
  // A `-t` of minus fifty seconds would be rejected outright, so the end is
  // dropped and the job runs from the start to the end of the file.
  assert.equal(args.includes('-t'), false);
});

test('a start alone adds no length, because the rest of the file is the answer', () => {
  const args = body(buildPlan(VIDEO, 'convert', { trimStart: 30 }));
  assert.deepEqual(args.slice(0, 2), ['-ss', '00:00:30.000']);
  assert.equal(args.includes('-t'), false);
});

/* ------------------------------------------------------------------ *
 * Scaling
 * ------------------------------------------------------------------ */

test('the scale filter bounds the picture without ever enlarging it', () => {
  const chain = chainOf({ resolution: '720' });

  // `force_original_aspect_ratio=decrease` on its own will still stretch a
  // 320x240 clip up to fill a 1280x720 box; the `min()` pair is what stops it.
  assert.ok(chain.includes("scale='min(iw,1280)':'min(ih,720)'"), chain);
  assert.ok(chain.includes('force_original_aspect_ratio=decrease'), chain);
  // H.264 in yuv420p cannot encode an odd dimension, and an odd source height
  // survives the aspect-ratio maths often enough to matter.
  assert.ok(chain.includes('force_divisible_by=2'), chain);
});

test('every resolution on the menu implies an even, 16:9 width', () => {
  for (const resolution of RESOLUTIONS.filter((entry) => entry.height !== null)) {
    const chain = chainOf({ resolution: resolution.id });
    const width = Number(/min\(iw,(\d+)\)/.exec(chain)[1]);
    const height = Number(/min\(ih,(\d+)\)/.exec(chain)[1]);

    assert.equal(height, resolution.height, `${resolution.id} did not bound the height it names`);
    assert.equal(width % 2, 0, `${resolution.id} implies an odd width of ${width}`);
    // 480p and 240p are not whole numbers at 16:9 (853.3 and 426.7), so the
    // rounding to an even width is allowed to move by a pixel and no more.
    assert.ok(Math.abs(width - (resolution.height * 16) / 9) <= 1, `${resolution.id} implies ${width}, which is not 16:9`);
  }
});

test('leaving the resolution alone adds no filter at all', () => {
  const args = body(buildPlan(VIDEO, 'convert', { resolution: 'source' }));
  // An identity filter would still cost a full decode-scale-encode of every
  // frame, so "same as source" has to mean no filter rather than a harmless one.
  assert.equal(args.includes('-vf'), false, 'a filter chain was built for a job that changes nothing');
});

/* ------------------------------------------------------------------ *
 * The filter chain
 * ------------------------------------------------------------------ */

test('frames are dropped first, then the picture is cropped, turned and scaled', () => {
  const chain = chainOf({
    fps: '24',
    cropX: 100,
    cropY: 50,
    cropWidth: 1200,
    cropHeight: 800,
    rotate: 90,
    resolution: '480',
  });

  // Positions rather than a split on commas, because the scale filter contains
  // commas of its own inside min(iw,854).
  assert.ok(chain.indexOf('fps=24') < chain.indexOf('crop='), `crop before the frame drop: ${chain}`);
  assert.ok(chain.indexOf('crop=') < chain.indexOf('transpose='), `rotation before the crop: ${chain}`);
  assert.ok(chain.indexOf('transpose=') < chain.indexOf('scale='), `scaled before rotating: ${chain}`);
  assert.ok(chain.startsWith('fps=24,'), chain);
  // Dropping frames first means nothing downstream works on frames that are
  // about to be thrown away; scaling last means the chosen height describes the
  // picture the user ends up looking at, not the one before it was turned.
  assert.ok(chain.includes("scale='min(iw,854)':'min(ih,480)'"), chain);
});

test('crop coordinates are clamped and snapped to safe even pixels', () => {
  assert.equal(
    chainOf({ cropX: 101, cropY: 51, cropWidth: 9999, cropHeight: 601 }),
    'crop=1820:600:100:50',
  );
  assert.equal(
    chainOf({ x: 10, y: 20, width: 400, height: 300 }),
    'crop=400:300:10:20',
  );
});

test('full-frame and invalid crops add no filter', () => {
  for (const options of [
    {},
    { cropX: 0, cropY: 0, cropWidth: 1920, cropHeight: 1080 },
    { cropWidth: 0, cropHeight: 300 },
    { cropAspect: 'not-a-preset' },
  ]) {
    const args = body(buildPlan(VIDEO, 'convert', options));
    assert.equal(args.includes('-vf'), false, JSON.stringify(options));
  }
});

test('crop bounds follow the visible frame after orientation metadata', () => {
  const rotated = source('portrait.mp4', {
    ...VIDEO.info,
    video: { ...VIDEO.info.video, rotation: 90 },
  });
  assert.equal(chainOf({
    cropX: 100,
    cropY: 200,
    cropWidth: 800,
    cropHeight: 1200,
  }, 'convert', rotated), 'crop=800:1200:100:200');
});

test('focused transformations can repair odd output dimensions at the end', () => {
  const chain = chainOf({ rotate: 90, resolution: '480', evenDimensions: true });
  const pad = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';

  assert.ok(chain.endsWith(pad), chain);
  assert.ok(chain.indexOf('transpose=') < chain.indexOf('scale='), chain);
  assert.ok(chain.indexOf('scale=') < chain.indexOf(pad), chain);
});

test('even-dimension padding is strictly opt in', () => {
  assert.equal(chainOf({ rotate: 90 }).includes('pad='), false);
  assert.equal(chainOf({ rotate: 90, evenDimensions: true }), 'transpose=1,pad=ceil(iw/2)*2:ceil(ih/2)*2');
});

test('rotation and flips map to the filters FFmpeg actually has', () => {
  assert.equal(chainOf({ rotate: 90 }), 'transpose=1');
  assert.equal(chainOf({ rotate: 270 }), 'transpose=2');
  // There is no transpose value for half a turn, so it is two quarter turns.
  assert.equal(chainOf({ rotate: 180 }), 'transpose=1,transpose=1');
  assert.equal(chainOf({ flip: 'horizontal' }), 'hflip');
  assert.equal(chainOf({ flip: 'vertical' }), 'vflip');
  assert.equal(chainOf({ rotate: 90, flip: 'horizontal' }), 'transpose=1,hflip');
});

test('a rotation of zero, or none, leaves the picture alone', () => {
  const args = body(buildPlan(VIDEO, 'convert', { rotate: 0, flip: 'none' }));
  assert.equal(args.includes('-vf'), false);
});

/* ------------------------------------------------------------------ *
 * Video quality
 * ------------------------------------------------------------------ */

test('x264 is given a CRF, a preset and the pixel format everything can decode', () => {
  const args = body(buildPlan(VIDEO, 'convert', { format: 'mp4-h264', quality: 'high', speed: 'slow' }));

  assert.equal(valueAfter(args, '-c:v'), 'libx264');
  assert.equal(valueAfter(args, '-crf'), '18');
  assert.equal(valueAfter(args, '-crf'), String(crfFor('libx264', 'high')), 'the CRF drifted from the table');
  assert.equal(valueAfter(args, '-preset'), 'slow');
  // Without this, x264 will happily pick yuv444p from a high-bit-depth source
  // and produce a file QuickTime and most phones refuse to open.
  assert.equal(valueAfter(args, '-pix_fmt'), 'yuv420p');
});

test('the quality choice moves the CRF and nothing else', () => {
  const crfFrom = (quality) => valueAfter(body(buildPlan(VIDEO, 'convert', { format: 'mp4-h264', quality })), '-crf');

  assert.equal(crfFrom('high'), '18');
  assert.equal(crfFrom('balanced'), '23');
  assert.equal(crfFrom('small'), '28');
  // Higher CRF is a smaller file: the scale runs the opposite way to the label,
  // which is exactly the mistake worth having a test for.
  assert.ok(Number(crfFrom('high')) < Number(crfFrom('small')));
});

test('VP8 has no constant-quality mode, so its CRF comes with a bitrate cap', () => {
  const args = body(buildPlan(VIDEO, 'convert', { format: 'webm-vp8', quality: 'balanced' }));

  assert.equal(valueAfter(args, '-c:v'), 'libvpx');
  assert.equal(valueAfter(args, '-crf'), String(crfFor('libvpx', 'balanced')));
  // For VP8 the CRF alone is ignored without a `-b:v` to bound it — and unlike
  // VP9 there is no `-b:v 0` that means "constant quality", so it is a real cap.
  assert.equal(valueAfter(args, '-b:v'), '2M');
  assert.notEqual(valueAfter(args, '-b:v'), '0', 'a zero cap is VP9 syntax, and VP8 reads it as unbounded');
});

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

test('each audio format asks for the encoder the table names', () => {
  for (const format of AUDIO_FORMATS) {
    const args = body(buildPlan(VIDEO, 'extract-audio', { audioFormat: format.id, audioBitrate: 96 }));

    assert.equal(valueAfter(args, '-c:a'), AUDIO_ENCODERS[format.id], `${format.id} used the wrong encoder`);
    assert.ok(args.includes('-vn'), `${format.id} kept the video stream`);
    assert.equal(args.at(-1), `output.${format.extension}`, `${format.id} wrote the wrong file`);
  }
});

test('the lossless formats are not offered a bitrate they cannot honour', () => {
  for (const format of AUDIO_FORMATS) {
    const args = body(buildPlan(VIDEO, 'extract-audio', { audioFormat: format.id, audioBitrate: 96 }));
    const lossless = Boolean(format.lossless);

    // `-b:a` to PCM or FLAC is not merely useless: it is a request the encoder
    // cannot satisfy, and asking for it silently produces a file of a different
    // size than the number implies.
    assert.equal(args.includes('-b:a'), !lossless, `${format.id} ${lossless ? 'was given' : 'was denied'} a bitrate`);
    if (!lossless) assert.equal(valueAfter(args, '-b:a'), '96k', format.id);
  }
});

test('FLAC is given a compression level, and it is clamped to what the encoder accepts', () => {
  const level = (options) => valueAfter(body(buildPlan(VIDEO, 'extract-audio', { audioFormat: 'flac', ...options })), '-compression_level');

  assert.equal(level({}), String(FLAC_COMPRESSION.default), 'the default level is not the one the table names');
  assert.equal(level({ flacCompression: 0 }), '0');
  assert.equal(level({ flacCompression: 12 }), '12');

  // Out of range is a number FFmpeg refuses outright, so it is brought back in
  // rather than passed through to fail at the last moment.
  assert.equal(level({ flacCompression: 99 }), String(FLAC_COMPRESSION.max));
  assert.equal(level({ flacCompression: -4 }), String(FLAC_COMPRESSION.min));
  assert.equal(level({ flacCompression: 7.6 }), '8');
  assert.equal(level({ flacCompression: 'loud' }), String(FLAC_COMPRESSION.default));
});

test('the compression level is the only thing it changes, because FLAC is lossless', () => {
  const args = (level) => body(buildPlan(VIDEO, 'extract-audio', { audioFormat: 'flac', flacCompression: level }));
  const without = (list) => list.filter((argument, index) => argument !== '-compression_level' && list[index - 1] !== '-compression_level');

  // Every level decodes to identical samples. If a level ever started moving
  // some other argument, that would be a quality setting wearing a disguise.
  assert.deepEqual(without(args(0)), without(args(12)));
});

test('codecs are classified only when the answer is known', () => {
  for (const codec of ['mp3', 'aac', 'opus', 'vorbis', 'ac3', 'wmav2']) {
    assert.equal(audioFidelity(codec), 'lossy', codec);
  }
  for (const codec of ['flac', 'alac', 'pcm_s16le', 'pcm_f32be', 'wavpack']) {
    assert.equal(audioFidelity(codec), 'lossless', codec);
  }
  // A warning built on a guess is worse than no warning, so anything the table
  // does not recognise says so instead of picking a side.
  for (const codec of ['', null, undefined, 'something_new']) {
    assert.equal(audioFidelity(codec), 'unknown', String(codec));
  }
});

test('a video keeps an audio track encoded for the container it is going into', () => {
  assert.equal(valueAfter(body(buildPlan(VIDEO, 'convert', { format: 'mp4-h264' })), '-c:a'), 'aac');
  // WebM cannot carry AAC, so the format table's second encoder decides.
  assert.equal(valueAfter(body(buildPlan(VIDEO, 'convert', { format: 'webm-vp8' })), '-c:a'), 'libvorbis');
});

/* ------------------------------------------------------------------ *
 * Silence
 * ------------------------------------------------------------------ */

test('mute drops the track, and a source with no track drops it too', () => {
  const muted = body(buildPlan(VIDEO, 'convert', { mute: true }));
  assert.ok(muted.includes('-an'), 'mute did not silence the output');
  assert.equal(muted.includes('-c:a'), false, 'an encoder was configured for a stream that will not exist');

  // Not the same reason, but it has to be the same argument: without `-an`,
  // some muxers still write an empty audio stream, and players show a track.
  const silent = body(buildPlan(SILENT, 'convert', {}));
  assert.ok(silent.includes('-an'), 'a silent source was given an audio encoder anyway');
  assert.equal(silent.includes('-c:a'), false);
});

test('muting an audio extraction is ignored, because it would produce nothing at all', () => {
  const args = body(buildPlan(VIDEO, 'extract-audio', { audioFormat: 'mp3', mute: true }));
  assert.equal(args.includes('-an'), false, 'the only stream the user asked for was removed');
  assert.equal(valueAfter(args, '-c:a'), 'libmp3lame');
});

/* ------------------------------------------------------------------ *
 * Containers
 * ------------------------------------------------------------------ */

test('the MP4 family moves its index to the front, and the others have no index to move', () => {
  const movflags = (plan) => valueAfter(body(plan), '-movflags');

  // Without this the moov atom lands at the end of the file, and a browser
  // cannot start playing until the whole thing has downloaded.
  assert.equal(movflags(buildPlan(VIDEO, 'convert', { format: 'mp4-h264' })), '+faststart');
  assert.equal(movflags(buildPlan(VIDEO, 'convert', { format: 'mov-h264' })), '+faststart');
  // M4A is the ipod muxer, which is MP4 wearing a different name.
  assert.equal(movflags(buildPlan(VIDEO, 'extract-audio', { audioFormat: 'm4a' })), '+faststart');

  for (const format of ['webm-vp8', 'mkv-h264']) {
    const args = body(buildPlan(VIDEO, 'convert', { format }));
    // Matroska and WebM are streamable by construction; `-movflags` is not a
    // valid option for them and would be an error rather than a no-op.
    assert.equal(args.includes('-movflags'), false, `${format} was given an MP4 option`);
  }
});

/* ------------------------------------------------------------------ *
 * GIF
 * ------------------------------------------------------------------ */

test('a GIF is a palette built from the clip, then a quantisation against it', () => {
  const plan = buildPlan(VIDEO, 'gif', { gifFps: 15, gifWidth: 320, trimStart: 2, trimEnd: 4 });
  assert.equal(plan.steps.length, 2, 'a one-pass GIF is the banded mess this operation exists to avoid');

  const first = body(plan, 0);
  const second = body(plan, 1);

  assert.equal(first.at(-1), 'palette.png', 'the first pass did not write the palette');
  assert.ok(valueAfter(first, '-vf').includes('palettegen'), 'the first pass is not generating a palette');

  // The palette has to arrive as a second input, and `paletteuse` reads it as
  // `[1:v]`, so the order of the two `-i` arguments is load-bearing.
  assert.equal(second.indexOf('-i', second.indexOf('-i') + 1), second.indexOf('palette.png') - 1);
  assert.ok(valueAfter(second, '-lavfi').includes('paletteuse'), 'the second pass ignores the palette');
  assert.deepEqual(plan.outputs, ['output.gif']);
  assert.equal(plan.mime, 'image/gif');
  assert.equal(plan.duration, 2);
});

test('both GIF passes see exactly the same frames', () => {
  const plan = buildPlan(VIDEO, 'gif', { gifFps: 15, gifWidth: 320, trimStart: 2, trimEnd: 4 });
  const first = body(plan, 0);
  const second = body(plan, 1);

  const paletteChain = valueAfter(first, '-vf').replace(/,palettegen.*$/, '');
  const useChain = valueAfter(second, '-lavfi').replace(/\[x\];.*$/, '');

  // A palette built from every frame at full size, then applied to a decimated
  // and shrunken clip, is a palette for pictures that no longer exist: the
  // colours it picked are not the colours being quantised.
  assert.equal(paletteChain, useChain, 'the two passes filter the source differently');
  assert.equal(paletteChain, 'fps=15,scale=320:-1:flags=lanczos');
  // Same for the seek: a palette from seconds 0-2 applied to seconds 2-4 is
  // just as wrong, and much harder to notice.
  assert.deepEqual(first.slice(0, 4), ['-ss', '00:00:02.000', '-t', '00:00:02.000']);
  assert.deepEqual(second.slice(0, 4), first.slice(0, 4));
});

test('turning dither off says so, rather than leaving it to the default', () => {
  const paletteuse = (options) => valueAfter(body(buildPlan(VIDEO, 'gif', options), 1), '-lavfi');

  assert.ok(paletteuse({ dither: false }).includes('paletteuse=dither=none'), paletteuse({ dither: false }));
  // FFmpeg's own default is sierra2_4a, so "dither on" still has to be stated
  // for the flat-colour result the option promises to be the one that changes.
  assert.ok(paletteuse({ dither: true }).includes('dither=bayer'), paletteuse({ dither: true }));
});

test('asking convert for a GIF builds the GIF plan rather than a video with a .gif name', () => {
  const viaConvert = buildPlan(VIDEO, 'convert', { format: 'gif', gifFps: 12, gifWidth: 480 });
  const direct = buildPlan(VIDEO, 'gif', { gifFps: 12, gifWidth: 480 });

  assert.deepEqual(viaConvert.steps, direct.steps);
  assert.deepEqual(viaConvert.outputs, ['output.gif']);
});

/* ------------------------------------------------------------------ *
 * Compressing to a size
 * ------------------------------------------------------------------ */

test('compressing is two passes, and the first one throws its pictures away', () => {
  const plan = buildPlan(VIDEO, 'compress', { targetSize: 10 });
  assert.equal(plan.steps.length, 2);

  const first = body(plan, 0);
  const second = body(plan, 1);

  assert.equal(valueAfter(first, '-pass'), '1');
  // The measuring pass has no use for sound, and `-f null -` discards the
  // encoded frames: it is writing the statistics file and nothing else.
  assert.ok(first.includes('-an'), 'the measuring pass encodes audio it will not keep');
  assert.deepEqual(first.slice(-3), ['-f', 'null', '-']);

  assert.equal(valueAfter(second, '-pass'), '2');
  assert.equal(valueAfter(second, '-c:a'), 'aac');
  assert.equal(second.at(-1), 'output.mp4');

  // Statistics collected under different settings describe a different encode,
  // so everything up to the pass number has to match exactly.
  assert.deepEqual(first.slice(0, first.indexOf('-pass')), second.slice(0, second.indexOf('-pass')));
});

test('the video bitrate falls out of the target size, the length and the audio', () => {
  // 10 MB is 80,000,000 bits. Keep 97% of it for the picture and the sound and
  // leave the rest for container overhead: 77,600,000 bits over 60 seconds is
  // 1293.33 kbps for everything, and the audio takes 128 of that.
  const plan = buildPlan(MINUTE, 'compress', { targetSize: 10, audioBitrate: 128 });
  const second = body(plan, 1);

  assert.equal(valueAfter(second, '-b:v'), '1165k');
  assert.equal(valueAfter(second, '-b:a'), '128k');
  // The inspector prints this line; it must be the same number that is about to
  // be run, or the preview is a plausible-looking reconstruction after all.
  assert.equal(plan.note, 'About 1165 kbps of video and 128 kbps of audio.');
});

test('silencing the output gives the whole budget to the picture', () => {
  const plan = buildPlan(MINUTE, 'compress', { targetSize: 10, audioBitrate: 128, mute: true });
  const second = body(plan, 1);

  assert.equal(valueAfter(second, '-b:v'), '1293k', 'the audio was still subtracted from a file with no audio');
  assert.ok(second.includes('-an'));
  assert.equal(second.includes('-b:a'), false);
});

test('an impossible target lands on a floor rather than a negative bitrate', () => {
  const hour = source('lecture.mp4', { hasVideo: true, hasAudio: true, duration: 3600 });
  const plan = buildPlan(hour, 'compress', { targetSize: 0.1, audioBitrate: 128 });

  // 0.1 MB over an hour is a fifth of a kilobit per second, and the audio alone
  // is 128: the honest subtraction is negative, which FFmpeg simply rejects.
  assert.equal(valueAfter(body(plan, 1), '-b:v'), '64k');
});

test('compressing a file of unknown length says so instead of guessing', () => {
  assert.throws(() => buildPlan(UNKNOWN, 'compress', { targetSize: 8 }), /how long the file is/);
  // A zero-length trim leaves the same hole in the arithmetic.
  assert.throws(() => buildPlan(source('x.mp4', { hasVideo: true, duration: 0 }), 'compress', {}), /how long the file is/);
});

/* ------------------------------------------------------------------ *
 * Splitting a command line
 * ------------------------------------------------------------------ */

test('a plain command splits on whitespace', () => {
  assert.deepEqual(splitArguments('-i in.mp4 -c:v libx264 out.mp4'), ['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4']);
  assert.deepEqual(splitArguments('   -y \t -vn  \n -an  '), ['-y', '-vn', '-an']);
  assert.deepEqual(splitArguments(''), []);
  assert.deepEqual(splitArguments('    '), []);
});

test('quotes hold a value together, including one that is deliberately empty', () => {
  assert.deepEqual(splitArguments("-vf 'scale=640:-1,fps=12'"), ['-vf', 'scale=640:-1,fps=12']);
  assert.deepEqual(splitArguments('-metadata title="My Trip"'), ['-metadata', 'title=My Trip']);
  // An empty argument is a real thing to pass — `-metadata title=''` clears a
  // field — so the quotes have to survive as an argument rather than vanish.
  assert.deepEqual(splitArguments("-metadata title='' -y"), ['-metadata', 'title=', '-y']);
  assert.deepEqual(splitArguments(`-map "0:v" '0:a'`), ['-map', '0:v', '0:a']);
});

test('escapes work outside quotes and inside double quotes, and stay literal inside single ones', () => {
  assert.deepEqual(splitArguments(String.raw`my\ clip.mp4`), ['my clip.mp4']);
  assert.deepEqual(splitArguments(String.raw`-metadata "title=say \"hi\""`), ['-metadata', 'title=say "hi"']);
  // A backslash inside single quotes is a backslash, which is what makes single
  // quotes the safe way to paste a Windows path or a filter with escapes in it.
  assert.deepEqual(splitArguments(String.raw`'C:\clips\a.mp4'`), [String.raw`C:\clips\a.mp4`]);
});

test('an unbalanced quote is refused rather than guessed at', () => {
  // Guessing where the quote was meant to close would silently run something
  // other than what was typed.
  assert.throws(() => splitArguments('-i "unclosed.mp4'), /Unbalanced double quote/);
  assert.throws(() => splitArguments("-i 'unclosed.mp4"), /Unbalanced single quote/);
});

test('nothing is globbed, expanded or executed', () => {
  // This is a splitter, not a shell: everything below is one ordinary argument
  // that FFmpeg will read literally, and none of it reaches an interpreter.
  assert.deepEqual(splitArguments('-i *.mp4'), ['-i', '*.mp4']);
  assert.deepEqual(splitArguments('-i $HOME/clip.mp4'), ['-i', '$HOME/clip.mp4']);
  assert.deepEqual(splitArguments('-i ~/clip.mp4 out?.mp4'), ['-i', '~/clip.mp4', 'out?.mp4']);
  assert.deepEqual(splitArguments('out.mp4; rm -rf /'), ['out.mp4;', 'rm', '-rf', '/']);
  assert.deepEqual(splitArguments('$(id) `id`'), ['$(id)', '`id`']);
});

/* ------------------------------------------------------------------ *
 * The raw command
 * ------------------------------------------------------------------ */

test('$in and $out become the names the core knows the files by', () => {
  const plan = buildPlan(VIDEO, 'raw', { rawArguments: '-i $in -c copy $out.mkv' });

  assert.deepEqual(body(plan), ['-i', 'input.mp4', '-c', 'copy', 'output.mkv']);
  assert.deepEqual(plan.inputNames, ['input.mp4']);
  assert.deepEqual(plan.outputs, ['output.mkv']);
  assert.equal(plan.downloadName, 'holiday.mkv');
});

test('every $in is substituted, not just the first', () => {
  const args = body(buildPlan(VIDEO, 'raw', { rawArguments: '-i $in -i $in -filter_complex hstack $out.mp4' }));
  assert.equal(args.filter((argument) => argument === 'input.mp4').length, 2);
  assert.equal(args.some((argument) => argument.includes('$in')), false, 'a placeholder survived into the command');
});

test('the extension written after $out decides what comes out', () => {
  const outputOf = (rawArguments) => buildPlan(VIDEO, 'raw', { rawArguments }).outputs[0];

  assert.equal(outputOf('-i $in -vn $out.wav'), 'output.wav');
  assert.equal(outputOf('-i $in $out.gif'), 'output.gif');
  // With nothing written after it, there is no better guess than the source's
  // own extension — a `-c copy` remux is the common case, and it is right there.
  assert.equal(outputOf('-i $in -c copy $out'), 'output.mp4');
  assert.equal(buildPlan(VIDEO, 'raw', { rawArguments: '-i $in -vn $out.mp3' }).downloadName, 'holiday.mp3');
});

test('a command that reads nothing, or writes nothing, is refused with a reason', () => {
  // All three run in the browser against a filesystem holding one file, so
  // "it did nothing" would be the only other feedback available.
  assert.throws(() => buildPlan(VIDEO, 'raw', { rawArguments: '-i clip.mp4 $out.mp4' }), /has to read \$in/);
  assert.throws(() => buildPlan(VIDEO, 'raw', { rawArguments: '-i $in -f null -' }), /has to write \$out/);
  assert.throws(() => buildPlan(VIDEO, 'raw', { rawArguments: '   ' }), /Nothing to run/);
});

/* ------------------------------------------------------------------ *
 * The preview
 * ------------------------------------------------------------------ */

test('the preview is one line per invocation, each one runnable as written', () => {
  const plan = buildPlan(VIDEO, 'gif', { gifWidth: 320 });
  const lines = planToCommand(plan).split('\n');

  assert.equal(lines.length, plan.steps.length, 'two invocations were printed as one command');
  for (const line of lines) assert.ok(line.startsWith('ffmpeg '), line);
});

test('the preview quotes exactly what a shell would need quoted', () => {
  const command = planToCommand(buildPlan(VIDEO, 'convert', { resolution: '720' }));

  // The filter contains quotes and parentheses; copied into a terminal unquoted
  // it would be a syntax error, and the whole point of the button is that what
  // is shown is what is run.
  assert.ok(command.includes(String.raw`'scale='\''min(iw,1280)'\''`), command);
  // Ordinary arguments stay bare, or the preview becomes unreadable.
  assert.ok(command.includes(' -i input.mp4 '), command);
  assert.ok(command.includes(' -c:v libx264 '), command);
});

test('an argument with a space in it survives the round trip', () => {
  const plan = buildPlan(VIDEO, 'raw', { rawArguments: '-i $in -metadata "title=My Trip" $out.mp4' });
  const command = planToCommand(plan);

  assert.ok(command.includes("'title=My Trip'"), command);
  // Re-splitting the printed line has to give back the arguments it was built
  // from, which is the only real definition of "quoted correctly".
  assert.deepEqual(splitArguments(command.replace(/^ffmpeg /, '')), plan.steps[0].args);
});

/* ------------------------------------------------------------------ *
 * Which operations are offered
 * ------------------------------------------------------------------ */

test('an audio file is not offered the operations that need pictures', () => {
  const offered = operationsFor({ hasVideo: false, hasAudio: true });

  assert.deepEqual(offered.map((operation) => operation.id), ['convert', 'raw']);
  // Offering "extract audio" or "poster frame" for an MP3 would produce a job
  // that fails inside FFmpeg, several seconds after the user chose it.
  assert.equal(offered.some((operation) => operation.accepts === 'video'), false);
});

test('a video is offered everything, and an unreadable file only the safe two', () => {
  // Everything, once the codecs are known. Repackaging is offered on what the
  // streams *are*, so a source that only says "there are pictures" cannot have
  // it: there is no way to tell which containers would take them.
  assert.deepEqual(
    operationsFor(REMUXABLE.info).map((operation) => operation.id),
    OPERATIONS.map((operation) => operation.id)
  );
  assert.deepEqual(
    operationsFor({ hasVideo: true }).map((operation) => operation.id),
    OPERATIONS.filter((operation) => operation.id !== 'remux').map((operation) => operation.id)
  );
  for (const info of [null, undefined, {}]) {
    assert.deepEqual(operationsFor(info).map((operation) => operation.id), ['convert', 'raw'], String(info));
  }
});

/* ------------------------------------------------------------------ *
 * Repackaging
 * ------------------------------------------------------------------ */

test('a container is offered only when it can carry these exact streams', () => {
  // H.264 and AAC: MP4 and MOV take both, M4A takes the sound on its own, and
  // WebM takes neither. Matroska is absent because the file is already one.
  assert.deepEqual(remuxTargets(REMUXABLE.info).map((container) => container.id), ['mp4', 'mov', 'm4a']);

  // VP8 and Vorbis are the mirror image: Matroska and Ogg, and nothing Apple.
  const webm = {
    hasVideo: true, hasAudio: true, duration: 10,
    formats: ['matroska', 'webm'], video: { codec: 'vp8' }, audio: { codec: 'vorbis' },
  };
  assert.deepEqual(remuxTargets(webm).map((container) => container.id), ['ogg']);
});

test('HEVC can be repackaged, which is the only way this app can touch it at all', () => {
  // There is no HEVC output format and there must not be one: `libx265` is
  // compiled in, listed by `-encoders`, and hangs the core outright when asked
  // to encode. Copying never asks for an encoder, so the stream still moves.
  const phone = {
    hasVideo: true, hasAudio: true, duration: 30,
    formats: ['mov', 'mp4', 'm4a'], video: { codec: 'hevc' }, audio: { codec: 'aac' },
  };
  // MP4 above all: an HEVC recording is already in the MP4 family, and the one
  // thing everybody wants from it is the extension every player recognises.
  assert.deepEqual(remuxTargets(phone, 'IMG_4021.mov').map((container) => container.id), ['mp4', 'mkv', 'm4a']);

  const plan = buildPlan(source('IMG_4021.mov', phone), 'remux', { remuxTarget: 'mp4' });
  assert.deepEqual(body(plan), [
    '-i', 'input.mov', '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', 'output.mp4',
  ]);
  assert.equal(plan.downloadName, 'IMG_4021.mp4');
});

test('repackaging copies both streams and asks for no encoder', () => {
  const plan = buildPlan(REMUXABLE, 'remux', { remuxTarget: 'mp4' });

  assert.deepEqual(body(plan), [
    '-i', 'input.mkv', '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', 'output.mp4',
  ]);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.downloadName, 'holiday.mp4');

  // The promise the operation makes. If any of these turns up, it is not a
  // repackage any more and the "nothing is lost" claim is false.
  for (const flag of ['-c:v', '-c:a', '-crf', '-b:v', '-vf', '-preset', '-ss', '-t']) {
    assert.equal(body(plan).includes(flag), false, `${flag} means something is being processed`);
  }
});

test('an audio container drops the picture and keeps the sound untouched', () => {
  const plan = buildPlan(REMUXABLE, 'remux', { remuxTarget: 'm4a' });

  assert.deepEqual(body(plan), ['-i', 'input.mkv', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', 'output.m4a']);
  assert.equal(body(plan).includes('0:v:0?'), false, 'the video stream is still being mapped in');
  assert.equal(plan.mime, 'audio/mp4');
});

test('a container that cannot hold these streams falls back, and says which one it used', () => {
  // A target left over from the previous file, impossible for this one. The
  // alternative is emitting a command FFmpeg refuses several seconds later.
  const plan = buildPlan(REMUXABLE, 'remux', { remuxTarget: 'webm' });

  assert.equal(plan.container, 'mp4');
  assert.match(plan.note, /WebM cannot hold these streams/);
  assert.equal(plan.downloadName, 'holiday.mp4');
});

test('the file is never offered the container it is already in', () => {
  const matroska = {
    hasVideo: true, hasAudio: true, duration: 10,
    formats: ['matroska', 'webm'], video: { codec: 'h264' }, audio: { codec: 'aac' },
  };
  const offered = remuxTargets(matroska, 'holiday.mkv').map((container) => container.id);

  assert.equal(offered.includes('mkv'), false, 'repackaging an MKV as an MKV does nothing');
  assert.equal(offered.includes('mp4'), true);
});

test('inside the MP4 family the extension decides, because the format list cannot', () => {
  // One demuxer serves MP4, MOV, M4A and 3GP, so `ffprobe` describes all of
  // them with the same string. Believing it ruled out both MP4 and MOV for
  // every file in the family, which removed the most useful case there is.
  const family = {
    hasVideo: true, hasAudio: true, duration: 10,
    formats: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'], video: { codec: 'h264' }, audio: { codec: 'aac' },
  };

  const fromMov = remuxTargets(family, 'IMG_4021.mov').map((container) => container.id);
  assert.equal(fromMov.includes('mp4'), true, 'a MOV must be offerable as an MP4');
  assert.equal(fromMov.includes('mov'), false, 'and not as another MOV');

  const fromMp4 = remuxTargets(family, 'holiday.mp4').map((container) => container.id);
  assert.equal(fromMp4.includes('mov'), true);
  assert.equal(fromMp4.includes('mp4'), false);

  // Lifting the AAC out is worth offering either way: the point of an audio
  // container is dropping the picture, which is never a no-op.
  assert.equal(fromMov.includes('m4a'), true);
  assert.equal(fromMp4.includes('m4a'), true);
});

test('the name can travel on the info, which is where the worker puts it', () => {
  // `probe` sends back `{...info, size, name}`, so the common case needs no
  // second argument at all.
  const info = {
    hasVideo: true, hasAudio: true, duration: 10, name: 'IMG_4021.mov',
    formats: ['mov', 'mp4', 'm4a'], video: { codec: 'h264' }, audio: { codec: 'aac' },
  };
  assert.equal(remuxTargets(info).map((container) => container.id).includes('mp4'), true);
  assert.equal(remuxTargets(info).map((container) => container.id).includes('mov'), false);
});

test('every PCM flavour is treated as one, because the containers treat it that way', () => {
  for (const codec of ['pcm_s16le', 'pcm_s24le', 'pcm_f32be']) {
    const raw = { hasVideo: false, hasAudio: true, duration: 5, formats: ['mov'], audio: { codec } };
    assert.equal(remuxTargets(raw).map((container) => container.id).includes('wav'), true, codec);
  }
});

test('a file whose codecs nothing will carry is not offered the operation', () => {
  const exotic = {
    hasVideo: true, hasAudio: true, duration: 10,
    formats: ['avi'], video: { codec: 'cinepak' }, audio: { codec: 'qdm2' },
  };

  assert.deepEqual(remuxTargets(exotic), []);
  assert.equal(operationsFor(exotic).some((operation) => operation.id === 'remux'), false);
  assert.throws(() => buildPlan(source('old.avi', exotic), 'remux', {}), /Convert it instead/);
});
