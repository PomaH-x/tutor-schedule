const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ROOM_LABELS = ['Л', 'Ц', 'П'];
const START_HOUR = 8;
const END_HOUR = 22;
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * 2;

let selecting = false;
let selStart = null;
let selEnd = null;
let scheduleInited = false;

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

  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const hour = START_HOUR + Math.floor(slot / 2);
    const min = (slot % 2) * 30;
    const isHour = min === 0;
    const row = rowForSlot(slot);

    const timeCell = document.createElement('div');
    timeCell.className = 'grid-time';
    if (isHour) timeCell.classList.add('grid-time-hour');
    timeCell.textContent = `${hour}:${min.toString().padStart(2, '0')}`;
    timeCell.style.gridRow = row;
    timeCell.style.gridColumn = '1';
    grid.appendChild(timeCell);

    for (let day = 0; day < 7; day++) {
      for (let room = 1; room <= 3; room++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        if (isHour) cell.classList.add('grid-cell-hour');
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

  initGridSelection(grid);
  renderLessons();
  renderNowLine();
}

function initGridSelection(grid) {
  grid.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    if (state.profile.role === 'student') return;

    selecting = true;
    selStart = {
      day: +cell.dataset.day,
      room: +cell.dataset.room,
      slot: +cell.dataset.slot
    };
    selEnd = { ...selStart };
    updateSelectionHighlight();
    e.preventDefault();
  });

  grid.addEventListener('mousemove', (e) => {
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

    openLessonModal({
      day: selStart.day,
      room: selStart.room,
      slotFrom,
      slotTo
    });
  });

  grid.addEventListener('mouseleave', () => {
    if (selecting) {
      selecting = false;
      clearSelectionHighlight();
    }
  });
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

function renderNowLine() {
  document.querySelectorAll('.now-line').forEach(el => el.remove());

  const now = new Date();
  const dates = getWeekDates(state.currentWeekStart);
  const todayIndex = dates.findIndex(d =>
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
  if (todayIndex === -1) return;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMin = START_HOUR * 60;
  const endMin = END_HOUR * 60;
  if (nowMinutes < startMin || nowMinutes > endMin) return;

  const slot = (nowMinutes - startMin) / SLOT_MINUTES;
  const row = rowForSlot(Math.floor(slot));
  const fraction = slot - Math.floor(slot);

  const grid = document.getElementById('schedule-grid');
  const line = document.createElement('div');
  line.className = 'now-line';
  const colStart = colForDayRoom(todayIndex, 1);
  const colEnd = colForDayRoom(todayIndex, 3) + 1;
  line.style.gridColumn = `${colStart} / ${colEnd}`;
  line.style.gridRow = row;
  line.style.top = `${fraction * 100}%`;
  grid.appendChild(line);
}

async function loadLessons() {
  const weekStart = formatDate(state.currentWeekStart);

  const { data, error } = await db
    .from('lessons')
    .select(`
      *,
      teacher:profiles!teacher_id(short_name, color, full_name),
      lesson_students(student_id, student:students(first_name, last_name))
    `)
    .eq('week_start', weekStart)
    .eq('status', 'active');

  if (error) {
    showToast('Ошибка загрузки расписания', 'error');
    return;
  }

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
      d.getFullYear() === start.getFullYear() &&
      d.getMonth() === start.getMonth() &&
      d.getDate() === start.getDate()
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

    const studentCount = lesson.lesson_students?.length || 0;
    card.innerHTML = `<div class="lc-teacher">${lesson.teacher?.short_name || '?'}</div><div class="lc-count">${studentCount} уч.</div>`;

    card.addEventListener('click', () => openEditLessonModal(lesson));
    grid.appendChild(card);
  });
}

function openLessonModal(sel) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[sel.day];
  const dayLabel = `${DAYS[sel.day]}, ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
  const roomLabel = ROOM_LABELS[sel.room - 1];
  const timeLabel = `${slotToTime(sel.slotFrom)} — ${slotToTime(sel.slotTo)}`;

  document.getElementById('lesson-modal-title').textContent = 'Новое занятие';
  document.getElementById('lesson-info-day').textContent = dayLabel;
  document.getElementById('lesson-info-room').textContent = `Кабинет: ${roomLabel}`;
  document.getElementById('lesson-info-time').textContent = timeLabel;
  document.getElementById('btn-delete-lesson').style.display = 'none';

  state.lessonModal = {
    mode: 'create',
    day: sel.day,
    room: sel.room,
    slotFrom: sel.slotFrom,
    slotTo: sel.slotTo,
    students: []
  };

  renderLessonStudents();
  document.getElementById('lesson-overlay').classList.add('active');
  document.getElementById('lesson-student-search').value = '';
  document.getElementById('lesson-student-search').focus();
}

function openEditLessonModal(lesson) {
  const start = new Date(lesson.start_time);
  const end = new Date(lesson.end_time);
  const dates = getWeekDates(state.currentWeekStart);
  const dayIndex = dates.findIndex(d =>
    d.getFullYear() === start.getFullYear() &&
    d.getMonth() === start.getMonth() &&
    d.getDate() === start.getDate()
  );

  const dayLabel = dayIndex >= 0 ? `${DAYS[dayIndex]}, ${start.getDate()} ${MONTHS_SHORT[start.getMonth()]}` : '';
  const roomLabel = ROOM_LABELS[lesson.room - 1];
  const startSlot = (start.getHours() * 60 + start.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const endSlot = (end.getHours() * 60 + end.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
  const timeLabel = `${slotToTime(startSlot)} — ${slotToTime(endSlot)}`;

  document.getElementById('lesson-modal-title').textContent = 'Редактировать занятие';
  document.getElementById('lesson-info-day').textContent = dayLabel;
  document.getElementById('lesson-info-room').textContent = `Кабинет: ${roomLabel}`;
  document.getElementById('lesson-info-time').textContent = timeLabel;

  const canEdit = state.profile.role === 'admin' || lesson.teacher_id === state.user.id;
  document.getElementById('btn-delete-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('btn-save-lesson').style.display = canEdit ? 'block' : 'none';
  document.getElementById('lesson-student-search').parentElement.style.display = canEdit ? 'block' : 'none';

  const students = (lesson.lesson_students || []).map(ls => ({
    id: ls.student_id,
    first_name: ls.student?.first_name || '',
    last_name: ls.student?.last_name || ''
  }));

  state.lessonModal = {
    mode: 'edit',
    lessonId: lesson.id,
    teacherId: lesson.teacher_id,
    day: dayIndex,
    room: lesson.room,
    slotFrom: startSlot,
    slotTo: endSlot,
    students: students
  };

  renderLessonStudents();
  document.getElementById('lesson-overlay').classList.add('active');
  document.getElementById('lesson-student-search').value = '';
}

function closeLessonModal() {
  document.getElementById('lesson-overlay').classList.remove('active');
  state.lessonModal = null;
  document.getElementById('lesson-search-results').innerHTML = '';
}

function renderLessonStudents() {
  const list = document.getElementById('lesson-students-list');
  const students = state.lessonModal.students;

  if (students.length === 0) {
    list.innerHTML = '<div class="lesson-no-students">Нет учеников</div>';
    return;
  }

  list.innerHTML = students.map(s =>
    `<div class="lesson-student-chip">
      <span>${s.first_name} ${s.last_name}</span>
      <button class="chip-remove" data-student-id="${s.id}">×</button>
    </div>`
  ).join('');

  list.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.lessonModal.students = state.lessonModal.students.filter(s => s.id !== btn.dataset.studentId);
      renderLessonStudents();
    });
  });
}

async function searchLessonStudents(query) {
  const resultsEl = document.getElementById('lesson-search-results');
  if (!query || query.length < 1) {
    resultsEl.innerHTML = '';
    return;
  }

  const teacherId = state.lessonModal.mode === 'edit' ? state.lessonModal.teacherId : state.user.id;
  const { data } = await db
    .from('students')
    .select('id, first_name, last_name')
    .eq('teacher_id', teacherId)
    .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%`)
    .limit(5);

  const existing = state.lessonModal.students.map(s => s.id);
  const filtered = (data || []).filter(s => !existing.includes(s.id));

  if (filtered.length === 0) {
    resultsEl.innerHTML = '<div class="search-no-results">Не найдено</div>';
    return;
  }

  resultsEl.innerHTML = filtered.map(s =>
    `<div class="search-result-item" data-id="${s.id}" data-first="${s.first_name}" data-last="${s.last_name}">
      ${s.first_name} ${s.last_name}
    </div>`
  ).join('');

  resultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      if (state.lessonModal.students.length >= 4) {
        showToast('Максимум 4 ученика', 'error');
        return;
      }
      state.lessonModal.students.push({
        id: item.dataset.id,
        first_name: item.dataset.first,
        last_name: item.dataset.last
      });
      renderLessonStudents();
      document.getElementById('lesson-student-search').value = '';
      resultsEl.innerHTML = '';
    });
  });
}

async function checkConflict(day, room, slotFrom, slotTo, excludeId) {
  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[day];
  const weekStart = formatDate(state.currentWeekStart);

  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(slotFrom * SLOT_MINUTES / 60), (slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(slotTo * SLOT_MINUTES / 60), (slotTo * SLOT_MINUTES) % 60, 0, 0);

  let query = db
    .from('lessons')
    .select('id')
    .eq('week_start', weekStart)
    .eq('room', room)
    .eq('status', 'active')
    .lt('start_time', endTime.toISOString())
    .gt('end_time', startTime.toISOString());

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data } = await query;
  return data && data.length > 0;
}

async function saveLesson() {
  const m = state.lessonModal;
  if (!m) return;

  const btn = document.getElementById('btn-save-lesson');
  btn.disabled = true;

  const conflict = await checkConflict(m.day, m.room, m.slotFrom, m.slotTo, m.mode === 'edit' ? m.lessonId : null);
  if (conflict) {
    showToast('Кабинет занят в это время', 'error');
    btn.disabled = false;
    return;
  }

  const dates = getWeekDates(state.currentWeekStart);
  const date = dates[m.day];
  const weekStart = formatDate(state.currentWeekStart);

  const startTime = new Date(date);
  startTime.setHours(START_HOUR + Math.floor(m.slotFrom * SLOT_MINUTES / 60), (m.slotFrom * SLOT_MINUTES) % 60, 0, 0);
  const endTime = new Date(date);
  endTime.setHours(START_HOUR + Math.floor(m.slotTo * SLOT_MINUTES / 60), (m.slotTo * SLOT_MINUTES) % 60, 0, 0);

  if (m.mode === 'create') {
    const { data, error } = await db
      .from('lessons')
      .insert({
        teacher_id: state.user.id,
        room: m.room,
        week_start: weekStart,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        status: 'active'
      })
      .select()
      .single();

    if (error) {
      showToast('Ошибка создания занятия', 'error');
      btn.disabled = false;
      return;
    }

    if (m.students.length > 0) {
      const links = m.students.map(s => ({ lesson_id: data.id, student_id: s.id }));
      await db.from('lesson_students').insert(links);
    }

    showToast('Занятие создано', 'success');
  } else {
    const { error } = await db
      .from('lessons')
      .update({
        room: m.room,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString()
      })
      .eq('id', m.lessonId);

    if (error) {
      showToast('Ошибка сохранения', 'error');
      btn.disabled = false;
      return;
    }

    await db.from('lesson_students').delete().eq('lesson_id', m.lessonId);
    if (m.students.length > 0) {
      const links = m.students.map(s => ({ lesson_id: m.lessonId, student_id: s.id }));
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
    if (error) {
      showToast('Ошибка удаления', 'error');
      return;
    }
    showToast('Занятие удалено', 'success');
    await loadLessons();
  });
}

function navigateWeek(offset) {
  const d = new Date(state.currentWeekStart);
  d.setDate(d.getDate() + offset * 7);
  state.currentWeekStart = d;
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
  if (scheduleInited) {
    renderGrid();
    loadLessons();
    return;
  }

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
    searchTimeout = setTimeout(() => searchLessonStudents(e.target.value.trim()), 200);
  });

  document.getElementById('lesson-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLessonModal();
  });

  setInterval(renderNowLine, 60000);
  scheduleInited = true;
}
