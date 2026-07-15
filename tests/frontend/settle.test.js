// 精算の傾斜(weights)正規化の特性化テスト。
// 背景: settleWeights[name][pi] = pct の代入順によって配列に「穴」(undefined)ができ、
// Firestore が undefined を含む配列を拒否して精算の保存全体が失敗するバグがあった。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { sanitizeSettleWeights } = loadFunctions(['sanitizeSettleWeights']);

test('スパース配列（2次会だけ傾斜）の穴を100%で埋める', () => {
  const sparse = [];
  sparse[1] = 120; // 1次会は未操作、2次会だけ120%
  assert.deepEqual(sanitizeSettleWeights({ A: sparse }, 2), { A: [100, 120] });
});

test('全ての値が undefined を含まない密な配列になる（Firestore が受け付ける形）', () => {
  const sparse = [];
  sparse[2] = 80;
  const out = sanitizeSettleWeights({ A: sparse, B: [110] }, 3);
  for (const arr of Object.values(out)) {
    assert.equal(arr.length, 3);
    arr.forEach(v => assert.ok(Number.isFinite(v), `undefined/NaN が残っている: ${arr}`));
  }
  assert.deepEqual(out, { A: [100, 100, 80], B: [110, 100, 100] });
});

test('次会数より長い配列は切り詰める（何次会を減らした場合）', () => {
  assert.deepEqual(sanitizeSettleWeights({ A: [100, 120, 90] }, 2), { A: [100, 120] });
});

test('配列でない値（壊れたデータ）は除外する', () => {
  assert.deepEqual(sanitizeSettleWeights({ A: 'broken', B: [100] }, 1), { B: [100] });
});

test('NaN は 100% に置き換える', () => {
  assert.deepEqual(sanitizeSettleWeights({ A: [NaN, 130] }, 2), { A: [100, 130] });
});

test('null/undefined 入力は空オブジェクトを返す', () => {
  assert.deepEqual(sanitizeSettleWeights(null, 2), {});
  assert.deepEqual(sanitizeSettleWeights(undefined, 2), {});
});
