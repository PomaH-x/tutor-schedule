const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAY_NAMES_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const START_HOUR = 8;
const END_HOUR = 21;
const SLOT_MINUTES = 30;

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

function renderGrid() {
  const grid = document.getElementById('schedule-grid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = getWeekDates(state.currentWeekStart);

  const corner = document.createElement('div');
  corner.className = 'grid-corner';
  grid.appendChild(corner);

  dates.forEach((date, i) => {
    const header = document.createElement('div');
    header.className = 'grid-header';
    if (date.getTime() === today.getTime()) header.classList.add('grid-header-today');
    header.innerHTML = `<span class="day-name">${DAYS[i]}</span><span class="day-num">${date.getDate()}</span>`;
    grid.appendChild(header);
  });

  const totalSlots = (END_HOUR - START_HOUR) * 2;

  for (let slot = 0; slot < totalSlots; slot++) {
    const hour = START_HOUR + Math.floor(slot / 2);
    const min = (slot % 2) * 30;
    const isHour = min === 0;

    const timeCell = document.createElement('div');
    timeCell.className = 'grid-time';
    if (isHour) {
      timeCell.textContent = `${hour}:00`;
    }
    timeCell.style.gridRow = slot + 2;
    timeCell.style.gridColumn = 1;
    grid.appendChild(timeCell);

    for (let day = 0; day < 7; day++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      if (isHour) cell.classList.add('grid-cell-hour');
      cell.style.gridRow = slot + 2;
      cell.style.gridColumn = day + 2;
      cell.dataset.day = day;
      cell.dataset.slot = slot;
      grid.appendChild(cell);
    }
  }

  renderLessons();
}

async function loadLessons() {
  const weekStart = formatDate(state.currentWeekStart);

  const { data, error } = await db
    .from('lessons')
    .select(`
      *,
      teacher:profiles!teacher_id(short_name, color, full_name),
      lesson_students(student_id)
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

    const dayColumn = dayIndex + 2;
    const gridRowStart = startSlot + 2;
    const gridRowEnd = endSlot + 2;

    const card = document.createElement('div');
    card.className = 'lesson-card';
    card.dataset.lessonId = lesson.id;

    const color = lesson.teacher?.color || '#6c5ce7';
    card.style.background = color + '22';
    card.style.borderColor = color + '44';
    card.style.color = color;
    card.style.gridRow = `${gridRowStart} / ${gridRowEnd}`;
    card.style.gridColumn = dayColumn;

    const roomOffset = (lesson.room - 1);
    const roomWidth = 33.33;
    card.style.left = `${roomOffset * roomWidth + 1}%`;
    card.style.width = `${roomWidth - 1.5}%`;
    card.style.position = 'absolute';

    const studentCount = lesson.lesson_students?.length || 0;
    card.innerHTML = `
      <div class="lc-teacher">${lesson.teacher?.short_name || '?'}</div>
      <div class="lc-count">${studentCount} уч.</div>
    `;

    const dayCell = grid.querySelector(`.grid-cell[data-day="${dayIndex}"][data-slot="${Math.floor(startSlot)}"]`);
    if (dayCell) {
      dayCell.style.position = 'relative';
    }

    grid.style.position = 'relative';
    card.style.gridRow = `${gridRowStart} / ${gridRowEnd}`;
    card.style.gridColumn = `${dayColumn}`;
    grid.appendChild(card);
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
  state.currentWeekStart = getMonday(new Date());
  updateWeekLabel();
  renderGrid();
  loadLessons();

  document.getElementById('btn-prev-week').addEventListener('click', () => navigateWeek(-1));
  document.getElementById('btn-next-week').addEventListener('click', () => navigateWeek(1));
  document.getElementById('btn-today').addEventListener('click', goToToday);
}
