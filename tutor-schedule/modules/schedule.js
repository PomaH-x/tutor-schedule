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

let selecting = false;
let selStart = null;
let selEnd = null;
let scheduleInited = false;
let hoveredTooltip = null;
let durationLabel = null;
let allTeacherStudents = [];
let studentWeekStatus = {};
let studentCancellations = {};
let dragState = null;
let dragMouseStart = null;
let dragStarted = false;
let studentDragState = null;

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
    if (l.id === excludeId || l.room !== room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lS = ls.getHours() * 60 + ls.getMinutes();
    const lE = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    if (startMin >= lE || endMin <= lS) return false;
    return teacherId ? l.teacher_id !== teacherId : true;
  });
}

function hasTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; if (!date) return false;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
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

  // Check room conflict (different teacher same room)
  let q = db.from('lessons').select('id, teacher_id').eq('week_start', ws).eq('room', room).eq('status', 'active').lt('start_time', et.toISOString()).gt('end_time', st.toISOString());
  if (excludeId) q = q.neq('id', excludeId);
  const { data: rd } = await q;
  if ((rd || []).some(l => l.teacher_id !== teacherId)) return 'room';

  // Check teacher in two rooms simultaneously
  let q2 = db.from('lessons').select('id').eq('week_start', ws).eq('teacher_id', teacherId).neq('room', room).eq('status', 'active').lt('start_time', et.toISOString()).gt('end_time', st.toISOString());
  if (excludeId) q2 = q2.neq('id', excludeId);
  const { data: td } = await q2;
  if (td && td.length > 0) return 'teacher';

  // Check student count and individual mixing among overlapping lessons in same room
  let q3 = db.from('lessons').select('id, lesson_students(student_id, student:students(is_individual))').eq('week_start', ws).eq('room', room).eq('status', 'active').lt('start_time', et.toISOString()).gt('end_time', st.toISOString());
  if (excludeId) q3 = q3.neq('id', excludeId);
  const { data: overlapping } = await q3;
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
    for (let day = 0; day < 7; day++) {
      for (let room = 1; room <= 3; room++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        if (min === 0) cell.classList.add('grid-cell-hour');
        if (room === 3) cell.classList.add('grid-cell-day-end');
        if (slot >= TOTAL_SLOTS) cell.classList.add('grid-cell-end');
        cell.style.gridRow = row; cell.style.gridColumn = colForDayRoom(day, room);
        if (slot < TOTAL_SLOTS) { cell.dataset.day = day; cell.dataset.room = room; cell.dataset.slot = slot; }
        grid.appendChild(cell);
      }
    }
  }
  initGridInteractions(grid);
  renderLessons();
  if (state.placingLesson || state.placingStudent || state.placingTruant) showPlacingBanner();
}

// ===== LESSONS RENDER (overlap) =====
function renderLessons() {
  document.querySelectorAll('.lesson-card').forEach(el => el.remove());
  document.querySelectorAll('.grid-cell').forEach(c => {
    c.style.background = ''; c.innerHTML = '';
    
    delete c.dataset.lessonIds;
  });

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
      const sc = lesson.lesson_students?.length || 0;
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
        const textColor = isDark
          ? (clamped >= 3 ? 'rgba(255,255,255,0.85)' : `rgba(${r},${g},${b},0.7)`)
          : (clamped >= 3 ? 'rgba(255,255,255,0.9)' : `rgba(${r},${g},${b},0.75)`);
        const showCount = slotClaimed[s] === lesson.id;
        const countHTML = showCount ? `<span class="lc-slot-count" style="color:${textColor}">${total}</span>` : '';
        slotsHTML += `<div class="lc-slot" style="background:${slotBg}">${countHTML}</div>`;
      }

      const isFirst = lesson._ov === 0;
      const sn = (lesson.teacher?.short_name || '??').replace(/\./g, '');
      const headerColor = `rgba(${r},${g},${b},${isDark ? 0.9 : 1})`;
      const headerHTML = isFirst ? `<div class="lc-header" style="color:${headerColor}">${sn}</div>` : '';
      const dragHTML = canDrag ? '<div class="lc-drag-handle" title="Перетащить">⠿</div>' : '';

      card.innerHTML = `${dragHTML}${headerHTML}<div class="lc-slots">${slotsHTML}</div>`;
      grid.appendChild(card);
    });
  });
}

// ===== GRID INTERACTIONS =====
function initGridInteractions(grid) {
  grid.addEventListener('mousedown', onGridMouseDown);
  grid.addEventListener('mousemove', onGridMouseMove);
  grid.addEventListener('mouseup', onGridMouseUp);
  grid.addEventListener('contextmenu', onGridContextMenu);
}

function onGridContextMenu(e) {
  const card = e.target.closest('.lesson-card');
  if (!card) return;
  e.preventDefault();

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
  if (state.profile.role === 'student') return;

  // Placing mode
  if (state.placingLesson || state.placingStudent || state.placingTruant) {
    const cell = e.target.closest('.grid-cell');
    const card = e.target.closest('.lesson-card');
    if (card && (state.placingStudent || state.placingTruant)) {
      e.preventDefault();
      if (state.placingStudent) placeTransferredStudentOnLesson(card.dataset.lessonId);
      else placeTruantOnLesson(card.dataset.lessonId);
    } else if (cell) {
      e.preventDefault();
      if (state.placingLesson) placeTransferredLesson(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
      else if (state.placingStudent) placeTransferredStudent(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
      else placeTruantOnCell(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
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
    const st = new Date(lesson.start_time); const et = new Date(lesson.end_time);
    const ss = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    const es = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    dragState = { lesson, slotLength: es - ss, startSlot: ss };
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
        const conflict = hasAnyConflict(td, tr, ts, end, dragState.lesson.id, dragState.lesson.teacher_id);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    return;
  }

  // Student DnD
  if (studentDragState) {
    const banner = document.getElementById('student-drag-banner');
    banner.style.left = `${e.clientX + 12}px`; banner.style.top = `${e.clientY - 12}px`;
    clearDragHighlight();
    const cell = e.target.closest('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + studentDragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = hasAnyConflict(td, tr, ts, end, null, studentDragState.teacherId);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    // Also highlight if on a lesson card
    const cardEl = e.target.closest('.lesson-card');
    document.querySelectorAll('.lesson-card-drop-target').forEach(c => c.classList.remove('lesson-card-drop-target'));
    if (cardEl) cardEl.classList.add('lesson-card-drop-target');
    return;
  }

  // Placing mode (lesson or student)
  if (state.placingLesson || state.placingStudent || state.placingTruant) {
    clearDragHighlight();
    document.querySelectorAll('.lesson-card-drop-target').forEach(c => c.classList.remove('lesson-card-drop-target'));
    const cardEl = e.target.closest('.lesson-card');
    if (cardEl && (state.placingStudent || state.placingTruant)) {
      cardEl.classList.add('lesson-card-drop-target');
    }
    const cell = e.target.closest('.grid-cell');
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
    } else {
      openLessonModal({ day: pc.day, room: pc.room, slotFrom: pc.slot, slotTo: pc.slot + 1 });
    }
    return;
  }

  // Drag lesson
  if (dragState) {
    if (!dragStarted) { dragState = null; dragMouseStart = null; return; }
    document.querySelectorAll('.week-tab-drop').forEach(t => t.classList.remove('week-tab-drop'));
    const nwTab = getNextWeekTab();
    if (nwTab) {
      const r = nwTab.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        startNextWeekTransfer(dragState.lesson);
        document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
        dragState = null; dragMouseStart = null; dragStarted = false; return;
      }
    }
    clearDragHighlight();
    document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
    const cell = e.target.closest('.grid-cell');
    if (cell) finishDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    dragState = null; dragMouseStart = null; dragStarted = false;
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
      return;
    }
    openLessonModal({ day: selStart.day, room: selStart.room, slotFrom: sf, slotTo: st });
  }
}

// ===== DRAG HIGHLIGHTS =====
function clearDragHighlight() {
  document.querySelectorAll('.grid-cell-drop-ok, .grid-cell-conflict').forEach(c => c.classList.remove('grid-cell-drop-ok', 'grid-cell-conflict'));
}

// ===== DRAG & DROP =====
async function finishDrag(targetDay, targetRoom, targetSlot) {
  const lesson = dragState.lesson; const end = targetSlot + dragState.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  const ct = await checkConflictServer(targetDay, targetRoom, targetSlot, end, lesson.id, lesson.teacher_id);
  if (ct) { conflictToast(ct); return; }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[targetDay];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(targetSlot * SLOT_MINUTES / 60), (targetSlot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  const updateData = {
    room: targetRoom,
    start_time: sTime.toISOString(),
    end_time: eTime.toISOString(),
    week_start: formatDate(state.currentWeekStart)
  };

  const { error } = await db.from('lessons').update(updateData).eq('id', lesson.id);
  if (error) { showToast('Ошибка переноса', 'error'); return; }
  showToast('Занятие перенесено', 'success'); await loadLessons();
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

function showPlacingBanner() {
  let b = document.getElementById('placing-banner');
  if (!b) {
    b = document.createElement('div'); b.id = 'placing-banner';
    b.innerHTML = '<span>Выберите место для занятия</span><button id="btn-cancel-placing">Отмена</button>';
    document.getElementById('screen-schedule').insertBefore(b, document.getElementById('schedule-grid'));
    document.getElementById('btn-cancel-placing').addEventListener('click', cancelPlacing);
  }
  b.style.display = 'flex';
}
function hidePlacingBanner() { const b = document.getElementById('placing-banner'); if (b) b.style.display = 'none'; }

function cancelPlacing() {
  const origOffset = state.placingLesson?.originalWeekOffset ?? state.placingStudent?.originalWeekOffset;
  state.placingLesson = null; state.placingStudent = null; state.placingTruant = null;
  hidePlacingBanner(); clearDragHighlight();
  document.querySelectorAll('.lesson-card-drop-target, .grid-cell-available').forEach(c => c.classList.remove('lesson-card-drop-target', 'grid-cell-available'));
  if (origOffset !== undefined) {
    currentWeekOffset = origOffset;
    state.currentWeekStart = getWeekByOffset(origOffset);
    updateWeekLabel(); updateWeekTabs(); renderGrid(); loadLessons();
  }
}

async function placeTransferredLesson(day, room, slot) {
  const p = state.placingLesson; if (!p) return;
  const end = slot + p.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  const ct = await checkConflictServer(day, room, slot, end, null, p.teacherId);
  if (ct) { conflictToast(ct); return; }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: p.teacherId, room, week_start: formatDate(state.currentWeekStart),
    start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active', transferred_from_id: p.originalLessonId
  }).select().single();
  if (error) { showToast('Ошибка переноса', 'error'); return; }
  if (p.studentIds.length > 0) await db.from('lesson_students').insert(p.studentIds.map(sid => ({ lesson_id: data.id, student_id: sid })));
  await db.from('lessons').update({ status: 'transferred' }).eq('id', p.originalLessonId);
  state.placingLesson = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Занятие перенесено на следующую неделю', 'success'); await loadLessons();
}

async function placeTransferredStudent(day, room, slot) {
  const p = state.placingStudent; if (!p) return;
  const end = slot + p.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  const ct = await checkConflictServer(day, room, slot, end, null, p.teacherId);
  if (ct) { conflictToast(ct); return; }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: p.teacherId, room, week_start: formatDate(state.currentWeekStart),
    start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
  }).select().single();
  if (error) { showToast('Ошибка', 'error'); return; }
  await db.from('lesson_students').insert({ lesson_id: data.id, student_id: p.studentId });
  await db.from('lesson_students').delete().eq('lesson_id', p.lessonId).eq('student_id', p.studentId);
  // Record transfer (not cancellation) - won't show in truants
  const origLesson = state.lessons.find(l => l.id === p.lessonId);
  const origWs = p.originalWeekStart || formatDate(getMonday(new Date()));
  await db.from('cancellations').insert({
    student_id: p.studentId, teacher_id: p.teacherId, week_start: origWs, status: 'transferred',
    lesson_start_time: origLesson?.start_time, lesson_day: origLesson ? new Date(origLesson.start_time).getDay() : null
  });
  await cleanEmptyLesson(p.lessonId);
  state.placingStudent = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик перенесён на следующую неделю', 'success'); await loadLessons();
}

async function placeTransferredStudentOnLesson(targetLessonId) {
  const p = state.placingStudent; if (!p) return;
  const tl = state.lessons.find(l => l.id === targetLessonId);
  if (!tl) { showToast('Занятие не найдено', 'error'); return; }
  if (tl.teacher_id !== p.teacherId) { showToast('Можно добавить только к своему преподавателю', 'error'); return; }
  if ((tl.lesson_students?.length || 0) >= getMaxGroup(tl.teacher_id)) { showToast(`Максимум ${getMaxGroup(tl.teacher_id)} учеников`, 'error'); return; }

  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: p.studentId });
  await db.from('lesson_students').delete().eq('lesson_id', p.lessonId).eq('student_id', p.studentId);
  await cleanEmptyLesson(p.lessonId);
  state.placingStudent = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик добавлен к занятию', 'success'); await loadLessons();
}

// ===== STUDENT DND =====
function startStudentDrag(studentData, lessonId, teacherId, lessonSlotLength) {
  closeLessonModal();
  studentDragState = {
    studentId: studentData.id, studentName: `${studentData.first_name} ${studentData.last_name}`,
    lessonId, teacherId, slotLength: lessonSlotLength
  };
  const banner = document.getElementById('student-drag-banner');
  banner.textContent = `${studentData.first_name} ${studentData.last_name}`;
  banner.style.display = 'block';
  document.body.style.cursor = 'grabbing';
}

async function placeStudentOnCell(day, room, slot) {
  const s = studentDragState; if (!s) return;
  const end = slot + s.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); cancelStudentDrag(); return; }
  const ct = await checkConflictServer(day, room, slot, end, null, s.teacherId);
  if (ct) { conflictToast(ct, cancelStudentDrag); return; }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: s.teacherId, room, week_start: formatDate(state.currentWeekStart),
    start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
  }).select().single();
  if (error) { showToast('Ошибка', 'error'); cancelStudentDrag(); return; }
  await db.from('lesson_students').insert({ lesson_id: data.id, student_id: s.studentId });
  await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);
  await cleanEmptyLesson(s.lessonId);
  cancelStudentDrag();
  showToast('Ученик перенесён', 'success'); await loadLessons();
}

async function placeStudentOnLesson(targetLessonId) {
  const s = studentDragState; if (!s) return;
  if (targetLessonId === s.lessonId) { cancelStudentDrag(); return; }
  const tl = state.lessons.find(l => l.id === targetLessonId);
  if (!tl) { cancelStudentDrag(); return; }
  if (tl.teacher_id !== s.teacherId) { showToast('Можно добавить только к своему преподавателю', 'error'); cancelStudentDrag(); return; }

  // Fetch student data to check individual flag
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

  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: s.studentId });
  await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);
  await cleanEmptyLesson(s.lessonId);
  cancelStudentDrag();
  showToast('Ученик добавлен к занятию', 'success'); await loadLessons();
}

async function cleanEmptyLesson(lessonId) {
  const { data } = await db.from('lesson_students').select('student_id').eq('lesson_id', lessonId);
  if (!data || data.length === 0) {
    await db.from('lessons').delete().eq('id', lessonId);
  }
}

function cancelStudentDrag() {
  studentDragState = null;
  document.getElementById('student-drag-banner').style.display = 'none';
  document.body.style.cursor = '';
  clearDragHighlight();
  document.querySelectorAll('.lesson-card-drop-target').forEach(c => c.classList.remove('lesson-card-drop-target'));
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
        const name = `${s.student.first_name} ${s.student.last_name}`;
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
  for (let s = sf; s <= st; s++) {
    const c = grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${s}"]`);
    if (c) c.classList.add('grid-cell-selected');
  }
  const last = grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${st}"]`);
  if (last && count > 0) {
    durationLabel = document.createElement('div');
    durationLabel.className = 'selection-duration-label';
    durationLabel.textContent = slotsToLabel(count);
    const rect = last.getBoundingClientRect(); const gr = grid.getBoundingClientRect();
    durationLabel.style.left = `${rect.left + rect.width / 2 - gr.left}px`;
    durationLabel.style.top = `${rect.bottom - gr.top + 4}px`;
    grid.appendChild(durationLabel);
  }
}

function clearSelectionHighlight() { document.querySelectorAll('.grid-cell-selected').forEach(c => c.classList.remove('grid-cell-selected')); }
function removeDurationLabel() { if (durationLabel) { durationLabel.remove(); durationLabel = null; } }

// ===== LESSONS CRUD =====
async function loadLessons() {
  const ws = formatDate(state.currentWeekStart);
  const { data, error } = await db.from('lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name, max_group_size), lesson_students(student_id, student:students(first_name, last_name, subject, is_individual, is_online, price_type)), original_start_time, original_end_time, transferred_from_id')
    .eq('week_start', ws).eq('status', 'active');
  if (error) { showToast('Ошибка загрузки', 'error'); return; }
  state.lessons = (data || []).filter(l => l.lesson_students?.length > 0 && l.room !== 0);
  const emptyIds = (data || []).filter(l => !l.lesson_students?.length).map(l => l.id);
  if (emptyIds.length > 0) db.from('lessons').delete().in('id', emptyIds);
  if (!recurringByStudent) await loadRecurringByStudent();
  renderLessons();
  const currentMonday = getMonday(new Date());
  if (formatDate(state.currentWeekStart) === formatDate(currentMonday)) {
    if (typeof computeAndSyncCancellations === 'function') computeAndSyncCancellations();
  }
}

function buildModalTitle(di, room, sf, st) { return `${DAYS_FULL[di]} · ${ROOM_FULL[room - 1]} · ${slotToTime(sf)}–${slotToTime(st)}`; }

async function loadTeacherStudentsForModal(tid) {
  const { data } = await db.from('students').select('id, first_name, last_name, subject, is_individual, is_online, price_type').eq('teacher_id', tid).order('first_name');
  const seen = new Set();
  allTeacherStudents = (data || []).filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });

  // Load current-week lesson status for each student
  const currentWs = formatDate(getMonday(new Date()));
  const sids = allTeacherStudents.map(s => s.id);
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
    .select('id, student_id, week_start, status, lesson_start_time, lesson_day, recurring_lesson:recurring_lessons(start_time, day_of_week)')
    .eq('teacher_id', tid).in('status', ['pending', 'transferred'])
    .gte('week_start', formatDate(threeWeeksAgo));

  studentCancellations = {};
  (cancellations || []).forEach(c => {
    if (!studentCancellations[c.student_id]) studentCancellations[c.student_id] = [];
    studentCancellations[c.student_id].push(c);
  });
}

function openLessonModal(sel) {
  document.getElementById('lesson-modal-title').textContent = buildModalTitle(sel.day, sel.room, sel.slotFrom, sel.slotTo);
  document.getElementById('btn-delete-lesson').style.display = 'none';
  document.getElementById('btn-save-lesson').style.display = 'block';
  document.getElementById('lesson-student-search').parentElement.style.display = 'block';
  document.getElementById('lesson-current-students').innerHTML = '';
  document.getElementById('lesson-current-students').style.display = 'none';
  state.lessonModal = { mode: 'create', day: sel.day, room: sel.room, slotFrom: sel.slotFrom, slotTo: sel.slotTo, selectedIds: new Set() };
  loadTeacherStudentsForModal(state.user.id).then(() => {
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
    document.getElementById('lesson-student-search').focus();
  });
}

function openEditLessonModal(lesson) {
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
  state.lessonModal = { mode: 'edit', lessonId: lesson.id, teacherId: lesson.teacher_id, day: di, room: lesson.room, slotFrom: ss, slotTo: es, selectedIds };
  loadTeacherStudentsForModal(lesson.teacher_id).then(() => {
    renderCurrentStudents();
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
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
  const sl = (s) => s || '';
  ct.innerHTML = `<label class="lesson-label">Текущие ученики</label>` + selected.map(s => {
    const cancelBtn = canEdit && (m.mode === 'edit') ? `<button class="cs-cancel" data-student-id="${s.id}" title="Отменить ученика">✕</button>` : '';
    return `<div class="current-student-row" data-student-id="${s.id}">
      ${canEdit && (m.mode === 'edit' || m.mode === 'rec-edit') ? '<span class="cs-drag-handle" title="Перенести">⠿</span>' : ''}
      <span class="cs-name">${s.first_name} ${s.last_name} <span class="lesson-student-subject">${sl(s.subject)}</span>${s.is_online ? '<span class="lesson-online-badge">Онл.</span>' : ''}</span>
      ${cancelBtn}
      ${canEdit ? `<button class="cs-remove" data-student-id="${s.id}" title="Убрать из списка"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
    </div>`;
  }).join('');

  if (canEdit) {
    ct.querySelectorAll('.cs-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        m.selectedIds.delete(btn.dataset.studentId);
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
        const lessonWeekStart = lesson?.week_start;
        const lessonDay = m.day;
        showConfirm(`Отменить ${s?.first_name || ''} ${s?.last_name || ''}?`, async () => {
          await db.from('lesson_students').delete().eq('lesson_id', lessonId).eq('student_id', sid);
          const ws = lessonWeekStart || formatDate(getMonday(new Date()));
          await db.from('cancellations').insert({ student_id: sid, teacher_id: teacherId, week_start: ws, status: 'pending', lesson_start_time: lessonStartTime, lesson_day: lessonDay });
          m.selectedIds.delete(sid);
          const isEmpty = m.selectedIds.size === 0;
          await cleanEmptyLesson(lessonId);
          await loadLessons();
          if (isEmpty) { closeLessonModal(); showToast('Ученик отменён, занятие удалено', 'success'); return; }
          await loadTeacherStudentsForModal(teacherId);
          renderCurrentStudents();
          renderLessonStudentsList(document.getElementById('lesson-student-search').value.trim());
          showToast('Ученик отменён', 'success');
        }, 'Отменить');
      });
    });
    if (m.mode === 'edit' || m.mode === 'rec-edit') {
      ct.querySelectorAll('.cs-drag-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault(); e.stopPropagation();
          const row = handle.closest('.current-student-row');
          const sid = row.dataset.studentId;
          const sd = allTeacherStudents.find(s => s.id === sid);
          if (!sd) return;
          const lessonSlots = m.slotTo - m.slotFrom;
          startStudentDrag(sd, m.lessonId, m.teacherId, lessonSlots);
        });
      });
    }
  }
}

function closeLessonModal() {
  document.getElementById('lesson-overlay').classList.remove('active');
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

  // Truant students (only pending, not transferred)
  const truantIds = new Set();
  const pendingCancels = {};
  Object.entries(studentCancellations).forEach(([sid, cancels]) => {
    const pending = cancels.filter(c => c.status === 'pending');
    if (pending.length > 0) { truantIds.add(sid); pendingCancels[sid] = pending; }
  });

  let allStudents = allTeacherStudents;
  if (search) allStudents = allStudents.filter(s => s.first_name.toLowerCase().includes(search) || s.last_name.toLowerCase().includes(search));

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
      const cancels = pendingCancels[s.id] || [];
      const dateBadges = cancels.map(c => {
        const timeStr = getCancelTimeStr(c);
        return timeStr ? `<span class="modal-truant-date">${timeStr}</span>` : '';
      }).filter(Boolean).join('');
      html += `<label class="lesson-student-row truant-row${ch ? ' checked' : ''}"><span class="lesson-student-name">${s.first_name} ${s.last_name}${indBadge}${onlBadge}${dateBadges}</span>${canEdit ? `<input type="checkbox" class="lesson-checkbox" data-id="${s.id}" data-individual="${s.is_individual || false}" ${ch ? 'checked' : ''}>` : (ch ? '<span class="lesson-check-mark">✓</span>' : '')}</label>`;
    });
    html += '</div>';
  }

  // Regular students
  regularStudents.forEach(s => {
    const ch = m.selectedIds.has(s.id);
    const indBadge = s.is_individual ? '<span class="lesson-ind-badge">Инд.</span>' : '';
    const onlBadge = s.is_online ? '<span class="lesson-online-badge">Онл.</span>' : '';
    const weekBadge = buildStudentWeekBadge(s.id);
    html += `<label class="lesson-student-row${ch ? ' checked' : ''}"><span class="lesson-student-name">${s.first_name} ${s.last_name}${indBadge}${onlBadge}${weekBadge}</span>${canEdit ? `<input type="checkbox" class="lesson-checkbox" data-id="${s.id}" data-individual="${s.is_individual || false}" ${ch ? 'checked' : ''}>` : (ch ? '<span class="lesson-check-mark">✓</span>' : '')}</label>`;
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
          m.selectedIds.add(id);
        } else { m.selectedIds.delete(id); }
        cb.closest('.lesson-student-row').classList.toggle('checked', cb.checked);
        renderCurrentStudents();
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

  const dates = getWeekDates(state.currentWeekStart); const date = dates[m.day]; const ws = formatDate(state.currentWeekStart);
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(m.slotFrom * SLOT_MINUTES / 60), (m.slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(m.slotTo * SLOT_MINUTES / 60), (m.slotTo * SLOT_MINUTES) % 60, 0, 0);
  const sids = Array.from(m.selectedIds);

  if (m.mode === 'create' || m.mode === 'rec-create') {
    const { data, error } = await db.from('lessons').insert({ teacher_id: state.user.id, room: m.room, week_start: ws, start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active' }).select().single();
    if (error) { showToast('Ошибка', 'error'); btn.disabled = false; return; }
    if (sids.length > 0) await db.from('lesson_students').insert(sids.map(sid => ({ lesson_id: data.id, student_id: sid })));
    showToast('Занятие создано', 'success');
  } else {
    const { error } = await db.from('lessons').update({ room: m.room, start_time: sTime.toISOString(), end_time: eTime.toISOString() }).eq('id', m.lessonId);
    if (error) { showToast('Ошибка', 'error'); btn.disabled = false; return; }
    await db.from('lesson_students').delete().eq('lesson_id', m.lessonId);
    if (sids.length > 0) await db.from('lesson_students').insert(sids.map(sid => ({ lesson_id: m.lessonId, student_id: sid })));
    showToast('Занятие обновлено', 'success');
  }
  btn.disabled = false; closeLessonModal(); await loadLessons();
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
      // Look up the transferred-origin cancellations (status='transferred') for these students + teacher
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
  const lessonWeekStart = lesson?.week_start;
  closeLessonModal();
  showConfirm('Отменить занятие? Все ученики будут отменены.', async () => {
    await db.from('lessons').update({ status: 'cancelled' }).eq('id', lid);
    const ws = lessonWeekStart || formatDate(getMonday(new Date()));
    if (studentIds.length > 0) {
      await db.from('cancellations').insert(
        studentIds.map(sid => ({ student_id: sid, teacher_id: teacherId, week_start: ws, status: 'pending', lesson_start_time: lessonStartTime, lesson_day: lessonDay }))
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
  if (state.placingLesson || state.placingStudent || state.placingTruant) { showToast('Сначала разместите или отмените перенос', 'error'); return; }
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

  document.querySelectorAll('.week-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const offset = +tab.dataset.offset;
      if (dragState && dragStarted && offset === currentWeekOffset + 1) {
        startNextWeekTransfer(dragState.lesson);
        document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
        document.getElementById('schedule-grid')?.classList.remove('grid-dragging');
        dragState = null; dragMouseStart = null; dragStarted = false;
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
          const conflict = hasAnyConflict(td, tr, ts, end, dragState.lesson.id, dragState.lesson.teacher_id);
          const grid = document.getElementById('schedule-grid');
          for (let s = ts; s < end; s++) {
            const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
            if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
          }
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
      document.querySelectorAll('.lesson-card-drop-target').forEach(c => c.classList.remove('lesson-card-drop-target'));
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cardEl = el?.closest?.('.lesson-card');
      const cell = el?.closest?.('.grid-cell');
      if (cardEl) cardEl.classList.add('lesson-card-drop-target');
      else if (cell) {
        const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
        const end = ts + studentDragState.slotLength;
        if (end <= TOTAL_SLOTS) {
          const grid = document.getElementById('schedule-grid');
          const conflict = hasAnyConflict(td, tr, ts, end, null, studentDragState.teacherId);
          for (let s = ts; s < end; s++) {
            const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
            if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
          }
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
          dragState = null; dragMouseStart = null; dragStarted = false; return;
        }
      }
      clearDragHighlight();
      document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el?.closest?.('.grid-cell');
      if (cell) finishDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
      dragState = null; dragMouseStart = null; dragStarted = false;
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
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cardEl = el?.closest?.('.lesson-card');
      const cell = el?.closest?.('.grid-cell');
      if (cardEl) placeStudentOnLesson(cardEl.dataset.lessonId);
      else if (cell) placeStudentOnCell(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
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
