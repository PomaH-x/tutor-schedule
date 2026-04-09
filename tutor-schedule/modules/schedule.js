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
let dragState = null;
let dragMouseStart = null;
let dragStarted = false;
let resizeState = null;
let studentDragState = null;

function getWeekDates(mondayDate) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function updateWeekLabel() {
  const dates = getWeekDates(state.currentWeekStart);
  document.getElementById('current-week-label').textContent = `${formatDateShort(dates[0])} — ${formatDateShort(dates[6])}`;
}

function colForDayRoom(di, room) { return di * 3 + room + 1; }
function rowForSlot(slot) { return slot + 3; }

function slotToTime(slot) {
  const m = START_HOUR * 60 + slot * SLOT_MINUTES;
  return `${Math.floor(m / 60)}:${(m % 60).toString().padStart(2, '0')}`;
}

function slotsToLabel(count) {
  const mins = count * SLOT_MINUTES;
  if (mins < 60) return `${mins} мин`;
  const h = mins / 60;
  if (h === Math.floor(h)) return `${h} ч`;
  return `${h.toFixed(1).replace('.', ',')} ч`;
}

function durationToLabel(mins) {
  if (mins < 60) return `${mins} мин`;
  const h = mins / 60;
  if (h === Math.floor(h)) return `${h} ч`;
  return `${h.toFixed(1).replace('.', ',')} ч`;
}

// Conflict: different teacher in same room+time = conflict. Same teacher = allowed (overlap).
function hasLocalConflict(day, room, slotFrom, slotTo, excludeId, teacherId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day];
  if (!date) return true;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
    if (l.id === excludeId) return false;
    if (l.room !== room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lStartMin = ls.getHours() * 60 + ls.getMinutes();
    const lEndMin = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    if (startMin >= lEndMin || endMin <= lStartMin) return false;
    if (teacherId && l.teacher_id === teacherId) return false;
    return true;
  });
}

// Also check: teacher can't be in two rooms at same time
function hasTeacherTimeConflict(day, slotFrom, slotTo, teacherId, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day];
  if (!date) return false;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
    if (l.id === excludeId) return false;
    if (l.teacher_id !== teacherId) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lStartMin = ls.getHours() * 60 + ls.getMinutes();
    const lEndMin = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    // Same room overlap is OK for same teacher
    // Different room overlap is NOT OK
    if (l.room === arguments[5]) return false; // skip same room
    return startMin < lEndMin && endMin > lStartMin;
  });
}

function hasAnyConflict(day, room, slotFrom, slotTo, excludeId, teacherId) {
  return hasLocalConflict(day, room, slotFrom, slotTo, excludeId, teacherId) ||
    hasTeacherTimeConflictDiffRoom(day, room, slotFrom, slotTo, teacherId, excludeId);
}

function hasTeacherTimeConflictDiffRoom(day, room, slotFrom, slotTo, teacherId, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day];
  if (!date) return false;
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return state.lessons.some(l => {
    if (l.id === excludeId) return false;
    if (l.teacher_id !== teacherId) return false;
    if (l.room === room) return false;
    const ls = new Date(l.start_time);
    if (ls.getDate() !== date.getDate() || ls.getMonth() !== date.getMonth() || ls.getFullYear() !== date.getFullYear()) return false;
    const lStartMin = ls.getHours() * 60 + ls.getMinutes();
    const lEndMin = new Date(l.end_time).getHours() * 60 + new Date(l.end_time).getMinutes();
    return startMin < lEndMin && endMin > lStartMin;
  });
}

async function checkConflictServer(day, room, slotFrom, slotTo, excludeId, teacherId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day];
  const weekStart = formatDate(state.currentWeekStart);
  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(slotFrom * SLOT_MINUTES / 60), (slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(slotTo * SLOT_MINUTES / 60), (slotTo * SLOT_MINUTES) % 60, 0, 0);

  // Check room conflict (different teacher)
  let q = db.from('lessons').select('id, teacher_id')
    .eq('week_start', weekStart).eq('room', room).eq('status', 'active')
    .lt('start_time', endTime.toISOString()).gt('end_time', startTime.toISOString());
  if (excludeId) q = q.neq('id', excludeId);
  const { data: roomData } = await q;
  const roomConflict = (roomData || []).some(l => l.teacher_id !== teacherId);

  // Check teacher in different room
  let q2 = db.from('lessons').select('id')
    .eq('week_start', weekStart).eq('teacher_id', teacherId).neq('room', room).eq('status', 'active')
    .lt('start_time', endTime.toISOString()).gt('end_time', startTime.toISOString());
  if (excludeId) q2 = q2.neq('id', excludeId);
  const { data: teacherData } = await q2;

  if (roomConflict) return 'room';
  if (teacherData && teacherData.length > 0) return 'teacher';
  return null;
}

// ===== GRID RENDER =====

function renderGrid() {
  const grid = document.getElementById('schedule-grid');
  grid.innerHTML = '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = getWeekDates(state.currentWeekStart);

  grid.style.gridTemplateColumns = '50px repeat(21, 1fr)';
  grid.style.gridTemplateRows = `40px 24px repeat(${TOTAL_SLOTS}, 28px)`;

  const corner = document.createElement('div');
  corner.className = 'grid-corner';
  corner.style.gridRow = '1 / 3'; corner.style.gridColumn = '1';
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
      rl.style.gridColumn = `${colForDayRoom(i, r + 1)}`; rl.style.gridRow = '2';
      rl.textContent = ROOM_LABELS[r];
      grid.appendChild(rl);
    }
  });

  for (let slot = 0; slot <= TOTAL_SLOTS; slot++) {
    const hour = START_HOUR + Math.floor(slot / 2);
    const min = (slot % 2) * 30;
    const row = rowForSlot(slot);
    const tc = document.createElement('div');
    tc.className = 'grid-time'; tc.dataset.slot = slot;
    tc.textContent = `${hour}:${min.toString().padStart(2, '0')}`;
    tc.style.gridRow = row; tc.style.gridColumn = '1';
    grid.appendChild(tc);
    if (slot === TOTAL_SLOTS) break;
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
  initGridInteractions(grid);
  renderLessons();
  renderNowTime();
  if (state.placingLesson) showPlacingBanner();
}

// ===== LESSONS RENDER (with overlap) =====

function renderLessons() {
  document.querySelectorAll('.lesson-card').forEach(el => el.remove());
  const grid = document.getElementById('schedule-grid');
  const dates = getWeekDates(state.currentWeekStart);

  // Group by room+day for overlap detection
  const groups = {};
  state.lessons.forEach(lesson => {
    const start = new Date(lesson.start_time);
    const dayIndex = dates.findIndex(d => d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth() && d.getDate() === start.getDate());
    if (dayIndex === -1) return;
    const key = `${dayIndex}-${lesson.room}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ ...lesson, _dayIndex: dayIndex });
  });

  Object.values(groups).forEach(group => {
    group.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    // Assign overlap index
    group.forEach((lesson, i) => {
      const start = new Date(lesson.start_time);
      const end = new Date(lesson.end_time);
      let overlapCount = 0;
      for (let j = 0; j < i; j++) {
        const pEnd = new Date(group[j].end_time);
        if (start < pEnd) overlapCount++;
      }
      lesson._overlapOffset = overlapCount;
    });

    group.forEach(lesson => {
      const start = new Date(lesson.start_time);
      const end = new Date(lesson.end_time);
      const startSlot = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
      const endSlot = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;

      const card = document.createElement('div');
      card.className = 'lesson-card';
      card.dataset.lessonId = lesson.id;
      const color = lesson.teacher?.color || '#6c5ce7';
      card.style.background = color + '22';
      card.style.borderColor = color + '55';
      card.style.color = color;
      card.style.gridRow = `${rowForSlot(startSlot)} / ${rowForSlot(endSlot)}`;
      card.style.gridColumn = colForDayRoom(lesson._dayIndex, lesson.room);

      if (lesson._overlapOffset > 0) {
        card.style.marginLeft = `${lesson._overlapOffset * 4}px`;
        card.style.zIndex = 2 + lesson._overlapOffset;
        card.style.borderWidth = '2px';
      }

      const shortName = (lesson.teacher?.short_name || '??').replace(/\./g, '');
      const studentCount = lesson.lesson_students?.length || 0;
      const canDrag = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;

      card.innerHTML = `${canDrag ? '<div class="lc-drag-handle" title="Перетащить">⠿</div>' : ''}<div class="lc-teacher">${shortName}</div><div class="lc-count">${studentCount}<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>${canDrag ? '<div class="lc-resize"></div>' : ''}`;
      grid.appendChild(card);
    });
  });
}

// ===== GRID INTERACTIONS =====

function initGridInteractions(grid) {
  grid.addEventListener('mousedown', onGridMouseDown);
  grid.addEventListener('mousemove', onGridMouseMove);
  grid.addEventListener('mouseup', onGridMouseUp);
  grid.addEventListener('mouseleave', onGridMouseLeave);
}

function onGridMouseDown(e) {
  if (state.profile.role === 'student') return;

  // Student DnD placement
  if (studentDragState) {
    const cell = e.target.closest('.grid-cell');
    const card = e.target.closest('.lesson-card');
    if (card && !cell) {
      placeStudentOnLesson(card.dataset.lessonId);
    } else if (cell) {
      placeStudentOnCell(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    }
    e.preventDefault();
    return;
  }

  // Resize
  const handle = e.target.closest('.lc-resize');
  if (handle) {
    e.preventDefault(); e.stopPropagation();
    const card = handle.closest('.lesson-card');
    const lesson = state.lessons.find(l => l.id === card.dataset.lessonId);
    if (!lesson) return;
    if (state.profile.role !== 'admin' && lesson.teacher_id !== state.user.id) return;
    const et = new Date(lesson.end_time);
    resizeState = { lesson, originalEndSlot: (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES, currentEndSlot: (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES };
    return;
  }

  // Drag handle
  const dragHandle = e.target.closest('.lc-drag-handle');
  if (dragHandle) {
    e.preventDefault();
    const card = dragHandle.closest('.lesson-card');
    const lesson = state.lessons.find(l => l.id === card.dataset.lessonId);
    if (!lesson) return;
    const st = new Date(lesson.start_time); const et = new Date(lesson.end_time);
    const startSlot = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    const endSlot = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    dragState = { lesson, slotLength: endSlot - startSlot, startSlot };
    dragMouseStart = { x: e.clientX, y: e.clientY };
    dragStarted = false;
    return;
  }

  // Click on card (not on handle) = edit
  const card = e.target.closest('.lesson-card');
  if (card) {
    const lesson = state.lessons.find(l => l.id === card.dataset.lessonId);
    if (lesson) openEditLessonModal(lesson);
    return;
  }

  // Placing lesson
  if (state.placingLesson) {
    const cell = e.target.closest('.grid-cell');
    if (cell) { e.preventDefault(); placeTransferredLesson(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot); }
    return;
  }

  // Selection
  const cell = e.target.closest('.grid-cell');
  if (!cell) return;
  selecting = true;
  selStart = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
  selEnd = { ...selStart };
  updateSelectionHighlight();
  e.preventDefault();
}

function onGridMouseMove(e) {
  const grid = document.getElementById('schedule-grid');

  // Resize
  if (resizeState) {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    const slot = +cell.dataset.slot + 1;
    const st = new Date(resizeState.lesson.start_time);
    const startSlot = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    if (slot <= startSlot || slot > TOTAL_SLOTS) return;
    resizeState.currentEndSlot = slot;
    clearDragHighlight();
    const dates = getWeekDates(state.currentWeekStart);
    const ls = new Date(resizeState.lesson.start_time);
    const dayIndex = dates.findIndex(d => d.getDate() === ls.getDate() && d.getMonth() === ls.getMonth() && d.getFullYear() === ls.getFullYear());
    const room = resizeState.lesson.room;
    const tid = resizeState.lesson.teacher_id;
    const conflict = hasAnyConflict(dayIndex, room, startSlot, slot, resizeState.lesson.id, tid);
    for (let s = startSlot; s < slot; s++) {
      const c = grid.querySelector(`.grid-cell[data-day="${dayIndex}"][data-room="${room}"][data-slot="${s}"]`);
      if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
    }
    return;
  }

  // Drag
  if (dragState) {
    if (!dragStarted) {
      const dx = e.clientX - dragMouseStart.x; const dy = e.clientY - dragMouseStart.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      dragStarted = true;
      const c = grid.querySelector(`.lesson-card[data-lesson-id="${dragState.lesson.id}"]`);
      if (c) c.classList.add('lesson-card-dragging');
      removeCellTooltip();
    }
    const cell = e.target.closest('.grid-cell');
    clearDragHighlight();
    if (!cell) {
      // Check if hovering next-week arrow
      const btn = document.getElementById('btn-next-week');
      if (btn) {
        const rect = btn.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          btn.classList.add('week-nav-hover');
        } else {
          btn.classList.remove('week-nav-hover');
        }
      }
      return;
    }
    document.getElementById('btn-next-week')?.classList.remove('week-nav-hover');
    const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
    const endSlot = ts + dragState.slotLength;
    if (endSlot > TOTAL_SLOTS) return;
    const tid = dragState.lesson.teacher_id;
    const conflict = hasAnyConflict(td, tr, ts, endSlot, dragState.lesson.id, tid);
    for (let s = ts; s < endSlot; s++) {
      const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
      if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
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
      const endSlot = ts + studentDragState.slotLength;
      if (endSlot <= TOTAL_SLOTS) {
        const conflict = hasAnyConflict(td, tr, ts, endSlot, null, studentDragState.teacherId);
        for (let s = ts; s < endSlot; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    return;
  }

  // Placing lesson
  if (state.placingLesson) {
    clearDragHighlight();
    const cell = e.target.closest('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const endSlot = ts + state.placingLesson.slotLength;
      if (endSlot <= TOTAL_SLOTS) {
        const conflict = hasAnyConflict(td, tr, ts, endSlot, null, state.placingLesson.teacherId);
        for (let s = ts; s < endSlot; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    return;
  }

  handleCellTooltip(e, grid);

  if (selecting) {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    if (+cell.dataset.day !== selStart.day || +cell.dataset.room !== selStart.room) return;
    selEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    updateSelectionHighlight();
  }
}

function onGridMouseUp(e) {
  if (resizeState) { finishResize(); return; }

  if (dragState) {
    if (!dragStarted) { dragState = null; dragMouseStart = null; return; }
    // Check if on next-week button
    const btn = document.getElementById('btn-next-week');
    btn?.classList.remove('week-nav-hover');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        startNextWeekTransfer(dragState.lesson);
        const c = document.querySelector('.lesson-card-dragging');
        if (c) c.classList.remove('lesson-card-dragging');
        dragState = null; dragMouseStart = null; dragStarted = false;
        return;
      }
    }
    const cell = e.target.closest('.grid-cell');
    clearDragHighlight();
    const c = document.querySelector('.lesson-card-dragging');
    if (c) c.classList.remove('lesson-card-dragging');
    if (cell) finishDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    dragState = null; dragMouseStart = null; dragStarted = false;
    return;
  }

  if (selecting) {
    selecting = false;
    clearSelectionHighlight();
    removeDurationLabel();
    if (!selStart) return;
    const slotFrom = Math.min(selStart.slot, selEnd.slot);
    const slotTo = Math.max(selStart.slot, selEnd.slot) + 1;
    openLessonModal({ day: selStart.day, room: selStart.room, slotFrom, slotTo });
  }
}

function onGridMouseLeave() {
  if (selecting) { selecting = false; clearSelectionHighlight(); removeDurationLabel(); }
  if (!dragState && !state.placingLesson && !studentDragState) removeCellTooltip();
  clearDragHighlight();
}

// ===== DRAG HIGHLIGHTS =====

function clearDragHighlight() {
  document.querySelectorAll('.grid-cell-drop-ok, .grid-cell-conflict').forEach(c => c.classList.remove('grid-cell-drop-ok', 'grid-cell-conflict'));
}

// ===== DRAG & DROP =====

async function finishDrag(targetDay, targetRoom, targetSlot) {
  const lesson = dragState.lesson;
  const endSlot = targetSlot + dragState.slotLength;
  if (endSlot > TOTAL_SLOTS) { showToast('Не помещается в сетку', 'error'); return; }

  const conflictType = await checkConflictServer(targetDay, targetRoom, targetSlot, endSlot, lesson.id, lesson.teacher_id);
  if (conflictType === 'room') { showToast('Кабинет занят другим преподавателем', 'error'); return; }
  if (conflictType === 'teacher') { showToast('Преподаватель занят в другом кабинете', 'error'); return; }

  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[targetDay];
  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(targetSlot * SLOT_MINUTES / 60), (targetSlot * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(endSlot * SLOT_MINUTES / 60), (endSlot * SLOT_MINUTES) % 60, 0, 0);

  const { error } = await db.from('lessons').update({
    room: targetRoom, start_time: startTime.toISOString(), end_time: endTime.toISOString(),
    week_start: formatDate(state.currentWeekStart)
  }).eq('id', lesson.id);
  if (error) { showToast('Ошибка переноса', 'error'); return; }
  showToast('Занятие перенесено', 'success');
  await loadLessons();
}

// ===== RESIZE =====

async function finishResize() {
  const r = resizeState; clearDragHighlight(); resizeState = null;
  if (!r || r.currentEndSlot === r.originalEndSlot) return;
  const lesson = r.lesson;
  const dates = getWeekDates(state.currentWeekStart);
  const ls = new Date(lesson.start_time);
  const dayIndex = dates.findIndex(d => d.getDate() === ls.getDate() && d.getMonth() === ls.getMonth());
  const startSlot = (ls.getHours() * 60 + ls.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;

  const conflictType = await checkConflictServer(dayIndex, lesson.room, startSlot, r.currentEndSlot, lesson.id, lesson.teacher_id);
  if (conflictType) { showToast('Конфликт: невозможно изменить длительность', 'error'); return; }

  const date = dates[dayIndex];
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(r.currentEndSlot * SLOT_MINUTES / 60), (r.currentEndSlot * SLOT_MINUTES) % 60, 0, 0);
  const { error } = await db.from('lessons').update({ end_time: endTime.toISOString() }).eq('id', lesson.id);
  if (error) { showToast('Ошибка изменения', 'error'); return; }
  showToast('Длительность изменена', 'success');
  await loadLessons();
}

// ===== NEXT WEEK TRANSFER =====

function startNextWeekTransfer(lesson) {
  const st = new Date(lesson.start_time); const et = new Date(lesson.end_time);
  const startSlot = (st.getHours() * 60 + st.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const endSlot = (et.getHours() * 60 + et.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  state.placingLesson = {
    originalLessonId: lesson.id, originalWeekStart: formatDate(state.currentWeekStart),
    teacherId: lesson.teacher_id, slotLength: endSlot - startSlot,
    studentIds: (lesson.lesson_students || []).map(ls => ls.student_id)
  };
  const nextWeek = new Date(state.currentWeekStart);
  nextWeek.setDate(nextWeek.getDate() + 7);
  state.currentWeekStart = nextWeek;
  updateWeekLabel(); renderGrid(); loadLessons();
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
  const orig = state.placingLesson?.originalWeekStart;
  state.placingLesson = null; hidePlacingBanner(); clearDragHighlight();
  if (orig) { state.currentWeekStart = new Date(orig); updateWeekLabel(); renderGrid(); loadLessons(); }
}

async function placeTransferredLesson(day, room, slot) {
  const p = state.placingLesson; if (!p) return;
  const endSlot = slot + p.slotLength;
  if (endSlot > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }

  const conflictType = await checkConflictServer(day, room, slot, endSlot, null, p.teacherId);
  if (conflictType) { showToast(conflictType === 'room' ? 'Кабинет занят' : 'Преподаватель занят', 'error'); return; }

  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; const weekStart = formatDate(state.currentWeekStart);
  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(endSlot * SLOT_MINUTES / 60), (endSlot * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: p.teacherId, room, week_start: weekStart,
    start_time: startTime.toISOString(), end_time: endTime.toISOString(),
    status: 'active', transferred_from_id: p.originalLessonId
  }).select().single();
  if (error) { showToast('Ошибка переноса', 'error'); return; }

  if (p.studentIds.length > 0) {
    await db.from('lesson_students').insert(p.studentIds.map(sid => ({ lesson_id: data.id, student_id: sid })));
  }
  await db.from('lessons').update({ status: 'transferred' }).eq('id', p.originalLessonId);

  state.placingLesson = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Занятие перенесено на следующую неделю', 'success');
  await loadLessons();
}

// ===== STUDENT DND =====

function startStudentDrag(studentData, lessonId, teacherId) {
  closeLessonModal();
  const slotLength = Math.ceil(studentData.duration / SLOT_MINUTES);
  studentDragState = {
    studentId: studentData.id, studentName: `${studentData.first_name} ${studentData.last_name}`,
    lessonId, teacherId, slotLength, duration: studentData.duration
  };
  const banner = document.getElementById('student-drag-banner');
  banner.textContent = `${studentData.first_name} ${studentData.last_name} · ${durationToLabel(studentData.duration)}`;
  banner.style.display = 'block';
  document.body.style.cursor = 'grabbing';
}

async function placeStudentOnCell(day, room, slot) {
  const s = studentDragState; if (!s) return;
  const endSlot = slot + s.slotLength;
  if (endSlot > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }

  const conflictType = await checkConflictServer(day, room, slot, endSlot, null, s.teacherId);
  if (conflictType === 'room') { showToast('Кабинет занят', 'error'); return; }
  if (conflictType === 'teacher') { showToast('Преподаватель занят', 'error'); return; }

  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day]; const weekStart = formatDate(state.currentWeekStart);
  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(endSlot * SLOT_MINUTES / 60), (endSlot * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: s.teacherId, room, week_start: weekStart,
    start_time: startTime.toISOString(), end_time: endTime.toISOString(), status: 'active'
  }).select().single();
  if (error) { showToast('Ошибка создания', 'error'); cancelStudentDrag(); return; }

  await db.from('lesson_students').insert({ lesson_id: data.id, student_id: s.studentId });
  await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);

  cancelStudentDrag();
  showToast('Ученик перенесён в новое занятие', 'success');
  await loadLessons();
}

async function placeStudentOnLesson(targetLessonId) {
  const s = studentDragState; if (!s) return;
  const targetLesson = state.lessons.find(l => l.id === targetLessonId);
  if (!targetLesson) { showToast('Занятие не найдено', 'error'); return; }
  if (targetLesson.teacher_id !== s.teacherId) { showToast('Можно добавить только к своему преподавателю', 'error'); return; }
  if ((targetLesson.lesson_students?.length || 0) >= 4) { showToast('Максимум 4 ученика', 'error'); return; }

  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: s.studentId });
  await db.from('lesson_students').delete().eq('lesson_id', s.lessonId).eq('student_id', s.studentId);

  cancelStudentDrag();
  showToast('Ученик добавлен к занятию', 'success');
  await loadLessons();
}

function cancelStudentDrag() {
  studentDragState = null;
  const banner = document.getElementById('student-drag-banner');
  banner.style.display = 'none';
  document.body.style.cursor = '';
  clearDragHighlight();
}

// ===== TOOLTIP & SELECTION =====

function handleCellTooltip(e, grid) {
  if (dragState || resizeState || state.placingLesson || studentDragState) return;
  const cell = e.target.closest('.grid-cell');
  if (!cell) { removeCellTooltip(); return; }
  const slot = +cell.dataset.slot; const room = +cell.dataset.room;
  const text = `${slotToTime(slot)} ${ROOM_FULL[room - 1]}`;
  if (!hoveredTooltip) { hoveredTooltip = document.createElement('div'); hoveredTooltip.className = 'cell-tooltip'; document.body.appendChild(hoveredTooltip); }
  hoveredTooltip.textContent = text;
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

function updateSelectionHighlight() {
  clearSelectionHighlight(); removeDurationLabel();
  if (!selStart || !selEnd) return;
  const grid = document.getElementById('schedule-grid');
  const slotFrom = Math.min(selStart.slot, selEnd.slot);
  const slotTo = Math.max(selStart.slot, selEnd.slot);
  const count = slotTo - slotFrom + 1;
  for (let s = slotFrom; s <= slotTo; s++) {
    const cell = grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${s}"]`);
    if (cell) cell.classList.add('grid-cell-selected');
  }
  // Duration label
  const lastCell = grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${slotTo}"]`);
  if (lastCell && count > 0) {
    durationLabel = document.createElement('div');
    durationLabel.className = 'selection-duration-label';
    durationLabel.textContent = slotsToLabel(count);
    const rect = lastCell.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    durationLabel.style.left = `${rect.left + rect.width / 2 - gridRect.left}px`;
    durationLabel.style.top = `${rect.bottom - gridRect.top + 4}px`;
    grid.appendChild(durationLabel);
  }
}

function clearSelectionHighlight() {
  document.querySelectorAll('.grid-cell-selected').forEach(c => c.classList.remove('grid-cell-selected'));
}

function removeDurationLabel() {
  if (durationLabel) { durationLabel.remove(); durationLabel = null; }
}

// ===== NOW TIME =====

function renderNowTime() {
  document.querySelectorAll('.grid-time-now').forEach(el => el.classList.remove('grid-time-now'));
  const now = new Date();
  const dates = getWeekDates(state.currentWeekStart);
  const ti = dates.findIndex(d => d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate());
  if (ti === -1) return;
  const nm = now.getHours() * 60 + now.getMinutes();
  if (nm < START_HOUR * 60 || nm > END_HOUR * 60) return;
  const slot = Math.floor((nm - START_HOUR * 60) / SLOT_MINUTES);
  const tc = document.getElementById('schedule-grid').querySelector(`.grid-time[data-slot="${slot}"]`);
  if (tc) { tc.textContent = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`; tc.classList.add('grid-time-now'); }
}

// ===== LESSONS CRUD =====

async function loadLessons() {
  const weekStart = formatDate(state.currentWeekStart);
  const { data, error } = await db.from('lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name), lesson_students(student_id, student:students(first_name, last_name, subject, lesson_duration))')
    .eq('week_start', weekStart).eq('status', 'active');
  if (error) { showToast('Ошибка загрузки', 'error'); return; }
  state.lessons = data || [];
  renderLessons();
}

function buildModalTitle(dayIndex, room, slotFrom, slotTo) {
  return `${DAYS_FULL[dayIndex]} · ${ROOM_FULL[room - 1]} · ${slotToTime(slotFrom)}–${slotToTime(slotTo)}`;
}

async function loadTeacherStudentsForModal(teacherId) {
  const { data } = await db.from('students').select('id, first_name, last_name, subject, lesson_duration').eq('teacher_id', teacherId).order('first_name');
  const seen = new Set();
  allTeacherStudents = (data || []).filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
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
  const dayIndex = dates.findIndex(d => d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth() && d.getDate() === start.getDate());
  const startSlot = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const endSlot = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;

  document.getElementById('lesson-modal-title').textContent = buildModalTitle(dayIndex, lesson.room, startSlot, endSlot);
  const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
  document.getElementById('btn-delete-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('btn-save-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('lesson-student-search').parentElement.style.display = canEdit ? 'block' : 'none';

  const selectedIds = new Set((lesson.lesson_students || []).map(ls => ls.student_id));

  state.lessonModal = { mode: 'edit', lessonId: lesson.id, teacherId: lesson.teacher_id,
    day: dayIndex, room: lesson.room, slotFrom: startSlot, slotTo: endSlot, selectedIds };

  loadTeacherStudentsForModal(lesson.teacher_id).then(() => {
    renderCurrentStudents(lesson);
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
  });
}

function renderCurrentStudents(lesson) {
  const container = document.getElementById('lesson-current-students');
  const students = (lesson.lesson_students || []).filter(ls => ls.student);
  const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;

  if (students.length === 0) { container.style.display = 'none'; container.innerHTML = ''; return; }
  container.style.display = 'block';
  const subjectLabel = (s) => s === 'math' ? 'Математика' : 'Информатика';

  container.innerHTML = `<label class="lesson-label">Текущие ученики</label>` + students.map(ls => {
    const s = ls.student;
    return `<div class="current-student-row" data-student-id="${ls.student_id}">
      ${canEdit ? '<span class="cs-drag-handle" title="Перенести ученика">⠿</span>' : ''}
      <span class="cs-name">${s.first_name} ${s.last_name} <span class="lesson-student-subject">· ${subjectLabel(s.subject)}</span></span>
      ${canEdit ? `<button class="cs-remove" data-student-id="${ls.student_id}" title="Убрать из занятия">×</button>` : ''}
    </div>`;
  }).join('');

  if (canEdit) {
    container.querySelectorAll('.cs-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.studentId;
        state.lessonModal.selectedIds.delete(sid);
        btn.closest('.current-student-row').remove();
        renderLessonStudentsList(document.getElementById('lesson-student-search').value.trim());
      });
    });

    container.querySelectorAll('.cs-drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const row = handle.closest('.current-student-row');
        const sid = row.dataset.studentId;
        const studentData = allTeacherStudents.find(s => s.id === sid);
        if (!studentData) return;
        startStudentDrag(studentData, state.lessonModal.lessonId, state.lessonModal.teacherId);
      });
    });
  }
}

function closeLessonModal() {
  document.getElementById('lesson-overlay').classList.remove('active');
  state.lessonModal = null; allTeacherStudents = [];
}

function renderLessonStudentsList(filter) {
  const list = document.getElementById('lesson-students-list');
  const m = state.lessonModal; if (!m) return;
  const search = filter.toLowerCase();
  let students = allTeacherStudents;
  if (search) students = students.filter(s => s.first_name.toLowerCase().includes(search) || s.last_name.toLowerCase().includes(search));
  if (students.length === 0) { list.innerHTML = '<div class="lesson-no-students">Нет учеников</div>'; return; }
  const subjectLabel = (s) => s === 'math' ? 'Математика' : 'Информатика';
  const canEdit = state.profile.role === 'admin' || (m.mode === 'create') || (m.teacherId === state.user.id);

  list.innerHTML = students.map(s => {
    const checked = m.selectedIds.has(s.id);
    return `<label class="lesson-student-row${checked ? ' checked' : ''}" data-id="${s.id}">
      <span class="lesson-student-name">${s.first_name} ${s.last_name} <span class="lesson-student-subject">· ${subjectLabel(s.subject)}</span></span>
      ${canEdit ? `<input type="checkbox" class="lesson-checkbox" data-id="${s.id}" ${checked ? 'checked' : ''}>` : (checked ? '<span class="lesson-check-mark">✓</span>' : '')}
    </label>`;
  }).join('');

  if (canEdit) {
    list.querySelectorAll('.lesson-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        if (cb.checked) { if (m.selectedIds.size >= 4) { cb.checked = false; showToast('Максимум 4 ученика', 'error'); return; } m.selectedIds.add(id); }
        else { m.selectedIds.delete(id); }
        cb.closest('.lesson-student-row').classList.toggle('checked', cb.checked);
      });
    });
  }
}

async function saveLesson() {
  const m = state.lessonModal; if (!m) return;
  const btn = document.getElementById('btn-save-lesson'); btn.disabled = true;
  if (m.selectedIds.size === 0) { showToast('Добавьте хотя бы одного ученика', 'error'); btn.disabled = false; return; }

  const teacherId = m.mode === 'create' ? state.user.id : m.teacherId;
  const conflictType = await checkConflictServer(m.day, m.room, m.slotFrom, m.slotTo, m.mode === 'edit' ? m.lessonId : null, teacherId);
  if (conflictType === 'room') { showToast('Кабинет занят другим преподавателем', 'error'); btn.disabled = false; return; }
  if (conflictType === 'teacher') { showToast('Преподаватель занят в другом кабинете', 'error'); btn.disabled = false; return; }

  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[m.day]; const weekStart = formatDate(state.currentWeekStart);
  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(m.slotFrom * SLOT_MINUTES / 60), (m.slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(m.slotTo * SLOT_MINUTES / 60), (m.slotTo * SLOT_MINUTES) % 60, 0, 0);
  const studentIds = Array.from(m.selectedIds);

  if (m.mode === 'create') {
    const { data, error } = await db.from('lessons').insert({ teacher_id: state.user.id, room: m.room, week_start: weekStart, start_time: startTime.toISOString(), end_time: endTime.toISOString(), status: 'active' }).select().single();
    if (error) { showToast('Ошибка создания', 'error'); btn.disabled = false; return; }
    if (studentIds.length > 0) await db.from('lesson_students').insert(studentIds.map(sid => ({ lesson_id: data.id, student_id: sid })));
    showToast('Занятие создано', 'success');
  } else {
    const { error } = await db.from('lessons').update({ room: m.room, start_time: startTime.toISOString(), end_time: endTime.toISOString() }).eq('id', m.lessonId);
    if (error) { showToast('Ошибка сохранения', 'error'); btn.disabled = false; return; }
    await db.from('lesson_students').delete().eq('lesson_id', m.lessonId);
    if (studentIds.length > 0) await db.from('lesson_students').insert(studentIds.map(sid => ({ lesson_id: m.lessonId, student_id: sid })));
    showToast('Занятие обновлено', 'success');
  }
  btn.disabled = false; closeLessonModal(); await loadLessons();
}

async function deleteLesson() {
  const m = state.lessonModal; if (!m || m.mode !== 'edit') return;
  const lessonId = m.lessonId; closeLessonModal();
  showConfirm('Удалить занятие?', async () => {
    await db.from('lesson_students').delete().eq('lesson_id', lessonId);
    const { error } = await db.from('lessons').delete().eq('id', lessonId);
    if (error) { showToast('Ошибка удаления', 'error'); return; }
    showToast('Занятие удалено', 'success'); await loadLessons();
  });
}

// ===== NAVIGATION =====

function navigateWeek(offset) {
  if (state.placingLesson) { showToast('Сначала разместите или отмените перенос', 'error'); return; }
  const target = new Date(state.currentWeekStart); target.setDate(target.getDate() + offset * 7);
  const now = getMonday(new Date());
  const diff = Math.round((target - now) / (7 * 24 * 60 * 60 * 1000));
  if (diff < -2 || diff > 2) { showToast('Доступны только 2 недели назад и вперёд', 'error'); return; }
  state.currentWeekStart = target; updateWeekLabel(); renderGrid(); loadLessons();
}

function goToToday() {
  if (state.placingLesson) { showToast('Сначала разместите или отмените перенос', 'error'); return; }
  state.currentWeekStart = getMonday(new Date()); updateWeekLabel(); renderGrid(); loadLessons();
}

function initSchedule() {
  if (scheduleInited) { renderGrid(); loadLessons(); return; }
  state.currentWeekStart = getMonday(new Date());
  updateWeekLabel(); renderGrid(); loadLessons();

  document.getElementById('btn-prev-week').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('btn-next-week').addEventListener('click', () => {
    if (dragState && dragStarted) {
      startNextWeekTransfer(dragState.lesson);
      document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
      dragState = null; dragMouseStart = null; dragStarted = false; return;
    }
    navigateWeek(1);
  });
  document.getElementById('btn-today').addEventListener('click', goToToday);
  document.getElementById('btn-save-lesson').addEventListener('click', saveLesson);
  document.getElementById('btn-cancel-lesson').addEventListener('click', closeLessonModal);
  document.getElementById('btn-close-lesson').addEventListener('click', closeLessonModal);
  document.getElementById('btn-delete-lesson').addEventListener('click', deleteLesson);

  let searchTimeout;
  document.getElementById('lesson-student-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout); searchTimeout = setTimeout(() => renderLessonStudentsList(e.target.value.trim()), 150);
  });
  document.getElementById('lesson-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLessonModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.placingLesson) cancelPlacing();
      if (studentDragState) cancelStudentDrag();
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (studentDragState) {
      const card = e.target.closest('.lesson-card');
      const cell = e.target.closest('.grid-cell');
      if (!card && !cell) cancelStudentDrag();
    }
  });

  setInterval(renderNowTime, 30000);
  scheduleInited = true;
}
