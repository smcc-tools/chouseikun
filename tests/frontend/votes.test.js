// 日程調整の投票集計 calcCounts の特性化テスト。
// ◯=1点、△=0.5点、✕=0点、未投票=0点 という重み付けを固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { calcCounts } = loadFunctions(['calcCounts']);

test('◯は1点、△は0.5点、✕と未投票は0点', () => {
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];
  const entries = [
    ['太郎', { 0: 'o', 1: 't', 2: 'x' }],       // 3列目(idx3)は未投票
    ['花子', { 0: 'o', 1: 'o', 2: 't', 3: 'x' }],
  ];
  assert.deepEqual(calcCounts(dates, entries), [2, 1.5, 0.5, 0]);
});

test('参加者ゼロなら全日程0点', () => {
  assert.deepEqual(calcCounts(['2026-07-20', '2026-07-21'], []), [0, 0]);
});

test('日程ゼロなら空配列', () => {
  assert.deepEqual(calcCounts([], [['太郎', { 0: 'o' }]]), []);
});

test('投票トグルで解除された（キーごと消えた）票は0点として扱う', () => {
  // deleteField() で Firestore から消えたキーは undefined になる
  const dates = ['2026-07-20', '2026-07-21'];
  const entries = [['太郎', { 1: 't' }]];
  assert.deepEqual(calcCounts(dates, entries), [0, 0.5]);
});

test('△だけの日は小数の合計になる（3人の△=1.5）', () => {
  const dates = ['2026-07-20'];
  const entries = [
    ['A', { 0: 't' }],
    ['B', { 0: 't' }],
    ['C', { 0: 't' }],
  ];
  assert.deepEqual(calcCounts(dates, entries), [1.5]);
});
