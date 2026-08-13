// Bump CACHE_NAME on every deploy so clients refetch assets.
const CACHE_NAME = 'tutor-schedule-v124';

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
  'modules/cache.js',
  'modules/modal-guard.js',
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
  'modules/subscriptions.js',
  'modules/admin.js',
  'modules/push.js',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png',
  'assets/apple-touch-icon.png',
  'assets/vendor/supabase.min.js'
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

// =============================================================================
// Web Push handler
// =============================================================================
// Fires when the push service delivers a notification payload (sent from the
// `send-push` Edge Function). We display a system notification and store the
// `url` so notificationclick can deep-link the user to the relevant screen.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    // Non-JSON payload (or empty) — show a generic notification rather than
    // dropping the event entirely.
    data = { title: 'УМпульс', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'УМпульс';
  const options = {
    body: data.body || '',
    icon: BASE + 'assets/icon-192.png',
    badge: BASE + 'assets/icon-192.png',
    tag: data.tag,                   // collapses duplicate notifications
    data: { url: data.url || BASE }, // accessed in notificationclick below
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification — focus an existing app window if open, otherwise
// open a new one. Honors the `url` from the push payload for deep-linking
// (e.g. straight to the admin panel for a new-registration push).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || BASE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        // If an app tab is already open in this origin, just focus it and
        // post the url so the SPA can navigate inside without a hard reload.
        if (c.url.startsWith(self.registration.scope.replace(/\/$/, ''))) {
          c.focus();
          try { c.postMessage({ type: 'push-navigate', url: targetUrl }); } catch (_) {}
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
