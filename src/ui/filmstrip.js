/**
 * Thumbnails for the timeline, from the browser rather than from FFmpeg.
 *
 * The obvious way to fill a filmstrip is to ask the core for stills, and it is
 * the wrong way here. Every still is another invocation, and one instance of
 * this core does not survive many of them: whatever it is asked to do, it
 * eventually traps with "memory access out of bounds" — around the seventieth
 * call for something trivial. A strip is a dozen stills, and it has to be
 * redrawn on every zoom. That is a budget the engine does not have, and it
 * would be spending it on pictures nobody keeps while the conversion people
 * actually asked for waits behind them in the queue.
 *
 * A `<video>` the browser can already decode costs none of that. Seeking it and
 * drawing to a canvas is the same decoder that paints the preview, it runs off
 * the engine entirely, and it leaves the core free for the job it is for.
 *
 * The cost is that it only works for formats the browser understands — MP4 and
 * WebM, mostly, not MKV and not most HEVC. That is a real limit and the caller
 * is told about it rather than left with an empty strip.
 */

/** How wide each thumbnail is drawn. Small: this is a strip, not a gallery. */
const THUMB_HEIGHT = 44;

/**
 * Whether this element has enough of a video to draw from.
 *
 * `readyState` is the honest question. A `<video>` that failed to decode still
 * exists, still has a `src`, and still reports a duration of NaN, so asking
 * anything else invites drawing a blank canvas and calling it a thumbnail.
 */
export const canDraw = (video) =>
  Boolean(video) && video.readyState >= 2 && video.videoWidth > 0 && Number.isFinite(video.duration);

/**
 * Seek to one instant and wait until the frame there is actually showing.
 *
 * `currentTime = x` returns immediately and the picture arrives later, so
 * drawing straight afterwards paints whatever frame was up before. `seeked` is
 * the event that means the new one is ready. The timeout is there because a
 * seek past the end, or into a damaged region, never fires it at all.
 */
function seek(video, time, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolve(ok);
    };
    const onSeeked = () => done(true);
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), 2000);

    if (signal?.aborted) {
      done(false);
      return;
    }
    video.addEventListener('seeked', onSeeked);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      video.currentTime = Math.max(0, Math.min(time, video.duration - 0.001));
    } catch {
      done(false);
    }
  });
}

/**
 * Draw `count` frames spread across `[from, to]`.
 *
 * Serial on purpose: a `<video>` has one playhead, so overlapping seeks would
 * race and several thumbnails would be the same frame. `signal` lets a strip
 * that is already out of date stop partway rather than finish work whose result
 * is going to be thrown away — which is the normal case while someone is
 * zooming, because a new strip is wanted before the last one is done.
 *
 * @returns {Promise<Array<{time: number, canvas: HTMLCanvasElement}>>}
 */
export async function drawStrip(video, { from, to, count, signal }) {
  if (!canDraw(video) || count < 1) return [];

  const width = Math.max(1, Math.round((video.videoWidth / video.videoHeight) * THUMB_HEIGHT));
  const frames = [];
  const span = to - from;

  for (let i = 0; i < count; i += 1) {
    if (signal?.aborted) break;

    // The middle of each slot rather than its edge: the first thumbnail of a
    // whole-file strip should be a frame from the film, not the black one that
    // so many files open on.
    const time = from + (span * (i + 0.5)) / count;
    if (!(await seek(video, time, signal))) continue;
    if (signal?.aborted) break;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = THUMB_HEIGHT;
    try {
      canvas.getContext('2d').drawImage(video, 0, 0, width, THUMB_HEIGHT);
    } catch {
      // Tainted canvas, or a decoder that gave up mid-strip. One missing
      // thumbnail is not a reason to abandon the rest.
      continue;
    }
    frames.push({ time, canvas });
  }

  return frames;
}

/** How many thumbnails fit, given how wide the strip is on screen. */
export const fitCount = (pixels) => Math.max(1, Math.min(24, Math.floor(pixels / 78)));
