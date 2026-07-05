// =============================================================================
// modules/modal-guard.js
// =============================================================================
// Universal "unsaved changes" guard for modal forms.
//
// Usage pattern per modal:
//
//   openXxx() {
//     // ... populate form fields with initial values ...
//     markPristine('xxx-overlay');           // snapshot as "clean"
//   }
//
//   closeXxx() {
//     if (isDirty('xxx-overlay')) {
//       confirmDiscardChanges(() => actualCloseXxx());
//       return;
//     }
//     actualCloseXxx();
//   }
//
//   saveXxx() {
//     // ... write to DB, on success:
//     markPristine('xxx-overlay');           // now closing won't prompt
//     closeXxx();
//   }
//
// Design notes:
//   - Snapshot lives on the overlay element itself as a data attribute. That way
//     it survives DOM mutations inside the modal (re-renders, appended fields)
//     without needing a separate WeakMap.
//   - Fields identified by id first, then name, then a stable data-guard-key,
//     then their index inside the form. Elements without any identity are
//     compared purely by position — good enough for our forms.
//   - Skipped: hidden inputs, disabled fields, elements marked
//     data-guard-skip="true" (e.g. search boxes inside a modal that filter
//     lists but don't count as "form data" the user is editing).
//   - The dialog itself is delegated to showConfirm() so styling and behaviour
//     match every other confirmation in the app.
// =============================================================================

function getGuardedFields(overlayEl) {
  if (!overlayEl) return [];
  return Array.from(overlayEl.querySelectorAll('input, textarea, select')).filter(el => {
    // Hidden fields are skipped by default (they hold internal state), UNLESS
    // marked data-guard-key — that's an opt-in for JS-controlled UI (chip
    // editors, custom pickers) that mirrors its state into a hidden input
    // specifically so the guard can see edits.
    if (el.type === 'hidden' && !(el.dataset && el.dataset.guardKey)) return false;
    if (el.disabled) return false;
    if (el.dataset && el.dataset.guardSkip === 'true') return false;
    return true;
  });
}

function snapshotForm(overlayEl) {
  const fields = getGuardedFields(overlayEl);
  return fields.map((el, i) => {
    const key = el.id || el.name || (el.dataset && el.dataset.guardKey) || ('idx:' + i);
    const value = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '0') : (el.value || '');
    return key + '=' + value;
  }).join('|');
}

function markPristine(overlayId) {
  const overlayEl = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
  if (!overlayEl) return;
  overlayEl.dataset.pristineSnapshot = snapshotForm(overlayEl);
}

function clearPristine(overlayId) {
  const overlayEl = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
  if (!overlayEl) return;
  delete overlayEl.dataset.pristineSnapshot;
}

function isDirty(overlayId) {
  const overlayEl = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
  if (!overlayEl) return false;
  const snap = overlayEl.dataset.pristineSnapshot;
  if (snap === undefined || snap === null) return false;
  return snapshotForm(overlayEl) !== snap;
}

// Ask the user whether to discard unsaved changes. On confirm the caller's
// real close function runs; on cancel nothing happens (the modal stays open).
function confirmDiscardChanges(onDiscard) {
  if (typeof showConfirm === 'function') {
    showConfirm(
      'Закрыть форму без сохранения? Все внесённые изменения будут потеряны.',
      onDiscard,
      'Закрыть без сохранения',
      'danger'
    );
  } else {
    // Fallback in the unlikely case showConfirm isn't loaded yet
    if (window.confirm('Закрыть форму без сохранения?')) onDiscard();
  }
}

// Convenience wrapper: call closeFn if pristine, otherwise show confirm.
// Use this at the top of every closeXxx() function. Returns true if the modal
// was actually closed synchronously (pristine path), false if the user was
// asked to confirm (close will happen asynchronously if they confirm).
function guardClose(overlayId, closeFn) {
  if (isDirty(overlayId)) {
    confirmDiscardChanges(() => {
      clearPristine(overlayId);
      closeFn();
    });
    return false;
  }
  clearPristine(overlayId);
  closeFn();
  return true;
}
