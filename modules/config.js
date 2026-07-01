// ===== SUPABASE ENDPOINTS =====
// Two routes to the same Supabase project:
//  - RU proxy (Moscow VPS, nginx reverse proxy) — fastest WITHOUT VPN in Russia
//  - direct supabase.co — fastest WITH VPN (avoids the extra RU hop)
// The app picks the fastest at startup (cached), re-measures in background on every load.
const SB_ENDPOINTS = {
  proxy:  'https://195-19-20-134.nip.io',
  direct: 'https://wvheehdxcrzgfkvokccm.supabase.co'
};
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind2aGVlaGR4Y3J6Z2Zrdm9rY2NtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1Nzk2NTksImV4cCI6MjA5MTE1NTY1OX0.-m4Nb8gY_1EoKGzl_UM66UeB2F3vzn5dlC6IAFvNDrA';
const VAPID_PUBLIC_KEY = 'BJtYsX_H4uqXQyf0cAYNJclYP1bRmYjkuu0XSfuEFJhumcJb56oRABWzmFjGj1uuMqcBO-PIJGYwkyGMoAROL1w';
// Synchronous choice: cached winner from the previous load, default — RU proxy
// (primary audience is in Russia without VPN).
const SUPABASE_URL = localStorage.getItem('sb_endpoint') || SB_ENDPOINTS.proxy;

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== BACKGROUND ENDPOINT RACE =====
// Measures both endpoints, stores the winner for the NEXT page load.
// If the endpoint we are currently using is dead but the other is alive — reload onto it
// (the app would be broken anyway, so a reload is a recovery, not a disruption).
(function raceEndpoints() {
  const HEALTH_TIMEOUT_MS = 4000;

  function ping(url) {
    const started = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    return fetch(url + '/auth/v1/health', {
      signal: ctrl.signal,
      headers: { apikey: SUPABASE_ANON_KEY },
      cache: 'no-store'
    })
      .then(r => {
        clearTimeout(timer);
        if (!r.ok) throw new Error('status ' + r.status);
        return { url, ms: performance.now() - started };
      })
      .catch(() => { clearTimeout(timer); return { url, ms: Infinity }; });
  }

  Promise.all([ping(SB_ENDPOINTS.proxy), ping(SB_ENDPOINTS.direct)]).then(results => {
    const alive = results.filter(r => r.ms !== Infinity);
    if (alive.length === 0) return; // fully offline — SW cache handles UX, nothing to decide

    alive.sort((a, b) => a.ms - b.ms);
    const winner = alive[0].url;
    localStorage.setItem('sb_endpoint', winner);

    // Recovery: current endpoint dead, another alive — switch now.
    const currentAlive = alive.some(r => r.url === SUPABASE_URL);
    if (!currentAlive) {
      console.warn('Supabase endpoint unreachable, switching to', winner);
      location.reload();
    }
  });
})();