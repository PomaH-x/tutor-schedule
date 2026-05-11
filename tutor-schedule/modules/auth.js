const TEACHER_COLORS = [
  '#1e6fe8', '#e05555', '#2ea87a', '#d4813a',
  '#7c5cc4', '#c4a03d', '#3a9ec4', '#c45a8a'
];

const EMAIL_DOMAIN = '@tutor.local';

function loginToEmail(login) {
  // Strip non-digits for phone, fallback to original for legacy logins
  const digits = login.replace(/\D/g, '');
  if (digits.length >= 10) return digits + EMAIL_DOMAIN;
  return login.toLowerCase().trim() + EMAIL_DOMAIN;
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

function generateShortName(name1, name2) {
  return name1[0].toUpperCase() + name2[0].toUpperCase();
}

async function getRandomColor() {
  const { data } = await db
    .from('profiles')
    .select('color')
    .eq('role', 'teacher');
  const used = (data || []).map(p => p.color);
  const available = TEACHER_COLORS.filter(c => !used.includes(c));
  return available.length > 0 ? available[0] : TEACHER_COLORS[Math.floor(Math.random() * TEACHER_COLORS.length)];
}

function showAuthStep(stepId) {
  document.querySelectorAll('.auth-step').forEach(s => s.classList.remove('active'));
  document.getElementById(stepId).classList.add('active');
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  if (typeof clearLessonTooltip === 'function') clearLessonTooltip();
  if (typeof removeCellTooltip === 'function') removeCellTooltip();
  if (typeof clearRecLessonTooltip === 'function') clearRecLessonTooltip();
}

async function loadProfile(userId) {
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

async function updateRegisterForm(role) {
  const name1 = document.getElementById('input-name1');
  const name2 = document.getElementById('input-name2');
  const studentFields = document.getElementById('student-reg-fields');

  if (role === 'student') {
    name1.placeholder = 'Имя';
    name2.placeholder = 'Фамилия';
    studentFields.style.display = 'block';
    await loadTeachersForRegistration();
  } else {
    name1.placeholder = 'Имя';
    name2.placeholder = 'Отчество';
    studentFields.style.display = 'none';
  }
}

async function loadTeachersForRegistration() {
  const list = document.getElementById('reg-teachers-list');
  list.innerHTML = '<div class="reg-teachers-loading">Загрузка преподавателей…</div>';

  // Pull approved teachers + their subjects in two requests
  const { data: teachers, error: tErr } = await db.from('profiles')
    .select('id, full_name, color')
    .in('role', ['teacher', 'admin'])
    .eq('status', 'approved')
    .order('full_name');

  if (tErr) console.error('Load teachers error:', tErr);
  if (!teachers || teachers.length === 0) {
    list.innerHTML = '<div class="reg-teachers-empty">Нет преподавателей</div>';
    return;
  }

  const { data: tsRows, error: sErr } = await db.from('teacher_subjects')
    .select('teacher_id, subject:subjects(id, name)');

  if (sErr) console.error('Load teacher_subjects error:', sErr);

  // Group subjects by teacher
  const subjectsByTeacher = {};
  (tsRows || []).forEach(row => {
    if (!row.subject) return;
    if (!subjectsByTeacher[row.teacher_id]) subjectsByTeacher[row.teacher_id] = [];
    subjectsByTeacher[row.teacher_id].push(row.subject);
  });

  list.innerHTML = teachers.map(t => {
    const subjects = subjectsByTeacher[t.id] || [];
    if (subjects.length === 0) return ''; // hide teachers without subjects — they can't be picked anyway
    const color = t.color || 'var(--accent)';
    const subjectsHTML = subjects
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => `<label class="reg-subject-item">
        <input type="checkbox" data-subject-id="${s.id}" data-subject-name="${s.name}">
        <span>${s.name}</span>
      </label>`).join('');
    return `<div class="reg-teacher-item" data-teacher-id="${t.id}">
      <label class="reg-teacher-head">
        <input type="checkbox" data-teacher-toggle>
        <span class="reg-teacher-color" style="background:${color}"></span>
        <span class="reg-teacher-name">${t.full_name}</span>
        <span class="reg-teacher-arrow">›</span>
      </label>
      <div class="reg-subjects-list" hidden>
        ${subjectsHTML}
      </div>
    </div>`;
  }).join('');

  // Toggle subjects on teacher checkbox
  list.querySelectorAll('[data-teacher-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const item = cb.closest('.reg-teacher-item');
      const subs = item.querySelector('.reg-subjects-list');
      if (cb.checked) {
        subs.hidden = false;
        item.classList.add('expanded');
      } else {
        subs.hidden = true;
        item.classList.remove('expanded');
        // Uncheck all of this teacher's subjects when teacher is deselected
        subs.querySelectorAll('input[type=checkbox]').forEach(b => { b.checked = false; });
      }
    });
  });
}

// Collect selected (teacher_id, subject_id) pairs from the registration form
function collectSelectedTeacherSubjects() {
  const pairs = [];
  document.querySelectorAll('#reg-teachers-list .reg-teacher-item').forEach(item => {
    const teacherCb = item.querySelector('[data-teacher-toggle]');
    if (!teacherCb || !teacherCb.checked) return;
    const teacherId = item.dataset.teacherId;
    const subjects = item.querySelectorAll('.reg-subjects-list input[type=checkbox]:checked');
    subjects.forEach(s => {
      pairs.push({ teacher_id: teacherId, subject_id: s.dataset.subjectId, subject_name: s.dataset.subjectName });
    });
  });
  return pairs;
}

async function handleLogin() {
  const login = document.getElementById('input-login').value.trim();
  const password = document.getElementById('input-password').value;

  if (!login || !password) {
    showToast('Заполните все поля', 'error');
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;

  const { data, error } = await db.auth.signInWithPassword({
    email: loginToEmail(login),
    password: password
  });

  btn.disabled = false;

  if (error) {
    showToast('Неверный логин или пароль', 'error');
    return;
  }

  await onAuthSuccess(data.user);
}

async function handleRegister() {
  const name1 = document.getElementById('input-name1').value.trim();
  const name2 = document.getElementById('input-name2').value.trim();
  const login = document.getElementById('input-reg-login').value.trim();
  const password = document.getElementById('input-reg-password').value;

  if (!name1 || !name2 || !login || !password) {
    showToast('Заполните все поля', 'error');
    return;
  }

  const role = state.selectedRole;
  const phone = normalizePhone(login);

  if (phone.length < 10) {
    showToast('Введите корректный телефон', 'error');
    return;
  }

  if (password.length < 6) {
    showToast('Пароль минимум 6 символов', 'error');
    return;
  }

  let requestedGrade = null;
  let selectedPairs = [];

  if (role === 'student') {
    requestedGrade = document.getElementById('reg-grade').value;
    selectedPairs = collectSelectedTeacherSubjects();

    if (!requestedGrade) {
      showToast('Укажите класс', 'error');
      return;
    }
    if (selectedPairs.length === 0) {
      showToast('Выберите хотя бы одного преподавателя и предмет', 'error');
      return;
    }
  }

  const btn = document.getElementById('btn-register');
  btn.disabled = true;

  const email = loginToEmail(login);
  const { data, error } = await db.auth.signUp({ email, password });

  if (error) {
    btn.disabled = false;
    if (error.message.includes('already registered')) {
      showToast('Этот телефон уже зарегистрирован', 'error');
    } else {
      showToast(error.message, 'error');
    }
    return;
  }

  const fullName = name1 + ' ' + name2;
  const shortName = (role === 'teacher' || role === 'admin') ? generateShortName(name1, name2) : null;
  const color = (role === 'teacher' || role === 'admin') ? await getRandomColor() : null;

  const profileData = {
    id: data.user.id,
    role: role,
    status: role === 'admin' ? 'approved' : 'pending',
    full_name: fullName,
    short_name: shortName,
    color: color,
    phone: phone
  };

  if (role === 'student') {
    // Keep requested_grade for backward compat with admin UI / older queries
    profileData.requested_grade = +requestedGrade;
  }

  const { error: profileError } = await db
    .from('profiles')
    .insert(profileData);

  if (profileError) {
    btn.disabled = false;
    showToast('Ошибка создания профиля', 'error');
    return;
  }

  // Save (teacher, subject) pairs as join requests
  if (role === 'student' && selectedPairs.length > 0) {
    const rows = selectedPairs.map(p => ({
      profile_id: data.user.id,
      teacher_id: p.teacher_id,
      subject_id: p.subject_id,
      grade: +requestedGrade
    }));
    const { error: sjrErr } = await db.from('student_join_requests').insert(rows);
    if (sjrErr) {
      console.error('student_join_requests insert error:', sjrErr);
      btn.disabled = false;
      showToast('Ошибка сохранения заявки', 'error');
      return;
    }
  }

  btn.disabled = false;
  await onAuthSuccess(data.user);
}

async function onAuthSuccess(user) {
  state.user = user;
  const profile = await loadProfile(user.id);
  state.profile = profile;

  if (!profile) {
    showToast('Профиль не найден', 'error');
    return;
  }

  if (profile.status === 'pending') {
    showAuthStep('auth-step-pending');
    return;
  }

  if (profile.status === 'rejected') {
    showToast('Заявка отклонена', 'error');
    await db.auth.signOut();
    return;
  }

  if (profile.role === 'student') {
    showStudentScreen();
    return;
  }

  showScreen('screen-schedule');
  initSchedule();
  loadPendingCount();
  loadSubjects();
  loadPricing();
  computeAndSyncCancellations();
  syncRecurringToWeeks();
}

async function handleLogout() {
  await db.auth.signOut();
  state.user = null;
  state.profile = null;
  showScreen('screen-auth');
  showAuthStep('auth-step-role');
}

function initPasswordToggles() {
  document.querySelectorAll('.btn-eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.classList.toggle('active', isPassword);
    });
  });
}

function initAuth() {
  document.querySelectorAll('.role-card').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedRole = card.dataset.role;
      showAuthStep('auth-step-login');
    });
  });

  document.getElementById('btn-back-to-role').addEventListener('click', () => {
    showAuthStep('auth-step-role');
  });

  document.getElementById('btn-show-register').addEventListener('click', () => {
    updateRegisterForm(state.selectedRole);
    showAuthStep('auth-step-register');
  });

  document.getElementById('btn-back-to-login').addEventListener('click', () => {
    showAuthStep('auth-step-login');
  });

  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-register').addEventListener('click', handleRegister);
  document.getElementById('btn-logout-pending').addEventListener('click', handleLogout);

  initPasswordToggles();

  document.querySelectorAll('.auth-form input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const form = input.closest('.auth-form');
        const btn = form.querySelector('.btn-primary');
        btn.click();
      }
    });
  });
}
