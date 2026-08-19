import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  audioMixOffsetBounds,
  audioMixOffsetForKey,
  audioMixTimelineMetrics,
  clampAudioMixOffset,
  formatAudioMixOffset,
} from '../src/ui/audio-mix-timeline.js';

test('signed offsets keep millisecond precision', () => {
  assert.equal(formatAudioMixOffset(0), '0:00');
  assert.equal(formatAudioMixOffset(5), '+0:05');
  assert.equal(formatAudioMixOffset(-5.25), '−0:05.250');
  assert.equal(formatAudioMixOffset(3661.5), '+1:01:01.500');
  assert.equal(formatAudioMixOffset(59.9996), '+1:00');
});

test('once geometry clips audio that began before the video', () => {
  const metrics = audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 4,
    offset: -2,
    fit: 'once',
    currentTime: 2.5,
  });

  assert.equal(metrics.visibleStart, 0);
  assert.equal(metrics.visibleEnd, 2);
  assert.equal(metrics.leftPercent, 0);
  assert.equal(metrics.widthPercent, 20);
  assert.equal(metrics.playheadPercent, 25);
  assert.equal(metrics.clippedStart, true);
  assert.equal(metrics.clippedEnd, false);
  assert.equal(metrics.outOfFrame, null);
});

test('once geometry trims a long audio track at the video end', () => {
  const metrics = audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 8,
    offset: 6,
    fit: 'once',
  });

  assert.equal(metrics.visibleStart, 6);
  assert.equal(metrics.visibleEnd, 10);
  assert.equal(metrics.leftPercent, 60);
  assert.equal(metrics.widthPercent, 40);
  assert.equal(metrics.clippedEnd, true);
});

test('loop is explicit and fills only from its signed start to the video end', () => {
  const positive = audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 3,
    offset: 2,
    fit: 'loop',
  });
  assert.equal(positive.visibleStart, 2);
  assert.equal(positive.visibleEnd, 10);
  assert.equal(positive.widthPercent, 80);
  assert.equal(positive.loopCount, 3);

  const negative = audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 3,
    offset: -1,
    fit: 'loop',
  });
  assert.equal(negative.visibleStart, 0);
  assert.equal(negative.visibleEnd, 10);
  assert.equal(negative.clippedStart, true);
  assert.equal(negative.loopCount, 4);

  const severalCyclesBeforeZero = audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 2,
    offset: -5,
    fit: 'loop',
  });
  assert.equal(severalCyclesBeforeZero.visibleStart, 0);
  assert.equal(severalCyclesBeforeZero.visibleEnd, 10);
  assert.equal(severalCyclesBeforeZero.outOfFrame, null);
});

test('geometry identifies audio wholly outside the video', () => {
  assert.equal(audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 2,
    offset: -3,
  }).outOfFrame, 'before');

  assert.equal(audioMixTimelineMetrics({
    videoDuration: 10,
    audioDuration: 2,
    offset: 10,
  }).outOfFrame, 'after');
});

test('offset bounds preserve a small audible overlap at either edge', () => {
  assert.deepEqual(audioMixOffsetBounds(10, 4), { min: -3.99, max: 9.99 });
  assert.equal(clampAudioMixOffset(-9, 10, 4), -3.99);
  assert.equal(clampAudioMixOffset(12, 10, 4), 9.99);
});

test('keyboard offset supports fine, coarse and boundary movement', () => {
  const context = { videoDuration: 10, audioDuration: 4 };
  assert.equal(audioMixOffsetForKey(-1, 'ArrowLeft', context), -1.1);
  assert.equal(audioMixOffsetForKey(-1, 'ArrowRight', { ...context, shiftKey: true }), 0);
  assert.equal(audioMixOffsetForKey(0, 'PageUp', context), 5);
  assert.equal(audioMixOffsetForKey(0, 'Home', context), -3.99);
  assert.equal(audioMixOffsetForKey(0, 'End', context), 9.99);
  assert.equal(audioMixOffsetForKey(0, 'Enter', context), null);
});
