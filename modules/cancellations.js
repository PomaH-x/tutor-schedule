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
    .select('id, student_id, recurring_lesson_id, status, dismissed_at')
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
      // dismissed_at means an admin manually removed this truant — never recreate / reopen it
      if (ex && ex.dismissed_at) continue;
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
      const { data: pending } = await db.from('cancellations').select('id').eq('student_id', sid).eq('teacher_id', teacherId).eq('status', 'pending').eq('is_paid', false).order('week_start').limit(extra);
      if (pending?.length > 0) await db.from('cancellations').update({ status: 'made_up' }).in('id', pending.map(p => p.id));
    }
  }
  for (const sid in nextStudentCount) {
    const recurringCount = (recurringByStudent[sid] || []).length;
    const extra = nextStudentCount[sid] - recurringCount;
    if (extra > 0) {
      const { data: pending } = await db.from('cancellations').select('id').eq('student_id', sid).eq('teacher_id', teacherId).eq('status', 'pending').eq('is_paid', false).order('week_start').limit(extra);
      if (pending?.length > 0) await db.from('cancellations').update({ status: 'made_up' }).in('id', pending.map(p => p.id));
    }
  }

  // Cancellations older than 3 weeks are no longer "pending make-up" — they become
  // permanent misses ('missed' status). They stay in DB so they keep reducing the
  // student's attendance metric and show up as «Прогул» in the student card.
  // 'made_up' rows older than 3 weeks are also archived (deleted) to keep the table small.
  const threeWeeksAgo = new Date(currentMonday);
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
  const threeWeeksAgoStr = formatDate(threeWeeksAgo);
  await db.from('cancellations')
    .update({ status: 'missed' })
    .lt('week_start', threeWeeksAgoStr)
    .eq('status', 'pending');
  await db.from('cancellations')
    .delete()
    .lt('week_start', threeWeeksAgoStr)
    .eq('status', 'made_up');
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

function getCancelDuration(c) {
  // Recurring: compute from recurring lesson start/end
  if (c.recurring_lesson) {
    var sp = c.recurring_lesson.start_time.split(':');
    var ep = c.recurring_lesson.end_time.split(':');
    return (+ep[0] * 60 + +ep[1]) - (+sp[0] * 60 + +sp[1]);
  }
  // Concrete lesson: compute from stored start/end
  if (c.lesson_start_time && c.lesson_end_time) {
    return Math.round((new Date(c.lesson_end_time) - new Date(c.lesson_start_time)) / 60000);
  }
  // Fallback (old records without end_time)
  return 90;
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

  function paidBadge(c) {
    return c.is_paid ? '<span class="truant-paid-badge" title="Платная отмена">₽</span>' : '';
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

    if (count === 1) {
      var c = t.cancels[0];
      var label = getCancelLabel(c);
      var dur = getCancelDuration(c);
      html += '<div class="truant-card">' +
        '<div class="truant-info">' +
          '<span class="truant-name">' + name + '</span>' +
          '<span class="truant-date-badge">' + label + '</span>' +
          paidBadge(c) +
        '</div>' +
        '<div class="truant-actions">' +
          '<button class="btn-remove-truant-single" data-cid="' + c.id + '" data-name="' + name + '" title="Убрать">Убрать</button>' +
          '<button class="btn-place-truant" data-student-id="' + t.studentId + '" data-teacher-id="' + t.teacherId + '" data-cid="' + c.id + '" data-duration="' + dur + '" data-name="' + name + '">Разместить</button>' +
        '</div>' +
      '</div>';
    } else {
      html += '<div class="truant-card truant-card-expandable">' +
        '<div class="truant-header" data-toggle="' + t.studentId + '">' +
          '<div class="truant-info">' +
            '<span class="truant-name">' + name + '</span>' +
            '<span class="truant-count-badge">' + count + ' неотработ.</span>' +
          '</div>' +
          '<span class="truant-expand-icon">▸</span>' +
        '</div>' +
        '<div class="truant-details" id="truant-details-' + t.studentId + '">';
      t.cancels.forEach(function(c) {
        var clabel = getCancelLabel(c);
        var dur = getCancelDuration(c);
        html += '<div class="truant-detail-row">' +
          '<span class="truant-date-badge">' + clabel + '</span>' +
          paidBadge(c) +
          '<div class="truant-actions">' +
            '<button class="btn-remove-truant-single" data-cid="' + c.id + '" data-name="' + name + '" title="Убрать">Убрать</button>' +
            '<button class="btn-place-truant" data-student-id="' + t.studentId + '" data-teacher-id="' + t.teacherId + '" data-cid="' + c.id + '" data-duration="' + dur + '" data-name="' + name + '">Разместить</button>' +
          '</div>' +
        '</div>';
      });
      html += '</div></div>';
    }
  });
  listEl.innerHTML = html;

  // Event delegation - one listener handles all buttons including those added later
  if (!listEl.dataset.truantsBound) {
    listEl.dataset.truantsBound = '1';
    listEl.addEventListener('click', function(e) {
      var placeBtn = e.target.closest('.btn-place-truant');
      if (placeBtn) {
        e.stopPropagation();
        startTruantPlacing(placeBtn.dataset.studentId, placeBtn.dataset.name, +placeBtn.dataset.duration, placeBtn.dataset.cid, placeBtn.dataset.teacherId);
        return;
      }
      var removeBtn = e.target.closest('.btn-remove-truant-single');
      if (removeBtn) {
        e.stopPropagation();
        var cid = removeBtn.dataset.cid;
        var cname = removeBtn.dataset.name;
        showConfirm('Убрать отмену для ' + cname + '?', async function() {
          // Mark as dismissed instead of deleting. If we just delete, computeAndSyncCancellations()
          // will recreate the cancellation on the next loadLessons because the recurring template
          // still says "should be a lesson, but there isn't one". The dismissed_at flag tells
          // the sync routine to leave this record alone.
          await db.from('cancellations').update({
            status: 'made_up',
            dismissed_at: new Date().toISOString()
          }).eq('id', cid);
          showToast('Отмена убрана', 'success');
          await loadTruants();
          if (typeof loadPayroll === 'function' && document.getElementById('screen-profile')?.classList.contains('active')) loadPayroll();
        }, 'Убрать');
        return;
      }
      var header = e.target.closest('.truant-header[data-toggle]');
      if (header) {
        var details = document.getElementById('truant-details-' + header.dataset.toggle);
        var icon = header.querySelector('.truant-expand-icon');
        var isOpen = details.classList.toggle('open');
        icon.textContent = isOpen ? '▾' : '▸';
      }
    });
  }
}

function startTruantPlacing(studentId, name, duration, cancellationId, teacherId) {
  var slotLength = Math.ceil(duration / SLOT_MINUTES);
  state.placingTruant = {
    studentId: studentId,
    name: name,
    slotLength: slotLength,
    teacherId: teacherId || state.user.id,
    cancellationId: cancellationId || null
  };
  showScreen('screen-schedule');
  showPlacingBanner(name ? `Выберите место для ${name}` : undefined);
  renderGrid();
}

async function placeTruantOnCell(day, room, slot) {
  if (typeof placementInFlight !== 'undefined' && placementInFlight) return;
  var t = state.placingTruant; if (!t) return;
  var end = slot + t.slotLength;
  if (end > TOTAL_SLOTS) { showToast('Не помещается', 'error'); return; }
  placementInFlight = true;
  try {
    var ct = await checkConflictServer(day, room, slot, end, null, t.teacherId);
    if (ct === 'room') { showToast('Кабинет занят', 'error'); return; }
    if (ct === 'teacher') { showToast('Преподаватель занят', 'error'); return; }

    var dates = getWeekDates(state.currentWeekStart); var date = dates[day];
    var sTime = new Date(date); sTime.setHours(START_HOUR + Math.floor(slot * SLOT_MINUTES / 60), (slot * SLOT_MINUTES) % 60, 0, 0);
    var eTime = new Date(date); eTime.setHours(START_HOUR + Math.floor(end * SLOT_MINUTES / 60), (end * SLOT_MINUTES) % 60, 0, 0);

    // Auto-merge: if a lesson with the exact same room/start/end already exists for this
    // teacher, the user wants to JOIN that group, not stack a duplicate on top of it.
    var sMs = sTime.getTime(), eMs = eTime.getTime();
    var twin = state.lessons.find(function (l) {
      return l.room === room && l.teacher_id === t.teacherId &&
        new Date(l.start_time).getTime() === sMs &&
        new Date(l.end_time).getTime() === eMs;
    });
    if (twin) {
      placementInFlight = false;
      showToast('Объединено с существующим занятием', 'success');
      return placeTruantOnLesson(twin.id);
    }

    var result = await db.from('lessons').insert({
      teacher_id: t.teacherId, room: room, week_start: formatDate(state.currentWeekStart),
      start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
    }).select().single();
    if (result.error) { showToast('Ошибка', 'error'); return; }
    await db.from('lesson_students').insert({ lesson_id: result.data.id, student_id: t.studentId });
    await attachActiveSubscriptionIfAny(result.data.id, t.studentId, t.teacherId);

    if (t.cancellationId) {
      await db.from('cancellations').delete().eq('id', t.cancellationId);
    } else {
      var pending = await db.from('cancellations').select('id').eq('student_id', t.studentId).eq('teacher_id', t.teacherId).eq('status', 'pending').order('week_start').limit(1);
      if (pending.data && pending.data.length > 0) await db.from('cancellations').delete().eq('id', pending.data[0].id);
    }

    state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
    showToast('Ученик размещён для отработки', 'success');
    await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

async function placeTruantOnLesson(targetLessonId) {
  if (typeof placementInFlight !== 'undefined' && placementInFlight) return;
  var t = state.placingTruant; if (!t) return;
  var tl = state.lessons.find(function(l) { return l.id === targetLessonId; });
  if (!tl) { showToast('Занятие не найдено', 'error'); return; }
  if (tl.teacher_id !== t.teacherId) { showToast('Только к своему преподавателю', 'error'); return; }
  placementInFlight = true;
  try {

  // Compute target lesson's duration in slots
  var tStart = new Date(tl.start_time), tEnd = new Date(tl.end_time);
  var targetSlots = Math.round((tEnd.getTime() - tStart.getTime()) / (SLOT_MINUTES * 60 * 1000));

  // Helper to close the cancellation row after a successful placement
  async function closeCancellation() {
    if (t.cancellationId) {
      await db.from('cancellations').delete().eq('id', t.cancellationId);
    } else {
      var pending = await db.from('cancellations').select('id').eq('student_id', t.studentId).eq('teacher_id', t.teacherId).eq('status', 'pending').order('week_start').limit(1);
      if (pending.data && pending.data.length > 0) await db.from('cancellations').delete().eq('id', pending.data[0].id);
    }
  }

  // Duration mismatch — create a separate (parallel) lesson at the same room+start with the truant's
  // original duration. This is the same rule we use for student DnD: the student's duration is
  // never silently overwritten by the target group's duration.
  if (targetSlots !== t.slotLength) {
    var dates = getWeekDates(state.currentWeekStart);
    var di = dates.findIndex(function(d) {
      return d.getFullYear() === tStart.getFullYear() && d.getMonth() === tStart.getMonth() && d.getDate() === tStart.getDate();
    });
    if (di === -1) { showToast('Ошибка даты', 'error'); return; }

    var startSlot = (tStart.getHours() * 60 + tStart.getMinutes() - START_HOUR * 60) / SLOT_MINUTES;
    var endSlot = startSlot + t.slotLength;
    if (endSlot > TOTAL_SLOTS) { showToast('Длительность ученика не помещается в этот слот', 'error'); return; }

    var ct = await checkConflictServer(di, tl.room, startSlot, endSlot, null, t.teacherId);
    if (ct === 'room') { showToast('Кабинет занят', 'error'); return; }
    if (ct === 'teacher') { showToast('Преподаватель занят', 'error'); return; }
    if (ct) { showToast('Конфликт', 'error'); return; }

    var sTime = new Date(tStart);
    var eTime = new Date(tStart.getTime() + t.slotLength * SLOT_MINUTES * 60 * 1000);

    var ins = await db.from('lessons').insert({
      teacher_id: t.teacherId, room: tl.room, week_start: formatDate(state.currentWeekStart),
      start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
    }).select().single();
    if (ins.error) { showToast('Ошибка', 'error'); return; }

    await db.from('lesson_students').insert({ lesson_id: ins.data.id, student_id: t.studentId });
    await attachActiveSubscriptionIfAny(ins.data.id, t.studentId, t.teacherId);
    await closeCancellation();

    state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
    showToast('Размещён в отдельное занятие (своя длительность)', 'success');
    await loadLessons();
    return;
  }

  // Same duration — merge into target group as before
  var targetStudents = tl.lesson_students || [];
  if (targetStudents.some(function(ls) { return ls.student_id === t.studentId; })) {
    showToast('Ученик уже в этом занятии', 'error'); return;
  }
  var truantResult = await db.from('students').select('is_individual').eq('id', t.studentId).single();
  var isInd = truantResult.data ? truantResult.data.is_individual : false;
  var targetHasIndividual = targetStudents.some(function(ls) { return ls.student && ls.student.is_individual; });

  if (isInd && targetStudents.length > 0) {
    showToast('Индивидуальное занятие — только один ученик', 'error'); return;
  }
  if (!isInd && targetHasIndividual) {
    showToast('В занятии уже индивидуальный ученик', 'error'); return;
  }
  if (targetStudents.length >= getMaxGroup(tl.teacher_id)) { showToast('Максимум ' + getMaxGroup(tl.teacher_id) + ' учеников', 'error'); return; }

  await db.from('lesson_students').insert({ lesson_id: targetLessonId, student_id: t.studentId });
  await attachActiveSubscriptionIfAny(targetLessonId, t.studentId, t.teacherId);
  await closeCancellation();

  state.placingTruant = null; hidePlacingBanner(); clearDragHighlight();
  showToast('Ученик добавлен к занятию', 'success');
  await loadLessons();
  } finally {
    placementInFlight = false;
  }
}

function initCancellations() {}
