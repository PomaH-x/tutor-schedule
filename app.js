document.addEventListener('DOMContentLoaded', async () => {
  initAuth();

  const { data: { session } } = await supabase.auth.getSession();

  if (session?.user) {
    await onAuthSuccess(session.user);
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      state.user = null;
      state.profile = null;
      showScreen('screen-auth');
      showAuthStep('auth-step-role');
    }
  });
});
