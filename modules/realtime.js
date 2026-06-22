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
// Устойчивость: при потере соединения (CLOSED, CHANNEL_ERROR, TIMED_OUT)
// локи очищаются (нет актуальной информации = пользователь не блокируется),
// канал переподключается автоматически через 3 секунды.
// =====================================================================

let presenceChannel = null;
let dataChannel = null;
let lockedKeys = new Map(); // key -> { userId, name, color }
let myLockedKeys = new Set();
let presenceReady = false;
let reconnectTimer = null;

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

function handleConnectionLoss() {
  // Connection lost: clear locks (we have no current info, so we shouldn't block the user)
  lockedKeys.clear();
  presenceReady = false;
  applyLockVisuals();

  // Schedule a reconnect attempt
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      if (presenceChannel) {
        await presenceChannel.unsubscribe();
        presenceChannel = null;
      }
      if (dataChannel) {
        await dataChannel.unsubscribe();
        dataChannel = null;
      }
    } catch (_) {}
    initRealtime();
  }, 3000);
}

async function initRealtime() {
  if (presenceChannel || !state.user || !state.profile) return;

  presenceChannel = db.channel('schedule-locks', {
    config: { presence: { key: state.user.id } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      rebuildLockMap();
      applyLockVisuals();
    })
    .on('presence', { event: 'join' }, () => {
      rebuildLockMap();
      applyLockVisuals();
    })
    .on('presence', { event: 'leave' }, () => {
      rebuildLockMap();
      applyLockVisuals();
    });

  presenceChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      presenceReady = true;
      await trackMyState();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      // Channel transients are normal on mobile/sleeping tabs — silent reconnect via timer
      handleConnectionLoss();
    }
  });

  // === Data sync: live updates from other clients ===
  if (!dataChannel) {
    dataChannel = db.channel('data-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons' }, () => {
        scheduleLessonsRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lesson_students' }, () => {
        scheduleLessonsRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_lessons' }, () => {
        scheduleRecurringRefresh();
        scheduleLessonsRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_lesson_students' }, () => {
        scheduleRecurringRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cancellations' }, () => {
        scheduleTruantsRefresh();
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // data-sync recovery rides along with presence reconnect via handleConnectionLoss
        }
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
    const presences = stateMap[userKey];
    if (!presences || presences.length === 0) continue;
    // Each track() creates a new presence ref; only the LAST one represents
    // current intent. Older entries are stale.
    const p = presences[presences.length - 1];
    if (!p || !Array.isArray(p.editing)) continue;
    if (p.user_id === state.user.id) continue; // skip my own locks
    p.editing.forEach(key => {
      lockedKeys.set(key, { userId: p.user_id, name: p.name || 'Кто-то', color: p.color || '#1e6fe8' });
    });
  }
}

async function trackMyState() {
  if (!presenceChannel || !presenceReady) return;
  try {
    await presenceChannel.track({
      user_id: state.user.id,
      name: state.profile?.short_name || state.profile?.full_name || 'Преподаватель',
      color: state.profile?.color || '#1e6fe8',
      editing: Array.from(myLockedKeys)
    });
  } catch (e) {
    // best-effort presence — failures are non-fatal
  }
}

async function acquireLock(key) {
  if (!key) return true;
  if (!presenceReady) return true; // offline → don't block the user
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
  if (presenceReady) await trackMyState();
}

async function releaseAllMyLocks() {
  if (myLockedKeys.size === 0) return;
  myLockedKeys.clear();
  if (presenceReady) await trackMyState();
}

function getLockInfo(key) {
  return lockedKeys.get(key) || null;
}

// Render-time helper: apply visual styles to all visible cards based on locks
function applyLockVisuals() {
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

// Convenience: check & toast. Returns true if locked (caller should abort).
// When offline (presenceReady=false), we don't enforce locks — better to let
// the user keep working with conflicts handled the old way than to freeze them.
function checkLockedAndToast(key) {
  if (!presenceReady) return false;
  const lock = getLockInfo(key);
  if (lock) {
    showToast(`Сейчас редактирует ${lock.name}`, 'error');
    return true;
  }
  return false;
}


