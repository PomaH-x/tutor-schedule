const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ROOM_LABELS = ['Л', 'Ц', 'П'];
const ROOM_FULL = ['Левый', 'Центральный', 'Правый'];
const START_HOUR = 8;
const END_HOUR = 22;
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * 2;
const DRAG_THRESHOLD = 5;

// Touch gesture support (mobile)
const TOUCH_LONG_PRESS_MS = 450;
const TOUCH_MOVE_THRESHOLD = 10;
const TOUCH_TOOLTIP_MS = 2000;
let touchGesture = null;
let lastTouchTime = 0;
let touchTooltipTimer = null;
let touchLastCardTapId = null;
let touchLastCardTapAt = 0;
let touchEditTimer = null;
function isShortlyAfterTouch() { return Date.now() - lastTouchTime < 600; }

let selecting = false;
let selStart = null;
let selEnd = null;
let scheduleInited = false;
let hoveredTooltip = null;
let durationLabel = null;
let allTeacherStudents = [];
let studentActiveSub = {}; // studentId -> active subscription row (with pricing.duration_minutes)
let studentWeekStatus = {};
let studentCancellations = {};
let dragState = null;

function clearDragState() {
  if (dragState && dragState.lockKey && typeof releaseLock === 'function') {
    releaseLock(dragState.lockKey);
  }
  dragState = null;
}
let dragMouseStart = null;
let dragStarted = false;
let studentDragState = null;

// Double-click / double-tap protection. Cleared in finally{} of every placement function
// so a successful commit OR a thrown error both release the guard. Prevents creating
// duplicate lessons when the user rapidly clicks/taps during a placing flow.
// Declared with `var` so it's reachable from cancellations.js (cross-script access).
var placementInFlight = false;

function getWeekDates(mondayDate) {
  const dates = [];
  for (let i = 0; i < 7; i++) { const d = new Date(mondayDate); d.setDate(d.getDate() + i); dates.push(d); }
  return dates;
}

function updateWeekLabel() {
  const dates = getWeekDates(state.currentWeekStart);
  document.getElementById('current-week-label').textContent = `${formatDateShort(dates[0])} — ${formatDateShort(dates[6])}`;
}

function colForDayRoom(di, room) { return di * 3 + room + 1; }
function rowForSlot(slot) { return slot + 3; }
function slotToTime(slot) { const m = START_HOUR * 60 + slot * SLOT_MINUTES; return `${Math.floor(m / 60)}:${(m % 60).toString().padStart(2, '0')}`; }
function slotsToLabel(count) { const mins = count * SLOT_MINUTES; if (mins < 60) return `${mins} мин`; const h = mins / 60; return h === Math.floor(h) ? `${h} ч` : `${h.toFixed(1).replace('.', ',')} ч`; }

function hasLocalConflict(day, room, slotFrom, slotTo, excludeId, teacherId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; if (!date) return true;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
    if (!isBlockingLesson(l)) return false;
    if (l.id === excludeId || l.room !== room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const lE = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    if (startMin >= lE || endMin <= lS) return false;
    return teacherId ? l.teacher_id !== teacherId : true;
  });
}

// A lesson participates in conflict checks only if it's actually a live
// occupancy of the slot: status='active' AND at least one student attached.
// Any other row (cancelled, or "ghost" with zero students after every kid was
// removed/cancelled) must NOT block a teacher from creating a new lesson in
// that slot. Without this filter, a lingering row in state.lessons — caused
// by a race between the optimistic UI update and the follow-up loadLessons()
// or by realtime not yet delivering the delete — produced false "преподаватель
// занят" toasts on visually empty slots.
function isBlockingLesson(l) {
  return l && l.status === 'active' && (l.lesson_students || []).length > 0;
}

// Strict same-room overlap check — used by drag (blocks ANY overlap regardless of teacher).
function hasRoomOverlapAny(day, room, slotFrom, slotTo, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; if (!date) return false;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
    if (!isBlockingLesson(l)) return false;
    if (l.id === excludeId || l.room !== room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const lE = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    return startMin < lE && endMin > lS;
  });
}

// Drag-specific conflict — returns 'room' | 'teacher' | 'students' | 'individual' | null.
// Different-teacher same-room overlap = 'room' (hard block).
// Same-teacher overlap allowed IF combined student count fits and no individual mixing.
function getDragConflictType(day, room, slotFrom, slotTo, excludeId, teacherId) {
  // Different-teacher in same room — block
  if (hasLocalConflict(day, room, slotFrom, slotTo, excludeId, teacherId)) return 'room';
  // Same teacher in DIFFERENT room same time — block
  if (hasTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId)) return 'teacher';

  // Same-teacher same-room overlap — check capacity / individual mixing
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; if (!date) return null;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  const overlapping = state.lessons.filter(l => {
    if (!isBlockingLesson(l)) return false;
    if (l.id === excludeId || l.room !== room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const lE = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    return startMin < lE && endMin > lS;
  });
  if (overlapping.length === 0) return null;

  const movingLesson = state.lessons.find(l => l.id === excludeId);
  const movingStudents = movingLesson?.lesson_students || [];
  const movingCount = movingStudents.length;
  const movingHasIndividual = movingStudents.some(ls => ls.student?.is_individual);
  const overlappingStudents = overlapping.flatMap(l => l.lesson_students || []);
  const overlappingCount = overlappingStudents.length;
  const overlappingHasIndividual = overlappingStudents.some(ls => ls.student?.is_individual);
  const maxGroup = getMaxGroup(teacherId);
  if (overlappingCount + movingCount > maxGroup) return 'students';
  if ((movingHasIndividual && overlappingCount > 0) || (overlappingHasIndividual && movingCount > 0)) return 'individual';
  return null;
}

function hasTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; if (!date) return false;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
    if (!isBlockingLesson(l)) return false;
    if (l.id === excludeId || l.teacher_id !== teacherId || l.room === room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const lE = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    return startMin < lE && endMin > lS;
  });
}

function getMaxGroup(teacherId) {
  if (state.profile && teacherId === state.user?.id) return state.profile.max_group_size || 4;
  const lesson = state.lessons.find(l => l.teacher_id === teacherId);
  return lesson?.teacher?.max_group_size || 4;
}

function hasAnyConflict(day, room, slotFrom, slotTo, excludeId, teacherId) {
  if (hasLocalConflict(day, room, slotFrom, slotTo, excludeId, teacherId)) return true;
  if (hasTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId)) return true;

  // Check student count + individual conflicts using local state
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; if (!date) return false;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  const overlapping = state.lessons.filter(l => {
    if (!isBlockingLesson(l)) return false;
    if (l.id === excludeId || l.room !== room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth()) return false;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const lE = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    return startMin < lE && endMin > lS;
  });
  if (overlapping.length === 0) return false;

  const maxGroup = getMaxGroup(teacherId);
  const overStudents = overlapping.flatMap(l => l.lesson_students || []);
  const movingLesson = state.lessons.find(l => l.id === excludeId);
  const movingStudents = movingLesson?.lesson_students || [];
  if (overStudents.length + movingStudents.length > maxGroup) return true;
  const overHasInd = overStudents.some(ls => ls.student?.is_individual);
  const movingHasInd = movingStudents.some(ls => ls.student?.is_individual);
  if ((movingHasInd && overStudents.length > 0) || (overHasInd && movingStudents.length > 0)) return true;
  return false;
}

async function checkConflictServer(day, room, slotFrom, slotTo, excludeId, teacherId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; const ws = formatDate(state.currentWeekStart);
  const st = new Date(date); st.setHours(START_HOUR + Math.floor(slotFrom * SLOT_MINUTES / 60), (slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const et = new Date(date); et.setHours(START_HOUR + Math.floor(slotTo * SLOT_MINUTES / 60), (slotTo * SLOT_MINUTES) % 60, 0, 0);

  // Ghost lessons (no students) sometimes linger in DB — they're hidden in the UI
  // (loadLessons filters them out) but the server still sees them. Always ignore them
  // so the conflict check matches what the user actually sees on the grid.
  const hasStudents = (l) => (l.lesson_students || []).length > 0;

  // Room conflict: a different teacher already occupies this room/time. Applies
  // to admin too — the live preview already lights up red here (hasAnyConflict
  // doesn't skip admin), and visual red MUST mean "blocked" or the user gets
  // misled into thinking the drop succeeded normally.
  {
    let q = db.from('lessons').select('id, teacher_id, lesson_students(student_id)').eq('week_start', ws).eq('room', room).eq('status', 'active').lt('start_time', et.toISOString()).gt('end_time', st.toISOString());
    if (excludeId) q = q.neq('id', excludeId);
    const { data: rd } = await q;
    if ((rd || []).some(l => l.teacher_id !== teacherId && hasStudents(l))) return 'room';
  }

  // Teacher double-book conflict: same teacher already busy in a different room.
  // Same reasoning — visual red must equal server block. (Even admins shouldn't
  // double-book a specific teacher across rooms; the teacher physically can't be
  // in two rooms at once.)
  {
    let q2 = db.from('lessons').select('id, lesson_students(student_id)').eq('week_start', ws).eq('teacher_id', teacherId).neq('room', room).eq('status', 'active').lt('start_time', et.toISOString()).gt('end_time', st.toISOString());
    if (excludeId) q2 = q2.neq('id', excludeId);
    const { data: td } = await q2;
    if ((td || []).some(hasStudents)) return 'teacher';
  }

  // Check student count and individual mixing among overlapping lessons in same room
  let q3 = db.from('lessons').select('id, lesson_students(student_id, student:students(is_individual))').eq('week_start', ws).eq('room', room).eq('status', 'active').lt('start_time', et.toISOString()).gt('end_time', st.toISOString());
  if (excludeId) q3 = q3.neq('id', excludeId);
  const { data: overlappingRaw } = await q3;
  const overlapping = (overlappingRaw || []).filter(hasStudents);
  if (overlapping && overlapping.length > 0) {
    const overlappingStudents = overlapping.flatMap(l => l.lesson_students || []);
    const overlappingCount = overlappingStudents.length;
    const overlappingHasIndividual = overlappingStudents.some(ls => ls.student?.is_individual);

    // Get students of the lesson being moved
    const movingLesson = state.lessons.find(l => l.id === excludeId);
    const movingStudents = movingLesson?.lesson_students || [];
    const movingCount = movingStudents.length;
    const movingHasIndividual = movingStudents.some(ls => ls.student?.is_individual);

    const maxGroup = getMaxGroup(teacherId);
    if (overlappingCount + movingCount > maxGroup) return 'students';
    if ((movingHasIndividual && overlappingCount > 0) || (overlappingHasIndividual && movingCount > 0)) return 'individual';
  }

  return null;
}

// Check if any of the given students is ALREADY booked in another active lesson
// that overlaps the target time range. Used to prevent the "same student in two
// places at once" class of conflicts when:
//   - creating a new lesson with selected students,
//   - dragging a student onto a cell (excludeLessonId = source lesson),
//   - placing a transferred student / truant (excludeLessonId = null or source).
//
// Returns { studentId, name } of the FIRST conflicting student, or null if all
// students are free at that slot. We return only the first hit because that's
// enough to produce a meaningful toast — the user fixes one conflict at a time.
async function findStudentDoubleBooking(studentIds, day, slotFrom, slotTo, excludeLessonId) {
  if (!studentIds || studentIds.length === 0) return null;
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; const ws = formatDate(state.currentWeekStart);
  const st = new Date(date); st.setHours(START_HOUR + Math.floor(slotFrom * SLOT_MINUTES / 60), (slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const et = new Date(date); et.setHours(START_HOUR + Math.floor(slotTo * SLOT_MINUTES / 60), (slotTo * SLOT_MINUTES) % 60, 0, 0);
  let q = db.from('lessons')
    .select('id, lesson_students(student_id, student:students(first_name, last_name))')
    .eq('week_start', ws)
    .eq('status', 'active')
    .lt('start_time', et.toISOString())
    .gt('end_time', st.toISOString());
  if (excludeLessonId) q = q.neq('id', excludeLessonId);
  const { data } = await q;
  if (!data) return null;
  const idSet = new Set(studentIds);
  for (const l of (data || [])) {
    for (const ls of (l.lesson_students || [])) {
      if (idSet.has(ls.student_id)) {
        const n = ls.student;
        return { studentId: ls.student_id, name: n ? `${n.first_name} ${n.last_name}` : 'Ученик' };
      }
    }
  }
  return null;
}

// ===== GRID RENDER =====
function renderGrid() {
  const grid = document.getElementById('schedule-grid');
  grid.innerHTML = '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = getWeekDates(state.currentWeekStart);
  grid.style.gridTemplateColumns = '50px repeat(21, 1fr)';
  grid.style.gridTemplateRows = `40px 24px repeat(${TOTAL_SLOTS + 1}, 28px)`;

  const corner = document.createElement('div');
  corner.className = 'grid-corner'; corner.style.gridRow = '1 / 3'; corner.style.gridColumn = '1';
  grid.appendChild(corner);

  dates.forEach((date, i) => {
    const h = document.createElement('div');
    h.className = 'grid-header';
    if (date.getTime() === today.getTime()) h.classList.add('grid-header-today');
    const col = colForDayRoom(i, 1);
    h.style.gridColumn = `${col} / ${col + 3}`; h.style.gridRow = '1';
    h.innerHTML = `<span class="day-name">${DAYS[i]}</span><span class="day-num">${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}</span>`;
    grid.appendChild(h);
    for (let r = 0; r < 3; r++) {
      const rl = document.createElement('div');
      rl.className = 'grid-room-label';
      if (date.getTime() === today.getTime()) rl.classList.add('grid-room-label-today');
      if (r === 2) rl.classList.add('grid-room-label-day-end');
      rl.style.gridColumn = `${colForDayRoom(i, r + 1)}`; rl.style.gridRow = '2'; rl.textContent = ROOM_LABELS[r];
      grid.appendChild(rl);
    }
  });

  for (let slot = 0; slot <= TOTAL_SLOTS; slot++) {
    const hour = START_HOUR + Math.floor(slot / 2); const min = (slot % 2) * 30;
    const row = rowForSlot(slot);
    const tc = document.createElement('div');
    tc.className = 'grid-time'; tc.dataset.slot = slot;
    tc.textContent = `${hour}:${min.toString().padStart(2, '0')}`;
    tc.style.gridRow = row; tc.style.gridColumn = '1';
    grid.appendChild(tc);
    if (slot >= TOTAL_SLOTS) {
      // Last row (22:00) — single cell spanning all content columns, acts as a visual terminator
      const endCell = document.createElement('div');
      endCell.className = 'grid-cell grid-cell-end grid-cell-end-row';
      endCell.style.gridRow = row;
      endCell.style.gridColumn = '2 / 23';
      grid.appendChild(endCell);
    } else {
      for (let day = 0; day < 7; day++) {
        for (let room = 1; room <= 3; room++) {
          const cell = document.createElement('div');
          cell.className = 'grid-cell';
          if (min === 0) cell.classList.add('grid-cell-hour');
          if (room === 3) cell.classList.add('grid-cell-day-end');
          cell.style.gridRow = row; cell.style.gridColumn = colForDayRoom(day, room);
          cell.dataset.day = day; cell.dataset.room = room; cell.dataset.slot = slot;
          grid.appendChild(cell);
        }
      }
    }
  }
  // initGridInteractions is NOT called here — it's installed once via initSchedule(),
  // because event listeners on the #schedule-grid element survive innerHTML wipes
  // (only its children are removed). Re-registering on every renderGrid would stack
  // duplicate handlers (week-switch → +9 listeners each time, full leak).
  renderLessons();
  if (state.placingLesson || state.placingStudent || state.placingTruant) showPlacingBanner();
}

// ===== LESSONS RENDER (overlap) =====
function renderLessons() {
  // IMPORTANT: scope cleanup to #schedule-grid only.
  // Using document.querySelectorAll would also wipe cards/cells of #recurring-grid
  // when realtime triggers a loadLessons → renderLessons while the recurring screen
  // is visible (cards disappear until F5).
  const scheduleGrid = document.getElementById('schedule-grid');
  if (scheduleGrid) {
    scheduleGrid.querySelectorAll('.lesson-card').forEach(el => el.remove());
    scheduleGrid.querySelectorAll('.grid-cell').forEach(c => {
      c.style.background = ''; c.innerHTML = '';
      delete c.dataset.lessonIds;
    });
  }

  const grid = document.getElementById('schedule-grid');
  const dates = getWeekDates(state.currentWeekStart);
  const isDark = document.documentElement.dataset.theme === 'dark';

  // Group by day+room
  const groups = {};
  state.lessons.forEach(lesson => {
    const start = new Date(lesson.start_time);
    const di = dates.findIndex(d => d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth() && d.getDate() === start.getDate());
    if (di === -1) return;
    const key = `${di}-${lesson.room}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ ...lesson, _dayIndex: di });
  });

  // Pre-compute per-slot student totals for each day+room
  const slotTotals = {};
  Object.entries(groups).forEach(([key, lessons]) => {
    slotTotals[key] = {};
    lessons.forEach(lesson => {
      const start = new Date(lesson.start_time); const end = new Date(lesson.end_time);
      const ss = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const es = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const sc = new Set((lesson.lesson_students || []).map(ls => ls.student_id)).size;
      for (let s = ss; s < es; s++) {
        slotTotals[key][s] = (slotTotals[key][s] || 0) + sc;
      }
    });
  });

  // Render cards
  Object.entries(groups).forEach(([key, lessons]) => {
    lessons.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    lessons.forEach((lesson, i) => {
      const start = new Date(lesson.start_time);
      let ov = 0;
      for (let j = 0; j < i; j++) { if (start < new Date(lessons[j].end_time)) ov++; }
      lesson._ov = ov;
    });

    // Track which lesson "claims" each slot for count display (first lesson to cover it wins)
    const slotClaimed = {};
    lessons.forEach(lesson => {
      const start = new Date(lesson.start_time); const end = new Date(lesson.end_time);
      const ss = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const es = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      for (let s = ss; s < es; s++) {
        if (!slotClaimed[s]) slotClaimed[s] = lesson.id;
      }
    });

    lessons.forEach(lesson => {
      const start = new Date(lesson.start_time); const end = new Date(lesson.end_time);
      const ss = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const es = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;

      const card = document.createElement('div');
      card.className = 'lesson-card'; card.dataset.lessonId = lesson.id;
      const color = lesson.teacher?.color || '#1e6fe8';
      card.style.gridRow = `${rowForSlot(ss)} / ${rowForSlot(es)}`;
      card.style.gridColumn = colForDayRoom(lesson._dayIndex, lesson.room);
      if (lesson._ov > 0) { card.style.zIndex = 2 + lesson._ov; }

      const canDrag = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;

      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      card.style.borderColor = `rgba(${r},${g},${b},${isDark ? 0.5 : 0.4})`;

      let slotsHTML = '';
      for (let s = ss; s < es; s++) {
        const total = slotTotals[key][s] || 0;
        const clamped = Math.min(total, 4);
        const alpha = isDark
          ? 0.06 + (clamped / 4) * 0.30
          : 0.05 + (clamped / 4) * 0.25;
        const slotBg = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
        // Light theme: always use the teacher color (good contrast on the light tinted bg).
        // Dark theme: switch to white at high counts because the bg is darker.
        const textColor = isDark
          ? (clamped >= 3 ? 'rgba(255,255,255,0.85)' : `rgba(${r},${g},${b},0.7)`)
          : `rgba(${r},${g},${b},0.95)`;
        const showCount = slotClaimed[s] === lesson.id;
        const countHTML = showCount ? `<span class="lc-slot-count" style="color:${textColor}">${total}</span>` : '';
        slotsHTML += `<div class="lc-slot" style="background:${slotBg}">${countHTML}</div>`;
      }

      const isFirst = lesson._ov === 0;
      const sn = escapeHtml((lesson.teacher?.short_name || '??').replace(/\./g, ''));
      const headerColor = `rgba(${r},${g},${b},${isDark ? 0.9 : 1})`;
      const headerHTML = isFirst ? `<div class="lc-header" style="color:${headerColor}">${sn}</div>` : '';
      const dragHTML = canDrag ? '<div class="lc-drag-handle" title="Перетащить">⠿</div>' : '';

      card.innerHTML = `${dragHTML}${headerHTML}<div class="lc-slots">${slotsHTML}</div>`;
      grid.appendChild(card);
    });
  });
  if (typeof applyLockVisuals === 'function') applyLockVisuals();
  decorateZCycleButtons('#schedule-grid');
}

// ===== GRID INTERACTIONS =====
function initGridInteractions(grid) {
  grid.addEventListener('mousedown', onGridMouseDown);
  grid.addEventListener('mousemove', onGridMouseMove);
  grid.addEventListener('mouseup', onGridMouseUp);
  grid.addEventListener('contextmenu', onGridContextMenu);
  // Touch (mobile) — pointer events branch on pointerType==='touch'
  grid.addEventListener('pointerdown', onGridPointerDown);
  grid.addEventListener('pointermove', onGridPointerMove);
  grid.addEventListener('pointerup', onGridPointerUp);
  grid.addEventListener('pointercancel', onGridPointerCancel);
  grid.addEventListener('touchmove', onGridTouchMove, { passive: false });
}

function onGridContextMenu(e) {
  // Always prevent native menu on grid (especially for touch long-press on Android)
  e.preventDefault();
  if (isShortlyAfterTouch()) return;
  const card = e.target.closest('.lesson-card');
  if (!card) return;

  const col = card.style.gridColumn;
  const allCards = [...document.querySelectorAll('.lesson-card')].filter(c => c.style.gridColumn === col);
  if (allCards.length <= 1) return;

  const clickedStart = parseInt(card.style.gridRow.split('/')[0].trim());
  const clickedEnd = parseInt(card.style.gridRow.split('/')[1].trim());
  const overlapping = allCards.filter(c => {
    const cStart = parseInt(c.style.gridRow.split('/')[0].trim());
    const cEnd = parseInt(c.style.gridRow.split('/')[1].trim());
    return cStart < clickedEnd && cEnd > clickedStart;
  });

  if (overlapping.length <= 1) return;

  const sorted = overlapping.sort((a, b) => (parseInt(b.style.zIndex) || 2) - (parseInt(a.style.zIndex) || 2));
  const zValues = sorted.map(c => parseInt(c.style.zIndex) || 2);
  const last = zValues.shift();
  zValues.push(last);
  sorted.forEach((c, i) => { c.style.zIndex = zValues[i]; });
}

let pendingClick = null;

function findCellAt(x, y, grid) {
  const cards = grid.querySelectorAll('.lesson-card');
  cards.forEach(c => c.style.pointerEvents = 'none');
  const el = document.elementFromPoint(x, y);
  cards.forEach(c => c.style.pointerEvents = '');
  return el?.closest?.('.grid-cell');
}

function onGridMouseDown(e) {
  if (e.button === 2) return;
  if (isShortlyAfterTouch()) return;
  if (state.profile.role === 'student') return;

  // Student drag in progress — let document-level handlers do the placement, don't set pendingClick.
  if (studentDragState) return;

  // Placing mode (banner-driven student/truant/lesson placement). Per UX
  // change: clicking a card no longer merges the student/truant into it —
  // we always resolve the cell beneath the click and create a new lesson
  // there. findCellAt() hides cards momentarily so elementFromPoint returns
  // the underlying grid cell even when the click landed visually on a card.
  if (state.placingLesson || state.placingStudent || state.placingTruant) {
    const grid = document.getElementById('schedule-grid');
    const cell = findCellAt(e.clientX, e.clientY, grid);
    if (cell) {
      e.preventDefault();
      const d = +cell.dataset.day, r = +cell.dataset.room, s = +cell.dataset.slot;
      if (state.placingLesson) placeTransferredLesson(d, r, s);
      else if (state.placingStudent) placeTransferredStudent(d, r, s);
      else placeTruantOnCell(d, r, s);
    }
    return;
  }

  // Drag handle
  const dragHandle = e.target.closest('.lc-drag-handle');
  if (dragHandle) {
    e.preventDefault();
    const card = dragHandle.closest('.lesson-card');
    const lesson = state.lessons.find(l => l.id === card?.dataset.lessonId);
    if (!lesson) return;
    // Edit lock: blocked if someone else holds it
    if (typeof checkLockedAndToast === 'function' && checkLockedAndToast('lesson:' + lesson.id)) return;
    if (typeof acquireLock === 'function') acquireLock('lesson:' + lesson.id);
    const st = new Date(lesson.start_time); const et = new Date(lesson.end_time);
    const ss = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    const es = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    dragState = { lesson, slotLength: es - ss, startSlot: ss, lockKey: 'lesson:' + lesson.id };
    dragMouseStart = { x: e.clientX, y: e.clientY };
    dragStarted = false;
    return;
  }

  // Click on card or empty cell — defer decision (click vs selection)
  const card = e.target.closest('.lesson-card');
  const grid = document.getElementById('schedule-grid');
  const cell = card ? findCellAt(e.clientX, e.clientY, grid) : e.target.closest('.grid-cell');
  if (!cell) return;

  e.preventDefault();
  clearLessonTooltip();
  pendingClick = {
    x: e.clientX, y: e.clientY,
    card: card,
    lessonId: card?.dataset.lessonId,
    day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot
  };
}

function onGridMouseMove(e) {
  if (isShortlyAfterTouch()) return;
  const grid = document.getElementById('schedule-grid');

  // Pending click → check if it becomes a selection
  if (pendingClick) {
    const dx = e.clientX - pendingClick.x; const dy = e.clientY - pendingClick.y;
    if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
      selecting = true;
      selStart = { day: pendingClick.day, room: pendingClick.room, slot: pendingClick.slot };
      selEnd = { ...selStart };
      updateSelectionHighlight();
      removeCellTooltip();
      pendingClick = null;
    } else {
      // Highlight card under cursor during pending click
      const card = e.target.closest('.lesson-card');
      document.querySelectorAll('.lesson-card-hover').forEach(c => c.classList.remove('lesson-card-hover'));
      if (card) card.classList.add('lesson-card-hover');
      return;
    }
  }

  // Drag lesson
  if (dragState) {
    if (!dragStarted) {
      const dx = e.clientX - dragMouseStart.x; const dy = e.clientY - dragMouseStart.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      dragStarted = true;
      grid.classList.add('grid-dragging');
      grid.querySelector(`.lesson-card[data-lesson-id="${dragState.lesson.id}"]`)?.classList.add('lesson-card-dragging');
      removeCellTooltip();
      clearLessonTooltip();
    }
    clearDragHighlight();
    const cell = e.target.closest('.grid-cell');
    const nwTab = getNextWeekTab();
    document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
    if (nwTab) {
      const r = nwTab.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        nwTab.classList.add('week-tab-drop');
      }
    }
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + dragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = !!getDragConflictType(td, tr, ts, end, dragState.lesson.id, dragState.lesson.teacher_id);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
        addTimeRangeHighlight(grid, ts, end);
      }
    }
    return;
  }

  // Student DnD
  if (studentDragState) {
    const banner = document.getElementById('student-drag-banner');
    banner.style.left = `${e.clientX + 12}px`; banner.style.top = `${e.clientY - 12}px`;
    clearDragHighlight();
    // Use findCellAt: this temporarily disables pointer-events on all lesson
    // cards so elementFromPoint returns the underlying grid cell, even when
    // the cursor visually sits on top of a card. After the iteration-6 UX
    // change (no auto-merge), we render the SAME silhouette preview whether
    // the cursor is over a card or empty space — there's no longer a
    // "drop onto card to merge" concept, so cards shouldn't get a special
    // drop-target highlight anymore.
    const cell = findCellAt(e.clientX, e.clientY, grid);
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + studentDragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = hasAnyConflict(td, tr, ts, end, null, studentDragState.teacherId);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
        addTimeRangeHighlight(grid, ts, end);
      }
    }
    return;
  }

  // Placing mode (lesson or student / truant). Same iteration-6 rule: cursor
  // over a card is functionally identical to cursor over an empty cell —
  // findCellAt sees through cards to find the underlying grid cell so the
  // user gets the same silhouette preview regardless.
  if (state.placingLesson || state.placingStudent || state.placingTruant) {
    clearDragHighlight();
    const cell = findCellAt(e.clientX, e.clientY, grid);
    if (cell) {
      const p = state.placingLesson || state.placingStudent || state.placingTruant;
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + p.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = hasAnyConflict(td, tr, ts, end, null, p.teacherId);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
        addTimeRangeHighlight(grid, ts, end);
      }
    }
    return;
  }

  handleCellTooltip(e, grid);
  handleLessonTooltip(e);

  if (selecting) {
    const cell = findCellAt(e.clientX, e.clientY, grid);
    if (!cell) return;
    if (+cell.dataset.day !== selStart.day || +cell.dataset.room !== selStart.room) return;
    selEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    updateSelectionHighlight();
  }
}

function onGridMouseUp(e) {
  if (isShortlyAfterTouch()) return;
  // Student drag in progress — let document-level mouseup handle placement, don't open any modal here.
  if (studentDragState) { pendingClick = null; return; }
  // Pending click → it was a click (not drag) → open edit if on card
  if (pendingClick) {
    const pc = pendingClick;
    pendingClick = null;
    document.querySelectorAll('.lesson-card-hover').forEach(c => c.classList.remove('lesson-card-hover'));
    if (pc.lessonId) {
      const lesson = state.lessons.find(l => l.id === pc.lessonId);
      if (!lesson) return;
      if (state.profile.role !== 'admin' && lesson.teacher_id !== state.user.id) {
        showToast('Нельзя редактировать чужие занятия', 'error');
        return;
      }
      openEditLessonModal(lesson);
    }
    // Click on empty cell does nothing — new lessons are created via range-select drag.
    return;
  }

  // Drag lesson
  if (dragState) {
    if (!dragStarted) { clearDragState(); dragMouseStart = null; return; }
    document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
    const nwTab = getNextWeekTab();
    if (nwTab) {
      const r = nwTab.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        startNextWeekTransfer(dragState.lesson);
        document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
        clearDragState(); dragMouseStart = null; dragStarted = false; return;
      }
    }
    clearDragHighlight();
    document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
    const cell = e.target.closest('.grid-cell');
    if (cell) finishDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    clearDragState(); dragMouseStart = null; dragStarted = false;
    return;
  }

  // Selection
  if (selecting) {
    selecting = false; clearSelectionHighlight(); removeDurationLabel();
    if (!selStart) return;
    const sf = Math.min(selStart.slot, selEnd.slot); const st = Math.max(selStart.slot, selEnd.slot) + 1;
    const durationMin = (st - sf) * SLOT_MINUTES;
    if (!hasAnyPricingForDuration(durationMin)) {
      showToast(`Нет тарифов для ${durationMin} мин`, 'error');
      selStart = null; selEnd = null;
      return;
    }
    // Conflict block (admin too — see same-reasoning comment in checkConflictServer).
    // hasLocalConflict ignores own-teacher overlaps; admin gets the most generic
    // form by passing their own user id, which simply prevents same-room overlap
    // with anyone else. Visual red ↔ blocked.
    if (hasLocalConflict(selStart.day, selStart.room, sf, st, null, state.user.id)) {
      showToast('Кабинет уже занят в это время', 'error');
      selStart = null; selEnd = null;
      return;
    }
    if (hasTeacherDiffRoomConflict(selStart.day, selStart.room, sf, st, state.user.id, null)) {
      showToast('У вас уже есть занятие в это время', 'error');
      selStart = null; selEnd = null;
      return;
    }
    openLessonModal({ day: selStart.day, room: selStart.room, slotFrom: sf, slotTo: st });
  }
}

// ===== DRAG HIGHLIGHTS =====
function clearDragHighlight() {
  const grid = document.getElementById('schedule-grid');
  if (!grid) return;
  grid.querySelectorAll('.grid-cell-drop-ok, .grid-cell-conflict, .grid-time-active')
    .forEach(c => c.classList.remove('grid-cell-drop-ok', 'grid-cell-conflict', 'grid-time-active'));
}

// Highlight the left-side time labels for slots [slotFrom..slotToInclusive].
// Used during cell selection and during drag/placing for clarity of the time range.
// Highlight time-labels for slots [slotFrom, slotToExclusive). Exclusive on the right —
// the label for `slotToExclusive` (the end-time mark) is NOT highlighted, matching what
// the user expects: a 3-slot lesson lights up exactly 3 time labels, not 4.
function addTimeRangeHighlight(grid, slotFrom, slotToExclusive) {
  for (let s = slotFrom; s < slotToExclusive; s++) {
    const t = grid.querySelector(`.grid-time[data-slot="${s}"]`);
    if (t) t.classList.add('grid-time-active');
  }
}

// ===== TOUCH GESTURES (mobile) =====
// On touch, we use long-press + drag instead of drag-handle drag.
// Tap on card = edit modal. Long-press on .lc-drag-handle = move.
// Long-press on card body = students tooltip (3s). Long-press on empty cell = range-select.
function isInsideExpandedRect(x, y, r, pct) {
  const xp = (r.right - r.left) * pct / 2;
  const yp = (r.bottom - r.top) * pct / 2;
  return x >= r.left - xp && x <= r.right + xp && y >= r.top - yp && y <= r.bottom + yp;
}

// ===== AUTO-SCROLL =====
// During an active touch lesson-drag, scroll the grid horizontally AND vertically when
// the finger approaches an edge — so users can drag to far-away days or distant times
// without running out of screen. Runs only while pointer is inside an edge zone.
const AUTOSCROLL_EDGE_PX = 50;
const AUTOSCROLL_MAX_SPEED = 14;
const AUTOSCROLL_TOP_HEADER_PX = 64;  // sticky day-header (40px) + room-label (24px)
let autoScrollGridId = null;
let autoScrollDirX = 0;
let autoScrollSpeedX = 0;
let autoScrollDirY = 0;
let autoScrollSpeedY = 0;
let autoScrollRAF = null;

function updateAutoScrollX(grid, clientX, clientY) {
  if (!grid) return;
  const r = grid.getBoundingClientRect();
  // Horizontal axis
  const leftDist = clientX - r.left;
  const rightDist = r.right - clientX;
  if (leftDist < AUTOSCROLL_EDGE_PX && leftDist >= 0) {
    autoScrollDirX = -1;
    autoScrollSpeedX = Math.max(2, AUTOSCROLL_MAX_SPEED * (1 - leftDist / AUTOSCROLL_EDGE_PX));
  } else if (rightDist < AUTOSCROLL_EDGE_PX && rightDist >= 0) {
    autoScrollDirX = 1;
    autoScrollSpeedX = Math.max(2, AUTOSCROLL_MAX_SPEED * (1 - rightDist / AUTOSCROLL_EDGE_PX));
  } else {
    autoScrollDirX = 0;
    autoScrollSpeedX = 0;
  }
  // Vertical axis — top zone starts BELOW the sticky day/room headers so the user can
  // trigger an upward scroll only when they're actually near data rows, not on the
  // header itself (where scrolling up does nothing).
  if (typeof clientY === 'number') {
    const topDist = clientY - (r.top + AUTOSCROLL_TOP_HEADER_PX);
    const botDist = r.bottom - clientY;
    if (topDist < AUTOSCROLL_EDGE_PX && topDist >= 0) {
      autoScrollDirY = -1;
      autoScrollSpeedY = Math.max(2, AUTOSCROLL_MAX_SPEED * (1 - topDist / AUTOSCROLL_EDGE_PX));
    } else if (botDist < AUTOSCROLL_EDGE_PX && botDist >= 0) {
      autoScrollDirY = 1;
      autoScrollSpeedY = Math.max(2, AUTOSCROLL_MAX_SPEED * (1 - botDist / AUTOSCROLL_EDGE_PX));
    } else {
      autoScrollDirY = 0;
      autoScrollSpeedY = 0;
    }
  }
  // Start/stop the RAF loop based on whether any axis is active
  if (autoScrollDirX !== 0 || autoScrollDirY !== 0) {
    if (!autoScrollRAF) startAutoScrollLoop(grid.id);
  } else {
    stopAutoScroll();
  }
}

function startAutoScrollLoop(gridId) {
  autoScrollGridId = gridId;
  const tick = () => {
    const g = document.getElementById(autoScrollGridId);
    if (!g || (autoScrollDirX === 0 && autoScrollDirY === 0)) { autoScrollRAF = null; return; }
    if (autoScrollDirX !== 0) g.scrollLeft += autoScrollDirX * autoScrollSpeedX;
    if (autoScrollDirY !== 0) g.scrollTop  += autoScrollDirY * autoScrollSpeedY;
    autoScrollRAF = requestAnimationFrame(tick);
  };
  autoScrollRAF = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
  autoScrollDirX = 0;
  autoScrollSpeedX = 0;
  autoScrollDirY = 0;
  autoScrollSpeedY = 0;
  autoScrollGridId = null;
}

// ===== PLACING PREVIEW (long-press during student/truant placement) =====

function getActivePlacingSlotLength() {
  if (studentDragState) return studentDragState.slotLength || 2;
  if (state.placingTruant) return state.placingTruant.slotLength || 2;
  if (state.placingStudent) return state.placingStudent.slotLength || 2;
  if (state.placingLesson) return state.placingLesson.slotLength || 2;
  return 2;
}

function showPlacementPreview(gridId, day, room, slotFrom, slotLength) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  removePlacementPreview();
  const end = Math.min(slotFrom + slotLength, TOTAL_SLOTS);
  if (end <= slotFrom) return;
  // Conflict check uses the same drag-rules as a real lesson drag, scoped to the right grid.
  let conflict = false;
  const teacherId = studentDragState?.teacherId || state.placingTruant?.teacherId || state.placingStudent?.teacherId;
  if (gridId === 'recurring-grid' && typeof getRecDragConflictType === 'function') {
    conflict = !!getRecDragConflictType(day, room, slotFrom, end, null, teacherId);
  } else if (typeof getDragConflictType === 'function') {
    conflict = !!getDragConflictType(day, room, slotFrom, end, null, teacherId);
  }
  const preview = document.createElement('div');
  preview.className = 'placing-preview' + (conflict ? ' placing-preview-conflict' : '');
  preview.style.gridColumn = `${day * 3 + room + 1}`;
  preview.style.gridRow = `${rowForSlot(slotFrom)} / ${rowForSlot(end)}`;
  grid.appendChild(preview);
}

function removePlacementPreview() {
  document.querySelectorAll('.placing-preview').forEach(el => el.remove());
}

function onPlaceLongPress() {
  const g = touchGesture; if (!g) return;
  if (g.moved) return;  // user already scrolled — long-press is invalid
  g.mode = 'place-drag';
  if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) {} }
  // Stop native pan/scroll for this gesture — otherwise the browser eats the touchmove
  // events and our pointermove handler stops firing (preview wouldn't follow the finger).
  const grid = document.getElementById('schedule-grid');
  if (grid) {
    grid.style.touchAction = 'none';
    try { grid.setPointerCapture(g.pointerId); } catch (_) {}
  }
  const el = document.elementFromPoint(g.startX, g.startY);
  const cell = el?.closest?.('.grid-cell');
  if (cell) {
    showPlacementPreview('schedule-grid', +cell.dataset.day, +cell.dataset.room, +cell.dataset.slot, getActivePlacingSlotLength());
  }
}

// Long-press on the ⠿ handle inside the lesson modal kicks off a continuous touch gesture:
// modal closes, studentDragState is set, and we feed the grid's existing place-drag flow
// (touchGesture with mode='place-drag') so the same finger continues into a real drag —
// the green preview follows it, conflicts colour it red, release commits placement. This
// mirrors lesson-card dragging: grab → drag → drop.
function activateStudentTransferTouch(pointerId, sd, lessonId, teacherId, lessonSlots, x, y) {
  lastTouchTime = Date.now();
  if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) {} }
  // startStudentDrag closes the modal internally and sets studentDragState.
  // It also turns on #student-drag-banner with the student's name — for touch we re-position
  // that banner as a fixed pill at the top so the user always sees who they're carrying.
  startStudentDrag(sd, lessonId, teacherId, lessonSlots);
  const dragBanner = document.getElementById('student-drag-banner');
  if (dragBanner) {
    dragBanner.textContent = `Куда переносим: ${sd.first_name} ${sd.last_name}`;
    dragBanner.style.display = 'block';
    dragBanner.dataset.touchMode = '1';
    // Pin the banner at the top centre — overrides any cursor-follower coords from desktop drag
    dragBanner.style.top = '70px';
    dragBanner.style.left = '50%';
    dragBanner.style.transform = 'translateX(-50%)';
  }
  hidePlacingBanner();  // belt-and-suspenders: nothing else should be showing at this point
  document.body.style.cursor = '';

  // Determine which grid is visible — schedule (#screen-schedule) or recurring (#screen-recurring)
  const recScreen = document.getElementById('screen-recurring');
  const onRecurring = recScreen && !recScreen.classList.contains('hidden');
  const grid = document.getElementById(onRecurring ? 'recurring-grid' : 'schedule-grid');
  if (!grid) return;

  // Lock down panning + capture the pointer so subsequent pointermove keeps reaching the grid
  grid.style.touchAction = 'none';
  try { grid.setPointerCapture(pointerId); } catch (_) {}

  // Seed the grid's touchGesture as if a long-press had just fired there.
  // mode='place-drag' makes the existing pointermove/up handlers drive the preview + commit.
  const gesture = { pointerId, startX: x, startY: y, mode: 'place-drag', moved: true, timer: null };
  if (onRecurring) { recTouchGesture = gesture; }
  else             { touchGesture    = gesture; }

  // Show the preview at the finger's current position right away (don't wait for next move)
  const el = document.elementFromPoint(x, y);
  const cell = el?.closest?.('.grid-cell');
  if (cell) {
    showPlacementPreview(grid.id, +cell.dataset.day, +cell.dataset.room, +cell.dataset.slot, lessonSlots);
  }
}

function onGridPointerDown(e) {
  if (e.pointerType !== 'touch') return;
  // If a touch gesture is already in progress and a second finger arrives,
  // ignore it — let the browser handle multi-touch (pinch-zoom).
  if (touchGesture && touchGesture.pointerId !== e.pointerId) return;
  lastTouchTime = Date.now();
  if (state.profile.role === 'student') return;

  // All placing flows (student transfer / truant / transferred-lesson / transferred-student):
  //   1. Quick tap → does NOTHING (so the user can freely scroll/zoom).
  //   2. Long-press → green preview appears for the slot range; finger keeps holding.
  //   3. Drag → preview follows.
  //   4. Release → commits placement (with conflict check).
  if (studentDragState || state.placingLesson || state.placingStudent || state.placingTruant) {
    touchGesture = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      mode: 'place',
      moved: false,
      timer: setTimeout(onPlaceLongPress, TOUCH_LONG_PRESS_MS)
    };
    return;
  }

  // Z-cycle button — tap cycles z-order, never starts long-press flow
  const zBtn = e.target.closest('.lc-zcycle');
  if (zBtn) {
    e.preventDefault();
    cycleZForCard(zBtn.closest('.lesson-card'));
    return;
  }

  const card = e.target.closest('.lesson-card');
  const cell = e.target.closest('.grid-cell');
  if (!card && !cell) return;

  // On mobile we removed the visible drag-handle. The TOP slot of the card is the drag zone.
  let handleHit = false;
  if (card) {
    const r = card.getBoundingClientRect();
    const lessonObj = state.lessons.find(l => l.id === card.dataset.lessonId);
    if (lessonObj) {
      const st = new Date(lessonObj.start_time), et = new Date(lessonObj.end_time);
      const ss = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const es = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const slotCount = Math.max(1, es - ss);
      // Top-slot height in pixels
      const slotPx = r.height / slotCount;
      handleHit = (e.clientY - r.top) < slotPx;
    }
  }

  // Capture pointer to keep receiving events even if finger moves outside grid
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}

  touchGesture = {
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    card, cell, handleHit,
    longPress: false,
    mode: null,        // 'select' | 'move' | 'tooltip'
    timer: null,
    tooltipTimer: null
  };
  touchGesture.timer = setTimeout(onTouchLongPress, TOUCH_LONG_PRESS_MS);
}

function onTouchLongPress() {
  const g = touchGesture; if (!g) return;
  g.longPress = true;
  if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) {} }

  if (g.card) {
    const lesson = state.lessons.find(l => l.id === g.card.dataset.lessonId);
    if (!lesson) { touchGesture = null; return; }

    if (g.handleHit) {
      // Start move
      if (state.profile.role !== 'admin' && lesson.teacher_id !== state.user.id) {
        showToast('Нельзя перемещать чужие занятия', 'error');
        touchGesture = null; return;
      }
      if (typeof checkLockedAndToast === 'function' && checkLockedAndToast('lesson:' + lesson.id)) {
        touchGesture = null; return;
      }
      if (typeof acquireLock === 'function') acquireLock('lesson:' + lesson.id);
      const st = new Date(lesson.start_time); const et = new Date(lesson.end_time);
      const ss = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const es = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      dragState = { lesson, slotLength: es - ss, startSlot: ss, lockKey: 'lesson:' + lesson.id };
      dragStarted = true;
      g.mode = 'move';
      const grid = document.getElementById('schedule-grid');
      grid.classList.add('grid-dragging');
      g.card.classList.add('lesson-card-dragging');
    } else {
      // Show students tooltip
      g.mode = 'tooltip';
      showLessonTooltipForCard(g.card);
      if (touchTooltipTimer) clearTimeout(touchTooltipTimer);
      touchTooltipTimer = setTimeout(() => { clearLessonTooltip(); touchTooltipTimer = null; }, TOUCH_TOOLTIP_MS);
    }
  } else if (g.cell) {
    // Range-select start
    g.mode = 'select';
    selecting = true;
    selStart = { day: +g.cell.dataset.day, room: +g.cell.dataset.room, slot: +g.cell.dataset.slot };
    selEnd = { ...selStart };
    updateSelectionHighlight();
    removeCellTooltip();
  }
}

function onGridPointerMove(e) {
  if (e.pointerType !== 'touch') return;
  const g = touchGesture; if (!g || g.pointerId !== e.pointerId) return;

  // Placement: track scroll vs. waiting-for-long-press
  if (g.mode === 'place') {
    const dx = Math.abs(e.clientX - g.startX), dy = Math.abs(e.clientY - g.startY);
    if (dx > 10 || dy > 10) {
      g.moved = true;
      if (g.timer) { clearTimeout(g.timer); g.timer = null; }  // abort long-press — it's a scroll
    }
    return;
  }
  if (g.mode === 'place-drag') {
    // The preview follows the finger; auto-scroll lets the user reach far-away cells.
    const grid = document.getElementById('schedule-grid');
    updateAutoScrollX(grid, e.clientX, e.clientY);
    // elementsFromPoint returns the FULL stack at this point — so when the finger is
    // hovering over a lesson card we can still find the grid-cell sitting underneath.
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    const cell = stack.find(el => el.classList && el.classList.contains('grid-cell'));
    if (cell) {
      const d = +cell.dataset.day, r = +cell.dataset.room, s = +cell.dataset.slot;
      g.targetDay = d; g.targetRoom = r; g.targetSlot = s;  // remembered for the release-time conflict check
      showPlacementPreview('schedule-grid', d, r, s, getActivePlacingSlotLength());
    } else {
      g.targetDay = g.targetRoom = g.targetSlot = undefined;
      removePlacementPreview();
    }
    return;
  }

  if (!g.longPress) {
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
    if (Math.sqrt(dx * dx + dy * dy) > TOUCH_MOVE_THRESHOLD) {
      // User is scrolling — abandon long-press
      clearTimeout(g.timer);
      touchGesture = null;
    }
    return;
  }

  if (g.mode === 'select') {
    const grid = document.getElementById('schedule-grid');
    const cell = findCellAt(e.clientX, e.clientY, grid);
    if (cell && +cell.dataset.day === selStart.day && +cell.dataset.room === selStart.room) {
      selEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
      updateSelectionHighlight();
    }
  } else if (g.mode === 'move') {
    const grid = document.getElementById('schedule-grid');
    // Auto-scroll horizontally when finger nears the left/right edge of the grid
    updateAutoScrollX(grid, e.clientX, e.clientY);
    clearDragHighlight();
    document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));

    const nwTab = getNextWeekTab();
    if (nwTab && isInsideExpandedRect(e.clientX, e.clientY, nwTab.getBoundingClientRect(), 0.3)) {
      nwTab.classList.add('week-tab-drop');
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day, tr = +cell.dataset.room, ts = +cell.dataset.slot;
      const end = ts + dragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = !!getDragConflictType(td, tr, ts, end, dragState.lesson.id, dragState.lesson.teacher_id);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
        addTimeRangeHighlight(grid, ts, end);
      }
    }
  }
}

function onGridTouchMove(e) {
  // Block native scroll while in an active long-press gesture (so finger drag drives our UI, not page scroll)
  if (touchGesture && touchGesture.longPress && (touchGesture.mode === 'select' || touchGesture.mode === 'move')) {
    e.preventDefault();
  }
}

function onGridPointerUp(e) {
  if (e.pointerType !== 'touch') return;
  const g = touchGesture; if (!g || g.pointerId !== e.pointerId) return;
  clearTimeout(g.timer);
  lastTouchTime = Date.now();
  stopAutoScroll();

  // 'place' = the long-press never fired (quick tap or scroll). Either way, NOTHING
  // is committed — the user has to explicitly long-press to start a placement drag.
  if (g.mode === 'place') {
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    touchGesture = null;
    return;
  }

  // 'place-drag' = long-press fired, preview was shown. Commit at the cell under finger.
  if (g.mode === 'place-drag') {
    removePlacementPreview();
    const grid = document.getElementById('schedule-grid');
    if (grid) {
      grid.style.touchAction = '';  // restore native panning for next gesture
      try { grid.releasePointerCapture(g.pointerId); } catch (_) {}
    }
    touchGesture = null;
    // Use the slot the preview was last shown at — that's the cell the user has been
    // looking at while deciding to release. Falling back to elementsFromPoint handles
    // the edge case where release fires before any pointermove updated g.target*.
    let day = g.targetDay, room = g.targetRoom, slot = g.targetSlot;
    if (typeof slot !== 'number') {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      const stackCell = stack.find(el => el.classList && el.classList.contains('grid-cell'));
      if (stackCell) { day = +stackCell.dataset.day; room = +stackCell.dataset.room; slot = +stackCell.dataset.slot; }
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const card = el?.closest?.('.lesson-card');

    // Client-side conflict check — MUST match the red preview the user saw, regardless of
    // whether a lesson card happens to sit at the drop point. Uses the same args as
    // showPlacementPreview, so red ↔ blocked is guaranteed.
    if (typeof slot === 'number' && typeof getDragConflictType === 'function') {
      const slotLength = getActivePlacingSlotLength();
      const teacherId = studentDragState?.teacherId || state.placingTruant?.teacherId || state.placingStudent?.teacherId;
      const end = slot + slotLength;
      if (end > TOTAL_SLOTS) {
        showToast('Не помещается', 'error');
        if (studentDragState) cancelStudentDrag();
        return;
      }
      const ct = getDragConflictType(day, room, slot, end, null, teacherId);
      if (ct) {
        // For studentDragState (button-triggered placing), keep the banner active so the
        // user can immediately pick another spot — matches the truant flow. cancelPlacing
        // / cancel button on banner is the only way out.
        conflictToast(ct, null);
        return;
      }
    }

    // Per UX change: dropping a student / truant / transferred-student now
    // ALWAYS creates a new lesson at the cell underneath the drop point — it
    // never merges into the existing card. This means slot coords are the
    // single source of truth here; the `card` variable is no longer consulted
    // for student / truant placement.
    if (studentDragState) {
      if (typeof slot === 'number') placeStudentOnCell(day, room, slot);
      else cancelStudentDrag();
      return;
    }
    if (typeof slot === 'number') {
      if (state.placingLesson) placeTransferredLesson(day, room, slot);
      else if (state.placingStudent) placeTransferredStudent(day, room, slot);
      else if (state.placingTruant) placeTruantOnCell(day, room, slot);
    }
    return;
  }

  if (!g.longPress) {
    // Tap
    if (g.card) {
      e.preventDefault();
      const lesson = state.lessons.find(l => l.id === g.card.dataset.lessonId);
      if (!lesson) { touchGesture = null; return; }
      const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
      const inOverlap = g.card.classList.contains('lesson-card-overlap');
      const cardId = g.card.dataset.lessonId;
      const now = Date.now();

      // Double-tap on a card in an overlap stack → cycle z-order
      if (inOverlap && touchLastCardTapId === cardId && now - touchLastCardTapAt < 350) {
        if (touchEditTimer) { clearTimeout(touchEditTimer); touchEditTimer = null; }
        touchLastCardTapId = null;
        cycleZForCard(g.card);
        touchGesture = null;
        return;
      }

      const openEdit = () => {
        if (canEdit) openEditLessonModal(lesson);
        else showToast('Нельзя редактировать чужие занятия', 'error');
        // After opening via touch, shield the modal so the ~300ms-delayed synthetic
        // click that follows touchend can't hit a button / search input / backdrop
        // inside the modal (which would otherwise immediately trigger Расформировать,
        // Сохранить, focus the search, or close the modal — the "flash" bug).
        shieldFromGhostClick();
      };

      if (inOverlap) {
        // Delay edit modal so we can detect a possible second tap
        touchLastCardTapId = cardId;
        touchLastCardTapAt = now;
        if (touchEditTimer) clearTimeout(touchEditTimer);
        touchEditTimer = setTimeout(() => { touchEditTimer = null; openEdit(); }, 280);
      } else {
        openEdit();
      }
    }
    // Tap on empty cell does nothing (no 30-min tariff)
    touchGesture = null;
    return;
  }

  if (g.mode === 'select') {
    selecting = false; clearSelectionHighlight(); removeDurationLabel();
    if (!selStart) { touchGesture = null; return; }
    const sf = Math.min(selStart.slot, selEnd.slot), st = Math.max(selStart.slot, selEnd.slot) + 1;
    const durationMin = (st - sf) * SLOT_MINUTES;
    if (!hasAnyPricingForDuration(durationMin)) {
      showToast(`Нет тарифов для ${durationMin} мин`, 'error');
      selStart = null; selEnd = null; touchGesture = null; return;
    }
    // Conflict block (admin too) — see mouse-up branch above for rationale
    if (hasLocalConflict(selStart.day, selStart.room, sf, st, null, state.user.id)) {
      showToast('Кабинет уже занят в это время', 'error');
      selStart = null; selEnd = null; touchGesture = null; return;
    }
    if (hasTeacherDiffRoomConflict(selStart.day, selStart.room, sf, st, state.user.id, null)) {
      showToast('У вас уже есть занятие в это время', 'error');
      selStart = null; selEnd = null; touchGesture = null; return;
    }
    openLessonModal({ day: selStart.day, room: selStart.room, slotFrom: sf, slotTo: st });
    shieldFromGhostClick();
  } else if (g.mode === 'move') {
    document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
    const nwTab = getNextWeekTab();
    if (nwTab && isInsideExpandedRect(e.clientX, e.clientY, nwTab.getBoundingClientRect(), 0.3)) {
      startNextWeekTransfer(dragState.lesson);
      g.card?.classList.remove('lesson-card-dragging');
      document.getElementById('schedule-grid')?.classList.remove('grid-dragging');
      clearDragState(); dragStarted = false;
      touchGesture = null; return;
    }
    // Resolve target cell FIRST — while grid-dragging is still active and cards are pointer-events:none
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('.grid-cell');
    // Now safe to drop visual drag state
    clearDragHighlight();
    g.card?.classList.remove('lesson-card-dragging');
    document.getElementById('schedule-grid')?.classList.remove('grid-dragging');
    if (cell) finishDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    else { clearDragState(); dragStarted = false; }
  }
  // tooltip mode: leave tooltipTimer running (3s auto-dismiss)
  touchGesture = null;
}

function onGridPointerCancel(e) {
  if (e.pointerType !== 'touch') return;
  const g = touchGesture; if (!g) return;
  clearTimeout(g.timer);
  stopAutoScroll();
  if (g.mode === 'place' || g.mode === 'place-drag') {
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    removePlacementPreview();
    const grid = document.getElementById('schedule-grid');
    if (grid) {
      grid.style.touchAction = '';
      try { grid.releasePointerCapture(g.pointerId); } catch (_) {}
    }
    // Placing state stays active so user can long-press again. Cancel button on the
    // banner is the explicit way out for both student transfer and truant placement.
  } else if (g.mode === 'select') {
    selecting = false; selStart = null; selEnd = null;
    clearSelectionHighlight(); removeDurationLabel();
  } else if (g.mode === 'move') {
    clearDragHighlight();
    g.card?.classList.remove('lesson-card-dragging');
    document.getElementById('schedule-grid')?.classList.remove('grid-dragging');
    clearDragState(); dragStarted = false;
  } else if (g.mode === 'tooltip') {
    // Leave tooltip and its 3s timer alone — pinch-zoom or scroll shouldn't dismiss it
  }
  touchGesture = null;
}

// Show tooltip with student list for a given lesson card (for touch long-press).
function showLessonTooltipForCard(card) {
  // Same semantics as the desktop hover tooltip (handleLessonTooltip):
  // looks at the HALF-HOUR slot under the finger and lists all students who have
  // a lesson covering that slot in that room (across overlapping lesson cards).
  // Transferred students (those not in the recurring template for this slot) are
  // wrapped in .tooltip-transferred so they get the yellow/brown highlight.
  clearLessonTooltip();
  const lesson = state.lessons.find(l => l.id === card.dataset.lessonId);
  if (!lesson) return;

  // Resolve the slot under the finger from the touch gesture's startY
  const g = touchGesture;
  const r = card.getBoundingClientRect();
  const sStart = new Date(lesson.start_time);
  const ssGlobal = (sStart.getHours() * 60 + sStart.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const eEnd = new Date(lesson.end_time);
  const esGlobal = (eEnd.getHours() * 60 + eEnd.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const slotCount = Math.max(1, esGlobal - ssGlobal);
  const slotPx = r.height / slotCount;
  const fingerY = g ? g.startY : (r.top + r.height / 2);
  const relSlot = Math.max(0, Math.min(slotCount - 1, Math.floor((fingerY - r.top) / slotPx)));
  const slot = ssGlobal + relSlot;

  // Day + room from the lesson (cards are positioned by day/room, so this is unambiguous)
  const dates = getWeekDates(state.currentWeekStart);
  const day = dates.findIndex(d =>
    d.getFullYear() === sStart.getFullYear() &&
    d.getMonth() === sStart.getMonth() &&
    d.getDate() === sStart.getDate());
  if (day === -1) return;
  const room = lesson.room;

  const slotStartMin = START_HOUR * 60 + slot * SLOT_MINUTES;
  const slotEndMin = slotStartMin + SLOT_MINUTES;
  const date = dates[day];

  const names = [];
  state.lessons.forEach(l => {
    if (l.room !== room) return;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const le = new Date(l.end_time);
    const lE = le.getHours() * 60 + le.getMinutes();
    if (slotStartMin >= lE || slotEndMin <= lS) return;
    const startHHMM = `${ls.getHours().toString().padStart(2,'0')}:${ls.getMinutes().toString().padStart(2,'0')}`;
    const endHHMM = `${le.getHours().toString().padStart(2,'0')}:${le.getMinutes().toString().padStart(2,'0')}`;
    const dayOfWeek = ls.getDay() === 0 ? 6 : ls.getDay() - 1;
    (l.lesson_students || []).forEach(s => {
      if (!s.student) return;
      const inRecurring = recurringByStudent ? isStudentInRecurringSlot(s.student_id, dayOfWeek, startHHMM, endHHMM, l.room) : true;
      const name = escapeHtml(`${s.student.first_name} ${s.student.last_name}`);
      names.push(inRecurring ? name : `<span class="tooltip-transferred">${name}</span>`);
    });
  });
  if (names.length === 0) return;

  lessonTooltip = document.createElement('div');
  lessonTooltip.className = 'lesson-tooltip lesson-tooltip-touch';
  lessonTooltip.innerHTML = names.join('<br>');
  document.body.appendChild(lessonTooltip);
  const tw = lessonTooltip.offsetWidth, th = lessonTooltip.offsetHeight;
  let left = r.right + 8;
  if (left + tw > window.innerWidth - 16) left = r.left - tw - 8;
  if (left < 8) left = 8;
  let top = r.top;
  if (top + th > window.innerHeight - 16) top = window.innerHeight - th - 16;
  if (top < 8) top = 8;
  lessonTooltip.style.left = `${left}px`;
  lessonTooltip.style.top = `${top}px`;
}

// ===== Z-CYCLE FOR OVERLAPPING CARDS =====
// Cycles z-order in a stack of overlapping cards. Picks "top card" deterministically.
function cycleZForCard(card) {
  if (!card) return;
  const isRecurring = !!card.closest('#recurring-grid');
  const gridSel = isRecurring ? '#recurring-grid' : '#schedule-grid';
  const col = card.style.gridColumn;
  const allCards = [...document.querySelectorAll(`${gridSel} .lesson-card`)].filter(c => c.style.gridColumn === col);
  if (allCards.length <= 1) return;
  const cs = parseInt(card.style.gridRow.split('/')[0].trim());
  const ce = parseInt(card.style.gridRow.split('/')[1].trim());
  const overlapping = allCards.filter(c => {
    const s = parseInt(c.style.gridRow.split('/')[0].trim());
    const e2 = parseInt(c.style.gridRow.split('/')[1].trim());
    return s < ce && e2 > cs;
  });
  if (overlapping.length <= 1) return;
  const sorted = overlapping.sort((a, b) => (parseInt(b.style.zIndex) || 2) - (parseInt(a.style.zIndex) || 2));
  const zValues = sorted.map(c => parseInt(c.style.zIndex) || 2);
  const last = zValues.shift(); zValues.push(last);
  sorted.forEach((c, i) => { c.style.zIndex = zValues[i]; });
  decorateZCycleButtons(gridSel);
}

// After cards are rendered, mark all cards in overlap groups so tap-handler can detect them.
// Z-cycle is invoked via right-click on desktop, or via double-tap on touch (handled in pointerup).
function decorateZCycleButtons(gridSel) {
  const grid = document.querySelector(gridSel || '#schedule-grid');
  if (!grid) return;
  grid.querySelectorAll('.lc-zcycle').forEach(b => b.remove());           // strip any old ↕ buttons
  grid.querySelectorAll('.lesson-card-overlap').forEach(c => c.classList.remove('lesson-card-overlap'));

  const byCol = {};
  grid.querySelectorAll('.lesson-card').forEach(c => {
    const col = c.style.gridColumn;
    if (!byCol[col]) byCol[col] = [];
    byCol[col].push(c);
  });
  Object.values(byCol).forEach(cards => {
    if (cards.length < 2) return;
    cards.forEach(card => {
      const cs = parseInt(card.style.gridRow.split('/')[0].trim());
      const ce = parseInt(card.style.gridRow.split('/')[1].trim());
      const overlapping = cards.filter(c => {
        if (c === card) return false;
        const s = parseInt(c.style.gridRow.split('/')[0].trim());
        const e2 = parseInt(c.style.gridRow.split('/')[1].trim());
        return s < ce && e2 > cs;
      });
      if (overlapping.length > 0) card.classList.add('lesson-card-overlap');
    });
  });
}

// ===== DRAG & DROP =====
async function finishDrag(targetDay, targetRoom, targetSlot) {
  const lesson = dragState.lesson; const end = targetSlot + dragState.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); clearDragState(); dragStarted = false; return; }

  // Strict client conflict (drag must never create unsafe overlaps)
  const conflictType = getDragConflictType(targetDay, targetRoom, targetSlot, end, lesson.id, lesson.teacher_id);
  if (conflictType === 'room')       { showToast('Кабинет уже занят в это время', 'error');         clearDragState(); dragStarted = false; return; }
  if (conflictType === 'teacher')    { showToast('У вас уже есть занятие в это время', 'error');    clearDragState(); dragStarted = false; return; }
  if (conflictType === 'students')   { showToast('Превышен лимит учеников в группе', 'error');      clearDragState(); dragStarted = false; return; }
  if (conflictType === 'individual') { showToast('Нельзя смешивать индивидуальные и групповые', 'error'); clearDragState(); dragStarted = false; return; }

  const ct = await checkConflictServer(targetDay, targetRoom, targetSlot, end, lesson.id, lesson.teacher_id);
  if (ct) { conflictToast(ct); clearDragState(); dragStarted = false; return; }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[targetDay];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(targetSlot * SLOT_MINUTES / 60), (targetSlot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  // Optimistic local update — render immediately, server roundtrip in background
  const movedLesson = state.lessons.find(l => l.id === lesson.id);
  const snapshot = movedLesson ? { room: movedLesson.room, start_time: movedLesson.start_time, end_time: movedLesson.end_time, week_start: movedLesson.week_start } : null;
  if (movedLesson) {
    movedLesson.room = targetRoom;
    movedLesson.start_time = sTime.toISOString();
    movedLesson.end_time = eTime.toISOString();
    movedLesson.week_start = formatDate(state.currentWeekStart);
  }
  renderLessons();
  clearDragState(); dragStarted = false;

  const updateData = {
    room: targetRoom,
    start_time: sTime.toISOString(),
    end_time: eTime.toISOString(),
    week_start: formatDate(state.currentWeekStart)
  };
  const { error } = await db.from('lessons').update(updateData).eq('id', lesson.id);
  if (error) {
    // Revert on failure
    if (movedLesson && snapshot) {
      movedLesson.room = snapshot.room;
      movedLesson.start_time = snapshot.start_time;
      movedLesson.end_time = snapshot.end_time;
      movedLesson.week_start = snapshot.week_start;
      renderLessons();
    }
    showToast('Ошибка переноса', 'error');
    return;
  }
  showToast('Занятие перенесено', 'success');
}

// ===== NEXT WEEK TRANSFER =====
function startNextWeekTransfer(lesson) {
  clearLessonTooltip(); removeCellTooltip();
  const st = new Date(lesson.start_time); const et = new Date(lesson.end_time);
  const ss = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const es = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  state.placingLesson = {
    originalLessonId: lesson.id, originalWeekStart: formatDate(state.currentWeekStart),
    originalWeekOffset: currentWeekOffset,
    teacherId: lesson.teacher_id, slotLength: es - ss,
    studentIds: (lesson.lesson_students || []).map(ls => ls.student_id)
  };
  currentWeekOffset = currentWeekOffset + 1;
  state.currentWeekStart = getWeekByOffset(currentWeekOffset);
  updateWeekLabel(); updateWeekTabs(); renderGrid(); loadLessons();
}

function showPlacingBanner(customText) {
  let b = document.getElementById('placing-banner');
  if (!b) {
    b = document.createElement('div'); b.id = 'placing-banner';
    b.innerHTML = '<span>Выберите место для занятия</span><button id="btn-cancel-placing">Отмена</button>';
    document.getElementById('screen-schedule').insertBefore(b, document.getElementById('schedule-grid'));
    document.getElementById('btn-cancel-placing').addEventListener('click', cancelPlacing);
  }
  const span = b.querySelector('span');
  if (span) span.textContent = customText || 'Выберите место для занятия';
  b.style.display = 'flex';
}
function hidePlacingBanner() { const b = document.getElementById('placing-banner'); if (b) b.style.display = 'none'; }

function cancelPlacing() {
  const origOffset = state.placingLesson?.originalWeekOffset ?? state.placingStudent?.originalWeekOffset;
  state.placingLesson = null; state.placingStudent = null; state.placingTruant = null;
  if (studentDragState) cancelStudentDrag();
  hidePlacingBanner(); clearDragHighlight();
  document.querySelectorAll('.lesson-card-drop-target, .grid-cell-available').forEach(c => c.classList.remove('lesson-card-drop-target', 'grid-cell-available'));
  if (origOffset !== undefined) {
    currentWeekOffset = origOffset;
    state.currentWeekStart = getWeekByOffset(origOffset);
    updateWeekLabel(); updateWeekTabs(); renderGrid(); loadLessons();
  }
}

// Returns true if all studentIds passed the transfer-limit check.
// For each student with an active subscription where transfers_used >= total_transfers,
// asks user confirmation (showConfirm). If user agrees — proceeds; if rejects — aborts.
// Like checkTransferLimit, but for NEW or RESCHEDULED lessons.
// A lesson counts as a transfer only if its (day_of_week, HH:MM) does NOT match
// any recurring template of the student at this teacher. If matches → not a transfer.
async function checkTransferLimitForLessonCreation(studentIds, lessonStart, teacherId) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return true;
  await recomputeSubscriptionsForStudents(studentIds);

  const { data: subs } = await db.from('subscriptions')
    .select('id, student_id, transfers_used, total_transfers, student:students(first_name, last_name)')
    .in('student_id', studentIds)
    .eq('status', 'active');
  const subByStudent = {};
  (subs || []).forEach(s => { subByStudent[s.student_id] = s; });

  const dow = lessonStart.getDay() === 0 ? 6 : lessonStart.getDay() - 1; // Mon=0..Sun=6
  const lessonKey = `${dow}-${lessonStart.getHours()}:${lessonStart.getMinutes().toString().padStart(2, '0')}`;

  // For students that have an active subscription — check if their recurring templates
  // match the new lesson slot. If no match → this new lesson is a transfer.
  const overLimitNames = [];
  for (const sid of studentIds) {
    const sub = subByStudent[sid];
    if (!sub) continue;
    const { data: recLinks } = await db.from('recurring_lesson_students')
      .select('recurring_lesson:recurring_lessons(day_of_week, start_time, teacher_id)')
      .eq('student_id', sid);
    const templates = (recLinks || [])
      .map(r => r.recurring_lesson)
      .filter(rl => rl && rl.teacher_id === teacherId);
    const isTransfer = templates.length === 0 || !templates.some(rl => {
      const sp = rl.start_time.split(':');
      const key = `${rl.day_of_week}-${+sp[0]}:${(+sp[1]).toString().padStart(2, '0')}`;
      return key === lessonKey;
    });
    if (!isTransfer) continue;
    if ((sub.transfers_used || 0) >= sub.total_transfers) {
      const name = `${sub.student?.first_name || ''} ${sub.student?.last_name || ''}`.trim();
      if (name) overLimitNames.push(name);
    }
  }

  if (overLimitNames.length === 0) return true;

  return new Promise((resolve) => {
    let resolved = false;
    const overlay = document.getElementById('confirm-overlay');
    const observer = new MutationObserver(() => {
      if (!overlay.classList.contains('active')) {
        observer.disconnect();
        setTimeout(() => { if (!resolved) { resolved = true; resolve(false); } }, 0);
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });

    showConfirm(
      `Лимит переносов исчерпан у: ${overLimitNames.join(', ')}. Создать занятие всё равно?`,
      () => { resolved = true; observer.disconnect(); resolve(true); },
      'Создать',
      'primary'
    );
  });
}

async function checkTransferLimit(studentIds) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return true;
  await recomputeSubscriptionsForStudents(studentIds);

  const { data: subs } = await db.from('subscriptions')
    .select('id, student_id, transfers_used, total_transfers, student:students(first_name, last_name)')
    .in('student_id', studentIds)
    .eq('status', 'active');

  const over = (subs || []).filter(s => (s.transfers_used || 0) >= s.total_transfers);
  if (over.length === 0) return true;

  const names = over.map(s => `${s.student?.first_name || ''} ${s.student?.last_name || ''}`.trim()).filter(Boolean).join(', ');

  // Use the existing showConfirm; resolve true when user clicks OK, false on overlay close otherwise.
  return new Promise((resolve) => {
    let resolved = false;
    const overlay = document.getElementById('confirm-overlay');
    const onClose = () => {
      if (resolved) return;
      // Wait one tick to let click handlers run; if not resolved (i.e., OK wasn't clicked) — treat as cancel
      setTimeout(() => { if (!resolved) { resolved = true; resolve(false); } }, 0);
    };
    const observer = new MutationObserver(() => {
      if (!overlay.classList.contains('active')) {
        observer.disconnect();
        onClose();
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });

    showConfirm(
      `Лимит переносов исчерпан у: ${names}. Перенести всё равно?`,
      () => { resolved = true; observer.disconnect(); resolve(true); },
      'Перенести',
      'primary'
    );
  });
}

async function placeTransferredLesson(day, room, slot) {
  if (placementInFlight) return;
  const p = state.placingLesson; if (!p) return;
  const end = slot + p.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  placementInFlight = true;
  try {
    const ct = await checkConflictServer(day, room, slot, end, null, p.teacherId);
    if (ct) { conflictToast(ct); return; }

    // No-double-booking: none of the lesson's students may already be in another
    // active lesson overlapping the new slot. Exclude the original lesson —
    // students are still linked to it until we flip its status to 'transferred'
    // below, so without exclusion they'd flag against themselves.
    const dup = await findStudentDoubleBooking(p.studentIds || [], day, slot, end, p.originalLessonId);
    if (dup) {
      showToast(`${dup.name} уже есть в другом занятии в это время`, 'error');
      return;
    }

    if (!(await checkTransferLimit(p.studentIds || []))) return;

  const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: p.teacherId, room, week_start: formatDate(state.currentWeekStart),
    start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active', transferred_from_id: p.originalLessonId
  }).select().single();
  if (error) { showToast('Ошибка переноса', 'error'); return; }
  if (p.studentIds.length > 0) {
    await db.from('lesson_students').insert(p.studentIds.map(sid => ({ lesson_id: data.id, student_id: sid })));
    for (const sid of p.studentIds) {
      await attachActiveSubscriptionIfAny(data.id, sid, p.teacherId);
    }
  }
  await db.from('lessons').update({ status: 'transferred' }).eq('id', p.originalLessonId);
  // Original lesson's subscription was already counted while it was 'active' in past;
  // since we mark it transferred and create a new lesson, recompute affected subs.
  await recomputeSubscriptionsByLesson(p.originalLessonId);
  // Optimistic state cleanup — same reason as deleteLesson/cancelLesson:
  // close the ~250ms–1s window where conflict checks see the still-active
  // status in state.lessons and falsely mark the freed slot as busy.
  state.lessons = state.lessons.filter(l => l.id !== p.originalLessonId);
  renderLessons();
  state.placingLesson = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Занятие перенесено на следующую неделю', 'success'); await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

async function placeTransferredStudent(day, room, slot) {
  if (placementInFlight) return;
  const p = state.placingStudent; if (!p) return;
  const end = slot + p.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  placementInFlight = true;
  try {
    const ct = await checkConflictServer(day, room, slot, end, null, p.teacherId);
    if (ct) { conflictToast(ct); return; }

    // No-double-booking: a transferred student can't be placed where they
    // already have another active lesson. We exclude p.lessonId — even though
    // the cancellation flow usually means that lesson has been mutated, the
    // student may still be linked to it briefly; explicit exclusion is safest.
    const dup = await findStudentDoubleBooking([p.studentId], day, slot, end, p.lessonId);
    if (dup) {
      showToast(`${dup.name} уже есть в другом занятии в это время`, 'error');
      return;
    }

    if (!(await checkTransferLimit([p.studentId]))) return;

    const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
    const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
    const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

    // Fast path: RPC handles INSERT lesson + move + cleanup + attach sub atomically
    const rpcRes = await rpcPlaceStudentOnNewLesson({
      p_student_id: p.studentId,
      p_teacher_id: p.teacherId,
      p_source_lesson_id: p.lessonId,
      p_room: room,
      p_start_time: sTime.toISOString(),
      p_end_time: eTime.toISOString(),
      p_week_start: formatDate(state.currentWeekStart)
    });

    const origLesson = state.lessons.find(l => l.id === p.lessonId);
    const origWs = p.originalWeekStart || formatDate(getMonday(new Date()));

    if (rpcRes) {
      // Sub recompute + cancellation insert run in parallel — they don't depend on each other
      await Promise.all([
        recomputeSubscriptionsByIds(rpcRes.affected_sub_ids),
        db.from('cancellations').insert({
          student_id: p.studentId, teacher_id: p.teacherId, week_start: origWs, status: 'transferred',
          lesson_start_time: origLesson?.start_time, lesson_end_time: origLesson?.end_time,
          lesson_day: origLesson ? new Date(origLesson.start_time).getDay() : null
        })
      ]);
    } else {
      // Legacy fallback
      const { data, error } = await db.from('lessons').insert({
        teacher_id: p.teacherId, room, week_start: formatDate(state.currentWeekStart),
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();
      if (error) { showToast('Ошибка', 'error'); return; }
      await db.from('lesson_students').insert({ lesson_id: data.id, student_id: p.studentId });
      await db.from('lesson_students').delete().eq('lesson_id', p.lessonId).eq('student_id', p.studentId);
      await attachActiveSubscriptionIfAny(data.id, p.studentId, p.teacherId);
      await recomputeSubscriptionsByLesson(p.lessonId);
      await db.from('cancellations').insert({
        student_id: p.studentId, teacher_id: p.teacherId, week_start: origWs, status: 'transferred',
        lesson_start_time: origLesson?.start_time, lesson_end_time: origLesson?.end_time, lesson_day: origLesson ? new Date(origLesson.start_time).getDay() : null
      });
      await cleanEmptyLesson(p.lessonId);
    }
    state.placingStudent = null; hidePlacingBanner(); clearDragHighlight();
    showToast('Ученик перенесён на следующую неделю', 'success'); await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

async function placeTransferredStudentOnLesson(targetLessonId) {
  if (placementInFlight) return;
  const p = state.placingStudent; if (!p) return;
  const tl = state.lessons.find(l => l.id === targetLessonId);
  if (!tl) { showToast('Занятие не найдено', 'error'); return; }
  if (tl.teacher_id !== p.teacherId) { showToast('Можно добавить только к своему преподавателю', 'error'); return; }
  if ((tl.lesson_students?.length || 0) >= getMaxGroup(tl.teacher_id)) { showToast(`Максимум ${getMaxGroup(tl.teacher_id)} учеников`, 'error'); return; }

  if (!(await checkTransferLimit([p.studentId]))) return;
  placementInFlight = true;
  try {
    // Fast path: one RPC
    const rpcRes = await rpcPlaceStudentOnExistingLesson({
      p_student_id: p.studentId,
      p_teacher_id: p.teacherId,
      p_source_lesson_id: p.lessonId,
      p_target_lesson_id: targetLessonId
    });

    if (rpcRes) {
      recomputeSubscriptionsByIds(rpcRes.affected_sub_ids);
    } else {
      // Legacy fallback
      await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: p.studentId });
      await db.from('lesson_students').delete().eq('lesson_id', p.lessonId).eq('student_id', p.studentId);
      await attachActiveSubscriptionIfAny(targetLessonId, p.studentId, p.teacherId);
      await recomputeSubscriptionsByLesson(p.lessonId);
      await cleanEmptyLesson(p.lessonId);
    }
    state.placingStudent = null; hidePlacingBanner(); clearDragHighlight();
    showToast('Ученик добавлен к занятию', 'success'); await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

// ===== STUDENT DND =====
function startStudentDrag(studentData, lessonId, teacherId, lessonSlotLength) {
  closeLessonModal();
  // Keep lock on source lesson while we move a student out of it
  const lockKey = 'lesson:' + lessonId;
  if (typeof acquireLock === 'function') acquireLock(lockKey);
  studentDragState = {
    studentId: studentData.id, studentName: `${studentData.first_name} ${studentData.last_name}`,
    lessonId, teacherId, slotLength: lessonSlotLength, lockKey
  };
  const banner = document.getElementById('student-drag-banner');
  banner.textContent = `${studentData.first_name} ${studentData.last_name}`;
  banner.style.display = 'block';
  document.body.style.cursor = 'grabbing';
}

async function placeStudentOnCell(day, room, slot) {
  if (placementInFlight) return;  // double-click guard
  const s = studentDragState; if (!s) return;
  const end = slot + s.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); cancelStudentDrag(); return; }
  placementInFlight = true;
  try {
    const ct = await checkConflictServer(day, room, slot, end, null, s.teacherId);
    if (ct) { conflictToast(ct, cancelStudentDrag); return; }

    // No-double-booking: student must not already be in another active lesson
    // overlapping target time. Source lesson is excluded — we're moving OUT of
    // it, so it doesn't count as "elsewhere".
    const dup = await findStudentDoubleBooking([s.studentId], day, slot, end, s.lessonId);
    if (dup) {
      showToast(`${dup.name} уже есть в другом занятии в это время`, 'error');
      cancelStudentDrag(); return;
    }

    if (!(await checkTransferLimit([s.studentId]))) { cancelStudentDrag(); return; }

    const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
    const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
    const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

    // No-op: if the user dropped the student back onto the SAME slot of the
    // source lesson (same teacher / room / start / end), there's nothing to
    // change — just cancel the drag silently. Without this guard we'd create
    // a new lesson identical to the source, move the student over, and delete
    // the source, which is correct semantically but wasteful and produces a
    // pointless «Ученик перенесён» toast.
    const sMs = sTime.getTime(), eMs = eTime.getTime();
    const sourceLesson = state.lessons.find(l => l.id === s.lessonId);
    if (sourceLesson &&
        sourceLesson.room === room &&
        sourceLesson.teacher_id === s.teacherId &&
        new Date(sourceLesson.start_time).getTime() === sMs &&
        new Date(sourceLesson.end_time).getTime() === eMs) {
      cancelStudentDrag();
      return;
    }

    // Fast path: one RPC does INSERT lesson + move lesson_students + cleanup + attach sub
    const rpcRes = await rpcPlaceStudentOnNewLesson({
      p_student_id: s.studentId,
      p_teacher_id: s.teacherId,
      p_source_lesson_id: s.lessonId,
      p_room: room,
      p_start_time: sTime.toISOString(),
      p_end_time: eTime.toISOString(),
      p_week_start: formatDate(state.currentWeekStart)
    });

    if (rpcRes) {
      // Recompute affected subscriptions in parallel (single concurrent batch)
      recomputeSubscriptionsByIds(rpcRes.affected_sub_ids); // fire-and-forget; cache invalidation also happens inside
    } else {
      // Legacy fallback (RPC not installed or other error). Same behaviour as before
      // iteration 3 — kept verbatim so the app keeps working pre-migration.
      const { data, error } = await db.from('lessons').insert({
        teacher_id: s.teacherId, room, week_start: formatDate(state.currentWeekStart),
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();
      if (error) { showToast('Ошибка', 'error'); cancelStudentDrag(); return; }
      await db.from('lesson_students').insert({ lesson_id: data.id, student_id: s.studentId });
      await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);
      await attachActiveSubscriptionIfAny(data.id, s.studentId, s.teacherId);
      await recomputeSubscriptionsByLesson(s.lessonId);
      await cleanEmptyLesson(s.lessonId);
    }
    cancelStudentDrag();
    showToast('Ученик перенесён', 'success'); await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

async function placeStudentOnLesson(targetLessonId) {
  if (placementInFlight) return;
  const s = studentDragState; if (!s) return;
  if (targetLessonId === s.lessonId) { cancelStudentDrag(); return; }
  const tl = state.lessons.find(l => l.id === targetLessonId);
  if (!tl) { cancelStudentDrag(); return; }
  if (tl.teacher_id !== s.teacherId) { showToast('Можно добавить только к своему преподавателю', 'error'); cancelStudentDrag(); return; }
  placementInFlight = true;
  try {

  // Compute target lesson's duration in slots
  const tStart = new Date(tl.start_time), tEnd = new Date(tl.end_time);
  const targetSlots = Math.round((tEnd.getTime() - tStart.getTime()) / (SLOT_MINUTES * 60 * 1000));

  // If the dragged student's original duration differs from the target group's duration,
  // we must NOT silently shrink/extend the student to the group's time. Instead, create
  // a separate lesson at the target's room+start with the student's original duration.
  if (targetSlots !== s.slotLength) {
    const dates = getWeekDates(state.currentWeekStart);
    const di = dates.findIndex(d =>
      d.getFullYear() === tStart.getFullYear() &&
      d.getMonth() === tStart.getMonth() &&
      d.getDate() === tStart.getDate());
    if (di === -1) { showToast('Ошибка даты', 'error'); cancelStudentDrag(); return; }

    const startSlot = (tStart.getHours() * 60 + tStart.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    const endSlot = startSlot + s.slotLength;
    if (endSlot > TOTAL_SLOTS) { showToast('Длительность ученика не помещается в этот слот', 'error'); cancelStudentDrag(); return; }

    const ct = await checkConflictServer(di, tl.room, startSlot, endSlot, null, s.teacherId);
    if (ct) { conflictToast(ct, cancelStudentDrag); return; }

    if (!(await checkTransferLimit([s.studentId]))) { cancelStudentDrag(); return; }

    const sTime = new Date(tStart);
    const eTime = new Date(tStart.getTime() + s.slotLength * SLOT_MINUTES * 60 * 1000);

    // Fast path: one RPC handles INSERT lesson + move + cleanup + attach sub
    const rpcRes = await rpcPlaceStudentOnNewLesson({
      p_student_id: s.studentId,
      p_teacher_id: s.teacherId,
      p_source_lesson_id: s.lessonId,
      p_room: tl.room,
      p_start_time: sTime.toISOString(),
      p_end_time: eTime.toISOString(),
      p_week_start: formatDate(state.currentWeekStart)
    });

    if (rpcRes) {
      recomputeSubscriptionsByIds(rpcRes.affected_sub_ids);
    } else {
      // Legacy fallback
      const { data, error } = await db.from('lessons').insert({
        teacher_id: s.teacherId, room: tl.room, week_start: formatDate(state.currentWeekStart),
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();
      if (error) { showToast('Ошибка', 'error'); cancelStudentDrag(); return; }
      await db.from('lesson_students').insert({ lesson_id: data.id, student_id: s.studentId });
      await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);
      await attachActiveSubscriptionIfAny(data.id, s.studentId, s.teacherId);
      await recomputeSubscriptionsByLesson(s.lessonId);
      await cleanEmptyLesson(s.lessonId);
    }
    cancelStudentDrag();
    showToast('Ученик перенесён в отдельное занятие (своя длительность)', 'success');
    await loadLessons();
    return;
  }

  // Same duration — merge into the existing group lesson
  const targetStudents0 = tl.lesson_students || [];
  if (targetStudents0.some(ls => ls.student_id === s.studentId)) {
    showToast('Ученик уже в этом занятии', 'error'); cancelStudentDrag(); return;
  }
  const { data: draggedStudent } = await db.from('students').select('is_individual').eq('id', s.studentId).single();
  const isInd = draggedStudent?.is_individual;
  const targetStudents = tl.lesson_students || [];
  const targetHasIndividual = targetStudents.some(ls => ls.student?.is_individual);

  if (isInd && targetStudents.length > 0) {
    showToast('Индивидуальное занятие — только один ученик', 'error'); cancelStudentDrag(); return;
  }
  if (!isInd && targetHasIndividual) {
    showToast('В занятии уже индивидуальный ученик', 'error'); cancelStudentDrag(); return;
  }
  if (targetStudents.length >= getMaxGroup(tl.teacher_id)) { showToast(`Максимум ${getMaxGroup(tl.teacher_id)} учеников`, 'error'); cancelStudentDrag(); return; }

  if (!(await checkTransferLimit([s.studentId]))) { cancelStudentDrag(); return; }

  // Fast path: one RPC does INSERT into target + DELETE from source + cleanup + attach sub.
  const rpcRes = await rpcPlaceStudentOnExistingLesson({
    p_student_id: s.studentId,
    p_teacher_id: s.teacherId,
    p_source_lesson_id: s.lessonId,
    p_target_lesson_id: targetLessonId
  });

  if (rpcRes) {
    recomputeSubscriptionsByIds(rpcRes.affected_sub_ids);
  } else {
    // Legacy fallback (RPC not installed)
    await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: s.studentId });
    await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);
    await attachActiveSubscriptionIfAny(targetLessonId, s.studentId, s.teacherId);
    await recomputeSubscriptionsByLesson(s.lessonId);
    await cleanEmptyLesson(s.lessonId);
  }
  cancelStudentDrag();
  showToast('Ученик добавлен к занятию', 'success'); await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

async function cleanEmptyLesson(lessonId) {
  const { data } = await db.from('lesson_students').select('student_id').eq('lesson_id', lessonId);
  if (!data || data.length === 0) {
    await db.from('lessons').delete().eq('id', lessonId);
  }
}

function cancelStudentDrag() {
  if (studentDragState && studentDragState.lockKey && typeof releaseLock === 'function') {
    releaseLock(studentDragState.lockKey);
  }
  studentDragState = null;
  hideStudentTransferBanner();
  // Also hide the placing-banner — used by other transfer flows. Defensive cleanup.
  hidePlacingBanner();
  document.body.style.cursor = '';
  clearDragHighlight();
  // The student-drag UX is shared between the current schedule and the recurring
  // schedule — if the drag was happening on the recurring grid, the cell
  // highlight classes there must be wiped too. Without this the red/green
  // silhouette lingers on recurring after the placement DB op completes.
  if (typeof clearRecDragHighlight === 'function') clearRecDragHighlight();
  document.querySelectorAll('.lesson-card-drop-target').forEach(c => c.classList.remove('lesson-card-drop-target'));
}

// Hides the «Куда переносим: X» pill and resets the touch-mode positioning, without
// touching studentDragState. Used to make the banner disappear the instant the user
// releases their finger, before the async placement DB ops complete.
function hideStudentTransferBanner() {
  const dragBanner = document.getElementById('student-drag-banner');
  if (!dragBanner) return;
  dragBanner.style.display = 'none';
  if (dragBanner.dataset.touchMode === '1') {
    delete dragBanner.dataset.touchMode;
    dragBanner.style.top = '';
    dragBanner.style.left = '';
    dragBanner.style.transform = '';
  }
}

function startStudentNextWeekTransfer() {
  clearLessonTooltip(); removeCellTooltip();
  const s = studentDragState;
  if (!s) return;
  state.placingStudent = {
    studentId: s.studentId, studentName: s.studentName,
    lessonId: s.lessonId, teacherId: s.teacherId,
    slotLength: s.slotLength, originalWeekStart: formatDate(state.currentWeekStart),
    originalWeekOffset: currentWeekOffset
  };
  cancelStudentDrag();
  currentWeekOffset = currentWeekOffset + 1;
  state.currentWeekStart = getWeekByOffset(currentWeekOffset);
  updateWeekLabel(); updateWeekTabs(); renderGrid(); loadLessons();
  showPlacingBanner();
}

// ===== TOOLTIP & SELECTION =====
function handleCellTooltip(e, grid) {
  if (dragState || state.placingLesson || state.placingStudent || state.placingTruant || studentDragState) return;
  const cell = e.target.closest('.grid-cell');
  if (!cell) { removeCellTooltip(); return; }
  const slot = +cell.dataset.slot; const room = +cell.dataset.room;
  if (!hoveredTooltip) { hoveredTooltip = document.createElement('div'); hoveredTooltip.className = 'cell-tooltip'; document.body.appendChild(hoveredTooltip); }
  hoveredTooltip.textContent = `${slotToTime(slot)} ${ROOM_FULL[room - 1]}`;
  const rect = cell.getBoundingClientRect();
  const tw = hoveredTooltip.offsetWidth || 120;
  hoveredTooltip.style.left = (window.innerWidth - rect.right > tw + 16) ? `${rect.right + 8}px` : `${rect.left - tw - 8}px`;
  hoveredTooltip.style.top = `${rect.top + rect.height / 2}px`;
  document.querySelectorAll('.grid-cell-hover').forEach(c => c.classList.remove('grid-cell-hover'));
  cell.classList.add('grid-cell-hover');
}

function removeCellTooltip() {
  if (hoveredTooltip) { hoveredTooltip.remove(); hoveredTooltip = null; }
  document.querySelectorAll('.grid-cell-hover').forEach(c => c.classList.remove('grid-cell-hover'));
}

let lessonTooltip = null;
let lessonTooltipTimer = null;
let lessonTooltipSlotKey = null;

let recurringByStudent = null;

async function loadRecurringByStudent() {
  const { data } = await db.from('recurring_lessons')
    .select('day_of_week, start_time, end_time, room, teacher_id, recurring_lesson_students(student_id)');
  recurringByStudent = {};
  (data || []).forEach(rl => {
    (rl.recurring_lesson_students || []).forEach(rs => {
      if (!recurringByStudent[rs.student_id]) recurringByStudent[rs.student_id] = [];
      recurringByStudent[rs.student_id].push(rl);
    });
  });
}

function isStudentInRecurringSlot(studentId, dayOfWeek, startHHMM, endHHMM, room) {
  const entries = recurringByStudent?.[studentId] || [];
  return entries.some(rl => {
    if (rl.day_of_week !== dayOfWeek) return false;
    if (rl.room !== room) return false;
    return rl.start_time.slice(0,5) === startHHMM && rl.end_time.slice(0,5) === endHHMM;
  });
}

function handleLessonTooltip(e) {
  const card = e.target.closest('.lesson-card');
  if (!card || selecting || dragState || studentDragState || pendingClick) {
    clearLessonTooltip(); return;
  }

  const grid = document.getElementById('schedule-grid');
  const cell = findCellAt(e.clientX, e.clientY, grid);
  if (!cell) { clearLessonTooltip(); return; }

  const day = +cell.dataset.day, room = +cell.dataset.room, slot = +cell.dataset.slot;
  const slotKey = `${day}-${room}-${slot}`;
  if (slotKey === lessonTooltipSlotKey && (lessonTooltip || lessonTooltipTimer)) return;

  clearLessonTooltip();
  lessonTooltipSlotKey = slotKey;
  lessonTooltipTimer = setTimeout(() => {
    const slotStartMin = START_HOUR * 60 + slot * SLOT_MINUTES;
    const slotEndMin = slotStartMin + SLOT_MINUTES;
    const dates = getWeekDates(state.currentWeekStart);
    const date = dates[day];

    const names = [];
    state.lessons.forEach(l => {
      if (l.room !== room) return;
      const ls = new Date(l.start_time);
      if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth()) return;
      const lS = ls.getHours() * 60 + ls.getMinutes();
      const le = new Date(l.end_time);
      const lE = le.getHours() * 60 + le.getMinutes();
      if (slotStartMin >= lE || slotEndMin <= lS) return;
      const startHHMM = `${ls.getHours().toString().padStart(2,'0')}:${ls.getMinutes().toString().padStart(2,'0')}`;
      const endHHMM = `${le.getHours().toString().padStart(2,'0')}:${le.getMinutes().toString().padStart(2,'0')}`;
      const dayOfWeek = ls.getDay() === 0 ? 6 : ls.getDay() - 1;
      (l.lesson_students || []).forEach(s => {
        if (!s.student) return;
        const inRecurring = recurringByStudent ? isStudentInRecurringSlot(s.student_id, dayOfWeek, startHHMM, endHHMM, l.room) : true;
        const name = escapeHtml(`${s.student.first_name} ${s.student.last_name}`);
        names.push(inRecurring ? name : `<span class="tooltip-transferred">${name}</span>`);
      });
    });

    if (names.length === 0) { clearLessonTooltip(); return; }

    lessonTooltip = document.createElement('div');
    lessonTooltip.className = 'lesson-tooltip';
    lessonTooltip.innerHTML = names.join('<br>');
    document.body.appendChild(lessonTooltip);

    const rect = cell.getBoundingClientRect();
    const tw = lessonTooltip.offsetWidth, th = lessonTooltip.offsetHeight;
    let left = rect.right + 8;
    if (left + tw > window.innerWidth - 16) left = rect.left - tw - 8;
    let top = rect.top;
    if (top + th > window.innerHeight - 16) top = window.innerHeight - th - 16;
    lessonTooltip.style.left = `${left}px`;
    lessonTooltip.style.top = `${top}px`;
  }, 500);
}

function clearLessonTooltip() {
  if (lessonTooltipTimer) { clearTimeout(lessonTooltipTimer); lessonTooltipTimer = null; }
  if (lessonTooltip) { lessonTooltip.remove(); lessonTooltip = null; }
  lessonTooltipSlotKey = null;
}

function updateSelectionHighlight() {
  clearSelectionHighlight(); removeDurationLabel();
  if (!selStart || !selEnd) return;
  const grid = document.getElementById('schedule-grid');
  const sf = Math.min(selStart.slot, selEnd.slot); const st = Math.max(selStart.slot, selEnd.slot);
  const count = st - sf + 1;
  // Conflict-aware visual: red the moment the range overlaps an existing
  // lesson the user can't co-locate with. Applies to admin too — visual red
  // ↔ release will be rejected (the release-time checks no longer skip admin).
  let conflict = false;
  if (state.user) {
    conflict = hasLocalConflict(selStart.day, selStart.room, sf, st + 1, null, state.user.id)
            || hasTeacherDiffRoomConflict(selStart.day, selStart.room, sf, st + 1, state.user.id, null);
  }
  for (let s = sf; s <= st; s++) {
    const c = grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${s}"]`);
    if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-selected');
  }
  // Highlight time labels: from start slot to end-time slot (st+1) inclusive
  addTimeRangeHighlight(grid, sf, st + 1);
  const isMobile = window.matchMedia('(max-width: 600px)').matches;
  const anchorCell = isMobile
    ? grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${sf}"]`)
    : grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${st}"]`);
  if (anchorCell && count > 0) {
    durationLabel = document.createElement('div');
    durationLabel.className = 'selection-duration-label';
    durationLabel.textContent = slotsToLabel(count);
    grid.appendChild(durationLabel);
    // The label is `position: absolute` inside the scroll container — its top/left are
    // CONTENT coordinates (not viewport), so we add the container's scroll offset
    // when translating from viewport-based getBoundingClientRect() to content space.
    const rect = anchorCell.getBoundingClientRect(); const gr = grid.getBoundingClientRect();
    const cellLeft = rect.left - gr.left + grid.scrollLeft;
    const cellTop = rect.top - gr.top + grid.scrollTop;
    durationLabel.style.left = `${cellLeft + rect.width / 2}px`;
    if (isMobile) {
      // Always sits directly ABOVE the first cell regardless of scroll position
      durationLabel.style.top = `${cellTop - durationLabel.offsetHeight - 4}px`;
    } else {
      // Desktop: below the last cell
      durationLabel.style.top = `${cellTop + rect.height + 4}px`;
    }
  }
}

function clearSelectionHighlight() {
  const grid = document.getElementById('schedule-grid');
  if (!grid) return;
  // Also wipe grid-cell-conflict here so the red cells from a conflicted
  // selection don't linger after the user releases or restarts the drag.
  grid.querySelectorAll('.grid-cell-selected, .grid-cell-conflict, .grid-time-active')
    .forEach(c => c.classList.remove('grid-cell-selected', 'grid-cell-conflict', 'grid-time-active'));
}
function removeDurationLabel() { if (durationLabel) { durationLabel.remove(); durationLabel = null; } }

// ===== LESSONS CRUD =====

// Collapse lessons that share the same (teacher, room, start_time, end_time) into a
// single visible card. Such duplicates can exist as legacy data from before auto-merge
// was implemented; without this, the schedule shows two identical cards stacked on top
// of one another and the slot count reads double. Returns a deduplicated array.
function collapseOverlappingLessons(lessons) {
  const groups = new Map();
  for (const l of lessons) {
    const key = `${l.teacher_id}|${l.room}|${l.start_time}|${l.end_time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const out = [];
  const cleanupTasks = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    // Multiple lessons at the exact same slot — fold all their student lists into the
    // first (primary) lesson, keeping unique student_ids only.
    const primary = group[0];
    const seen = new Set();
    const merged = [];
    for (const l of group) {
      for (const ls of (l.lesson_students || [])) {
        if (seen.has(ls.student_id)) continue;
        seen.add(ls.student_id);
        merged.push(ls);
      }
    }
    primary.lesson_students = merged;
    out.push(primary);
    cleanupTasks.push({
      primaryId: primary.id,
      secondaryIds: group.slice(1).map(l => l.id),
      studentIds: Array.from(seen)
    });
  }
  // Fire-and-forget DB cleanup so the duplicates eventually disappear server-side too
  if (cleanupTasks.length > 0) cleanupOverlappingLessons(cleanupTasks);
  return out;
}

async function cleanupOverlappingLessons(tasks) {
  for (const t of tasks) {
    try {
      // Ensure every student is attached to the primary lesson (upsert ignores existing rows)
      if (t.studentIds.length > 0) {
        const rows = t.studentIds.map(sid => ({ lesson_id: t.primaryId, student_id: sid }));
        await db.from('lesson_students').upsert(rows, { onConflict: 'lesson_id,student_id', ignoreDuplicates: true });
      }
      // Remove the now-redundant duplicate lessons (CASCADE drops their lesson_students rows)
      if (t.secondaryIds.length > 0) {
        await db.from('lessons').delete().in('id', t.secondaryIds);
      }
    } catch (_) { /* best-effort cleanup — RLS may reject for foreign teachers */ }
  }
}

// Show shimmer placeholder cards in plausible positions while the real lesson
// data is fetching. Removed automatically on the next renderLessons() call.
// Strategy: keep the EXISTING cards visible if there are any (avoids the empty
// flash when switching weeks), only inject skeletons on first load when there's
// nothing to show. This is the "skeleton or stale content, never blank" rule.
function showScheduleSkeleton() {
  const grid = document.getElementById('schedule-grid');
  if (!grid) return;
  // If we already have rendered lesson cards, don't replace them — keep the
  // user looking at the previous week's cards until the new data lands.
  if (grid.querySelector('.lesson-card:not(.skel-card)')) return;
  if (grid.querySelector('.skel-card')) return; // already shown
  // Inject a handful of fake cards at common slots (10:00, 14:00, 18:00 × few rooms)
  const isMobile = window.innerWidth <= 600;
  const positions = isMobile
    ? [[0, 1, 4, 4], [2, 2, 12, 4]]                            // mobile: 2 cards
    : [[0, 1, 4, 4], [2, 2, 12, 4], [4, 3, 20, 4], [1, 2, 8, 4]]; // desktop: 4 cards
  positions.forEach(([day, room, startSlot, length]) => {
    const card = document.createElement('div');
    card.className = 'lesson-card skel-card';
    card.style.gridRow = `${rowForSlot(startSlot)} / ${rowForSlot(startSlot + length)}`;
    card.style.gridColumn = colForDayRoom(day, room);
    grid.appendChild(card);
  });
}

// Tracks which weeks have been successfully loaded from the network during
// this session. If a week is already in here, subsequent loadLessons() calls
// for that week (from realtime refresh, after a drag, after a placement)
// SKIP the cache-hydrate step — the in-memory state is canonical, and
// re-rendering from possibly-older cache would flicker stale data on top.
const lessonsFreshlyLoadedWeeks = new Set();

async function loadLessons() {
  const ws = formatDate(state.currentWeekStart);

  // Hydrate from cache ONLY when offline. Online users always go straight to
  // the network — cache flash on tab navigation would be a UX regression.
  // (Offline boot still benefits from cache to show last-known data.)
  const isFreshLoad = !lessonsFreshlyLoadedWeeks.has(ws);
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('lessons:' + ws) : null;
    if (cached && Array.isArray(cached)) {
      state.lessons = cached;
      renderLessons();
    }
  }

  showScheduleSkeleton(); // shimmer placeholder if we have nothing to show
  const { data, error } = await db.from('lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name, max_group_size), lesson_students(student_id, subject_id, student:students(first_name, last_name, subject, is_individual, is_online, price_type)), original_start_time, original_end_time, transferred_from_id')
    .eq('week_start', ws).eq('status', 'active');
  if (error) {
    // Toast only if we have NOTHING on screen for this week
    if (isFreshLoad && (!state.lessons || state.lessons.length === 0)) {
      showToast('Ошибка загрузки', 'error');
    }
    return;
  }
  // Deduplicate lesson_students by student_id — same student can't be in the same lesson
  // twice (physically impossible). Any duplicates that slipped past historical inserts are
  // collapsed here so counts, max-group checks, and rendering all see a clean set.
  (data || []).forEach(l => {
    if (!l.lesson_students || l.lesson_students.length < 2) return;
    const seen = new Set();
    l.lesson_students = l.lesson_students.filter(ls => {
      if (seen.has(ls.student_id)) return false;
      seen.add(ls.student_id);
      return true;
    });
  });
  state.lessons = collapseOverlappingLessons(
    (data || []).filter(l => l.lesson_students?.length > 0 && l.room !== 0)
  );
  const emptyIds = (data || []).filter(l => !l.lesson_students?.length).map(l => l.id);
  if (emptyIds.length > 0) db.from('lessons').delete().in('id', emptyIds);
  if (!recurringByStudent) await loadRecurringByStudent();
  renderLessons();

  // Persist this week's snapshot for offline boot. Keyed by week_start so
  // switching weeks doesn't clobber each other's cache.
  if (typeof cacheSet === 'function') cacheSet('lessons:' + ws, state.lessons);
  lessonsFreshlyLoadedWeeks.add(ws);

  // Run side-effects in parallel, do not block the caller (e.g. cancellation flow)
  const currentMonday = getMonday(new Date());
  const isCurrentWeek = formatDate(state.currentWeekStart) === formatDate(currentMonday);
  const profileVisible = document.getElementById('screen-profile')?.classList.contains('active');

  // Fire-and-forget: heavy recurring↔actual sync runs in background.
  // It won't delay the UI; once it finishes it will resync via realtime / next loadLessons call.
  // We re-fetch truants AFTER compute completes — but ONLY if the user is
  // currently looking at the profile screen. Otherwise the call is wasted
  // bandwidth, and worse, an out-of-sequence render later (when the user
  // does open the profile) would briefly flash one state then update —
  // exactly the "blinking" the user reported.
  if (isCurrentWeek && typeof computeAndSyncCancellations === 'function') {
    computeAndSyncCancellations().then(() => {
      const stillVisible = document.getElementById('screen-profile')?.classList.contains('active');
      if (stillVisible && typeof loadTruants === 'function') loadTruants();
    });
  }

  // Dependent views in parallel — only triggered when the relevant section
  // is actually visible. openProfileScreen fires its own fresh loaders, so
  // when the user navigates IN they always get fresh data; we don't need
  // to keep these warmed up while they're elsewhere.
  const refreshes = [];
  if (profileVisible && typeof loadTruants === 'function') refreshes.push(loadTruants());
  if (profileVisible && typeof loadPayroll === 'function') refreshes.push(loadPayroll());
  Promise.all(refreshes); // not awaited — UI does not wait for these
}

function buildModalTitle(di, room, sf, st) { return `${DAYS_FULL[di]} · ${ROOM_FULL[room - 1]} · ${slotToTime(sf)}–${slotToTime(st)}`; }

async function loadTeacherStudentsForModal(tid) {
  const { data } = await db.from('students')
    .select('id, first_name, last_name, subject, is_individual, is_online, price_type, student_subjects(subject_id, subjects(id, name))')
    .eq('teacher_id', tid).order('first_name');
  const seen = new Set();
  allTeacherStudents = (data || []).filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
  // Flatten junction join into a plain [{id, name}] per student — used by
  // the "which subject?" picker when the student has more than one.
  allTeacherStudents.forEach(s => {
    s.subjectList = (s.student_subjects || [])
      .map(ss => ss.subjects)
      .filter(Boolean);
    // Legacy fallback: if the junction is empty but the old text column has
    // something, look up its id from the dictionary so the picker still works.
    if (s.subjectList.length === 0 && s.subject && typeof subjectsList !== 'undefined') {
      const found = subjectsList.find(sj => sj.name === s.subject);
      if (found) s.subjectList = [{ id: found.id, name: found.name }];
    }
  });

  // Read active subscriptions (no rebind/recompute here — those are heavy and run only
  // in openStudentDetail / when lessons actually change. Reading is enough for the modal.)
  const sids = allTeacherStudents.map(s => s.id);
  studentActiveSub = {};
  if (sids.length > 0) {
    const { data: subs } = await db.from('subscriptions')
      .select('id, student_id, total_lessons, used_lessons, end_date, pricing:pricing_id(duration_minutes, format)')
      .in('student_id', sids)
      .eq('status', 'active');
    (subs || []).forEach(s => { studentActiveSub[s.student_id] = s; });
  }

  // Load current-week lesson status for each student
  const currentWs = formatDate(getMonday(new Date()));
  if (sids.length === 0) return;

  const { data: weekLessons } = await db.from('lessons')
    .select('id, status, start_time, end_time, original_start_time, original_end_time, transferred_from_id, lesson_students(student_id)')
    .eq('week_start', currentWs).eq('teacher_id', tid)
    .in('status', ['active', 'cancelled', 'transferred']);

  studentWeekStatus = {};
  (weekLessons || []).forEach(l => {
    (l.lesson_students || []).forEach(ls => {
      const sid = ls.student_id;
      if (!sids.includes(sid)) return;
      if (!studentWeekStatus[sid]) studentWeekStatus[sid] = [];
      studentWeekStatus[sid].push(l);
    });
  });

  // Load cancellations (pending) for truant display
  const threeWeeksAgo = new Date(getMonday(new Date()));
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 14);
  const { data: cancellations } = await db.from('cancellations')
    .select('id, student_id, week_start, status, lesson_start_time, lesson_day, is_paid, valid_reason, recurring_lesson:recurring_lessons(start_time, day_of_week)')
    .eq('teacher_id', tid).in('status', ['pending', 'transferred'])
    .gte('week_start', formatDate(threeWeeksAgo));

  studentCancellations = {};
  (cancellations || []).forEach(c => {
    if (!studentCancellations[c.student_id]) studentCancellations[c.student_id] = [];
    studentCancellations[c.student_id].push(c);
  });
}

// Which subject was assigned to each currently-selected student in the lesson
// modal. Lives in state.lessonModal.selectedSubjects (Map<student_id,
// subject_id>) — mirrors selectedIds. Populated at open time (for edit) or
// as the teacher picks students (for create).

// Show the "Which subject?" mini-modal on top of the lesson modal.
// options: [{id, name}] — subjects available for this student.
// Callback receives the chosen subject id (never null; cancel just closes).
function showSubjectPicker(studentName, options, onPick) {
  const overlay = document.getElementById('subject-picker-overlay');
  const listWrap = document.getElementById('subject-picker-options');
  document.getElementById('subject-picker-title').textContent =
    `Какой предмет для ${studentName}?`;
  listWrap.innerHTML = options
    .map(o => `<button type="button" class="subject-picker-option" data-id="${o.id}">${escapeHtml(o.name)}</button>`)
    .join('');
  const close = () => overlay.classList.remove('active');
  listWrap.querySelectorAll('.subject-picker-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      close();
      onPick(id);
    });
  });
  document.getElementById('btn-subject-picker-cancel').onclick = close;
  overlay.classList.add('active');
}

// Decide the subject for a student the teacher is about to add. If they have
// one subject we assign silently; more than one → show the picker; none →
// error toast (should be caught earlier by student creation validation).
function pickSubjectForStudent(student, onPick) {
  const opts = student.subjectList || [];
  if (opts.length === 0) {
    showToast(`У ${student.first_name} ${student.last_name} нет предметов. Добавьте в карточке.`, 'error');
    return;
  }
  if (opts.length === 1) { onPick(opts[0].id); return; }
  showSubjectPicker(`${student.first_name} ${student.last_name}`, opts, onPick);
}

function openLessonModal(sel) {
  document.getElementById('lesson-modal-title').textContent = buildModalTitle(sel.day, sel.room, sel.slotFrom, sel.slotTo);
  document.getElementById('btn-delete-lesson').style.display = 'none';
  document.getElementById('btn-save-lesson').style.display = 'block';
  document.getElementById('lesson-student-search').parentElement.style.display = 'block';
  document.getElementById('lesson-current-students').innerHTML = '';
  document.getElementById('lesson-current-students').style.display = 'none';
  state.lessonModal = {
    mode: 'create', day: sel.day, room: sel.room, slotFrom: sel.slotFrom, slotTo: sel.slotTo,
    selectedIds: new Set(),
    selectedSubjects: new Map() // student_id → subject_id
  };
  loadTeacherStudentsForModal(state.user.id).then(() => {
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
    document.getElementById('lesson-student-search').focus();
  });
}

async function openEditLessonModal(lesson) {
  // Edit lock: refuse if someone else is editing this lesson
  const key = 'lesson:' + lesson.id;
  if (typeof checkLockedAndToast === 'function' && checkLockedAndToast(key)) return;
  if (typeof acquireLock === 'function') acquireLock(key);  // fire-and-forget so modal opens instantly

  const start = new Date(lesson.start_time); const end = new Date(lesson.end_time);
  const dates = getWeekDates(state.currentWeekStart);
  const di = dates.findIndex(d => d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth() && d.getDate() === start.getDate());
  const ss = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const es = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  document.getElementById('lesson-modal-title').textContent = buildModalTitle(di, lesson.room, ss, es);
  const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
  document.getElementById('btn-delete-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('btn-save-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('lesson-student-search').parentElement.style.display = canEdit ? 'block' : 'none';
  const selectedIds = new Set((lesson.lesson_students || []).map(ls => ls.student_id));
  // Load the subject_id assigned to each student — this is the multi-subject
  // storage (`lesson_students.subject_id`) that replaces the old "one subject
  // per lesson" model.
  const selectedSubjects = new Map();
  (lesson.lesson_students || []).forEach(ls => {
    if (ls.subject_id) selectedSubjects.set(ls.student_id, ls.subject_id);
  });
  state.lessonModal = { mode: 'edit', lessonId: lesson.id, teacherId: lesson.teacher_id, day: di, room: lesson.room, slotFrom: ss, slotTo: es, selectedIds, selectedSubjects };
  // Show overlay immediately (no wait for DB load) — populate lists once loaded
  document.getElementById('lesson-overlay').classList.add('active');
  document.getElementById('lesson-student-search').value = '';
  document.getElementById('lesson-current-students').innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Загрузка…</div>';
  document.getElementById('lesson-students-list').innerHTML = '';
  loadTeacherStudentsForModal(lesson.teacher_id).then(() => {
    // Make sure modal hasn't been closed/switched in the meantime
    if (state.lessonModal?.lessonId !== lesson.id) return;
    renderCurrentStudents();
    renderLessonStudentsList('');
  });
}

function renderCurrentStudents() {
  const ct = document.getElementById('lesson-current-students');
  const m = state.lessonModal;
  if (!m) { ct.style.display = 'none'; ct.innerHTML = ''; return; }
  const canEdit = state.profile.role === 'admin' || (m.mode === 'create' || m.mode === 'rec-create') || (m.teacherId === state.user.id);
  const selected = allTeacherStudents.filter(s => m.selectedIds.has(s.id));
  if (selected.length === 0) { ct.style.display = 'none'; ct.innerHTML = ''; return; }
  ct.style.display = 'block';
  const nameToId = {};
  if (typeof subjectsList !== 'undefined') subjectsList.forEach(sj => { nameToId[sj.id] = sj.name; });
  // Format: "Егор Мирошенко · ЕГЭ Информатика" — chosen subject as inline
  // separator. Falls back to legacy s.subject if lesson_students.subject_id
  // hasn't been set yet (very old rows before the migration).
  ct.innerHTML = `<label class="lesson-label">Текущие ученики</label>` + selected.map(s => {
    const cancelBtn = canEdit && (m.mode === 'edit') ? `<button class="cs-cancel" data-student-id="${s.id}" title="Отменить ученика">✕</button>` : '';
    const subjectId = m.selectedSubjects && m.selectedSubjects.get(s.id);
    const subjectName = subjectId ? nameToId[subjectId] : (s.subject || '');
    const subjectPart = subjectName ? ` · ${escapeHtml(subjectName)}` : '';
    return `<div class="current-student-row" data-student-id="${s.id}">
      ${canEdit && (m.mode === 'edit' || m.mode === 'rec-edit') ? '<button class="cs-transfer-btn" type="button" title="Перенести ученика"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></button>' : ''}
      <span class="cs-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}<span class="lesson-student-subject">${subjectPart}</span>${s.is_online ? '<span class="lesson-online-badge">Онл.</span>' : ''}</span>
      ${cancelBtn}
      ${canEdit ? `<button class="cs-remove" data-student-id="${s.id}" title="Убрать из списка"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
    </div>`;
  }).join('');

  if (canEdit) {
    ct.querySelectorAll('.cs-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.studentId;
        m.selectedIds.delete(sid);
        if (m.selectedSubjects) m.selectedSubjects.delete(sid);
        renderCurrentStudents();
        renderLessonStudentsList(document.getElementById('lesson-student-search').value.trim());
      });
    });
    ct.querySelectorAll('.cs-cancel').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.studentId;
        const s = allTeacherStudents.find(x => x.id === sid);
        const lessonId = m.lessonId;
        const teacherId = m.teacherId;
        const lesson = state.lessons.find(l => l.id === lessonId);
        const lessonStartTime = lesson?.start_time;
        const lessonEndTime = lesson?.end_time;
        const lessonWeekStart = lesson?.week_start;
        const lessonDay = m.day;
        showCancelConfirm(`Отменить ${s?.first_name || ''} ${s?.last_name || ''}?`, async (isPaid) => {
          // 1. Optimistic UI update — show change instantly
          const lessonRef = state.lessons.find(l => l.id === lessonId);
          let removedLs = null;
          if (lessonRef && Array.isArray(lessonRef.lesson_students)) {
            const idx = lessonRef.lesson_students.findIndex(ls => ls.student_id === sid);
            if (idx !== -1) { removedLs = lessonRef.lesson_students[idx]; lessonRef.lesson_students.splice(idx, 1); }
          }
          m.selectedIds.delete(sid);
          if (m.selectedSubjects) m.selectedSubjects.delete(sid);
          const isEmpty = m.selectedIds.size === 0;
          if (isEmpty && lessonRef) state.lessons = state.lessons.filter(l => l.id !== lessonId);
          renderLessons();
          if (isEmpty) closeLessonModal();
          else { renderCurrentStudents(); renderLessonStudentsList(document.getElementById('lesson-student-search').value.trim()); }
          showToast(isPaid
            ? (isEmpty ? 'Ученик отменён (платно), занятие удалено' : 'Ученик отменён (платно)')
            : (isEmpty ? 'Ученик отменён, занятие удалено' : 'Ученик отменён'), 'success');

          // 2. Persist to DB — parallel writes, rollback on error
          const ws = lessonWeekStart || formatDate(getMonday(new Date()));
          try {
            const results = await Promise.all([
              db.from('lesson_students').delete().eq('lesson_id', lessonId).eq('student_id', sid),
              db.from('cancellations').insert({ student_id: sid, teacher_id: teacherId, week_start: ws, status: 'pending', lesson_start_time: lessonStartTime, lesson_end_time: lessonEndTime, lesson_day: lessonDay, is_paid: isPaid })
            ]);
            const failed = results.find(r => r && r.error);
            if (failed) throw failed.error;
            if (isEmpty) cleanEmptyLesson(lessonId); // fire-and-forget
            // Background refresh of dependent views (truants, payroll)
            loadLessons();
          } catch (err) {
            showToast('Ошибка отмены, обновляю', 'error');
            if (lessonRef && removedLs && !isEmpty) lessonRef.lesson_students.push(removedLs);
            await loadLessons();
          }
        });
      });
    });
    if (m.mode === 'edit' || m.mode === 'rec-edit') {
      ct.querySelectorAll('.cs-transfer-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const row = btn.closest('.current-student-row');
          const sid = row.dataset.studentId;
          const sd = allTeacherStudents.find(s => s.id === sid);
          if (!sd) return;
          const lessonSlots = m.slotTo - m.slotFrom;
          enterStudentPlacingMode(sd, m.lessonId, m.teacherId, lessonSlots);
        });
      });
    }
  }
}

// Click-to-place flow for student transfer — same UX shape as truant placement.
// Closes the modal, sets studentDragState, and shows the shared #placing-banner with
// "Выберите место для <name>". User then long-presses a grid cell to preview the slot,
// drags to fine-tune, releases to commit (with conflict check that BLOCKS on red).
function enterStudentPlacingMode(sd, lessonId, teacherId, lessonSlots) {
  closeLessonModal();
  if (typeof acquireLock === 'function') acquireLock('lesson:' + lessonId);
  studentDragState = {
    studentId: sd.id, studentName: `${sd.first_name} ${sd.last_name}`,
    lessonId, teacherId, slotLength: lessonSlots,
    lockKey: 'lesson:' + lessonId
  };
  // Hide the desktop cursor-follower banner — we use the shared placing-banner instead
  const dragBanner = document.getElementById('student-drag-banner');
  if (dragBanner) dragBanner.style.display = 'none';
  showPlacingBanner(`Выберите место для ${sd.first_name} ${sd.last_name}`);
}

function closeLessonModal() {
  document.getElementById('lesson-overlay').classList.remove('active');
  // Release any lesson edit lock
  if (state.lessonModal && state.lessonModal.lessonId && typeof releaseLock === 'function') {
    const prefix = state.lessonModal.mode === 'rec-edit' ? 'rec:' : 'lesson:';
    releaseLock(prefix + state.lessonModal.lessonId);
  }
  state.lessonModal = null; allTeacherStudents = [];
}

function buildStudentWeekBadge(studentId) {
  const lessons = studentWeekStatus[studentId] || [];
  const cancels = studentCancellations[studentId] || [];
  const currentWs = formatDate(getMonday(new Date()));
  const badges = [];

  // Collect active lesson day+time keys for current week
  const activeKeys = new Set();
  lessons.forEach(l => {
    if (l.status !== 'active') return;
    const start = new Date(l.start_time);
    const dayName = DAYS_SHORT[start.getDay() === 0 ? 6 : start.getDay() - 1];
    const time = `${start.getHours().toString().padStart(2,'0')}:${start.getMinutes().toString().padStart(2,'0')}`;
    activeKeys.add(`${dayName} ${time}`);
    badges.push(`<span class="student-week-badge badge-active">${dayName} ${time}</span>`);
  });

  // Cancellations / transfers: skip if there's already an active lesson for same day+time on current week
  cancels.forEach(c => {
    const timeStr = getCancelTimeStr(c);
    if (!timeStr) return;
    const isCurrentWeek = !c.week_start || c.week_start === currentWs;
    // If same day+time exists as active lesson on current week, skip this cancellation badge
    if (isCurrentWeek && activeKeys.has(timeStr)) return;
    if (c.status === 'transferred') {
      badges.push(`<span class="student-week-badge badge-transferred">Перенесён ${timeStr}</span>`);
    } else if (c.status === 'pending') {
      badges.push(`<span class="student-week-badge badge-cancelled">Отменено ${timeStr}</span>`);
    }
  });

  return badges.join('');
}

function getCancelTimeStr(c) {
  const currentWs = formatDate(getMonday(new Date()));
  let dayName = '', time = '';
  if (c.lesson_start_time) {
    const d = new Date(c.lesson_start_time);
    dayName = DAYS_SHORT[d.getDay() === 0 ? 6 : d.getDay() - 1];
    time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  } else if (c.recurring_lesson) {
    const sp = c.recurring_lesson.start_time.split(':');
    dayName = DAYS_SHORT[c.recurring_lesson.day_of_week];
    time = `${(+sp[0]).toString().padStart(2,'0')}:${sp[1]}`;
  }
  if (!dayName) return '';
  if (c.week_start && c.week_start !== currentWs) {
    const wd = new Date(c.week_start + 'T00:00:00');
    const dd = wd.getDate().toString().padStart(2,'0');
    const mm = (wd.getMonth()+1).toString().padStart(2,'0');
    const yy = String(wd.getFullYear()).slice(2);
    return `${dd}.${mm}.${yy} ${dayName} ${time}`;
  }
  return `${dayName} ${time}`;
}

const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function renderLessonStudentsList(filter) {
  const list = document.getElementById('lesson-students-list');
  const m = state.lessonModal; if (!m) return;
  const search = filter.toLowerCase();
  const canEdit = state.profile.role === 'admin' || (m.mode === 'create' || m.mode === 'rec-create') || (m.teacherId === state.user.id);
  const currentWs = formatDate(getMonday(new Date()));

  // Truant students (only pending, not transferred; valid_reason=true excluded)
  const truantIds = new Set();
  const pendingCancels = {};
  Object.entries(studentCancellations).forEach(([sid, cancels]) => {
    const pending = cancels.filter(c => c.status === 'pending' && !c.is_paid && !c.valid_reason);
    if (pending.length > 0) { truantIds.add(sid); pendingCancels[sid] = pending; }
  });

  let allStudents = allTeacherStudents;
  if (search) allStudents = allStudents.filter(s => s.first_name.toLowerCase().includes(search) || s.last_name.toLowerCase().includes(search));

  // Filter by active subscription's lesson duration.
  // Lesson duration in this modal = (slotTo - slotFrom) * 30 minutes.
  // A student with an active subscription can only attend lessons matching that subscription's duration.
  // Students without an active subscription pay per single lesson — no duration restriction.
  // Always keep already-selected students visible (so user can deselect them).
  const lessonDurationMin = (m.slotTo - m.slotFrom) * 30;
  allStudents = allStudents.filter(s => {
    if (m.selectedIds.has(s.id)) return true; // never hide already-checked
    const sub = studentActiveSub[s.id];
    if (!sub) return true;
    return sub.pricing?.duration_minutes === lessonDurationMin;
  });

  const truantStudents = allStudents.filter(s => truantIds.has(s.id));
  const regularStudents = allStudents.filter(s => !truantIds.has(s.id));

  if (allStudents.length === 0) { list.innerHTML = '<div class="lesson-no-students">Нет учеников</div>'; return; }

  let html = '';

  // Truant block
  if (truantStudents.length > 0) {
    html += '<div class="modal-truant-block">';
    truantStudents.forEach(s => {
      const ch = m.selectedIds.has(s.id);
      const indBadge = s.is_individual ? '<span class="lesson-ind-badge">Инд.</span>' : '';
      const onlBadge = s.is_online ? '<span class="lesson-online-badge">Онл.</span>' : '';
      const subBadge = studentActiveSub[s.id] ? '<span class="lesson-sub-badge" title="Активный абонемент">Абн.</span>' : '';
      const cancels = pendingCancels[s.id] || [];
      const dateBadges = cancels.map(c => {
        const timeStr = getCancelTimeStr(c);
        return timeStr ? `<span class="modal-truant-date">${timeStr}</span>` : '';
      }).filter(Boolean).join('');
      html += `<label class="lesson-student-row truant-row${ch ? ' checked' : ''}"><span class="lesson-student-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}${indBadge}${onlBadge}${subBadge}${dateBadges}</span>${canEdit ? `<input type="checkbox" class="lesson-checkbox" data-id="${s.id}" data-individual="${s.is_individual || false}" ${ch ? 'checked' : ''}>` : (ch ? '<span class="lesson-check-mark">✓</span>' : '')}</label>`;
    });
    html += '</div>';
  }

  // Regular students
  regularStudents.forEach(s => {
    const ch = m.selectedIds.has(s.id);
    const indBadge = s.is_individual ? '<span class="lesson-ind-badge">Инд.</span>' : '';
    const onlBadge = s.is_online ? '<span class="lesson-online-badge">Онл.</span>' : '';
    const subBadge = studentActiveSub[s.id] ? '<span class="lesson-sub-badge" title="Активный абонемент">Абн.</span>' : '';
    const weekBadge = buildStudentWeekBadge(s.id);
    html += `<label class="lesson-student-row${ch ? ' checked' : ''}"><span class="lesson-student-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}${indBadge}${onlBadge}${subBadge}${weekBadge}</span>${canEdit ? `<input type="checkbox" class="lesson-checkbox" data-id="${s.id}" data-individual="${s.is_individual || false}" ${ch ? 'checked' : ''}>` : (ch ? '<span class="lesson-check-mark">✓</span>' : '')}</label>`;
  });

  list.innerHTML = html;

  if (canEdit) {
    list.querySelectorAll('.lesson-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        const isInd = cb.dataset.individual === 'true';
        if (cb.checked) {
          const selectedStudents = allStudents.filter(s => m.selectedIds.has(s.id));
          const hasIndividual = selectedStudents.some(s => s.is_individual);
          if (isInd && selectedStudents.length > 0) {
            cb.checked = false; showToast('Индивидуальное занятие — только один ученик', 'error'); return;
          }
          if (!isInd && hasIndividual) {
            cb.checked = false; showToast('В занятии уже индивидуальный ученик', 'error'); return;
          }
          const maxG = getMaxGroup(m.teacherId || state.user.id);
          if (m.selectedIds.size >= maxG) { cb.checked = false; showToast(`Максимум ${maxG} учеников`, 'error'); return; }

          // Ask which subject if the student has more than one. For a single-
          // subject student we assign silently; for multi, the mini-modal
          // pops up (blocking selection until the teacher picks one).
          // The checkbox is optimistically checked — we roll it back if the
          // teacher cancels the picker so the visual state matches reality.
          const student = allStudents.find(s => s.id === id);
          const opts = (student && student.subjectList) || [];
          if (opts.length === 0) {
            cb.checked = false;
            showToast(`У ${student.first_name} ${student.last_name} нет предметов`, 'error');
            return;
          }
          if (opts.length === 1) {
            m.selectedIds.add(id);
            m.selectedSubjects.set(id, opts[0].id);
            cb.closest('.lesson-student-row').classList.toggle('checked', true);
            renderCurrentStudents();
            return;
          }
          // Multi-subject: show picker. Roll back checkbox until user commits.
          showSubjectPicker(`${student.first_name} ${student.last_name}`, opts, (subjectId) => {
            m.selectedIds.add(id);
            m.selectedSubjects.set(id, subjectId);
            cb.closest('.lesson-student-row').classList.toggle('checked', true);
            renderCurrentStudents();
          });
          // If the user closes the picker without picking, they can just try again.
          // Keep the checkbox unchecked for now so state and UI agree.
          cb.checked = false;
        } else {
          m.selectedIds.delete(id);
          if (m.selectedSubjects) m.selectedSubjects.delete(id);
          cb.closest('.lesson-student-row').classList.toggle('checked', false);
          renderCurrentStudents();
        }
      });
    });
  }
}

async function saveLesson() {
  const m = state.lessonModal; if (!m) return;
  if (m.mode === 'rec-create' || m.mode === 'rec-edit') { await saveRecurringLesson(); return; }
  const btn = document.getElementById('btn-save-lesson'); btn.disabled = true;
  if (m.selectedIds.size === 0) { showToast('Добавьте хотя бы одного ученика', 'error'); btn.disabled = false; return; }

  // Tariff validation
  const durationMin = (m.slotTo - m.slotFrom) * SLOT_MINUTES;
  const selectedStudents = allTeacherStudents.filter(s => m.selectedIds.has(s.id));
  for (const s of selectedStudents) {
    if (!findPricing(durationMin, s.is_individual || false, s.price_type || 'new', s.is_online || false)) {
      showToast(`Нет тарифа для ${s.first_name} ${s.last_name} (${durationMin} мин, ${s.is_individual ? 'инд.' : 'груп.'}, ${s.price_type === 'old' ? 'стар.' : 'нов.'})`, 'error');
      btn.disabled = false; return;
    }
  }

  const tid = m.mode === 'create' || m.mode === 'rec-create' ? state.user.id : m.teacherId;
  const ct = await checkConflictServer(m.day, m.room, m.slotFrom, m.slotTo, m.mode === 'edit' || m.mode === 'rec-edit' ? m.lessonId : null, tid);
  if (ct) { conflictToast(ct); btn.disabled = false; return; }

  // No-double-booking rule: no selected student may already be in ANOTHER active
  // lesson that overlaps this time slot. For edits we exclude THIS lesson so an
  // existing student of the lesson isn't flagged against itself.
  if (m.mode === 'create' || m.mode === 'edit') {
    const sidsForCheck = Array.from(m.selectedIds);
    const dup = await findStudentDoubleBooking(
      sidsForCheck, m.day, m.slotFrom, m.slotTo,
      m.mode === 'edit' ? m.lessonId : null
    );
    if (dup) {
      showToast(`${dup.name} уже есть в другом занятии в это время`, 'error');
      btn.disabled = false; return;
    }
  }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[m.day]; const ws = formatDate(state.currentWeekStart);
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(m.slotFrom * SLOT_MINUTES / 60), (m.slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(m.slotTo * SLOT_MINUTES / 60), (m.slotTo * SLOT_MINUTES) % 60, 0, 0);
  const sids = Array.from(m.selectedIds);

  // Transfer-limit check (only for real lessons, not recurring templates)
  if (sids.length > 0 && (m.mode === 'create' || m.mode === 'edit')) {
    if (!(await checkTransferLimitForLessonCreation(sids, sTime, tid))) {
      btn.disabled = false;
      return;
    }
  }

  if (m.mode === 'create' || m.mode === 'rec-create') {
    // The lessons.subject text column stays as a summary for the grid card —
    // set to the first attached student's subject. Per-student granularity is
    // stored in lesson_students.subject_id below.
    const firstSid = sids[0];
    const firstSubjectId = firstSid ? m.selectedSubjects.get(firstSid) : null;
    const firstSubjectName = firstSubjectId
      ? (subjectsList.find(sj => sj.id === firstSubjectId) || {}).name || null
      : null;
    const { data, error } = await db.from('lessons').insert({ teacher_id: state.user.id, room: m.room, week_start: ws, start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active', subject: firstSubjectName }).select().single();
    if (error) { showToast('Ошибка', 'error'); btn.disabled = false; return; }
    if (sids.length > 0) {
      const rows = sids.map(sid => ({
        lesson_id: data.id,
        student_id: sid,
        subject_id: m.selectedSubjects.get(sid) || null
      }));
      await db.from('lesson_students').insert(rows);
    }

    // === Optimistic UI: show the new lesson on the grid IMMEDIATELY and free
    // the modal, before we chase all the subscription bookkeeping. Without
    // this, the teacher waits ~1s while attachActiveSubscriptionIfAny (per
    // student) + recompute + loadLessons run in sequence. The BG chain
    // reconciles state with the server; if something races, the next
    // loadLessons wins.
    const optimisticLesson = {
      ...data,
      teacher: {
        short_name: state.profile?.short_name || '',
        color: state.profile?.color || null,
        full_name: state.profile?.full_name || '',
        max_group_size: state.profile?.max_group_size || 3
      },
      lesson_students: sids.map(sid => {
        const student = allTeacherStudents.find(s => s.id === sid);
        return {
          student_id: sid,
          subject_id: m.selectedSubjects.get(sid) || null,
          student: student ? {
            first_name: student.first_name, last_name: student.last_name,
            subject: student.subject, is_individual: student.is_individual,
            is_online: student.is_online, price_type: student.price_type
          } : null
        };
      })
    };
    state.lessons.push(optimisticLesson);
    renderLessons();
    btn.disabled = false;
    closeLessonModal();
    showToast('Занятие создано', 'success');

    // Background: subscriptions attach + a follow-up loadLessons to fold in
    // whatever the server calculated (subscription_id, transfer counters).
    (async () => {
      try {
        for (const sid of sids) await attachActiveSubscriptionIfAny(data.id, sid, state.user.id);
        await loadLessons();
      } catch (e) { console.error('saveLesson bg:', e); }
    })();
    return;
  } else {
    const firstSid = sids[0];
    const firstSubjectId = firstSid ? m.selectedSubjects.get(firstSid) : null;
    const firstSubjectName = firstSubjectId
      ? (subjectsList.find(sj => sj.id === firstSubjectId) || {}).name || null
      : null;
    const { error } = await db.from('lessons').update({ room: m.room, start_time: sTime.toISOString(), end_time: eTime.toISOString(), subject: firstSubjectName }).eq('id', m.lessonId);
    if (error) { showToast('Ошибка', 'error'); btn.disabled = false; return; }
    // Snapshot subscriptions before deleting links so we can recompute them after
    const { data: oldLinks } = await db.from('lesson_students').select('subscription_id').eq('lesson_id', m.lessonId);
    const oldSubIds = new Set((oldLinks || []).map(r => r.subscription_id).filter(Boolean));

    await db.from('lesson_students').delete().eq('lesson_id', m.lessonId);
    if (sids.length > 0) {
      const rows = sids.map(sid => ({
        lesson_id: m.lessonId,
        student_id: sid,
        subject_id: m.selectedSubjects.get(sid) || null
      }));
      await db.from('lesson_students').insert(rows);
    }

    // Optimistic in-place update of the lesson in state — same idea as the
    // create path above. Rebuild lesson_students from the modal's map so the
    // grid re-renders without waiting for the network roundtrip.
    const li = state.lessons.findIndex(l => l.id === m.lessonId);
    if (li !== -1) {
      const cur = state.lessons[li];
      state.lessons[li] = {
        ...cur,
        room: m.room,
        start_time: sTime.toISOString(),
        end_time: eTime.toISOString(),
        subject: firstSubjectName,
        lesson_students: sids.map(sid => {
          const student = allTeacherStudents.find(s => s.id === sid);
          return {
            student_id: sid,
            subject_id: m.selectedSubjects.get(sid) || null,
            student: student ? {
              first_name: student.first_name, last_name: student.last_name,
              subject: student.subject, is_individual: student.is_individual,
              is_online: student.is_online, price_type: student.price_type
            } : null
          };
        })
      };
    }
    renderLessons();
    btn.disabled = false;
    closeLessonModal();
    showToast('Занятие обновлено', 'success');

    (async () => {
      try {
        for (const sid of sids) await attachActiveSubscriptionIfAny(m.lessonId, sid, state.user.id);
        for (const subId of oldSubIds) await recomputeSubscriptionUsage(subId);
        await loadLessons();
      } catch (e) { console.error('saveLesson edit bg:', e); }
    })();
    return;
  }
}

async function deleteLesson() {
  const m = state.lessonModal; if (!m || (m.mode !== 'edit' && m.mode !== 'rec-edit')) return;
  if (m.mode === 'rec-edit') { await deleteRecurringLesson(); return; }
  const lid = m.lessonId;
  const lesson = state.lessons.find(l => l.id === lid);
  const transferredFromId = lesson?.transferred_from_id;
  const teacherId = lesson?.teacher_id;
  const studentIds = (lesson?.lesson_students || []).map(ls => ls.student_id);
  closeLessonModal();
  showConfirm('Расформировать занятие? Оно удалится без учёта в оплате.', async () => {
    // If this was a transferred lesson, turn its existing "transferred" cancellations into "pending"
    // so the students appear in truants for origin week
    if (transferredFromId && studentIds.length > 0) {
      const { data: origCancels } = await db.from('cancellations')
        .select('id, student_id, week_start')
        .eq('teacher_id', teacherId)
        .eq('status', 'transferred')
        .in('student_id', studentIds);
      if (origCancels?.length > 0) {
        await db.from('cancellations').update({ status: 'pending' }).in('id', origCancels.map(c => c.id));
      }
    }
    await db.from('lesson_students').delete().eq('lesson_id', lid);
    await db.from('lessons').delete().eq('id', lid);
    // Optimistic state cleanup: remove the lesson from state.lessons BEFORE the
    // network loadLessons() finishes. Without this there's a ~250ms–1s window
    // (network + realtime debounce) where hasTeacherDiffRoomConflict, etc.,
    // still see the row and produce false "занят" toasts for the freed slot.
    state.lessons = state.lessons.filter(l => l.id !== lid);
    renderLessons();
    showToast('Занятие расформировано', 'success'); await loadLessons();
  }, 'Расформировать');
}

async function cancelLesson() {
  const m = state.lessonModal; if (!m || m.mode !== 'edit') return;
  const lid = m.lessonId;
  const teacherId = m.teacherId;
  const studentIds = Array.from(m.selectedIds);
  const lessonDay = m.day;
  const lesson = state.lessons.find(l => l.id === lid);
  const lessonStartTime = lesson?.start_time;
  const lessonEndTime = lesson?.end_time;
  const lessonWeekStart = lesson?.week_start;
  closeLessonModal();
  showConfirm('Отменить занятие? Все ученики будут отменены.', async () => {
    await db.from('lessons').update({ status: 'cancelled' }).eq('id', lid);
    await recomputeSubscriptionsByLesson(lid);
    // Optimistic state cleanup — see deleteLesson() for the same pattern and
    // rationale. loadLessons() will re-fetch and confirm, but we need the
    // slot to look "free" to conflict checks IMMEDIATELY, not in 250-1000ms.
    state.lessons = state.lessons.filter(l => l.id !== lid);
    renderLessons();
    const ws = lessonWeekStart || formatDate(getMonday(new Date()));
    if (studentIds.length > 0) {
      await db.from('cancellations').insert(
        studentIds.map(sid => ({ student_id: sid, teacher_id: teacherId, week_start: ws, status: 'pending', lesson_start_time: lessonStartTime, lesson_end_time: lessonEndTime, lesson_day: lessonDay }))
      );
    }
    showToast('Занятие отменено', 'success');
    await loadLessons();
  }, 'Отменить');
}

// ===== NAVIGATION =====
let currentWeekOffset = 0;

function getWeekByOffset(offset) {
  const now = getMonday(new Date());
  const d = new Date(now);
  d.setDate(d.getDate() + offset * 7);
  return d;
}

function switchToWeekOffset(offset) {
  // Block week navigation for lesson/student transfers (they carry an originalWeekOffset)
  // but allow it for TRUANT placing — the user explicitly asked to be able to flip
  // weeks while choosing where to place a truant.
  if (state.placingLesson || state.placingStudent) { showToast('Сначала разместите или отмените перенос', 'error'); return; }
  currentWeekOffset = offset;
  state.currentWeekStart = getWeekByOffset(offset);
  updateWeekLabel();
  updateWeekTabs();
  renderGrid();
  loadLessons();
}

function updateWeekTabs() {
  document.querySelectorAll('.week-tab').forEach(tab => {
    tab.classList.toggle('active', +tab.dataset.offset === currentWeekOffset);
  });
}

function getNextWeekTab() {
  const nextOffset = currentWeekOffset + 1;
  if (nextOffset > 2) return null;
  return document.querySelector(`.week-tab[data-offset="${nextOffset}"]`);
}

function initSchedule() {
  if (scheduleInited) { renderGrid(); loadLessons(); return; }
  state.currentWeekStart = getMonday(new Date());
  currentWeekOffset = 0;
  updateWeekLabel(); updateWeekTabs(); renderGrid(); loadLessons();
  // Install grid event listeners ONCE — the #schedule-grid DOM element is never
  // recreated (only its children are wiped on renderGrid via innerHTML='').
  initGridInteractions(document.getElementById('schedule-grid'));

  // ----- Reactive placing-banner (iteration 5) -----
  // Subscribers fire on any assignment to state.placingLesson/Student/Truant.
  // Effect: setting any of these to non-null automatically shows the banner;
  // setting all three to null automatically hides it. Removes the "I cleared
  // the placing state but forgot to call hidePlacingBanner" class of bugs.
  // Custom banner text is still set by callers via `showPlacingBanner(text)`;
  // this subscriber only enforces visibility.
  const syncPlacingBanner = () => {
    const isPlacing = state.placingLesson || state.placingStudent || state.placingTruant;
    const banner = document.getElementById('placing-banner');
    if (isPlacing) {
      if (!banner) showPlacingBanner();      // create DOM + default text
      else banner.style.display = 'flex';     // already exists → just reveal
    } else {
      if (banner) banner.style.display = 'none';
    }
  };
  subscribe('placingLesson', syncPlacingBanner);
  subscribe('placingStudent', syncPlacingBanner);
  subscribe('placingTruant', syncPlacingBanner);

  document.querySelectorAll('.week-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const offset = +tab.dataset.offset;
      if (dragState && dragStarted && offset === currentWeekOffset + 1) {
        startNextWeekTransfer(dragState.lesson);
        document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
        document.getElementById('schedule-grid')?.classList.remove('grid-dragging');
        clearDragState(); dragMouseStart = null; dragStarted = false;
        return;
      }
      switchToWeekOffset(offset);
    });
  });

  document.getElementById('btn-save-lesson').addEventListener('click', saveLesson);
  document.getElementById('btn-close-lesson').addEventListener('click', closeLessonModal);
  document.getElementById('btn-close-lesson-modal').addEventListener('click', closeLessonModal);
  document.getElementById('btn-delete-lesson').addEventListener('click', deleteLesson);

  let st;
  document.getElementById('lesson-student-search').addEventListener('input', (e) => {
    clearTimeout(st); st = setTimeout(() => renderLessonStudentsList(e.target.value.trim()), 150);
  });
  document.getElementById('lesson-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLessonModal(); });


  // Global handlers for drag that goes outside grid
  document.addEventListener('mousemove', (e) => {
    if (dragState && dragStarted) {
      clearDragHighlight();
      document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
      const nwTab = getNextWeekTab();
      if (nwTab) {
        const r = nwTab.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          nwTab.classList.add('week-tab-drop');
        }
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el?.closest?.('.grid-cell');
      if (cell) {
        const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
        const end = ts + dragState.slotLength;
        if (end <= TOTAL_SLOTS) {
          const conflict = !!getDragConflictType(td, tr, ts, end, dragState.lesson.id, dragState.lesson.teacher_id);
          const grid = document.getElementById('schedule-grid');
          for (let s = ts; s < end; s++) {
            const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
            if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
          }
          addTimeRangeHighlight(grid, ts, end);
        }
      }
    }
    if (studentDragState) {
      const banner = document.getElementById('student-drag-banner');
      if (banner) { banner.style.left = `${e.clientX + 12}px`; banner.style.top = `${e.clientY - 12}px`; }
      document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
      const nwTab = getNextWeekTab();
      if (nwTab) {
        const r = nwTab.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          nwTab.classList.add('week-tab-drop');
        }
      }
      clearDragHighlight();
      // findCellAt resolves the cell under cards too. Iteration-6: cards
      // never receive a special "drop target" highlight any more — same
      // silhouette preview everywhere.
      const grid = document.getElementById('schedule-grid');
      const cell = findCellAt(e.clientX, e.clientY, grid);
      if (cell) {
        const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
        const end = ts + studentDragState.slotLength;
        if (end <= TOTAL_SLOTS) {
          const conflict = hasAnyConflict(td, tr, ts, end, null, studentDragState.teacherId);
          for (let s = ts; s < end; s++) {
            const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
            if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
          }
          addTimeRangeHighlight(grid, ts, end);
        }
      }
    }
  });

  document.addEventListener('mouseup', (e) => {
    document.getElementById('schedule-grid')?.classList.remove('grid-dragging');
    document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
    document.querySelectorAll('.lesson-card-hover').forEach(c => c.classList.remove('lesson-card-hover'));
    pendingClick = null;
    if (dragState && dragStarted) {
      const nwTab = getNextWeekTab();
      if (nwTab) {
        const r = nwTab.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          startNextWeekTransfer(dragState.lesson);
          document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
          clearDragState(); dragMouseStart = null; dragStarted = false; return;
        }
      }
      clearDragHighlight();
      document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el?.closest?.('.grid-cell');
      if (cell) finishDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
      clearDragState(); dragMouseStart = null; dragStarted = false;
    }
    if (studentDragState) {
      clearDragHighlight();
      document.querySelectorAll('.lesson-card-drop-target').forEach(c => c.classList.remove('lesson-card-drop-target'));
      const nwTab = getNextWeekTab();
      if (nwTab) {
        const r = nwTab.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          startStudentNextWeekTransfer(); return;
        }
      }
      const grid = document.getElementById('schedule-grid');
      // Drop a student onto a cell — even if the user released over a lesson
      // card. findCellAt temporarily disables card pointer-events so
      // elementFromPoint sees the cell beneath. We never call
      // placeStudentOnLesson here any more (no auto-merge): a drop creates a
      // new lesson at exactly the cell, with the student's slot length.
      const cell = findCellAt(e.clientX, e.clientY, grid);
      if (cell) placeStudentOnCell(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
      else cancelStudentDrag();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      pendingClick = null;
      if (state.placingLesson || state.placingStudent || state.placingTruant) cancelPlacing();
      if (studentDragState) cancelStudentDrag();
    }
  });

  scheduleInited = true;
}

function conflictToast(ct, cancelFn) {
  const msgs = {
    room: 'Кабинет занят другим преподавателем',
    teacher: 'Преподаватель занят в другом кабинете',
    students: 'Превышен лимит учеников в кабинете',
    individual: 'Нельзя совместить индивидуальное занятие с другим'
  };
  showToast(msgs[ct] || 'Конфликт', 'error');
  if (cancelFn) cancelFn();
}
