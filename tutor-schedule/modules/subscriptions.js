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
  // Try active first
  const { data: active } = await db.from('subscriptions')
    .select('*, pricing:pricing_id(duration_minutes, is_individual, is_online, format, student_price, teacher_profit, commission)')
    .eq('student_id', studentId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) {
    activeSubscriptionsCache[studentId] = active;
    return active;
  }
  // Fallback: most recent non-active (expired or refunded) — to show context in UI
  const { data: other } = await db.from('subscriptions')
    .select('*, pricing:pricing_id(duration_minutes, is_individual, is_online, format, student_price, teacher_profit, commission)')
    .eq('student_id', studentId)
    .in('status', ['expired', 'refunded'])
    .order('end_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  activeSubscriptionsCache[studentId] = other || null;
  return other || null;
}

function invalidateSubscriptionCache(studentId) {
  if (studentId) delete activeSubscriptionsCache[studentId];
  else activeSubscriptionsCache = {};
}

// --- Activation ---

let activationCtx = null; // { studentId, student, options }

async function openSubscriptionActivation(studentId) {
  const { data: student } = await db.from('students')
    .select('id, first_name, last_name, subject, is_individual, is_online, price_type')
    .eq('id', studentId).single();
  if (!student) { showToast('Ученик не найден', 'error'); return; }

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

  activationCtx = { studentId, student, options };

  document.getElementById('sub-act-student').textContent = `${student.first_name} ${student.last_name}`;
  document.getElementById('sub-act-subject').textContent = student.subject || '—';
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
          <span>Стоимость: <b>${o.student_price} ₽</b></span>
          <span>Преподавателю: <b>${o.teacher_profit} ₽</b></span>
          <span>Центру: <b>${o.commission} ₽</b></span>
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
  document.getElementById('subscription-activation-overlay').classList.remove('active');
  activationCtx = null;
}

async function confirmSubscriptionActivation() {
  if (!activationCtx) return;
  const pickedRadio = document.querySelector('input[name="sub-act-format"]:checked');
  if (!pickedRadio) { showToast('Выберите тип абонемента', 'error'); return; }
  const pricing = activationCtx.options.find(o => o.id === pickedRadio.value);
  if (!pricing) return;

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

    invalidateSubscriptionCache(activationCtx.studentId);
    const sid = activationCtx.studentId; // snapshot before close clears the context
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

// Call this after inserting a lesson_students row.
// If the student has an ACTIVE subscription with this teacher AND the lesson falls
// within its validity period — attach. Direct query, no cache, no fallback to expired.
async function attachActiveSubscriptionIfAny(lessonId, studentId, teacherId) {
  try {
    const { data: sub } = await db.from('subscriptions')
      .select('id, status, teacher_id, start_date, end_date')
      .eq('student_id', studentId)
      .eq('teacher_id', teacherId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sub) return;

    const { data: lesson } = await db.from('lessons')
      .select('start_time').eq('id', lessonId).maybeSingle();
    if (!lesson) return;
    const ls = new Date(lesson.start_time);
    const e = new Date(sub.end_date);
    e.setHours(23, 59, 59, 999);
    if (ls < new Date(sub.start_date) || ls > e) return;

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
    .select('id, student_id, teacher_id, start_date, end_date')
    .in('student_id', studentIds)
    .eq('status', 'active');
  for (const sub of (subs || [])) {
    const startIso = sub.start_date + 'T00:00:00';
    const endIso = sub.end_date + 'T23:59:59';
    const { data: orphans } = await db.from('lesson_students')
      .select('lesson_id, lesson:lessons(id, teacher_id, start_time)')
      .eq('student_id', sub.student_id)
      .is('subscription_id', null);
    const targetIds = (orphans || [])
      .filter(r => r.lesson && r.lesson.teacher_id === sub.teacher_id)
      .filter(r => r.lesson.start_time >= startIso && r.lesson.start_time <= endIso)
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
  const { data: sub } = await db.from('subscriptions').select('end_date, teacher_id').eq('id', subscriptionId).single();
  if (!sub) return;
  const endIso = sub.end_date + 'T23:59:59';
  const startIso = formatDate(startDateObj) + 'T00:00:00';

  // Lessons of this student at this teacher in date window
  const { data: ls } = await db.from('lesson_students')
    .select('lesson_id, subscription_id, lesson:lessons(id, teacher_id, start_time, status)')
    .eq('student_id', studentId)
    .is('subscription_id', null);
  const targetIds = (ls || [])
    .filter(r => r.lesson && r.lesson.teacher_id === sub.teacher_id)
    .filter(r => r.lesson.start_time >= startIso && r.lesson.start_time <= endIso)
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
      .select('id, student_id, teacher_id, start_date, end_date, status, total_lessons')
      .eq('id', subscriptionId).single();
    if (!sub) return;

    // Lazy expiry: if active but past end_date — mark as expired.
    const todayStr = formatDate(new Date());
    if (sub.status === 'active' && sub.end_date < todayStr) {
      await db.from('subscriptions').update({ status: 'expired' }).eq('id', subscriptionId);
      sub.status = 'expired';
    }

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

    await db.from('subscriptions').update({
      used_lessons: used,
      transfers_used: transfers
    }).eq('id', subscriptionId);

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

  if (isRefunded) {
    return `<div class="sub-panel sub-panel-refunded">
      <div class="sub-panel-head">
        <span class="sub-badge sub-badge-refunded">Возврат оформлен</span>
        <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
        <span class="sub-panel-amount">${sub.paid_amount} ₽ <span class="sub-refund-tag">после пересчёта</span></span>
        <button class="sub-panel-delete" id="btn-delete-sub" data-sub-id="${sub.id}" title="Удалить запись">✕</button>
      </div>
      <div class="sub-panel-meta">
        <span>Закрыт с возвратом ${sub.refund_amount || 0} ₽ ученику</span>
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
        <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
        <span class="sub-panel-amount">${sub.paid_amount} ₽</span>
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

  return `<div class="sub-panel sub-panel-active">
    <div class="sub-panel-head">
      <span class="sub-badge sub-badge-active">Абонемент</span>
      <span class="sub-panel-type">${total} занятий${durLabel ? ' · ' + durLabel : ''}</span>
      <span class="sub-panel-amount">${sub.paid_amount} ₽</span>
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
    <div class="sub-refund-row"><span class="sub-refund-label">Ученик:</span><span class="sub-refund-value">${refundCtx.studentName}</span></div>
    <div class="sub-refund-row"><span class="sub-refund-label">Абонемент:</span><span class="sub-refund-value">${subFresh.total_lessons} занятий · ${hStr}${isOnline ? ' · онлайн' : ''}${isInd && !isOnline ? ' · индивидуальное' : ''}</span></div>
    <div class="sub-refund-row"><span class="sub-refund-label">Срок:</span><span class="sub-refund-value">${fmt(subFresh.start_date)} — ${fmt(subFresh.end_date)}</span></div>
    <div class="sub-refund-row"><span class="sub-refund-label">Оплачено:</span><span class="sub-refund-value"><b>${subFresh.paid_amount} ₽</b></span></div>
  `;

  // Default used = current used_lessons. Cap at total_lessons.
  const defaultUsed = Math.min(subFresh.used_lessons || 0, subFresh.total_lessons);
  const usedInput = document.getElementById('sub-refund-used');
  usedInput.value = defaultUsed;
  usedInput.max = subFresh.total_lessons;

  refreshRefundCalc();
  usedInput.oninput = refreshRefundCalc;

  document.getElementById('subscription-refund-overlay').classList.add('active');
}

function closeSubscriptionRefund() {
  document.getElementById('subscription-refund-overlay').classList.remove('active');
  refundCtx = null;
}

function refreshRefundCalc() {
  if (!refundCtx) return;
  const sub = refundCtx.sub;
  const sp = refundCtx.singlePrice;
  const usedRaw = parseInt(document.getElementById('sub-refund-used').value);
  const used = Math.max(0, Math.min(isNaN(usedRaw) ? 0 : usedRaw, sub.total_lessons));

  // Recalc by single-tariff
  const newPaid = used * sp.student_price;
  const newTeacher = used * sp.teacher_profit;
  const newCenter = used * sp.commission;

  const refund = sub.paid_amount - newPaid;
  const teacherDelta = sub.teacher_share - newTeacher;
  const centerDelta = sub.center_share - newCenter;

  const calc = document.getElementById('sub-refund-calc');
  calc.innerHTML = `
    <div class="sub-refund-section">
      <div class="sub-refund-section-title">Пересчёт по разовой цене</div>
      <div class="sub-refund-row"><span>${used} × ${sp.student_price} ₽</span><span><b>${newPaid} ₽</b></span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>├─ Преподавателю: ${used} × ${sp.teacher_profit}</span><span>${newTeacher} ₽</span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>└─ Центру: ${used} × ${sp.commission}</span><span>${newCenter} ₽</span></div>
    </div>
    <div class="sub-refund-section sub-refund-section-total">
      <div class="sub-refund-row"><span class="sub-refund-label-strong">К возврату ученику</span><span class="sub-refund-amount-big">${refund} ₽</span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>├─ Из доли преподавателя: ${sub.teacher_share} − ${newTeacher}</span><span>${teacherDelta} ₽</span></div>
      <div class="sub-refund-row sub-refund-row-sub"><span>└─ Из доли центра: ${sub.center_share} − ${newCenter}</span><span>${centerDelta} ₽</span></div>
    </div>
    ${refund < 0 ? '<div class="sub-refund-warning">Возврат отрицательный — это значит, что ученик использовал больше слотов, чем мог. Проверьте число пройденных занятий.</div>' : ''}
  `;

  // Save calculated values into ctx so confirm uses fresh numbers
  refundCtx.calc = { used, newPaid, newTeacher, newCenter, refund };

  document.getElementById('btn-confirm-sub-refund').disabled = refund < 0;
}

async function confirmSubscriptionRefund() {
  if (!refundCtx || !refundCtx.calc) return;
  const { sub, calc } = refundCtx;
  const { used, newPaid, newTeacher, newCenter, refund } = calc;

  const btn = document.getElementById('btn-confirm-sub-refund');
  btn.disabled = true;

  try {
    const { error } = await db.from('subscriptions').update({
      status: 'refunded',
      used_lessons: used,
      paid_amount: newPaid,
      teacher_share: newTeacher,
      center_share: newCenter,
      refund_amount: refund,
      refunded_at: new Date().toISOString()
    }).eq('id', sub.id);
    if (error) throw error;

    invalidateSubscriptionCache(sub.student_id);
    closeSubscriptionRefund();
    showToast(`Возврат оформлен: ${refund} ₽ ученику`, 'success');

    // Reopen student detail if open (find the student id)
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
