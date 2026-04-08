const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ROOM_LABELS = ['Л', 'Ц', 'П'];
const ROOM_FULL = ['Левый', 'Центральный', 'Правый'];
const START_HOUR = 8;
const END_HOUR = 22;
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * 2;

let selecting = false;
let selStart = null;
let selEnd = null;
let scheduleInited = false;
let hoveredTooltip = null;
let allTeacherStudents = [];

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
  const from = formatDateShort(dates[0]);
  const to = formatDateShort(dates[6]);
  document.getElementById('current-week-label').textContent = `${from} — ${to}`;
}

function colForDayRoom(dayIndex, room) {
  return dayIndex * 3 + room + 1;
}

function rowForSlot(slot) {
  return slot + 3;
}

function slotToTime(slot) {
  const totalMin = START_HOUR * 60 + slot * SLOT_MINUTES;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${m.toString().padStart(2, '0')}`;
}

function renderGrid() {
  const grid = document.getElementById('schedule-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = getWeekDates(state.currentWeekStart);

  grid.style.gridTemplateColumns = `50px repeat(21, 1fr)`;
  grid.style.gridTemplateRows = `40px 24px repeat(${TOTAL_SLOTS}, 28px)`;

  const corner = document.createElement('div');
  corner.className = 'grid-corner';
  corner.style.gridRow = '1 / 3';
  corner.style.gridColumn = '1';
  grid.appendChild(corner);

  dates.forEach((date, i) => {
    const header = document.createElement('div');
    header.className = 'grid-header';
    if (date.getTime() === today.getTime()) header.classList.add('grid-header-today');
    const col = colForDayRoom(i, 1);
    header.style.gridColumn = `${col} / ${col + 3}`;
    header.style.gridRow = '1';
    header.innerHTML = `<span class="day-name">${DAYS[i]}</span><span class="day-num">${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}</span>`;
    grid.appendChild(header);

    for (let r = 0; r < 3; r++) {
      const roomLabel = document.createElement('div');
      roomLabel.className = 'grid-room-label';
      if (date.getTime() === today.getTime()) roomLabel.classList.add('grid-room-label-today');
      roomLabel.style.gridColumn = `${colForDayRoom(i, r + 1)}`;
      roomLabel.style.gridRow = '2';
      roomLabel.textContent = ROOM_LABELS[r];
      grid.appendChild(roomLabel);
    }
  });

  for (let slot = 0; slot <= TOTAL_SLOTS; slot++) {
    const hour = START_HOUR + Math.floor(slot / 2);
    const min = (slot % 2) * 30;
    const row = rowForSlot(slot);

    const timeCell = document.createElement('div');
    timeCell.className = 'grid-time';
    timeCell.textContent = `${hour}:${min.toString().padStart(2, '0')}`;
    timeCell.style.gridRow = row;
    timeCell.style.gridColumn = '1';
    timeCell.dataset.slot = slot;
    grid.appendChild(timeCell);

    if (slot === TOTAL_SLOTS) break;

    for (let day = 0; day < 7; day++) {
      for (let room = 1; room <= 3; room++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        if (min === 0) cell.classList.add('grid-cell-hour');
        if (room === 3) cell.classList.add('grid-cell-day-end');
        cell.style.gridRow = row;
        cell.style.gridColumn = colForDayRoom(day, room);
        cell.dataset.day = day;
        cell.dataset.room = room;
        cell.dataset.slot = slot;
        grid.appendChild(cell);
      }
    }
  }

  initGridInteractions(grid);
  renderLessons();
  renderNowTime();
}

function initGridInteractions(grid) {
  grid.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    if (state.profile.role === 'student') return;

    selecting = true;
    selStart = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    selEnd = { ...selStart };
    updateSelectionHighlight();
    e.preventDefault();
  });

  grid.addEventListener('mousemove', (e) => {
    handleCellTooltip(e, grid);
    if (!selecting) return;
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    if (+cell.dataset.day !== selStart.day || +cell.dataset.room !== selStart.room) return;
    selEnd = { day: +cell.dataset.day, room: +cell.dataset.room, slot: +cell.dataset.slot };
    updateSelectionHighlight();
  });

  grid.addEventListener('mouseup', () => {
    if (!selecting) return;
    selecting = false;
    clearSelectionHighlight();
    if (!selStart) return;

    const slotFrom = Math.min(selStart.slot, selEnd.slot);
    const slotTo = Math.max(selStart.slot, selEnd.slot) + 1;
    openLessonModal({ day: selStart.day, room: selStart.room, slotFrom, slotTo });
  });

  grid.addEventListener('mouseleave', () => {
    if (selecting) { selecting = false; clearSelectionHighlight(); }
    removeCellTooltip();
  });
}

function handleCellTooltip(e, grid) {
  const cell = e.target.closest('.grid-cell');
  if (!cell) { removeCellTooltip(); return; }

  const slot = +cell.dataset.slot;
  const room = +cell.dataset.room;
  const time = slotToTime(slot);
  const roomName = ROOM_FULL[room - 1];
  const text = `${time} ${roomName}`;

  if (!hoveredTooltip) {
    hoveredTooltip = document.createElement('div');
    hoveredTooltip.className = 'cell-tooltip';
    document.body.appendChild(hoveredTooltip);
  }

  hoveredTooltip.textContent = text;
  const rect = cell.getBoundingClientRect();
  hoveredTooltip.style.left = `${rect.right + 8}px`;
  hoveredTooltip.style.top = `${rect.top + rect.height / 2}px`;

  if (!selecting) {
    document.querySelectorAll('.grid-cell-hover').forEach(c => c.classList.remove('grid-cell-hover'));
    cell.classList.add('grid-cell-hover');
  }
}

function removeCellTooltip() {
  if (hoveredTooltip) { hoveredTooltip.remove(); hoveredTooltip = null; }
  document.querySelectorAll('.grid-cell-hover').forEach(c => c.classList.remove('grid-cell-hover'));
}

function updateSelectionHighlight() {
  clearSelectionHighlight();
  if (!selStart || !selEnd) return;
  const grid = document.getElementById('schedule-grid');
  const slotFrom = Math.min(selStart.slot, selEnd.slot);
  const slotTo = Math.max(selStart.slot, selEnd.slot);
  for (let s = slotFrom; s <= slotTo; s++) {
    const cell = grid.querySelector(`.grid-cell[data-day="${selStart.day}"][data-room="${selStart.room}"][data-slot="${s}"]`);
    if (cell) cell.classList.add('grid-cell-selected');
  }
}

function clearSelectionHighlight() {
  document.querySelectorAll('.grid-cell-selected').forEach(c => c.classList.remove('grid-cell-selected'));
}

function renderNowTime() {
  document.querySelectorAll('.grid-time-now').forEach(el => el.classList.remove('grid-time-now'));

  const now = new Date();
  const dates = getWeekDates(state.currentWeekStart);
  const todayIndex = dates.findIndex(d =>
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  );
  if (todayIndex === -1) return;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMin = START_HOUR * 60;
  const endMin = END_HOUR * 60;
  if (nowMinutes < startMin || nowMinutes > endMin) return;

  const slot = Math.floor((nowMinutes - startMin) / SLOT_MINUTES);
  const grid = document.getElementById('schedule-grid');
  const timeCell = grid.querySelector(`.grid-time[data-slot="${slot}"]`);
  if (timeCell) {
    const h = now.getHours();
    const m = now.getMinutes();
    timeCell.textContent = `${h}:${m.toString().padStart(2, '0')}`;
    timeCell.classList.add('grid-time-now');
  }
}

async function loadLessons() {
  const weekStart = formatDate(state.currentWeekStart);
  const { data, error } = await db
    .from('lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name), lesson_students(student_id, student:students(first_name, last_name, subject))')
    .eq('week_start', weekStart)
    .eq('status', 'active');

  if (error) { showToast('Ошибка загрузки расписания', 'error'); return; }
  state.lessons = data || [];
  renderLessons();
}

function renderLessons() {
  document.querySelectorAll('.lesson-card').forEach(el => el.remove());
  const grid = document.getElementById('schedule-grid');
  const dates = getWeekDates(state.currentWeekStart);

  state.lessons.forEach(lesson => {
    const start = new Date(lesson.start_time);
    const end = new Date(lesson.end_time);
    const dayIndex = dates.findIndex(d =>
      d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth() && d.getDate() === start.getDate()
    );
    if (dayIndex === -1) return;

    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const endMinutes = end.getHours() * 60 + end.getMinutes();
    const startSlot = (startMinutes - START_HOUR * 60) / SLOT_MINUTES;
    const endSlot = (endMinutes - START_HOUR * 60) / SLOT_MINUTES;
    if (startSlot < 0 || endSlot < 0) return;

    const col = colForDayRoom(dayIndex, lesson.room);
    const rowStart = rowForSlot(startSlot);
    const rowEnd = rowForSlot(endSlot);

    const card = document.createElement('div');
    card.className = 'lesson-card';
    card.dataset.lessonId = lesson.id;

    const color = lesson.teacher?.color || '#6c5ce7';
    card.style.background = color + '22';
    card.style.borderColor = color + '55';
    card.style.color = color;
    card.style.gridRow = `${rowStart} / ${rowEnd}`;
    card.style.gridColumn = col;

    const shortName = (lesson.teacher?.short_name || '??').replace(/\./g, '');
    const studentCount = lesson.lesson_students?.length || 0;
    card.innerHTML = `<div class="lc-teacher">${shortName}</div><div class="lc-count">${studentCount}<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`;

    card.addEventListener('click', (e) => { e.stopPropagation(); openEditLessonModal(lesson); });
    grid.appendChild(card);
  });
}

function buildModalTitle(dayIndex, room, slotFrom, slotTo) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[dayIndex];
  const dayName = DAYS[dayIndex];
  const dayNum = date.getDate();
  const month = MONTHS_SHORT[date.getMonth()];
  const roomName = ROOM_FULL[room - 1];
  const time = `${slotToTime(slotFrom)}–${slotToTime(slotTo)}`;
  return `${dayName}, ${dayNum} ${month} · ${roomName} · ${time}`;
}

async function loadTeacherStudentsForModal(teacherId) {
  const { data } = await db
    .from('students')
    .select('id, first_name, last_name, subject')
    .eq('teacher_id', teacherId)
    .order('first_name');
  allTeacherStudents = data || [];
}

function openLessonModal(sel) {
  const title = buildModalTitle(sel.day, sel.room, sel.slotFrom, sel.slotTo);
  document.getElementById('lesson-modal-title').textContent = title;
  document.getElementById('btn-delete-lesson').style.display = 'none';
  document.getElementById('btn-save-lesson').style.display = 'block';
  document.getElementById('lesson-student-search').parentElement.style.display = 'block';

  state.lessonModal = {
    mode: 'create',
    day: sel.day,
    room: sel.room,
    slotFrom: sel.slotFrom,
    slotTo: sel.slotTo,
    selectedIds: new Set()
  };

  loadTeacherStudentsForModal(state.user.id).then(() => {
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
    document.getElementById('lesson-student-search').focus();
  });
}

function openEditLessonModal(lesson) {
  const start = new Date(lesson.start_time);
  const end = new Date(lesson.end_time);
  const dates = getWeekDates(state.currentWeekStart);
  const dayIndex = dates.findIndex(d =>
    d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth() && d.getDate() === start.getDate()
  );

  const startSlot = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const endSlot = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;

  const title = buildModalTitle(dayIndex, lesson.room, startSlot, endSlot);
  document.getElementById('lesson-modal-title').textContent = title;

  const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
  document.getElementById('btn-delete-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('btn-save-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('lesson-student-search').parentElement.style.display = canEdit ? 'block' : 'none';

  const selectedIds = new Set((lesson.lesson_students || []).map(ls => ls.student_id));

  state.lessonModal = {
    mode: 'edit',
    lessonId: lesson.id,
    teacherId: lesson.teacher_id,
    day: dayIndex,
    room: lesson.room,
    slotFrom: startSlot,
    slotTo: endSlot,
    selectedIds
  };

  loadTeacherStudentsForModal(lesson.teacher_id).then(() => {
    renderLessonStudentsList('');
    document.getElementById('lesson-overlay').classList.add('active');
    document.getElementById('lesson-student-search').value = '';
  });
}

function closeLessonModal() {
  document.getElementById('lesson-overlay').classList.remove('active');
  state.lessonModal = null;
  allTeacherStudents = [];
}

function renderLessonStudentsList(filter) {
  const list = document.getElementById('lesson-students-list');
  const m = state.lessonModal;
  if (!m) return;

  const search = filter.toLowerCase();
  let students = allTeacherStudents;
  if (search) {
    students = students.filter(s =>
      s.first_name.toLowerCase().includes(search) || s.last_name.toLowerCase().includes(search)
    );
  }

  if (students.length === 0) {
    list.innerHTML = '<div class="lesson-no-students">Нет учеников</div>';
    return;
  }

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
        if (cb.checked) {
          if (m.selectedIds.size >= 4) {
            cb.checked = false;
            showToast('Максимум 4 ученика', 'error');
            return;
          }
          m.selectedIds.add(id);
        } else {
          m.selectedIds.delete(id);
        }
        cb.closest('.lesson-student-row').classList.toggle('checked', cb.checked);
      });
    });
  }
}

async function checkConflict(day, room, slotFrom, slotTo, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day];
  const weekStart = formatDate(state.currentWeekStart);

  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(slotFrom * SLOT_MINUTES / 60), (slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(slotTo * SLOT_MINUTES / 60), (slotTo * SLOT_MINUTES) % 60, 0, 0);

  let query = db.from('lessons').select('id')
    .eq('week_start', weekStart).eq('room', room).eq('status', 'active')
    .lt('start_time', endTime.toISOString()).gt('end_time', startTime.toISOString());
  if (excludeId) query = query.neq('id', excludeId);

  const { data } = await query;
  return data && data.length > 0;
}

async function saveLesson() {
  const m = state.lessonModal;
  if (!m) return;

  const btn = document.getElementById('btn-save-lesson');
  btn.disabled = true;

  const conflict = await checkConflict(m.day, m.room, m.slotFrom, m.slotTo, m.mode === 'edit' ? m.lessonId : null);
  if (conflict) { showToast('Кабинет занят в это время', 'error'); btn.disabled = false; return; }

  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[m.day];
  const weekStart = formatDate(state.currentWeekStart);

  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(m.slotFrom * SLOT_MINUTES / 60), (m.slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(m.slotTo * SLOT_MINUTES / 60), (m.slotTo * SLOT_MINUTES) % 60, 0, 0);

  const studentIds = Array.from(m.selectedIds);

  if (m.mode === 'create') {
    const { data, error } = await db.from('lessons').insert({
      teacher_id: state.user.id, room: m.room, week_start: weekStart,
      start_time: startTime.toISOString(), end_time: endTime.toISOString(), status: 'active'
    }).select().single();

    if (error) { showToast('Ошибка создания занятия', 'error'); btn.disabled = false; return; }

    if (studentIds.length > 0) {
      const links = studentIds.map(sid => ({ lesson_id: data.id, student_id: sid }));
      await db.from('lesson_students').insert(links);
    }
    showToast('Занятие создано', 'success');
  } else {
    const { error } = await db.from('lessons').update({
      room: m.room, start_time: startTime.toISOString(), end_time: endTime.toISOString()
    }).eq('id', m.lessonId);

    if (error) { showToast('Ошибка сохранения', 'error'); btn.disabled = false; return; }

    await db.from('lesson_students').delete().eq('lesson_id', m.lessonId);
    if (studentIds.length > 0) {
      const links = studentIds.map(sid => ({ lesson_id: m.lessonId, student_id: sid }));
      await db.from('lesson_students').insert(links);
    }
    showToast('Занятие обновлено', 'success');
  }

  btn.disabled = false;
  closeLessonModal();
  await loadLessons();
}

async function deleteLesson() {
  const m = state.lessonModal;
  if (!m || m.mode !== 'edit') return;
  const lessonId = m.lessonId;
  closeLessonModal();

  showConfirm('Удалить занятие?', async () => {
    await db.from('lesson_students').delete().eq('lesson_id', lessonId);
    const { error } = await db.from('lessons').delete().eq('id', lessonId);
    if (error) { showToast('Ошибка удаления', 'error'); return; }
    showToast('Занятие удалено', 'success');
    await loadLessons();
  });
}

function navigateWeek(offset) {
  const target = new Date(state.currentWeekStart);
  target.setDate(target.getDate() + offset * 7);

  const now = getMonday(new Date());
  const diffWeeks = Math.round((target - now) / (7 * 24 * 60 * 60 * 1000));
  if (diffWeeks < -2 || diffWeeks > 2) {
    showToast('Доступны только 2 недели назад и вперёд', 'error');
    return;
  }

  state.currentWeekStart = target;
  updateWeekLabel();
  renderGrid();
  loadLessons();
}

function goToToday() {
  state.currentWeekStart = getMonday(new Date());
  updateWeekLabel();
  renderGrid();
  loadLessons();
}

function initSchedule() {
  if (scheduleInited) { renderGrid(); loadLessons(); return; }

  state.currentWeekStart = getMonday(new Date());
  updateWeekLabel();
  renderGrid();
  loadLessons();

  document.getElementById('btn-prev-week').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('btn-next-week').addEventListener('click', () => navigateWeek(1));
  document.getElementById('btn-today').addEventListener('click', goToToday);

  document.getElementById('btn-save-lesson').addEventListener('click', saveLesson);
  document.getElementById('btn-cancel-lesson').addEventListener('click', closeLessonModal);
  document.getElementById('btn-close-lesson').addEventListener('click', closeLessonModal);
  document.getElementById('btn-delete-lesson').addEventListener('click', deleteLesson);

  let searchTimeout;
  document.getElementById('lesson-student-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => renderLessonStudentsList(e.target.value.trim()), 150);
  });

  document.getElementById('lesson-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLessonModal();
  });

  setInterval(renderNowTime, 30000);
  scheduleInited = true;
}
