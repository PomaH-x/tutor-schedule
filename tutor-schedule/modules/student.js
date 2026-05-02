let studentWeekOffset = 0;
let studentHistoryMonthOffset = 0;
let studentRecord = null;

const STUDENT_DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const STUDENT_DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const STUDENT_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function getRoomLabel(room) {
  if (room === 0) return 'Онлайн';
  return ['Левый', 'Центральный', 'Правый'][room - 1] || 'Кабинет';
}

function getStudentWeekStart() {
  const now = getMonday(new Date());
  const d = new Date(now);
  d.setDate(d.getDate() + studentWeekOffset * 7);
  return d;
}

function updateStudentWeekTabs() {
  document.querySelectorAll('#student-week-tabs .week-tab').forEach(tab => {
    tab.classList.toggle('active', +tab.dataset.offset === studentWeekOffset);
  });
}

async function loadStudentRecord() {
  if (studentRecord) return studentRecord;
  const { data, error } = await db.from('students')
    .select('id, first_name, last_name, subject, grade, is_individual, is_online, price_type, teacher_id, profile_id')
    .eq('profile_id', state.user.id)
    .single();
  if (error) console.error('loadStudentRecord error:', error);
  studentRecord = data;
  return data;
}

async function fetchStudentLessons(weekStartDate, weekEndDate) {
  const student = await loadStudentRecord();
  if (!student) return { lessons: [], cancellations: [], payments: [] };

  const ws = formatDate(weekStartDate);
  const we = formatDate(weekEndDate);

  const lessonsQ = db.from('lessons')
    .select('id, week_start, room, start_time, end_time, status, teacher:profiles!teacher_id(full_name, color, telegram), lesson_students!inner(student_id)')
    .gte('week_start', ws).lte('week_start', we)
    .in('status', ['active', 'cancelled'])
    .eq('lesson_students.student_id', student.id);

  const cancelQ = db.from('cancellations')
    .select('id, week_start, lesson_start_time, status, is_paid, teacher:profiles!teacher_id(full_name, color, telegram)')
    .eq('student_id', student.id)
    .gte('week_start', ws).lte('week_start', we)
    .eq('status', 'pending');

  const paymentsQ = db.from('payments')
    .select('id, lesson_id, status')
    .eq('student_id', student.id);

  const [lessonsRes, cancelRes, paymentsRes] = await Promise.all([lessonsQ, cancelQ, paymentsQ]);
  return {
    lessons: lessonsRes.data || [],
    cancellations: cancelRes.data || [],
    payments: paymentsRes.data || [],
    student
  };
}

function buildLessonItems(lessons, cancellations, payments, student) {
  const items = [];

  lessons.forEach(l => {
    const start = new Date(l.start_time);
    const end = new Date(l.end_time);
    const durMin = Math.round((end - start) / 60000);
    const cost = computeStudentCost(durMin, student);
    const lessonPayment = payments.find(p => p.lesson_id === l.id);
    const isPaid = lessonPayment && lessonPayment.status === 'approved';
    const paymentPending = lessonPayment && lessonPayment.status === 'pending';

    let status = 'planned';
    const now = new Date();
    if (l.status === 'cancelled') status = 'cancelled';
    else if (end < now) status = 'completed';

    items.push({
      id: l.id,
      type: 'lesson',
      date: start,
      startTime: `${start.getHours().toString().padStart(2,'0')}:${start.getMinutes().toString().padStart(2,'0')}`,
      endTime: `${end.getHours().toString().padStart(2,'0')}:${end.getMinutes().toString().padStart(2,'0')}`,
      duration: durMin,
      subject: student.subject || '',
      teacherName: l.teacher?.full_name || '',
      teacherColor: l.teacher?.color || '#1e6fe8',
      teacherTelegram: l.teacher?.telegram || null,
      room: l.room,
      status,
      isPaid,
      paymentPending,
      cost
    });
  });

  cancellations.forEach(c => {
    if (!c.lesson_start_time) return;
    const start = new Date(c.lesson_start_time);
    const dur = 90;
    const cost = computeStudentCost(dur, student);
    items.push({
      id: 'c_' + c.id,
      type: 'cancellation',
      date: start,
      startTime: `${start.getHours().toString().padStart(2,'0')}:${start.getMinutes().toString().padStart(2,'0')}`,
      endTime: '',
      duration: dur,
      subject: student.subject || '',
      teacherName: c.teacher?.full_name || '',
      teacherColor: c.teacher?.color || '#1e6fe8',
      teacherTelegram: c.teacher?.telegram || null,
      room: -1,
      status: c.is_paid ? 'paid_cancel' : 'cancelled',
      isPaid: !!c.is_paid,
      cost
    });
  });

  return items;
}

function computeStudentCost(durMin, student) {
  if (typeof findPricing !== 'function') return 0;
  const price = findPricing(durMin, student.is_individual || false, student.price_type || 'new', student.is_online || false);
  return price ? price.student_price : 0;
}

function findNearestUpcomingItem(items) {
  const now = new Date();
  const upcoming = items.filter(it => it.status === 'planned' && it.date >= now)
    .sort((a, b) => a.date - b.date);
  return upcoming.length > 0 ? upcoming[0].id : null;
}

async function renderStudentSchedule() {
  const ws = getStudentWeekStart();
  const we = new Date(ws); we.setDate(we.getDate() + 6);

  const { lessons, cancellations, payments, student } = await fetchStudentLessons(ws, we);
  if (!student) {
    document.getElementById('student-summary').innerHTML = '';
    document.getElementById('student-lessons-list').innerHTML = '<div class="online-empty">Профиль не привязан к ученику</div>';
    return;
  }

  const items = buildLessonItems(lessons, cancellations, payments, student);

  const summaryEl = document.getElementById('student-summary');
  const planned = items.filter(it => it.status === 'planned').length;
  const completed = items.filter(it => it.status === 'completed' || it.status === 'paid_cancel').length;
  const toPay = items.filter(it => (it.status === 'completed' || it.status === 'paid_cancel') && !it.isPaid && !it.paymentPending)
    .reduce((sum, it) => sum + it.cost, 0);

  const attendance = await computeAttendance(student.id);

  summaryEl.innerHTML = `
    <div class="student-stat"><span class="student-stat-num">${planned}</span><span class="student-stat-label">Запланировано</span></div>
    <div class="student-stat"><span class="student-stat-num">${completed}</span><span class="student-stat-label">Проведено</span></div>
    <div class="student-stat"><span class="student-stat-num">${toPay} ₽</span><span class="student-stat-label">К оплате</span></div>
    <div class="student-stat"><span class="student-stat-num">${attendance}%</span><span class="student-stat-label">Посещаемость</span></div>
  `;

  const list = document.getElementById('student-lessons-list');
  if (items.length === 0) {
    list.innerHTML = '<div class="online-empty">Нет занятий на этой неделе</div>';
    return;
  }

  const nearestId = findNearestUpcomingItem(items);
  const sorted = [...items].sort((a, b) => a.date - b.date);

  let html = '';
  sorted.forEach(it => {
    const dayIdx = it.date.getDay() === 0 ? 6 : it.date.getDay() - 1;
    const dayName = STUDENT_DAYS_FULL[dayIdx];
    const dd = it.date.getDate().toString().padStart(2, '0');
    const mm = (it.date.getMonth() + 1).toString().padStart(2, '0');
    const isCancelled = it.status === 'cancelled';
    const isNearest = it.id === nearestId;
    const cardClass = `student-card ${isCancelled ? 'student-card-cancelled' : ''} ${isNearest ? 'student-card-nearest' : ''}`;

    let statusBadge = '';
    if (it.status === 'cancelled') statusBadge = '<span class="student-card-status status-cancelled">Отменено</span>';
    else if (it.status === 'paid_cancel') statusBadge = '<span class="student-card-status status-paid-cancel">Платная отмена</span>';
    else if (it.status === 'completed' && it.isPaid) statusBadge = '<span class="student-card-status status-paid">Оплачено</span>';
    else if (it.status === 'completed' && it.paymentPending) statusBadge = '<span class="student-card-status status-pending">Ждёт подтверждения</span>';
    else if (it.status === 'completed') statusBadge = '<span class="student-card-status status-unpaid">К оплате</span>';
    else statusBadge = '<span class="student-card-status status-planned">Запланировано</span>';

    const tgLink = it.teacherTelegram ? `<a class="student-card-tg" href="https://t.me/${it.teacherTelegram}" target="_blank" title="Telegram"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21.94 4.55L18.78 19.5c-.24 1.06-.86 1.32-1.74.82l-4.81-3.55-2.32 2.23c-.26.26-.47.47-.97.47l.34-4.91 8.94-8.07c.39-.35-.08-.54-.6-.19L6.56 13.5l-4.76-1.49c-1.04-.32-1.06-1.04.22-1.54L20.6 3.16c.86-.32 1.62.19 1.34 1.39z"/></svg></a>` : '';

    const showPayBtn = it.status === 'completed' && !it.isPaid && !it.paymentPending && it.cost > 0;
    const roomLine = it.room < 0 ? '' : `<div class="student-card-row"><span class="student-card-label">Кабинет:</span><span class="student-card-value">${getRoomLabel(it.room)}</span></div>`;
    const timeStr = it.endTime ? `${it.startTime} – ${it.endTime}` : it.startTime;

    html += `<div class="${cardClass}" data-lesson-id="${it.id}" style="border-left:3px solid ${it.teacherColor}">
      <div class="student-card-header">
        <span class="student-card-day">${dayName}, ${dd}.${mm}</span>
        <span class="student-card-time">${timeStr}</span>
        <span class="student-card-dur">${it.duration} мин</span>
      </div>
      <div class="student-card-body">
        <div class="student-card-row">
          <span class="student-card-label">Предмет:</span>
          <span class="student-card-value">${it.subject}</span>
        </div>
        <div class="student-card-row">
          <span class="student-card-label">Преподаватель:</span>
          <span class="student-card-value student-card-teacher"><span class="teacher-color-dot" style="background:${it.teacherColor}"></span>${it.teacherName}${tgLink}</span>
        </div>
        ${roomLine}
        <div class="student-card-row">
          <span class="student-card-label">Стоимость:</span>
          <span class="student-card-value student-card-cost">${it.cost} ₽</span>
        </div>
      </div>
      <div class="student-card-footer">
        ${statusBadge}
        ${showPayBtn ? `<button class="btn-pay-lesson" data-lesson-id="${it.id}" data-amount="${it.cost}">Оплатить</button>` : ''}
      </div>
    </div>`;
  });
  list.innerHTML = html;

  list.querySelectorAll('.btn-pay-lesson').forEach(btn => {
    btn.addEventListener('click', () => openPaymentModal(btn.dataset.lessonId, +btn.dataset.amount));
  });
}

async function computeAttendance(studentId) {
  const { data: lessons } = await db.from('lessons')
    .select('id, status, lesson_students!inner(student_id)')
    .eq('lesson_students.student_id', studentId)
    .lte('start_time', new Date().toISOString())
    .in('status', ['active', 'cancelled']);

  const { data: cancellations } = await db.from('cancellations')
    .select('id, is_paid, status')
    .eq('student_id', studentId)
    .eq('status', 'pending');

  const total = (lessons || []).length + (cancellations || []).length;
  if (total === 0) return 0;
  const completed = (lessons || []).filter(l => l.status === 'active').length
    + (cancellations || []).filter(c => c.is_paid).length;
  return Math.round((completed / total) * 100);
}

async function renderStudentHistory() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + studentHistoryMonthOffset, 1);
  document.getElementById('month-label').textContent = `${STUDENT_MONTHS[target.getMonth()]} ${target.getFullYear()}`;

  const monthStart = target;
  const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0);
  const expStart = new Date(monthStart); expStart.setDate(expStart.getDate() - 7);
  const expEnd = new Date(monthEnd); expEnd.setDate(expEnd.getDate() + 7);

  const { lessons, cancellations, payments, student } = await fetchStudentLessons(expStart, expEnd);

  const tbody = document.getElementById('student-history-tbody');
  if (!student) {
    tbody.innerHTML = '<tr><td colspan="10" class="history-empty">Профиль не привязан к ученику</td></tr>';
    return;
  }

  const items = buildLessonItems(lessons, cancellations, payments, student)
    .filter(it => it.date >= monthStart && it.date <= monthEnd);

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="history-empty">Нет занятий в этом месяце</td></tr>';
    return;
  }

  const sorted = [...items].sort((a, b) => a.date - b.date);

  tbody.innerHTML = sorted.map(it => {
    const dayIdx = it.date.getDay() === 0 ? 6 : it.date.getDay() - 1;
    const dd = it.date.getDate().toString().padStart(2, '0');
    const mm = (it.date.getMonth() + 1).toString().padStart(2, '0');

    let statusHTML = '';
    if (it.status === 'cancelled') statusHTML = '<span class="history-status history-cancelled">Отменено</span>';
    else if (it.status === 'paid_cancel') statusHTML = '<span class="history-status history-paid-cancel">Платная отмена</span>';
    else if (it.status === 'completed') statusHTML = '<span class="history-status history-completed">Проведено</span>';
    else statusHTML = '<span class="history-status history-planned">Запланировано</span>';

    let payHTML = '—';
    if (it.status === 'completed' || it.status === 'paid_cancel') {
      if (it.isPaid) payHTML = '<span class="pay-paid">Оплачено</span>';
      else if (it.paymentPending) payHTML = '<span class="pay-pending">Ждёт</span>';
      else payHTML = '<span class="pay-unpaid">Не оплачено</span>';
    }

    const timeStr = it.endTime ? `${it.startTime}–${it.endTime}` : it.startTime;
    const roomStr = it.room < 0 ? '—' : getRoomLabel(it.room);

    return `<tr>
      <td>${dd}.${mm}</td>
      <td>${STUDENT_DAYS_SHORT[dayIdx]}</td>
      <td>${timeStr}</td>
      <td>${it.duration} мин</td>
      <td>${it.subject}</td>
      <td><span class="teacher-color-dot" style="background:${it.teacherColor}"></span>${it.teacherName}</td>
      <td>${roomStr}</td>
      <td>${statusHTML}</td>
      <td>${it.cost} ₽</td>
      <td>${payHTML}</td>
    </tr>`;
  }).join('');
}

let pendingPaymentLessonId = null;
let pendingPaymentAmount = 0;

function openPaymentModal(lessonId, amount) {
  pendingPaymentLessonId = lessonId;
  pendingPaymentAmount = amount;
  document.getElementById('payment-amount').textContent = amount + ' ₽';
  document.querySelectorAll('input[name="payment-method"]').forEach(r => r.checked = false);
  document.getElementById('payment-overlay').classList.add('active');
}

function closePaymentModal() {
  document.getElementById('payment-overlay').classList.remove('active');
  pendingPaymentLessonId = null;
}

async function submitPayment() {
  const method = document.querySelector('input[name="payment-method"]:checked');
  if (!method) { showToast('Выберите способ оплаты', 'error'); return; }
  if (!pendingPaymentLessonId) return;

  const student = await loadStudentRecord();
  if (!student) { showToast('Ошибка', 'error'); return; }

  const { error } = await db.from('payments').insert({
    lesson_id: pendingPaymentLessonId,
    student_id: student.id,
    amount: pendingPaymentAmount,
    payment_method: method.value,
    status: 'pending'
  });

  if (error) { console.error(error); showToast('Ошибка отправки заявки', 'error'); return; }

  closePaymentModal();
  showToast('Заявка на оплату отправлена', 'success');
  await renderStudentSchedule();
}

function initStudent() {
  document.querySelectorAll('#student-week-tabs .week-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      studentWeekOffset = +tab.dataset.offset;
      updateStudentWeekTabs();
      renderStudentSchedule();
    });
  });

  document.getElementById('btn-student-history').addEventListener('click', () => {
    showScreen('screen-student-history');
    studentHistoryMonthOffset = 0;
    renderStudentHistory();
  });

  document.getElementById('btn-student-back').addEventListener('click', () => {
    showScreen('screen-student');
  });

  document.getElementById('btn-month-prev').addEventListener('click', () => {
    studentHistoryMonthOffset--;
    renderStudentHistory();
  });

  document.getElementById('btn-month-next').addEventListener('click', () => {
    studentHistoryMonthOffset++;
    renderStudentHistory();
  });

  document.getElementById('btn-profile-student').addEventListener('click', () => showScreen('screen-profile'));
  document.getElementById('btn-profile-student-history').addEventListener('click', () => showScreen('screen-profile'));

  document.getElementById('btn-payment-cancel').addEventListener('click', closePaymentModal);
  document.getElementById('btn-payment-submit').addEventListener('click', submitPayment);
  document.getElementById('btn-close-payment').addEventListener('click', closePaymentModal);
  document.getElementById('payment-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePaymentModal();
  });
}

async function showStudentScreen() {
  studentRecord = null;
  studentWeekOffset = 0;
  updateStudentWeekTabs();
  if (typeof loadPricing === 'function') await loadPricing();
  await renderStudentSchedule();
  showScreen('screen-student');
}
