// 通知（トースト）のキャラ。うまくいったときの通知（{ art: true }）にだけ番号を付け、
// ちいかわのイベントでは CSS がその番号のキャラ（12体）を出す。エラーの通知には出さない。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

function setup() {
  const el = { textContent: '', dataset: {}, classList: { add() {}, remove() {} } };
  const { showToast } = loadFunctions(['showToast'], {
    document: { getElementById: () => el },
    _toastTimer: null, setTimeout: () => 0, clearTimeout: () => {},
  });
  return { el, showToast };
}

test('うまくいった通知には 0〜11 の番号が付き、何度も出すと色々なキャラになる', () => {
  const { el, showToast } = setup();
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    showToast('山田 さんの回答を登録しました', { art: true });
    const n = Number(el.dataset.art);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 12, el.dataset.art);
    seen.add(n);
  }
  assert.equal(seen.size, 12);
});

test('エラーなどの通知では前の番号を消し、キャラを出さない', () => {
  const { el, showToast } = setup();
  showToast('保存しました', { art: true });
  showToast('通信に失敗しました。もう一度お試しください');
  assert.equal(el.dataset.art, undefined);
  assert.equal(el.textContent, '通信に失敗しました。もう一度お試しください');
});
