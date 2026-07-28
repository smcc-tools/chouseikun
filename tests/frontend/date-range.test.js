// 日程の範囲追加 expandDateRange の特性化テスト。
// 作成画面とホスト画面の「日程を追加」が共通で使うため、ここが崩れると両方が壊れる。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { expandDateRange } = loadFunctions(['expandDateRange']);

test('開始日と終了日の間を1日ずつ列挙する', () => {
  assert.deepEqual(expandDateRange('2026-08-01', '2026-08-04', ''),
    ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
});

test('時刻を指定すると全日付に付く', () => {
  assert.deepEqual(expandDateRange('2026-08-01', '2026-08-02', '19:00'),
    ['2026-08-01 19:00', '2026-08-02 19:00']);
});

test('終了日が未入力なら開始日の1日だけ', () => {
  assert.deepEqual(expandDateRange('2026-08-01', '', ''), ['2026-08-01']);
  assert.deepEqual(expandDateRange('2026-08-01', null, ''), ['2026-08-01']);
});

test('開始日と終了日が同じなら1日だけ', () => {
  assert.deepEqual(expandDateRange('2026-08-01', '2026-08-01', ''), ['2026-08-01']);
});

test('終了日が開始日より前なら空（呼び出し側でエラー表示する）', () => {
  assert.deepEqual(expandDateRange('2026-08-05', '2026-08-01', ''), []);
});

test('開始日が無ければ空', () => {
  for (const v of ['', null, undefined]) assert.deepEqual(expandDateRange(v, '2026-08-01', ''), []);
});

test('月をまたぐ範囲でゼロ埋めが崩れない', () => {
  assert.deepEqual(expandDateRange('2026-08-30', '2026-09-02', ''),
    ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});

test('年をまたぐ範囲', () => {
  assert.deepEqual(expandDateRange('2026-12-30', '2027-01-02', ''),
    ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('うるう年の2/29を飛ばさない', () => {
  assert.deepEqual(expandDateRange('2028-02-27', '2028-03-01', ''),
    ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
});

test('うるう年でない年は2/29を作らない', () => {
  assert.deepEqual(expandDateRange('2026-02-27', '2026-03-01', ''),
    ['2026-02-27', '2026-02-28', '2026-03-01']);
});

test('夏時間の無い日本時間でも日付がずれない（1年ぶん全て連続）', () => {
  const r = expandDateRange('2026-01-01', '2026-12-31', '');
  assert.equal(r.length, 365);
  assert.equal(r[0], '2026-01-01');
  assert.equal(r[364], '2026-12-31');
});

test('年単位の誤指定は400件で打ち切る（ブラウザの固まり・大量書き込みを防ぐ）', () => {
  const r = expandDateRange('2026-01-01', '2036-01-01', '');
  assert.equal(r.length, 400);
});

test('不正な日付文字列は空を返す', () => {
  for (const bad of ['2026-13-45', 'あした', '2026/08/01']) {
    assert.deepEqual(expandDateRange(bad, bad, ''), [], `${bad} が受理された`);
  }
});
