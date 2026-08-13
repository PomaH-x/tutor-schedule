// =============================================================================
// modules/cache.js
// =============================================================================
// Lightweight localStorage cache so the app shows the user's LAST KNOWN data
// (profile, lessons of the current week, students list) when there is no
// network — the PWA opens, renders cached cards immediately, then attempts a
// background network refresh. If the refresh fails, the cached view stays
// visible and we don't blow up.
//
// Design notes:
//   - Values are JSON-encoded. Reads return null on parse/quota error.
//   - All keys are prefixed with CACHE_PREFIX so we can wipe ours without
//     touching other localStorage entries (e.g. supabase's session token,
//     lastScreen for UI persistence).
//   - User scoping: the cached `userId` marker tracks who the cache belongs to;
//     when a DIFFERENT user logs in we wipe the cache so the new user can
//     never see the previous one's data (privacy + correctness).
//   - This is an in-memory snapshot, not a sync layer. Realtime mutations that
//     happen mid-session aren't written back to cache — only successful network
//     LOADS overwrite the cache. Next reload picks up the latest snapshot.
// =============================================================================

const CACHE_PREFIX = 'tutor-schedule:cache:v1:';

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    // Quota exceeded, private mode, or other storage failure — silently skip.
    // We never want a failed write to throw and crash the calling code path.
    console.warn('[cache] set failed:', key, e && e.message);
    return false;
  }
}

function cacheGet(key) {
  try {
    const v = localStorage.getItem(CACHE_PREFIX + key);
    return v ? JSON.parse(v) : null;
  } catch (_) { return null; }
}

function cacheDelete(key) {
  try { localStorage.removeItem(CACHE_PREFIX + key); } catch (_) {}
}

// Wipe every cache key that belongs to us. Used on logout and on user-switch.
function cacheClearAll() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

// Called once we know the current user id. If the cache previously belonged to
// a different user, wipe everything BEFORE any cached data is read elsewhere.
// Then mark the cache as owned by `userId`.
function cacheEnsureUser(userId) {
  if (!userId) return;
  const stored = cacheGet('userId');
  if (stored && stored !== userId) cacheClearAll();
  cacheSet('userId', userId);
}
