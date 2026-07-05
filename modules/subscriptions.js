// ===== SUBSCRIPTIONS =====
// Subscriptions are "packages" of 4 or 8 lessons a student pre-pays for at a discount.
// The teacher activates a subscription in the student's card after receiving the cash.
// Each conducted lesson (or lesson cancelled late) consumes a slot.
// Transfers (drag-and-drop) consume the transfer counter, not the lesson slot.
//
// Key invariants:
// - One active subscription per student at a time (per teacher).
// - A subscription is bound to lesson_students rows via lesson_students.subscription_id.
// - used_lessons / transfers_used are stored on the row and updated by recompute*().

let activeSubscriptionsCache = {}; // { studentId: subscription | null }, lazy

// --- Loading ---

async function loadActiveSubscriptionForStudent(studentId, force) {
  if (!force && activeSubscriptionsCache[studentId] !== undefined) {
    return activeSubscriptionsCache[studentId];
  }
  try {
    // Try active first
    const { data: active, error: activeErr } = await db.from('subscriptions')
      .select('*, pricing:pricing_id(duration_minutes, is_individual, is_online, format, student_price, teacher_profit, commission), subject:subject_id(name)')
      .eq('student_id', studentId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!activeErr) {
      if (active) {
        activeSubscriptionsCache[studentId] = active;
        // Persist for offline boot — keyed per student id
        if (typeof cacheSet === 'function') cacheSet('sub:' + studentId, active);
        return active;
      }
      // Fallback: most recent non-active (completed/expired/refunded) — to show context in UI
      const { data: other } = await db.from('subscriptions')
        .select('*, pricing:pricing_id(duration_minutes, is_individual, is_online, format, student_price, teacher_profit, commission)')
        .eq('student_id', studentId)
        .in('status', ['completed', 'expired', 'refunded'])
        .order('end_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      activeSubscriptionsCache[studentId] = other || null;
      if (other && typeof cacheSet === 'function') cacheSet('sub:' + studentId, other);
      return other || null;
    }
  } catch (_) { /* network down — try cache below */ }
  // Network failed entirely: fall back to last-known snapshot from localStorage
  const cached = (typeof cacheGet === 'function') ? cacheGet('sub:' + studentId) : null;
  if (cached) {
    activeSubscriptionsCache[studentId] = cached;
    return cached;
  }
  return null;
}

function invalidateSubscriptionCache(studentId) {
  if (studentId) delete activeSubscriptionsCache[studentId];
  else activeSubscriptionsCache = {};
}

// Load ALL active subscriptions for a student (a student can now hold one
// subscription per subject) plus, if there are no actives at all, the most
// recent non-active one to give the UI context (e.g. "last one expired").
// Returns { active: [subs], last: sub|null }.
async function loadStudentSubscriptionsList(studentId) {
  try {
    const { data: actives } = await db.from('subscriptions')
      .select('*, pricing:pricing_id(duration_minutes, is_individual, is_online, format, student_price, teacher_profit, commission), subject:subject_id(name)')
      .eq('student_id', studentId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (actives && actives.length > 0) {
      return { active: actives, last: null };
    }
    // No actives — show the most recent finished one for context (Завершён /
    // Истёк / Возврат). Same fallback that loadStudentActiveSubscription used
    // to provide.
    const { data: last } = await db.from('subscriptions')
      .select('*, pricing:pricing_id(duration_minutes, is_individual, is_online, format, student_price, teacher_profit, commission), subject:subject_id(name)')
      .eq('student_id', studentId)
      .in('status', ['completed', 'expired', 'refunded'])
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    return { active: [], last: last || null };
  } catch (e) {
    console.error('loadStudentSubscriptionsList:', e);
    return { active: [], last: null };
  }
}

// --- Activation ---

let activationCtx = null; // { studentId, student, options }

async function openSubscriptionActivation(studentId) {
  const { data: student } = await db.from('students')
    .select('id, first_name, last_name, subject, is_individual, is_online, price_type, student_subjects(subject_id, subjects(id, name))')
    .eq('id', studentId).single();
  if (!student) { showToast('Ученик не найден', 'error'); return; }

  // Flatten the junction join into a plain [{id, name}] list — that's what
  // the subject picker below iterates over. Falls back to the legacy single-
  // value column if the junction is empty.
  const studentSubjects = (student.student_subjects || [])
    .map(ss => ss.subjects)
    .filter(Boolean);
  if (studentSubjects.length === 0 && student.subject) {
    const legacy = subjectsList.find(s => s.name === student.subject);
    if (legacy) studentSubjects.push({ id: legacy.id, name: legacy.name });
  }
  if (studentSubjects.length === 0) {
    showToast('У ученика нет предметов. Добавьте хотя бы один в карточке ученика.', 'error');
    return;
  }

  // Exclude subjects that already have an active subscription — a student
  // can only hold ONE active subscription per subject. If they want another,
  // they can wait for the current one to end or close it with a refund.
  const { data: activeSubs } = await db.from('subscriptions')
    .select('subject_id')
    .eq('student_id', studentId)
    .eq('status', 'active');
  const coveredSubjectIds = new Set((activeSubs || []).map(s => s.subject_id).filter(Boolean));
  const availableSubjects = studentSubjects.filter(s => !coveredSubjectIds.has(s.id));
  if (availableSubjects.length === 0) {
    showToast('У всех предметов ученика уже активен абонемент. Дождитесь окончания или закройте с возвратом.', 'error');
    return;
  }

  // Pull ALL subscription pricing options matching the student's format
  // (group/individual/online + price_type). Duration is chosen inside the form.
  const priceType = student.price_type || 'new';
  const options = pricingList.filter(p => {
    if (p.format !== 'sub4' && p.format !== 'sub8') return false;
    if (p.price_type !== priceType) return false;
    if (student.is_online) return p.is_online === true;
    return !p.is_online && p.is_individual === (student.is_individual || false);
  });

  if (options.length === 0) {
    showToast('Для этого ученика нет тарифов абонементов. Добавьте их в админке.', 'error');
    return;
  }

  activationCtx = { studentId, student, options, studentSubjects: availableSubjects };

  document.getElementById('sub-act-student').textContent = `${student.first_name} ${student.last_name}`;

  // "Предмет" — either a plain span (one subject → nothing to pick) or a
  // dropdown so the teacher can decide which subject this subscription is
  // for. The chosen name is read back in confirmSubscriptionActivation().
  const subjWrap = document.getElementById('sub-act-subject');
  if (availableSubjects.length === 1) {
    subjWrap.textContent = availableSubjects[0].name;
  } else {
    subjWrap.innerHTML = `<select id="sub-act-subject-select">
      ${availableSubjects.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('')}
    </select>`;
  }

  const typeLabel = student.is_online ? 'Онлайн' : (student.is_individual ? 'Индивидуальное' : 'Групповое');
  document.getElementById('sub-act-type').textContent = typeLabel;

  // Build options grouped by duration, sorted: 90 → 120 → 180, then sub4 → sub8 within each
  const sorted = [...options].sort((a, b) => {
    if (a.duration_minutes !== b.duration_minutes) return a.duration_minutes - b.duration_minutes;
    return a.format === 'sub4' ? -1 : 1;
  });

  const wrap = document.getElementById('sub-act-options');
  wrap.innerHTML = sorted.map((o, i) => {
    const lessons = o.format === 'sub4' ? 4 : 8;
    const transfers = o.format === 'sub4' ? 1 : 2;
    const h = o.duration_minutes / 60;
    const hStr = h === Math.floor(h) ? `${h} ч` : `${h.toString().replace('.', ',')} ч`;
    return `<label class="sub-act-option">
      <input type="radio" name="sub-act-format" value="${o.id}" ${i === 0 ? 'checked' : ''}>
      <div class="sub-act-option-body">
        <div class="sub-act-option-title">${hStr} · ${lessons} занятий</div>
        <div class="sub-act-option-meta">
          <span>Стоимость: <b>${o.student_price} ₽</b></span>
          <span>Преподавателю: <b>${o.teacher_profit} ₽</b></span>
          <span>Центру: <b>${o.commission} ₽</b></span>
          <span>Переносов: <b>${transfers}</b></span>
        </div>
      </div>
    </label>`;
  }).join('');

  refreshActivationDurationVisibility();
  wrap.querySelectorAll('input[name="sub-act-format"]').forEach(r =>
    r.addEventListener('change', refreshActivationDurationVisibility)
  );

  document.getElementById('sub-act-start').value = formatDate(new Date());
  document.getElementById('subscription-activation-overlay').classList.add('active');
  markPristine('subscription-activation-overlay');
}

function refreshActivationDurationVisibility() {
  if (!activationCtx) return;
  const picked = document.querySelector('input[name="sub-act-format"]:checked');
  if (!picked) return;
  const opt = activationCtx.options.find(o => o.id === picked.value);
  const block = document.getElementById('sub-act-duration-block');
  if (opt && opt.format === 'sub8') {
    block.style.display = '';
  } else {
    block.style.display = 'none';
  }
}

function closeSubscriptionActivation() {
  guardClose('subscription-activation-overlay', () => {
    document.getElementById('subscription-activation-overlay').classList.remove('active');
    activationCtx = null;
  });
}

async function confirmSubscriptionActivation() {
  if (!activationCtx) return;
  const pickedRadio = document.querySelector('input[name="sub-act-format"]:checked');
  if (!pickedRadio) { showToast('Выберите тип абонемента', 'error'); return; }
  const pricing = activationCtx.options.find(o => o.id === pickedRadio.value);
  if (!pricing) return;

  // Which subject is this subscription for?
  //   - Student with one subject → we baked the name into the span at open time;
  //     read it directly from activationCtx (no user choice to make).
  //   - Student with multiple subjects → we injected a <select>; pull the
  //     chosen value from there.
  let subjectName;
  if (activationCtx.studentSubjects.length === 1) {
    subjectName = activationCtx.studentSubjects[0].name;
  } else {
    const subjSel = document.getElementById('sub-act-subject-select');
    subjectName = subjSel ? subjSel.value : null;
  }
  if (!subjectName) { showToast('Выберите предмет абонемента', 'error'); return; }
  const subjectRec = activationCtx.studentSubjects.find(s => s.name === subjectName);
  const subjectId = subjectRec ? subjectRec.id : null;

  const startDateStr = document.getElementById('sub-act-start').value;
  if (!startDateStr) { showToast('Укажите дату начала', 'error'); return; }
  const startDate = new Date(startDateStr);

  const totalLessons = pricing.format === 'sub4' ? 4 : 8;
  const totalTransfers = pricing.format === 'sub4' ? 1 : 2;

  // sub8 has user-chosen duration (30 or 60 days); sub4 is always 30
  let durationDays = 30;
  if (pricing.format === 'sub8') {
    const dur = document.querySelector('input[name="sub-act-duration"]:checked');
    if (!dur) { showToast('Выберите срок действия', 'error'); return; }
    durationDays = parseInt(dur.value);
  }

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + durationDays);

  const btn = document.getElementById('btn-sub-act-confirm');
  btn.disabled = true;
  try {
    const { data: created, error } = await db.from('subscriptions').insert({
      student_id: activationCtx.studentId,
      teacher_id: state.user.id,
      pricing_id: pricing.id,
      subject_id: subjectId,
      total_lessons: totalLessons,
      total_transfers: totalTransfers,
      used_lessons: 0,
      transfers_used: 0,
      paid_amount: pricing.student_price,
      teacher_share: pricing.teacher_profit,
      center_share: pricing.commission,
      start_date: formatDate(startDate),
      end_date: formatDate(endDate),
      status: 'active'
    }).select().single();
    if (error) throw error;

    // After activation — go and attach already-existing lessons of this student
    // from start_date onwards that don't have a subscription yet, and recompute usage.
    await attachLessonsToSubscription(created.id, activationCtx.studentId, startDate);
    await recomputeSubscriptionUsage(created.id);

    // Push the student about their new subscription. Per AM: only the student
    // is notified — the teacher just created it themselves and obviously knows.
    // We look up students.profile_id; if it's null (e.g. minor without their
    // own account), there's no user to push to and we silently skip.
    try {
      const { data: studentRec } = await db.from('students')
        .select('profile_id, first_name, last_name')
        .eq('id', activationCtx.studentId).maybeSingle();
      if (studentRec && studentRec.profile_id && typeof sendPush === 'function') {
        sendPush([studentRec.profile_id], {
          title: 'Новый абонемент',
          body: `${totalLessons} уроков — до ${formatDate(endDate)}`,
          tag: `sub-new-${created.id}`,
        });
      }
    } catch (e) {
      console.warn('[push] new-sub notify failed:', e && e.message);
    }

    invalidateSubscriptionCache(activationCtx.studentId);
    const sid = activationCtx.studentId; // snapshot before close clears the context
    markPristine('subscription-activation-overlay');
    closeSubscriptionActivation();
    showToast('Абонемент активирован', 'success');
    // Reopen the student detail to refresh the panel immediately
    if (typeof openStudentDetail === 'function' && sid) {
      await openStudentDetail(sid);
    }
  } catch (e) {
    console.error('confirmSubscriptionActivation:', e);
    showToast('Ошибка: ' + (e.message || 'неизвестно'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Auto-binding lessons to active subscription ---

// ----------------------------------------------------------------------------
// Placement RPCs (iteration 3). These wrap the Postgres `place_student_on_*`
// functions which do all the mechanical DB ops in one transaction (insert
// lesson, move lesson_students row, delete empty source, attach subscription)
// and return the list of subscription_ids that need recomputing on the client.
// Caller is responsible for running recomputeSubscriptionUsage on those IDs
// (this stays on the JS side because the JS function is the source of truth
// for the recompute logic; the Postgres equivalent is kept as a backstop).
//
// Replaces the previous 5–7 sequential `await db.from(...)` chain with a
// single round-trip. If the RPC isn't installed yet (user hasn't applied
// iteration-3.sql), the wrapper sets `rpcAvailable=false` for the rest of
// the session and falls back to the legacy sequential path automatically.
// ----------------------------------------------------------------------------
let __rpcPlacementAvailable = true;

async function rpcPlaceStudentOnNewLesson(params) {
  if (!__rpcPlacementAvailable) return null;
  const { data, error } = await db.rpc('place_student_on_new_lesson', params);
  if (error) {
    // 42883 = undefined_function — RPC not installed. Disable for session.
    if (error.code === '42883' || /function .* does not exist/i.test(error.message || '')) {
      console.warn('[placement-rpc] not installed, falling back to legacy path. Apply iteration-3.sql to enable single-roundtrip placement.');
      __rpcPlacementAvailable = false;
      return null;
    }
    throw error;
  }
  return data && data[0] ? data[0] : null; // { new_lesson_id, source_deleted, affected_sub_ids }
}

async function rpcPlaceStudentOnExistingLesson(params) {
  if (!__rpcPlacementAvailable) return null;
  const { data, error } = await db.rpc('place_student_on_existing_lesson', params);
  if (error) {
    if (error.code === '42883' || /function .* does not exist/i.test(error.message || '')) {
      __rpcPlacementAvailable = false;
      return null;
    }
    throw error;
  }
  return data && data[0] ? data[0] : null; // { source_deleted, affected_sub_ids }
}

// After an RPC placement returns affected_sub_ids[], recompute all of them
// in parallel (one HTTP round-trip per sub, but they fire simultaneously
// rather than sequentially as the old code did).
async function recomputeSubscriptionsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  await Promise.all(ids.map(id => recomputeSubscriptionUsage(id)));
}

// Call this after inserting a lesson_students row.
// If the student has an ACTIVE subscription with this teacher AND the lesson falls
// within its validity period — attach. Direct query, no cache, no fallback to expired.
async function attachActiveSubscriptionIfAny(lessonId, studentId, teacherId) {
  try {
    // Read the subject assigned to this student on this specific lesson —
    // stored on the link row itself now that a lesson can have multiple
    // students, each on a different subject.
    const { data: link } = await db.from('lesson_students')
      .select('subject_id, lesson:lessons(start_time)')
      .eq('lesson_id', lessonId).eq('student_id', studentId).maybeSingle();
    if (!link || !link.lesson) return;
    const linkSubjectId = link.subject_id || null;

    // Pull ALL active subs for this student+teacher — we'll pick the right
    // one on the client. Ordered so the newest one wins ties.
    const { data: subs } = await db.from('subscriptions')
      .select('id, status, teacher_id, start_date, end_date, subject_id')
      .eq('student_id', studentId)
      .eq('teacher_id', teacherId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (!subs || subs.length === 0) return;

    const ls = new Date(link.lesson.start_time);
    const inWindow = (sub) => {
      const e = new Date(sub.end_date); e.setHours(23, 59, 59, 999);
      return ls >= new Date(sub.start_date) && ls <= e;
    };

    // Priority selection:
    //   1. exact subject match (sub.subject_id === link.subject_id),
    //   2. legacy sub with NULL subject_id (backward compat with pre-reform data).
    // A sub with subject_id set that DOESN'T match this link's subject is
    // never chosen — that's the whole point of tying subs to a subject.
    let sub = subs.find(s => s.subject_id && s.subject_id === linkSubjectId && inWindow(s));
    if (!sub) sub = subs.find(s => !s.subject_id && inWindow(s));
    if (!sub) return;

    await db.from('lesson_students')
      .update({ subscription_id: sub.id })
      .eq('lesson_id', lessonId).eq('student_id', studentId);
    await recomputeSubscriptionUsage(sub.id);
    invalidateSubscriptionCache(studentId);
  } catch (e) {
    console.error('attachActiveSubscriptionIfAny:', e);
  }
}

// Lazy re-binding: for every active subscription of these students,
// find all NULL-subscription lessons in the validity period and attach them.
// Safe to call repeatedly — idempotent. Used when opening student card / widget
// to recover from any past attach failures.
async function rebindOrphanLessonsForStudents(studentIds) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return;
  const { data: subs } = await db.from('subscriptions')
    .select('id, student_id, teacher_id, start_date, end_date, subject_id')
    .in('student_id', studentIds)
    .eq('status', 'active');

  for (const sub of (subs || [])) {
    const startIso = sub.start_date + 'T00:00:00';
    const endIso = sub.end_date + 'T23:59:59';
    const { data: orphans } = await db.from('lesson_students')
      .select('lesson_id, subject_id, lesson:lessons(id, teacher_id, start_time)')
      .eq('student_id', sub.student_id)
      .is('subscription_id', null);

    // Subject gate — same rules as attachLessonsToSubscription (see there).
    const subjectMatches = (linkSubjectId) => {
      if (!sub.subject_id) return true;
      if (!linkSubjectId) return false;
      return linkSubjectId === sub.subject_id;
    };

    const targetIds = (orphans || [])
      .filter(r => r.lesson && r.lesson.teacher_id === sub.teacher_id)
      .filter(r => r.lesson.start_time >= startIso && r.lesson.start_time <= endIso)
      .filter(r => subjectMatches(r.subject_id))
      .map(r => r.lesson_id);
    if (targetIds.length === 0) continue;
    await db.from('lesson_students')
      .update({ subscription_id: sub.id })
      .in('lesson_id', targetIds)
      .eq('student_id', sub.student_id);
    await recomputeSubscriptionUsage(sub.id);
  }
}

// Find lessons of this student in the period (start_date..end_date) that have
// no subscription bound yet and bind them. Called right after activation.
async function attachLessonsToSubscription(subscriptionId, studentId, startDateObj) {
  const { data: sub } = await db.from('subscriptions')
    .select('end_date, teacher_id, subject_id')
    .eq('id', subscriptionId).single();
  if (!sub) return;
  const endIso = sub.end_date + 'T23:59:59';
  const startIso = formatDate(startDateObj) + 'T00:00:00';

  // Read subject_id straight from the junction row rather than translating
  // lesson.subject (text) — the junction is now the source of truth.
  const { data: ls } = await db.from('lesson_students')
    .select('lesson_id, subscription_id, subject_id, lesson:lessons(id, teacher_id, start_time, status)')
    .eq('student_id', studentId)
    .is('subscription_id', null);

  const subjectMatches = (linkSubjectId) => {
    if (!sub.subject_id) return true; // legacy sub — attach anything
    if (!linkSubjectId) return false; // sub is bound to a subject, link has none — skip
    return linkSubjectId === sub.subject_id;
  };

  const targetIds = (ls || [])
    .filter(r => r.lesson && r.lesson.teacher_id === sub.teacher_id)
    .filter(r => r.lesson.start_time >= startIso && r.lesson.start_time <= endIso)
    .filter(r => subjectMatches(r.subject_id))
    .map(r => r.lesson_id);

  if (targetIds.length === 0) return;
  await db.from('lesson_students')
    .update({ subscription_id: subscriptionId })
    .in('lesson_id', targetIds)
    .eq('student_id', studentId);
}

// --- Usage recomputation ---

// Recomputes used_lessons and transfers_used for a single subscription.
// Also lazily expires it if end_date is in the past (sets status='expired').
//
// Used_lessons counts:
//   - active past lessons attached to this subscription, AND
//   - paid cancellations (is_paid=true) of subscription's students within validity period,
//     EXCLUDING those with valid_reason=true (these are forgiven and don't consume slots).
//
// Transfers_used counts lessons attached to this subscription whose (day_of_week, time)
// do NOT match any recurring template of this student at this teacher. If the student
// has no recurring template at all, transfers counter stays at 0 (no baseline to compare).
async function recomputeSubscriptionUsage(subscriptionId) {
  try {
    const { data: sub } = await db.from('subscriptions')
      .select('id, student_id, teacher_id, start_date, end_date, status, total_lessons, used_lessons, transfers_used')
      .eq('id', subscriptionId).single();
    if (!sub) return;

    // Snapshot the OLD "remaining" before recompute, so we can detect a
    // transition into the 1-left state and fire push exactly once. If the
    // function runs again with no change to used/transfers, oldRemaining and
    // newRemaining will both be 1, and the transition guard ("old > 1")
    // prevents duplicate sends.
    const oldRemaining = sub.total_lessons - (sub.used_lessons || 0) - (sub.transfers_used || 0);

    // Today in YYYY-MM-DD — used below to derive the new status of the sub
    // (completed / expired / active) after we recompute used_lessons and
    // transfers_used against the actual lessons + cancellations.
    const todayStr = formatDate(new Date());

    // Lessons attached to this subscription
    const { data: links } = await db.from('lesson_students')
      .select('student_id, lesson:lessons(id, status, start_time, end_time)')
      .eq('subscription_id', subscriptionId);

    const now = new Date().toISOString();
    let used = 0;
    const lessonsForTransferCalc = [];
    (links || []).forEach(r => {
      if (!r.lesson) return;
      if (r.lesson.status === 'active' && r.lesson.end_time < now) used++;
      // Collect all attached lessons (active or any) to compare with recurring schedule
      if (r.lesson.status === 'active') {
        lessonsForTransferCalc.push(r.lesson);
      }
    });

    // Late cancellations within validity that consume a slot (paid AND not "valid reason")
    const startIso = sub.start_date + 'T00:00:00';
    const endIso = sub.end_date + 'T23:59:59';
    const { data: cancellations } = await db.from('cancellations')
      .select('id, lesson_start_time, is_paid, valid_reason')
      .eq('student_id', sub.student_id)
      .eq('is_paid', true)
      .gte('lesson_start_time', startIso)
      .lte('lesson_start_time', endIso);
    const cancelledPaid = (cancellations || []).filter(c => c.valid_reason !== true);
    used += cancelledPaid.length;

    // Transfers count: load recurring templates for this student at this teacher.
    // A lesson is a "transfer" if its (day_of_week, start HH:MM) does not match any template.
    const { data: recLinks } = await db.from('recurring_lesson_students')
      .select('recurring_lesson:recurring_lessons(day_of_week, start_time, teacher_id)')
      .eq('student_id', sub.student_id);
    const templates = (recLinks || [])
      .map(r => r.recurring_lesson)
      .filter(rl => rl && rl.teacher_id === sub.teacher_id);

    let transfers = 0;
    if (templates.length > 0) {
      const templateKeys = new Set(templates.map(rl => {
        const sp = rl.start_time.split(':');
        return `${rl.day_of_week}-${+sp[0]}:${(+sp[1]).toString().padStart(2, '0')}`;
      }));
      lessonsForTransferCalc.forEach(l => {
        const d = new Date(l.start_time);
        const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // Mon=0..Sun=6 to match recurring schema
        const key = `${dow}-${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
        if (!templateKeys.has(key)) transfers++;
      });
    }
    // If no templates — transfers stays at 0 (no baseline to compare).

    // Cap used at total_lessons. `used` counts every lesson_students row
    // attached to this subscription that has already been conducted (plus paid
    // late cancellations). Sometimes more rows attach than the subscription
    // has slots for — extra ones from recurring materialisation or manual
    // admin adjustment. A subscription physically can't consume more slots
    // than it has, so we clamp here. Without this the UI shows nonsense
    // ("6 из 4 · осталось 0") and the sub can appear "active" forever.
    if (used > sub.total_lessons) used = sub.total_lessons;

    await db.from('subscriptions').update({
      used_lessons: used,
      transfers_used: transfers
    }).eq('id', subscriptionId);

    // ===== Recompute status =====
    // Full derived status, not a one-way lazy transition. Symmetric so that
    // reversing a change (cancelling a lesson that pushed used to total, or
    // extending end_date past today) naturally moves the sub back to 'active'.
    // 'refunded' is a terminal, teacher-driven state — never touched here.
    //
    // Priority: completed > expired > active. If the student used all lessons,
    // it's a success even if the calendar deadline also passed — no reason to
    // display it as "expired".
    //
    // NB: `transfers` is a SUBSET of `used` (every transfer-lesson is also a
    // used-lesson), so the completion check is just `used >= total`, not
    // `used + transfers >= total` — the latter double-counts.
    if (sub.status !== 'refunded') {
      let newStatus;
      if (used >= sub.total_lessons) {
        newStatus = 'completed';
      } else if (sub.end_date < todayStr) {
        newStatus = 'expired';
      } else {
        newStatus = 'active';
      }
      if (newStatus !== sub.status) {
        await db.from('subscriptions').update({ status: newStatus }).eq('id', subscriptionId);
        sub.status = newStatus;
      }
    }

    // Push when the subscription transitions to exactly 1 lesson left.
    // Mirror the AM rule: notify BOTH the student and the teacher. Skip if
    // status isn't 'active' (expired/refunded subs shouldn't ping) and skip
    // if oldRemaining was already <=1 (avoids re-pinging on idempotent
    // recomputes that don't actually move the count).
    const newRemaining = sub.total_lessons - used - transfers;
    if (sub.status === 'active' && newRemaining === 1 && oldRemaining > 1) {
      const { data: studentRec } = await db.from('students')
        .select('profile_id, first_name, last_name')
        .eq('id', sub.student_id).maybeSingle();
      const userIds = [sub.teacher_id];
      // students.profile_id is null for kids without their own account — only
      // push to the student if they have a linked profile (= a user account).
      if (studentRec && studentRec.profile_id) userIds.push(studentRec.profile_id);
      const studName = studentRec ? `${studentRec.first_name} ${studentRec.last_name}`.trim() : 'Ученик';
      if (typeof sendPush === 'function') {
        sendPush(userIds, {
          title: 'Абонемент скоро закончится',
          body: `${studName} — остался 1 урок`,
          tag: `sub-low-${sub.id}`,
        });
      }
    }

    invalidateSubscriptionCache(sub.student_id);
  } catch (e) {
    console.error('recomputeSubscriptionUsage:', e);
  }
}

// Convenience: recompute by lesson_id (find all subs touched and update each).
async function recomputeSubscriptionsByLesson(lessonId) {
  const { data: links } = await db.from('lesson_students')
    .select('subscription_id').eq('lesson_id', lessonId);
  const ids = new Set();
  (links || []).forEach(r => { if (r.subscription_id) ids.add(r.subscription_id); });
  for (const id of ids) await recomputeSubscriptionUsage(id);
}

// Convenience: recompute by student_id (used when cancellation status changes).
async function recomputeSubscriptionsByStudent(studentId) {
  const { data: subs } = await db.from('subscriptions')
    .select('id').eq('student_id', studentId).eq('status', 'active');
  for (const r of (subs || [])) await recomputeSubscriptionUsage(r.id);
}

// Recompute all active subscriptions linked to a list of student IDs.
// Called before showing the subscription panel/widget — guarantees the displayed
// progress reflects the current state of lessons (no stale used_lessons).
async function recomputeSubscriptionsForStudents(studentIds) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return;
  const { data: subs } = await db.from('subscriptions')
    .select('id').in('student_id', studentIds).eq('status', 'active');
  for (const r of (subs || [])) await recomputeSubscriptionUsage(r.id);
}

// --- UI helpers ---

function renderSubscriptionPanelHTML(sub, studentId) {
  if (!sub) {
    return `<div class="sub-panel sub-panel-empty">
      <div class="sub-empty-text">У ученика нет активного абонемента. Оплата идёт по разовому тарифу.</div>
      <button class="btn-primary btn-sm" id="btn-activate-sub" data-student-id="${studentId}">Активировать абонемент</button>
    </div>`;
  }
  const isExpired = sub.status === 'expired';
  const isRefunded = sub.status === 'refunded';
  const isCompleted = sub.status === 'completed';
  const total = sub.total_lessons;
  const used = sub.used_lessons || 0;
  const remaining = Math.max(0, total - used);
  const pct = Math.min(100, Math.round((used / total) * 100));
  const fmt = (d) => {
    const dt = new Date(d);
    return `${dt.getDate().toString().padStart(2,'0')}.${(dt.getMonth()+1).toString().padStart(2,'0')}.${dt.getFullYear()}`;
  };
  const transfersTotal = sub.total_transfers;
  const transfersUsed = sub.transfers_used || 0;
  const transfersLeft = Math.max(0, transfersTotal - transfersUsed);
  const transfersWarning = transfersLeft === 0;
  const dur = sub.pricing?.duration_minutes;
  const durLabel = dur ? formatTierLabel(dur, sub.pricing?.is_individual) : '';
  // Subject chip: shown in the panel head so it's immediately clear WHICH
  // subject this subscription covers. Falls back gracefully for legacy subs
  // (subject_id = NULL, no subject joined).
  const subjectName = sub.subject?.name || null;
  const subjectChip = subjectName
    ? `<span class="sub-panel-subject">${escapeHtml(subjectName)}</span>`
    : '';

  if (isRefunded) {
    return `<div class="sub-panel sub-panel-refunded">
      <div class="sub-panel-head">
        <span class="sub-badge sub-badge-refunded">Возврат оформлен</span>
        ${subjectChip}
        <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
        <span class="sub-panel-amount">${sub.paid_amount} ₽ <span class="sub-refund-tag">после пересчёта</span></span>
        <button class="sub-panel-delete" id="btn-delete-sub" data-sub-id="${sub.id}" title="Удалить запись">✕</button>
      </div>
      <div class="sub-panel-meta">
        <span>Закрыт с возвратом ${sub.refund_amount || 0} ₽ ученику</span>
        <span>Засчитано занятий: ${used}</span>
      </div>
      <div class="sub-empty-text" style="margin-top:8px">Можно активировать новый абонемент.</div>
      <button class="btn-primary btn-sm" id="btn-activate-sub" data-student-id="${studentId}" style="align-self:flex-start">Активировать новый</button>
    </div>`;
  }

  if (isExpired) {
    const burned = Math.max(0, total - used);
    return `<div class="sub-panel sub-panel-expired">
      <div class="sub-panel-head">
        <span class="sub-badge sub-badge-expired">Истёк</span>
        ${subjectChip}
        <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
        <span class="sub-panel-amount">${sub.paid_amount} ₽</span>
        <button class="sub-panel-refund" id="btn-refund-sub" data-sub-id="${sub.id}" title="Закрыть с возвратом">⤺</button>
        <button class="sub-panel-delete" id="btn-delete-sub" data-sub-id="${sub.id}" title="Удалить абонемент">✕</button>
      </div>
      <div class="sub-progress-wrap">
        <div class="sub-progress-bar sub-progress-bar-muted"><div class="sub-progress-fill sub-progress-fill-muted" style="width:${pct}%"></div></div>
        <div class="sub-progress-label">Проведено ${used} из ${total}${burned > 0 ? ` · сгорело ${burned}` : ''}</div>
      </div>
      <div class="sub-panel-meta">
        <span>Срок действия истёк: ${fmt(sub.end_date)}</span>
      </div>
      <div class="sub-empty-text" style="margin-top:8px">Для продолжения занятий по абонементу — активируйте новый.</div>
      <button class="btn-primary btn-sm" id="btn-activate-sub" data-student-id="${studentId}" style="align-self:flex-start">Активировать новый</button>
    </div>`;
  }

  if (isCompleted) {
    // Абонемент завершён «положительно» — все занятия проведены (с учётом переносов).
    // Визуально переиспользуем стили expired-панели (тот же приглушённый вид),
    // но бейдж и подпись другие: это НЕ провал, а успешное использование.
    return `<div class="sub-panel sub-panel-expired">
      <div class="sub-panel-head">
        <span class="sub-badge sub-badge-expired">Завершён</span>
        ${subjectChip}
        <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
        <span class="sub-panel-amount">${sub.paid_amount} ₽</span>
        <button class="sub-panel-delete" id="btn-delete-sub" data-sub-id="${sub.id}" title="Удалить абонемент">✕</button>
      </div>
      <div class="sub-progress-wrap">
        <div class="sub-progress-bar sub-progress-bar-muted"><div class="sub-progress-fill sub-progress-fill-muted" style="width:100%"></div></div>
        <div class="sub-progress-label">Проведено ${used} из ${total}${transfersUsed > 0 ? ` · переносов ${transfersUsed}` : ''}</div>
      </div>
      <div class="sub-panel-meta">
        <span>Все занятия проведены</span>
      </div>
      <div class="sub-empty-text" style="margin-top:8px">Для продолжения занятий по абонементу — активируйте новый.</div>
      <button class="btn-primary btn-sm" id="btn-activate-sub" data-student-id="${studentId}" style="align-self:flex-start">Активировать новый</button>
    </div>`;
  }

  return `<div class="sub-panel sub-panel-active">
    <div class="sub-panel-head">
      <span class="sub-badge sub-badge-active">Абонемент</span>
      ${subjectChip}
      <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
      <span class="sub-panel-amount">${sub.paid_amount} ₽</span>
      <button class="sub-panel-refund" id="btn-refund-sub" data-sub-id="${sub.id}" title="Закрыть с возвратом">⤺</button>
      <button class="sub-panel-delete" id="btn-delete-sub" data-sub-id="${sub.id}" title="Удалить абонемент">✕</button>
    </div>
    <div class="sub-progress-wrap">
      <div class="sub-progress-bar"><div class="sub-progress-fill" style="width:${pct}%"></div></div>
      <div class="sub-progress-label">${used} из ${total} · осталось ${remaining}</div>
    </div>
    <div class="sub-panel-meta">
      <span>Действует: ${fmt(sub.start_date)} — ${fmt(sub.end_date)}</span>
      <span class="${transfersWarning ? 'sub-meta-warn' : ''}">Переносов: ${transfersUsed} / ${transfersTotal}</span>
    </div>
  </div>`;
}

// formatDate is defined in schedule.js or similar (yyyy-mm-dd). Provide a safe fallback.
if (typeof formatDate !== 'function') {
  // eslint-disable-next-line no-var
  var formatDate = function (d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getFullYear();
    const m = (dt.getMonth() + 1).toString().padStart(2, '0');
    const day = dt.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
}

// ===== REFUND (closing subscription with refund) =====

let refundCtx = null;

async function openSubscriptionRefund(subscriptionId) {
  const { data: sub, error } = await db.from('subscriptions')
    .select('*, student:students(first_name, last_name, is_individual, is_online, price_type), pricing:pricing_id(duration_minutes, is_individual, is_online, format)')
    .eq('id', subscriptionId).single();
  if (error || !sub) { showToast('Не удалось загрузить абонемент', 'error'); return; }
  if (sub.status === 'refunded') { showToast('Этот абонемент уже закрыт с возвратом', 'error'); return; }

  // Recompute first so used_lessons reflects the current state
  await recomputeSubscriptionUsage(subscriptionId);
  // Reload after recompute
  const { data: refreshed } = await db.from('subscriptions')
    .select('*, student:students(first_name, last_name, is_individual, is_online, price_type), pricing:pricing_id(duration_minutes, is_individual, is_online, format)')
    .eq('id', subscriptionId).single();
  const subFresh = refreshed || sub;

  // Find single-tariff price for this student/lesson format
  const dur = subFresh.pricing?.duration_minutes;
  const isInd = subFresh.pricing?.is_individual ?? subFresh.student?.is_individual ?? false;
  const isOnline = subFresh.pricing?.is_online ?? subFresh.student?.is_online ?? false;
  const priceType = subFresh.student?.price_type || 'new';
  const singlePrice = findPricing(dur, isInd, priceType, isOnline, 'single');
  if (!singlePrice) {
    showToast('Не найден разовый тариф для пересчёта. Заведите его в админке.', 'error');
    return;
  }

  refundCtx = {
    sub: subFresh,
    singlePrice,
    studentName: `${subFresh.student?.first_name || ''} ${subFresh.student?.last_name || ''}`.trim()
  };

  // Render summary block
  const fmt = (d) => {
    const dt = new Date(d);
    return `${dt.getDate().toString().padStart(2,'0')}.${(dt.getMonth()+1).toString().padStart(2,'0')}.${dt.getFullYear()}`;
  };
  const hStr = dur === 90 ? '1,5 ч' : dur === 120 ? '2 ч' : dur === 180 ? '3 ч' : `${dur} мин`;
  document.getElementById('sub-refund-summary').innerHTML = `
    <div class="sub-refund-row"><span class="sub-refund-label">Ученик:</span><span class="sub-refund-value">${escapeHtml(refundCtx.studentName)}</span></div>
    <div class="sub-refund-row"><span class="sub-refund-label">Абонемент:</span><span class="sub-refund-value">${subFresh.total_lessons} занятий · ${hStr}${isOnline ? ' · онлайн' : ''}${isInd && !isOnline ? ' · индивидуальное' : ''}</span></div>
    <div class="sub-refund-row"><span class="sub-refund-label">Срок:</span><span class="sub-refund-value">${fmt(subFresh.start_date)} — ${fmt(subFresh.end_date)}</span></div>
    <div class="sub-refund-row"><span class="sub-refund-label">Оплачено:</span><span class="sub-refund-value"><b>${subFresh.paid_amount} ₽</b></span></div>
  `;

  // Default used = current used_lessons. Cap at total_lessons.
  const defaultUsed = Math.min(subFresh.used_lessons || 0, subFresh.total_lessons);
  const usedInput = document.getElementById('sub-refund-used');
  usedInput.value = defaultUsed;
  usedInput.max = subFresh.total_lessons;

  refreshRefundCalc();
  usedInput.oninput = refreshRefundCalc;

  document.getElementById('subscription-refund-overlay').classList.add('active');
  markPristine('subscription-refund-overlay');
}

function closeSubscriptionRefund() {
  guardClose('subscription-refund-overlay', () => {
    document.getElementById('subscription-refund-overlay').classList.remove('active');
    refundCtx = null;
  });
}

// Round refund up to multiples of 50 — center pays human-friendly amounts in cash
function roundRefundUp50(n) {
  if (n <= 0) return 0;
  return Math.ceil(n / 50) * 50;
}

function refreshRefundCalc() {
  if (!refundCtx) return;
  const sub = refundCtx.sub;
  const sp = refundCtx.singlePrice;
  const usedRaw = parseInt(document.getElementById('sub-refund-used').value);
  const used = Math.max(0, Math.min(isNaN(usedRaw) ? 0 : usedRaw, sub.total_lessons));

  // What the student "really paid" after refund: used × single tariff
  const newPaidExact = used * sp.student_price;
  const newTeacher = used * sp.teacher_profit;
  const newCenter = used * sp.commission;

  // Raw refund and rounded-up to multiples of 50
  const refundExact = sub.paid_amount - newPaidExact;
  const refund = roundRefundUp50(refundExact);
  // Adjust effective paid (after rounding the refund up, slightly less stays in the system)
  const effectivePaid = sub.paid_amount - refund;

  // Splits of refund between teacher and center, by single-tariff proportion
  // Round center part up to multiples of 50; teacher keeps the remainder (so the sum
  // still equals the displayed total refund).
  const teacherRatio = sp.student_price > 0 ? sp.teacher_profit / sp.student_price : 0;
  const rawCenter = refund * (1 - teacherRatio);
  let refundFromCenter = Math.ceil(rawCenter / 50) * 50;
  if (refundFromCenter > refund) refundFromCenter = refund;
  const refundFromTeacher = refund - refundFromCenter;

  const calc = document.getElementById('sub-refund-calc');
  const roundedNote = refund !== refundExact
    ? `<div class="sub-refund-row sub-refund-row-sub"><span>округлено вверх до 50 ₽ (было ${refundExact} ₽)</span><span></span></div>`
    : '';
  calc.innerHTML = `
    <div class="sub-refund-section">
      <div class="sub-refund-section-title">Пересчёт по разовой цене</div>
      <div class="sub-refund-row"><span>${used} × ${sp.student_price} ₽</span><span><b>${newPaidExact} ₽</b></span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>├─ Преподавателю: ${used} × ${sp.teacher_profit}</span><span>${newTeacher} ₽</span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>└─ Центру: ${used} × ${sp.commission}</span><span>${newCenter} ₽</span></div>
    </div>
    <div class="sub-refund-section sub-refund-section-total">
      <div class="sub-refund-row"><span class="sub-refund-label-strong">К возврату ученику</span><span class="sub-refund-amount-big">${refund} ₽</span></div>
      ${roundedNote}
      <div class="sub-refund-row sub-refund-row-sub"><span>├─ Из доли преподавателя</span><span>${refundFromTeacher} ₽</span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>└─ Из доли центра</span><span>${refundFromCenter} ₽</span></div>
    </div>
    ${refundExact < 0 ? '<div class="sub-refund-warning">Возврат отрицательный — ученик использовал больше слотов, чем мог. Проверьте число пройденных занятий.</div>' : ''}
  `;

  refundCtx.calc = { used, refund, effectivePaid, refundFromTeacher, refundFromCenter };

  document.getElementById('btn-confirm-sub-refund').disabled = refundExact < 0;
}

async function confirmSubscriptionRefund() {
  if (!refundCtx || !refundCtx.calc) return;
  const { sub, calc } = refundCtx;
  const { used, refund } = calc;

  const btn = document.getElementById('btn-confirm-sub-refund');
  btn.disabled = true;

  try {
    // We keep original paid_amount / teacher_share / center_share as they were at the sale.
    // Only mark the subscription as refunded and record how much was returned.
    // This way payroll historical weeks remain consistent — the sale-week numbers don't change.
    const { error } = await db.from('subscriptions').update({
      status: 'refunded',
      used_lessons: used,
      refund_amount: refund,
      refunded_at: new Date().toISOString()
    }).eq('id', sub.id);
    if (error) throw error;

    invalidateSubscriptionCache(sub.student_id);
    markPristine('subscription-refund-overlay');
    closeSubscriptionRefund();
    showToast(`Возврат оформлен: ${refund} ₽ ученику`, 'success');

    if (typeof openStudentDetail === 'function') {
      const studentDetailEl = document.getElementById('student-detail-overlay');
      if (studentDetailEl && studentDetailEl.classList.contains('active')) {
        await openStudentDetail(sub.student_id);
      }
    }
  } catch (e) {
    console.error('confirmSubscriptionRefund:', e);
    showToast('Ошибка: ' + (e.message || 'неизвестно'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Init ---

function initSubscriptions() {
  document.getElementById('btn-close-sub-act').addEventListener('click', closeSubscriptionActivation);
  document.getElementById('btn-cancel-sub-act').addEventListener('click', closeSubscriptionActivation);
  document.getElementById('btn-sub-act-confirm').addEventListener('click', confirmSubscriptionActivation);
  document.getElementById('subscription-activation-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSubscriptionActivation();
  });

  // Refund modal
  document.getElementById('btn-close-sub-refund').addEventListener('click', closeSubscriptionRefund);
  document.getElementById('btn-cancel-sub-refund').addEventListener('click', closeSubscriptionRefund);
  document.getElementById('btn-confirm-sub-refund').addEventListener('click', confirmSubscriptionRefund);
  document.getElementById('subscription-refund-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSubscriptionRefund();
  });
}
