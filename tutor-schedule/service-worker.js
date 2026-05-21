// Bump CACHE_NAME on every deploy so clients refetch assets.
const CACHE_NAME = 'tutor-schedule-v21';

const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/modules/config.js',
  '/modules/state.js',
  '/modules/auth.js',
  '/modules/toast.js',
  '/modules/schedule.js',
  '/modules/students.js',
  '/modules/recurring.js',
  '/modules/cancellations.js',
  '/modules/online.js',
  '/modules/realtime.js',
  '/modules/student.js',
  '/modules/pricing.js',
  '/modules/admin.js',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
  '/assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  // Don't call skipWaiting() automatically — let the app prompt the user to update.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// App → SW: "please activate the new version now"
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Network-only for backend / realtime / cross-origin scripts (e.g. Supabase CDN).
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    return;
  }

  // Network-first for index.html so users always get the latest shell when online.
  // Falls back to cache when offline.
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for everything else (static assets, modules).
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
