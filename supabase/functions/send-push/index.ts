// =============================================================================
// supabase/functions/send-push/index.ts
// =============================================================================
// Edge Function (Deno runtime) that fans out a Web Push notification to a
// set of target users. Invoked by the client via `db.functions.invoke('send-push', ...)`.
//
// Contract:
//   POST { user_ids: string[], payload: { title, body, url?, tag? } }
//   →    { sent, failed, deleted }
//
// Auth model:
//   - Caller must present a valid Supabase session JWT (any authenticated
//     user). The function does NOT enforce "you can only send to yourself"
//     — every trigger scenario approved by the AM has a well-defined sender
//     (e.g. the just-registered user pings admins; the teacher who marked
//     a lesson done pings student+teacher), and adding fine-grained perms
//     would gate legitimate use cases. We rate-limit via the standard
//     Supabase Edge Function quotas.
//
// Dead-endpoint cleanup:
//   - The push services (FCM for Chrome, Mozilla Autopush for Firefox,
//     Apple's APNs for Safari/iOS PWA) return 404 / 410 when an endpoint is
//     gone (user revoked permission, app uninstalled, etc.). We DELETE those
//     rows so future sends don't waste cycles or surface warnings.
// =============================================================================

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// === Env vars (set in Supabase Dashboard → Edge Functions → Secrets) ===
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");

// === Auto-provided by the Supabase Edge runtime ===
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// CORS — the function is called from the PWA in the browser, so it needs the
// standard preflight + headers.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  // Refuse early if VAPID isn't configured — better a clear 500 than a
  // confusing webpush library error.
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return json(500, { error: "VAPID secrets not configured" });
  }

  // Validate the caller's JWT. We use the anon key + the caller's JWT to
  // resolve `auth.getUser()` — this avoids accepting forged user_ids.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "missing auth" });

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json(401, { error: "invalid auth" });

  let body: {
    user_ids?: string[];
    broadcast_role?: string;
    payload?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }

  const directIds = Array.isArray(body.user_ids) ? body.user_ids : [];
  const broadcastRole = body.broadcast_role;
  const payload = body.payload;
  if ((directIds.length === 0 && !broadcastRole) || !payload || typeof payload !== "object") {
    return json(400, { error: "user_ids[] or broadcast_role + payload required" });
  }

  // Service-role client to bypass RLS — we need to read subscription rows
  // that belong to OTHER users (e.g. a teacher pinging students), and resolve
  // broadcast_role targets without depending on the caller's privileges (a
  // pending user must be able to fan out to admins even though their own RLS
  // policies might forbid SELECTing those profile rows).
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve final target user_id set: direct ids + (if requested) all approved
  // users with the broadcast role. De-duped via Set so a user that appears
  // in both lists doesn't get the notification twice. Note: profile.status
  // for an onboarded user is "approved" (not "active") — "active" is the
  // lessons/subscriptions table state, NOT the profile lifecycle.
  const targetSet = new Set<string>(directIds);
  if (broadcastRole) {
    const { data: roleTargets, error: roleErr } = await admin
      .from("profiles")
      .select("id")
      .eq("role", broadcastRole)
      .eq("status", "approved");
    if (roleErr) {
      console.warn("[send-push] broadcast role resolve failed:", roleErr);
    } else {
      for (const t of (roleTargets || [])) targetSet.add(t.id);
    }
  }
  const userIds = Array.from(targetSet);
  if (userIds.length === 0) {
    return json(200, { sent: 0, failed: 0, deleted: 0 });
  }

  const { data: subs, error: subsErr } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (subsErr) {
    console.error("[send-push] subs query failed:", subsErr);
    return json(500, { error: subsErr.message });
  }
  if (!subs || subs.length === 0) {
    return json(200, { sent: 0, failed: 0, deleted: 0 });
  }

  const payloadStr = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  const deadIds: string[] = [];

  // Fan out in parallel. Each send is at most a few hundred ms; even with
  // 20+ subscriptions the function will respond well within timeout.
  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(pushSubscription, payloadStr);
      sent++;
    } catch (err) {
      // The webpush lib throws an object with a `statusCode` on HTTP errors.
      // 404 Not Found / 410 Gone = endpoint is permanently dead; clean up.
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        deadIds.push(sub.id);
      } else {
        failed++;
        console.warn(
          "[send-push] push failed:",
          code,
          (err as { body?: string }).body || (err as Error).message,
        );
      }
    }
  }));

  let deleted = 0;
  if (deadIds.length > 0) {
    const { error: delErr } = await admin
      .from("push_subscriptions")
      .delete()
      .in("id", deadIds);
    if (!delErr) deleted = deadIds.length;
    else console.warn("[send-push] dead-cleanup failed:", delErr);
  }

  return json(200, { sent, failed, deleted });
});
