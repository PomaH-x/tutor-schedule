let pricingList = [];
let editingPricingId = null;
let currentPayrollOffset = 0;

// ===== PRICING CRUD =====

async function loadPricing() {
  const { data } = await db.from('pricing').select('*').eq('active', true).order('is_individual').order('duration_minutes').order('price_type');
  pricingList = data || [];
}

function formatTierLabel(duration, isIndividual) {
  const h = duration / 60;
  const hStr = h === Math.floor(h) ? `${h} ч` : `${h.toString().replace('.', ',')} ч`;
  return isIndividual ? `${hStr} (Инд.)` : hStr;
}

function findPricing(duration, isIndividual, priceType, isOnline) {
  if (isOnline) {
    const online = pricingList.find(p => p.is_online === true && p.duration_minutes === duration && p.price_type === priceType);
    if (online) return online;
    return pricingList.find(p => p.is_individual === true && p.duration_minutes === duration && p.price_type === priceType);
  }
  return pricingList.find(p => !p.is_online && p.duration_minutes === duration && p.is_individual === isIndividual && p.price_type === priceType);
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

  // Group: group first, then individual; within each, by price type
  const grouped = { group_old: [], group_new: [], ind_old: [], ind_new: [], online_old: [], online_new: [] };
  pricing.forEach(p => {
    if (p.is_online) {
      grouped[`online_${p.price_type}`].push(p);
    } else {
      const key = `${p.is_individual ? 'ind' : 'group'}_${p.price_type}`;
      if (grouped[key]) grouped[key].push(p);
    }
  });

  const sections = [
    { key: 'group_new', title: 'Групповые · Новые цены' },
    { key: 'group_old', title: 'Групповые · Старые цены' },
    { key: 'ind_new', title: 'Индивидуальные · Новые цены' },
    { key: 'ind_old', title: 'Индивидуальные · Старые цены' },
    { key: 'online_new', title: 'Онлайн · Новые цены' },
    { key: 'online_old', title: 'Онлайн · Старые цены' }
  ];

  let html = '';
  sections.forEach(sec => {
    if (grouped[sec.key].length === 0) return;
    html += `<div class="pricing-section-title">${sec.title}</div>`;
    grouped[sec.key].sort((a, b) => a.duration_minutes - b.duration_minutes);
    grouped[sec.key].forEach(p => {
      html += `<div class="pricing-card" data-id="${p.id}">
        <span class="pricing-duration">${formatTierLabel(p.duration_minutes, p.is_individual)}</span>
        <span class="pricing-values">
          <span class="pv-item">Занятие: <b>${p.student_price}₽</b></span>
          <span class="pv-item">Преп.: <b>${p.teacher_profit}₽</b></span>
          <span class="pv-item">Центр: <b>${p.commission}₽</b></span>
        </span>
        <button class="btn-edit-pricing" data-id="${p.id}" title="Редактировать">✎</button>
      </div>`;
    });
  });
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
  const studentPrice = parseInt(document.getElementById('pricing-student-price').value);
  const teacherProfit = parseInt(document.getElementById('pricing-teacher-profit').value);
  const commission = parseInt(document.getElementById('pricing-commission').value);

  if (!duration || duration < 30) { showToast('Укажите длительность', 'error'); return; }
  if (isNaN(studentPrice) || isNaN(teacherProfit) || isNaN(commission)) { showToast('Заполните все суммы', 'error'); return; }

  const record = {
    duration_minutes: duration, is_individual: isIndividual, is_online: isOnline, price_type: priceType,
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

async function loadPayroll() {
  const now = getMonday(new Date());
  const target = new Date(now);
  target.setDate(target.getDate() + currentPayrollOffset * 7);
  const ws = formatDate(target);
  const isAdmin = state.profile.role === 'admin';

  let q = db.from('lessons')
    .select('id, teacher_id, start_time, end_time, status, teacher:profiles!teacher_id(full_name, color, role), lesson_students(student_id, student:students(first_name, last_name, is_individual, is_online, price_type))')
    .eq('week_start', ws).in('status', ['active', 'cancelled']);
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);

  // Also fetch pending cancellations for this week
  let qc = db.from('cancellations')
    .select('id, student_id, teacher_id, lesson_start_time, is_paid, reason_text, reason_image_url, student:students(first_name, last_name, is_individual, is_online, price_type)')
    .eq('week_start', ws).eq('status', 'pending');
  if (!isAdmin) qc = qc.eq('teacher_id', state.user.id);

  const [{ data: lessons }, { data: cancellations }] = await Promise.all([q, qc]);
  renderPayroll(lessons || [], cancellations || [], isAdmin);
}

let payrollTeacherData = {};

function renderPayroll(lessons, cancellations, isAdmin) {
  const container = document.getElementById('payroll-content');
  if (!container) return;

  payrollTeacherData = {};

  // Process active lessons
  lessons.forEach(lesson => {
    if (lesson.status !== 'active') return;
    const tId = lesson.teacher_id;
    const teacherRole = lesson.teacher?.role;
    const start = new Date(lesson.start_time);
    const end = new Date(lesson.end_time);
    const durationMin = Math.round((end - start) / 60000);

    if (!payrollTeacherData[tId]) {
      payrollTeacherData[tId] = {
        name: lesson.teacher?.full_name || '',
        color: lesson.teacher?.color || '#1e6fe8',
        role: teacherRole,
        revenue: 0, profit: 0, commission: 0,
        cancelCount: 0,
        students: {}, cancelledStudents: []
      };
    }
    (lesson.lesson_students || []).forEach(ls => {
      const s = ls.student; if (!s) return;
      const price = findPricing(durationMin, s.is_individual || false, s.price_type || 'new', s.is_online || false);
      if (!price) return;

      const isTeacherAdmin = teacherRole === 'admin';
      const effectiveProfit = isTeacherAdmin ? price.student_price : price.teacher_profit;
      const effectiveCommission = isTeacherAdmin ? 0 : price.commission;

      payrollTeacherData[tId].revenue += price.student_price;
      payrollTeacherData[tId].profit += effectiveProfit;
      payrollTeacherData[tId].commission += effectiveCommission;

      const sKey = ls.student_id;
      if (!payrollTeacherData[tId].students[sKey]) {
        payrollTeacherData[tId].students[sKey] = { name: `${s.first_name} ${s.last_name}`, amount: 0, count: 0 };
      }
      payrollTeacherData[tId].students[sKey].amount += price.student_price;
      payrollTeacherData[tId].students[sKey].count++;
    });
  });

  // Process cancellations — add cancelled students (red/yellow rows) + counter
  cancellations.forEach(c => {
    const tId = c.teacher_id;
    if (!payrollTeacherData[tId]) {
      const cancelledLesson = lessons.find(l => l.teacher_id === tId);
      payrollTeacherData[tId] = {
        name: cancelledLesson?.teacher?.full_name || '',
        color: cancelledLesson?.teacher?.color || '#1e6fe8',
        role: cancelledLesson?.teacher?.role,
        revenue: 0, profit: 0, commission: 0,
        cancelCount: 0,
        students: {}, cancelledStudents: []
      };
    }
    payrollTeacherData[tId].cancelCount++;

    const s = c.student;
    if (!s) return;
    let amount = 0;
    if (c.lesson_start_time) {
      const paired = lessons.find(l => l.teacher_id === tId && l.status === 'cancelled' && l.start_time === c.lesson_start_time);
      if (paired) {
        const durMin = Math.round((new Date(paired.end_time) - new Date(paired.start_time)) / 60000);
        const price = findPricing(durMin, s.is_individual || false, s.price_type || 'new', s.is_online || false);
        if (price) amount = price.student_price;
      }
    }
    if (amount === 0) {
      const match = pricingList.find(p => p.is_individual === (s.is_individual || false) && p.price_type === (s.price_type || 'new'));
      if (match) amount = match.student_price;
    }

    // If paid cancellation — add to revenue/profit/commission as a regular lesson
    if (c.is_paid && amount > 0) {
      const isTeacherAdmin = payrollTeacherData[tId].role === 'admin';
      // Try to find tariff again for proper profit/commission
      const dur = c.lesson_start_time ? (() => {
        const paired = lessons.find(l => l.teacher_id === tId && l.status === 'cancelled' && l.start_time === c.lesson_start_time);
        if (paired) return Math.round((new Date(paired.end_time) - new Date(paired.start_time)) / 60000);
        return null;
      })() : null;
      let priceObj = null;
      if (dur) priceObj = findPricing(dur, s.is_individual || false, s.price_type || 'new', s.is_online || false);
      if (!priceObj) priceObj = pricingList.find(p => p.is_individual === (s.is_individual || false) && p.price_type === (s.price_type || 'new'));
      if (priceObj) {
        const eff = isTeacherAdmin ? priceObj.student_price : priceObj.teacher_profit;
        const com = isTeacherAdmin ? 0 : priceObj.commission;
        payrollTeacherData[tId].revenue += priceObj.student_price;
        payrollTeacherData[tId].profit += eff;
        payrollTeacherData[tId].commission += com;
      }
    }

    payrollTeacherData[tId].cancelledStudents.push({
      cancellationId: c.id,
      teacherId: c.teacher_id,
      name: `${s.first_name} ${s.last_name}`,
      amount,
      isPaid: !!c.is_paid,
      hasReason: !!(c.reason_text || c.reason_image_url)
    });
  });

function cancelDeclension(n) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} отмен`;
  if (last === 1) return `${n} отмена`;
  if (last >= 2 && last <= 4) return `${n} отмены`;
  return `${n} отмен`;
}

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
        html += `<button class="payroll-filter-pill active" data-tid="${tId}"><span class="teacher-color-dot" style="background:${data.color}"></span>${data.name}</button>`;
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
    const students = Object.values(data.students).sort((a, b) => b.amount - a.amount);
    const cancelBadge = data.cancelCount > 0 ? `<span class="payroll-cancel-count">${cancelDeclension(data.cancelCount)}</span>` : '';
    if (isAdmin) {
      html += `<div class="payroll-teacher" data-teacher-id="${tId}">
        <div class="payroll-teacher-header">
          <span class="teacher-color-dot" style="background:${data.color}"></span>
          <span class="payroll-teacher-name">${data.name}</span>
          ${cancelBadge}
        </div>`;
    } else {
      html += `<div class="payroll-teacher" data-teacher-id="${tId}">
        ${cancelBadge ? `<div class="payroll-teacher-header">${cancelBadge}</div>` : ''}`;
    }
    html += `<div class="payroll-summary">
      <div class="payroll-stat"><span class="payroll-label">Выручка</span><span class="payroll-num">${data.revenue} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Прибыль</span><span class="payroll-num payroll-num-profit">${data.profit} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Комиссия</span><span class="payroll-num">${data.commission} ₽</span></div>
    </div>`;
    html += `<div class="payroll-students">`;
    // 1. Unpaid cancellations on top (red)
    data.cancelledStudents.filter(cs => !cs.isPaid).forEach(cs => {
      html += renderCancellationRow(cs, 'payroll-student-cancelled', isAdmin);
    });
    // 2. Conducted lessons in the middle (blue), sorted by amount descending
    students.forEach(s => {
      html += `<div class="payroll-student"><span class="ps-name">${s.name}</span><span class="ps-count">${s.count} зан.</span><span class="ps-amount">${s.amount} ₽</span></div>`;
    });
    // 3. Paid cancellations at the bottom (yellow)
    data.cancelledStudents.filter(cs => cs.isPaid).forEach(cs => {
      html += renderCancellationRow(cs, 'payroll-student-paid', isAdmin);
    });
    html += `</div></div>`;
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
      <div class="payroll-stat"><span class="payroll-label">Общая выручка</span><span class="payroll-num">${rev} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Прибыль преподавателей</span><span class="payroll-num">${prof} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Комиссия центра</span><span class="payroll-num">${comm} ₽</span></div>
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
  let btn;
  if (cs.hasReason) {
    btn = `<button class="btn-reason btn-reason-filled" data-cancellation-id="${cs.cancellationId}" data-editable="${editable ? 1 : 0}" title="${editable ? 'Изменить причину' : 'Посмотреть причину'}">Причина</button>`;
  } else if (editable) {
    btn = `<button class="btn-reason btn-reason-empty" data-cancellation-id="${cs.cancellationId}" data-editable="1" title="Указать причину">Указать причину</button>`;
  } else {
    btn = `<button class="btn-reason btn-reason-missing" data-cancellation-id="${cs.cancellationId}" data-editable="0" disabled title="Причина не указана">Не указана</button>`;
  }
  return `<div class="payroll-student ${colorClass}">
    <span class="ps-name">${cs.name}</span>
    <span class="ps-reason">${btn}</span>
    <span class="ps-count">отменено</span>
    <span class="ps-amount">${cs.amount} ₽</span>
  </div>`;
}

let reasonCtx = null; // { id, editable, existingImagePath, pendingFile, removeExistingImage }

async function openReasonModal(cancellationId, editable) {
  const { data: c, error } = await db.from('cancellations')
    .select('id, teacher_id, reason_text, reason_image_url, student:students(first_name, last_name)')
    .eq('id', cancellationId).single();
  if (error || !c) { showToast('Не удалось загрузить отмену', 'error'); return; }

  reasonCtx = {
    id: c.id,
    editable,
    teacherId: c.teacher_id,
    existingImagePath: c.reason_image_url || null,
    pendingFile: null,
    removeExistingImage: false
  };

  document.getElementById('reason-modal-title').textContent =
    `${editable ? 'Причина отмены' : 'Причина отмены'}: ${c.student?.first_name || ''} ${c.student?.last_name || ''}`.trim();

  const textarea = document.getElementById('reason-text');
  textarea.value = c.reason_text || '';
  textarea.disabled = !editable;

  // Image preview
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

  if (!text && !willHaveImage) {
    showToast('Нужно указать текст или прикрепить скриншот', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-reason');
  btn.disabled = true;

  try {
    let imagePathToSave = reasonCtx.existingImagePath;

    // Upload new file if picked
    if (reasonCtx.pendingFile) {
      const ext = (reasonCtx.pendingFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${reasonCtx.teacherId}/${reasonCtx.id}.${ext}`;
      const { error: upErr } = await db.storage.from('cancellation-reasons')
        .upload(path, reasonCtx.pendingFile, { upsert: true, contentType: reasonCtx.pendingFile.type });
      if (upErr) throw upErr;

      // If previous file had a different extension, delete it
      if (reasonCtx.existingImagePath && reasonCtx.existingImagePath !== path) {
        await db.storage.from('cancellation-reasons').remove([reasonCtx.existingImagePath]);
      }
      imagePathToSave = path;
    } else if (reasonCtx.removeExistingImage && reasonCtx.existingImagePath) {
      await db.storage.from('cancellation-reasons').remove([reasonCtx.existingImagePath]);
      imagePathToSave = null;
    }

    const { error: dbErr } = await db.from('cancellations').update({
      reason_text: text || null,
      reason_image_url: imagePathToSave,
      reason_updated_at: new Date().toISOString()
    }).eq('id', reasonCtx.id);
    if (dbErr) throw dbErr;

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
