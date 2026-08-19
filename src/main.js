/**
 * Entry point.
 *
 * Boots the app, registers the service worker that makes the whole thing work
 * offline, and reports failures somewhere the user can actually see them.
 */

import { App } from './app.js';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // A service worker needs a secure context; `file://` and plain http hosts
  // other than localhost simply skip offline support.
  if (!window.isSecureContext) return;

  try {
    const registration = await navigator.serviceWorker.register(
      new URL('../sw.js', import.meta.url),
      { scope: './' }
    );

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent('media-forge:update-ready'));
        }
      });
    });
  } catch (error) {
    console.warn('[media-forge] offline support unavailable:', error.message);
  }
}

function reportFatal(error) {
  console.error('[media-forge]', error);
  const banner = document.createElement('div');
  banner.className = 'toast toast-error';
  banner.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);z-index:200';
  banner.textContent = `media-forge failed to start: ${error.message}`;
  document.body.append(banner);
}

const app = new App();

app.ready = app.start();
app.ready.then(
  () => {
    window.addEventListener('media-forge:update-ready', () => {
      app.toast('A new version is ready.', {
        duration: 12000,
        action: { label: 'Reload', run: () => location.reload() },
      });
    });
    registerServiceWorker();
  },
  (error) => reportFatal(error)
);

// Handy for debugging from the console; carries no behaviour of its own.
window.mediaForge = app;
