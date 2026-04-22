const ALL_COLORS = [
  '#1e6fe8', '#e05555', '#2ea87a', '#d4813a',
  '#7c5cc4', '#c4a03d', '#3a9ec4', '#c45a8a',
  '#2bbcc4', '#8a6db0', '#5a94b8', '#b87858',
  '#5ab88a', '#b89860', '#6a8fc4', '#c47070'
];

let pendingUsers = [];
let teachersList = [];
let colorEditTeacherId = null;

async function loadPendingCount() {
  if (state.profile?.role !== 'admin') return;
  const { data, count } = await db
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  const badge = document.getElementById('badge-pending');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

async function loadPendingUsers() {
  const { data } = await db
    .from('profiles')
    .select('*')
    .eq('status', 'pending')
    .order('created_at');
  pendingUsers = data || [];
  renderPendingUsers();
}

function renderPendingUsers() {
  const list = document.getElementById('pending-list');
  if (pendingUsers.length === 0) {
    list.innerHTML = '<div class="admin-empty">Нет новых заявок</div>';
    return;
  }

  const roleLabel = { teacher: 'Преподаватель', student: 'Ученик', admin: 'Админ' };

  list.innerHTML = pendingUsers.map(u => `
    <div class="pending-card" data-id="${u.id}">
      <div class="pending-info">
        <span class="pending-name">${u.full_name}</span>
        <span class="pending-role">${roleLabel[u.role] || u.role}</span>
      </div>
      <div class="pending-actions">
        <button class="btn-approve" data-id="${u.id}" title="Одобрить">✓</button>
        <button class="btn-reject" data-id="${u.id}" title="Отклонить">✕</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-approve').forEach(btn => {
    btn.addEventListener('click', () => approveUser(btn.dataset.id));
  });

  list.querySelectorAll('.btn-reject').forEach(btn => {
    btn.addEventListener('click', () => rejectUser(btn.dataset.id));
  });
}

async function approveUser(userId) {
  const { error } = await db.from('profiles').update({ status: 'approved' }).eq('id', userId);
  if (error) { showToast('Ошибка', 'error'); return; }
  showToast('Пользователь одобрен', 'success');
  await loadPendingUsers();
  await loadPendingCount();
}

async function rejectUser(userId) {
  const user = pendingUsers.find(u => u.id === userId);
  const name = user ? user.full_name : '';
  showConfirm(`Отклонить заявку ${name}?`, async () => {
    const { error } = await db.from('profiles').update({ status: 'rejected' }).eq('id', userId);
    if (error) { showToast('Ошибка', 'error'); return; }
    showToast('Заявка отклонена', 'success');
    await loadPendingUsers();
    await loadPendingCount();
  }, 'Отклонить');
}

async function loadTeachers() {
  const { data } = await db
    .from('profiles')
    .select('*')
    .in('role', ['teacher', 'admin'])
    .eq('status', 'approved')
    .order('full_name');
  teachersList = data || [];
  renderTeachers();
}

function renderTeachers() {
  const list = document.getElementById('teachers-list');
  if (teachersList.length === 0) {
    list.innerHTML = '<div class="admin-empty">Нет преподавателей</div>';
    return;
  }

  const roleLabel = { teacher: 'Преподаватель', admin: 'Админ' };

  list.innerHTML = teachersList.map(t => `
    <div class="teacher-card" data-id="${t.id}">
      <div class="teacher-color" style="background:${t.color || '#1e6fe8'}" data-id="${t.id}" title="Сменить цвет">
        <span class="teacher-color-edit">✎</span>
      </div>
      <div class="teacher-info">
        <span class="teacher-name">${t.full_name}</span>
        <span class="teacher-role">${roleLabel[t.role] || t.role} · ${t.short_name || ''}</span>
      </div>
      <div class="teacher-group-size" title="Макс. учеников в группе">
        <label>Макс:</label>
        <input type="number" class="input-group-size" data-id="${t.id}" value="${t.max_group_size || 4}" min="1" max="20">
      </div>
      ${t.id !== state.user.id ? `<button class="btn-delete-teacher" data-id="${t.id}" data-name="${t.full_name}" title="Удалить">×</button>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.teacher-color').forEach(el => {
    el.addEventListener('click', () => openColorPicker(el.dataset.id));
  });

  list.querySelectorAll('.input-group-size').forEach(inp => {
    inp.addEventListener('change', async () => {
      const val = Math.max(1, Math.min(20, parseInt(inp.value) || 4));
      inp.value = val;
      await db.from('profiles').update({ max_group_size: val }).eq('id', inp.dataset.id);
      const t = teachersList.find(x => x.id === inp.dataset.id);
      if (t) t.max_group_size = val;
      if (inp.dataset.id === state.user.id) state.profile.max_group_size = val;
      showToast('Размер группы обновлён', 'success');
    });
  });

  list.querySelectorAll('.btn-delete-teacher').forEach(btn => {
    btn.addEventListener('click', () => deleteTeacher(btn.dataset.id, btn.dataset.name));
  });
}

function openColorPicker(teacherId) {
  colorEditTeacherId = teacherId;
  const grid = document.getElementById('color-grid');
  const current = teachersList.find(t => t.id === teacherId)?.color;

  grid.innerHTML = ALL_COLORS.map(c => `
    <div class="color-swatch${c === current ? ' active' : ''}" data-color="${c}" style="background:${c}"></div>
  `).join('');

  grid.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => selectColor(sw.dataset.color));
  });

  document.getElementById('color-overlay').classList.add('active');
}

function closeColorPicker() {
  document.getElementById('color-overlay').classList.remove('active');
  colorEditTeacherId = null;
}

async function selectColor(color) {
  if (!colorEditTeacherId) return;
  const { error } = await db.from('profiles').update({ color }).eq('id', colorEditTeacherId);
  if (error) { showToast('Ошибка', 'error'); return; }
  if (colorEditTeacherId === state.user.id) {
    state.profile.color = color;
  }
  closeColorPicker();
  showToast('Цвет обновлён', 'success');
  await loadTeachers();
}

function deleteTeacher(teacherId, name) {
  showConfirm(`Удалить ${name}? Все занятия и ученики будут удалены.`, async () => {
    await db.from('lesson_students').delete().in('lesson_id',
      (await db.from('lessons').select('id').eq('teacher_id', teacherId)).data?.map(l => l.id) || []
    );
    await db.from('lessons').delete().eq('teacher_id', teacherId);
    await db.from('students').delete().eq('teacher_id', teacherId);
    await db.from('profiles').delete().eq('id', teacherId);
    showToast('Преподаватель удалён', 'success');
    await loadTeachers();
  });
}

function initProfileTabs() {
  document.querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.profile-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');

      if (tab.dataset.tab === 'tab-admin') {
        loadPendingUsers();
        loadTeachers();
        loadSubjectsAdmin();
        loadPricingAdmin();
      }
      if (tab.dataset.tab === 'tab-payroll') {
        loadPayroll();
      }
    });
  });

  document.getElementById('btn-close-color').addEventListener('click', closeColorPicker);
  document.getElementById('color-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeColorPicker();
  });

  document.getElementById('btn-add-subject').addEventListener('click', addSubject);
  document.getElementById('new-subject-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSubject();
  });
}

async function loadSubjectsAdmin() {
  const { data } = await db.from('subjects').select('*').order('name');
  renderSubjectsAdmin(data || []);
}

function renderSubjectsAdmin(subjects) {
  const list = document.getElementById('subjects-list');
  if (subjects.length === 0) {
    list.innerHTML = '<div class="admin-empty">Нет предметов</div>';
    return;
  }
  list.innerHTML = subjects.map(s =>
    `<div class="subject-card">
      <span class="subject-name">${s.name}</span>
      <button class="btn-delete-subject" data-id="${s.id}" data-name="${s.name}">×</button>
    </div>`
  ).join('');

  list.querySelectorAll('.btn-delete-subject').forEach(btn => {
    btn.addEventListener('click', () => {
      showConfirm(`Удалить предмет "${btn.dataset.name}"?`, async () => {
        await db.from('subjects').delete().eq('id', btn.dataset.id);
        showToast('Предмет удалён', 'success');
        await loadSubjectsAdmin();
        await loadSubjects();
      });
    });
  });
}

async function addSubject() {
  const input = document.getElementById('new-subject-name');
  const name = input.value.trim();
  if (!name) { showToast('Введите название предмета', 'error'); return; }
  const { error } = await db.from('subjects').insert({ name });
  if (error) {
    if (error.message.includes('unique')) showToast('Предмет уже существует', 'error');
    else showToast('Ошибка', 'error');
    return;
  }
  input.value = '';
  showToast('Предмет добавлен', 'success');
  await loadSubjectsAdmin();
  await loadSubjects();
}

async function loadAdminCancellationStats() {
  const container = document.getElementById('admin-cancellations-stats');
  if (!container) return;
  const currentWs = formatDate(getMonday(new Date()));

  const { data: cancellations } = await db.from('cancellations')
    .select('id, student_id, teacher_id, student:students(first_name, last_name), teacher:profiles!teacher_id(full_name, color)')
    .eq('status', 'pending').eq('week_start', currentWs);

  if (!cancellations || cancellations.length === 0) {
    container.innerHTML = '<div class="admin-empty">Нет отмен на этой неделе</div>';
    return;
  }

  const byTeacher = {};
  cancellations.forEach(c => {
    const tid = c.teacher_id;
    if (!byTeacher[tid]) byTeacher[tid] = { name: c.teacher?.full_name || '', color: c.teacher?.color || '#1e6fe8', students: [] };
    if (c.student) byTeacher[tid].students.push(`${c.student.first_name} ${c.student.last_name}`);
  });

  let html = `<div class="cancel-stat-total">Всего отмен: <b>${cancellations.length}</b></div>`;
  Object.values(byTeacher).forEach(t => {
    html += `<div class="cancel-stat-teacher"><span class="teacher-color-dot" style="background:${t.color}"></span><span class="cancel-stat-name">${t.name}</span><span class="cancel-stat-count">${t.students.length} отм.</span></div>`;
    t.students.forEach(s => { html += `<div class="cancel-stat-student">${s}</div>`; });
  });
  container.innerHTML = html;
}

function initAdmin() {
  initProfileTabs();
}
