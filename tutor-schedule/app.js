document.addEventListener('DOMContentLoaded', async () => {
  initAuth();
  initStudents();
  initAdmin();

  document.getElementById('btn-profile').addEventListener('click', () => {
    openProfileScreen();
  });

  document.getElementById('btn-back-to-schedule').addEventListener('click', () => {
    showScreen('screen-schedule');
  });

  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  const { data: { session } } = await db.auth.getSession();

  if (session?.user) {
    await onAuthSuccess(session.user);
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

  const tabs = document.getElementById('profile-tabs');
  if (p.role === 'admin') {
    tabs.style.display = 'flex';
  } else {
    tabs.style.display = 'none';
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.profile-tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="tab-students"]').classList.add('active');
    document.getElementById('tab-students').classList.add('active');
  }

  showScreen('screen-profile');
  loadStudents();
  loadPendingCount();
}
