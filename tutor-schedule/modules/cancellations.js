async function computeAndSyncCancellations() {
  if (!state.profile || state.profile.role === 'student') return;
  const teacherId = state.user.id;
  const currentMonday = getMonday(new Date());
  const ws = formatDate(currentMonday);

  // Get recurring template
  const { data: recurring } = await db.from('recurring_lessons')
    .select('id, day_of_week, start_time, end_time, recurring_lesson_students(student_id)')
    .eq('teacher_id', teacherId);
  if (!recurring) return;

  // Get current week lessons (all statuses)
  const { data: actualCurrent } = await db.from('lessons')
    .select('id, status, start_time, lesson_students(student_id)')
    .eq('week_start', ws).eq('teacher_id', teacherId);

  // Map: student_id → list of actual active lesson ids this week
  const activeByStudent = {};
  const cancelledByStudent = {};
  (actualCurrent || []).forEach(l => {
    (l.lesson_students || []).forEach(ls => {
      if (l.status === 'active') {
        if (!activeByStudent[ls.student_id]) activeByStudent[ls.student_id] = [];
        activeByStudent[ls.student_id].push(l.id);
      }
      if (l.status === 'cancelled') {
        if (!cancelledByStudent[ls.student_id]) cancelledByStudent[ls.student_id] = [];
        cancelledByStudent[ls.student_id].push(l.id);
      }
    });
  });

  // Build recurring map: student_id → [rlId, ...]
  const recurringByStudent = {};
  (recurring || []).forEach(rl => {
    (rl.recurring_lesson_students || []).forEach(rs => {
      if (!recurringByStudent[rs.student_id]) recurringByStudent[rs.student_id] = [];
      recurringByStudent[rs.student_id].push(rl.id);
    });
  });

  // Existing cancellations for this week
  const { data: existing } = await db.from('cancellations')
    .select('id, student_id, recurring_lesson_id, status')
    .eq('teacher_id', teacherId).eq('week_start', ws);
  const existingMap = {};
  (existing || []).forEach(c => { existingMap[`${c.student_id}-${c.recurring_lesson_id}`] = c; });

  const toInsert = [], toMakeUp = [], toReopen = [];

  for (const sid in recurringByStudent) {
    const rlIds = recurringByStudent[sid];
    const activeCount = (activeByStudent[sid] || []).length;
    // Each cancelled lesson for this student counts as one miss
    const cancelledCount = (cancelledByStudent[sid] || []).length;
    // Missed = cancelled + (recurring not covered by active)
    const missedFromAbsence = Math.max(0, rlIds.length - activeCount);
    const totalMissed = cancelledCount + Math.max(0, missedFromAbsence - cancelledCount);
    const missed = Math.max(cancelledCount, missedFromAbsence);

    for (let i = 0; i < rlIds.length; i++) {
      const rlId = rlIds[i];
      const key = `${sid}-${rlId}`;
      const ex = existingMap[key];
      if (i < missed) {
        if (!ex) toInsert.push({ student_id: sid, teacher_id: teacherId, week_start: ws, recurring_lesson_id: rlId, status: 'pending' });
        else if (ex.status === 'made_up') toReopen.push(ex.id);
      } else {
        if (ex && ex.status === 'pending') toMakeUp.push(ex.id);
      }
    }
  }

  if (toInsert.length > 0) await db.from('cancellations').insert(toInsert);
  if (toMakeUp.length > 0) await db.from('cancellations').update({ status: 'made_up' }).in('id', toMakeUp);
  if (toReopen.length > 0) await db.from('cancellations').update({ status: 'pending' }).in('id', toReopen);

  // Extra active lessons on current week close oldest pending cancellations
  const nextMonday = new Date(currentMonday); nextMonday.setDate(nextMonday.getDate() + 7);
  const nws = formatDate(nextMonday);
  const { data: actualNext } = await db.from('lessons')
    .select('id, lesson_students(student_id)').eq('week_start', nws).eq('teacher_id', teacherId).eq('status', 'active');
  const nextStudentCount = {};
  (actualNext || []).forEach(l => {
    (l.lesson_students || []).forEach(ls => { nextStudentCount[ls.student_id] = (nextStudentCount[ls.student_id] || 0) + 1; });
  });

  for (const sid in activeByStudent) {
    const recurringCount = (recurringByStudent[sid] || []).length;
    const extra = (activeByStudent[sid] || []).length - recurringCount;
    if (extra > 0) {
      const { data: pending } = await db.from('cancellations').select('id').eq('student_id', sid).eq('teacher_id', teacherId).eq('status', 'pending').order('week_start').limit(extra);
      if (pending?.length > 0) await db.from('cancellations').update({ status: 'made_up' }).in('id', pending.map(p => p.id));
    }
  }
  for (const sid in nextStudentCount) {
    const recurringCount = (recurringByStudent[sid] || []).length;
    const extra = nextStudentCount[sid] - recurringCount;
    if (extra > 0) {
      const { data: pending } = await db.from('cancellations').select('id').eq('student_id', sid).eq('teacher_id', teacherId).eq('status', 'pending').order('week_start').limit(extra);
      if (pending?.length > 0) await db.from('cancellations').update({ status: 'made_up' }).in('id', pending.map(p => p.id));
    }
  }

  // Cleanup: delete cancellations older than 3 weeks
  const threeWeeksAgo = new Date(currentMonday);
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
  await db.from('cancellations').delete().lt('week_start', formatDate(threeWeeksAgo));
}

async function loadTruants() {
  if (!state.profile || state.profile.role === 'student') return;
  const isAdmin = state.profile.role === 'admin';
  const threeWeeksAgo = new Date(getMonday(new Date()));
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 14);
  let q = db.from('cancellations')
    .select('*, student:students(first_name, last_name), recurring_lesson:recurring_lessons(start_time, end_time), teacher:profiles!teacher_id(full_name)')
    .eq('status', 'pending')
    .gte('week_start', formatDate(threeWeeksAgo));
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);
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
    if (!grouped[key]) grouped[key] = { student: c.student, count: 0, studentId: c.student_id, duration: 90, teacherId: c.teacher_id, teacherName: c.teacher?.full_name || '' };
    grouped[key].count++;
    if (c.recurring_lesson) {
      const sp = c.recurring_lesson.start_time.split(':');
      const ep = c.recurring_lesson.end_time.split(':');
      grouped[key].duration = (+ep[0] * 60 + +ep[1]) - (+sp[0] * 60 + +sp[1]);
    }
  });

  const truants = Object.values(grouped);
  const isAdmin = state.profile.role === 'admin';

  if (isAdmin) {
    truants.sort((a, b) => {
      const aOwn = a.teacherId === state.user.id ? 0 : 1;
      const bOwn = b.teacherId === state.user.id ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
      return b.count - a.count;
    });
  } else {
    truants.sort((a, b) => b.count - a.count);
  }

  if (truants.length === 0) {
    listEl.innerHTML = '<div class="admin-empty">Нет прогульщиков</div>';
    return;
  }

  let html = '';
  let currentTeacher = null;
  truants.forEach(t => {
    if (isAdmin && t.teacherName !== currentTeacher) {
      currentTeacher = t.teacherName;
      html += `<div class="truant-group-title">${currentTeacher}</div>`;
    }
    html += `<div class="truant-card" data-student-id="${t.studentId}">
      <div class="truant-info">
        <span class="truant-name">${t.student.first_name} ${t.student.last_name}</span>
        <span class="truant-count">${t.count} неотработ.</span>
      </div>
      <div class="truant-actions">
        <button class="btn-excuse-truant" data-student-id="${t.studentId}" data-teacher-id="${t.teacherId}" title="Уважительная причина">Ув. причина</button>
        <button class="btn-place-truant" data-student-id="${t.studentId}" data-duration="${t.duration}" data-name="${t.student.first_name} ${t.student.last_name}">Разместить</button>
      </div>
    </div>`;
  });
  listEl.innerHTML = html;

  listEl.querySelectorAll('.btn-place-truant').forEach(btn => {
    btn.addEventListener('click', () => {
      startTruantPlacing(btn.dataset.studentId, btn.dataset.name, +btn.dataset.duration);
    });
  });

  listEl.querySelectorAll('.btn-excuse-truant').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.studentId;
      const tid = btn.dataset.teacherId;
      await db.from('cancellations').update({ status: 'made_up' })
        .eq('student_id', sid).eq('teacher_id', tid).eq('status', 'pending');
      showToast('Уважительная причина принята', 'success');
      await loadTruants();
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

  const { data: truantStudent } = await db.from('students').select('is_individual').eq('id', t.studentId).single();
  const isInd = truantStudent?.is_individual;
  const targetStudents = tl.lesson_students || [];
  const targetHasIndividual = targetStudents.some(ls => ls.student?.is_individual);

  if (isInd && targetStudents.length > 0) {
    showToast('Индивидуальное занятие — только один ученик', 'error'); return;
  }
  if (!isInd && targetHasIndividual) {
    showToast('В занятии уже индивидуальный ученик', 'error'); return;
  }
  if (targetStudents.length >= getMaxGroup(tl.teacher_id)) { showToast(`Максимум ${getMaxGroup(tl.teacher_id)} учеников`, 'error'); return; }

  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: t.studentId });
  state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик добавлен к занятию', 'success');
  await loadLessons();
}

function initCancellations() {}
