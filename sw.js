// Offline shell: same-origin files are served cache-first and refreshed in the
// background. Cross-origin requests (card API, images, Claude) are never cached here.

const CACHE = "carddex-v3-live-auto-scan";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/styles.css", "icons/icon.svg",
  "js/app.js", "js/dom.js", "js/store.js", "js/api.js", "js/match.js", "js/identify.js", "js/ocr.js", "js/ai.js", "js/prices.js", "js/ui.js",
  "js/views/scan.js", "js/views/search.js", "js/views/collection.js", "js/views/sets.js", "js/views/wishlist.js", "js/views/settings.js",
  "vendor/tesseract/tesseract.esm.min.js", "vendor/tesseract/worker.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Check application code online first, so fixing the scanner on GitHub actually
// reaches users instead of being hidden indefinitely behind an old JS cache.
// Keep offline fallback, and continue cache-first for large OCR vendor assets.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fallback = await cache.match(e.request, { ignoreSearch: true });
    const liveCode = e.request.mode === "navigate" ||
      /\\.(?:js|css|html)$/.test(url.pathname) || url.pathname.endsWith("/");

    if (!liveCode && fallback) return fallback;
    try {
      const response = await fetch(e.request, liveCode ? { cache: "no-cache" } : undefined);
      if (response.ok && response.type === "basic") {
        await cache.put(e.request, response.clone());
      }
      return response;
    } catch {
      return fallback || Response.error();
    }
  })());
});
