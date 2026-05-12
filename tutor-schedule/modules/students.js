let editingStudentId = null;
let subjectsList = [];

async function loadSubjects() {
  const { data } = await db.from('subjects').select('*').order('name');
  subjectsList = data || [];
  populateSubjectSelects();
}

function populateSubjectSelects() {
  const sel = document.getElementById('student-subject');
  if (sel) sel.innerHTML = subjectsList.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
  const filterSel = document.getElementById('filter-subject');
  if (filterSel) {
    const current = filterSel.value;
    filterSel.innerHTML = '<option value="">Все предметы</option>' + subjectsList.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    filterSel.value = current;
  }
}

async function loadStudents() {
  const isAdmin = state.profile.role === 'admin';
  let query = db.from('students').select('*, teacher:profiles!teacher_id(full_name, short_name)');
  if (!isAdmin) query = query.eq('teacher_id', state.user.id);
  query = query.order('first_name');
  const { data, error } = await query;
  if (error) { showToast('Ошибка загрузки учеников', 'error'); return; }
  state.students = data || [];
  renderStudents();
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
          <span class="students-group-name">${group.name}</span>
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
      <span class="student-name">${s.first_name} ${s.last_name}</span>
      <span class="student-subject">${s.subject || ''}</span>
    </div>
    <div class="student-card-meta">
      ${s.grade ? `<span>${s.grade} класс</span>` : ''}
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

  if (!firstName || !lastName) { showToast('Введите имя и фамилию', 'error'); return; }

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
}

let confirmCallback = null;
let cancelConfirmCallback = null;

function showConfirm(text, callback, btnLabel) {
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('btn-confirm-ok').textContent = btnLabel || 'Удалить';
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
  showConfirm(`Удалить ${name}?`, async () => {
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

  document.getElementById('student-search').addEventListener('input', (e) => {
    renderStudents(e.target.value);
  });

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
  document.getElementById('student-detail-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeStudentDetail();
  });

  // Link student modal
  document.getElementById('btn-close-link-student').addEventListener('click', closeLinkStudentModal);
  document.getElementById('btn-cancel-link-student').addEventListener('click', closeLinkStudentModal);
  document.getElementById('link-student-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLinkStudentModal();
  });
  document.getElementById('link-student-search').addEventListener('input', (e) => {
    renderLinkStudentList(e.target.value);
  });
}

let studentDetailId = null;

async function openStudentDetail(studentId) {
  studentDetailId = studentId;
  const { data: student } = await db.from('students')
    .select('*, teacher:profiles!teacher_id(full_name, color)')
    .eq('id', studentId).single();
  if (!student) { showToast('Ученик не найден', 'error'); return; }

  // Attendance
  const attendance = await computeStudentAttendance(studentId);

  document.getElementById('student-detail-title').innerHTML =
    `${student.first_name} ${student.last_name}<span class="sd-att-inline" title="Посещаемость">${attendance}%</span>`;

  // Recent lessons (last 4 weeks)
  const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const { data: lessons } = await db.from('lessons')
    .select('id, start_time, end_time, status, room, week_start, lesson_students!inner(student_id)')
    .eq('lesson_students.student_id', studentId)
    .gte('start_time', fourWeeksAgo.toISOString())
    .in('status', ['active', 'cancelled'])
    .order('start_time', { ascending: false })
    .limit(20);

  // Payments
  const { data: payments } = await db.from('payments')
    .select('id, lesson_id, amount, payment_method, status, submitted_at')
    .eq('student_id', studentId)
    .order('submitted_at', { ascending: false });

  const pendingPayments = (payments || []).filter(p => p.status === 'pending');
  const paymentsByLesson = {};
  (payments || []).forEach(p => { paymentsByLesson[p.lesson_id] = p; });

  // Build body
  const body = document.getElementById('student-detail-body');
  const typeLabel = student.is_online ? 'Онлайн' : (student.is_individual ? 'Индивидуальное' : 'Групповое');
  const priceLabel = student.price_type === 'old' ? 'Старая' : 'Новая';

  let html = `
    <div class="sd-top">
      <div class="sd-fields">
        ${!student.profile_id ? `<div class="sd-link-banner">
          <div class="sd-link-banner-text">Тестовая карточка — не привязана к аккаунту ученика.</div>
          <button class="btn-link-account" type="button">Привязать аккаунт</button>
        </div>` : ''}
        <div class="form-row">
          <div class="form-group"><label>Предмет</label><input type="text" id="sd-subject" value="${student.subject || ''}"></div>
          <div class="form-group"><label>Класс</label><input type="number" id="sd-grade" value="${student.grade || ''}" min="5" max="11"></div>
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
        <div class="form-group"><label>Примечание</label><textarea id="sd-note" rows="2">${student.notes || ''}</textarea></div>
      </div>
    </div>

    <div class="sd-section">
      <h4>Занятия</h4>
      <div class="sd-table-wrap">
        <table class="sd-table">
          <thead><tr><th>Дата</th><th>Время</th><th>Длит.</th><th>Каб.</th><th>Статус</th><th>Оплата</th></tr></thead>
          <tbody>`;

  (lessons || []).forEach(l => {
    const s = new Date(l.start_time); const e = new Date(l.end_time);
    const dur = Math.round((e - s) / 60000);
    const dd = s.getDate().toString().padStart(2,'0');
    const mm = (s.getMonth()+1).toString().padStart(2,'0');
    const dayIdx = s.getDay() === 0 ? 6 : s.getDay() - 1;
    const day = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][dayIdx];
    const time = `${s.getHours().toString().padStart(2,'0')}:${s.getMinutes().toString().padStart(2,'0')}`;
    const room = l.room === 0 ? 'Онл.' : ['Л','Ц','П'][l.room - 1] || '';
    const isActive = l.status === 'active';
    const past = e < new Date();
    const statusStr = l.status === 'cancelled' ? '<span class="history-status history-cancelled">Отм.</span>'
      : past ? '<span class="history-status history-completed">✓</span>'
      : '<span class="history-status history-planned">⏳</span>';
    const p = paymentsByLesson[l.id];
    const payStr = !past ? '—' : p?.status === 'approved' ? '<span class="pay-paid">✓</span>' : p?.status === 'pending' ? '<span class="pay-pending">⏳</span>' : '<span class="pay-unpaid">✕</span>';

    html += `<tr><td>${dd}.${mm} ${day}</td><td>${time}</td><td>${dur}</td><td>${room}</td><td>${statusStr}</td><td>${payStr}</td></tr>`;
  });

  html += `</tbody></table></div></div>`;

  // Pending payments
  if (pendingPayments.length > 0) {
    html += `<div class="sd-section"><h4>Заявки на оплату</h4><div class="sd-payments">`;
    pendingPayments.forEach(p => {
      const d = new Date(p.submitted_at);
      const dd = d.getDate().toString().padStart(2,'0');
      const mm = (d.getMonth()+1).toString().padStart(2,'0');
      const methodLabel = p.payment_method === 'cash' ? 'Наличными' : 'Переводом';
      html += `<div class="sd-payment-row">
        <span class="sd-pay-info">${dd}.${mm} · ${p.amount} ₽ · ${methodLabel}</span>
        <div class="sd-pay-actions">
          <button class="btn-sm btn-primary" data-approve="${p.id}">Подтвердить</button>
          <button class="btn-sm btn-danger" data-reject="${p.id}">Отклонить</button>
        </div>
      </div>`;
    });
    html += `</div></div>`;
  }

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

  document.getElementById('student-detail-overlay').classList.add('active');
}

function closeStudentDetail() {
  document.getElementById('student-detail-overlay').classList.remove('active');
  studentDetailId = null;
}

async function saveStudentDetail() {
  if (!studentDetailId) return;
  const typeVal = document.getElementById('sd-type').value;
  const update = {
    subject: document.getElementById('sd-subject').value.trim(),
    grade: parseInt(document.getElementById('sd-grade').value) || null,
    is_individual: typeVal === 'true' || typeVal === 'online',
    is_online: typeVal === 'online',
    price_type: document.getElementById('sd-price-type').value,
    notes: document.getElementById('sd-note').value.trim() || null
  };
  const { error } = await db.from('students').update(update).eq('id', studentDetailId);
  if (error) { showToast('Ошибка: ' + error.message, 'error'); return; }
  showToast('Сохранено', 'success');
  closeStudentDetail();
  renderStudents(document.getElementById('student-search').value);
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
        <span class="link-student-name">${p.full_name || '(без имени)'}</span>
        ${p.phone ? `<span class="link-student-phone">${p.phone}</span>` : ''}
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
    // Load the fake record's subject for matching
    const { data: fakeStudent } = await db.from('students')
      .select('subject')
      .eq('id', fakeStudentId)
      .single();
    const fakeSubject = fakeStudent?.subject || null;

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

      // Transfer all remaining references
      await db.from('lesson_students').update({ student_id: realId }).eq('student_id', fakeStudentId);
      await db.from('recurring_lesson_students').update({ student_id: realId }).eq('student_id', fakeStudentId);
      await db.from('cancellations').update({ student_id: realId }).eq('student_id', fakeStudentId);
      await db.from('payments').update({ student_id: realId }).eq('student_id', fakeStudentId);

      // Delete the fake record
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
  // Denominator addition: outstanding misses (any reason — paid or unpaid)
  // lessons with status='cancelled' are NOT queried separately to avoid double-counting:
  // computeAndSyncCancellations creates a cancellations record for each cancelled lesson.
  const { data: pendingCancellations } = await db.from('cancellations')
    .select('id')
    .eq('student_id', studentId)
    .eq('status', 'pending');
  const completed = (completedLessons || []).length;
  const missed = (pendingCancellations || []).length;
  const total = completed + missed;
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}
