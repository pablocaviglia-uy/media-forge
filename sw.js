/**
 * Service worker: makes the whole app work with no network at all.
 *
 * Strategy is deliberately simple because the app is entirely static:
 *   - Install: pre-cache every file the app needs to boot.
 *   - Navigations: network first, falling back to the cached shell offline.
 *   - Same-origin assets: stale-while-revalidate — serve the cached copy
 *     immediately, refresh it in the background for the next load.
 *   - The FFmpeg core: cache-first, and never pre-cached. It is 32 MB, and the
 *     one place this file departs from the two rules above. See PRECACHE and
 *     IMMUTABLE below for why, in both directions.
 *   - Cross-origin: never touched. The app makes no cross-origin requests.
 *
 * Bumping CACHE_VERSION on a release is good hygiene, but the revalidate step
 * means forgetting to is no longer able to strand anyone on stale code — with
 * the single exception called out at IMMUTABLE.
 */

// v18 replaces the generic option wall with a contextual conversion workspace.
const CACHE_VERSION = 'v18';
const CACHE_NAME = `media-forge-${CACHE_VERSION}`;

/**
 * On localhost the worker stays out of the way entirely: a cache-first service
 * worker serves stale source on every edit, which is maddening during
 * development and easy to mistake for a bug in the app.
 */
const DEVELOPMENT = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

/** Paths are relative so the app works from any GitHub Pages sub-path. */
const PRECACHE = [
  './',
  './index.html',
  './about.html',
  './manifest.webmanifest',
  './assets/css/base.css',
  './assets/css/app.css',
  './assets/css/forge.css',
  './assets/css/about.css',
  './assets/icons/icon.svg',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable.png',
  './assets/og.png',
  './src/main.js',
  './src/app.js',
  './src/forge-shell.js',
  './src/catalog/tool-catalog.js',
  './src/ffmpeg/client.js',
  './src/ffmpeg/capabilities.js',
  './src/ffmpeg/failures.js',
  './src/worker/ffmpeg.worker.js',
  './src/media/commands.js',
  './src/media/conversion-workspace.js',
  './src/media/formats.js',
  './src/media/probe.js',
  './src/media/quick-tools.js',
  './src/media/merge.js',
  './src/media/add-audio.js',
  './src/media/audio-lab.js',
  './src/media/audio-peaks.js',
  './src/media/project-tree.js',
  './src/media/results.js',
  './src/media/timeline.js',
  './src/media/zip.js',
  './src/storage/ids.js',
  './src/storage/prefs.js',
  './src/storage/projects.js',
  './src/ui/dom.js',
  './src/ui/filmstrip.js',
  './src/ui/scrubber.js',
  './src/ui/cropper.js',
  './src/ui/merge-sequence.js',
  './src/ui/audio-mix-timeline.js',
  './src/ui/audio-lab-player.js',
  './src/ui/generated-results.js',

  /*
   * The FFmpeg core, minus the part of it that matters most.
   *
   * `manifest.json` (2 KB) names the vendored version and is what the worker
   * reads to decide which variant it may load; `ffmpeg-core.js` (112 KB) is the
   * Emscripten glue. Both belong here. Their companion `ffmpeg-core.wasm` is
   * 32 MB, and deliberately does not:
   *
   *   - Install runs on the first visit, before anyone has asked to convert
   *     anything. Pre-caching the core would mean the app is not installed —
   *     not offline-capable, not done — until 32 MB has arrived, which on a
   *     slow connection is minutes spent on a page that already looks ready.
   *   - It is by far the entry most likely to fail, and the one whose failure
   *     is most expensive to retry. Every other file here is a rounding error
   *     next to it; hanging install off the one 32 MB download turns a flaky
   *     connection into a broken install.
   *
   * It still has to end up cached, because working offline is the headline
   * feature and there is no app without the core. So the job is handed to the
   * fetch handler instead: the first real conversion downloads it — which it
   * was going to do anyway, and at a moment when the user has already accepted
   * that something is being loaded — and the response is written into this same
   * cache on the way past. One download, and from then on it is offline.
   *
   * The consequence to be aware of: a visitor who installs the app and never
   * converts anything is not offline-ready. That is the correct trade. The
   * alternative charges every visitor 32 MB for a feature most of them are
   * about to use anyway, and charges it at the worst possible moment.
   */
  './assets/ffmpeg/manifest.json',
  './assets/ffmpeg/ffmpeg-core.js',
];

self.addEventListener('install', (event) => {
  if (DEVELOPMENT) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // addAll fails the whole install if one entry 404s; add individually so a
      // renamed optional asset cannot brick offline support.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            await cache.add(new Request(path, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] could not pre-cache', path, error.message);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const stale = DEVELOPMENT
        ? names.filter((name) => name.startsWith('media-forge-'))
        : names.filter((name) => name.startsWith('media-forge-') && name !== CACHE_NAME);
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

/**
 * The vendored FFmpeg core: `ffmpeg-core.js`, `ffmpeg-core.wasm`, and the
 * threaded build's `mt/ffmpeg-core.worker.js` if it is ever vendored.
 *
 * These files are immutable for a given version. `tools/fetch-core.mjs` pins
 * the version and records a SHA-256 of every byte in `assets/ffmpeg/
 * manifest.json`, so the bytes behind these URLs do not drift; they are either
 * exactly what was vendored or the version was deliberately changed. Running
 * stale-while-revalidate against them would mean re-downloading 32 MB in the
 * background on every single load, to learn each time that nothing changed.
 * That is pure waste — the user's bandwidth, on a file that cannot have moved
 * under them — so the cached copy is preferred outright and only a cache miss
 * ever reaches the network.
 *
 * The trade-off is precisely the one stale-while-revalidate exists to avoid: a
 * re-vendored core will not be picked up until CACHE_VERSION changes. That is
 * acceptable here and nowhere else, because re-vendoring is a deliberate act
 * with its own checklist — bump CACHE_VERSION when you run `npm run fetch-core`.
 * Note that `manifest.json` is not in this set: it is the small file that names
 * the version, so it keeps revalidating and stays honest.
 */
const IMMUTABLE = /\/assets\/ffmpeg\/(?:mt\/)?ffmpeg-core\./;

/**
 * Only the scope root and its explicit `index.html` are app-shell
 * navigations. Keeping this test tied to the registration scope matters on
 * GitHub Pages, where MediaForge is served below `/media-forge/` rather than
 * at the origin root.
 */
function isAppShellNavigation(url) {
  const scopeRoot = new URL('./', self.registration.scope);
  const index = new URL('./index.html', scopeRoot);
  return url.pathname === scopeRoot.pathname || url.pathname === index.pathname;
}

self.addEventListener('fetch', (event) => {
  if (DEVELOPMENT) return; // let every request go straight to the dev server

  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never intercept third parties

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        let response;
        try {
          response = await fetch(request);
        } catch {
          // The shell has one canonical cache key. Install also pre-caches the
          // scope root, but that alias is only an install snapshot and may be
          // older than a later network refresh of index.html.
          if (isAppShellNavigation(url)) {
            const shell = await caches.match('./index.html', { ignoreSearch: true });
            return shell || new Response('Offline and nothing cached yet.', { status: 503 });
          }

          // Preserve real multi-page navigations offline (notably
          // about.html); unknown routes still fall back to the app shell.
          const requested = await caches.match(request, { ignoreSearch: true });
          if (requested) return requested;

          const shell = await caches.match('./index.html', { ignoreSearch: true });
          return shell || new Response('Offline and nothing cached yet.', { status: 503 });
        }

        // A response for about.html (or, worse, a server's 404 document)
        // must never replace the app shell. Only a successful request for
        // the scope root or index.html is allowed to refresh that key.
        if (response.ok && isAppShellNavigation(url)) {
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./index.html', response.clone());
          } catch (error) {
            // Cache quota/corruption must not turn a valid online navigation
            // into an apparent network failure.
            console.warn('[sw] could not refresh the app shell', error.message);
          }
        }
        return response;
      })()
    );
    return;
  }

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached; // no network request at all, which is the point

        try {
          const response = await fetch(request);
          // Same-origin GETs come back `basic`, never opaque, so there is a real
          // status to check and a real body to store — a 32 MB one is nothing
          // special to the Cache API. This is where the core that install
          // skipped actually gets cached, and the only place it can happen.
          if (response.ok && response.type === 'basic') {
            const cache = await caches.open(CACHE_NAME);
            // Awaited on purpose, exactly as a cache miss behaves for every
            // other asset: the copy is banked before the response is handed
            // over, so closing the tab mid-compile cannot cost the download.
            await cache.put(request, response.clone());
          }
          return response;
        } catch {
          return new Response(`Offline: ${url.pathname} has not been downloaded yet.`, { status: 504 });
        }
      })()
    );
    return;
  }

  // Stale-while-revalidate: answer from cache at once, then refresh the entry
  // in the background. Pure cache-first would pin a visitor to whatever they
  // first downloaded until this file itself changed — so forgetting to bump
  // CACHE_VERSION after editing, say, `commands.js` would strand them on old
  // code indefinitely. This way the app converges on the deployed version after
  // one reload whatever else happens, and offline still works because the
  // refresh is allowed to fail.
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Both of these must be called synchronously, while the event is still active.
  event.waitUntil(refresh);
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await refresh;
      return response || new Response(`Offline: ${url.pathname} is not cached.`, { status: 504 });
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
