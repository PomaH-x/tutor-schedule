document.addEventListener('DOMContentLoaded', async () => {
  // Detect iOS Safari (iPhone / iPad / iPod, including iPad on iOS 13+ which
  // reports as MacIntel + touch). Used to scope safe-area paddings ONLY to
  // iOS — other phones don't have the notch / rounded-corner issues and
  // shouldn't get unnecessary side margins.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) document.documentElement.classList.add('is-ios');

  // Warm up Supabase connection before user interaction
  db.from('profiles').select('id').limit(1).then(() => {}).catch(() => {});

  initAuth();
  initStudents();
  initAdmin();
  initTheme();
  initRecurring();
  initCancellations();
  initPricingAndPayroll();
  initOnline();
  initStudent();
  initSubscriptions();

  document.getElementById('btn-save-telegram')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-telegram');
    const tg = document.getElementById('profile-telegram-input').value.trim().replace(/^@/, '');

    // ===== Validation =====
    // Empty is valid (clearing the telegram). Otherwise must look like a Telegram username.
    if (tg) {
      if (tg.length < 5) { showToast('Telegram: минимум 5 символов', 'error'); return; }
      if (tg.length > 32) { showToast('Telegram: максимум 32 символа', 'error'); return; }
      if (!/^[A-Za-z0-9_]+$/.test(tg)) { showToast('Telegram: только латиница, цифры и _', 'error'); return; }
      if (!/^[A-Za-z]/.test(tg)) { showToast('Telegram должен начинаться с буквы', 'error'); return; }
      if (tg.endsWith('_')) { showToast('Telegram не может заканчиваться на _', 'error'); return; }
      if (/__/.test(tg)) { showToast('Telegram: нельзя несколько _ подряд', 'error'); return; }
    }

    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const { error } = await db.from('profiles').update({ telegram: tg || null }).eq('id', state.user.id);
      if (error) { showToast('Ошибка', 'error'); return; }
      state.profile.telegram = tg || null;
      showToast('Telegram сохранён', 'success');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-profile').addEventListener('click', () => {
    openProfileScreen();
  });

  document.getElementById('btn-back-to-schedule').addEventListener('click', () => {
    if (state.profile?.role === 'student') showScreen('screen-student');
    else showScreen('screen-schedule');
  });

  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  const { data: { session } } = await db.auth.getSession();

  if (session?.user) {
    // onAuthSuccess will navigate to the appropriate screen (schedule / student)
    await onAuthSuccess(session.user);
  } else {
    // No session — show the auth form
    showScreen('screen-auth');
  }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      state.user = null;
      state.profile = null;
      showScreen('screen-auth');
      showAuthStep('auth-step-role');
    }
  });
});

function openProfileScreen() {
  const p = state.profile;
  if (!p) return;

  const avatar = document.getElementById('profile-avatar');
  avatar.textContent = p.short_name || p.full_name[0];
  avatar.style.background = p.color || 'var(--accent)';

  document.getElementById('profile-name').textContent = p.full_name;

  const roles = { admin: 'Администратор', teacher: 'Преподаватель', student: 'Ученик' };
  document.getElementById('profile-role').textContent = roles[p.role];

  const tgWrap = document.getElementById('profile-telegram-wrap');
  if (p.role === 'teacher' || p.role === 'admin') {
    tgWrap.style.display = 'flex';
    document.getElementById('profile-telegram-input').value = p.telegram || '';
  } else {
    tgWrap.style.display = 'none';
  }

  const tabs = document.getElementById('profile-tabs');
  const adminTab = document.querySelector('[data-tab="tab-admin"]');
  if (p.role === 'admin') {
    tabs.style.display = 'flex';
    if (adminTab) adminTab.style.display = 'block';
  } else if (p.role === 'teacher') {
    tabs.style.display = 'flex';
    if (adminTab) adminTab.style.display = 'none';
  } else {
    tabs.style.display = 'none';
  }

  // Hide all teacher/admin-specific tab content for students
  const tabStudents = document.getElementById('tab-students');
  const tabPayroll = document.getElementById('tab-payroll');
  const tabAdmin = document.getElementById('tab-admin');
  if (p.role === 'student') {
    if (tabStudents) tabStudents.style.display = 'none';
    if (tabPayroll) tabPayroll.style.display = 'none';
    if (tabAdmin) tabAdmin.style.display = 'none';
  } else {
    if (tabStudents) tabStudents.style.display = '';
    if (tabPayroll) tabPayroll.style.display = '';
  }

  document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.profile-tab-content').forEach(c => c.classList.remove('active'));
  if (p.role !== 'student') {
    document.querySelector('[data-tab="tab-students"]').classList.add('active');
    document.getElementById('tab-students').classList.add('active');
  }

  showScreen('screen-profile');
  loadStudents();
  loadPendingCount();
  loadTruants();
}

function initTheme() {
  const sw = document.getElementById('theme-switch');
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  sw.checked = current === 'dark';

  const syncAll = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    document.querySelectorAll('#theme-switch, .theme-switch-sync').forEach(s => s.checked = theme === 'dark');
    if (state.lessons && state.lessons.length > 0) renderLessons();
    if (typeof renderRecurringLessons === 'function' && recurringLessons.length > 0) renderRecurringLessons();
  };

  sw.addEventListener('change', () => syncAll(sw.checked ? 'dark' : 'light'));
  document.querySelectorAll('.theme-switch-sync').forEach(s => {
    s.checked = current === 'dark';
    s.addEventListener('change', () => syncAll(s.checked ? 'dark' : 'light'));
  });
}

// ===== PWA: Service Worker registration + update prompt =====
// On every deploy, service-worker.js bumps CACHE_NAME, the browser detects
// a new SW version. We listen for "installed" while another SW controls
// the page and show a toast offering the user to refresh.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then(reg => {
      // Check for updates whenever the tab becomes visible again
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update();
      });

      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            // A new SW is waiting. Prompt the user.
            promptForUpdate(newSW);
          }
        });
      });
    }).catch(err => console.warn('SW registration failed:', err));

    // When the active SW changes, reload the page so the new version takes effect
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

function promptForUpdate(newWorker) {
  // Minimal sticky banner — independent of toast system to survive any re-render.
  if (document.getElementById('pwa-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'pwa-update-banner';
  banner.innerHTML = `
    <span>Доступна новая версия приложения</span>
    <button id="pwa-update-btn">Обновить</button>
    <button id="pwa-update-dismiss" aria-label="Закрыть">×</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('pwa-update-btn').onclick = () => {
    newWorker.postMessage({ type: 'SKIP_WAITING' });
  };
  document.getElementById('pwa-update-dismiss').onclick = () => banner.remove();
}
