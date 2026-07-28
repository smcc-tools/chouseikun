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

// ── normalizeTableSlots の freeLayout ──
// ホストが「配置を調整」で意図的に空けた隙間を、詰めずに保つための引数。
// 既存の4件（freeLayout 未指定）は tests/frontend/seating.test.js 側で従来どおり通ること。

const { normalizeTableSlots } = loadFunctions(['normalizeTableSlots']);

test('freeLayout未指定なら従来どおり詰める（既存の挙動を壊さない）', () => {
  const a = { id: 'a', slot: 3 }, b = { id: 'b', slot: 0 };
  assert.deepEqual(normalizeTableSlots([a, b], 2), [b, a]);
});

test('freeLayout=true なら2卓×2列でも隙間を保つ', () => {
  const a = { id: 'a', slot: 3 }, b = { id: 'b', slot: 0 };
  assert.deepEqual(normalizeTableSlots([a, b], 2, true), [b, null, null, a]);
});

test('freeLayout=true で間に穴があいた配置を保つ', () => {
  const a = { id: 'a', slot: 0 }, b = { id: 'b', slot: 2 };
  assert.deepEqual(normalizeTableSlots([a, b], 3, true), [a, null, b]);
});

test('freeLayout=true でも末尾は列数の倍数まで埋める', () => {
  const a = { id: 'a', slot: 0 }, b = { id: 'b', slot: 4 };
  const r = normalizeTableSlots([a, b], 3, true);
  assert.equal(r.length % 3, 0, '行が半端に終わるとグリッドが崩れる');
  assert.equal(r[0], a);
  assert.equal(r[4], b);
});

test('freeLayout=true でも卓が無ければ空配列', () => {
  assert.deepEqual(normalizeTableSlots([], 2, true), []);
});

test('freeLayout=true でも重複slotは空きへ退避する', () => {
  const a = { id: 'a', slot: 1 }, b = { id: 'b', slot: 1 };
  const r = normalizeTableSlots([a, b], 2, true);
  assert.equal(r.filter(Boolean).length, 2, '卓が消えてはいけない');
});
