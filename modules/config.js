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

// ===== WRITE ERROR INTERCEPTOR =====
// Supabase resolves rather than throws: a failed insert/update/delete comes back as
// { data: null, error } and a caller that doesn't destructure `error` proceeds as if
// the write succeeded. The UI then shows a saved state the database never recorded —
// the "I saved it and it's gone" class of bug, and the hardest to reproduce because
// nothing appears in any log.
//
// Rather than editing 100+ call sites (a large diff with a mistake in every one a
// possibility), this wraps db.from() once and instruments the four write builders.
// The resolved value is passed through untouched, so every existing `if (error)`
// branch keeps working exactly as before — this only adds reporting on top.
const RAW_FROM = db.from.bind(db);
const WRITE_OPS = ['insert', 'update', 'delete', 'upsert'];

function reportWriteError(table, op, error) {
  console.error(`[db.${op}] ${table}:`, error);
  // Give the caller's own handler a moment to surface something specific. If it did,
  // stay quiet — two toasts for one failure is worse than one good message.
  setTimeout(() => {
    try {
      if (Date.now() - lastToastShownAt < 500) return;
      showToast('Не удалось сохранить изменения. Проверьте связь и повторите', 'error');
    } catch (_) { /* toast layer unavailable — console already has it */ }
  }, 300);
}

function instrumentWrite(query, table, op) {
  // PostgrestFilterBuilder is a thenable; chaining (.eq/.select/...) returns the same
  // instance, so patching then() here survives the whole chain.
  if (!query || typeof query.then !== 'function') return query;
  const originalThen = query.then.bind(query);
  query.then = function (onFulfilled, onRejected) {
    return originalThen(
      (result) => {
        if (result && result.error) reportWriteError(table, op, result.error);
        return onFulfilled ? onFulfilled(result) : result;
      },
      onRejected
    );
  };
  return query;
}

db.from = function (table) {
  const builder = RAW_FROM(table);
  WRITE_OPS.forEach(op => {
    const original = builder[op];
    if (typeof original !== 'function') return;
    builder[op] = function (...args) {
      return instrumentWrite(original.apply(this, args), table, op);
    };
  });
  return builder;
};
