// ===== SUPABASE ENDPOINT =====
// Own project (migrated off the client's account).
// The previous build raced an RU nginx proxy against direct supabase.co; that proxy
// pointed at the OLD project, so it is removed here — a stale winner in localStorage
// would silently route part of the traffic to a database we no longer own.
// To reintroduce an RU proxy later: point nginx at this project and restore the race.
const SUPABASE_URL = 'https://wvheehdxcrzgfkvokccm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind2aGVlaGR4Y3J6Z2Zrdm9rY2NtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1Nzk2NTksImV4cCI6MjA5MTE1NTY1OX0.-m4Nb8gY_1EoKGzl_UM66UeB2F3vzn5dlC6IAFvNDrA';

// Public half of the VAPID pair generated for this project. The matching private
// key lives only in this project's Edge Function secrets (VAPID_PRIVATE_KEY).
// Changing this invalidates every existing push subscription.
const VAPID_PUBLIC_KEY = 'BMO2VlnD8SenOLZ05QtRd26q0lMz0nArSHrQyYOy7aGKO9CXecMa-JNXIJizm8BoFoFNf7fhzuEg1NUYG5f0zh8';

// One-time cleanup: installed PWAs still hold the old endpoint winner from the
// proxy race. Nothing reads it now, but clearing avoids a stale value resurfacing
// if the race is ever restored.
try { localStorage.removeItem('sb_endpoint'); } catch (_) {}

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
