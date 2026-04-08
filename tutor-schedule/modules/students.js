let editingStudentId = null;

async function loadStudents() {
  const isAdmin = state.profile.role === 'admin';
  let query = db.from('students').select('*, teacher:profiles!teacher_id(full_name, short_name)');

  if (!isAdmin) {
    query = query.eq('teacher_id', state.user.id);
  }

  query = query.order('first_name');
  const { data, error } = await query;

  if (error) {
    showToast('Ошибка загрузки учеников', 'error');
    return;
  }

  state.students = data || [];
  renderStudents();
}

function renderStudents(filter = '') {
  const list = document.getElementById('students-list');
  const isAdmin = state.profile.role === 'admin';
  const search = filter.toLowerCase();

  let filtered = state.students;
  if (search) {
    filtered = filtered.filter(s =>
      s.first_name.toLowerCase().includes(search) ||
      s.last_name.toLowerCase().includes(search)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="students-empty">Нет учеников</div>';
    return;
  }

  if (isAdmin) {
    const grouped = {};
    filtered.forEach(s => {
      const tName = s.teacher?.full_name || 'Без преподавателя';
      if (!grouped[tName]) grouped[tName] = [];
      grouped[tName].push(s);
    });

    list.innerHTML = Object.entries(grouped).map(([teacher, students]) =>
      `<div class="students-group">
        <div class="students-group-title">${teacher}</div>
        ${students.map(s => studentCardHTML(s)).join('')}
      </div>`
    ).join('');
  } else {
    list.innerHTML = filtered.map(s => studentCardHTML(s)).join('');
  }

  list.querySelectorAll('.student-card').forEach(card => {
    card.addEventListener('click', () => openEditStudent(card.dataset.id));
  });
}

function studentCardHTML(s) {
  const subjectLabel = s.subject === 'math' ? 'Математика' : 'Информатика';
  return `<div class="student-card" data-id="${s.id}">
    <div class="student-card-main">
      <span class="student-name">${s.first_name} ${s.last_name}</span>
      <span class="student-subject">${subjectLabel}</span>
    </div>
    <div class="student-card-meta">
      <span>${s.lessons_per_week}×/нед</span>
      <span>${s.lesson_duration} мин</span>
    </div>
  </div>`;
}

function openStudentModal(title, student = null) {
  editingStudentId = student ? student.id : null;
  document.getElementById('modal-student-title').textContent = title;
  document.getElementById('student-first-name').value = student?.first_name || '';
  document.getElementById('student-last-name').value = student?.last_name || '';
  document.getElementById('student-subject').value = student?.subject || 'math';
  document.getElementById('student-lessons-per-week').value = student?.lessons_per_week || 2;
  document.getElementById('student-duration').value = student?.lesson_duration || 90;
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
  const lessonsPerWeek = parseInt(document.getElementById('student-lessons-per-week').value);
  const duration = parseInt(document.getElementById('student-duration').value);
  const notes = document.getElementById('student-notes').value.trim();

  if (!firstName || !lastName) {
    showToast('Введите имя и фамилию', 'error');
    return;
  }

  const record = {
    first_name: firstName,
    last_name: lastName,
    subject: subject,
    lessons_per_week: lessonsPerWeek,
    lesson_duration: duration,
    notes: notes || null,
    teacher_id: state.user.id
  };

  let error;

  if (editingStudentId) {
    ({ error } = await db.from('students').update(record).eq('id', editingStudentId));
  } else {
    ({ error } = await db.from('students').insert(record));
  }

  if (error) {
    showToast('Ошибка сохранения', 'error');
    return;
  }

  const isEdit = !!editingStudentId;
  closeStudentModal();
  showToast(isEdit ? 'Ученик отредактирован' : 'Ученик добавлен', 'success');
  await loadStudents();
}

let confirmCallback = null;

function showConfirm(text, callback) {
  document.getElementById('confirm-text').textContent = text;
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
    if (error) {
      showToast('Ошибка удаления', 'error');
      return;
    }
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

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeStudentModal();
  });

  document.getElementById('confirm-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirm();
  });
}
