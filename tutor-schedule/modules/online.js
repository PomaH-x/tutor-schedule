let onlineWeekOffset = 0;
let onlineLessons = [];
let onlineStudents = [];
let onlineSelectedStudentId = null;
let onlineEditId = null;

const DAYS_ONLINE = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAYS_ONLINE_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function getOnlineWeekStart() {
  const now = getMonday(new Date());
  const d = new Date(now);
  d.setDate(d.getDate() + onlineWeekOffset * 7);
  return d;
}

function updateOnlineWeekTabs() {
  document.querySelectorAll('#online-week-tabs .week-tab').forEach(tab => {
    tab.classList.toggle('active', +tab.dataset.offset === onlineWeekOffset);
  });
}

async function loadOnlineLessons() {
  const ws = formatDate(getOnlineWeekStart());
  const isAdmin = state.profile.role === 'admin';
  let q = db.from('lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name), lesson_students(student_id, student:students(first_name, last_name, subject, is_individual, is_online, price_type))')
    .eq('week_start', ws).eq('room', 0).eq('status', 'active');
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);
  const { data, error } = await q;
  if (error) console.error('Online load error:', error);
  onlineLessons = (data || []).filter(l => l.lesson_students?.length > 0);
  renderOnlineLessons();
}

function renderOnlineLessons() {
  const container = document.getElementById('online-lessons-list');
  if (!container) return;

  if (onlineLessons.length === 0) {
    container.innerHTML = '<div class="online-empty">Нет онлайн-занятий на этой неделе</div>';
    return;
  }

  const sorted = [...onlineLessons].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const ws = getOnlineWeekStart();
  const dates = getWeekDates(ws);

  let html = '';
  sorted.forEach(l => {
    const start = new Date(l.start_time);
    const end = new Date(l.end_time);
    const dayIdx = start.getDay() === 0 ? 6 : start.getDay() - 1;
    const dayName = DAYS_ONLINE[dayIdx];
    const dayShort = DAYS_ONLINE_SHORT[dayIdx];
    const dd = start.getDate().toString().padStart(2, '0');
    const mm = (start.getMonth() + 1).toString().padStart(2, '0');
    const timeStart = `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}`;
    const timeEnd = `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
    const durMin = Math.round((end - start) / 60000);
    const students = l.lesson_students || [];
    const color = l.teacher?.color || '#1e6fe8';

    html += `<div class="online-card" data-lesson-id="${l.id}" style="border-left: 3px solid ${color}">
      <div class="online-card-header">
        <span class="online-card-day">${dayName}, ${dd}.${mm}</span>
        <span class="online-card-time">${timeStart} – ${timeEnd}</span>
        <span class="online-card-dur">${durMin} мин</span>
      </div>
      <div class="online-card-students">`;
    students.forEach(ls => {
      const s = ls.student;
      if (!s) return;
      html += `<div class="online-card-student">
        <span class="online-student-name">${s.first_name} ${s.last_name}</span>
        <span class="online-student-subject">${s.subject || ''}</span>
        <button class="online-cancel-btn" data-lesson-id="${l.id}" data-student-id="${ls.student_id}" data-name="${s.first_name} ${s.last_name}" title="Отменить ученика">✕</button>
      </div>`;
    });
    html += `</div>
      <div class="online-card-actions">
        <button class="btn-sm btn-danger" data-delete="${l.id}" title="Расформировать">Расформировать</button>
      </div>
    </div>`;
  });

  container.innerHTML = html;

  container.querySelectorAll('.online-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lid = btn.dataset.lessonId;
      const sid = btn.dataset.studentId;
      const name = btn.dataset.name;
      const lesson = onlineLessons.find(l => l.id === lid);
      showConfirm(`Отменить ${name}?`, async () => {
        await db.from('lesson_students').delete().eq('lesson_id', lid).eq('student_id', sid);
        const ws = lesson?.week_start || formatDate(getOnlineWeekStart());
        const startTime = lesson?.start_time || null;
        const startDay = startTime ? (new Date(startTime).getDay() === 0 ? 6 : new Date(startTime).getDay() - 1) : null;
        const { error: cancelErr } = await db.from('cancellations').insert({
          student_id: sid, teacher_id: lesson?.teacher_id || state.user.id,
          week_start: ws, status: 'pending',
          lesson_start_time: startTime, lesson_day: startDay
        });
        if (cancelErr) console.error('Cancel insert error:', cancelErr);
        const { data: remaining } = await db.from('lesson_students').select('student_id').eq('lesson_id', lid);
        if (!remaining || remaining.length === 0) {
          await db.from('lessons').delete().eq('id', lid);
        }
        showToast('Ученик отменён', 'success');
        await loadOnlineLessons();
      }, 'Отменить');
    });
  });

  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const lid = btn.dataset.delete;
      showConfirm('Расформировать занятие?', async () => {
        await db.from('lesson_students').delete().eq('lesson_id', lid);
        await db.from('lessons').delete().eq('id', lid);
        showToast('Занятие расформировано', 'success');
        await loadOnlineLessons();
      }, 'Расформировать');
    });
  });
}

function openOnlineCreateModal() {
  onlineSelectedStudentId = null;
  onlineEditId = null;
  document.getElementById('online-modal-title').textContent = 'Добавить онлайн-занятие';
  document.getElementById('online-day').value = '0';
  document.getElementById('online-start').value = '14:00';
  document.getElementById('online-end').value = '16:00';
  loadOnlineStudents();
  document.getElementById('online-create-overlay').classList.add('active');
}

function closeOnlineModal() {
  document.getElementById('online-create-overlay').classList.remove('active');
}

async function loadOnlineStudents() {
  const tid = state.user.id;
  const { data } = await db.from('students').select('id, first_name, last_name, subject, is_individual, is_online, price_type')
    .eq('teacher_id', tid).eq('is_online', true).order('first_name');
  onlineStudents = data || [];

  const list = document.getElementById('online-student-list');
  list.innerHTML = onlineStudents.map(s => {
    const sel = onlineSelectedStudentId === s.id;
    return `<label class="lesson-student-row${sel ? ' checked' : ''}">
      <span class="lesson-student-name">${s.first_name} ${s.last_name}<span class="lesson-online-badge">Онл.</span></span>
      <input type="radio" name="online-student" class="lesson-checkbox" data-id="${s.id}" ${sel ? 'checked' : ''}>
    </label>`;
  }).join('') || '<div class="lesson-no-students">Нет онлайн-учеников</div>';

  list.querySelectorAll('input[name="online-student"]').forEach(r => {
    r.addEventListener('change', () => { onlineSelectedStudentId = r.dataset.id; });
  });
}

async function saveOnlineLesson() {
  if (!onlineSelectedStudentId) { showToast('Выберите ученика', 'error'); return; }
  const day = +document.getElementById('online-day').value;
  const startVal = document.getElementById('online-start').value;
  const endVal = document.getElementById('online-end').value;
  if (!startVal || !endVal) { showToast('Укажите время', 'error'); return; }

  const sp = startVal.split(':'); const ep = endVal.split(':');
  const startMin = +sp[0] * 60 + +sp[1];
  const endMin = +ep[0] * 60 + +ep[1];
  if (endMin <= startMin) { showToast('Конец должен быть позже начала', 'error'); return; }

  const durationMin = endMin - startMin;
  const student = onlineStudents.find(s => s.id === onlineSelectedStudentId);
  if (student && !findPricing(durationMin, student.is_individual || false, student.price_type || 'new', student.is_online || false)) {
    showToast(`Нет тарифа для ${durationMin} мин`, 'error'); return;
  }

  const currentWs = getOnlineWeekStart();
  const weeks = [currentWs];
  // Auto-create for next week and 2 weeks ahead on current week
  if (onlineWeekOffset === 0) {
    const nw = new Date(currentWs); nw.setDate(nw.getDate() + 7); weeks.push(nw);
    const nw2 = new Date(currentWs); nw2.setDate(nw2.getDate() + 14); weeks.push(nw2);
  }

  closeOnlineModal();

  for (const weekStart of weeks) {
    const dates = getWeekDates(weekStart);
    const date = dates[day];
    const sTime = new Date(date); sTime.setHours(+sp[0], +sp[1], 0, 0);
    const eTime = new Date(date); eTime.setHours(+ep[0], +ep[1], 0, 0);
    const ws = formatDate(weekStart);

    // Dedup check
    const { data: existing } = await db.from('lessons')
      .select('id').eq('week_start', ws).eq('teacher_id', state.user.id)
      .eq('room', 0).eq('start_time', sTime.toISOString());
    if (existing?.length > 0) continue;

    const { data: newLesson, error } = await db.from('lessons').insert({
      teacher_id: state.user.id, room: 0, week_start: ws,
      start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
    }).select().single();

    if (error) { console.error('Online save error:', error); showToast('Ошибка: ' + error.message, 'error'); return; }
    if (newLesson) {
      const { error: e2 } = await db.from('lesson_students').insert({ lesson_id: newLesson.id, student_id: onlineSelectedStudentId });
      if (e2) { console.error('Student link error:', e2); }
    }
  }

  showToast(onlineWeekOffset === 0 ? 'Занятие создано на 3 недели' : 'Занятие создано', 'success');
  await loadOnlineLessons();
}

function initOnline() {
  document.getElementById('btn-to-online').addEventListener('click', () => {
    showScreen('screen-online');
    onlineWeekOffset = 0;
    updateOnlineWeekTabs();
    loadOnlineLessons();
  });

  document.getElementById('btn-online-to-current').addEventListener('click', () => {
    showScreen('screen-schedule');
  });

  document.querySelectorAll('#online-week-tabs .week-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      onlineWeekOffset = +tab.dataset.offset;
      updateOnlineWeekTabs();
      loadOnlineLessons();
    });
  });

  document.getElementById('btn-add-online').addEventListener('click', openOnlineCreateModal);
  document.getElementById('btn-close-online-modal').addEventListener('click', closeOnlineModal);
  document.getElementById('btn-cancel-online').addEventListener('click', closeOnlineModal);
  document.getElementById('btn-save-online').addEventListener('click', saveOnlineLesson);
  document.getElementById('online-create-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeOnlineModal();
  });

  document.getElementById('btn-profile-online').addEventListener('click', () => showScreen('screen-profile'));
}
