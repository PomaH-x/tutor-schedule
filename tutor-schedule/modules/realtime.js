// =====================================================================
// realtime.js — edit-lock через Supabase Presence + live data sync
//
// Идея presence: каждый клиент держит presence в общем канале и публикует
// список "ключей" того, что сейчас редактирует (открытая модалка занятия,
// drag и т.д.). Все остальные клиенты подсвечивают эти карточки цветом
// редактирующего + блокируют клик/drag.
//
// Live data sync: подписки на postgres_changes для таблиц lessons,
// lesson_students, recurring_lessons и т.д. — при любом INSERT/UPDATE/
// DELETE с дебаунсом перевызываются loadLessons/loadRecurringLessons,
// чтобы все клиенты видели актуальную картину без рефреша страницы.
//
// Ключи presence:
//   "lesson:<uuid>"      — занятие в текущем расписании
//   "rec:<uuid>"         — занятие в постоянном расписании
//
// ВАЖНО: для работы data sync таблицы должны быть в publication:
//   ALTER PUBLICATION supabase_realtime ADD TABLE lessons, lesson_students,
//     recurring_lessons, recurring_lesson_students, cancellations;
// =====================================================================

let presenceChannel = null;
let dataChannel = null;
let lockedKeys = new Map(); // key -> { userId, name, color }
let myLockedKeys = new Set();
let presenceReady = false;

// Debounce timers — coalesce bursts of events into one refresh
let lessonsRefreshTimer = null;
let recurringRefreshTimer = null;
let truantsRefreshTimer = null;

function scheduleLessonsRefresh() {
  if (lessonsRefreshTimer) clearTimeout(lessonsRefreshTimer);
  lessonsRefreshTimer = setTimeout(() => {
    if (typeof loadLessons === 'function') loadLessons();
  }, 250);
}

function scheduleRecurringRefresh() {
  if (recurringRefreshTimer) clearTimeout(recurringRefreshTimer);
  recurringRefreshTimer = setTimeout(() => {
    // Only refresh if recurring screen is currently active — otherwise stale data is fine
    const recScreen = document.getElementById('screen-recurring');
    if (recScreen && recScreen.classList.contains('active') && typeof loadRecurringLessons === 'function') {
      loadRecurringLessons();
    }
  }, 250);
}

function scheduleTruantsRefresh() {
  if (truantsRefreshTimer) clearTimeout(truantsRefreshTimer);
  truantsRefreshTimer = setTimeout(() => {
    if (typeof loadTruants === 'function') loadTruants();
  }, 250);
}

async function initRealtime() {
  if (presenceChannel || !state.user || !state.profile) return;

  console.log('[realtime] init for user', state.user.id, state.profile?.short_name);

  presenceChannel = db.channel('schedule-locks', {
    config: { presence: { key: state.user.id } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const s = presenceChannel.presenceState();
      console.log('[realtime] sync, presences:', s);
      rebuildLockMap();
      console.log('[realtime] my view of locks:', Array.from(lockedKeys.entries()));
      applyLockVisuals();
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      console.log('[realtime] join', key, newPresences);
      rebuildLockMap();
      applyLockVisuals();
    })
    .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      console.log('[realtime] leave', key, leftPresences);
      rebuildLockMap();
      applyLockVisuals();
    });

  presenceChannel.subscribe(async (status) => {
    console.log('[realtime] subscribe status:', status);
    if (status === 'SUBSCRIBED') {
      presenceReady = true;
      await trackMyState();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      console.warn('[realtime] connection problem:', status);
    }
  });

  // === Data sync: live updates from other clients ===
  // Listen to postgres_changes on all tables that affect what users see on the schedule.
  // Each event triggers a debounced refresh of the relevant view.
  if (!dataChannel) {
    dataChannel = db.channel('data-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons' }, (payload) => {
        console.log('[realtime] lessons change:', payload.eventType);
        scheduleLessonsRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lesson_students' }, (payload) => {
        console.log('[realtime] lesson_students change:', payload.eventType);
        scheduleLessonsRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_lessons' }, (payload) => {
        console.log('[realtime] recurring change:', payload.eventType);
        scheduleRecurringRefresh();
        scheduleLessonsRefresh(); // recurring changes may sync to lessons too
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_lesson_students' }, () => {
        scheduleRecurringRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cancellations' }, () => {
        scheduleTruantsRefresh();
      })
      .subscribe((status) => {
        console.log('[realtime] data-sync status:', status);
      });
  }

  // Best-effort cleanup on tab close
  window.addEventListener('beforeunload', () => {
    if (presenceChannel) {
      try { presenceChannel.untrack(); } catch (_) {}
    }
  });
}

function rebuildLockMap() {
  if (!presenceChannel) return;
  lockedKeys.clear();
  const stateMap = presenceChannel.presenceState();
  for (const userKey in stateMap) {
    const presences = stateMap[userKey]; // array of presence entries
    if (!presences || presences.length === 0) continue;
    // Each track() call creates a new presence ref; only the LAST one in the array
    // represents the user's current intent. Older entries are stale tracks.
    const p = presences[presences.length - 1];
    if (!p || !Array.isArray(p.editing)) continue;
    // Skip my own locks — I don't lock myself out
    if (p.user_id === state.user.id) continue;
    p.editing.forEach(key => {
      lockedKeys.set(key, { userId: p.user_id, name: p.name || 'Кто-то', color: p.color || '#1e6fe8' });
    });
  }
}

async function trackMyState() {
  if (!presenceChannel || !presenceReady) return;
  try {
    const payload = {
      user_id: state.user.id,
      name: state.profile?.short_name || state.profile?.full_name || 'Преподаватель',
      color: state.profile?.color || '#1e6fe8',
      editing: Array.from(myLockedKeys)
    };
    console.log('[realtime] track', payload);
    await presenceChannel.track(payload);
  } catch (e) {
    console.warn('[realtime] track failed:', e);
  }
}

async function acquireLock(key) {
  if (!key) return true;
  // If someone else is already editing this, refuse
  const existing = lockedKeys.get(key);
  if (existing) return false;
  myLockedKeys.add(key);
  await trackMyState();
  return true;
}

async function releaseLock(key) {
  if (!key) return;
  if (!myLockedKeys.has(key)) return;
  myLockedKeys.delete(key);
  await trackMyState();
}

async function releaseAllMyLocks() {
  if (myLockedKeys.size === 0) return;
  myLockedKeys.clear();
  await trackMyState();
}

function getLockInfo(key) {
  return lockedKeys.get(key) || null;
}

// Render-time helper: apply visual styles to all visible cards based on locks
function applyLockVisuals() {
  // Both grids
  document.querySelectorAll('.lesson-card[data-lesson-id]').forEach(card => {
    const isRecGrid = card.closest('#recurring-grid');
    const id = card.dataset.lessonId;
    const key = (isRecGrid ? 'rec:' : 'lesson:') + id;
    const lock = lockedKeys.get(key);
    if (lock) {
      card.classList.add('lesson-locked');
      card.style.setProperty('--lock-color', lock.color);
      card.dataset.lockedBy = lock.name;
    } else {
      card.classList.remove('lesson-locked');
      card.style.removeProperty('--lock-color');
      delete card.dataset.lockedBy;
    }
  });
}

// Convenience: check & toast in one call. Returns true if locked (caller should abort).
function checkLockedAndToast(key) {
  const lock = getLockInfo(key);
  if (lock) {
    showToast(`Сейчас редактирует ${lock.name}`, 'error');
    return true;
  }
  return false;
}
