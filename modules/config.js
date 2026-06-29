const SUPABASE_URL = 'https://wvheehdxcrzgfkvokccm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind2aGVlaGR4Y3J6Z2Zrdm9rY2NtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1Nzk2NTksImV4cCI6MjA5MTE1NTY1OX0.-m4Nb8gY_1EoKGzl_UM66UeB2F3vzn5dlC6IAFvNDrA';

// VAPID public key for Web Push. The matching PRIVATE key is stored in Supabase
// Edge Function secrets — never embed it in the client. If these keys are ever
// rotated, every existing push_subscriptions row will become unusable on the
// next send (the push service won't accept new pushes signed by a different
// key for an old subscription) — so don't rotate unless compromised.
const VAPID_PUBLIC_KEY = 'BJtYsX_H4uqXQyf0cAYNJclYP1bRmYjkuu0XSfuEFJhumcJb56oRABWzmFjGj1uuMqcBO-PIJGYwkyGMoAROL1w';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
