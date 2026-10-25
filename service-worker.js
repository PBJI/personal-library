const CACHE_NAME = 'neo-world-shell-v3';
const SHELL = [
  './', './index.html', './manifest.json', './assets/neo-icon.svg', './css/styles.css',
  './js/app.js', './js/data.js', './js/storage/app-state.js', './js/storage/database.js',
  './js/storage/file-store.js', './js/storage/cache-manager.js', './js/resources/detect-type.js',
  './js/paths/path-format.js', './js/ai/task-registry.js', './js/ai/context-builder.js',
  './js/ai/prompt-builder.js', './js/ai/response-parser.js', './js/readers/pdf-reader.js',
  './js/readers/epub-reader.js', './js/readers/image-reader.js', './js/readers/youtube-reader.js',
  './js/readers/website-reader.js', './js/readers/media-reader.js', './js/readers/text-reader.js', './js/readers/file-reader.js'
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('neo-world-shell-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && (request.destination === 'script' || request.destination === 'style' || request.destination === 'document' || request.destination === 'image')) cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      if (request.mode === 'navigate') return cache.match('./index.html');
      throw error;
    }
  })());
});
