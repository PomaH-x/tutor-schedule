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
  const sel = document.getElementById('reg-teacher-id');
  const subjSel = document.getElementById('reg-subject');
  sel.innerHTML = '<option value="">Выберите преподавателя</option>';
  subjSel.innerHTML = '<option value="">Сначала выберите преподавателя</option>';

  const { data, error } = await db.from('profiles')
    .select('id, full_name')
    .in('role', ['teacher', 'admin'])
    .eq('status', 'approved')
    .order('full_name');

  if (error) console.error('Load teachers error:', error);

  if (!data || data.length === 0) {
    sel.innerHTML = '<option value="">Нет преподавателей</option>';
    return;
  }

  (data || []).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.full_name;
    sel.appendChild(opt);
  });

  sel.onchange = async () => {
    const tid = sel.value;
    subjSel.innerHTML = '<option value="">Загрузка...</option>';
    if (!tid) { subjSel.innerHTML = '<option value="">Сначала выберите преподавателя</option>'; return; }

    const { data: ts } = await db.from('teacher_subjects')
      .select('subject:subjects(id, name)')
      .eq('teacher_id', tid);

    if (!ts || ts.length === 0) {
      subjSel.innerHTML = '<option value="">У преподавателя нет предметов</option>';
      return;
    }

    subjSel.innerHTML = '<option value="">Выберите предмет</option>';
    ts.forEach(row => {
      if (!row.subject) return;
      const opt = document.createElement('option');
      opt.value = row.subject.name;
      opt.textContent = row.subject.name;
      subjSel.appendChild(opt);
    });
  };
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

  let requestedTeacherId = null;
  let requestedSubject = null;
  let requestedGrade = null;

  if (role === 'student') {
    requestedTeacherId = document.getElementById('reg-teacher-id').value;
    requestedSubject = document.getElementById('reg-subject').value;
    requestedGrade = document.getElementById('reg-grade').value;

    if (!requestedTeacherId || !requestedSubject || !requestedGrade) {
      showToast('Заполните все поля', 'error');
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
    profileData.requested_teacher_id = requestedTeacherId;
    profileData.requested_subject = requestedSubject;
    profileData.requested_grade = +requestedGrade;
  }

  const { error: profileError } = await db
    .from('profiles')
    .insert(profileData);

  btn.disabled = false;

  if (profileError) {
    showToast('Ошибка создания профиля', 'error');
    return;
  }

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
