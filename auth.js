const TEACHER_COLORS = [
  '#6c5ce7', '#e74c5c', '#00b894', '#e17055',
  '#0984e3', '#fdcb6e', '#a29bfe', '#55a6e8'
];

function generateShortName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return parts[0][0].toUpperCase() + '.' + parts[1][0].toUpperCase() + '.';
  }
  return parts[0].substring(0, 2).toUpperCase();
}

async function getRandomColor() {
  const { data } = await supabase
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
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

async function handleLogin() {
  const email = document.getElementById('input-email').value.trim();
  const password = document.getElementById('input-password').value;

  if (!email || !password) {
    showToast('Заполните все поля', 'error');
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  btn.disabled = false;

  if (error) {
    showToast('Неверный email или пароль', 'error');
    return;
  }

  await onAuthSuccess(data.user);
}

async function handleRegister() {
  const fullName = document.getElementById('input-fullname').value.trim();
  const email = document.getElementById('input-reg-email').value.trim();
  const password = document.getElementById('input-reg-password').value;
  const password2 = document.getElementById('input-reg-password2').value;

  if (!fullName || !email || !password || !password2) {
    showToast('Заполните все поля', 'error');
    return;
  }

  if (password !== password2) {
    showToast('Пароли не совпадают', 'error');
    return;
  }

  if (password.length < 6) {
    showToast('Пароль минимум 6 символов', 'error');
    return;
  }

  const btn = document.getElementById('btn-register');
  btn.disabled = true;

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    btn.disabled = false;
    showToast(error.message, 'error');
    return;
  }

  const role = state.selectedRole;
  const shortName = (role === 'teacher' || role === 'admin') ? generateShortName(fullName) : null;
  const color = role === 'teacher' ? await getRandomColor() : null;

  const { error: profileError } = await supabase
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
    await supabase.auth.signOut();
    return;
  }

  showScreen('screen-schedule');
  initSchedule();
}

async function handleLogout() {
  await supabase.auth.signOut();
  state.user = null;
  state.profile = null;
  showScreen('screen-auth');
  showAuthStep('auth-step-role');
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
    showAuthStep('auth-step-register');
  });

  document.getElementById('btn-back-to-login').addEventListener('click', () => {
    showAuthStep('auth-step-login');
  });

  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-register').addEventListener('click', handleRegister);
  document.getElementById('btn-logout-pending').addEventListener('click', handleLogout);

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
