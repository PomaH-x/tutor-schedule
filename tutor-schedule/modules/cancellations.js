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
    .select('*, student:students(first_name, last_name), recurring_lesson:recurring_lessons(start_time, end_time, day_of_week), teacher:profiles!teacher_id(full_name)')
    .eq('status', 'pending')
    .gte('week_start', formatDate(threeWeeksAgo));
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);
  q = q.order('week_start', { ascending: false });
  const { data } = await q;
  renderTruants(data || []);
}

function getCancelLabel(c) {
  const currentWs = formatDate(getMonday(new Date()));
  let dayName = '', time = '';
  if (c.lesson_start_time) {
    const d = new Date(c.lesson_start_time);
    dayName = DAYS_SHORT[d.getDay() === 0 ? 6 : d.getDay() - 1];
    time = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  } else if (c.recurring_lesson) {
    const sp = c.recurring_lesson.start_time.split(':');
    dayName = DAYS_SHORT[c.recurring_lesson.day_of_week];
    time = (+sp[0]).toString().padStart(2,'0') + ':' + sp[1];
  }
  if (!dayName) return 'Отмена';
  if (c.week_start === currentWs) return dayName + ' ' + time;
  const d = new Date(c.week_start + 'T00:00:00');
  return d.getDate().toString().padStart(2,'0') + '.' + (d.getMonth()+1).toString().padStart(2,'0') + '.' + String(d.getFullYear()).slice(2) + ' ' + dayName + ' ' + time;
}

function renderTruants(cancellations) {
  const statsEl = document.getElementById('truants-stats');
  const listEl = document.getElementById('truants-list');
  if (!statsEl || !listEl) return;

  const thisWeek = formatDate(getMonday(new Date()));
  const thisWeekCount = cancellations.filter(c => c.week_start === thisWeek).length;

  statsEl.innerHTML = '<div class="truant-stat"><span class="truant-stat-num">' + thisWeekCount + '</span><span class="truant-stat-label">Отмен на этой неделе</span></div><div class="truant-stat"><span class="truant-stat-num">' + cancellations.length + '</span><span class="truant-stat-label">Неотработанных за 3 недели</span></div>';

  var grouped = {};
  cancellations.forEach(function(c) {
    if (!c.student) return;
    var key = c.student_id;
    if (!grouped[key]) grouped[key] = { student: c.student, studentId: c.student_id, teacherId: c.teacher_id, teacherName: c.teacher ? c.teacher.full_name : '', cancels: [] };
    grouped[key].cancels.push(c);
  });

  var truants = Object.values(grouped);
  var isAdmin = state.profile.role === 'admin';

  if (isAdmin) {
    truants.sort(function(a, b) {
      var aOwn = a.teacherId === state.user.id ? 0 : 1;
      var bOwn = b.teacherId === state.user.id ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
      return b.cancels.length - a.cancels.length;
    });
  } else {
    truants.sort(function(a, b) { return b.cancels.length - a.cancels.length; });
  }

  if (truants.length === 0) {
    listEl.innerHTML = '<div class="admin-empty">Нет прогульщиков</div>';
    return;
  }

  var html = '';
  var currentTeacher = null;
  truants.forEach(function(t) {
    if (isAdmin && t.teacherName !== currentTeacher) {
      currentTeacher = t.teacherName;
      html += '<div class="truant-group-title">' + currentTeacher + '</div>';
    }
    var name = t.student.first_name + ' ' + t.student.last_name;
    var count = t.cancels.length;
    var dur = 90;
    if (t.cancels[0].recurring_lesson) {
      var sp = t.cancels[0].recurring_lesson.start_time.split(':');
      var ep = t.cancels[0].recurring_lesson.end_time.split(':');
      dur = (+ep[0] * 60 + +ep[1]) - (+sp[0] * 60 + +sp[1]);
    }

    if (count === 1) {
      var label = getCancelLabel(t.cancels[0]);
      html += '<div class="truant-card"><div class="truant-info"><span class="truant-name">' + name + '</span><span class="truant-date-badge">' + label + '</span></div><div class="truant-actions"><button class="btn-remove-truant-single" data-cid="' + t.cancels[0].id + '" data-name="' + name + '" title="Убрать">Убрать</button><button class="btn-place-truant" data-student-id="' + t.studentId + '" data-duration="' + dur + '" data-name="' + name + '">Разместить</button></div></div>';
    } else {
      html += '<div class="truant-card truant-card-expandable"><div class="truant-header" data-toggle="' + t.studentId + '"><div class="truant-info"><span class="truant-name">' + name + '</span><span class="truant-count-badge">' + count + ' неотработ.</span></div><span class="truant-expand-icon">▸</span></div><div class="truant-details" id="truant-details-' + t.studentId + '">';
      t.cancels.forEach(function(c) {
        var clabel = getCancelLabel(c);
        html += '<div class="truant-detail-row"><span class="truant-date-badge">' + clabel + '</span><div class="truant-actions"><button class="btn-remove-truant-single" data-cid="' + c.id + '" data-name="' + name + '" title="Убрать">Убрать</button><button class="btn-place-truant" data-student-id="' + t.studentId + '" data-duration="' + dur + '" data-name="' + name + '">Разместить</button></div></div>';
      });
      html += '</div></div>';
    }
  });
  listEl.innerHTML = html;

  listEl.querySelectorAll('.truant-header[data-toggle]').forEach(function(header) {
    header.addEventListener('click', function() {
      var details = document.getElementById('truant-details-' + header.dataset.toggle);
      var icon = header.querySelector('.truant-expand-icon');
      var isOpen = details.classList.toggle('open');
      icon.textContent = isOpen ? '▾' : '▸';
    });
  });

  listEl.querySelectorAll('.btn-place-truant').forEach(function(btn) {
    btn.addEventListener('click', function() {
      startTruantPlacing(btn.dataset.studentId, btn.dataset.name, +btn.dataset.duration);
    });
  });

  listEl.querySelectorAll('.btn-remove-truant-single').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var cid = btn.dataset.cid;
      var cname = btn.dataset.name;
      showConfirm('Убрать отмену для ' + cname + '?', async function() {
        await db.from('cancellations').delete().eq('id', cid);
        showToast('Отмена убрана', 'success');
        await loadTruants();
      }, 'Убрать');
    });
  });
}

function startTruantPlacing(studentId, name, duration) {
  var slotLength = Math.ceil(duration / SLOT_MINUTES);
  state.placingTruant = { studentId: studentId, name: name, slotLength: slotLength, teacherId: state.user.id };
  showScreen('screen-schedule');
  showPlacingBanner();
  renderGrid();
}

async function placeTruantOnCell(day, room, slot) {
  var t = state.placingTruant; if (!t) return;
  var end = slot + t.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  var ct = await checkConflictServer(day, room, slot, end, null, t.teacherId);
  if (ct === 'room') { showToast('Кабинет занят', 'error'); return; }
  if (ct === 'teacher') { showToast('Преподаватель занят', 'error'); return; }

  var dates = getWeekDates(state.currentWeekStart); var date = dates[day];
  var sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
  var eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

  var result = await db.from('lessons').insert({
    teacher_id: t.teacherId, room: room, week_start: formatDate(state.currentWeekStart),
    start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
  }).select().single();
  if (result.error) { showToast('Ошибка', 'error'); return; }
  await db.from('lesson_students').insert({ lesson_id: result.data.id, student_id: t.studentId });

  // Close one pending cancellation for this student
  var pending = await db.from('cancellations').select('id').eq('student_id', t.studentId).eq('teacher_id', t.teacherId).eq('status', 'pending').order('week_start').limit(1);
  if (pending.data && pending.data.length > 0) await db.from('cancellations').delete().eq('id', pending.data[0].id);

  state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик размещён для отработки', 'success');
  await loadLessons();
}

async function placeTruantOnLesson(targetLessonId) {
  var t = state.placingTruant; if (!t) return;
  var tl = state.lessons.find(function(l) { return l.id === targetLessonId; });
  if (!tl) { showToast('Занятие не найдено', 'error'); return; }
  if (tl.teacher_id !== t.teacherId) { showToast('Только к своему преподавателю', 'error'); return; }

  var truantResult = await db.from('students').select('is_individual').eq('id', t.studentId).single();
  var isInd = truantResult.data ? truantResult.data.is_individual : false;
  var targetStudents = tl.lesson_students || [];
  var targetHasIndividual = targetStudents.some(function(ls) { return ls.student && ls.student.is_individual; });

  if (isInd && targetStudents.length > 0) {
    showToast('Индивидуальное занятие — только один ученик', 'error'); return;
  }
  if (!isInd && targetHasIndividual) {
    showToast('В занятии уже индивидуальный ученик', 'error'); return;
  }
  if (targetStudents.length >= getMaxGroup(tl.teacher_id)) { showToast('Максимум ' + getMaxGroup(tl.teacher_id) + ' учеников', 'error'); return; }

  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: t.studentId });

  // Close one pending cancellation for this student
  var pending = await db.from('cancellations').select('id').eq('student_id', t.studentId).eq('teacher_id', t.teacherId).eq('status', 'pending').order('week_start').limit(1);
  if (pending.data && pending.data.length > 0) await db.from('cancellations').delete().eq('id', pending.data[0].id);

  state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик добавлен к занятию', 'success');
  await loadLessons();
}

function initCancellations() {}
