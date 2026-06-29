let pricingList = [];
let editingPricingId = null;
let currentPayrollOffset = 0;

// ===== PRICING CRUD =====

let pricingFreshlyLoaded = false;

async function loadPricing() {
  const isFreshLoad = !pricingFreshlyLoaded;
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('pricing') : null;
    if (cached && Array.isArray(cached)) pricingList = cached;
  }
  const { data, error } = await db.from('pricing').select('*').eq('active', true).order('is_individual').order('duration_minutes').order('price_type');
  if (error) return;
  pricingList = data || [];
  if (typeof cacheSet === 'function') cacheSet('pricing', pricingList);
  pricingFreshlyLoaded = true;
}

function formatTierLabel(duration, isIndividual) {
  const h = duration / 60;
  const hStr = h === Math.floor(h) ? `${h} ч` : `${h.toString().replace('.', ',')} ч`;
  return isIndividual ? `${hStr} (Инд.)` : hStr;
}

function findPricing(duration, isIndividual, priceType, isOnline, format) {
  format = format || 'single';
  if (isOnline) {
    const online = pricingList.find(p => p.is_online === true && p.duration_minutes === duration && p.price_type === priceType && (p.format || 'single') === format);
    if (online) return online;
    return pricingList.find(p => p.is_individual === true && p.duration_minutes === duration && p.price_type === priceType && (p.format || 'single') === format);
  }
  return pricingList.find(p => !p.is_online && p.duration_minutes === duration && p.is_individual === isIndividual && p.price_type === priceType && (p.format || 'single') === format);
}

// Returns all subscription pricing options (sub4/sub8) for a student's profile.
// Used in the activation form.
function listSubscriptionOptions(durationMinutes, isIndividual, priceType, isOnline) {
  return pricingList.filter(p =>
    p.duration_minutes === durationMinutes &&
    p.price_type === priceType &&
    (isOnline ? p.is_online === true : (!p.is_online && p.is_individual === isIndividual)) &&
    (p.format === 'sub4' || p.format === 'sub8')
  );
}

function hasAnyPricingForDuration(duration) {
  return pricingList.some(p => p.duration_minutes === duration);
}

// ===== ADMIN PRICING MANAGEMENT =====

async function loadPricingAdmin() {
  const { data } = await db.from('pricing').select('*').order('is_individual').order('duration_minutes').order('price_type');
  renderPricingAdmin(data || []);
}

function renderPricingAdmin(pricing) {
  const list = document.getElementById('pricing-list');
  if (!list) return;
  if (pricing.length === 0) {
    list.innerHTML = '<div class="admin-empty">Нет тарифов</div>';
    return;
  }

  // Two top-level groups by format: single (Разовые) and subscription (Абонементы)
  const singles = pricing.filter(p => (p.format || 'single') === 'single');
  const subs = pricing.filter(p => p.format === 'sub4' || p.format === 'sub8');

  const groupBy = (rows) => {
    const g = { group_new: [], group_old: [], ind_new: [], ind_old: [], online_new: [], online_old: [] };
    rows.forEach(p => {
      const t = p.is_online ? 'online' : (p.is_individual ? 'ind' : 'group');
      const key = `${t}_${p.price_type}`;
      if (g[key]) g[key].push(p);
    });
    return g;
  };

  const sectionTitles = [
    { key: 'group_new', title: 'Групповые · Новые цены' },
    { key: 'group_old', title: 'Групповые · Старые цены' },
    { key: 'ind_new',   title: 'Индивидуальные · Новые цены' },
    { key: 'ind_old',   title: 'Индивидуальные · Старые цены' },
    { key: 'online_new', title: 'Онлайн · Новые цены' },
    { key: 'online_old', title: 'Онлайн · Старые цены' }
  ];

  const formatCard = (p, isSub) => {
    const lessons = p.format === 'sub4' ? 4 : (p.format === 'sub8' ? 8 : null);
    const durLabel = formatTierLabel(p.duration_minutes, p.is_individual);
    const title = isSub ? `${durLabel} · ${lessons} занятий` : durLabel;
    return `<div class="pricing-card" data-id="${p.id}">
      <span class="pricing-duration">${title}</span>
      <span class="pricing-values">
        <span class="pv-item">${isSub ? 'Абонемент' : 'Занятие'}: <b>${p.student_price}₽</b></span>
        <span class="pv-item">Преп.: <b>${p.teacher_profit}₽</b></span>
        <span class="pv-item">Центр: <b>${p.commission}₽</b></span>
      </span>
      <button class="btn-edit-pricing" data-id="${p.id}" title="Редактировать">✎</button>
    </div>`;
  };

  const renderGroupedSection = (rows, isSub) => {
    if (rows.length === 0) return '';
    const grouped = groupBy(rows);
    let html = '';
    sectionTitles.forEach(sec => {
      if (grouped[sec.key].length === 0) return;
      html += `<div class="pricing-section-title">${sec.title}</div>`;
      grouped[sec.key].sort((a, b) => {
        // sort by duration, then sub4 before sub8
        if (a.duration_minutes !== b.duration_minutes) return a.duration_minutes - b.duration_minutes;
        const fa = a.format || 'single';
        const fb = b.format || 'single';
        return fa.localeCompare(fb);
      });
      grouped[sec.key].forEach(p => { html += formatCard(p, isSub); });
    });
    return html;
  };

  let html = '';
  if (singles.length > 0) {
    html += `<div class="pricing-group-header">Разовые занятия</div>`;
    html += renderGroupedSection(singles, false);
  }
  if (subs.length > 0) {
    html += `<div class="pricing-group-header">Абонементы</div>`;
    html += renderGroupedSection(subs, true);
  }
  list.innerHTML = html;

  list.querySelectorAll('.btn-edit-pricing').forEach(btn => {
    btn.addEventListener('click', () => openPricingModal(pricing.find(p => p.id === btn.dataset.id)));
  });
}

function openPricingModal(pricing = null) {
  editingPricingId = pricing ? pricing.id : null;
  document.getElementById('pricing-modal-title').textContent = pricing ? 'Редактировать тариф' : 'Добавить тариф';
  document.getElementById('pricing-duration').value = pricing?.duration_minutes || 90;
  document.getElementById('pricing-is-individual').value = pricing?.is_online ? 'online' : String(pricing?.is_individual || false);
  document.getElementById('pricing-price-type').value = pricing?.price_type || 'new';
  const fmtSel = document.getElementById('pricing-format');
  if (fmtSel) fmtSel.value = pricing?.format || 'single';
  const lbl = document.getElementById('pricing-student-price-label');
  if (lbl) lbl.textContent = (pricing?.format && pricing.format !== 'single') ? 'Цена абонемента' : 'Цена занятия';
  document.getElementById('pricing-student-price').value = pricing?.student_price || '';
  document.getElementById('pricing-teacher-profit').value = pricing?.teacher_profit || '';
  document.getElementById('pricing-commission').value = pricing?.commission || '';
  document.getElementById('btn-delete-pricing').style.display = pricing ? 'block' : 'none';
  document.getElementById('pricing-overlay').classList.add('active');
}

function closePricingModal() {
  document.getElementById('pricing-overlay').classList.remove('active');
  editingPricingId = null;
}

async function savePricing() {
  const duration = parseInt(document.getElementById('pricing-duration').value);
  const typeVal = document.getElementById('pricing-is-individual').value;
  const isIndividual = typeVal === 'true' || typeVal === 'online';
  const isOnline = typeVal === 'online';
  const priceType = document.getElementById('pricing-price-type').value;
  const format = document.getElementById('pricing-format')?.value || 'single';
  const studentPrice = parseInt(document.getElementById('pricing-student-price').value);
  const teacherProfit = parseInt(document.getElementById('pricing-teacher-profit').value);
  const commission = parseInt(document.getElementById('pricing-commission').value);

  if (!duration || duration < 30) { showToast('Укажите длительность', 'error'); return; }
  if (isNaN(studentPrice) || isNaN(teacherProfit) || isNaN(commission)) { showToast('Заполните все суммы', 'error'); return; }
  if (studentPrice < 0 || teacherProfit < 0 || commission < 0) { showToast('Суммы не могут быть отрицательными', 'error'); return; }

  const record = {
    duration_minutes: duration, is_individual: isIndividual, is_online: isOnline, price_type: priceType,
    format: format,
    student_price: studentPrice, teacher_profit: teacherProfit, commission
  };

  let error;
  if (editingPricingId) {
    ({ error } = await db.from('pricing').update(record).eq('id', editingPricingId));
  } else {
    ({ error } = await db.from('pricing').insert(record));
  }

  if (error) {
    if (error.message.includes('unique')) showToast('Такой тариф уже существует', 'error');
    else showToast('Ошибка сохранения', 'error');
    return;
  }

  closePricingModal();
  showToast('Тариф сохранён', 'success');
  await loadPricing();
  await loadPricingAdmin();
}

async function deletePricingEntry() {
  if (!editingPricingId) return;
  const id = editingPricingId; closePricingModal();
  showConfirm('Удалить тариф?', async () => {
    await db.from('pricing').delete().eq('id', id);
    showToast('Тариф удалён', 'success');
    await loadPricing();
    await loadPricingAdmin();
  });
}

// ===== PAYROLL CALCULATION =====

const payrollFreshlyLoadedWeeks = new Set();

async function loadPayroll() {
  const now = getMonday(new Date());
  const target = new Date(now);
  target.setDate(target.getDate() + currentPayrollOffset * 7);
  const ws = formatDate(target);
  const we = new Date(target); we.setDate(we.getDate() + 7);
  const wsIso = target.toISOString();
  const weIso = we.toISOString();
  const isAdmin = state.profile.role === 'admin';

  // Hydrate from cache ONLY when offline. Online users get fresh data on
  // every navigation to this tab.
  const isFreshLoad = !payrollFreshlyLoadedWeeks.has(ws);
  if (isFreshLoad && !navigator.onLine) {
    const cached = (typeof cacheGet === 'function') ? cacheGet('payroll:' + ws) : null;
    if (cached && cached.lessons) {
      renderPayroll(
        cached.lessons || [], cached.cancellations || [],
        cached.soldSubs || [], cached.refundedSubs || [],
        cached.subsById || {}, cached.isAdmin
      );
    }
  }

  let q = db.from('lessons')
    .select('id, teacher_id, start_time, end_time, status, teacher:profiles!teacher_id(full_name, color, role), lesson_students(student_id, subscription_id, student:students(first_name, last_name, is_individual, is_online, price_type))')
    .eq('week_start', ws).in('status', ['active', 'cancelled']);
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);

  // Pending cancellations this week. Includes lesson_end_time so we know lesson duration without joining lessons.
  let qc = db.from('cancellations')
    .select('id, student_id, teacher_id, lesson_start_time, lesson_end_time, is_paid, valid_reason, reason_text, reason_image_url, student:students(first_name, last_name, is_individual, is_online, price_type), teacher:profiles!teacher_id(full_name, color, role)')
    .eq('week_start', ws).eq('status', 'pending');
  if (!isAdmin) qc = qc.eq('teacher_id', state.user.id);

  // Subscriptions SOLD on this week (by created_at — matches teacher's actual cash receipt date)
  let qs = db.from('subscriptions')
    .select('id, teacher_id, student_id, total_lessons, paid_amount, teacher_share, center_share, created_at, student:students(first_name, last_name), pricing:pricing_id(duration_minutes, format, is_individual, is_online)')
    .gte('created_at', wsIso).lt('created_at', weIso);
  if (!isAdmin) qs = qs.eq('teacher_id', state.user.id);

  // Subscriptions REFUNDED on this week (by refunded_at) — they need to roll back center share
  let qr = db.from('subscriptions')
    .select('id, teacher_id, student_id, total_lessons, paid_amount, teacher_share, center_share, refund_amount, refunded_at, created_at, student:students(first_name, last_name), pricing:pricing_id(duration_minutes, format, is_individual, is_online)')
    .eq('status', 'refunded')
    .gte('refunded_at', wsIso).lt('refunded_at', weIso);
  if (!isAdmin) qr = qr.eq('teacher_id', state.user.id);

  let lessons, cancellations, soldSubs, refundedSubs;
  try {
    const res = await Promise.all([q, qc, qs, qr]);
    lessons = res[0].data; cancellations = res[1].data;
    soldSubs = res[2].data; refundedSubs = res[3].data;
  } catch (_) {
    return; // network failed; cached view (if any) stays on screen
  }

  // Collect subscription IDs referenced by lesson_students, fetch them separately.
  // We don't use a nested join above because it can silently return null due to RLS or
  // unresolved FKs, breaking the spread-profit calculation.
  const subIds = new Set();
  (lessons || []).forEach(l => (l.lesson_students || []).forEach(ls => {
    if (ls.subscription_id) subIds.add(ls.subscription_id);
  }));
  let subsById = {};
  if (subIds.size > 0) {
    const { data: subs } = await db.from('subscriptions')
      .select('id, total_lessons, paid_amount, teacher_share, center_share, status, pricing:pricing_id(duration_minutes, format, is_individual, is_online)')
      .in('id', Array.from(subIds));
    (subs || []).forEach(s => { subsById[s.id] = s; });
  }

  renderPayroll(lessons || [], cancellations || [], soldSubs || [], refundedSubs || [], subsById, isAdmin);
  // Persist this week's full input set so we can replay renderPayroll offline
  if (typeof cacheSet === 'function') {
    cacheSet('payroll:' + ws, {
      lessons: lessons || [],
      cancellations: cancellations || [],
      soldSubs: soldSubs || [],
      refundedSubs: refundedSubs || [],
      subsById,
      isAdmin
    });
  }
  payrollFreshlyLoadedWeeks.add(ws);
}

let payrollTeacherData = {};

function ensureTeacherBucket(tId, lesson, cancellation, sub, soldList) {
  if (payrollTeacherData[tId]) return payrollTeacherData[tId];
  // Try to figure out teacher info from any source
  const tInfo = lesson?.teacher || cancellation?.teacher || null;
  payrollTeacherData[tId] = {
    name: tInfo?.full_name || 'Преподаватель',
    color: tInfo?.color || '#1e6fe8',
    role: tInfo?.role,
    // One-off (single) figures
    oneOffRevenue: 0, oneOffProfit: 0, oneOffCommission: 0,
    // Subscription figures (spread per lesson; commission is full-on-sale separately)
    subProfit: 0,           // spread profit from attended subscription lessons
    subRevenue: 0,          // spread paid_amount equivalent
    soldSubsCommission: 0,  // FULL commission for subscriptions sold this week
    soldSubsRevenue: 0,     // FULL paid_amount of sold subscriptions
    soldSubsTeacherShare: 0,
    // Aggregations for UI rows
    students: {},           // one-off conducted lessons by student
    subStudents: {},        // subscription-attended lessons aggregated by student
    cancelledStudents: [],  // one-off cancellations rows (red/yellow)
    soldSubs: [],           // list of sold subscriptions this week
    cancelCount: 0
  };
  return payrollTeacherData[tId];
}

function renderPayroll(lessons, cancellations, soldSubs, refundedSubs, subsById, isAdmin) {
  const container = document.getElementById('payroll-content');
  if (!container) return;

  payrollTeacherData = {};

  // ===== 1. Active lessons (conducted) — split into one-off vs subscription =====
  lessons.forEach(lesson => {
    if (lesson.status !== 'active') return;
    const tId = lesson.teacher_id;
    const teacherRole = lesson.teacher?.role;
    const start = new Date(lesson.start_time);
    const end = new Date(lesson.end_time);
    const durationMin = Math.round((end - start) / 60000);
    const td = ensureTeacherBucket(tId, lesson);
    td.role = teacherRole;
    const isTeacherAdmin = teacherRole === 'admin';

    (lesson.lesson_students || []).forEach(ls => {
      const s = ls.student; if (!s) return;
      const sKey = ls.student_id;
      const sub = ls.subscription_id ? subsById[ls.subscription_id] : null;

      if (sub && sub.status === 'refunded') {
        // Refunded subscription — its lessons are re-valued at single-tariff (per AM rule).
        // Show in the "subscription" block but compute as one-off.
        const isInd = sub.pricing?.is_individual ?? (s.is_individual || false);
        const isOnline = sub.pricing?.is_online ?? (s.is_online || false);
        const dur = sub.pricing?.duration_minutes || durationMin;
        const sp = findPricing(dur, isInd, s.price_type || 'new', isOnline, 'single');
        if (!sp) return;
        const perProfit = isTeacherAdmin ? sp.student_price : sp.teacher_profit;
        const perRevenue = sp.student_price;
        td.subProfit += perProfit;
        td.subRevenue += perRevenue;
        const fmt = sub.pricing?.format === 'sub4' ? 4 : 8;
        if (!td.subStudents[sKey]) {
          td.subStudents[sKey] = {
            name: `${s.first_name} ${s.last_name}`, amount: 0, count: 0, subType: fmt,
            duration: sub.pricing?.duration_minutes, refunded: true
          };
        }
        // For refunded subscriptions in the payroll row show "money received after recalc"
        // — i.e. count × single-tariff price — instead of teacher's per-lesson share.
        // This matches the breakdown the admin saw in the refund modal (used × student_price).
        td.subStudents[sKey].amount += perRevenue;
        td.subStudents[sKey].count++;
      } else if (sub) {
        // Active/expired subscription lesson — spread profit across all lessons
        const total = sub.total_lessons || 8;
        const perProfit = Math.round((isTeacherAdmin ? sub.paid_amount : sub.teacher_share) / total);
        const perRevenue = Math.round(sub.paid_amount / total);
        td.subProfit += perProfit;
        td.subRevenue += perRevenue;
        const fmt = sub.pricing?.format === 'sub4' ? 4 : 8;
        if (!td.subStudents[sKey]) {
          td.subStudents[sKey] = {
            name: `${s.first_name} ${s.last_name}`,
            amount: 0,
            count: 0,
            subType: fmt,
            duration: sub.pricing?.duration_minutes
          };
        }
        td.subStudents[sKey].amount += perProfit;
        td.subStudents[sKey].count++;
      } else {
        // One-off lesson — full single-tariff
        const price = findPricing(durationMin, s.is_individual || false, s.price_type || 'new', s.is_online || false);
        if (!price) return;
        const effectiveProfit = isTeacherAdmin ? price.student_price : price.teacher_profit;
        const effectiveCommission = isTeacherAdmin ? 0 : price.commission;
        td.oneOffRevenue += price.student_price;
        td.oneOffProfit += effectiveProfit;
        td.oneOffCommission += effectiveCommission;
        if (!td.students[sKey]) {
          td.students[sKey] = { name: `${s.first_name} ${s.last_name}`, amount: 0, count: 0 };
        }
        td.students[sKey].amount += price.student_price;
        td.students[sKey].count++;
      }
    });
  });

  // ===== 2. Cancellations =====
  cancellations.forEach(c => {
    const tId = c.teacher_id;
    const td = ensureTeacherBucket(tId, null, c);
    td.cancelCount++;
    const s = c.student; if (!s) return;

    // Lesson duration straight from cancellation (no need to find the paired lesson)
    let cancelledLessonDur = null;
    if (c.lesson_start_time && c.lesson_end_time) {
      cancelledLessonDur = Math.round((new Date(c.lesson_end_time) - new Date(c.lesson_start_time)) / 60000);
    }
    // Was the cancelled lesson linked to a subscription? Look at the paired (status='cancelled') lesson.
    let cancelledLessonSubId = null;
    if (c.lesson_start_time) {
      const paired = lessons.find(l => l.teacher_id === tId && l.status === 'cancelled' && l.start_time === c.lesson_start_time);
      if (paired) {
        const ourLink = (paired.lesson_students || []).find(ls => ls.student_id === c.student_id);
        cancelledLessonSubId = ourLink?.subscription_id || null;
      }
    }

    let amount = 0;
    if (cancelledLessonSubId && subsById[cancelledLessonSubId]) {
      // Subscription-linked cancellation: amount shown is "per-lesson" spread, just for display
      const sub = subsById[cancelledLessonSubId];
      const total = sub.total_lessons || 8;
      amount = Math.round((td.role === 'admin' ? sub.paid_amount : sub.teacher_share) / total);
    } else if (cancelledLessonDur) {
      // One-off cancellation: precise tariff lookup by duration + student params
      const priceObj = findPricing(cancelledLessonDur, s.is_individual || false, s.price_type || 'new', s.is_online || false);
      if (priceObj) {
        amount = priceObj.student_price;
        // If paid AND not subscription-linked → counts as one-off income for the week
        if (c.is_paid && !c.valid_reason) {
          const isTeacherAdmin = td.role === 'admin';
          const eff = isTeacherAdmin ? priceObj.student_price : priceObj.teacher_profit;
          const com = isTeacherAdmin ? 0 : priceObj.commission;
          td.oneOffRevenue += priceObj.student_price;
          td.oneOffProfit += eff;
          td.oneOffCommission += com;
        }
      }
    }
    // Note: if duration is unknown (e.g. lesson record was deleted and cancellation has no end_time),
    // we leave amount=0 rather than guessing — better than showing a random number.

    td.cancelledStudents.push({
      cancellationId: c.id,
      teacherId: c.teacher_id,
      name: `${s.first_name} ${s.last_name}`,
      amount,
      isPaid: !!c.is_paid,
      validReason: !!c.valid_reason,
      hasReason: !!(c.reason_text || c.reason_image_url),
      fromSubscription: !!cancelledLessonSubId
    });
  });

  // ===== 3. Subscriptions sold this week =====
  // Full commission goes to center on the week of sale.
  // Teacher's share is "earned" through attendance (spread), but the actual cash was received now.
  soldSubs.forEach(sub => {
    const td = ensureTeacherBucket(sub.teacher_id);
    const lessons = sub.total_lessons || 8;
    const fmt = sub.pricing?.format === 'sub4' ? 4 : 8;
    td.soldSubsRevenue += sub.paid_amount;
    td.soldSubsCommission += sub.center_share;
    td.soldSubsTeacherShare += sub.teacher_share;
    td.soldSubs.push({
      subscriptionId: sub.id,
      studentName: sub.student ? `${sub.student.first_name} ${sub.student.last_name}` : '—',
      subType: fmt,
      duration: sub.pricing?.duration_minutes,
      paidAmount: sub.paid_amount,
      centerShare: sub.center_share,
      teacherShare: sub.teacher_share
    });
  });

  // ===== 4. Subscriptions refunded this week =====
  // We need to "roll back" the over-collected center share that was counted on the sale week.
  // After refund, sub's paid_amount/teacher_share/center_share are already the new (lower) values
  // — the difference between the originals and these is what's being returned.
  //
  // refund_amount is the total returned to the student.
  // We don't have the original center_share stored separately, but we can derive it from
  // (refund_amount * old_center_share_ratio). Instead — for the payroll display we just show
  // the refund operation and subtract the relevant portion from this week's commission.
  //
  // The exact original split is reconstructable if we know the original pricing (sub still
  // points to its pricing_id) and original total_lessons. But after refund, paid_amount/center_share
  // already point to the NEW (reduced) values. The difference between "what was originally
  // collected at sale" and "what remains as legitimate" is the refund.
  //
  // To compute the center_share delta we'd need the original. To avoid storing both, we adopt
  // a simpler rule that's still honest: at refund we display `refund_amount` total returned
  // and split it proportionally between teacher and center using the pricing's single-tariff
  // ratios. Most accurate alternative would require storing originals; we keep it simple here.
  refundedSubs.forEach(sub => {
    const td = ensureTeacherBucket(sub.teacher_id);
    const fmt = sub.pricing?.format === 'sub4' ? 4 : 8;
    const refundAmount = sub.refund_amount || 0;
    // Find single-tariff ratio for this format to split refund into teacher/center deltas
    const dur = sub.pricing?.duration_minutes;
    const isInd = sub.pricing?.is_individual ?? false;
    const isOnline = sub.pricing?.is_online ?? false;
    const sp = findPricing(dur, isInd, 'new', isOnline, 'single');
    let centerPart = 0, teacherPart = refundAmount;
    if (sp && sp.student_price > 0) {
      // Round up to multiples of 50 — center pays cash in human-friendly amounts.
      // Teacher part keeps the remainder so display sum equals total refundAmount.
      const rawCenter = refundAmount * (sp.commission / sp.student_price);
      centerPart = Math.ceil(rawCenter / 50) * 50;
      if (centerPart > refundAmount) centerPart = refundAmount;
      teacherPart = refundAmount - centerPart;
    }
    td.refundsCommission = (td.refundsCommission || 0) - centerPart; // negative, reduces this week's commission
    td.refundsTotal = (td.refundsTotal || 0) + refundAmount;
    td.refundsList = td.refundsList || [];
    td.refundsList.push({
      subscriptionId: sub.id,
      studentName: sub.student ? `${sub.student.first_name} ${sub.student.last_name}` : '—',
      subType: fmt,
      duration: dur,
      refundAmount,
      teacherPart,
      centerPart
    });
  });

  // ===== Aggregate totals on each teacher bucket =====
  Object.values(payrollTeacherData).forEach(td => {
    td.profit = td.oneOffProfit + td.subProfit;             // what teacher "earned" this week (display)
    td.commission = td.oneOffCommission + td.soldSubsCommission + (td.refundsCommission || 0); // owed to center this week (refunds reduce)
    td.revenue = td.oneOffRevenue + td.soldSubsRevenue;     // physical cash that flowed in
  });

  renderPayrollHTML(isAdmin);
}

function cancelDeclension(n) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} отмен`;
  if (last === 1) return `${n} отмена`;
  if (last >= 2 && last <= 4) return `${n} отмены`;
  return `${n} отмен`;
}

function renderPayrollHTML(isAdmin) {
  const container = document.getElementById('payroll-content');
  const teachers = Object.entries(payrollTeacherData);
  teachers.sort((a, b) => {
    if (a[0] === state.user.id) return -1;
    if (b[0] === state.user.id) return 1;
    return a[1].name.localeCompare(b[1].name);
  });

  let html = '';

  if (isAdmin) {
    html += `<div id="payroll-total" class="payroll-total"></div>`;
    if (teachers.length > 1) {
      html += `<div class="payroll-filter">`;
      teachers.forEach(([tId, data]) => {
        html += `<button class="payroll-filter-pill active" data-tid="${tId}"><span class="teacher-color-dot" style="background:${escapeHtml(data.color)}"></span>${escapeHtml(data.name)}</button>`;
      });
      html += `</div>`;
    }
  }

  if (teachers.length === 0) {
    html += '<div class="admin-empty">Нет данных на этой неделе</div>';
    container.innerHTML = html;
    return;
  }

  teachers.forEach(([tId, data]) => {
    const cancelBadge = data.cancelCount > 0 ? `<span class="payroll-cancel-count">${cancelDeclension(data.cancelCount)}</span>` : '';
    if (isAdmin) {
      html += `<div class="payroll-teacher" data-teacher-id="${tId}">
        <div class="payroll-teacher-header">
          <span class="teacher-color-dot" style="background:${escapeHtml(data.color)}"></span>
          <span class="payroll-teacher-name">${escapeHtml(data.name)}</span>
          ${cancelBadge}
        </div>`;
    } else {
      html += `<div class="payroll-teacher" data-teacher-id="${tId}">
        ${cancelBadge ? `<div class="payroll-teacher-header">${cancelBadge}</div>` : ''}`;
    }
    html += `<div class="payroll-summary">
      <div class="payroll-stat"><span class="payroll-label">Выручка</span><span class="payroll-num">${data.revenue} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Прибыль</span><span class="payroll-num payroll-num-profit">${data.profit} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Комиссия</span><span class="payroll-num">${data.commission} ₽</span></div>
    </div>`;

    // Breakdown row: one-off vs subscriptions
    if (data.subProfit > 0 || data.soldSubs.length > 0) {
      html += `<div class="payroll-breakdown">
        <div class="payroll-breakdown-item"><span>С разовых: <b>${data.oneOffProfit} ₽</b></span></div>
        <div class="payroll-breakdown-item"><span>С абонементов: <b>${data.subProfit} ₽</b></span></div>
      </div>`;
    }

    const oneOffStudents = Object.values(data.students).sort((a, b) => b.amount - a.amount);
    const subStudents = Object.values(data.subStudents).sort((a, b) => b.amount - a.amount);

    html += `<div class="payroll-students">`;
    // 1. Unpaid cancellations on top (red) — only one-off (subscription-linked unpaid go below as part of sub section)
    data.cancelledStudents.filter(cs => !cs.isPaid && !cs.fromSubscription).forEach(cs => {
      html += renderCancellationRow(cs, 'payroll-student-cancelled', isAdmin);
    });
    // 2. One-off conducted lessons
    oneOffStudents.forEach(s => {
      html += `<div class="payroll-student"><span class="ps-name">${escapeHtml(s.name)}</span><span class="ps-count">${s.count} зан.</span><span class="ps-amount">${s.amount} ₽</span></div>`;
    });
    // 3. Paid one-off cancellations (yellow)
    data.cancelledStudents.filter(cs => cs.isPaid && !cs.fromSubscription).forEach(cs => {
      html += renderCancellationRow(cs, 'payroll-student-paid', isAdmin);
    });
    html += `</div>`;

    // ===== Subscription-attended lessons section =====
    if (subStudents.length > 0 || data.cancelledStudents.some(cs => cs.fromSubscription)) {
      html += `<div class="payroll-sub-section">
        <div class="payroll-sub-title">По абонементам · заработок размазан по проведённым</div>
        <div class="payroll-students">`;
      subStudents.forEach(s => {
        const durStr = s.duration ? ` · ${s.duration === 90 ? '1,5 ч' : s.duration === 120 ? '2 ч' : s.duration === 180 ? '3 ч' : (s.duration + ' мин')}` : '';
        html += `<div class="payroll-student payroll-student-sub">
          <span class="ps-name">${escapeHtml(s.name)} <span class="ps-sub-meta">· Абон ${escapeHtml(s.subType)}${durStr}</span></span>
          <span class="ps-count">${s.count} зан.</span>
          <span class="ps-amount">${s.amount} ₽</span>
        </div>`;
      });
      // Subscription-linked cancellations (red unpaid + yellow paid) — they still consume the slot
      data.cancelledStudents.filter(cs => cs.fromSubscription).forEach(cs => {
        const cls = cs.isPaid ? 'payroll-student-paid' : 'payroll-student-cancelled';
        html += renderCancellationRow(cs, cls, isAdmin);
      });
      html += `</div></div>`;
    }

    // ===== Sold subscriptions section =====
    if (data.soldSubs.length > 0) {
      html += `<div class="payroll-sub-section">
        <div class="payroll-sub-title">Проданные абонементы на этой неделе · комиссия идёт центру целиком</div>
        <div class="payroll-students">`;
      data.soldSubs.forEach(ss => {
        const durStr = ss.duration ? ` · ${ss.duration === 90 ? '1,5 ч' : ss.duration === 120 ? '2 ч' : ss.duration === 180 ? '3 ч' : (ss.duration + ' мин')}` : '';
        html += `<div class="payroll-student payroll-student-sold">
          <span class="ps-name">${escapeHtml(ss.studentName)} <span class="ps-sub-meta">· Абон ${escapeHtml(ss.subType)}${durStr}</span></span>
          <span class="ps-count">${ss.paidAmount} ₽</span>
          <span class="ps-amount">центру ${ss.centerShare} ₽</span>
        </div>`;
      });
      html += `</div></div>`;
    }

    // ===== Refunds section =====
    if (data.refundsList && data.refundsList.length > 0) {
      html += `<div class="payroll-sub-section">
        <div class="payroll-sub-title">Возвраты по абонементам на этой неделе · комиссия центру уменьшается</div>
        <div class="payroll-students">`;
      data.refundsList.forEach(rs => {
        const durStr = rs.duration ? ` · ${rs.duration === 90 ? '1,5 ч' : rs.duration === 120 ? '2 ч' : rs.duration === 180 ? '3 ч' : (rs.duration + ' мин')}` : '';
        html += `<div class="payroll-student payroll-student-refund">
          <span class="ps-name">${escapeHtml(rs.studentName)} <span class="ps-sub-meta">· Абон ${escapeHtml(rs.subType)}${durStr}</span></span>
          <span class="ps-count">возврат ${rs.refundAmount} ₽</span>
          <span class="ps-amount">центру −${rs.centerPart} ₽</span>
        </div>`;
      });
      html += `</div></div>`;
    }

    html += `</div>`;
  });

  container.innerHTML = html;

  if (isAdmin) {
    updatePayrollTotals();
    container.querySelectorAll('.payroll-filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        updatePayrollTotals();
      });
    });
  }
}

function updatePayrollTotals() {
  const checked = new Set();
  document.querySelectorAll('.payroll-filter-pill.active').forEach(btn => checked.add(btn.dataset.tid));
  let rev = 0, prof = 0, comm = 0;
  Object.entries(payrollTeacherData).forEach(([tId, data]) => {
    if (checked.has(tId)) { rev += data.revenue; prof += data.profit; comm += data.commission; }
  });
  const el = document.getElementById('payroll-total');
  if (el) {
    el.innerHTML = `
      <div class="payroll-stat"><span class="payroll-label">Общая выручка</span><span class="payroll-num">${rev} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Прибыль преподавателей</span><span class="payroll-num">${prof} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Комиссия центра</span><span class="payroll-num">${comm} ₽</span></div>
    `;
  }
}

function initPricingAndPayroll() {
  // Pricing modal
  document.getElementById('btn-add-pricing').addEventListener('click', () => openPricingModal());
  document.getElementById('btn-close-pricing').addEventListener('click', closePricingModal);
  document.getElementById('btn-cancel-pricing').addEventListener('click', closePricingModal);
  document.getElementById('btn-save-pricing').addEventListener('click', savePricing);
  document.getElementById('btn-delete-pricing').addEventListener('click', deletePricingEntry);
  document.getElementById('pricing-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePricingModal();
  });

  // Auto-calculate profit = price - commission
  function updateProfit() {
    const price = parseInt(document.getElementById('pricing-student-price').value) || 0;
    const commission = parseInt(document.getElementById('pricing-commission').value) || 0;
    document.getElementById('pricing-teacher-profit').value = price - commission;
  }
  document.getElementById('pricing-student-price').addEventListener('input', updateProfit);
  document.getElementById('pricing-commission').addEventListener('input', updateProfit);

  // Payroll week slider
  document.querySelectorAll('.payroll-week-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.payroll-week-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPayrollOffset = +btn.dataset.offset;
      loadPayroll();
    });
  });

  // Delegated handler: click on any "Указать причину" / "Причина" / "Не указана" button
  document.getElementById('payroll-content').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-reason');
    if (!btn) return;
    const id = btn.dataset.cancellationId;
    const editable = btn.dataset.editable === '1';
    openReasonModal(id, editable);
  });

  // Reason modal buttons
  document.getElementById('btn-close-reason').addEventListener('click', closeReasonModal);
  document.getElementById('btn-cancel-reason').addEventListener('click', closeReasonModal);
  document.getElementById('btn-save-reason').addEventListener('click', saveReason);
  const validBtn = document.getElementById('btn-toggle-valid');
  if (validBtn) validBtn.addEventListener('click', toggleValidReasonAction);
  const extendBtn = document.getElementById('btn-extend-sub');
  if (extendBtn) extendBtn.addEventListener('click', applyExtensionAction);
  document.getElementById('btn-remove-reason-image').addEventListener('click', removeReasonImage);
  document.getElementById('reason-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeReasonModal();
  });
  document.getElementById('reason-image-input').addEventListener('change', onReasonImagePicked);

  // Lightbox: click on overlay or close button → close; click on image → stay open; ESC → close
  const lightboxOverlay = document.getElementById('lightbox-overlay');
  lightboxOverlay.addEventListener('click', (e) => {
    if (e.target === lightboxOverlay || e.target.closest('#lightbox-close')) {
      closeLightbox();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxOverlay.classList.contains('active')) closeLightbox();
  });
}

// ===== CANCELLATION REASON =====

function renderCancellationRow(cs, colorClass, isAdmin) {
  const editable = !isAdmin || cs.teacherId === state.user.id;
  const hasFilledReason = cs.hasReason || cs.validReason;
  let btn;
  if (hasFilledReason) {
    const label = cs.validReason && !cs.hasReason ? 'Ув. причина' : 'Причина';
    btn = `<button class="btn-reason btn-reason-filled" data-cancellation-id="${cs.cancellationId}" data-editable="${editable ? 1 : 0}" title="${editable ? 'Изменить причину' : 'Посмотреть причину'}">${label}</button>`;
  } else if (editable) {
    btn = `<button class="btn-reason btn-reason-empty" data-cancellation-id="${cs.cancellationId}" data-editable="1" title="Указать причину">Указать причину</button>`;
  } else {
    btn = `<button class="btn-reason btn-reason-missing" data-cancellation-id="${cs.cancellationId}" data-editable="0" disabled title="Причина не указана">Не указана</button>`;
  }
  const statusLabel = cs.isPaid ? 'Платная отмена' : 'Отменено';
  return `<div class="payroll-student ${colorClass}">
    <span class="ps-name">${escapeHtml(cs.name)}</span>
    <span class="ps-reason">${btn}</span>
    <span class="ps-cancel-status">${statusLabel}</span>
    <span class="ps-amount">${cs.amount} ₽</span>
  </div>`;
}

let reasonCtx = null; // { id, editable, existingImagePath, pendingFile, removeExistingImage }

async function openReasonModal(cancellationId, editable) {
  const { data: c, error } = await db.from('cancellations')
    .select('id, teacher_id, student_id, reason_text, reason_image_url, valid_reason, extension_applied_at, student:students(first_name, last_name)')
    .eq('id', cancellationId).single();
  if (error || !c) { showToast('Не удалось загрузить отмену', 'error'); return; }

  reasonCtx = {
    id: c.id,
    editable,
    teacherId: c.teacher_id,
    studentId: c.student_id,
    existingImagePath: c.reason_image_url || null,
    pendingFile: null,
    removeExistingImage: false,
    validReason: !!c.valid_reason,
    extensionAppliedAt: c.extension_applied_at || null
  };

  document.getElementById('reason-modal-title').textContent =
    `Причина отмены: ${c.student?.first_name || ''} ${c.student?.last_name || ''}`.trim();

  const textarea = document.getElementById('reason-text');
  textarea.value = c.reason_text || '';
  textarea.disabled = !editable;

  // "Уважительная причина" toggle button — visual state by reasonCtx.validReason
  const validBtn = document.getElementById('btn-toggle-valid');
  if (validBtn) {
    validBtn.classList.toggle('active', !!c.valid_reason);
    validBtn.disabled = !editable;
  }

  // "+7 дней абонемента" button — disabled if already applied or not editable
  const extendBtn = document.getElementById('btn-extend-sub');
  if (extendBtn) {
    if (c.extension_applied_at) {
      extendBtn.disabled = true;
      extendBtn.classList.add('applied');
      const titleSpan = extendBtn.querySelector('.reason-action-title');
      if (titleSpan) titleSpan.textContent = '+7 дней применены';
    } else {
      extendBtn.disabled = !editable;
      extendBtn.classList.remove('applied');
      const titleSpan = extendBtn.querySelector('.reason-action-title');
      if (titleSpan) titleSpan.textContent = '+7 дней абонемента';
    }
  }

  await refreshReasonImagePreview();

  document.getElementById('reason-edit-controls').style.display = editable ? 'flex' : 'none';
  document.getElementById('btn-save-reason').style.display = editable ? '' : 'none';
  document.getElementById('btn-cancel-reason').textContent = editable ? 'Отмена' : 'Закрыть';

  document.getElementById('reason-overlay').classList.add('active');
}

function closeReasonModal() {
  document.getElementById('reason-overlay').classList.remove('active');
  document.getElementById('reason-image-input').value = '';
  reasonCtx = null;
}

async function refreshReasonImagePreview() {
  const wrap = document.getElementById('reason-image-preview');
  if (!reasonCtx) { wrap.innerHTML = ''; return; }

  // Priority: pending local file > existing in storage > nothing
  if (reasonCtx.pendingFile) {
    const url = URL.createObjectURL(reasonCtx.pendingFile);
    wrap.innerHTML = `<img src="${url}" alt="">`;
    attachReasonImageZoom(wrap, url);
    document.getElementById('btn-remove-reason-image').style.display = reasonCtx.editable ? '' : 'none';
    return;
  }
  if (reasonCtx.existingImagePath && !reasonCtx.removeExistingImage) {
    const { data: signed, error } = await db.storage.from('cancellation-reasons')
      .createSignedUrl(reasonCtx.existingImagePath, 3600);
    if (!error && signed?.signedUrl) {
      wrap.innerHTML = `<img src="${signed.signedUrl}" alt="">`;
      attachReasonImageZoom(wrap, signed.signedUrl);
    } else {
      wrap.innerHTML = '<div class="reason-img-error">Не удалось загрузить изображение</div>';
    }
    document.getElementById('btn-remove-reason-image').style.display = reasonCtx.editable ? '' : 'none';
    return;
  }
  wrap.innerHTML = '<div class="reason-img-empty">Скриншот не прикреплён</div>';
  document.getElementById('btn-remove-reason-image').style.display = 'none';
}

function attachReasonImageZoom(wrap, src) {
  const img = wrap.querySelector('img');
  if (!img) return;
  img.addEventListener('click', () => openLightbox(src));
}

// ===== LIGHTBOX (image viewer) =====

function openLightbox(src) {
  const overlay = document.getElementById('lightbox-overlay');
  const img = document.getElementById('lightbox-img');
  img.src = src;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const overlay = document.getElementById('lightbox-overlay');
  overlay.classList.remove('active');
  document.getElementById('lightbox-img').src = '';
  document.body.style.overflow = '';
}

function onReasonImagePicked(e) {
  const file = e.target.files?.[0];
  if (!file || !reasonCtx) return;
  if (!file.type.startsWith('image/')) {
    showToast('Можно загружать только изображения', 'error');
    e.target.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Файл больше 5 МБ — сожмите перед загрузкой', 'error');
    e.target.value = '';
    return;
  }
  reasonCtx.pendingFile = file;
  reasonCtx.removeExistingImage = false; // adding new replaces existing
  refreshReasonImagePreview();
}

function removeReasonImage() {
  if (!reasonCtx) return;
  reasonCtx.pendingFile = null;
  reasonCtx.removeExistingImage = true;
  document.getElementById('reason-image-input').value = '';
  refreshReasonImagePreview();
}

async function saveReason() {
  if (!reasonCtx || !reasonCtx.editable) return;
  const text = document.getElementById('reason-text').value.trim();
  const willHaveImage = !!reasonCtx.pendingFile || (reasonCtx.existingImagePath && !reasonCtx.removeExistingImage);
  const validReason = !!reasonCtx.validReason;

  if (!validReason && !text && !willHaveImage) {
    showToast('Нужно указать текст, прикрепить скриншот или отметить уважительную причину', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-reason');
  btn.disabled = true;

  try {
    let imagePathToSave = reasonCtx.existingImagePath;

    if (reasonCtx.pendingFile) {
      const ext = (reasonCtx.pendingFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${reasonCtx.teacherId}/${reasonCtx.id}.${ext}`;
      const { error: upErr } = await db.storage.from('cancellation-reasons')
        .upload(path, reasonCtx.pendingFile, { upsert: true, contentType: reasonCtx.pendingFile.type });
      if (upErr) throw upErr;
      if (reasonCtx.existingImagePath && reasonCtx.existingImagePath !== path) {
        await db.storage.from('cancellation-reasons').remove([reasonCtx.existingImagePath]);
      }
      imagePathToSave = path;
    } else if (reasonCtx.removeExistingImage && reasonCtx.existingImagePath) {
      await db.storage.from('cancellation-reasons').remove([reasonCtx.existingImagePath]);
      imagePathToSave = null;
    }

    // valid_reason here only frees the cancellation (no payment, not a truant).
    // Extension is a separate one-shot action via "+7 дней абонемента" button.
    const update = {
      reason_text: text || null,
      reason_image_url: imagePathToSave,
      reason_updated_at: new Date().toISOString(),
      valid_reason: validReason
    };
    if (validReason) update.is_paid = false;

    const { error: dbErr } = await db.from('cancellations').update(update).eq('id', reasonCtx.id);
    if (dbErr) throw dbErr;

    if (reasonCtx.studentId) await recomputeSubscriptionsByStudent(reasonCtx.studentId);

    showToast('Причина сохранена', 'success');
    closeReasonModal();
    await loadPayroll();
  } catch (e) {
    console.error('saveReason error:', e);
    showToast('Ошибка: ' + (e.message || 'неизвестно'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// Toggle "Уважительная причина" — visual state, persisted on Save
function toggleValidReasonAction() {
  if (!reasonCtx || !reasonCtx.editable) return;
  reasonCtx.validReason = !reasonCtx.validReason;
  const btn = document.getElementById('btn-toggle-valid');
  if (btn) btn.classList.toggle('active', !!reasonCtx.validReason);
}

// One-shot "+7 days" — extends active subscription, marks extension_applied_at,
// disables the button. Persistent in DB so it cannot be applied twice for the same cancellation.
async function applyExtensionAction() {
  if (!reasonCtx || !reasonCtx.editable) return;
  if (reasonCtx.extensionAppliedAt) {
    showToast('Уже применено для этой отмены', 'error');
    return;
  }
  // One-shot and irreversible — ask before doing it.
  showConfirm(
    'Продлить активный абонемент ученика на 7 дней? Действие можно применить только один раз для этой отмены.',
    () => doApplyExtension(),
    'Продлить',
    'primary'
  );
}

async function doApplyExtension() {
  if (!reasonCtx || !reasonCtx.editable) return;
  if (reasonCtx.extensionAppliedAt) return;
  const btn = document.getElementById('btn-extend-sub');
  if (btn) btn.disabled = true;
  try {
    const { data: activeSub } = await db.from('subscriptions')
      .select('id, end_date')
      .eq('student_id', reasonCtx.studentId)
      .eq('status', 'active')
      .maybeSingle();
    if (!activeSub) {
      showToast('У ученика нет активного абонемента для продления', 'error');
      if (btn) btn.disabled = false;
      return;
    }
    const newEnd = new Date(activeSub.end_date);
    newEnd.setDate(newEnd.getDate() + 7);
    const yyyy = newEnd.getFullYear();
    const mm = (newEnd.getMonth() + 1).toString().padStart(2, '0');
    const dd = newEnd.getDate().toString().padStart(2, '0');
    const newEndStr = `${yyyy}-${mm}-${dd}`;

    const nowIso = new Date().toISOString();
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      db.from('subscriptions').update({ end_date: newEndStr }).eq('id', activeSub.id),
      db.from('cancellations').update({ extension_applied_at: nowIso }).eq('id', reasonCtx.id)
    ]);
    if (e1 || e2) throw (e1 || e2);

    reasonCtx.extensionAppliedAt = nowIso;
    if (btn) {
      btn.classList.add('applied');
      const titleSpan = btn.querySelector('.reason-action-title');
      if (titleSpan) titleSpan.textContent = '+7 дней применены';
    }
    showToast('Срок абонемента продлён на 7 дней', 'success');
  } catch (e) {
    console.error('applyExtensionAction:', e);
    showToast('Ошибка: ' + (e.message || 'неизвестно'), 'error');
    if (btn) btn.disabled = false;
  }
}
