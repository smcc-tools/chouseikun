// 座席の「確定」判定の特性化テスト。
// 未設定を未確定として扱う（移行処理を書かないための前提）ことを固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { isPartyConfirmed } = loadFunctions(['isPartyConfirmed']);

test('confirmed 未設定の次会は未確定', () => {
  assert.equal(isPartyConfirmed({ id: 'p1', name: '1次会' }), false);
});

test('confirmed:false は未確定', () => {
  assert.equal(isPartyConfirmed({ id: 'p1', confirmed: false }), false);
});

test('confirmed:true は確定', () => {
  assert.equal(isPartyConfirmed({ id: 'p1', confirmed: true }), true);
});

test('null / undefined は未確定（呼び出し側で分岐を書かなくて済むように）', () => {
  assert.equal(isPartyConfirmed(null), false);
  assert.equal(isPartyConfirmed(undefined), false);
});

test('文字列の "true" は確定にしない（真偽値だけを認める）', () => {
  assert.equal(isPartyConfirmed({ confirmed: 'true' }), false);
});

test('1 は確定にしない', () => {
  assert.equal(isPartyConfirmed({ confirmed: 1 }), false);
});
