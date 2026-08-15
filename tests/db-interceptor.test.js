// Tests for the write-error interceptor in modules/config.js.
//
// The interceptor is the riskiest change in this codebase: it sits between every write
// and its caller. If it swallowed a result, changed a value, or broke chaining, the
// damage would be everywhere at once and hard to trace. These tests pin the contract:
// pass everything through untouched, only add reporting.
//
// config.js can't be required directly (it calls createClient at load), so the
// interceptor is rebuilt here from the same source lines. If you change the wrapper in
// config.js, mirror it here — the tests below are what tell you the contract still holds.

const { test } = require('node:test');
const assert = require('node:assert');

// --- Minimal stand-in for a postgrest builder: thenable, chainable, returns itself ---
function makeBuilder(result) {
  const b = {
    _result: result,
    eq() { return this; },
    in() { return this; },
    select() { return this; },
    single() { return this; },
    then(onF, onR) { return Promise.resolve(this._result).then(onF, onR); }
  };
  ['insert', 'update', 'delete', 'upsert'].forEach(op => {
    b[op] = function () { return this; };
  });
  return b;
}

// --- The interceptor under test (mirrors modules/config.js) ---
function installInterceptor(db, hooks) {
  const RAW_FROM = db.from.bind(db);
  const WRITE_OPS = ['insert', 'update', 'delete', 'upsert'];

  function reportWriteError(table, op, error) {
    hooks.onReport(table, op, error);
  }

  function instrumentWrite(query, table, op) {
    if (!query || typeof query.then !== 'function') return query;
    const originalThen = query.then.bind(query);
    query.then = function (onFulfilled, onRejected) {
      return originalThen(
        (result) => {
          if (result && result.error) reportWriteError(table, op, result.error);
          return onFulfilled ? onFulfilled(result) : result;
        },
        onRejected
      );
    };
    return query;
  }

  db.from = function (table) {
    const builder = RAW_FROM(table);
    WRITE_OPS.forEach(op => {
      const original = builder[op];
      if (typeof original !== 'function') return;
      builder[op] = function (...args) {
        return instrumentWrite(original.apply(this, args), table, op);
      };
    });
    return builder;
  };
  return db;
}

function setup(result) {
  const reports = [];
  const db = installInterceptor(
    { from: () => makeBuilder(result) },
    { onReport: (table, op, error) => reports.push({ table, op, error }) }
  );
  return { db, reports };
}

const ERR = { data: null, error: { message: 'new row violates row-level security policy' } };
const OK = { data: [{ id: 'abc' }], error: null };

test('вызывающий код по-прежнему получает error — существующие обработчики не сломаны', async () => {
  const { db } = setup(ERR);
  const { data, error } = await db.from('lessons').insert({ x: 1 });
  assert.strictEqual(data, null);
  assert.strictEqual(error.message, ERR.error.message);
});

test('успешный результат проходит нетронутым', async () => {
  const { db, reports } = setup(OK);
  const res = await db.from('lessons').insert({ x: 1 });
  assert.deepStrictEqual(res.data, [{ id: 'abc' }]);
  assert.strictEqual(res.error, null);
  assert.strictEqual(reports.length, 0, 'при успехе ничего не репортим');
});

test('цепочки методов не ломаются', async () => {
  const { db, reports } = setup(ERR);
  const res = await db.from('lessons').update({ status: 'x' }).eq('id', 1).select().single();
  assert.strictEqual(res.error.message, ERR.error.message);
  assert.strictEqual(reports.length, 1, 'ошибка зарепорчена один раз, а не на каждый метод цепочки');
});

test('все четыре операции записи перехватываются', async () => {
  for (const op of ['insert', 'update', 'delete', 'upsert']) {
    const { db, reports } = setup(ERR);
    await db.from('lessons')[op]({ x: 1 });
    assert.strictEqual(reports.length, 1, `${op} не перехвачен`);
    assert.strictEqual(reports[0].op, op);
    assert.strictEqual(reports[0].table, 'lessons');
  }
});

test('чтение не перехватывается — репортим только записи', async () => {
  const { db, reports } = setup(ERR);
  await db.from('lessons').select().eq('id', 1);
  assert.strictEqual(reports.length, 0);
});

test('имя таблицы попадает в отчёт — иначе ошибку негде искать', async () => {
  const { db, reports } = setup(ERR);
  await db.from('subscriptions').update({ status: 'refunded' }).eq('id', 7);
  assert.strictEqual(reports[0].table, 'subscriptions');
});

test('несколько запросов подряд репортятся независимо', async () => {
  const { db, reports } = setup(ERR);
  await db.from('lessons').insert({});
  await db.from('students').delete().eq('id', 1);
  assert.strictEqual(reports.length, 2);
  assert.deepStrictEqual(reports.map(r => r.table), ['lessons', 'students']);
});

test('отклонённый промис пробрасывается наружу, а не проглатывается', async () => {
  const failing = {
    from: () => {
      const b = makeBuilder(null);
      b.then = (onF, onR) => Promise.reject(new Error('network down')).then(onF, onR);
      ['insert', 'update', 'delete', 'upsert'].forEach(op => { b[op] = function () { return this; }; });
      return b;
    }
  };
  const reports = [];
  const db = installInterceptor(failing, { onReport: (...a) => reports.push(a) });
  await assert.rejects(
    // Promise.resolve() around the thenable: assert.rejects requires a real Promise,
    // while the builder (like postgrest's) is only thenable.
    () => Promise.resolve(db.from('lessons').insert({})),
    /network down/
  );
  assert.strictEqual(reports.length, 0, 'отклонение — не результат с error, репортить нечего');
});
