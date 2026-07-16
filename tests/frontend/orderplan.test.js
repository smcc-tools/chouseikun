// AI注文提案のプラン描画の特性化テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { buildOrderPlanHtml } = loadFunctions(['escHtml', 'buildOrderPlanHtml']);

const PLAN = [
  { category: '前菜', items: [{ name: 'ポテサラ', qty: 2, price: '¥500前後', why: '定番の一品' }] },
  { category: 'メイン', items: [{ name: '焼き鳥盛り', qty: 3, price: '¥1,200前後', why: '看板メニュー' }] },
];

test('プラン・合計・補足・参考リンクが全て描画される', () => {
  const html = buildOrderPlanHtml(PLAN, '¥3,000/人 前後', 'L.O.は22時', ['https://example.com/a']);
  for (const s of ['前菜', 'ポテサラ', '× 2', '¥500前後', '合計目安', '¥3,000/人 前後', 'L.O.は22時', 'https://example.com/a']) {
    assert.ok(html.includes(s), `欠落: ${s}`);
  }
});

test('XSS: 品名・カテゴリ・URLの特殊文字はエスケープされる', () => {
  const evil = [{ category: '<img src=x>', items: [{ name: '<script>alert(1)</script>', qty: 1, price: '', why: '"quoted"' }] }];
  const html = buildOrderPlanHtml(evil, '<b>合計</b>', '', ['https://e.com/?a=1&b="x"']);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('<b>合計</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('qty が不正でも 1 として表示される', () => {
  const p = [{ category: 'A', items: [{ name: 'x', qty: 'zz', price: '', why: 'w' }] },
             { category: 'B', items: [{ name: 'y', qty: null, price: '', why: 'w' }] }];
  const html = buildOrderPlanHtml(p, 't', '', []);
  assert.equal((html.match(/× 1/g) || []).length, 2);
});

test('空プラン・空引数でも例外を投げず空文字系を返す', () => {
  assert.equal(buildOrderPlanHtml([], '', '', []), '');
  assert.equal(buildOrderPlanHtml(null, '', '', null), '');
});

test('extras（追加のおすすめ）があれば見出し付きで描画され、無ければ出ない', () => {
  const extras = [
    { name: 'とり福プリン', price: '¥450前後', why: 'デザートの隠れ名物' },
    { name: '梅きゅう', price: '', why: '箸休めに' },
  ];
  const withExtras = buildOrderPlanHtml(PLAN, '¥3,000/人 前後', '', [], extras);
  for (const s of ['追加のおすすめ', 'とり福プリン', '¥450前後', '梅きゅう']) {
    assert.ok(withExtras.includes(s), `欠落: ${s}`);
  }
  const without = buildOrderPlanHtml(PLAN, '¥3,000/人 前後', '', [], []);
  assert.ok(!without.includes('追加のおすすめ'));
});

test('extras の特殊文字もエスケープされる', () => {
  const html = buildOrderPlanHtml(PLAN, 't', '', [], [{ name: '<i>x</i>', price: '', why: '<u>y</u>' }]);
  assert.ok(!html.includes('<i>x</i>'));
  assert.ok(html.includes('&lt;i&gt;'));
});
