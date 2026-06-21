let recurringLessons = [];
let recurringInited = false;
let recSelecting = false;
let recSelStart = null;
let recSelEnd = null;
let recDragState = null;

function clearRecDragState() {
  if (recDragState && recDragState.lockKey && typeof releaseLock === 'function') {
    releaseLock(recDragState.lockKey);
  }
  recDragState = null;
}
let recDragMouseStart = null;
let recDragStarted = false;
let recPendingClick = null;
let recDurationLabel = null;
let recTooltip = null;

// Touch gesture state (mobile) — mirrors schedule.js
let recTouchGesture = null;
let recLastTouchTime = 0;
let recTouchTooltipTimer = null;
let recTouchLastCardTapId = null;
let recTouchLastCardTapAt = 0;
let recTouchEditTimer = null;
function recIsShortlyAfterTouch() { return Date.now() - recLastTouchTime < 600; }

async function loadRecurringLessons() {
  // Everyone (admin + teacher) sees ALL recurring lessons — needed for conflict prevention
  const { data, error } = await db.from('recurring_lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name, max_group_size), recurring_lesson_students(student_id, student:students(first_name, last_name, subject, is_individual))');
  if (error) {
    console.error('loadRecurringLessons error:', error);
    showToast('Ошибка загрузки', 'error');
    return;
  }
  recurringLessons = data || [];
  renderRecurringLessons();
  // Defensive: occasionally the first render races with grid setup — verify and retry once.
  setTimeout(() => {
    if (recurringLessons.length === 0) return;
    const visible = document.querySelectorAll('#recurring-grid .lesson-card').length;
    if (visible === 0) {
      console.warn('Recurring cards missing after render — retrying. data:', recurringLessons.length);
      renderRecurringLessons();
    }
  }, 100);
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
  if (typeof applyLockVisuals === 'function') applyLockVisuals();
  if (typeof decorateZCycleButtons === 'function') decorateZCycleButtons('#recurring-grid');
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
  // Touch (mobile)
  grid.addEventListener('pointerdown', onRecGridPointerDown);
  grid.addEventListener('pointermove', onRecGridPointerMove);
  grid.addEventListener('pointerup', onRecGridPointerUp);
  grid.addEventListener('pointercancel', onRecGridPointerCancel);
  grid.addEventListener('touchmove', onRecGridTouchMove, { passive: false });
}

function onRecGridContextMenu(e) {
  e.preventDefault();
  if (recIsShortlyAfterTouch()) return;
  const card = e.target.closest('.lesson-card');
  if (!card) return;
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
  if (recIsShortlyAfterTouch()) return;
  if (state.profile.role === 'student') return;

  // Student drag in progress — let document-level handlers do the placement, don't set pendingClick.
  if (studentDragState) return;

  const dragHandle = e.target.closest('.lc-drag-handle');
  if (dragHandle) {
    e.preventDefault();
    const card = dragHandle.closest('.lesson-card');
    const lesson = recurringLessons.find(l => l.id === card.dataset.lessonId);
    if (!lesson) return;
    if (typeof checkLockedAndToast === 'function' && checkLockedAndToast('rec:' + lesson.id)) return;
    if (typeof acquireLock === 'function') acquireLock('rec:' + lesson.id);
    const { ss, es } = recLessonSlots(lesson);
    recDragState = { lesson, slotLength: es - ss, lockKey: 'rec:' + lesson.id };
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
  if (recIsShortlyAfterTouch()) return;
  const grid = document.getElementById('recurring-grid');

  // Student drag — highlight target cells with conflict awareness
  if (studentDragState) {
    clearRecDragHighlight();
    const cell = e.target.closest('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + studentDragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = hasRecConflict(td, tr, ts, end, null, studentDragState.teacherId);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    return;
  }

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
      clearRecLessonTooltip();
    }
    clearRecDragHighlight();
    const cell = e.target.closest('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day; const tr = +cell.dataset.room; const ts = +cell.dataset.slot;
      const end = ts + recDragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = !!getRecDragConflictType(td, tr, ts, end, recDragState.lesson.id, recDragState.lesson.teacher_id);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
    return;
  }

  if (!recSelecting) { handleRecTooltip(e); handleRecLessonTooltip(e); }

  if (recSelecting) {
    const cell = findRecCellAt(e.clientX, e.clientY);
    if (!cell) return;
    if (+cell.dataset.day !== recSelStart.day || +cell.dataset.room !== recSelStart.room) return;
    recSelEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    updateRecSelection();
  }
}

async function onRecGridMouseUp(e) {
  if (recIsShortlyAfterTouch()) return;
  // Student drag (started from a lesson modal, modal was closed, banner shown)
  if (studentDragState) {
    recPendingClick = null;
    const card = e.target.closest('.lesson-card');
    if (card) {
      placeStudentOnRecurringLesson(card.dataset.lessonId);
      return;
    }
    const cell = e.target.closest('.grid-cell');
    if (cell) {
      placeStudentOnRecurringCell(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
      return;
    }
    cancelStudentDrag();
    return;
  }

  if (recPendingClick) {
    const pc = recPendingClick; recPendingClick = null;
    if (pc.lessonId) {
      const lesson = recurringLessons.find(l => l.id === pc.lessonId);
      if (lesson) openRecurringEditModal(lesson);
    }
    // Click on empty cell does nothing — new recurring lessons are created via range-select drag.
    return;
  }

  if (recDragState) {
    if (!recDragStarted) { clearRecDragState(); recDragMouseStart = null; return; }
    clearRecDragHighlight();
    document.getElementById('recurring-grid')?.classList.remove('grid-dragging');
    document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
    const cell = e.target.closest('.grid-cell');
    if (cell) await finishRecDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    clearRecDragState(); recDragMouseStart = null; recDragStarted = false;
    return;
  }

  if (recSelecting) {
    recSelecting = false; clearRecSelection();
    if (!recSelStart) return;
    const sf = Math.min(recSelStart.slot, recSelEnd.slot);
    const st = Math.max(recSelStart.slot, recSelEnd.slot) + 1;
    const ownTid = state.profile.role === 'admin' ? null : state.user.id;
    if (hasRecRoomConflict(recSelStart.day, recSelStart.room, sf, st, null, ownTid)) {
      showToast('Кабинет уже занят в это время', 'error');
      return;
    }
    if (ownTid && hasRecTeacherDiffRoomConflict(recSelStart.day, recSelStart.room, sf, st, ownTid, null)) {
      showToast('У вас уже есть занятие в это время', 'error');
      return;
    }
    openRecurringCreateModal({ day: recSelStart.day, room: recSelStart.room, slotFrom: sf, slotTo: st });
  }
}

// ===== TOUCH GESTURES for recurring grid (mobile) =====
// Same logic as schedule.js but without next-week transfer.
function onRecGridPointerDown(e) {
  if (e.pointerType !== 'touch') return;
  if (recTouchGesture && recTouchGesture.pointerId !== e.pointerId) return;
  recLastTouchTime = Date.now();
  if (state.profile.role === 'student') return;

  // Student-from-modal placing → tap-to-place
  if (studentDragState) {
    const cardEl = e.target.closest('.lesson-card');
    if (cardEl) { e.preventDefault(); hidePlacingBanner(); placeStudentOnRecurringLesson(cardEl.dataset.lessonId); return; }
    const cellEl = e.target.closest('.grid-cell');
    if (cellEl) { e.preventDefault(); hidePlacingBanner(); placeStudentOnRecurringCell(+cellEl.dataset.day, +cellEl.dataset.room, +cellEl.dataset.slot); return; }
    return;
  }

  const zBtn = e.target.closest('.lc-zcycle');
  if (zBtn) { e.preventDefault(); cycleZForCard(zBtn.closest('.lesson-card')); return; }

  const card = e.target.closest('.lesson-card');
  const cell = e.target.closest('.grid-cell');
  if (!card && !cell) return;

  // Top slot of card is the drag zone (no visual handle on mobile)
  let handleHit = false;
  if (card) {
    const r = card.getBoundingClientRect();
    const lessonObj = recurringLessons.find(l => l.id === card.dataset.lessonId);
    if (lessonObj) {
      const { ss, es } = recLessonSlots(lessonObj);
      const slotCount = Math.max(1, es - ss);
      const slotPx = r.height / slotCount;
      handleHit = (e.clientY - r.top) < slotPx;
    }
  }

  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}

  recTouchGesture = {
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    card, cell, handleHit,
    longPress: false, mode: null, timer: null, tooltipTimer: null
  };
  recTouchGesture.timer = setTimeout(onRecTouchLongPress, 450);
}

function onRecTouchLongPress() {
  const g = recTouchGesture; if (!g) return;
  g.longPress = true;
  if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) {} }

  if (g.card) {
    const lesson = recurringLessons.find(l => l.id === g.card.dataset.lessonId);
    if (!lesson) { recTouchGesture = null; return; }
    if (g.handleHit) {
      if (state.profile.role !== 'admin' && lesson.teacher_id !== state.user.id) {
        showToast('Нельзя перемещать чужие занятия', 'error');
        recTouchGesture = null; return;
      }
      if (typeof checkLockedAndToast === 'function' && checkLockedAndToast('rec:' + lesson.id)) {
        recTouchGesture = null; return;
      }
      if (typeof acquireLock === 'function') acquireLock('rec:' + lesson.id);
      const { ss, es } = recLessonSlots(lesson);
      recDragState = { lesson, slotLength: es - ss, lockKey: 'rec:' + lesson.id };
      recDragStarted = true;
      g.mode = 'move';
      const grid = document.getElementById('recurring-grid');
      grid.classList.add('grid-dragging');
      g.card.classList.add('lesson-card-dragging');
    } else {
      g.mode = 'tooltip';
      showRecLessonTooltipForCard(g.card);
      if (recTouchTooltipTimer) clearTimeout(recTouchTooltipTimer);
      recTouchTooltipTimer = setTimeout(() => { clearRecLessonTooltip(); recTouchTooltipTimer = null; }, 2000);
    }
  } else if (g.cell) {
    g.mode = 'select';
    recSelecting = true;
    recSelStart = { day: +g.cell.dataset.day, room: +g.cell.dataset.room, slot: +g.cell.dataset.slot };
    recSelEnd = { ...recSelStart };
    updateRecSelection();
    removeRecTooltip();
  }
}

function onRecGridPointerMove(e) {
  if (e.pointerType !== 'touch') return;
  const g = recTouchGesture; if (!g || g.pointerId !== e.pointerId) return;

  if (!g.longPress) {
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      clearTimeout(g.timer); recTouchGesture = null;
    }
    return;
  }

  if (g.mode === 'select') {
    const cell = findRecCellAt(e.clientX, e.clientY);
    if (cell && +cell.dataset.day === recSelStart.day && +cell.dataset.room === recSelStart.room) {
      recSelEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
      updateRecSelection();
    }
  } else if (g.mode === 'move') {
    const grid = document.getElementById('recurring-grid');
    clearRecDragHighlight();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('.grid-cell');
    if (cell) {
      const td = +cell.dataset.day, tr = +cell.dataset.room, ts = +cell.dataset.slot;
      const end = ts + recDragState.slotLength;
      if (end <= TOTAL_SLOTS) {
        const conflict = !!getRecDragConflictType(td, tr, ts, end, recDragState.lesson.id, recDragState.lesson.teacher_id);
        for (let s = ts; s < end; s++) {
          const c = grid.querySelector(`.grid-cell[data-day="${td}"][data-room="${tr}"][data-slot="${s}"]`);
          if (c) c.classList.add(conflict ? 'grid-cell-conflict' : 'grid-cell-drop-ok');
        }
      }
    }
  }
}

function onRecGridTouchMove(e) {
  if (recTouchGesture && recTouchGesture.longPress && (recTouchGesture.mode === 'select' || recTouchGesture.mode === 'move')) {
    e.preventDefault();
  }
}

async function onRecGridPointerUp(e) {
  if (e.pointerType !== 'touch') return;
  const g = recTouchGesture; if (!g || g.pointerId !== e.pointerId) return;
  clearTimeout(g.timer);
  recLastTouchTime = Date.now();

  if (!g.longPress) {
    if (g.card) {
      e.preventDefault();
      const lesson = recurringLessons.find(l => l.id === g.card.dataset.lessonId);
      if (!lesson) { recTouchGesture = null; return; }
      const inOverlap = g.card.classList.contains('lesson-card-overlap');
      const cardId = g.card.dataset.lessonId;
      const now = Date.now();
      if (inOverlap && recTouchLastCardTapId === cardId && now - recTouchLastCardTapAt < 350) {
        if (recTouchEditTimer) { clearTimeout(recTouchEditTimer); recTouchEditTimer = null; }
        recTouchLastCardTapId = null;
        cycleZForCard(g.card);
        recTouchGesture = null;
        return;
      }
      if (inOverlap) {
        recTouchLastCardTapId = cardId;
        recTouchLastCardTapAt = now;
        if (recTouchEditTimer) clearTimeout(recTouchEditTimer);
        recTouchEditTimer = setTimeout(() => { recTouchEditTimer = null; openRecurringEditModal(lesson); }, 280);
      } else {
        openRecurringEditModal(lesson);
      }
    }
    recTouchGesture = null;
    return;
  }

  if (g.mode === 'select') {
    recSelecting = false; clearRecSelection();
    if (!recSelStart) { recTouchGesture = null; return; }
    const sf = Math.min(recSelStart.slot, recSelEnd.slot);
    const st = Math.max(recSelStart.slot, recSelEnd.slot) + 1;
    const ownTid = state.profile.role === 'admin' ? null : state.user.id;
    if (hasRecRoomConflict(recSelStart.day, recSelStart.room, sf, st, null, ownTid)) {
      showToast('Кабинет уже занят в это время', 'error');
      recTouchGesture = null; return;
    }
    if (ownTid && hasRecTeacherDiffRoomConflict(recSelStart.day, recSelStart.room, sf, st, ownTid, null)) {
      showToast('У вас уже есть занятие в это время', 'error');
      recTouchGesture = null; return;
    }
    openRecurringCreateModal({ day: recSelStart.day, room: recSelStart.room, slotFrom: sf, slotTo: st });
  } else if (g.mode === 'move') {
    // Resolve target cell FIRST — while grid-dragging is still active and cards are pointer-events:none
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('.grid-cell');
    clearRecDragHighlight();
    g.card?.classList.remove('lesson-card-dragging');
    document.getElementById('recurring-grid')?.classList.remove('grid-dragging');
    if (cell) await finishRecDrag(+cell.dataset.day, +cell.dataset.room, +cell.dataset.slot);
    else { clearRecDragState(); recDragStarted = false; }
  }
  recTouchGesture = null;
}

function onRecGridPointerCancel(e) {
  if (e.pointerType !== 'touch') return;
  const g = recTouchGesture; if (!g) return;
  clearTimeout(g.timer);
  if (g.mode === 'select') {
    recSelecting = false; recSelStart = null; recSelEnd = null; clearRecSelection();
  } else if (g.mode === 'move') {
    clearRecDragHighlight();
    g.card?.classList.remove('lesson-card-dragging');
    document.getElementById('recurring-grid')?.classList.remove('grid-dragging');
    clearRecDragState(); recDragStarted = false;
  } else if (g.mode === 'tooltip') {
    // Leave tooltip and its 3s timer alone
  }
  recTouchGesture = null;
}

function showRecLessonTooltipForCard(card) {
  const lesson = recurringLessons.find(l => l.id === card.dataset.lessonId);
  if (!lesson) return;
  clearRecLessonTooltip();
  const names = (lesson.recurring_lesson_students || [])
    .filter(s => s.student)
    .map(s => `${s.student.first_name} ${s.student.last_name}`);
  if (names.length === 0) return;
  recLessonTooltip = document.createElement('div');
  recLessonTooltip.className = 'lesson-tooltip lesson-tooltip-touch';
  recLessonTooltip.innerHTML = names.join('<br>');
  document.body.appendChild(recLessonTooltip);
  const rect = card.getBoundingClientRect();
  const tw = recLessonTooltip.offsetWidth, th = recLessonTooltip.offsetHeight;
  let left = rect.right + 8;
  if (left + tw > window.innerWidth - 16) left = rect.left - tw - 8;
  if (left < 8) left = 8;
  let top = rect.top;
  if (top + th > window.innerHeight - 16) top = window.innerHeight - th - 16;
  if (top < 8) top = 8;
  recLessonTooltip.style.left = `${left}px`;
  recLessonTooltip.style.top = `${top}px`;
}

let recLessonTooltip = null;
let recLessonTooltipTimer = null;
let recLessonTooltipSlotKey = null;

function handleRecLessonTooltip(e) {
  const card = e.target.closest('.lesson-card');
  if (!card || recSelecting || recDragState || recPendingClick) {
    clearRecLessonTooltip(); return;
  }
  const cell = findRecCellAt(e.clientX, e.clientY);
  if (!cell) { clearRecLessonTooltip(); return; }

  const day = +cell.dataset.day, room = +cell.dataset.room, slot = +cell.dataset.slot;
  const slotKey = `${day}-${room}-${slot}`;
  if (slotKey === recLessonTooltipSlotKey && (recLessonTooltip || recLessonTooltipTimer)) return;

  clearRecLessonTooltip();
  recLessonTooltipSlotKey = slotKey;
  recLessonTooltipTimer = setTimeout(() => {
    const slotStartMin = START_HOUR * 60 + slot * SLOT_MINUTES;
    const slotEndMin = slotStartMin + SLOT_MINUTES;
    const names = [];
    recurringLessons.forEach(l => {
      if (l.day_of_week !== day || l.room !== room) return;
      const sp = l.start_time.split(':'); const ep = l.end_time.split(':');
      const lS = +sp[0] * 60 + +sp[1];
      const lE = +ep[0] * 60 + +ep[1];
      if (slotStartMin >= lE || slotEndMin <= lS) return;
      (l.recurring_lesson_students || []).forEach(s => {
        if (s.student) names.push(`${s.student.first_name} ${s.student.last_name}`);
      });
    });
    if (names.length === 0) { clearRecLessonTooltip(); return; }
    recLessonTooltip = document.createElement('div');
    recLessonTooltip.className = 'lesson-tooltip';
    recLessonTooltip.innerHTML = names.join('<br>');
    document.body.appendChild(recLessonTooltip);
    const rect = cell.getBoundingClientRect();
    const tw = recLessonTooltip.offsetWidth, th = recLessonTooltip.offsetHeight;
    let left = rect.right + 8;
    if (left + tw > window.innerWidth - 16) left = rect.left - tw - 8;
    let top = rect.top;
    if (top + th > window.innerHeight - 16) top = window.innerHeight - th - 16;
    recLessonTooltip.style.left = `${left}px`;
    recLessonTooltip.style.top = `${top}px`;
  }, 500);
}

function clearRecLessonTooltip() {
  if (recLessonTooltipTimer) { clearTimeout(recLessonTooltipTimer); recLessonTooltipTimer = null; }
  if (recLessonTooltip) { recLessonTooltip.remove(); recLessonTooltip = null; }
  recLessonTooltipSlotKey = null;
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
  const grid = document.getElementById('recurring-grid');
  if (grid) grid.querySelectorAll('.grid-cell-selected').forEach(c => c.classList.remove('grid-cell-selected'));
  if (recDurationLabel) { recDurationLabel.remove(); recDurationLabel = null; }
}
function clearRecDragHighlight() {
  const grid = document.getElementById('recurring-grid');
  if (!grid) return;
  grid.querySelectorAll('.grid-cell-drop-ok, .grid-cell-conflict')
    .forEach(c => c.classList.remove('grid-cell-drop-ok', 'grid-cell-conflict'));
}

// Room conflict: another teacher's lesson overlaps in the same room.
// If `excludeTeacherId` is provided, lessons belonging to that teacher are NOT counted as room conflicts
// (it's their own lesson - they can move it, drag handles teacher conflict separately).
function hasRecRoomConflict(day, room, slotFrom, slotTo, excludeId, excludeTeacherId) {
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return recurringLessons.some(l => {
    if (l.id === excludeId) return false;
    if (l.day_of_week !== day) return false;
    if (l.room !== room) return false;
    if (excludeTeacherId && l.teacher_id === excludeTeacherId) return false;
    const sp = l.start_time.split(':'); const ep = l.end_time.split(':');
    const lS = +sp[0] * 60 + +sp[1]; const lE = +ep[0] * 60 + +ep[1];
    return !(startMin >= lE || endMin <= lS);
  });
}

// Strict same-room overlap (any teacher) — used by drag to block ALL overlaps
function hasRecRoomOverlapAny(day, room, slotFrom, slotTo, excludeId) {
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return recurringLessons.some(l => {
    if (l.id === excludeId || l.day_of_week !== day || l.room !== room) return false;
    const sp = l.start_time.split(':'); const ep = l.end_time.split(':');
    const lS = +sp[0] * 60 + +sp[1]; const lE = +ep[0] * 60 + +ep[1];
    return !(startMin >= lE || endMin <= lS);
  });
}

function getRecDragConflictType(day, room, slotFrom, slotTo, excludeId, teacherId) {
  // Different-teacher in same room — block
  if (hasRecRoomConflict(day, room, slotFrom, slotTo, excludeId, teacherId)) return 'room';
  // Same teacher in different room same time — block
  if (hasRecTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId)) return 'teacher';

  // Same-teacher same-room overlap — check capacity / individual mixing
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  const overlapping = recurringLessons.filter(l => {
    if (l.id === excludeId || l.day_of_week !== day || l.room !== room) return false;
    const sp = l.start_time.split(':'); const ep = l.end_time.split(':');
    const lS = +sp[0] * 60 + +sp[1]; const lE = +ep[0] * 60 + +ep[1];
    return startMin < lE && endMin > lS;
  });
  if (overlapping.length === 0) return null;

  const movingLesson = recurringLessons.find(l => l.id === excludeId);
  const movingStudents = movingLesson?.recurring_lesson_students || [];
  const movingCount = movingStudents.length;
  const movingHasIndividual = movingStudents.some(ls => ls.student?.is_individual);
  const overlappingStudents = overlapping.flatMap(l => l.recurring_lesson_students || []);
  const overlappingCount = overlappingStudents.length;
  const overlappingHasIndividual = overlappingStudents.some(ls => ls.student?.is_individual);
  const maxGroup = getMaxGroup(teacherId);
  if (overlappingCount + movingCount > maxGroup) return 'students';
  if ((movingHasIndividual && overlappingCount > 0) || (overlappingHasIndividual && movingCount > 0)) return 'individual';
  return null;
}

// Teacher conflict: same teacher has another lesson at this time in a different room.
function hasRecTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId) {
  const startMin = START_HOUR * 60 + slotFrom * SLOT_MINUTES;
  const endMin = START_HOUR * 60 + slotTo * SLOT_MINUTES;
  return recurringLessons.some(l => {
    if (l.id === excludeId) return false;
    if (l.day_of_week !== day) return false;
    if (l.teacher_id !== teacherId) return false;
    if (l.room === room) return false;
    const sp = l.start_time.split(':'); const ep = l.end_time.split(':');
    const lS = +sp[0] * 60 + +sp[1]; const lE = +ep[0] * 60 + +ep[1];
    return !(startMin >= lE || endMin <= lS);
  });
}

// Legacy compatibility wrapper (drag uses this) — combines both checks.
function hasRecConflict(day, room, slotFrom, slotTo, excludeId, teacherId) {
  if (hasRecRoomConflict(day, room, slotFrom, slotTo, excludeId, teacherId)) return 'room';
  if (hasRecTeacherDiffRoomConflict(day, room, slotFrom, slotTo, teacherId, excludeId)) return 'teacher';
  return false;
}

// ===== STUDENT DRAG-AND-DROP IN RECURRING =====

// Find recurring lesson by source: where the dragged student currently lives in recurring template
async function findSourceRecurringLessonId(studentId, teacherId) {
  const candidates = recurringLessons.filter(l =>
    l.teacher_id === teacherId &&
    (l.recurring_lesson_students || []).some(rs => rs.student_id === studentId)
  );
  return candidates[0]?.id || null;
}

async function placeStudentOnRecurringCell(day, room, slot) {
  const s = studentDragState; if (!s) return;
  const end = slot + s.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); cancelStudentDrag(); return; }

  const conflict = hasRecConflict(day, room, slot, end, null, s.teacherId);
  if (conflict === 'room') { showToast('Кабинет уже занят в это время', 'error'); cancelStudentDrag(); return; }
  if (conflict === 'teacher') { showToast('У вас уже есть занятие в это время', 'error'); cancelStudentDrag(); return; }

  const sourceRecId = await findSourceRecurringLessonId(s.studentId, s.teacherId);

  // Create new recurring lesson at target slot
  const { data: newRec, error } = await db.from('recurring_lessons').insert({
    teacher_id: s.teacherId, room, day_of_week: day,
    start_time: recSlotToTimeStr(slot), end_time: recSlotToTimeStr(end)
  }).select().single();
  if (error) { showToast('Ошибка', 'error'); cancelStudentDrag(); return; }

  await db.from('recurring_lesson_students').insert({ recurring_lesson_id: newRec.id, student_id: s.studentId });

  // Remove student from source recurring lesson, delete it if empty
  if (sourceRecId) {
    await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', sourceRecId).eq('student_id', s.studentId);
    const { data: remaining } = await db.from('recurring_lesson_students').select('student_id').eq('recurring_lesson_id', sourceRecId);
    if (!remaining || remaining.length === 0) {
      await db.from('recurring_lessons').delete().eq('id', sourceRecId);
    }
  }

  cancelStudentDrag();
  showToast('Ученик перенесён', 'success');
  await loadRecurringLessons();
  syncRecurringToWeeks();
}

async function placeStudentOnRecurringLesson(targetLessonId) {
  const s = studentDragState; if (!s) return;
  const tl = recurringLessons.find(l => l.id === targetLessonId);
  if (!tl) { cancelStudentDrag(); return; }
  if (tl.teacher_id !== s.teacherId) { showToast('Можно добавить только к своему преподавателю', 'error'); cancelStudentDrag(); return; }

  const sourceRecId = await findSourceRecurringLessonId(s.studentId, s.teacherId);
  if (sourceRecId === targetLessonId) { cancelStudentDrag(); return; }

  // Compute target lesson's duration in slots
  const tsp = tl.start_time.split(':'); const tep = tl.end_time.split(':');
  const tStartSlot = ((+tsp[0]) * 60 + (+tsp[1]) - START_HOUR * 60) / SLOT_MINUTES;
  const tEndSlot = ((+tep[0]) * 60 + (+tep[1]) - START_HOUR * 60) / SLOT_MINUTES;
  const targetSlots = tEndSlot - tStartSlot;

  // Duration mismatch — create a parallel recurring lesson at target's room+day+start with student's original duration
  if (targetSlots !== s.slotLength) {
    const endSlot = tStartSlot + s.slotLength;
    if (endSlot > TOTAL_SLOTS) { showToast('Длительность ученика не помещается в этот слот', 'error'); cancelStudentDrag(); return; }

    const conflict = hasRecConflict(tl.day_of_week, tl.room, tStartSlot, endSlot, null, s.teacherId);
    if (conflict === 'room') { showToast('Кабинет уже занят в это время', 'error'); cancelStudentDrag(); return; }
    if (conflict === 'teacher') { showToast('У вас уже есть занятие в это время', 'error'); cancelStudentDrag(); return; }

    const { data: newRec, error } = await db.from('recurring_lessons').insert({
      teacher_id: s.teacherId, room: tl.room, day_of_week: tl.day_of_week,
      start_time: recSlotToTimeStr(tStartSlot), end_time: recSlotToTimeStr(endSlot)
    }).select().single();
    if (error) { showToast('Ошибка', 'error'); cancelStudentDrag(); return; }

    await db.from('recurring_lesson_students').insert({ recurring_lesson_id: newRec.id, student_id: s.studentId });

    if (sourceRecId) {
      await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', sourceRecId).eq('student_id', s.studentId);
      const { data: remaining } = await db.from('recurring_lesson_students').select('student_id').eq('recurring_lesson_id', sourceRecId);
      if (!remaining || remaining.length === 0) {
        await db.from('recurring_lessons').delete().eq('id', sourceRecId);
      }
    }

    cancelStudentDrag();
    showToast('Ученик перенесён в отдельное занятие (своя длительность)', 'success');
    await loadRecurringLessons();
    syncRecurringToWeeks();
    return;
  }

  // Same duration — merge into target group
  const targetStudents = tl.recurring_lesson_students || [];
  if (targetStudents.some(rs => rs.student_id === s.studentId)) {
    showToast('Ученик уже в этом занятии', 'error'); cancelStudentDrag(); return;
  }
  if (targetStudents.length >= getMaxGroup(tl.teacher_id)) {
    showToast(`Максимум ${getMaxGroup(tl.teacher_id)} учеников`, 'error'); cancelStudentDrag(); return;
  }

  // Check individual flag
  const { data: studentInfo } = await db.from('students').select('is_individual').eq('id', s.studentId).single();
  const isInd = studentInfo?.is_individual;
  const targetHasIndividual = targetStudents.some(rs => rs.student?.is_individual);
  if (isInd && targetStudents.length > 0) { showToast('Индивидуальное занятие — только один ученик', 'error'); cancelStudentDrag(); return; }
  if (!isInd && targetHasIndividual) { showToast('В занятии уже индивидуальный ученик', 'error'); cancelStudentDrag(); return; }

  await db.from('recurring_lesson_students').insert({ recurring_lesson_id: targetLessonId, student_id: s.studentId });

  if (sourceRecId) {
    await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', sourceRecId).eq('student_id', s.studentId);
    const { data: remaining } = await db.from('recurring_lesson_students').select('student_id').eq('recurring_lesson_id', sourceRecId);
    if (!remaining || remaining.length === 0) {
      await db.from('recurring_lessons').delete().eq('id', sourceRecId);
    }
  }

  cancelStudentDrag();
  showToast('Ученик добавлен к занятию', 'success');
  await loadRecurringLessons();
  syncRecurringToWeeks();
}

function recSlotToTimeStr(slot) {
  const m = START_HOUR * 60 + slot * SLOT_MINUTES;
  const h = Math.floor(m / 60); const min = m % 60;
  return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:00`;
}

// ===== AUTO-COPY TO NEXT WEEKS =====
async function syncRecurringToWeeks(teacherFilter) {
  const now = getMonday(new Date());
  // Auto-sync: only "2 weeks ahead". "Next week" is manual only.
  const twoWeeks = new Date(now); twoWeeks.setDate(twoWeeks.getDate() + 14);
  const isAdmin = state.profile.role === 'admin';
  const filterTid = teacherFilter || (isAdmin ? null : state.user.id);

  let q = db.from('recurring_lessons').select('*, recurring_lesson_students(student_id)');
  if (filterTid) q = q.eq('teacher_id', filterTid);
  const { data: recurring } = await q;
  if (!recurring || recurring.length === 0) return;

  for (const weekStart of [twoWeeks]) {
    const ws = formatDate(weekStart);
    const dates = getWeekDates(weekStart);

    // Look at ALL statuses (active, cancelled, transferred) so we don't recreate over a manual cancel/transfer
    let eq = db.from('lessons').select('id, teacher_id, start_time, room, status, lesson_students(student_id)').eq('week_start', ws);
    if (filterTid) eq = eq.eq('teacher_id', filterTid);
    const { data: existing } = await eq;

    // Map key → lesson (for student-merge)
    const existingByKey = {};
    (existing || []).forEach(l => {
      const s = new Date(l.start_time);
      const key = `${l.teacher_id}-${s.getDay()}-${l.room}-${s.getHours()}:${s.getMinutes()}`;
      existingByKey[key] = l;
    });

    for (const rl of recurring) {
      const dayDate = dates[rl.day_of_week];
      if (!dayDate) continue;
      const sp = rl.start_time.split(':');
      const ep = rl.end_time.split(':');
      const key = `${rl.teacher_id}-${dayDate.getDay()}-${rl.room}-${+sp[0]}:${+sp[1]}`;

      const ex = existingByKey[key];
      if (ex) {
        // Lesson already exists. Only merge new students if it's active.
        if (ex.status === 'active' && rl.recurring_lesson_students?.length > 0) {
          const existingSids = new Set((ex.lesson_students || []).map(ls => ls.student_id));
          const newSids = rl.recurring_lesson_students
            .map(rs => rs.student_id)
            .filter(sid => !existingSids.has(sid));
          if (newSids.length > 0) {
            await db.from('lesson_students').insert(newSids.map(sid => ({ lesson_id: ex.id, student_id: sid })));
          }
        }
        continue;
      }

      // No lesson at this slot — create new one
      const sTime = new Date(dayDate); sTime.setHours(+sp[0], +sp[1], 0, 0);
      const eTime = new Date(dayDate); eTime.setHours(+ep[0], +ep[1], 0, 0);

      const { data: newLesson, error } = await db.from('lessons').insert({
        teacher_id: rl.teacher_id, room: rl.room, week_start: ws,
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();

      if (!error && newLesson && rl.recurring_lesson_students?.length > 0) {
        const sids = rl.recurring_lesson_students.map(rs => rs.student_id);
        await db.from('lesson_students').insert(
          sids.map(sid => ({ lesson_id: newLesson.id, student_id: sid }))
        );
        for (const sid of sids) await attachActiveSubscriptionIfAny(newLesson.id, sid, rl.teacher_id);
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

async function openRecurringEditModal(lesson) {
  const key = 'rec:' + lesson.id;
  if (typeof checkLockedAndToast === 'function' && checkLockedAndToast(key)) return;
  if (typeof acquireLock === 'function') await acquireLock(key);

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
  recurringByStudent = null;
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
    recurringByStudent = null;
    await loadRecurringLessons();
    syncRecurringToWeeks();
  });
}

async function finishRecDrag(targetDay, targetRoom, targetSlot) {
  const lesson = recDragState.lesson;
  const end = targetSlot + recDragState.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); clearRecDragState(); recDragStarted = false; return; }
  const conflictType = getRecDragConflictType(targetDay, targetRoom, targetSlot, end, lesson.id, lesson.teacher_id);
  if (conflictType === 'room')       { showToast('Кабинет уже занят в это время', 'error');         clearRecDragState(); recDragStarted = false; return; }
  if (conflictType === 'teacher')    { showToast('У вас уже есть занятие в это время', 'error');    clearRecDragState(); recDragStarted = false; return; }
  if (conflictType === 'students')   { showToast('Превышен лимит учеников в группе', 'error');      clearRecDragState(); recDragStarted = false; return; }
  if (conflictType === 'individual') { showToast('Нельзя смешивать индивидуальные и групповые', 'error'); clearRecDragState(); recDragStarted = false; return; }

  // Optimistic local update
  const newStart = recSlotToTimeStr(targetSlot);
  const newEnd = recSlotToTimeStr(end);
  const snapshot = { room: lesson.room, day_of_week: lesson.day_of_week, start_time: lesson.start_time, end_time: lesson.end_time };
  lesson.room = targetRoom; lesson.day_of_week = targetDay;
  lesson.start_time = newStart; lesson.end_time = newEnd;
  renderRecurringLessons();
  clearRecDragState(); recDragStarted = false;

  const { error } = await db.from('recurring_lessons').update({
    room: targetRoom, day_of_week: targetDay,
    start_time: newStart, end_time: newEnd
  }).eq('id', lesson.id);
  if (error) {
    // Revert
    Object.assign(lesson, snapshot);
    renderRecurringLessons();
    showToast('Ошибка', 'error'); return;
  }
  showToast('Занятие перенесено', 'success');
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

async function syncRecurringToWeeksManual(teacherFilter) {
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

    let eq = db.from('lessons').select('id, teacher_id, start_time, room, status, lesson_students(student_id)').eq('week_start', ws);
    if (filterTid) eq = eq.eq('teacher_id', filterTid);
    const { data: existing } = await eq;

    const existingByKey = {};
    (existing || []).forEach(l => {
      const s = new Date(l.start_time);
      const key = `${l.teacher_id}-${s.getDay()}-${l.room}-${s.getHours()}:${s.getMinutes()}`;
      existingByKey[key] = l;
    });

    for (const rl of recurring) {
      const dayDate = dates[rl.day_of_week];
      if (!dayDate) continue;
      const sp = rl.start_time.split(':');
      const ep = rl.end_time.split(':');
      const key = `${rl.teacher_id}-${dayDate.getDay()}-${rl.room}-${+sp[0]}:${+sp[1]}`;

      const ex = existingByKey[key];
      if (ex) {
        if (ex.status === 'active' && rl.recurring_lesson_students?.length > 0) {
          const existingSids = new Set((ex.lesson_students || []).map(ls => ls.student_id));
          const newSids = rl.recurring_lesson_students
            .map(rs => rs.student_id)
            .filter(sid => !existingSids.has(sid));
          if (newSids.length > 0) {
            await db.from('lesson_students').insert(newSids.map(sid => ({ lesson_id: ex.id, student_id: sid })));
          }
        }
        continue;
      }

      const sTime = new Date(dayDate); sTime.setHours(+sp[0], +sp[1], 0, 0);
      const eTime = new Date(dayDate); eTime.setHours(+ep[0], +ep[1], 0, 0);

      const { data: newLesson, error } = await db.from('lessons').insert({
        teacher_id: rl.teacher_id, room: rl.room, week_start: ws,
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();

      if (!error && newLesson && rl.recurring_lesson_students?.length > 0) {
        const sids = rl.recurring_lesson_students.map(rs => rs.student_id);
        await db.from('lesson_students').insert(
          sids.map(sid => ({ lesson_id: newLesson.id, student_id: sid }))
        );
        for (const sid of sids) await attachActiveSubscriptionIfAny(newLesson.id, sid, rl.teacher_id);
      }
    }
  }
}

function closeCopyOverlay() {
  document.getElementById('copy-overlay').classList.remove('active');
}

async function onCopyRecurringClick() {
  const isAdmin = state.profile.role === 'admin';
  if (!isAdmin) {
    showToast('Дублирование...', 'success');
    await syncRecurringToWeeksManual(state.user.id);
    showToast('Расписание дублировано', 'success');
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
      showToast('Дублирование...', 'success');
      await syncRecurringToWeeksManual(tid === 'all' ? null : tid);
      showToast('Расписание дублировано', 'success');
    });
  });
  document.getElementById('copy-overlay').classList.add('active');
}
