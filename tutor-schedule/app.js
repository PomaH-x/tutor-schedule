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

  document.addEventListener('mouseup', () => {
    if (typeof resizeState !== 'undefined' && resizeState) { finishResize(); }
    if (typeof dragState !== 'undefined' && dragState && dragStarted) {
      document.querySelector('.lesson-card-dragging')?.classList.remove('lesson-card-dragging');
      if (typeof clearDragHighlight === 'function') clearDragHighlight();
      dragState = null; dragMouseStart = null; dragStarted = false;
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (typeof studentDragState !== 'undefined' && studentDragState) {
      const banner = document.getElementById('student-drag-banner');
      if (banner) { banner.style.left = `${e.clientX + 12}px`; banner.style.top = `${e.clientY - 12}px`; }
    }
  });

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
