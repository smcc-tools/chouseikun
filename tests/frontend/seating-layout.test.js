// 卓の向き・配置まわりの特性化テスト。
// 縦向きは「見た目の90度回転」であり席の隣接関係は変わらない、という設計判断を固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { tableRowCounts } = loadFunctions(['tableRowCounts']);

test('偶数定員は半々に分かれる', () => {
  assert.deepEqual(tableRowCounts({ capacity: 8, shape: 'rect' }), { first: 4, second: 4 });
});

test('奇数定員はsplit未設定なら先に描く側を多くする', () => {
  assert.deepEqual(tableRowCounts({ capacity: 7, shape: 'rect' }), { first: 4, second: 3 });
});

test("split='bottom' なら先に描く側を少なくする", () => {
  assert.deepEqual(tableRowCounts({ capacity: 7, shape: 'rect', split: 'bottom' }), { first: 3, second: 4 });
});

test('向き(orient)は席数の配分に影響しない（見た目が回るだけ）', () => {
  const h = tableRowCounts({ capacity: 7, shape: 'rect', orient: 'h' });
  const v = tableRowCounts({ capacity: 7, shape: 'rect', orient: 'v' });
  assert.deepEqual(h, v);
});

test('円卓は全席が1つの並びになる', () => {
  assert.deepEqual(tableRowCounts({ capacity: 6, shape: 'round' }), { first: 6, second: 0 });
});

test('first + second は必ず定員に一致する', () => {
  for (const cap of [0, 1, 2, 3, 7, 12, 20]) {
    for (const split of [undefined, 'top', 'bottom']) {
      const r = tableRowCounts({ capacity: cap, shape: 'rect', split });
      assert.equal(r.first + r.second, cap, `定員${cap}/split=${split} で合計がずれた`);
    }
  }
});

test('定員が未設定・不正でも落ちない', () => {
  for (const t of [{}, null, undefined, { capacity: 'abc' }, { capacity: -3 }]) {
    const r = tableRowCounts(t);
    assert.ok(Number.isInteger(r.first) && Number.isInteger(r.second));
    assert.ok(r.first >= 0 && r.second >= 0);
  }
});
