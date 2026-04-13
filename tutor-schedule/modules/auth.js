const TEACHER_COLORS = [
  '#7c6dd8', '#d4637a', '#3da88c', '#c97a5a',
  '#4a90c4', '#c4a84d', '#8b82c8', '#5a94b8'
];

const EMAIL_DOMAIN = '@tutor.local';

function loginToEmail(login) {
  return login.toLowerCase().trim() + EMAIL_DOMAIN;
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

function updateRegisterForm(role) {
  const name1 = document.getElementById('input-name1');
  const name2 = document.getElementById('input-name2');

  if (role === 'student') {
    name1.placeholder = 'Имя';
    name2.placeholder = 'Фамилия';
  } else {
    name1.placeholder = 'Имя';
    name2.placeholder = 'Отчество';
  }
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

  if (login.length < 3) {
    showToast('Логин минимум 3 символа', 'error');
    return;
  }

  if (password.length < 6) {
    showToast('Пароль минимум 6 символов', 'error');
    return;
  }

  const btn = document.getElementById('btn-register');
  btn.disabled = true;

  const role = state.selectedRole;
  const email = loginToEmail(login);

  const { data, error } = await db.auth.signUp({ email, password });

  if (error) {
    btn.disabled = false;
    if (error.message.includes('already registered')) {
      showToast('Этот логин уже занят', 'error');
    } else {
      showToast(error.message, 'error');
    }
    return;
  }

  const fullName = name1 + ' ' + name2;
  const shortName = (role === 'teacher' || role === 'admin') ? generateShortName(name1, name2) : null;
  const color = (role === 'teacher' || role === 'admin') ? await getRandomColor() : null;

  const { error: profileError } = await db
    .from('profiles')
    .insert({
      id: data.user.id,
      role: role,
      status: role === 'admin' ? 'approved' : 'pending',
      full_name: fullName,
      short_name: shortName,
      color: color
    });

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

  showScreen('screen-schedule');
  initSchedule();
  loadPendingCount();
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
