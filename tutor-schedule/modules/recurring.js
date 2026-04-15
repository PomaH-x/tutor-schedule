let recurringLessons = [];
let recurringInited = false;
let recAllStudents = [];

async function loadRecurringLessons() {
  const tid = state.profile.role === 'admin' ? undefined : state.user.id;
  let q = db.from('recurring_lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name), recurring_lesson_students(student_id, student:students(first_name, last_name, subject))');
  if (tid) q = q.eq('teacher_id', tid);
  const { data, error } = await q;
  if (error) { showToast('Ошибка загрузки', 'error'); return; }
  recurringLessons = data || [];
  renderRecurringLessons();
}

function renderRecurringGrid() {
  const grid = document.getElementById('recurring-grid');
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = '50px repeat(21, 1fr)';
  grid.style.gridTemplateRows = `40px 24px repeat(${TOTAL_SLOTS}, 28px)`;

  const corner = document.createElement('div');
  corner.className = 'grid-corner'; corner.style.gridRow = '1 / 3'; corner.style.gridColumn = '1';
  grid.appendChild(corner);

  for (let i = 0; i < 7; i++) {
    const h = document.createElement('div');
    h.className = 'grid-header';
    const col = colForDayRoom(i, 1);
    h.style.gridColumn = `${col} / ${col + 3}`; h.style.gridRow = '1';
    h.innerHTML = `<span class="day-name">${DAYS[i]}</span><span class="day-num">${DAYS_FULL[i]}</span>`;
    grid.appendChild(h);
    for (let r = 0; r < 3; r++) {
      const rl = document.createElement('div');
      rl.className = 'grid-room-label';
      rl.style.gridColumn = `${colForDayRoom(i, r + 1)}`; rl.style.gridRow = '2'; rl.textContent = ROOM_LABELS[r];
      grid.appendChild(rl);
    }
  }

  for (let slot = 0; slot <= TOTAL_SLOTS; slot++) {
    const hour = START_HOUR + Math.floor(slot / 2); const min = (slot % 2) * 30;
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

  initRecurringGridEvents(grid);
  renderRecurringLessons();
}

function renderRecurringLessons() {
  const grid = document.getElementById('recurring-grid');
  grid.querySelectorAll('.lesson-card').forEach(el => el.remove());
  const isDark = document.documentElement.dataset.theme === 'dark';

  recurringLessons.forEach(lesson => {
    const startParts = lesson.start_time.split(':');
    const endParts = lesson.end_time.split(':');
    const startMin = +startParts[0] * 60 + +startParts[1];
    const endMin = +endParts[0] * 60 + +endParts[1];
    const startSlot = (startMin - START_HOUR * 60) / SLOT_MINUTES;
    const endSlot = (endMin - START_HOUR * 60) / SLOT_MINUTES;
    if (startSlot < 0) return;

    const card = document.createElement('div');
    card.className = 'lesson-card'; card.dataset.lessonId = lesson.id;
    const color = lesson.teacher?.color || '#1e6fe8';
    card.style.background = color + (isDark ? '18' : '15');
    card.style.borderColor = color + (isDark ? '40' : '35');
    card.style.color = isDark ? color + 'cc' : color;
    card.style.gridRow = `${rowForSlot(startSlot)} / ${rowForSlot(endSlot)}`;
    card.style.gridColumn = colForDayRoom(lesson.day_of_week, lesson.room);

    const sn = (lesson.teacher?.short_name || '??').replace(/\./g, '');
    const sc = lesson.recurring_lesson_students?.length || 0;
    const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
    card.innerHTML = `${canEdit ? '<div class="lc-drag-handle" title="Перетащить">⠿</div>' : ''}<div class="lc-teacher">${sn}</div><div class="lc-count">${sc}<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`;
    grid.appendChild(card);
  });
}

// ===== RECURRING GRID EVENTS =====
let recSelecting = false;
let recSelStart = null;
let recSelEnd = null;
let recDragState = null;
let recDragMouseStart = null;
let recDragStarted = false;

function initRecurringGridEvents(grid) {
  grid.addEventListener('mousedown', onRecGridMouseDown);
  grid.addEventListener('mousemove', onRecGridMouseMove);
  grid.addEventListener('mouseup', onRecGridMouseUp);
  grid.addEventListener('mouseleave', () => {
    if (recSelecting) { recSelecting = false; clearRecSelection(); }
    removeRecTooltip();
    clearRecDragHighlight();
  });
}

function onRecGridMouseDown(e) {
  if (state.profile.role === 'student') return;
  const dragHandle = e.target.closest('.lc-drag-handle');
  if (dragHandle) {
    e.preventDefault();
    const card = dragHandle.closest('.lesson-card');
    const lesson = recurringLessons.find(l => l.id === card.dataset.lessonId);
    if (!lesson) return;
    const sp = lesson.start_time.split(':'); const ep = lesson.end_time.split(':');
    const ss = (+sp[0] * 60 + +sp[1] - START_HOUR * 60) / SLOT_MINUTES;
    const es = (+ep[0] * 60 + +ep[1] - START_HOUR * 60) / SLOT_MINUTES;
    recDragState = { lesson, slotLength: es - ss };
    recDragMouseStart = { x: e.clientX, y: e.clientY };
    recDragStarted = false;
    return;
  }
  const card = e.target.closest('.lesson-card');
  if (card) {
    const lesson = recurringLessons.find(l => l.id === card.dataset.lessonId);
    if (lesson) openRecurringEditModal(lesson);
    return;
  }
  const cell = e.target.closest('.grid-cell');
  if (!cell) return;
  recSelecting = true;
  recSelStart = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
  recSelEnd = { ...recSelStart };
  updateRecSelection();
  e.preventDefault();
}

function onRecGridMouseMove(e) {
  const grid = document.getElementById('recurring-grid');
  if (recDragState) {
    if (!recDragStarted) {
      const dx = e.clientX - recDragMouseStart.x; const dy = e.clientY - recDragMouseStart.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      recDragStarted = true;
      grid.classList.add('grid-dragging');
      grid.querySelector(`.lesson-card[data-lesson-id="${recDragState.lesson.id}"]`)?.classList.add('lesson-card-dragging');
      removeRecTooltip();
    }
    clearRecDragHighlight();
    const cell = e.target.closest('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + recDragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = hasRecConflict(td, tr, ts, end, recDragState.lesson.id, recDragState.lesson.teacher_id);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    return;
  }

  // Tooltip
  if (!recSelecting) {
    handleRecTooltip(e);
  }

  if (recSelecting) {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    if (+cell.dataset.day !== recSelStart.day || +cell.dataset.room !== recSelStart.room) return;
    recSelEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    updateRecSelection();
  }
}

let recTooltip = null;

function handleRecTooltip(e) {
  const cell = e.target.closest('.grid-cell');
  if (!cell) { removeRecTooltip(); return; }
  const slot = +cell.dataset.slot; const room = +cell.dataset.room;
  if (!recTooltip) { recTooltip = document.createElement('div'); recTooltip.className = 'cell-tooltip'; document.body.appendChild(recTooltip); }
  recTooltip.textContent = `${slotToTime(slot)} ${ROOM_FULL[room - 1]}`;
  const rect = cell.getBoundingClientRect();
  const tw = recTooltip.offsetWidth || 120;
  recTooltip.style.left = (window.innerWidth - rect.right > tw + 16) ? `${rect.right + 8}px` : `${rect.left - tw - 8}px`;
  recTooltip.style.top = `${rect.top + rect.height / 2}px`;
  document.querySelectorAll('#recurring-grid .grid-cell-hover').forEach(c => c.classList.remove('grid-cell-hover'));
  cell.classList.add('grid-cell-hover');
}

function removeRecTooltip() {
  if (recTooltip) { recTooltip.remove(); recTooltip = null; }
  document.querySelectorAll('#recurring-grid .grid-cell-hover').forEach(c => c.classList.remove('grid-cell-hover'));
}

function onRecGridMouseUp(e) {
  if (recDragState) {
    if (!recDragStarted) { recDragState = null; recDragMouseStart = null; return; }
    clearRecDragHighlight();
    document.getElementById('recurring-grid')?.classList.remove('grid-dragging');
    document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
    const cell = e.target.closest('.grid-cell');
    if (cell) finishRecDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    recDragState = null; recDragMouseStart = null; recDragStarted = false;
    return;
  }
  if (recSelecting) {
    recSelecting = false; clearRecSelection();
    if (!recSelStart) return;
    const sf = Math.min(recSelStart.slot, recSelEnd.slot);
    const st = Math.max(recSelStart.slot, recSelEnd.slot) + 1;
    openRecurringCreateModal({ day: recSelStart.day, room: recSelStart.room, slotFrom: sf, slotTo: st });
  }
}

let recDurationLabel = null;

function updateRecSelection() {
  clearRecSelection();
  if (!recSelStart || !recSelEnd) return;
  const grid = document.getElementById('recurring-grid');
  const sf = Math.min(recSelStart.slot, recSelEnd.slot);
  const st = Math.max(recSelStart.slot, recSelEnd.slot);
  const count = st - sf + 1;
  for (let s = sf; s <= st; s++) {
    const c = grid.querySelector(`.grid-cell[data-day="${recSelStart.day}"][data-room="${recSelStart.room}"][data-slot="${s}"]`);
    if (c) c.classList.add('grid-cell-selected');
  }
  const last = grid.querySelector(`.grid-cell[data-day="${recSelStart.day}"][data-room="${recSelStart.room}"][data-slot="${st}"]`);
  if (last && count > 0) {
    recDurationLabel = document.createElement('div');
    recDurationLabel.className = 'selection-duration-label';
    recDurationLabel.textContent = slotsToLabel(count);
    const rect = last.getBoundingClientRect(); const gr = grid.getBoundingClientRect();
    recDurationLabel.style.left = `${rect.left + rect.width / 2 - gr.left}px`;
    recDurationLabel.style.top = `${rect.bottom - gr.top + 4}px`;
    grid.appendChild(recDurationLabel);
  }
}

function clearRecSelection() {
  document.querySelectorAll('#recurring-grid .grid-cell-selected').forEach(c => c.classList.remove('grid-cell-selected'));
  if (recDurationLabel) { recDurationLabel.remove(); recDurationLabel = null; }
}
function clearRecDragHighlight() { document.querySelectorAll('#recurring-grid .grid-cell-drop-ok, #recurring-grid .grid-cell-conflict').forEach(c => c.classList.remove('grid-cell-drop-ok', 'grid-cell-conflict')); }

function hasRecConflict(day, room, slotFrom, slotTo, excludeId, teacherId) {
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return recurringLessons.some(l => {
    if (l.id === excludeId) return false;
    if (l.day_of_week !== day) return false;
    const sp = l.start_time.split(':'); const ep = l.end_time.split(':');
    const lS = +sp[0] * 60 + +sp[1]; const lE = +ep[0] * 60 + +ep[1];
    if (startMin >= lE || endMin <= lS) return false;
    if (l.room === room && teacherId && l.teacher_id === teacherId) return false;
    if (l.room === room && l.teacher_id !== teacherId) return true;
    if (l.room !== room && l.teacher_id === teacherId) return true;
    return false;
  });
}

function recSlotToTimeStr(slot) {
  const m = START_HOUR * 60 + slot * SLOT_MINUTES;
  const h = Math.floor(m / 60); const min = m % 60;
  return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:00`;
}

// ===== RECURRING CRUD =====
function openRecurringCreateModal(sel) {
  document.getElementById('lesson-modal-title').textContent = `${DAYS_FULL[sel.day]} · ${ROOM_FULL[sel.room - 1]} · ${slotToTime(sel.slotFrom)}–${slotToTime(sel.slotTo)}`;
  document.getElementById('btn-delete-lesson').style.display = 'none';
  document.getElementById('btn-save-lesson').style.display = 'block';
  document.getElementById('lesson-student-search').parentElement.style.display = 'block';
  document.getElementById('lesson-current-students').innerHTML = '';
  document.getElementById('lesson-current-students').style.display = 'none';

  state.lessonModal = { mode: 'rec-create', day: sel.day, room: sel.room, slotFrom: sel.slotFrom, slotTo: sel.slotTo, selectedIds: new Set() };

  loadTeacherStudentsForModal(state.user.id).then(() => {
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
  });
}

function openRecurringEditModal(lesson) {
  const sp = lesson.start_time.split(':'); const ep = lesson.end_time.split(':');
  const ss = (+sp[0] * 60 + +sp[1] - START_HOUR * 60) / SLOT_MINUTES;
  const es = (+ep[0] * 60 + +ep[1] - START_HOUR * 60) / SLOT_MINUTES;

  document.getElementById('lesson-modal-title').textContent = `${DAYS_FULL[lesson.day_of_week]} · ${ROOM_FULL[lesson.room - 1]} · ${slotToTime(ss)}–${slotToTime(es)}`;
  const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
  document.getElementById('btn-delete-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('btn-save-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('lesson-student-search').parentElement.style.display = canEdit ? 'block' : 'none';

  const selectedIds = new Set((lesson.recurring_lesson_students || []).map(ls => ls.student_id));
  state.lessonModal = { mode: 'rec-edit', lessonId: lesson.id, teacherId: lesson.teacher_id, day: lesson.day_of_week, room: lesson.room, slotFrom: ss, slotTo: es, selectedIds };

  loadTeacherStudentsForModal(lesson.teacher_id).then(() => {
    renderCurrentStudents();
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
  });
}

async function saveRecurringLesson() {
  const m = state.lessonModal; if (!m) return;
  if (m.selectedIds.size === 0) { showToast('Добавьте хотя бы одного ученика', 'error'); return; }
  const sids = Array.from(m.selectedIds);
  const startTimeStr = recSlotToTimeStr(m.slotFrom);
  const endTimeStr = recSlotToTimeStr(m.slotTo);

  if (m.mode === 'rec-create') {
    const { data, error } = await db.from('recurring_lessons').insert({
      teacher_id: state.user.id, room: m.room, day_of_week: m.day,
      start_time: startTimeStr, end_time: endTimeStr
    }).select().single();
    if (error) { showToast('Ошибка', 'error'); return; }
    if (sids.length > 0) await db.from('recurring_lesson_students').insert(sids.map(sid => ({ recurring_lesson_id: data.id, student_id: sid })));
    showToast('Занятие добавлено в постоянное расписание', 'success');
  } else {
    const { error } = await db.from('recurring_lessons').update({
      room: m.room, day_of_week: m.day, start_time: startTimeStr, end_time: endTimeStr
    }).eq('id', m.lessonId);
    if (error) { showToast('Ошибка', 'error'); return; }
    await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', m.lessonId);
    if (sids.length > 0) await db.from('recurring_lesson_students').insert(sids.map(sid => ({ recurring_lesson_id: m.lessonId, student_id: sid })));
    showToast('Занятие обновлено', 'success');
  }
  closeLessonModal(); await loadRecurringLessons();
}

async function deleteRecurringLesson() {
  const m = state.lessonModal; if (!m) return;
  const lid = m.lessonId; closeLessonModal();
  showConfirm('Удалить из постоянного расписания?', async () => {
    await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', lid);
    await db.from('recurring_lessons').delete().eq('id', lid);
    showToast('Удалено', 'success'); await loadRecurringLessons();
  });
}

async function finishRecDrag(targetDay, targetRoom, targetSlot) {
  const lesson = recDragState.lesson;
  const end = targetSlot + recDragState.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  if (hasRecConflict(targetDay, targetRoom, targetSlot, end, lesson.id, lesson.teacher_id)) {
    showToast('Конфликт', 'error'); return;
  }
  const { error } = await db.from('recurring_lessons').update({
    room: targetRoom, day_of_week: targetDay,
    start_time: recSlotToTimeStr(targetSlot), end_time: recSlotToTimeStr(end)
  }).eq('id', lesson.id);
  if (error) { showToast('Ошибка', 'error'); return; }
  showToast('Перенесено', 'success'); await loadRecurringLessons();
}

function initRecurring() {
  document.getElementById('btn-to-recurring').addEventListener('click', () => {
    showScreen('screen-recurring');
    renderRecurringGrid();
    loadRecurringLessons();
  });
  document.getElementById('btn-to-current').addEventListener('click', () => {
    showScreen('screen-schedule');
  });
  document.getElementById('btn-profile-2').addEventListener('click', () => {
    openProfileScreen();
  });
}
