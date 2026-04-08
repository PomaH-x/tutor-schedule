document.addEventListener('DOMContentLoaded', async () => {
  initAuth();
  initStudents();

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

  showScreen('screen-profile');
  loadStudents();
}
