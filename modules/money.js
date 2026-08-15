// ===== MONEY =====
// Pure arithmetic for everything involving rubles. Kept free of DOM and network so
// it can be unit-tested in Node (see tests/money.test.js) — money bugs are the most
// expensive kind here, and they are silent: nothing throws, the numbers are just wrong.
//
// Rule for this file: no side effects, no globals read, no `db`. Inputs → number out.

// Per-lesson share of a subscription, distributed so the parts sum EXACTLY to `amount`.
//
// The naive Math.round(amount / total) per lesson loses or invents rubles: 9250 over
// 4 lessons rounds to 2313 each = 9252, two rubles that never existed. Over a month of
// subscriptions that becomes a visible discrepancy in the payroll a client will ask about.
//
// Instead each lesson gets the difference between two cumulative floors:
//     share(i) = floor(amount·(i+1)/n) − floor(amount·i/n)
// The cumulative sums telescope, so the total is exactly `amount`, and each lesson's
// value depends only on its own index — payroll for one week returns the same number
// regardless of which other weeks happen to be loaded.
//
// index is 0-based. Out-of-range indexes (more linked lessons than total_lessons —
// possible if a subscription was over-used) fall back to the flat floor share rather
// than silently returning 0.
function subscriptionLessonShare(amount, totalLessons, index) {
  const amt = Number(amount) || 0;
  const n = Number(totalLessons) || 0;
  if (n <= 0) return 0;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= n) return Math.floor(amt / n);
  return Math.floor((amt * (i + 1)) / n) - Math.floor((amt * i) / n);
}

// Round a refund up to the nearest 50 ₽ — the centre pays cash and wants human amounts.
// Negative input means the student used more slots than the subscription held; that is
// a data problem surfaced elsewhere, here it clamps to 0 rather than returning a
// negative "refund".
function roundRefundUp50(n) {
  const v = Number(n) || 0;
  if (v <= 0) return 0;
  return Math.ceil(v / 50) * 50;
}

// Full refund breakdown for a subscription recalculated at the single-lesson tariff.
//
// `used` lessons are re-priced at the one-off rate; the difference goes back to the
// student, rounded up to 50. That rounding is then split: the centre's part is also
// rounded up to 50 and the teacher covers the remainder, so the two parts always add
// up to exactly the refund shown to the student (a split that didn't sum would be the
// worst kind of bug here — both sides would compute different payouts).
function calcRefund(sub, singlePrice, usedInput) {
  const total = Number(sub.total_lessons) || 0;
  const paid = Number(sub.paid_amount) || 0;
  const usedRaw = parseInt(usedInput, 10);
  const used = Math.max(0, Math.min(isNaN(usedRaw) ? 0 : usedRaw, total));

  const newPaidExact = used * singlePrice.student_price;
  const newTeacher = used * singlePrice.teacher_profit;
  const newCenter = used * singlePrice.commission;

  const refundExact = paid - newPaidExact;
  const refund = roundRefundUp50(refundExact);
  const effectivePaid = paid - refund;

  const teacherRatio = singlePrice.student_price > 0
    ? singlePrice.teacher_profit / singlePrice.student_price
    : 0;
  const rawCenter = refund * (1 - teacherRatio);
  let refundFromCenter = Math.ceil(rawCenter / 50) * 50;
  if (refundFromCenter > refund) refundFromCenter = refund;
  const refundFromTeacher = refund - refundFromCenter;

  return {
    used, newPaidExact, newTeacher, newCenter,
    refundExact, refund, effectivePaid,
    refundFromCenter, refundFromTeacher
  };
}

// Node-only export so tests can require this file. `module` is undefined in the
// browser, where these stay plain globals like every other module here.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { subscriptionLessonShare, roundRefundUp50, calcRefund };
}
