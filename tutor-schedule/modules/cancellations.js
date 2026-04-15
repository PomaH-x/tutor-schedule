async function computeAndSyncCancellations() {
  if (!state.profile || state.profile.role === 'student') return;
  const teacherId = state.user.id;
  const currentMonday = getMonday(new Date());
  const ws = formatDate(currentMonday);

  // Get recurring (permanent) schedule
  const { data: recurring } = await db.from('recurring_lessons')
    .select('id, recurring_lesson_students(student_id)')
    .eq('teacher_id', teacherId);

  // Get actual lessons for CURRENT week only
  const { data: actualCurrent } = await db.from('lessons')
    .select('id, status, lesson_students(student_id)')
    .eq('week_start', ws)
    .eq('teacher_id', teacherId)
    .in('status', ['active', 'transferred']);

  if (!recurring) return;

  // Count how many recurring lessons each student has
  const recurringStudentLessons = {};
  (recurring || []).forEach(rl => {
    (rl.recurring_lesson_students || []).forEach(rs => {
      if (!recurringStudentLessons[rs.student_id]) recurringStudentLessons[rs.student_id] = [];
      recurringStudentLessons[rs.student_id].push(rl.id);
    });
  });

  // Count how many actual lessons each student has this week
  const actualStudentCount = {};
  (actualCurrent || []).forEach(l => {
    (l.lesson_students || []).forEach(ls => {
      actualStudentCount[ls.student_id] = (actualStudentCount[ls.student_id] || 0) + 1;
    });
  });

  // Get existing cancellations for this week
  const { data: existing } = await db.from('cancellations')
    .select('id, student_id, recurring_lesson_id, status')
    .eq('teacher_id', teacherId)
    .eq('week_start', ws);

  const existingMap = {};
  (existing || []).forEach(c => {
    const key = `${c.student_id}-${c.recurring_lesson_id}`;
    existingMap[key] = c;
  });

  const toInsert = [];
  const toMakeUp = [];
  const toReopen = [];

  for (const sid in recurringStudentLessons) {
    const recurringCount = recurringStudentLessons[sid].length;
    const actualCount = actualStudentCount[sid] || 0;
    const missedCount = Math.max(0, recurringCount - actualCount);
    const rlIds = recurringStudentLessons[sid];

    for (let i = 0; i < rlIds.length; i++) {
      const rlId = rlIds[i];
      const key = `${sid}-${rlId}`;
      const ex = existingMap[key];

      if (i < missedCount) {
        // This lesson is missed
        if (!ex) {
          toInsert.push({ student_id: sid, teacher_id: teacherId, week_start: ws, recurring_lesson_id: rlId, status: 'pending' });
        } else if (ex.status === 'made_up') {
          toReopen.push(ex.id);
        }
      } else {
        // This lesson is covered
        if (ex && ex.status === 'pending') {
          toMakeUp.push(ex.id);
        }
      }
    }
  }

  if (toInsert.length > 0) await db.from('cancellations').insert(toInsert);
  if (toMakeUp.length > 0) await db.from('cancellations').update({ status: 'made_up' }).in('id', toMakeUp);
  if (toReopen.length > 0) await db.from('cancellations').update({ status: 'pending' }).in('id', toReopen);

  // Check if extra lessons on current or next week cover old pending cancellations
  const nextMonday = new Date(currentMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const nws = formatDate(nextMonday);

  const { data: actualNext } = await db.from('lessons')
    .select('id, lesson_students(student_id)')
    .eq('week_start', nws)
    .eq('teacher_id', teacherId)
    .eq('status', 'active');

  const nextStudentCount = {};
  (actualNext || []).forEach(l => {
    (l.lesson_students || []).forEach(ls => {
      nextStudentCount[ls.student_id] = (nextStudentCount[ls.student_id] || 0) + 1;
    });
  });

  // For students not in recurring but with lessons = extra = make up
  for (const sid in actualStudentCount) {
    const recurringCount = (recurringStudentLessons[sid] || []).length;
    const extra = actualStudentCount[sid] - recurringCount;
    if (extra > 0) {
      const { data: pending } = await db.from('cancellations')
        .select('id').eq('student_id', sid).eq('teacher_id', teacherId)
        .eq('status', 'pending').order('week_start').limit(extra);
      if (pending && pending.length > 0) {
        await db.from('cancellations').update({ status: 'made_up' }).in('id', pending.map(p => p.id));
      }
    }
  }

  for (const sid in nextStudentCount) {
    const recurringCount = (recurringStudentLessons[sid] || []).length;
    const extra = nextStudentCount[sid] - recurringCount;
    if (extra > 0) {
      const { data: pending } = await db.from('cancellations')
        .select('id').eq('student_id', sid).eq('teacher_id', teacherId)
        .eq('status', 'pending').order('week_start').limit(extra);
      if (pending && pending.length > 0) {
        await db.from('cancellations').update({ status: 'made_up' }).in('id', pending.map(p => p.id));
      }
    }
  }
}

async function loadTruants() {
  if (!state.profile || state.profile.role === 'student') return;
  const teacherId = state.profile.role === 'admin' ? undefined : state.user.id;
  let q = db.from('cancellations')
    .select('*, student:students(first_name, last_name), recurring_lesson:recurring_lessons(start_time, end_time)')
    .eq('status', 'pending');
  if (teacherId) q = q.eq('teacher_id', teacherId);
  q = q.order('week_start', { ascending: false });

  const { data } = await q;
  renderTruants(data || []);
}

function renderTruants(cancellations) {
  const statsEl = document.getElementById('truants-stats');
  const listEl = document.getElementById('truants-list');
  if (!statsEl || !listEl) return;

  const thisWeek = formatDate(getMonday(new Date()));
  const thisWeekCount = cancellations.filter(c => c.week_start === thisWeek).length;
  const totalPending = cancellations.length;

  statsEl.innerHTML = `
    <div class="truant-stat"><span class="truant-stat-num">${thisWeekCount}</span><span class="truant-stat-label">Отмен на этой неделе</span></div>
    <div class="truant-stat"><span class="truant-stat-num">${totalPending}</span><span class="truant-stat-label">Неотработанных</span></div>
  `;

  const grouped = {};
  cancellations.forEach(c => {
    if (!c.student) return;
    const key = c.student_id;
    if (!grouped[key]) grouped[key] = { student: c.student, count: 0, studentId: c.student_id, duration: 90 };
    grouped[key].count++;
    if (c.recurring_lesson) {
      const sp = c.recurring_lesson.start_time.split(':');
      const ep = c.recurring_lesson.end_time.split(':');
      grouped[key].duration = (+ep[0] * 60 + +ep[1]) - (+sp[0] * 60 + +sp[1]);
    }
  });

  const truants = Object.values(grouped).sort((a, b) => b.count - a.count);

  if (truants.length === 0) {
    listEl.innerHTML = '<div class="admin-empty">Нет прогульщиков</div>';
    return;
  }

  listEl.innerHTML = truants.map(t =>
    `<div class="truant-card" data-student-id="${t.studentId}">
      <div class="truant-info">
        <span class="truant-name">${t.student.first_name} ${t.student.last_name}</span>
        <span class="truant-count">${t.count} неотработ.</span>
      </div>
      <button class="btn-place-truant" data-student-id="${t.studentId}" data-duration="${t.duration}" data-name="${t.student.first_name} ${t.student.last_name}">Разместить</button>
    </div>`
  ).join('');

  listEl.querySelectorAll('.btn-place-truant').forEach(btn => {
    btn.addEventListener('click', () => {
      startTruantPlacing(btn.dataset.studentId, btn.dataset.name, +btn.dataset.duration);
    });
  });
}

function startTruantPlacing(studentId, name, duration) {
  const slotLength = Math.ceil(duration / SLOT_MINUTES);
  state.placingTruant = { studentId, name, slotLength, teacherId: state.user.id };
  showScreen('screen-schedule');
  showPlacingBanner();
  renderGrid();
}

async function placeTruantOnCell(day, room, slot) {
  const t = state.placingTruant; if (!t) return;
  const end = slot + t.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  const ct = await checkConflictServer(day, room, slot, end, null, t.teacherId);
  if (ct === 'room') { showToast('Кабинет занят', 'error'); return; }
  if (ct === 'teacher') { showToast('Преподаватель занят', 'error'); return; }

  const dates = getWeekDates(state.currentWeekStart); const date = dates[day];
  const sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  const eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  const { data, error } = await db.from('lessons').insert({
    teacher_id: t.teacherId, room, week_start: formatDate(state.currentWeekStart),
    start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
  }).select().single();
  if (error) { showToast('Ошибка', 'error'); return; }
  await db.from('lesson_students').insert({ lesson_id: data.id, student_id: t.studentId });

  state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик размещён для отработки', 'success');
  await loadLessons();
}

async function placeTruantOnLesson(targetLessonId) {
  const t = state.placingTruant; if (!t) return;
  const tl = state.lessons.find(l => l.id === targetLessonId);
  if (!tl) { showToast('Занятие не найдено', 'error'); return; }
  if (tl.teacher_id !== t.teacherId) { showToast('Только к своему преподавателю', 'error'); return; }
  if ((tl.lesson_students?.length || 0) >= 4) { showToast('Максимум 4 ученика', 'error'); return; }
  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: t.studentId });

  state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик добавлен к занятию', 'success');
  await loadLessons();
}

function initCancellations() {}
