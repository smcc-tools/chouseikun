// 割り勘の参加者向け表示の特性化テスト。
//
// 参加者画面はホストと同じものを全部出しており、一番知りたい精算結果が最下部、
// メンバー欄（改名・削除ボタン付き5行）が最上部で画面の1/3強を占めていた。
// メンバーは畳んで1行のまとめにする（増減できること自体は参加者も同じ）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { memberSummaryText } = loadFunctions(['memberSummaryText']);

test('人数と名前を並べる', () => {
  assert.equal(memberSummaryText(['田中', '佐藤', '鈴木']), '3人：田中・佐藤・鈴木');
});

test('1人でも同じ形', () => {
  assert.equal(memberSummaryText(['田中']), '1人：田中');
});

test('多いときは打ち切って「ほか○人」を添える', () => {
  const m = ['田中', '佐藤', '鈴木', '高橋', '伊藤', '渡辺', '山本', '中村'];
  assert.equal(memberSummaryText(m), '8人：田中・佐藤・鈴木・高橋・伊藤・渡辺 ほか2人');
});

test('打ち切り数ちょうどなら「ほか」を付けない', () => {
  const m = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(memberSummaryText(m), '6人：a・b・c・d・e・f');
});

test('打ち切り数は指定できる', () => {
  assert.equal(memberSummaryText(['a', 'b', 'c'], 2), '3人：a・b ほか1人');
});

test('空なら人数を出さず、その旨を返す', () => {
  assert.equal(memberSummaryText([]), 'メンバーがいません');
});

test('null / undefined でも壊れない', () => {
  assert.equal(memberSummaryText(null), 'メンバーがいません');
  assert.equal(memberSummaryText(undefined), 'メンバーがいません');
});

test('空文字の混入は数えない', () => {
  assert.equal(memberSummaryText(['田中', '', null, '佐藤']), '2人：田中・佐藤');
});
