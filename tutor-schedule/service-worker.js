// Bump CACHE_NAME on every deploy so clients refetch assets.
const CACHE_NAME = 'tutor-schedule-v23';

// Compute base path dynamically so the SW works under any URL,
// including GitHub Pages subpaths like /tutor-schedule/tutor-schedule/.
// self.registration.scope is e.g. "https://pomah-x.github.io/tutor-schedule/tutor-schedule/"
const BASE = new URL(self.registration.scope).pathname;

const ASSETS = [
  '',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'modules/config.js',
  'modules/state.js',
  'modules/auth.js',
  'modules/toast.js',
  'modules/schedule.js',
  'modules/students.js',
  'modules/recurring.js',
  'modules/cancellations.js',
  'modules/online.js',
  'modules/realtime.js',
  'modules/student.js',
  'modules/pricing.js',
  'modules/admin.js',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png',
  'assets/apple-touch-icon.png'
].map(path => BASE + path);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
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

  // Network-only for backend / realtime / cross-origin.
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    return;
  }

  // Network-first for navigation requests (HTML) so the shell stays fresh.
  // Falls back to cached index.html when offline.
  if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === BASE) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(BASE + 'index.html'))
    );
    return;
  }

  // Cache-first for static assets / modules.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
