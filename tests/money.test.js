// Unit tests for modules/money.js — run with:  node --test tests/
//
// Uses only node:test and node:assert, both built in. No framework, no npm install,
// nothing to keep updated: the "no dependencies" rule applies to tooling too.
//
// These cover the arithmetic where a silent error costs the client real money:
// subscription per-lesson shares and refund splits.

const { test } = require('node:test');
const assert = require('node:assert');
const { subscriptionLessonShare, roundRefundUp50, calcRefund } =
  require('../modules/money.js');

// Helper: the whole point of the share function is that the parts sum to the total.
function sumOfShares(amount, total) {
  let sum = 0;
  for (let i = 0; i < total; i++) sum += subscriptionLessonShare(amount, total, i);
  return sum;
}

// ===== subscriptionLessonShare =====

test('доли делятся нацело, когда сумма кратна числу занятий', () => {
  assert.strictEqual(subscriptionLessonShare(8000, 8, 0), 1000);
  assert.strictEqual(subscriptionLessonShare(8000, 8, 7), 1000);
  assert.strictEqual(sumOfShares(8000, 8), 8000);
});

test('регрессия: 9250 на 4 занятия даёт ровно 9250, а не 9252', () => {
  // Старый Math.round(9250/4) = 2313 на каждое → 9252. Два лишних рубля из воздуха.
  assert.strictEqual(sumOfShares(9250, 4), 9250);
  const shares = [0, 1, 2, 3].map(i => subscriptionLessonShare(9250, 4, i));
  assert.deepStrictEqual(shares, [2312, 2313, 2312, 2313]);
});

test('сумма долей равна исходной для широкого набора значений', () => {
  const amounts = [0, 1, 7, 50, 999, 1000, 4500, 9250, 12345, 99999];
  const totals = [1, 2, 3, 4, 5, 6, 7, 8, 12, 16];
  for (const amount of amounts) {
    for (const total of totals) {
      assert.strictEqual(sumOfShares(amount, total), amount,
        `сумма долей ${amount} на ${total} занятий разошлась`);
    }
  }
});

test('доли отличаются не больше чем на рубль — никто не переплачивает заметно', () => {
  const shares = [];
  for (let i = 0; i < 7; i++) shares.push(subscriptionLessonShare(10000, 7, i));
  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
});

test('доля зависит только от своего индекса (важно для недельного payroll)', () => {
  // Одно и то же занятие должно стоить одинаково независимо от того,
  // какая неделя открыта — иначе суммы «плавают» между экранами.
  const first = subscriptionLessonShare(9250, 8, 3);
  const again = subscriptionLessonShare(9250, 8, 3);
  assert.strictEqual(first, again);
});

test('вырожденные входные данные не роняют расчёт', () => {
  assert.strictEqual(subscriptionLessonShare(1000, 0, 0), 0);
  assert.strictEqual(subscriptionLessonShare(1000, -5, 0), 0);
  assert.strictEqual(subscriptionLessonShare(null, 8, 0), 0);
  assert.strictEqual(subscriptionLessonShare(undefined, 8, 0), 0);
  assert.strictEqual(subscriptionLessonShare(0, 8, 0), 0);
});

test('индекс вне диапазона откатывается к ровной доле, а не к нулю', () => {
  // Абонемент на 4, а связанных занятий больше — перерасход. Показать
  // приблизительную сумму лучше, чем молча показать 0.
  assert.strictEqual(subscriptionLessonShare(8000, 4, 9), 2000);
  assert.strictEqual(subscriptionLessonShare(8000, 4, -1), 2000);
  assert.strictEqual(subscriptionLessonShare(8000, 4, undefined), 2000);
});

// ===== roundRefundUp50 =====

test('возврат округляется вверх до 50', () => {
  assert.strictEqual(roundRefundUp50(1), 50);
  assert.strictEqual(roundRefundUp50(49), 50);
  assert.strictEqual(roundRefundUp50(50), 50);
  assert.strictEqual(roundRefundUp50(51), 100);
  assert.strictEqual(roundRefundUp50(2312), 2350);
});

test('нулевой и отрицательный возврат — это ноль, не отрицательное число', () => {
  assert.strictEqual(roundRefundUp50(0), 0);
  assert.strictEqual(roundRefundUp50(-100), 0);
});

// ===== calcRefund =====

const singlePrice = { student_price: 1000, teacher_profit: 600, commission: 400 };

test('возврат: половина абонемента использована', () => {
  const sub = { total_lessons: 8, paid_amount: 7000 };
  const r = calcRefund(sub, singlePrice, 4);
  assert.strictEqual(r.used, 4);
  assert.strictEqual(r.newPaidExact, 4000);   // 4 × 1000 по разовому тарифу
  assert.strictEqual(r.refundExact, 3000);    // 7000 − 4000
  assert.strictEqual(r.refund, 3000);         // уже кратно 50
  assert.strictEqual(r.effectivePaid, 4000);
});

test('части возврата всегда дают в сумме ровно возврат', () => {
  // Самое важное свойство: если части не сходятся, преподаватель и центр
  // насчитают разные суммы и будут спорить.
  const cases = [
    [{ total_lessons: 8, paid_amount: 7000 }, 4],
    [{ total_lessons: 8, paid_amount: 9250 }, 3],
    [{ total_lessons: 4, paid_amount: 4444 }, 1],
    [{ total_lessons: 8, paid_amount: 7777 }, 7],
    [{ total_lessons: 4, paid_amount: 5000 }, 0],
  ];
  for (const [sub, used] of cases) {
    const r = calcRefund(sub, singlePrice, used);
    assert.strictEqual(r.refundFromCenter + r.refundFromTeacher, r.refund,
      `части не сошлись для ${sub.paid_amount} ₽, использовано ${used}`);
  }
});

test('доля центра в возврате не превышает сам возврат', () => {
  const sub = { total_lessons: 8, paid_amount: 4020 };
  const r = calcRefund(sub, singlePrice, 3);
  assert.ok(r.refundFromCenter <= r.refund);
  assert.ok(r.refundFromTeacher >= 0);
});

test('число использованных занятий зажимается в допустимые границы', () => {
  const sub = { total_lessons: 8, paid_amount: 7000 };
  assert.strictEqual(calcRefund(sub, singlePrice, 99).used, 8);
  assert.strictEqual(calcRefund(sub, singlePrice, -3).used, 0);
  assert.strictEqual(calcRefund(sub, singlePrice, 'abc').used, 0);
  assert.strictEqual(calcRefund(sub, singlePrice, '').used, 0);
});

test('использованы все занятия — возврата нет', () => {
  const sub = { total_lessons: 8, paid_amount: 7000 };
  const r = calcRefund(sub, singlePrice, 8);
  assert.strictEqual(r.newPaidExact, 8000);
  assert.strictEqual(r.refundExact, -1000);  // потратил больше, чем стоил абонемент
  assert.strictEqual(r.refund, 0);           // но возврат не может быть отрицательным
});

test('ничего не использовано — возвращается вся сумма', () => {
  const sub = { total_lessons: 8, paid_amount: 7000 };
  const r = calcRefund(sub, singlePrice, 0);
  assert.strictEqual(r.refund, 7000);
  assert.strictEqual(r.effectivePaid, 0);
});

test('нулевая разовая цена не роняет расчёт делением на ноль', () => {
  const zero = { student_price: 0, teacher_profit: 0, commission: 0 };
  const r = calcRefund({ total_lessons: 8, paid_amount: 7000 }, zero, 4);
  assert.ok(Number.isFinite(r.refund));
  assert.strictEqual(r.refundFromCenter + r.refundFromTeacher, r.refund);
});
