// =============================================================================
// modules/push.js
// =============================================================================
// Manages Web Push subscriptions on the client side.
//
//   - setupPushSubscription() is called once per session after successful auth.
//     It requests notification permission (no-op if already granted/denied),
//     creates / refreshes the PushManager subscription, and upserts it into
//     `push_subscriptions` so the Edge Function `send-push` can target it.
//
//   - The user-facing flow per project policy is "no toggle, just on" — we
//     don't show an opt-in UI, but the browser's native permission prompt is
//     unavoidable on the first call (it's a hard requirement of the Push API).
//     If the user denies it, we simply don't subscribe; nothing else breaks.
//
//   - iOS note: Web Push works only when the PWA is installed via "Add to Home
//     Screen" on iOS 16.4+. In a regular Safari tab it silently fails. The
//     user-facing manual covers this; here we just attempt and abort cleanly.
// =============================================================================

// Convert the URL-safe base64 VAPID key into a Uint8Array — the PushManager
// API requires the application server key in this raw byte form.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function setupPushSubscription() {
  // Hard feature-detection. iOS Safari outside of installed PWA, very old
  // browsers, or unusual environments may lack one of these. Abort silently —
  // pushes are best-effort, not critical for app function.
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return;
  }
  if (!state.user || !state.profile) return;
  // Students don't receive any of the AM-approved push scenarios (new
  // registration → admin, subscription ending → student+teacher, new
  // subscription → student) ... actually students DO get two of them. Keep
  // subscriptions on for everyone; the Edge Function filters by user_id.

  let permission = Notification.permission;
  if (permission === 'default') {
    try { permission = await Notification.requestPermission(); }
    catch (_) { return; }
  }
  if (permission !== 'granted') return;

  let reg;
  try { reg = await navigator.serviceWorker.ready; }
  catch (_) { return; }

  // Reuse the existing subscription if one is already registered with this
  // SW — re-subscribing would mint a new endpoint and orphan the old row.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    } catch (e) {
      console.warn('[push] subscribe failed:', e && e.message);
      return;
    }
  }

  // Persist to DB so the Edge Function can find this endpoint for our user.
  // UPSERT on `endpoint` (UNIQUE constraint) handles the common case of the
  // same browser re-subscribing — we just refresh the user binding + keys.
  const json = sub.toJSON();
  if (!json || !json.endpoint || !json.keys) return;
  try {
    await db.from('push_subscriptions').upsert({
      user_id: state.user.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
  } catch (e) {
    console.warn('[push] DB upsert failed:', e && e.message);
  }
}

// Called from handleLogout BEFORE signOut. Unsubscribes the PushManager so the
// browser drops this endpoint, then deletes the row from push_subscriptions
// so the Edge Function stops attempting to push to a now-stale endpoint.
// Best-effort: silently no-ops if anything fails.
async function teardownPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    // Delete DB row BEFORE unsubscribe — once unsubscribed, the browser may
    // still allow the DELETE under the active session, but ordering this way
    // avoids any race where the row outlives the local endpoint.
    if (state.user) {
      try { await db.from('push_subscriptions').delete().eq('endpoint', endpoint); } catch (_) {}
    }
    await sub.unsubscribe();
  } catch (e) {
    console.warn('[push] teardown failed:', e && e.message);
  }
}
