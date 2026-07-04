let editingStudentId = null;
let subjectsList = [];

let subjectsFreshlyLoaded = false;

async function loadSubjects() {
  const isFreshLoad = !subjectsFreshlyLoaded;
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('subjects') : null;
    if (cached && Array.isArray(cached)) {
      subjectsList = cached;
      populateSubjectSelects();
    }
  }
  const { data, error } = await db.from('subjects').select('*').order('name');
  if (error) return;
  subjectsList = data || [];
  populateSubjectSelects();
  if (typeof cacheSet === 'function') cacheSet('subjects', subjectsList);
  subjectsFreshlyLoaded = true;
}

function populateSubjectSelects() {
  const sel = document.getElementById('student-subject');
  if (sel) sel.innerHTML = subjectsList.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
  const filterSel = document.getElementById('filter-subject');
  if (filterSel) {
    const current = filterSel.value;
    filterSel.innerHTML = '<option value="">Все предметы</option>' + subjectsList.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
    filterSel.value = current;
  }
}

// Same "freshly loaded" guard as loadLessons — prevents the cache from
// flicker-overwriting fresh state on subsequent refresh calls.
let studentsFreshlyLoaded = false;

async function loadStudents() {
  const isFreshLoad = !studentsFreshlyLoaded;
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('students') : null;
    if (cached && Array.isArray(cached)) {
      state.students = cached;
      renderStudents();
    }
  }

  // Show skeleton rows on first load (when list is empty); on refresh keep
  // existing rows visible to avoid flicker.
  const list = document.getElementById('students-list');
  if (list && !list.querySelector('.student-card:not(.skel-row)') && !list.querySelector('.students-empty') && !list.querySelector('.skel-row')) {
    list.innerHTML = '<div class="student-card skel-row"></div>'.repeat(5);
  }
  const isAdmin = state.profile.role === 'admin';
  let query = db.from('students').select('*, teacher:profiles!teacher_id(full_name, short_name)');
  if (!isAdmin) query = query.eq('teacher_id', state.user.id);
  query = query.order('first_name');
  const { data, error } = await query;
  if (error) {
    if (isFreshLoad && (!state.students || state.students.length === 0)) {
      showToast('Ошибка загрузки учеников', 'error');
    }
    return;
  }
  state.students = data || [];
  renderStudents();
  if (typeof cacheSet === 'function') cacheSet('students', state.students);
  studentsFreshlyLoaded = true;
}

function renderStudents(filter = '') {
  const list = document.getElementById('students-list');
  const isAdmin = state.profile.role === 'admin';
  const search = filter.toLowerCase();
  const subjectFilter = document.getElementById('filter-subject')?.value || '';
  const gradeFilter = document.getElementById('filter-grade')?.value || '';

  let filtered = state.students;
  if (search) {
    filtered = filtered.filter(s =>
      s.first_name.toLowerCase().includes(search) || s.last_name.toLowerCase().includes(search)
    );
  }
  if (subjectFilter) {
    filtered = filtered.filter(s => s.subject === subjectFilter);
  }
  if (gradeFilter) {
    filtered = filtered.filter(s => s.grade === +gradeFilter);
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="students-empty">Нет учеников</div>';
    return;
  }

  if (isAdmin) {
    const grouped = {};
    filtered.forEach(s => {
      const tId = s.teacher_id;
      const tName = s.teacher?.full_name || 'Без преподавателя';
      if (!grouped[tId]) grouped[tId] = { name: tName, students: [] };
      grouped[tId].students.push(s);
    });

    const entries = Object.entries(grouped);
    entries.sort((a, b) => {
      if (a[0] === state.user.id) return -1;
      if (b[0] === state.user.id) return 1;
      return a[1].name.localeCompare(b[1].name);
    });

    list.innerHTML = entries.map(([tId, group]) =>
      `<div class="students-group" data-teacher-id="${tId}">
        <div class="students-group-header" data-teacher-id="${tId}">
          <span class="students-group-name">${escapeHtml(group.name)}</span>
          <span class="students-group-count">${group.students.length}</span>
          <span class="students-group-arrow">›</span>
        </div>
        <div class="students-group-body collapsed">
          ${group.students.map(s => studentCardHTML(s)).join('')}
        </div>
      </div>`
    ).join('');

    list.querySelectorAll('.students-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        const arrow = header.querySelector('.students-group-arrow');
        const isCollapsed = body.classList.contains('collapsed');
        if (isCollapsed) {
          body.style.maxHeight = body.scrollHeight + 'px';
          body.classList.remove('collapsed');
          arrow.classList.add('open');
          setTimeout(() => { body.style.maxHeight = 'none'; }, 300);
        } else {
          body.style.maxHeight = body.scrollHeight + 'px';
          requestAnimationFrame(() => {
            body.style.maxHeight = '0px';
            body.classList.add('collapsed');
            arrow.classList.remove('open');
          });
        }
      });
    });
  } else {
    list.innerHTML = filtered.map(s => studentCardHTML(s)).join('');
  }

  list.querySelectorAll('.student-card').forEach(card => {
    card.addEventListener('click', () => openStudentDetail(card.dataset.id));
  });
}

function studentCardHTML(s) {
  const isUnlinked = !s.profile_id;
  return `<div class="student-card ${isUnlinked ? 'student-card-unlinked' : ''}" data-id="${s.id}">
    <div class="student-card-main">
      <span class="student-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}</span>
      <span class="student-subject">${escapeHtml(s.subject || '')}</span>
    </div>
    <div class="student-card-meta">
      ${s.grade ? `<span>${escapeHtml(s.grade)} класс</span>` : ''}
      ${isUnlinked ? '<span class="student-unlinked-badge" title="Не привязан к аккаунту">Тест</span>' : ''}
    </div>
  </div>`;
}

function openStudentModal(title, student = null) {
  editingStudentId = student ? student.id : null;
  document.getElementById('modal-student-title').textContent = title;
  document.getElementById('student-first-name').value = student?.first_name || '';
  document.getElementById('student-last-name').value = student?.last_name || '';
  populateSubjectSelects();
  document.getElementById('student-subject').value = student?.subject || (subjectsList[0]?.name || '');
  document.getElementById('student-grade').value = student?.grade || 11;
  document.getElementById('student-is-individual').value = student?.is_online ? 'online' : String(student?.is_individual || false);
  document.getElementById('student-price-type').value = student?.price_type || 'new';
  document.getElementById('student-notes').value = student?.notes || '';
  document.getElementById('btn-delete-student').style.display = student ? 'block' : 'none';
  document.getElementById('modal-overlay').classList.add('active');
}

function closeStudentModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  editingStudentId = null;
}

function openEditStudent(id) {
  const student = state.students.find(s => s.id === id);
  if (student) openStudentModal('Редактировать ученика', student);
}

async function saveStudent() {
  const firstName = document.getElementById('student-first-name').value.trim();
  const lastName = document.getElementById('student-last-name').value.trim();
  const subject = document.getElementById('student-subject').value;
  const grade = parseInt(document.getElementById('student-grade').value);
  const typeVal = document.getElementById('student-is-individual').value;
  const isIndividual = typeVal === 'true' || typeVal === 'online';
  const isOnline = typeVal === 'online';
  const priceType = document.getElementById('student-price-type').value;
  const notes = document.getElementById('student-notes').value.trim();

  // ===== Validation =====
  if (!firstName) { showToast('Введите имя', 'error'); return; }
  if (!lastName)  { showToast('Введите фамилию', 'error'); return; }
  if (firstName.length > 30 || lastName.length > 30) {
    showToast('Имя/фамилия не длиннее 30 символов', 'error'); return;
  }
  // Cyrillic / Latin letters, spaces, hyphens, apostrophes only
  const nameRe = /^[A-Za-zА-Яа-яЁё\s\-']+$/;
  if (!nameRe.test(firstName)) { showToast('Имя содержит недопустимые символы', 'error'); return; }
  if (!nameRe.test(lastName))  { showToast('Фамилия содержит недопустимые символы', 'error'); return; }
  if (!subject) { showToast('Укажите предмет', 'error'); return; }
  if (!Number.isFinite(grade) || grade < 1 || grade > 11) {
    showToast('Класс должен быть от 1 до 11', 'error'); return;
  }
  if (notes.length > 1000) { showToast('Примечание слишком длинное (макс 1000 символов)', 'error'); return; }

  // Double-click guard for the save button
  const btn = document.getElementById('btn-save-student');
  if (btn.disabled) return;
  btn.disabled = true;

  try {
    const record = {
      first_name: firstName, last_name: lastName, subject, grade,
      is_individual: isIndividual, is_online: isOnline, price_type: priceType,
      notes: notes || null, teacher_id: state.user.id
    };

    let error;
    if (editingStudentId) {
      ({ error } = await db.from('students').update(record).eq('id', editingStudentId));
    } else {
      ({ error } = await db.from('students').insert(record));
    }

    if (error) { showToast('Ошибка сохранения', 'error'); return; }

    const isEdit = !!editingStudentId;
    closeStudentModal();
    showToast(isEdit ? 'Ученик отредактирован' : 'Ученик добавлен', 'success');
    await loadStudents();
  } finally {
    btn.disabled = false;
  }
}

let confirmCallback = null;
let cancelConfirmCallback = null;

function showConfirm(text, callback, btnLabel, btnVariant) {
  document.getElementById('confirm-text').textContent = text;
  const okBtn = document.getElementById('btn-confirm-ok');
  okBtn.textContent = btnLabel || 'Удалить';
  // Reset variant classes, then apply the requested one (default: danger)
  okBtn.classList.remove('btn-danger', 'btn-primary', 'btn-success');
  const variantClass = btnVariant === 'success' ? 'btn-success'
                     : btnVariant === 'primary' ? 'btn-primary'
                     : 'btn-danger';
  okBtn.classList.add(variantClass);
  confirmCallback = callback;
  document.getElementById('confirm-overlay').classList.add('active');
}

function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('active');
  confirmCallback = null;
}

function showCancelConfirm(text, callback) {
  document.getElementById('cancel-confirm-text').textContent = text;
  document.getElementById('cancel-is-paid').checked = false;
  cancelConfirmCallback = callback;
  document.getElementById('cancel-confirm-overlay').classList.add('active');
}

function closeCancelConfirm() {
  document.getElementById('cancel-confirm-overlay').classList.remove('active');
  cancelConfirmCallback = null;
}

async function deleteStudent() {
  if (!editingStudentId) return;
  const id = editingStudentId;
  const student = state.students.find(s => s.id === id);
  const name = student ? `${student.first_name} ${student.last_name}` : 'ученика';

  closeStudentModal();
  showConfirm(`Удалить ${name}? Вся история и занятия будут удалены.`, async () => {
    await db.from('lesson_students').delete().eq('student_id', id);
    await db.from('cancellations').delete().eq('student_id', id);
    await db.from('payments').delete().eq('student_id', id);
    const { error } = await db.from('students').delete().eq('id', id);
    if (error) { showToast('Ошибка удаления', 'error'); return; }
    showToast('Ученик удалён', 'success');
    await loadStudents();
  });
}

function initStudents() {
  document.getElementById('btn-add-student').addEventListener('click', () => {
    openStudentModal('Добавить ученика');
  });

  document.getElementById('btn-save-student').addEventListener('click', saveStudent);
  document.getElementById('btn-cancel-student').addEventListener('click', closeStudentModal);
  document.getElementById('btn-modal-close').addEventListener('click', closeStudentModal);
  document.getElementById('btn-delete-student').addEventListener('click', deleteStudent);

  document.getElementById('btn-confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirm();
  });

  document.getElementById('btn-cancel-confirm-close').addEventListener('click', closeCancelConfirm);
  document.getElementById('btn-cancel-confirm-ok').addEventListener('click', () => {
    const isPaid = document.getElementById('cancel-is-paid').checked;
    if (cancelConfirmCallback) cancelConfirmCallback(isPaid);
    closeCancelConfirm();
  });

  document.getElementById('student-search').addEventListener('input', debounce((e) => {
    renderStudents(e.target.value);
  }, 150));

  document.getElementById('filter-subject').addEventListener('change', () => {
    renderStudents(document.getElementById('student-search').value);
  });

  document.getElementById('filter-grade').addEventListener('change', () => {
    renderStudents(document.getElementById('student-search').value);
  });

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeStudentModal();
  });

  document.getElementById('confirm-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirm();
  });

  // Student detail modal
  document.getElementById('btn-close-student-detail').addEventListener('click', closeStudentDetail);
  document.getElementById('btn-cancel-student-detail').addEventListener('click', closeStudentDetail);
  document.getElementById('btn-save-student-detail').addEventListener('click', saveStudentDetail);
  document.getElementById('btn-delete-student-detail').addEventListener('click', () => {
    if (!studentDetailId) return;
    const student = state.students.find(s => s.id === studentDetailId);
    const name = student ? `${student.first_name} ${student.last_name}` : 'ученика';
    const id = studentDetailId;
    closeStudentDetail();
    showConfirm(`Удалить ${name}? Вся история и занятия будут удалены.`, async () => {
      await db.from('lesson_students').delete().eq('student_id', id);
      await db.from('cancellations').delete().eq('student_id', id);
      await db.from('payments').delete().eq('student_id', id);
      const { error } = await db.from('students').delete().eq('id', id);
      if (error) { showToast('Ошибка удаления', 'error'); return; }
      showToast('Ученик удалён', 'success');
      await loadStudents();
    });
  });
  document.getElementById('student-detail-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeStudentDetail();
  });

  // Link student modal
  document.getElementById('btn-close-link-student').addEventListener('click', closeLinkStudentModal);
  document.getElementById('btn-cancel-link-student').addEventListener('click', closeLinkStudentModal);
  document.getElementById('link-student-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLinkStudentModal();
  });
  document.getElementById('link-student-search').addEventListener('input', debounce((e) => {
    renderLinkStudentList(e.target.value);
  }, 150));
}

let studentDetailId = null;

async function openStudentDetail(studentId) {
  studentDetailId = studentId;
  // Fire the four independent reads in parallel — they don't depend on each other.
  // Saves ~2 round-trips on slow connections.
  const [studentRes, lessonsRes, paymentsRes, missedRes] = await Promise.all([
    db.from('students')
      .select('*, teacher:profiles!teacher_id(full_name, color)')
      .eq('id', studentId).single(),
    db.from('lessons')
      .select('id, start_time, end_time, status, subject, week_start, lesson_students!inner(student_id)')
      .eq('lesson_students.student_id', studentId)
      .in('status', ['active', 'cancelled'])
      .order('start_time', { ascending: false }),
    db.from('payments')
      .select('id, lesson_id, amount, payment_method, status, submitted_at')
      .eq('student_id', studentId)
      .order('submitted_at', { ascending: false }),
    db.from('cancellations')
      .select('id, week_start, lesson_start_time, lesson_end_time, recurring_lesson_id')
      .eq('student_id', studentId)
      .eq('status', 'missed')
      .order('week_start', { ascending: false })
  ]);
  const student = studentRes.data;
  if (!student) { showToast('Ученик не найден', 'error'); return; }
  const lessons = lessonsRes.data;
  const payments = paymentsRes.data;

  // Resolve recurring_lesson templates for the missed cancellations in a second query.
  // We avoid PostgREST embed (`recurring_lesson:recurring_lessons(...)`) because that
  // syntax requires a declared FK constraint on cancellations.recurring_lesson_id and
  // returns 400 if the constraint is missing. Two-query approach is FK-agnostic.
  const missedRaw = missedRes.data || [];
  const recIds = [...new Set(missedRaw.map(c => c.recurring_lesson_id).filter(Boolean))];
  let recById = {};
  if (recIds.length > 0) {
    const { data: recRows } = await db.from('recurring_lessons')
      .select('id, start_time, end_time, day_of_week, subject')
      .in('id', recIds);
    (recRows || []).forEach(r => { recById[r.id] = r; });
  }

  // Convert missed cancellations into synthetic "missed" lesson rows. They participate
  // in the same per-subject grouping and attendance counters as the real lesson rows.
  const missedRows = missedRaw.map(c => {
    const rec = c.recurring_lesson_id ? recById[c.recurring_lesson_id] : null;
    // Prefer the cancellation's own captured time (set when the lesson was concrete).
    // Otherwise compute the date from week_start + day_of_week + time on the recurring template.
    let startISO = c.lesson_start_time || null;
    let endISO = c.lesson_end_time || null;
    let subj = null;
    if (rec) subj = rec.subject || null;
    if (!startISO && rec && c.week_start) {
      const monday = new Date(c.week_start);
      const dow = rec.day_of_week;
      const date = new Date(monday); date.setDate(monday.getDate() + dow);
      const sp = (rec.start_time || '00:00').split(':');
      const ep = (rec.end_time || '00:00').split(':');
      const s = new Date(date); s.setHours(+sp[0], +sp[1], 0, 0);
      const e = new Date(date); e.setHours(+ep[0], +ep[1], 0, 0);
      startISO = s.toISOString();
      endISO = e.toISOString();
    }
    if (!startISO) return null; // can't render without a time
    return {
      id: 'missed-' + c.id,
      _missedCancellationId: c.id,
      start_time: startISO,
      end_time: endISO,
      status: 'missed',
      subject: subj,
      week_start: c.week_start
    };
  }).filter(Boolean);

  const pendingPayments = (payments || []).filter(p => p.status === 'pending');
  const paymentsByLesson = {};
  (payments || []).forEach(p => { paymentsByLesson[p.lesson_id] = p; });

  // Group lessons by subject (including synthetic missed rows)
  const lessonList = [...(lessons || []), ...missedRows]
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  const subjectGroups = {};
  lessonList.forEach(l => {
    const subj = l.subject || student.subject || 'Без предмета';
    if (!subjectGroups[subj]) subjectGroups[subj] = [];
    subjectGroups[subj].push(l);
  });

  // Build select options
  const subjectOptions = subjectsList.map(s =>
    `<option value="${escapeHtml(s.name)}" ${s.name === (student.subject || '') ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
  ).join('');
  const gradeOptions = [5,6,7,8,9,10,11].map(g =>
    `<option value="${g}" ${g === (student.grade || 11) ? 'selected' : ''}>${g}</option>`
  ).join('');
  const sourceOptions = [
    ['','— Не указан —'],['auto','Авто'],['youla','Юла'],['recommend','Рекомендации'],['vk','ВКонтакте'],['other','Другое']
  ].map(([v,l]) => `<option value="${v}" ${(student.source||'') === v ? 'selected' : ''}>${l}</option>`).join('');

  const body = document.getElementById('student-detail-body');

  let html = `
    <div class="sd-top">
      <div class="sd-fields">
        ${!student.profile_id ? `<div class="sd-link-banner">
          <div class="sd-link-banner-text">Тестовая карточка — не привязана к аккаунту ученика.</div>
          <button class="btn-link-account" type="button">Привязать аккаунт</button>
        </div>` : ''}
        <div class="form-row">
          <div class="form-group"><label>Имя</label><input type="text" id="sd-first-name" value="${escapeHtml(student.first_name || '')}" maxlength="30"></div>
          <div class="form-group"><label>Фамилия</label><input type="text" id="sd-last-name" value="${escapeHtml(student.last_name || '')}" maxlength="30"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Предмет</label><select id="sd-subject">${subjectOptions}</select></div>
          <div class="form-group"><label>Класс</label><select id="sd-grade">${gradeOptions}</select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Тип занятия</label>
            <select id="sd-type">
              <option value="false" ${!student.is_individual && !student.is_online ? 'selected' : ''}>Групповое</option>
              <option value="true" ${student.is_individual && !student.is_online ? 'selected' : ''}>Индивидуальное</option>
              <option value="online" ${student.is_online ? 'selected' : ''}>Онлайн</option>
            </select>
          </div>
          <div class="form-group"><label>Тип цены</label>
            <select id="sd-price-type">
              <option value="new" ${student.price_type === 'new' ? 'selected' : ''}>Новая</option>
              <option value="old" ${student.price_type === 'old' ? 'selected' : ''}>Старая</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Источник</label><select id="sd-source">${sourceOptions}</select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>ФИО родителя</label><input type="text" id="sd-parent-name" value="${escapeHtml(student.parent_name || '')}" placeholder="Иванова Мария Сергеевна"></div>
          <div class="form-group"><label>Телефон родителя</label><input type="text" id="sd-parent-phone" value="${escapeHtml(student.parent_phone || '')}" placeholder="+7 (999) 000-00-00"></div>
        </div>
        <div class="form-group"><label>Примечание</label><textarea id="sd-note" rows="2">${escapeHtml(student.notes || '')}</textarea></div>
      </div>
    </div>`;

  function formatDur(ms) {
    const min = Math.round(ms / 60000);
    if (min % 60 === 0) return (min / 60) + 'ч';
    if (min % 30 === 0) return (min / 60).toFixed(1) + 'ч';
    return min + 'мин';
  }

  function buildLessonsTable(group) {
    const now = new Date();
    const completed = group.filter(l => l.status === 'active' && new Date(l.end_time) < now).length;
    const cancelled = group.filter(l => l.status === 'cancelled').length;
    const missed    = group.filter(l => l.status === 'missed').length;
    const upcoming  = group.filter(l => l.status === 'active' && new Date(l.end_time) >= now).length;
    // Attendance: completed vs (completed + missed). Pending cancellations are not yet final
    // misses (they can still be made up), so they don't drag the number down — only the
    // permanent 'missed' status does, mirroring how the truants list works.
    const att = (completed + missed) > 0 ? Math.round(completed / (completed + missed) * 100) : null;

    let t = `<div class="sd-subject-stats">`;
    t += `<span>Всего: <b>${group.length}</b></span>`;
    t += `<span>Проведено: <b>${completed}</b></span>`;
    if (cancelled > 0) t += `<span>Отменено: <b>${cancelled}</b></span>`;
    if (missed > 0)    t += `<span>Прогулов: <b>${missed}</b></span>`;
    if (upcoming > 0)  t += `<span>Предстоит: <b>${upcoming}</b></span>`;
    if (att !== null)  t += `<span>Посещаемость: <b>${att}%</b></span>`;
    t += `</div>`;

    t += `<div class="sd-table-wrap"><table class="sd-table">
      <thead><tr><th>Дата</th><th>Время</th><th>Длит.</th><th>Статус</th><th>Оплата</th><th></th></tr></thead><tbody>`;

    group.forEach(l => {
      const s = new Date(l.start_time); const e = new Date(l.end_time);
      const dur = formatDur(e - s);
      const dd = s.getDate().toString().padStart(2,'0');
      const mm = (s.getMonth()+1).toString().padStart(2,'0');
      const dayIdx = s.getDay() === 0 ? 6 : s.getDay() - 1;
      const day = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][dayIdx];
      const time = `${s.getHours().toString().padStart(2,'0')}:${s.getMinutes().toString().padStart(2,'0')}`;
      const past = e < now;
      let statusStr;
      if (l.status === 'missed') {
        statusStr = '<span class="history-status history-missed">Прогул</span>';
      } else if (l.status === 'cancelled') {
        statusStr = '<span class="history-status history-cancelled">Отм.</span>';
      } else if (past) {
        statusStr = '<span class="history-status history-completed">✓</span>';
      } else {
        statusStr = '<span class="history-status history-planned">⏳</span>';
      }
      const p = paymentsByLesson[l.id];
      const payStr = (l.status === 'missed' || !past) ? '—'
        : p?.status === 'approved' ? '<span class="pay-paid">✓</span>'
        : p?.status === 'pending' ? '<span class="pay-pending">⏳</span>'
        : '<span class="pay-unpaid">✕</span>';
      // No delete button for synthetic missed rows — they're derived from cancellations
      // and represent confirmed truancy that shouldn't be casually erased.
      const delBtn = l.status === 'missed'
        ? ''
        : `<button class="btn-delete-lesson-row" data-lesson-id="${l.id}" title="Удалить запись">✕</button>`;
      t += `<tr><td>${dd}.${mm} ${day}</td><td>${time}</td><td>${dur}</td><td>${statusStr}</td><td>${payStr}</td><td class="sd-table-actions">${delBtn}</td></tr>`;
    });

    t += `</tbody></table></div>`;
    return t;
  }

  // Subscription section: render with a placeholder first; the heavy chain
  // (rebindOrphan → recompute → loadActive) runs asynchronously below and replaces
  // just this block when ready. This makes the card appear ~1s sooner on slow connections.
  html += `<div class="sd-section sd-section-subscription">
    <h4>Абонемент</h4>
    <div id="sd-sub-panel-container">
      <div class="sub-panel sub-panel-empty"><div class="sub-empty-text">Загрузка…</div></div>
    </div>
  </div>`;

  const subjectEntries = Object.entries(subjectGroups);
  if (subjectEntries.length === 0) {
    html += `<div class="sd-section"><h4>Занятия</h4><div class="sd-empty">Нет занятий</div></div>`;
  } else if (subjectEntries.length === 1) {
    html += `<div class="sd-section"><h4>Занятия — ${escapeHtml(subjectEntries[0][0])}</h4>${buildLessonsTable(subjectEntries[0][1])}</div>`;
  } else {
    subjectEntries.forEach(([subj, group]) => {
      html += `<div class="sd-section"><h4>${escapeHtml(subj)}</h4>${buildLessonsTable(group)}</div>`;
    });
  }

  // Pending payments
  if (pendingPayments.length > 0) {
    html += `<div class="sd-section"><h4>Заявки на оплату</h4><div class="sd-payments">`;
    pendingPayments.forEach(p => {
      const d = new Date(p.submitted_at);
      const dd = d.getDate().toString().padStart(2,'0');
      const mm = (d.getMonth()+1).toString().padStart(2,'0');
      const methodLabel = p.payment_method === 'cash' ? 'Наличными' : 'Переводом';
      html += `<div class="sd-payment-row">
        <span class="sd-pay-info">${dd}.${mm} · ${p.amount} ₽ · ${methodLabel}</span>
        <div class="sd-pay-actions">
          <button class="btn-sm btn-primary" data-approve="${p.id}">Подтвердить</button>
          <button class="btn-sm btn-danger" data-reject="${p.id}">Отклонить</button>
        </div>
      </div>`;
    });
    html += `</div></div>`;
  }

  document.getElementById('student-detail-title').textContent =
    `${student.first_name} ${student.last_name}`;

  body.innerHTML = html;

  body.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.from('payments').update({ status: 'approved', approved_at: new Date().toISOString(), approved_by_id: state.user.id }).eq('id', btn.dataset.approve);
      showToast('Оплата подтверждена', 'success');
      await openStudentDetail(studentId);
    });
  });

  body.querySelectorAll('[data-reject]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.from('payments').update({ status: 'rejected' }).eq('id', btn.dataset.reject);
      showToast('Оплата отклонена', 'success');
      await openStudentDetail(studentId);
    });
  });

  const linkBtn = body.querySelector('.btn-link-account');
  if (linkBtn) {
    linkBtn.addEventListener('click', () => openLinkStudentModal(studentId, student.teacher_id));
  }

  // Helper: bind buttons that live inside the (re-rendered) subscription panel
  function bindSubPanelButtons() {
    const activateSubBtn = body.querySelector('#btn-activate-sub');
    if (activateSubBtn) {
      activateSubBtn.addEventListener('click', () => openSubscriptionActivation(activateSubBtn.dataset.studentId));
    }
    const deleteSubBtn = body.querySelector('#btn-delete-sub');
    if (deleteSubBtn) {
      deleteSubBtn.addEventListener('click', async () => {
        const subId = deleteSubBtn.dataset.subId;
        showConfirm('Удалить абонемент? Связанные занятия останутся в расписании и станут разовыми. Это действие нельзя отменить.', async () => {
          const { error } = await db.from('subscriptions').delete().eq('id', subId);
          if (error) { showToast('Ошибка: ' + error.message, 'error'); return; }
          showToast('Абонемент удалён', 'success');
          invalidateSubscriptionCache(studentId);
          await openStudentDetail(studentId);
        }, 'Удалить');
      });
    }
    const refundSubBtn = body.querySelector('#btn-refund-sub');
    if (refundSubBtn) {
      refundSubBtn.addEventListener('click', () => openSubscriptionRefund(refundSubBtn.dataset.subId));
    }
  }

  // Kick off the heavy subscription chain in the background — the card is already
  // visible at this point. When ready, swap just the placeholder panel.
  (async () => {
    try {
      await rebindOrphanLessonsForStudents([studentId]);
      await recomputeSubscriptionsForStudents([studentId]);
      const activeSub = await loadActiveSubscriptionForStudent(studentId, true);
      // Guard: user may have closed the card or opened another one in the meantime.
      if (studentDetailId !== studentId) return;
      const container = document.getElementById('sd-sub-panel-container');
      if (!container) return;
      container.innerHTML = renderSubscriptionPanelHTML(activeSub, studentId);
      bindSubPanelButtons();
    } catch (e) {
      console.error('sub panel load failed:', e);
    }
  })();

  // Delete this student's record from a lesson (NEVER deletes the lesson itself — even if this was the only student)
  body.querySelectorAll('.btn-delete-lesson-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lessonId = btn.dataset.lessonId;
      showConfirm('Удалить запись этого ученика на занятие? Другие ученики этого занятия останутся. Это действие нельзя отменить.', async () => {
        // Capture subscription id of THIS student's link (if any) so we can recompute it after delete
        const { data: link } = await db.from('lesson_students')
          .select('subscription_id').eq('lesson_id', lessonId).eq('student_id', studentId).maybeSingle();
        const subId = link?.subscription_id || null;

        const { error } = await db.from('lesson_students')
          .delete().eq('lesson_id', lessonId).eq('student_id', studentId);
        if (error) { showToast('Ошибка: ' + error.message, 'error'); return; }

        if (subId) await recomputeSubscriptionUsage(subId);
        showToast('Ученик удалён из занятия', 'success');
        await openStudentDetail(studentId);
      }, 'Удалить');
    });
  });

  document.getElementById('student-detail-overlay').classList.add('active');
}

function closeStudentDetail() {
  document.getElementById('student-detail-overlay').classList.remove('active');
  studentDetailId = null;
}

async function saveStudentDetail() {
  if (!studentDetailId) return;
  const firstName = document.getElementById('sd-first-name').value.trim();
  const lastName = document.getElementById('sd-last-name').value.trim();
  const typeVal = document.getElementById('sd-type').value;
  const grade = parseInt(document.getElementById('sd-grade').value);
  const parentName = document.getElementById('sd-parent-name').value.trim();
  const parentPhone = document.getElementById('sd-parent-phone').value.trim();
  const notes = document.getElementById('sd-note').value.trim();

  // ===== Validation =====
  if (!firstName) { showToast('Введите имя', 'error'); return; }
  if (!lastName)  { showToast('Введите фамилию', 'error'); return; }
  if (firstName.length > 30 || lastName.length > 30) {
    showToast('Имя/фамилия не длиннее 30 символов', 'error'); return;
  }
  // Same rule as saveStudent(): Cyrillic / Latin letters, spaces, hyphens, apostrophes
  const nameRe = /^[A-Za-zА-Яа-яЁё\s\-']+$/;
  if (!nameRe.test(firstName)) { showToast('Имя содержит недопустимые символы', 'error'); return; }
  if (!nameRe.test(lastName))  { showToast('Фамилия содержит недопустимые символы', 'error'); return; }
  if (Number.isFinite(grade) && (grade < 1 || grade > 11)) {
    showToast('Класс должен быть от 1 до 11', 'error'); return;
  }
  if (notes.length > 1000) { showToast('Примечание слишком длинное (макс 1000)', 'error'); return; }
  if (parentName && parentName.length > 60) { showToast('ФИО родителя слишком длинное', 'error'); return; }
  if (parentPhone) {
    const digits = parentPhone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 12) {
      showToast('Телефон родителя: 10–12 цифр', 'error'); return;
    }
  }

  const btn = document.getElementById('btn-save-student-detail');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    const update = {
      first_name: firstName,
      last_name: lastName,
      subject: document.getElementById('sd-subject').value,
      grade: Number.isFinite(grade) ? grade : null,
      is_individual: typeVal === 'true' || typeVal === 'online',
      is_online: typeVal === 'online',
      price_type: document.getElementById('sd-price-type').value,
      source: document.getElementById('sd-source').value || null,
      parent_name: parentName || null,
      parent_phone: parentPhone || null,
      notes: notes || null
    };
    const { error } = await db.from('students').update(update).eq('id', studentDetailId);
    if (error) { showToast('Ошибка: ' + error.message, 'error'); return; }
    // Sync local state so renderStudents() picks up the change without a full reload.
    const idx = state.students.findIndex(s => s.id === studentDetailId);
    if (idx !== -1) state.students[idx] = { ...state.students[idx], ...update };
    if (typeof cacheSet === 'function') cacheSet('students', state.students);
    showToast('Сохранено', 'success');
    closeStudentDetail();
    renderStudents(document.getElementById('student-search').value);
  } finally {
    if (btn) btn.disabled = false;
  }
}
// === Link unregistered (fake) student to a real registered account ===

let linkContext = null; // { fakeStudentId, teacherId, profiles: [...] }

async function openLinkStudentModal(fakeStudentId, teacherId) {
  // Pull all approved student profiles. Filter out ones already linked
  // to this teacher via the students table (avoid offering duplicates).
  const { data: profiles, error: pErr } = await db.from('profiles')
    .select('id, full_name, phone, telegram')
    .eq('role', 'student')
    .eq('status', 'approved')
    .order('full_name');
  if (pErr) { showToast('Ошибка загрузки: ' + pErr.message, 'error'); return; }

  linkContext = { fakeStudentId, teacherId, profiles: profiles || [] };
  document.getElementById('link-student-search').value = '';
  renderLinkStudentList('');
  document.getElementById('link-student-overlay').classList.add('active');
}

function closeLinkStudentModal() {
  document.getElementById('link-student-overlay').classList.remove('active');
  linkContext = null;
}

function renderLinkStudentList(search) {
  const list = document.getElementById('link-student-list');
  if (!linkContext) { list.innerHTML = ''; return; }

  const q = (search || '').trim().toLowerCase();
  const filtered = linkContext.profiles.filter(p => {
    if (!q) return true;
    const hay = `${p.full_name || ''} ${p.phone || ''} ${p.telegram || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="link-student-empty">Никто не найден</div>';
    return;
  }

  list.innerHTML = filtered.map(p => `
    <div class="link-student-item" data-profile-id="${p.id}">
      <div class="link-student-item-main">
        <span class="link-student-name">${escapeHtml(p.full_name || '(без имени)')}</span>
        ${p.phone ? `<span class="link-student-phone">${escapeHtml(p.phone)}</span>` : ''}
      </div>
      <button class="btn-primary btn-sm" data-pick="${p.id}">Выбрать</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', () => confirmLinkStudent(btn.dataset.pick));
  });
}

function confirmLinkStudent(profileId) {
  if (!linkContext) return;
  const profile = linkContext.profiles.find(p => p.id === profileId);
  const name = profile?.full_name || 'этому ученику';
  showConfirm(
    `Перенести все занятия и платежи на «${name}»? Тестовая карточка будет удалена.`,
    () => performLinkStudent(linkContext.fakeStudentId, profileId, linkContext.teacherId),
    'Привязать'
  );
}

async function performLinkStudent(fakeStudentId, profileId, teacherId) {
  try {
    // Load ALL trial student fields — we'll copy them to the real student record
    const { data: fakeStudent } = await db.from('students')
      .select('*')
      .eq('id', fakeStudentId)
      .single();
    if (!fakeStudent) throw new Error('Тестовая карточка не найдена');
    const fakeSubject = fakeStudent.subject || null;

    // For this teacher, the real profile may have several students-records (different subjects).
    // We treat them as the SAME if the subject matches. No subject → first record.
    const { data: candidates } = await db.from('students')
      .select('id, subject')
      .eq('profile_id', profileId)
      .eq('teacher_id', teacherId);

    let matching = null;
    if (Array.isArray(candidates) && candidates.length > 0) {
      if (fakeSubject) {
        matching = candidates.find(c => (c.subject || '') === fakeSubject) || null;
      } else {
        matching = candidates[0];
      }
    }

    if (matching) {
      const realId = matching.id;

      // lesson_students PK = (lesson_id, student_id) — clean up potential collisions
      const { data: fakeLs } = await db.from('lesson_students').select('lesson_id').eq('student_id', fakeStudentId);
      const { data: realLs } = await db.from('lesson_students').select('lesson_id').eq('student_id', realId);
      const realLessonIds = new Set((realLs || []).map(r => r.lesson_id));
      for (const row of (fakeLs || [])) {
        if (realLessonIds.has(row.lesson_id)) {
          await db.from('lesson_students').delete().eq('lesson_id', row.lesson_id).eq('student_id', fakeStudentId);
        }
      }

      // Same for recurring_lesson_students
      const { data: fakeRls } = await db.from('recurring_lesson_students').select('recurring_lesson_id').eq('student_id', fakeStudentId);
      const { data: realRls } = await db.from('recurring_lesson_students').select('recurring_lesson_id').eq('student_id', realId);
      const realRecIds = new Set((realRls || []).map(r => r.recurring_lesson_id));
      for (const row of (fakeRls || [])) {
        if (realRecIds.has(row.recurring_lesson_id)) {
          await db.from('recurring_lesson_students').delete().eq('recurring_lesson_id', row.recurring_lesson_id).eq('student_id', fakeStudentId);
        }
      }

      // Transfer all remaining references to the real student id
      await db.from('lesson_students').update({ student_id: realId }).eq('student_id', fakeStudentId);
      await db.from('recurring_lesson_students').update({ student_id: realId }).eq('student_id', fakeStudentId);
      await db.from('cancellations').update({ student_id: realId }).eq('student_id', fakeStudentId);
      await db.from('payments').update({ student_id: realId }).eq('student_id', fakeStudentId);
      // Subscriptions also belong to a student — move them too so the trial's active subscription survives
      await db.from('subscriptions').update({ student_id: realId }).eq('student_id', fakeStudentId);

      // Copy ALL profile fields from trial to real, so the data entered on the trial card is preserved.
      // We do NOT touch profile_id of the real (it's already correct).
      await db.from('students').update({
        subject: fakeStudent.subject,
        grade: fakeStudent.grade,
        is_individual: fakeStudent.is_individual,
        is_online: fakeStudent.is_online,
        price_type: fakeStudent.price_type,
        source: fakeStudent.source,
        parent_name: fakeStudent.parent_name,
        parent_phone: fakeStudent.parent_phone,
        notes: fakeStudent.notes
      }).eq('id', realId);

      // Delete the trial record — all its data now lives under the real id
      const { error: delErr } = await db.from('students').delete().eq('id', fakeStudentId);
      if (delErr) throw delErr;
    } else {
      // No matching record exists for this teacher (different subject, or no records at all) —
      // just attach the profile_id and the fake becomes the real one.
      const { error: updErr } = await db.from('students').update({ profile_id: profileId }).eq('id', fakeStudentId);
      if (updErr) throw updErr;
    }

    closeLinkStudentModal();
    closeStudentDetail();
    showToast('Ученик привязан', 'success');
    await loadStudents();
  } catch (e) {
    console.error('linkStudent error:', e);
    showToast('Ошибка привязки: ' + (e.message || 'неизвестно'), 'error');
  }
}

async function computeStudentAttendance(studentId) {
  // Numerator: actually conducted past lessons (status='active', already happened)
  const { data: completedLessons } = await db.from('lessons')
    .select('id, lesson_students!inner(student_id)')
    .eq('lesson_students.student_id', studentId)
    .lte('start_time', new Date().toISOString())
    .eq('status', 'active');
  // Denominator addition: confirmed misses ('missed') — pending ones are not final yet
  // since they can still be made up before the 3-week boundary expires.
  const { data: missedCancellations } = await db.from('cancellations')
    .select('id')
    .eq('student_id', studentId)
    .eq('status', 'missed');
  const completed = (completedLessons || []).length;
  const missed = (missedCancellations || []).length;
  const total = completed + missed;
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}
