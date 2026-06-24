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

// ===== INPUT VALIDATION =====

// Russian or latin letters, hyphens and spaces. Must start and end with a letter.
// Length 2..50. Allows compound names like "Анна-Мария" or "Van Der Berg".
const NAME_RE = /^[А-Яа-яЁёA-Za-z](?:[А-Яа-яЁёA-Za-z\- ]{0,48}[А-Яа-яЁёA-Za-z])?$/;

function validateName(value, fieldLabel) {
  if (!value) return `Укажите: ${fieldLabel}`;
  if (value.length < 2) return `${fieldLabel}: минимум 2 символа`;
  if (value.length > 50) return `${fieldLabel}: максимум 50 символов`;
  if (!NAME_RE.test(value)) return `${fieldLabel}: только буквы, дефис и пробел`;
  return null;
}

// digits-only string from normalizePhone(). Accepts Russian formats:
//   11 digits starting with 7 or 8  → mobile/landline with country code
//   10 digits starting with 9       → mobile without country code
function validatePhone(digits) {
  if (!digits) return 'Укажите телефон';
  if (digits.length === 11) {
    if (digits[0] !== '7' && digits[0] !== '8') {
      return 'Телефон должен начинаться с +7 или 8';
    }
    return null;
  }
  if (digits.length === 10) {
    if (digits[0] !== '9') return 'Введите телефон в формате +7 9XX XXX XX XX';
    return null;
  }
  return 'Телефон должен содержать 10 или 11 цифр';
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

// Keys we DON'T persist — those are boot/auth-flow screens, not navigation targets
const _NON_PERSISTED_SCREENS = new Set(['screen-loading', 'screen-auth']);

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  if (typeof clearLessonTooltip === 'function') clearLessonTooltip();
  if (typeof removeCellTooltip === 'function') removeCellTooltip();
  if (typeof clearRecLessonTooltip === 'function') clearRecLessonTooltip();
  // Remember the last navigated-to screen so we can restore it after a page
  // reload (UI-state persistence). Boot/auth screens are excluded — when the
  // user is logged out they'll see auth regardless, and the loading splash is
  // transient. Stored under 'lastScreen' in localStorage.
  if (!_NON_PERSISTED_SCREENS.has(screenId)) {
    try { localStorage.setItem('lastScreen', screenId); } catch (_) { /* private mode */ }
  }
}

// Screens each role is allowed to land on after a reload. If the persisted
// screen isn't in this list for the current user, we silently fall back to the
// role's default. Prevents e.g. an old admin session restoring to screen-admin
// after a role downgrade.
const _SCREEN_ALLOWLIST = {
  admin:   ['screen-schedule', 'screen-recurring', 'screen-online', 'screen-profile'],
  teacher: ['screen-schedule', 'screen-recurring', 'screen-online', 'screen-profile'],
  student: ['screen-student', 'screen-student-history', 'screen-profile']
};

// Called from onAuthSuccess AFTER the default screen + inits have run.
// If a valid persisted screen exists, navigate there by dispatching a click on
// the corresponding nav button. We deliberately go through real click handlers
// (instead of calling functions directly) so we don't have to duplicate any
// load/render logic — the same code path that handles a normal user click is
// re-used here.
function restoreLastScreen() {
  let target;
  try { target = localStorage.getItem('lastScreen'); } catch (_) { return; }
  if (!target) return;

  const role = state.profile?.role;
  const allowed = _SCREEN_ALLOWLIST[role] || [];
  if (!allowed.includes(target)) return;

  // Default screen for the role — if target IS the default, nothing to do
  const defaultScreen = role === 'student' ? 'screen-student' : 'screen-schedule';
  if (target === defaultScreen) return;

  // Map target → the nav button that opens it. Using the actual button click
  // re-uses the existing setup path (which loads data, renders grid, etc.).
  const navMap = {
    'screen-recurring':       'btn-to-recurring',
    'screen-online':          'btn-to-online',
    'screen-profile':         role === 'student' ? 'btn-profile-student' : 'btn-profile',
    'screen-student-history': 'btn-student-history'
  };
  const btnId = navMap[target];
  if (btnId) {
    const btn = document.getElementById(btnId);
    if (btn) { btn.click(); return; }
  }
  // Fallback for screens without a single button click that fully sets them up
  // (e.g. profile for student): just open the screen directly.
  try { showScreen(target); } catch (_) { /* unknown screen — stay on default */ }
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
        <input type="checkbox" data-subject-id="${s.id}" data-subject-name="${escapeHtml(s.name)}">
        <span>${escapeHtml(s.name)}</span>
      </label>`).join('');
    return `<div class="reg-teacher-item" data-teacher-id="${t.id}">
      <label class="reg-teacher-head">
        <input type="checkbox" data-teacher-toggle>
        <span class="reg-teacher-color" style="background:${escapeHtml(color)}"></span>
        <span class="reg-teacher-name">${escapeHtml(t.full_name)}</span>
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

  const role = state.selectedRole;
  // Student form is "Имя + Фамилия"; teacher/admin form is "Имя + Отчество".
  // Use the right label for the second field so toast tells exactly which one is wrong.
  const name2Label = role === 'student' ? 'Фамилия' : 'Отчество';

  const name1Err = validateName(name1, 'Имя');
  if (name1Err) { showToast(name1Err, 'error'); return; }
  const name2Err = validateName(name2, name2Label);
  if (name2Err) { showToast(name2Err, 'error'); return; }

  const phone = normalizePhone(login);
  const phoneErr = validatePhone(phone);
  if (phoneErr) { showToast(phoneErr, 'error'); return; }

  if (!password) {
    showToast('Укажите пароль', 'error');
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
    status: 'pending',
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
    await showStudentScreen();
    restoreLastScreen();
    return;
  }

  showScreen('screen-schedule');
  initSchedule();
  loadPendingCount();
  loadSubjects();
  loadPricing();
  computeAndSyncCancellations();
  syncRecurringToWeeks();
  if (typeof initRealtime === 'function') initRealtime();
  // After the default screen + inits are running, restore the user's last
  // navigated screen if one was persisted (UI-state persistence — survives
  // page reloads). No-op if nothing was saved or the saved screen isn't
  // valid for this user's role.
  restoreLastScreen();
}

async function handleLogout() {
  await db.auth.signOut();
  state.user = null;
  state.profile = null;
  // Forget the persisted screen so the next user (or the same user re-logging
  // in) doesn't get restored to the previous session's view.
  try { localStorage.removeItem('lastScreen'); } catch (_) {}
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
