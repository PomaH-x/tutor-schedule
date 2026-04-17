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
    card.addEventListener('click', () => openEditStudent(card.dataset.id));
  });
}

function studentCardHTML(s) {
  return `<div class="student-card" data-id="${s.id}">
    <div class="student-card-main">
      <span class="student-name">${s.first_name} ${s.last_name}</span>
      <span class="student-subject">${s.subject || ''}</span>
    </div>
    <div class="student-card-meta">
      ${s.grade ? `<span>${s.grade} класс</span>` : ''}
    </div>
  </div>`;
}

function openStudentModal(title, student = null) {
  editingStudentId = student ? student.id : null;
  document.getElementById('modal-student-title').textContent = title;
  document.getElementById('student-first-name').value = student?.first_name || '';
  document.getElementById('student-last-name').value = student?.last_name || '';
  populateSubjectSelects();
  populateDurationTierSelect();
  document.getElementById('student-subject').value = student?.subject || (subjectsList[0]?.name || '');
  document.getElementById('student-grade').value = student?.grade || 11;
  if (student?.lesson_duration) {
    document.getElementById('student-duration-tier').value = `${student.lesson_duration}-${student.is_individual || false}`;
  }
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
  const tierVal = document.getElementById('student-duration-tier').value;
  const priceType = document.getElementById('student-price-type').value;
  const notes = document.getElementById('student-notes').value.trim();

  if (!firstName || !lastName) { showToast('Введите имя и фамилию', 'error'); return; }
  if (!tierVal) { showToast('Выберите длительность', 'error'); return; }

  const [durStr, indStr] = tierVal.split('-');
  const duration = parseInt(durStr);
  const isIndividual = indStr === 'true';

  const record = {
    first_name: firstName, last_name: lastName, subject, grade,
    lesson_duration: duration, is_individual: isIndividual, price_type: priceType,
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
}
