// 精算の均等割り金額の端数配分（evenSplitAmounts）の特性化テスト。
// 「各人の金額を個別に丸めて端数が失われ、合計が総額と1〜2円ずれる」バグの再発防止。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { evenSplitAmounts } = loadFunctions(['evenSplitAmounts']);

test('割り切れる場合は全員同額', () => {
  assert.deepEqual(evenSplitAmounts(9000, 3), [3000, 3000, 3000]);
});

test('端数は先頭から1円ずつ配分し、合計は必ず総額ぴったり', () => {
  assert.deepEqual(evenSplitAmounts(10000, 3), [3334, 3333, 3333]);
  assert.equal(evenSplitAmounts(10000, 3).reduce((s, v) => s + v, 0), 10000);
  assert.deepEqual(evenSplitAmounts(10000, 7), [1429, 1429, 1429, 1429, 1428, 1428, 1428]);
  assert.equal(evenSplitAmounts(10000, 7).reduce((s, v) => s + v, 0), 10000);
});

test('さまざまな総額・人数で必ず合計＝総額（端数の喪失なし）', () => {
  for (const total of [1, 100, 1234, 9999, 30000, 55555]) {
    for (const count of [1, 2, 3, 5, 7, 12, 20]) {
      const arr = evenSplitAmounts(total, count);
      assert.equal(arr.length, count);
      assert.equal(arr.reduce((s, v) => s + v, 0), total, `総額${total}/${count}人で合計がずれた`);
      // 各人の差は高々1円
      assert.ok(Math.max(...arr) - Math.min(...arr) <= 1);
    }
  }
});

test('総額0・人数0は安全に空/0を返す', () => {
  assert.deepEqual(evenSplitAmounts(0, 3), [0, 0, 0]);
  assert.deepEqual(evenSplitAmounts(10000, 0), []);
});

test('全員100%（均等割り）の再現：baseShare×100/100の合計が総額', () => {
  // 各人の金額 = round(baseShare * 100 / 100) = baseShare。合計は総額ぴったり
  const shares = evenSplitAmounts(10000, 3);
  const amounts = shares.map(b => Math.round(b * 100 / 100));
  assert.equal(amounts.reduce((s, v) => s + v, 0), 10000);
});
