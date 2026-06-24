function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast';
  if (type === 'error') toast.classList.add('toast-error');
  if (type === 'success') toast.classList.add('toast-success');
  toast.classList.add('visible');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ===== Ghost-click shield =====
// iOS Safari and some Android browsers fire a synthetic `click` event ~300ms AFTER
// `touchend` at the location of the original touch. If we open a modal during the
// pointerup/touchend handler, the modal is on screen by the time that delayed click
// arrives — so the click lands INSIDE the modal: on a button, on the search input,
// or on the overlay backdrop (which closes the modal again, giving a "flash" effect
// that's especially visible when the user taps a card near the bottom of the
// viewport, since the modal's backdrop occupies that area after centring).
//
// shieldFromGhostClick() drops a transparent full-screen layer above everything
// for 400ms after the modal opens. The synthetic click hits this layer and dies
// there; the user can't see it (transparent), and after 400ms the shield removes
// itself so normal interaction resumes. 400ms is comfortably above the ~300ms
// click-delay so we never expose the modal too early, but small enough that real
// user taps (which generally come >500ms apart) are unaffected.
function shieldFromGhostClick() {
  // Remove any leftover shield from a previous call (defensive)
  const prev = document.getElementById('ghost-click-shield');
  if (prev) prev.remove();
  const shield = document.createElement('div');
  shield.id = 'ghost-click-shield';
  shield.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent;';
  document.body.appendChild(shield);
  setTimeout(() => { shield.remove(); }, 400);
}
