// 事前登録された参加者の列（全日未回答＝isPreset）の判定。
//
// 事前登録の列は「初回入力」なので ◯△✕ を編集モードなしで直接押せる。
// ところが「全て◯／✕」の一括ボタンは新規入力列にしか作られておらず、
// ホストが先に名前だけ登録した参加者には一括の近道が無かった。
// 判定を2箇所に書くと食い違うので、純粋関数に切り出してここで固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { isPresetEntry } = loadFunctions(['isPresetEntry']);

test('全ての候補日が未回答なら事前登録の列', () => {
  assert.equal(isPresetEntry({ _note: '', _joinedAt: 1 }, 3), true);
});

test('1日でも回答していれば事前登録の列ではない', () => {
  assert.equal(isPresetEntry({ 0: '', 1: 'o', 2: '' }, 3), false);
});

test('最後の1日だけ回答していても事前登録の列ではない', () => {
  assert.equal(isPresetEntry({ 2: 'x' }, 3), false);
});

test('全日回答済みは事前登録の列ではない', () => {
  assert.equal(isPresetEntry({ 0: 'o', 1: 't', 2: 'x' }, 3), false);
});

test('候補日が0件なら true（既存の dates.every と同じ挙動）', () => {
  assert.equal(isPresetEntry({ 0: 'o' }, 0), true);
});

test('votes が無くても壊れない', () => {
  assert.equal(isPresetEntry(null, 3), true);
  assert.equal(isPresetEntry(undefined, 3), true);
});

test('候補日より後ろに残った回答は見ない（日程を削除した後の残骸）', () => {
  // 候補日を3件に減らしたが、votes には削除前の index 3 が残っている
  assert.equal(isPresetEntry({ 3: 'o' }, 3), true);
});

test('備考や参加時刻は判定に影響しない', () => {
  assert.equal(isPresetEntry({ _note: '遅れます', _joinedAt: 999 }, 2), true);
});

test('空文字の回答は未回答として扱う', () => {
  assert.equal(isPresetEntry({ 0: '', 1: '' }, 2), true);
});

test('候補日数が文字列でも数として扱う', () => {
  assert.equal(isPresetEntry({ 1: 'o' }, '3'), false);
});
