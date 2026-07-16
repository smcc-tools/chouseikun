const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrderInput } = require('../index');

test('入力検証: 正常系（全項目）', () => {
  const r = validateOrderInput({ shop: ' 銀座うち山 ', partySize: 4, budget: 5000, mood: '肉多め', excludeDishes: ['A'] });
  assert.deepEqual(r, { shop: '銀座うち山', partySize: 4, budget: 5000, mood: '肉多め', excludeDishes: ['A'] });
});

test('入力検証: 店名なし・201字はエラー', () => {
  assert.equal(validateOrderInput({ shop: '  ', partySize: 2 }).error, 'INVALID_ARG');
  assert.equal(validateOrderInput({ shop: 'あ'.repeat(201), partySize: 2 }).error, 'INVALID_ARG');
});

test('入力検証: 人数は整数1〜50のみ', () => {
  assert.equal(validateOrderInput({ shop: 'X', partySize: 0 }).error, 'INVALID_ARG');
  assert.equal(validateOrderInput({ shop: 'X', partySize: 51 }).error, 'INVALID_ARG');
  assert.equal(validateOrderInput({ shop: 'X', partySize: '3' }).partySize, 3); // 文字列数値は許容
});

test('入力検証: 予算は省略可・指定時は正の整数', () => {
  assert.equal(validateOrderInput({ shop: 'X', partySize: 2 }).budget, null);
  assert.equal(validateOrderInput({ shop: 'X', partySize: 2, budget: -100 }).error, 'INVALID_ARG');
});

test('入力検証: 好みは100字に切詰め・除外は21件でエラー・各60字切詰め', () => {
  assert.equal(validateOrderInput({ shop: 'X', partySize: 2, mood: 'あ'.repeat(150) }).mood.length, 100);
  assert.equal(validateOrderInput({ shop: 'X', partySize: 2, excludeDishes: Array(21).fill('a') }).error, 'INVALID_ARG');
  const r = validateOrderInput({ shop: 'X', partySize: 2, excludeDishes: ['', 'あ'.repeat(80)] });
  assert.deepEqual(r.excludeDishes, ['あ'.repeat(60)]); // 空要素は除去
});
