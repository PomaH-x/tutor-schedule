let recurringLessons = [];
let recurringInited = false;
let recSelecting = false;
let recSelStart = null;
let recSelEnd = null;
let recDragState = null;
let recDragMouseStart = null;
let recDragStarted = false;
let recPendingClick = null;
let recDurationLabel = null;
let recTooltip = null;

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
      if (r === 2) rl.classList.add('grid-room-label-day-end');
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

function recLessonSlots(lesson) {
  const sp = lesson.start_time.split(':'); const ep = lesson.end_time.split(':');
  const ss = (+sp[0] * 60 + +sp[1] - START_HOUR * 60) / SLOT_MINUTES;
  const es = (+ep[0] * 60 + +ep[1] - START_HOUR * 60) / SLOT_MINUTES;
  return { ss, es };
}

function renderRecurringLessons() {
  const grid = document.getElementById('recurring-grid');
  grid.querySelectorAll('.lesson-card').forEach(el => el.remove());
  const isDark = document.documentElement.dataset.theme === 'dark';

  const groups = {};
  recurringLessons.forEach(lesson => {
    const key = `${lesson.day_of_week}-${lesson.room}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(lesson);
  });

  // Pre-compute per-slot totals
  const slotTotals = {};
  Object.entries(groups).forEach(([key, lessons]) => {
    slotTotals[key] = {};
    lessons.forEach(lesson => {
      const { ss, es } = recLessonSlots(lesson);
      const sc = lesson.recurring_lesson_students?.length || 0;
      for (let s = ss; s < es; s++) {
        slotTotals[key][s] = (slotTotals[key][s] || 0) + sc;
      }
    });
  });

  Object.entries(groups).forEach(([key, lessons]) => {
    lessons.sort((a, b) => {
      const as = recLessonSlots(a).ss; const bs = recLessonSlots(b).ss;
      return as - bs;
    });
    lessons.forEach((lesson, i) => {
      const { ss } = recLessonSlots(lesson);
      let ov = 0;
      for (let j = 0; j < i; j++) { if (ss < recLessonSlots(lessons[j]).es) ov++; }
      lesson._ov = ov;
    });

    const slotClaimed = {};
    lessons.forEach(lesson => {
      const { ss, es } = recLessonSlots(lesson);
      for (let s = ss; s < es; s++) { if (!slotClaimed[s]) slotClaimed[s] = lesson.id; }
    });

    lessons.forEach(lesson => {
      const { ss, es } = recLessonSlots(lesson);
      const card = document.createElement('div');
      card.className = 'lesson-card'; card.dataset.lessonId = lesson.id;
      const color = lesson.teacher?.color || '#1e6fe8';
      card.style.gridRow = `${rowForSlot(ss)} / ${rowForSlot(es)}`;
      card.style.gridColumn = colForDayRoom(lesson.day_of_week, lesson.room);
      if (lesson._ov > 0) { card.style.zIndex = 2 + lesson._ov; }

      const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      card.style.borderColor = `rgba(${r},${g},${b},${isDark ? 0.5 : 0.4})`;

      let slotsHTML = '';
      for (let s = ss; s < es; s++) {
        const total = slotTotals[key][s] || 0;
        const clamped = Math.min(total, 4);
        const alpha = isDark ? 0.06 + (clamped / 4) * 0.30 : 0.05 + (clamped / 4) * 0.25;
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
      const dragHTML = canEdit ? '<div class="lc-drag-handle" title="Перетащить">⠿</div>' : '';

      card.innerHTML = `${dragHTML}${headerHTML}<div class="lc-slots">${slotsHTML}</div>`;
      grid.appendChild(card);
    });
  });
}

// ===== RECURRING GRID EVENTS =====
function findRecCellAt(x, y) {
  const grid = document.getElementById('recurring-grid');
  const cards = grid.querySelectorAll('.lesson-card');
  cards.forEach(c => c.style.pointerEvents = 'none');
  const el = document.elementFromPoint(x, y);
  cards.forEach(c => c.style.pointerEvents = '');
  return el?.closest?.('.grid-cell');
}

function initRecurringGridEvents(grid) {
  grid.addEventListener('mousedown', onRecGridMouseDown);
  grid.addEventListener('mousemove', onRecGridMouseMove);
  grid.addEventListener('mouseup', onRecGridMouseUp);
  grid.addEventListener('contextmenu', onRecGridContextMenu);
  grid.addEventListener('mouseleave', () => {
    if (recSelecting) { recSelecting = false; clearRecSelection(); }
    recPendingClick = null;
    removeRecTooltip();
    clearRecDragHighlight();
  });
}

function onRecGridContextMenu(e) {
  const card = e.target.closest('.lesson-card');
  if (!card) return;
  e.preventDefault();
  const col = card.style.gridColumn;
  const allCards = [...document.querySelectorAll('#recurring-grid .lesson-card')].filter(c => c.style.gridColumn === col);
  if (allCards.length <= 1) return;
  const clickedStart = parseInt(card.style.gridRow.split('/')[0].trim());
  const clickedEnd = parseInt(card.style.gridRow.split('/')[1].trim());
  const overlapping = allCards.filter(c => {
    const s = parseInt(c.style.gridRow.split('/')[0].trim());
    const e2 = parseInt(c.style.gridRow.split('/')[1].trim());
    return s < clickedEnd && e2 > clickedStart;
  });
  if (overlapping.length <= 1) return;
  const sorted = overlapping.sort((a, b) => (parseInt(b.style.zIndex) || 2) - (parseInt(a.style.zIndex) || 2));
  const zValues = sorted.map(c => parseInt(c.style.zIndex) || 2);
  const last = zValues.shift(); zValues.push(last);
  sorted.forEach((c, i) => { c.style.zIndex = zValues[i]; });
}

function onRecGridMouseDown(e) {
  if (e.button === 2) return;
  if (state.profile.role === 'student') return;

  const dragHandle = e.target.closest('.lc-drag-handle');
  if (dragHandle) {
    e.preventDefault();
    const card = dragHandle.closest('.lesson-card');
    const lesson = recurringLessons.find(l => l.id === card.dataset.lessonId);
    if (!lesson) return;
    const { ss, es } = recLessonSlots(lesson);
    recDragState = { lesson, slotLength: es - ss };
    recDragMouseStart = { x: e.clientX, y: e.clientY };
    recDragStarted = false;
    return;
  }

  const card = e.target.closest('.lesson-card');
  const grid = document.getElementById('recurring-grid');
  const cell = card ? findRecCellAt(e.clientX, e.clientY) : e.target.closest('.grid-cell');
  if (!cell) return;
  e.preventDefault();
  recPendingClick = {
    x: e.clientX, y: e.clientY, card, lessonId: card?.dataset.lessonId,
    day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot
  };
}

function onRecGridMouseMove(e) {
  const grid = document.getElementById('recurring-grid');

  if (recPendingClick) {
    const dx = e.clientX - recPendingClick.x; const dy = e.clientY - recPendingClick.y;
    if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
      recSelecting = true;
      recSelStart = { day: recPendingClick.day, room: recPendingClick.room, slot: recPendingClick.slot };
      recSelEnd = { ...recSelStart };
      updateRecSelection();
      removeRecTooltip();
      recPendingClick = null;
    } else { return; }
  }

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

  if (!recSelecting) handleRecTooltip(e);

  if (recSelecting) {
    const cell = findRecCellAt(e.clientX, e.clientY);
    if (!cell) return;
    if (+cell.dataset.day !== recSelStart.day || +cell.dataset.room !== recSelStart.room) return;
    recSelEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    updateRecSelection();
  }
}

function onRecGridMouseUp(e) {
  if (recPendingClick) {
    const pc = recPendingClick; recPendingClick = null;
    if (pc.lessonId) {
      const lesson = recurringLessons.find(l => l.id === pc.lessonId);
      if (lesson) openRecurringEditModal(lesson);
    } else {
      openRecurringCreateModal({ day: pc.day, room: pc.room, slotFrom: pc.slot, slotTo: pc.slot + 1 });
    }
    return;
  }

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

// ===== AUTO-COPY TO NEXT WEEKS =====
async function syncRecurringToWeeks(teacherFilter) {
  const now = getMonday(new Date());
  const nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + 7);
  const twoWeeks = new Date(now); twoWeeks.setDate(twoWeeks.getDate() + 14);
  const isAdmin = state.profile.role === 'admin';
  const filterTid = teacherFilter || (isAdmin ? null : state.user.id);

  let q = db.from('recurring_lessons').select('*, recurring_lesson_students(student_id)');
  if (filterTid) q = q.eq('teacher_id', filterTid);
  const { data: recurring } = await q;
  if (!recurring || recurring.length === 0) return;

  for (const weekStart of [nextWeek, twoWeeks]) {
    const ws = formatDate(weekStart);
    const dates = getWeekDates(weekStart);

    let eq = db.from('lessons').select('id, teacher_id, start_time, room').eq('week_start', ws).eq('status', 'active');
    if (filterTid) eq = eq.eq('teacher_id', filterTid);
    const { data: existing } = await eq;

    const existingKeys = new Set((existing || []).map(l => {
      const s = new Date(l.start_time);
      return `${l.teacher_id}-${s.getDay()}-${l.room}-${s.getHours()}:${s.getMinutes()}`;
    }));

    for (const rl of recurring) {
      const dayDate = dates[rl.day_of_week];
      if (!dayDate) continue;
      const sp = rl.start_time.split(':');
      const ep = rl.end_time.split(':');
      const key = `${rl.teacher_id}-${dayDate.getDay()}-${rl.room}-${+sp[0]}:${+sp[1]}`;
      if (existingKeys.has(key)) continue;

      const sTime = new Date(dayDate); sTime.setHours(+sp[0], +sp[1], 0, 0);
      const eTime = new Date(dayDate); eTime.setHours(+ep[0], +ep[1], 0, 0);

      const { data: newLesson, error } = await db.from('lessons').insert({
        teacher_id: rl.teacher_id, room: rl.room, week_start: ws,
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();

      if (!error && newLesson && rl.recurring_lesson_students?.length > 0) {
        await db.from('lesson_students').insert(
          rl.recurring_lesson_students.map(rs => ({ lesson_id: newLesson.id, student_id: rs.student_id }))
        );
      }
    }
  }
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
    renderCurrentStudents();
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
  });
}

function openRecurringEditModal(lesson) {
  const { ss, es } = recLessonSlots(lesson);
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
    showToast('Занятие добавлено', 'success');
  } else {
    const { error } = await db.from('recurring_lessons').update({
      room: m.room, day_of_week: m.day, start_time: startTimeStr, end_time: endTimeStr
    }).eq('id', m.lessonId);
    if (error) { showToast('Ошибка', 'error'); return; }
    await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', m.lessonId);
    if (sids.length > 0) await db.from('recurring_lesson_students').insert(sids.map(sid => ({ recurring_lesson_id: m.lessonId, student_id: sid })));
    showToast('Занятие обновлено', 'success');
  }
  closeLessonModal();
  await loadRecurringLessons();
  syncRecurringToWeeks();
}

async function deleteRecurringLesson() {
  const m = state.lessonModal; if (!m) return;
  const lid = m.lessonId; closeLessonModal();
  showConfirm('Удалить из постоянного расписания?', async () => {
    await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', lid);
    await db.from('recurring_lessons').delete().eq('id', lid);
    showToast('Удалено', 'success');
    await loadRecurringLessons();
    syncRecurringToWeeks();
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
  showToast('Перенесено', 'success');
  await loadRecurringLessons();
  syncRecurringToWeeks();
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

  document.getElementById('btn-copy-recurring').addEventListener('click', onCopyRecurringClick);
  document.getElementById('btn-close-copy').addEventListener('click', closeCopyOverlay);
  document.getElementById('copy-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCopyOverlay();
  });
}

function closeCopyOverlay() {
  document.getElementById('copy-overlay').classList.remove('active');
}

async function onCopyRecurringClick() {
  const isAdmin = state.profile.role === 'admin';

  if (!isAdmin) {
    showToast('Копирование...', 'success');
    await syncRecurringToWeeks(state.user.id);
    showToast('Расписание скопировано', 'success');
    return;
  }

  const { data: teachers } = await db.from('profiles')
    .select('id, full_name, color')
    .in('role', ['teacher', 'admin'])
    .eq('status', 'approved')
    .order('full_name');

  const list = document.getElementById('copy-teacher-list');
  let html = `<button class="copy-teacher-btn" data-tid="all"><span class="copy-teacher-dot" style="background:var(--accent)"></span>Все преподаватели</button>`;
  (teachers || []).forEach(t => {
    html += `<button class="copy-teacher-btn" data-tid="${t.id}"><span class="copy-teacher-dot" style="background:${t.color || '#1e6fe8'}"></span>${t.full_name}</button>`;
  });
  list.innerHTML = html;

  list.querySelectorAll('.copy-teacher-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      closeCopyOverlay();
      const tid = btn.dataset.tid;
      showToast('Копирование...', 'success');
      if (tid === 'all') {
        await syncRecurringToWeeks(null);
      } else {
        await syncRecurringToWeeks(tid);
      }
      showToast('Расписание скопировано', 'success');
    });
  });

  document.getElementById('copy-overlay').classList.add('active');
}
