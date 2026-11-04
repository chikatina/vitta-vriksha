/*
 * Service Worker for Vitta Vriksha PWA.
 * Enables 100% offline-first execution, caching shell, assets, fonts and WebAssembly modules.
 */

const CACHE_NAME = 'vittavriksha-v1.0.10';

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
  // App core scripts
  './js/app.js',
  './js/brand-mark.js',
  './js/bridge.js',
  './js/charts.js',
  './js/demo-seed.js',
  './js/formatters.js',
  './js/icon-codepoints.js',
  './js/ui.js',
  // Backend modules
  './js/backend/analytics.js',
  './js/backend/asset-class.js',
  './js/backend/broker_parser.js',
  './js/backend/cas.js',
  './js/backend/cashflow.js',
  './js/backend/crypto.js',
  './js/backend/database.js',
  './js/backend/debt_planner.js',
  './js/backend/errors.js',
  './js/backend/fire.js',
  './js/backend/goals_habits.js',
  './js/backend/index.js',
  './js/backend/isin.js',
  './js/backend/loan.js',
  './js/backend/merchants.js',
  './js/backend/native.js',
  './js/backend/nlq.js',
  './js/backend/periods.js',
  './js/backend/recurring.js',
  './js/backend/reminders.js',
  './js/backend/sips.js',
  './js/backend/sms.js',
  './js/backend/sqlite.js',
  './js/backend/statement_parser.js',
  './js/backend/tax_engine.js',
  './js/backend/vault.js',
  './js/backend/wealth_intel.js',
  // Views
  './js/views/about.js',
  './js/views/alert-tooltip.js',
  './js/views/backup.js',
  './js/views/buckets.js',
  './js/views/budgets.js',
  './js/views/cas.js',
  './js/views/category-field.js',
  './js/views/delete-data.js',
  './js/views/drilldown.js',
  './js/views/family.js',
  './js/views/fire.js',
  './js/views/guide.js',
  './js/views/home.js',
  './js/views/insights.js',
  './js/views/investments.js',
  './js/views/ledger.js',
  './js/views/lock.js',
  './js/views/more.js',
  './js/views/onboarding-tour.js',
  './js/views/records.js',
  './js/views/recurring.js',
  './js/views/rules.js',
  './js/views/security.js',
  './js/views/settings.js',
  './js/views/shared.js',
  './js/views/sips.js',
  './js/views/sms-ingest.js',
  './js/views/support.js',
  './js/views/transaction-sheet.js',
  './js/views/wealth.js',
  './js/views/widgets.js',
  // Vendor wasm, workers & libraries
  './vendor/sqlite/sqlite3.mjs',
  './vendor/sqlite/sqlite3.wasm',
  './vendor/pdfjs/pdf.mjs',
  './vendor/pdfjs/pdf.worker.mjs',
  './vendor/casparser/index.js',
  './vendor/casparser/dates.js',
  './vendor/casparser/decimal.js',
  './vendor/casparser/enums.js',
  './vendor/casparser/exceptions.js',
  './vendor/casparser/isin-db.js',
  './vendor/casparser/isin.js',
  './vendor/casparser/types.js',
  './vendor/casparser/analysis/gains.js',
  './vendor/casparser/analysis/index.js',
  './vendor/casparser/analysis/utils.js',
  './vendor/casparser/parsers/cams_detailed.js',
  './vendor/casparser/parsers/cams_summary.js',
  './vendor/casparser/parsers/cdsl.js',
  './vendor/casparser/parsers/classify.js',
  './vendor/casparser/parsers/detect.js',
  './vendor/casparser/parsers/extract.js',
  './vendor/casparser/parsers/index.js',
  './vendor/casparser/parsers/investor.js',
  './vendor/casparser/parsers/nsdl.js',
  './vendor/casparser/parsers/pageobj.js',
  './vendor/casparser/parsers/utils.js',
  './vendor/casparser/pdf/backend.js',
  './vendor/casparser/pdf/pdfjs.js',
  './vendor/isin/isin.db',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('Failed to precache resource:', url, err);
          }),
        ),
      );
    }).then(() => self.skipWaiting()),
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

/**
 * Handles HTTP 206 Range requests from cached responses.
 * Essential for Safari media and chunked/partial requests.
 */
async function handleRangeResponse(request, cachedResponse) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cachedResponse;

  const arrayBuffer = await cachedResponse.arrayBuffer();
  const bytes = rangeHeader.replace(/bytes=/, '').split('-');
  const total = arrayBuffer.byteLength;
  const start = parseInt(bytes[0], 10) || 0;
  const end = bytes[1] ? parseInt(bytes[1], 10) : total - 1;

  if (start >= total || end >= total || start > end) {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: {
        'Content-Range': `bytes */${total}`,
      },
    });
  }

  const sliced = arrayBuffer.slice(start, end + 1);
  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(sliced.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

/** Safely puts a response into the cache, ignoring partial or range requests. */
function safeCachePut(cache, request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque' || request.headers.has('range')) {
    return;
  }
  cache.put(request, response).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Network-first for navigation requests to ensure fresh shell when online,
  // falling back to cached index.html immediately when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => safeCachePut(cache, event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Cache-first with stale-while-revalidate for static assets
  event.respondWith(
    caches.match(event.request, { ignoreSearch: false }).then(async (cached) => {
      if (cached) {
        if (event.request.headers.has('range')) {
          return handleRangeResponse(event.request, cached);
        }

        // Return cached version immediately; refresh in background if online
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => safeCachePut(cache, event.request, networkResponse));
            }
          })
          .catch(() => {});

        return cached;
      }

      // Not in cache, fetch from network and cache
      return fetch(event.request)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          const toCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => safeCachePut(cache, event.request, toCache));
          return networkResponse;
        })
        .catch(() => {
          return new Response('Offline resource unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' },
          });
        });
    }),
  );
});
