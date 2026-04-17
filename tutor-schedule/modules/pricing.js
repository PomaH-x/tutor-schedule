let pricingList = [];
let editingPricingId = null;
let currentPayrollOffset = 0;

// ===== PRICING CRUD =====

async function loadPricing() {
  const { data } = await db.from('pricing').select('*').eq('active', true).order('is_individual').order('duration_minutes').order('price_type');
  pricingList = data || [];
  populateDurationTierSelect();
}

function populateDurationTierSelect() {
  const sel = document.getElementById('student-duration-tier');
  if (!sel) return;

  // Unique combinations of duration + is_individual
  const tiers = [];
  const seen = new Set();
  pricingList.forEach(p => {
    const key = `${p.duration_minutes}-${p.is_individual}`;
    if (!seen.has(key)) {
      seen.add(key);
      tiers.push({ duration: p.duration_minutes, isIndividual: p.is_individual });
    }
  });
  tiers.sort((a, b) => {
    if (a.isIndividual !== b.isIndividual) return a.isIndividual ? 1 : -1;
    return a.duration - b.duration;
  });

  const current = sel.value;
  sel.innerHTML = tiers.map(t => {
    const label = formatTierLabel(t.duration, t.isIndividual);
    const val = `${t.duration}-${t.isIndividual}`;
    return `<option value="${val}">${label}</option>`;
  }).join('');
  if (current) sel.value = current;
}

function formatTierLabel(duration, isIndividual) {
  const h = duration / 60;
  const hStr = h === Math.floor(h) ? `${h} ч` : `${h.toString().replace('.', ',')} ч`;
  return isIndividual ? `${hStr} (Инд.)` : hStr;
}

function findPricing(duration, isIndividual, priceType) {
  return pricingList.find(p => p.duration_minutes === duration && p.is_individual === isIndividual && p.price_type === priceType);
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
  const grouped = { group_old: [], group_new: [], ind_old: [], ind_new: [] };
  pricing.forEach(p => {
    const key = `${p.is_individual ? 'ind' : 'group'}_${p.price_type}`;
    grouped[key].push(p);
  });

  const sections = [
    { key: 'group_new', title: 'Групповые · Новые цены' },
    { key: 'group_old', title: 'Групповые · Старые цены' },
    { key: 'ind_new', title: 'Индивидуальные · Новые цены' },
    { key: 'ind_old', title: 'Индивидуальные · Старые цены' }
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
          <span class="pv-item">Ученик: <b>${p.student_price}₽</b></span>
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
  document.getElementById('pricing-is-individual').value = String(pricing?.is_individual || false);
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
  const isIndividual = document.getElementById('pricing-is-individual').value === 'true';
  const priceType = document.getElementById('pricing-price-type').value;
  const studentPrice = parseInt(document.getElementById('pricing-student-price').value);
  const teacherProfit = parseInt(document.getElementById('pricing-teacher-profit').value);
  const commission = parseInt(document.getElementById('pricing-commission').value);

  if (!duration || duration < 30) { showToast('Укажите длительность', 'error'); return; }
  if (isNaN(studentPrice) || isNaN(teacherProfit) || isNaN(commission)) { showToast('Заполните все суммы', 'error'); return; }

  const record = {
    duration_minutes: duration, is_individual: isIndividual, price_type: priceType,
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
    .select('id, teacher_id, teacher:profiles!teacher_id(full_name, color), lesson_students(student_id, student:students(first_name, last_name, lesson_duration, is_individual, price_type))')
    .eq('week_start', ws).eq('status', 'active');
  if (!isAdmin) q = q.eq('teacher_id', state.user.id);

  const { data: lessons } = await q;
  renderPayroll(lessons || [], isAdmin);
}

function renderPayroll(lessons, isAdmin) {
  const container = document.getElementById('payroll-content');
  if (!container) return;

  // Per-teacher: { teacherId: { name, color, revenue, profit, commission, students: { studentId: {name, amount, count} } } }
  const perTeacher = {};
  let totalRevenue = 0, totalProfit = 0, totalCommission = 0;

  lessons.forEach(lesson => {
    const tId = lesson.teacher_id;
    if (!perTeacher[tId]) {
      perTeacher[tId] = {
        name: lesson.teacher?.full_name || '',
        color: lesson.teacher?.color || '#1e6fe8',
        revenue: 0, profit: 0, commission: 0,
        students: {}
      };
    }
    (lesson.lesson_students || []).forEach(ls => {
      const s = ls.student; if (!s) return;
      const price = findPricing(s.lesson_duration, s.is_individual, s.price_type || 'new');
      if (!price) return;
      perTeacher[tId].revenue += price.student_price;
      perTeacher[tId].profit += price.teacher_profit;
      perTeacher[tId].commission += price.commission;
      totalRevenue += price.student_price;
      totalProfit += price.teacher_profit;
      totalCommission += price.commission;

      const sKey = ls.student_id;
      if (!perTeacher[tId].students[sKey]) {
        perTeacher[tId].students[sKey] = { name: `${s.first_name} ${s.last_name}`, amount: 0, count: 0, profit: 0, commission: 0 };
      }
      perTeacher[tId].students[sKey].amount += price.student_price;
      perTeacher[tId].students[sKey].profit += price.teacher_profit;
      perTeacher[tId].students[sKey].commission += price.commission;
      perTeacher[tId].students[sKey].count++;
    });
  });

  let html = '';

  if (isAdmin) {
    html += `<div class="payroll-total">
      <div class="payroll-stat"><span class="payroll-label">Общая выручка</span><span class="payroll-num">${totalRevenue} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Прибыль преподавателей</span><span class="payroll-num">${totalProfit} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Комиссия центра</span><span class="payroll-num">${totalCommission} ₽</span></div>
    </div>`;
  }

  const teachers = Object.entries(perTeacher);
  if (teachers.length === 0) {
    html += '<div class="admin-empty">Нет занятий на этой неделе</div>';
    container.innerHTML = html;
    return;
  }

  teachers.sort((a, b) => {
    if (a[0] === state.user.id) return -1;
    if (b[0] === state.user.id) return 1;
    return a[1].name.localeCompare(b[1].name);
  });

  teachers.forEach(([tId, data]) => {
    const students = Object.values(data.students).sort((a, b) => b.amount - a.amount);

    if (isAdmin) {
      html += `<div class="payroll-teacher">
        <div class="payroll-teacher-header">
          <span class="teacher-color-dot" style="background:${data.color}"></span>
          <span class="payroll-teacher-name">${data.name}</span>
        </div>`;
    } else {
      html += `<div class="payroll-teacher">`;
    }

    html += `<div class="payroll-summary">
      <div class="payroll-stat"><span class="payroll-label">Выручка</span><span class="payroll-num">${data.revenue} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Прибыль</span><span class="payroll-num payroll-num-profit">${data.profit} ₽</span></div>
      <div class="payroll-stat"><span class="payroll-label">Комиссия</span><span class="payroll-num">${data.commission} ₽</span></div>
    </div>`;

    html += `<div class="payroll-students">`;
    students.forEach(s => {
      html += `<div class="payroll-student">
        <span class="ps-name">${s.name}</span>
        <span class="ps-count">${s.count} зан.</span>
        <span class="ps-amount">${s.amount} ₽</span>
      </div>`;
    });
    html += `</div></div>`;
  });

  container.innerHTML = html;
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

  // Payroll week slider
  document.querySelectorAll('.payroll-week-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.payroll-week-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPayrollOffset = +btn.dataset.offset;
      loadPayroll();
    });
  });
}
