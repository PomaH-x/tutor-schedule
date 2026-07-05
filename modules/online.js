let onlineWeekOffset = 0;
let onlineLessons = [];
let onlineStudents = [];
let onlineSelectedStudentId = null;
let onlineEditId = null;
// Pinned online lessons — these are the recurring "templates" that
// syncOnlinePinnedToWeeks() rolls forward into the +2-weeks slot. One row per
// (student, day_of_week, start_time, end_time). Loaded once at boot and
// refreshed after every pin / unpin toggle.
let onlinePinned = [];

const DAYS_ONLINE = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAYS_ONLINE_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

let onlinePinnedFreshlyLoaded = false;

// Load the current user's set of pinned online lessons. Used to:
//   - show which lesson cards are pinned (filled icon vs outlined)
//   - power syncOnlinePinnedToWeeks() which auto-copies them into +2 weeks.
// Hydrates from cache instantly on offline boot, refreshes from network.
async function loadOnlinePinned() {
  if (!state.profile || state.profile.role === 'student') { onlinePinned = []; return; }
  const isFreshLoad = !onlinePinnedFreshlyLoaded;
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('onlinePinned') : null;
    if (cached && Array.isArray(cached)) onlinePinned = cached;
  }
  const isAdmin = state.profile.role === 'admin';
  let q = db.from('online_pinned_lessons').select('*');
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);
  const { data, error } = await q;
  if (error) return; // keep cached pins
  onlinePinned = data || [];
  if (typeof cacheSet === 'function') cacheSet('onlinePinned', onlinePinned);
  onlinePinnedFreshlyLoaded = true;
}

// Match a lesson's (student × day × time) tuple against the current pin set.
// Returns the pin row if found, else null. Used for both render state and the
// unpin DELETE.
function findPin(studentId, lesson) {
  if (!lesson || !lesson.start_time) return null;
  const start = new Date(lesson.start_time);
  const end = new Date(lesson.end_time);
  const dayOfWeek = start.getDay() === 0 ? 6 : start.getDay() - 1;
  const startStr = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
  const endStr = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  return onlinePinned.find(p =>
    p.student_id === studentId &&
    p.day_of_week === dayOfWeek &&
    p.start_time.slice(0, 5) === startStr &&
    p.end_time.slice(0, 5) === endStr
  ) || null;
}

// Is EVERY student in the lesson pinned at this slot? Used to decide the icon
// state on the card (pinned slot = filled icon, otherwise outlined).
function isLessonFullyPinned(lesson) {
  const students = lesson.lesson_students || [];
  if (students.length === 0) return false;
  return students.every(ls => !!findPin(ls.student_id, lesson));
}

function getOnlineWeekStart() {
  const now = getMonday(new Date());
  const d = new Date(now);
  d.setDate(d.getDate() + onlineWeekOffset * 7);
  return d;
}

function updateOnlineWeekTabs() {
  document.querySelectorAll('#online-week-tabs .week-tab').forEach(tab => {
    tab.classList.toggle('active', +tab.dataset.offset === onlineWeekOffset);
  });
}

// Tracks which online weeks have been freshly loaded — prevents cache flicker
// on realtime refresh / week revisit (same logic as schedule's
// lessonsFreshlyLoadedWeeks).
const onlineFreshlyLoadedWeeks = new Set();

async function loadOnlineLessons() {
  const ws = formatDate(getOnlineWeekStart());
  const isFreshLoad = !onlineFreshlyLoadedWeeks.has(ws);
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('online:' + ws) : null;
    if (cached && Array.isArray(cached)) {
      onlineLessons = cached;
      renderOnlineLessons();
    }
  }
  // Refresh pins in parallel with lessons so the next render shows correct
  // pin state. loadOnlinePinned has its own fresh-load guard.
  const pinsPromise = (typeof loadOnlinePinned === 'function') ? loadOnlinePinned() : Promise.resolve();
  const isAdmin = state.profile.role === 'admin';
  let q = db.from('lessons')
    .select('*, teacher:profiles!teacher_id(short_name, color, full_name), lesson_students(student_id, student:students(first_name, last_name, subject, is_individual, is_online, price_type))')
    .eq('week_start', ws).eq('room', 0).eq('status', 'active');
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);
  const [{ data, error }] = await Promise.all([q, pinsPromise]);
  if (error) { console.error('Online load error:', error); return; }
  onlineLessons = (data || []).filter(l => l.lesson_students?.length > 0);
  renderOnlineLessons();
  if (typeof cacheSet === 'function') cacheSet('online:' + ws, onlineLessons);
  onlineFreshlyLoadedWeeks.add(ws);
}

function renderOnlineLessons() {
  const container = document.getElementById('online-lessons-list');
  if (!container) return;

  if (onlineLessons.length === 0) {
    container.innerHTML = '<div class="online-empty">Нет онлайн-занятий на этой неделе</div>';
    return;
  }

  const sorted = [...onlineLessons].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const ws = getOnlineWeekStart();
  const dates = getWeekDates(ws);

  let html = '';
  sorted.forEach(l => {
    const start = new Date(l.start_time);
    const end = new Date(l.end_time);
    const dayIdx = start.getDay() === 0 ? 6 : start.getDay() - 1;
    const dayName = DAYS_ONLINE[dayIdx];
    const dd = start.getDate().toString().padStart(2, '0');
    const mm = (start.getMonth() + 1).toString().padStart(2, '0');
    const timeStart = `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}`;
    const timeEnd = `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
    const durMin = Math.round((end - start) / 60000);
    const durLabel = formatDurationHours(durMin);
    const students = l.lesson_students || [];
    // Pin state: filled icon if ALL students of this slot are pinned, outlined
    // otherwise. Click toggles all-or-none for this slot. The user said online
    // lessons are individual (1 student) in practice, but the all-or-none model
    // still does the right thing if a multi-student card ever appears.
    const pinned = isLessonFullyPinned(l);
    const pinLabel = pinned ? 'Открепить' : 'Закрепить';
    const pinSvg = pinned
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 3l5 5-3.5 3.5-1.5-1.5-5 5V19l-3 3-2.5-2.5L8 17l-3-3-1.5-1.5-1.5-1.5 5-5L9 7.5 12.5 4l1.5 1.5L16 3z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76V6h-1V4h8v2h-1v4.76l3 3.24v3H6v-3z"/></svg>';

    html += `<div class="online-card" data-lesson-id="${l.id}">
      <div class="online-card-header">
        <span class="online-card-day">${dayName}, ${dd}.${mm}</span>
        <span class="online-card-time">${timeStart} – ${timeEnd}</span>
      </div>
      <div class="online-card-pin-row">
        <button class="online-btn-pin${pinned ? ' is-pinned' : ''}" data-pin="${l.id}" title="${pinLabel}">${pinSvg}<span class="online-pin-label">${pinLabel}</span></button>
      </div>
      <div class="online-card-students">`;
    students.forEach(ls => {
      const s = ls.student;
      if (!s) return;
      html += `<div class="online-card-student">
        <div class="online-student-info">
          <span class="online-student-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}</span>
          ${s.subject ? `<span class="online-student-subject">${escapeHtml(s.subject)}</span>` : ''}
        </div>
      </div>`;
    });
    html += `</div>
      <div class="online-card-actions">
        <button class="online-btn-cancel" data-cancel="${l.id}">Отменить</button>
        <button class="online-btn-disband" data-delete="${l.id}">Расформировать</button>
      </div>
    </div>`;
  });

  container.innerHTML = html;

  // Pin / unpin toggle. Disables itself while the DB roundtrip is in flight to
  // avoid double-clicks creating duplicates / 409s.
  container.querySelectorAll('[data-pin]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try { await togglePin(btn.dataset.pin); }
      finally { btn.disabled = false; }
    });
  });

  container.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const lid = btn.dataset.cancel;
      const lesson = onlineLessons.find(l => l.id === lid);
      if (!lesson) return;
      const studentIds = (lesson.lesson_students || []).map(ls => ls.student_id);
      if (studentIds.length === 0) return;
      const ws = lesson.week_start || formatDate(getOnlineWeekStart());
      const startTime = lesson.start_time || null;
      const startDay = startTime ? (new Date(startTime).getDay() === 0 ? 6 : new Date(startTime).getDay() - 1) : null;
      showCancelConfirm('Отменить занятие?', async (isPaid) => {
        await db.from('lesson_students').delete().eq('lesson_id', lid);
        const { error: cancelErr } = await db.from('cancellations').insert(
          studentIds.map(sid => ({
            student_id: sid, teacher_id: lesson.teacher_id || state.user.id,
            week_start: ws, status: 'pending',
            lesson_start_time: startTime, lesson_day: startDay, is_paid: isPaid
          }))
        );
        if (cancelErr) console.error('Cancel insert error:', cancelErr);
        await db.from('lessons').delete().eq('id', lid);
        showToast(isPaid ? 'Занятие отменено (платно)' : 'Занятие отменено', 'success');
        await loadOnlineLessons();
      });
    });
  });

  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const lid = btn.dataset.delete;
      showConfirm('Расформировать занятие?', async () => {
        await db.from('lesson_students').delete().eq('lesson_id', lid);
        await db.from('lessons').delete().eq('id', lid);
        showToast('Занятие расформировано', 'success');
        await loadOnlineLessons();
      }, 'Расформировать');
    });
  });
}

function formatDurationHours(min) {
  if (min < 60) return `${min} мин`;
  const h = min / 60;
  const isWhole = h === Math.floor(h);
  const display = isWhole ? `${h}` : h.toFixed(1).replace('.', ',');
  if (!isWhole) return `${display} часа`;
  const n = h % 100;
  const last = n % 10;
  if (n >= 11 && n <= 14) return `${display} часов`;
  if (last === 1) return `${display} час`;
  if (last >= 2 && last <= 4) return `${display} часа`;
  return `${display} часов`;
}

function openOnlineCreateModal() {
  onlineSelectedStudentId = null;
  onlineEditId = null;
  document.getElementById('online-modal-title').textContent = 'Добавить онлайн-занятие';
  document.getElementById('online-day').value = '0';
  document.getElementById('online-start').value = '14:00';
  document.getElementById('online-end').value = '16:00';
  loadOnlineStudents();
  document.getElementById('online-create-overlay').classList.add('active');
  markPristine('online-create-overlay');
}

function closeOnlineModal() {
  guardClose('online-create-overlay', () => {
    document.getElementById('online-create-overlay').classList.remove('active');
  });
}

async function loadOnlineStudents() {
  const tid = state.user.id;
  const { data } = await db.from('students').select('id, first_name, last_name, subject, is_individual, is_online, price_type')
    .eq('teacher_id', tid).eq('is_online', true).order('first_name');
  onlineStudents = data || [];

  const list = document.getElementById('online-student-list');
  list.innerHTML = onlineStudents.map(s => {
    const sel = onlineSelectedStudentId === s.id;
    return `<label class="lesson-student-row${sel ? ' checked' : ''}">
      <span class="lesson-student-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}</span>
      <input type="radio" name="online-student" class="lesson-checkbox" data-id="${s.id}" ${sel ? 'checked' : ''}>
    </label>`;
  }).join('') || '<div class="lesson-no-students">Нет онлайн-учеников</div>';

  list.querySelectorAll('input[name="online-student"]').forEach(r => {
    r.addEventListener('change', () => { onlineSelectedStudentId = r.dataset.id; });
  });
}

async function saveOnlineLesson() {
  if (!onlineSelectedStudentId) { showToast('Выберите ученика', 'error'); return; }
  const day = +document.getElementById('online-day').value;
  const startVal = document.getElementById('online-start').value;
  const endVal = document.getElementById('online-end').value;
  if (!startVal || !endVal) { showToast('Укажите время', 'error'); return; }

  const sp = startVal.split(':'); const ep = endVal.split(':');
  const startMin = +sp[0] * 60 + +sp[1];
  const endMin = +ep[0] * 60 + +ep[1];
  if (endMin <= startMin) { showToast('Конец должен быть позже начала', 'error'); return; }

  const durationMin = endMin - startMin;
  const student = onlineStudents.find(s => s.id === onlineSelectedStudentId);
  if (student && !findPricing(durationMin, student.is_individual || false, student.price_type || 'new', student.is_online || false)) {
    showToast(`Нет тарифа для ${durationMin} мин`, 'error'); return;
  }

  const currentWs = getOnlineWeekStart();
  // Single-week creation only — future weeks are handled by the «Закрепить»
  // feature now. If the user wants this lesson to repeat, they pin it on the
  // card and syncOnlinePinnedToWeeks fills +2 weeks ahead automatically.
  const weeks = [currentWs];

  markPristine('online-create-overlay');
  closeOnlineModal();

  for (const weekStart of weeks) {
    const dates = getWeekDates(weekStart);
    const date = dates[day];
    const sTime = new Date(date); sTime.setHours(+sp[0], +sp[1], 0, 0);
    const eTime = new Date(date); eTime.setHours(+ep[0], +ep[1], 0, 0);
    const ws = formatDate(weekStart);

    // Dedup check
    const { data: existing } = await db.from('lessons')
      .select('id').eq('week_start', ws).eq('teacher_id', state.user.id)
      .eq('room', 0).eq('start_time', sTime.toISOString());
    if (existing?.length > 0) continue;

    const { data: newLesson, error } = await db.from('lessons').insert({
      teacher_id: state.user.id, room: 0, week_start: ws,
      start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
    }).select().single();

    if (error) { console.error('Online save error:', error); showToast('Ошибка: ' + error.message, 'error'); return; }
    if (newLesson) {
      const { error: e2 } = await db.from('lesson_students').insert({ lesson_id: newLesson.id, student_id: onlineSelectedStudentId });
      if (e2) { console.error('Student link error:', e2); }
      else await attachActiveSubscriptionIfAny(newLesson.id, onlineSelectedStudentId, state.user.id);
    }
  }

  showToast('Занятие создано', 'success');
  await loadOnlineLessons();
}

function initOnline() {
  document.getElementById('btn-to-online').addEventListener('click', () => {
    showScreen('screen-online');
    onlineWeekOffset = 0;
    updateOnlineWeekTabs();
    loadOnlineLessons();
  });

  document.getElementById('btn-online-to-current').addEventListener('click', () => {
    showScreen('screen-schedule');
    if (typeof loadLessons === 'function') loadLessons();
  });

  document.querySelectorAll('#online-week-tabs .week-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      onlineWeekOffset = +tab.dataset.offset;
      updateOnlineWeekTabs();
      loadOnlineLessons();
    });
  });

  document.getElementById('btn-add-online').addEventListener('click', openOnlineCreateModal);
  document.getElementById('btn-close-online-modal').addEventListener('click', closeOnlineModal);
  document.getElementById('btn-cancel-online').addEventListener('click', closeOnlineModal);
  document.getElementById('btn-save-online').addEventListener('click', saveOnlineLesson);
  document.getElementById('online-create-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeOnlineModal();
  });

  document.getElementById('btn-profile-online').addEventListener('click', () => showScreen('screen-profile'));
}

// Toggle pin state for an online lesson. "Pin a lesson" means: for EACH student
// in that lesson, INSERT a row into online_pinned_lessons capturing
// (teacher, student, day_of_week, start_time, end_time). "Unpin" deletes those
// matching rows. Since the typical online lesson has exactly one student, this
// usually amounts to one INSERT or one DELETE per click.
//
// After the DB op we run syncOnlinePinnedToWeeks immediately so the +2-weeks
// view gets the new lesson without waiting for the next boot, and we reload
// the pins list so the icon flips its state.
async function togglePin(lessonId) {
  const lesson = onlineLessons.find(l => l.id === lessonId);
  if (!lesson) return;
  const students = lesson.lesson_students || [];
  if (students.length === 0) return;

  const start = new Date(lesson.start_time);
  const end = new Date(lesson.end_time);
  const dayOfWeek = start.getDay() === 0 ? 6 : start.getDay() - 1;
  const startStr = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}:00`;
  const endStr = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}:00`;
  const teacherId = lesson.teacher_id || state.user.id;

  const isFullyPinned = isLessonFullyPinned(lesson);

  if (isFullyPinned) {
    // UNPIN — delete pin rows for each student at this slot
    const ids = students
      .map(ls => findPin(ls.student_id, lesson))
      .filter(Boolean)
      .map(p => p.id);
    if (ids.length === 0) return;
    const { error } = await db.from('online_pinned_lessons').delete().in('id', ids);
    if (error) { showToast('Ошибка', 'error'); return; }
    showToast('Закрепление снято', 'success');
  } else {
    // PIN — insert one row per student at this slot. Using upsert with
    // onConflict so re-pinning a partially-pinned slot (some students already
    // pinned) doesn't fail on the UNIQUE constraint.
    const rows = students.map(ls => ({
      teacher_id: teacherId, student_id: ls.student_id,
      day_of_week: dayOfWeek, start_time: startStr, end_time: endStr
    }));
    const { error } = await db.from('online_pinned_lessons').upsert(rows, {
      onConflict: 'student_id,day_of_week,start_time,end_time'
    });
    if (error) { showToast('Ошибка', 'error'); return; }
    showToast('Занятие закреплено — будет автоматически копироваться', 'success');
  }

  await loadOnlinePinned();
  // Fire-and-forget the sync so the +2-weeks view picks up the change. We
  // don't await it here because the user is on the current week and shouldn't
  // wait for a future-week write to complete just to see the pin icon flip.
  if (typeof syncOnlinePinnedToWeeks === 'function') syncOnlinePinnedToWeeks();
  renderOnlineLessons();
}

// Mirror of syncRecurringToWeeks for online-pinned templates. Iterates the
// current user's pins (or all pins if admin), groups them by (teacher, day,
// start, end), and creates `lessons` rows with room=0 in the "+2 weeks" slot.
// Slots that already have ANY lesson (active / cancelled / transferred) are
// left alone — same "never recreate over a manual decision" rule as the
// regular sync. Multi-student groups are reconstructed by inserting all
// `lesson_students` for that slot.
async function syncOnlinePinnedToWeeks(teacherFilter) {
  if (!state.profile) return;
  const now = getMonday(new Date());
  // Copy pinned online lessons into BOTH the next week and the week after.
  // Previously only +14 days was populated, leaving a gap on +7 days.
  const oneWeek = new Date(now); oneWeek.setDate(oneWeek.getDate() + 7);
  const twoWeeks = new Date(now); twoWeeks.setDate(twoWeeks.getDate() + 14);
  const isAdmin = state.profile.role === 'admin';
  const filterTid = teacherFilter || (isAdmin ? null : state.user.id);

  let q = db.from('online_pinned_lessons').select('*');
  if (filterTid) q = q.eq('teacher_id', filterTid);
  const { data: pins } = await q;
  if (!pins || pins.length === 0) return;

  for (const weekStart of [oneWeek, twoWeeks]) {
    const ws = formatDate(weekStart);
    const dates = getWeekDates(weekStart);

    // ALL statuses considered so we don't overwrite a manual cancel/transfer.
    let eq = db.from('lessons')
      .select('id, teacher_id, start_time, status, lesson_students(student_id)')
      .eq('week_start', ws).eq('room', 0);
    if (filterTid) eq = eq.eq('teacher_id', filterTid);
    const { data: existing } = await eq;

    const existingByKey = {};
    (existing || []).forEach(l => {
      const s = new Date(l.start_time);
      const key = `${l.teacher_id}-${s.getDay()}-${s.getHours()}:${s.getMinutes()}`;
      existingByKey[key] = l;
    });

    // Group pins by slot so a 2-student slot makes one lesson with both
    const slotGroups = new Map();
    for (const pin of pins) {
      const dayDate = dates[pin.day_of_week];
      if (!dayDate) continue;
      const sp = pin.start_time.split(':');
      const slotKey = `${pin.teacher_id}-${dayDate.getDay()}-${+sp[0]}:${+sp[1]}`;
      if (!slotGroups.has(slotKey)) slotGroups.set(slotKey, { pin, students: [] });
      slotGroups.get(slotKey).students.push(pin.student_id);
    }

    for (const group of slotGroups.values()) {
      const { pin, students: sids } = group;
      const dayDate = dates[pin.day_of_week];
      const sp = pin.start_time.split(':');
      const ep = pin.end_time.split(':');
      const slotKey = `${pin.teacher_id}-${dayDate.getDay()}-${+sp[0]}:${+sp[1]}`;

      const ex = existingByKey[slotKey];
      if (ex) {
        // Slot already has a lesson — merge new students if it's still active
        if (ex.status === 'active') {
          const existingSids = new Set((ex.lesson_students || []).map(ls => ls.student_id));
          const newSids = sids.filter(sid => !existingSids.has(sid));
          if (newSids.length > 0) {
            await db.from('lesson_students').insert(newSids.map(sid => ({ lesson_id: ex.id, student_id: sid })));
          }
        }
        continue;
      }

      // Empty slot — create a fresh online lesson (room = 0)
      const sTime = new Date(dayDate); sTime.setHours(+sp[0], +sp[1], 0, 0);
      const eTime = new Date(dayDate); eTime.setHours(+ep[0], +ep[1], 0, 0);
      const { data: newLesson, error } = await db.from('lessons').insert({
        teacher_id: pin.teacher_id, room: 0, week_start: ws,
        start_time: sTime.toISOString(), end_time: eTime.toISOString(), status: 'active'
      }).select().single();
      if (!error && newLesson) {
        await db.from('lesson_students').insert(sids.map(sid => ({ lesson_id: newLesson.id, student_id: sid })));
        if (typeof attachActiveSubscriptionIfAny === 'function') {
          for (const sid of sids) await attachActiveSubscriptionIfAny(newLesson.id, sid, pin.teacher_id);
        }
      }
    }
  }
}
