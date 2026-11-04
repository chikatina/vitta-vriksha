/*
 * Service Worker for Vitta Vriksha PWA.
 * Enables 100% offline-first execution, caching shell, assets, fonts and WebAssembly modules.
 */

const CACHE_NAME = 'vittavriksha-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './fonts/material-symbols-outlined.woff2',
  './images/vittvriksha.png',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/apple-touch-icon.png',
  './vendor/sqlite/sqlite3.wasm',
  './vendor/sqlite/sqlite3.mjs',
  './vendor/pdfjs/pdf.mjs',
  './vendor/pdfjs/pdf.worker.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
    }).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cached version immediately, update in background if online
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {
          // Offline, background update silently fails
        });
        return cached;
      }

      // Not in pre-cache, fetch from network and cache for offline usage
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const toCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
        return networkResponse;
      }).catch(() => {
        // Fallback to index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    }),
  );
});
