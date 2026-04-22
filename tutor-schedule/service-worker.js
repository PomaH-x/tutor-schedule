const CACHE_NAME = 'tutor-schedule-v7';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/modules/config.js',
  '/modules/state.js',
  '/modules/auth.js',
  '/modules/toast.js',
  '/modules/schedule.js',
  '/modules/students.js',
  '/modules/recurring.js',
  '/modules/cancellations.js',
  '/modules/online.js',
  '/modules/pricing.js',
  '/modules/admin.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('supabase')) return;

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
