const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOrderPlanRequestBody, parseOrderPlanResponse, validateOrderPlan, extractSourceUrls } = require('../prompt');

// ── buildOrderPlanRequestBody ──

test('リクエスト: 店名・人数は必ずユーザーメッセージに入る', () => {
  const body = buildOrderPlanRequestBody({ shop: '銀座うち山', partySize: 4, budget: null, mood: '', excludeDishes: [] });
  const user = body.contents[0].parts[0].text;
  assert.ok(user.includes('銀座うち山'));
  assert.ok(user.includes('4人'));
});

test('リクエスト: 予算・好み・除外リストは指定時のみ注入される', () => {
  const none = buildOrderPlanRequestBody({ shop: 'X', partySize: 2, budget: null, mood: '', excludeDishes: [] });
  assert.ok(!none.contents[0].parts[0].text.includes('予算'));
  const full = buildOrderPlanRequestBody({ shop: 'X', partySize: 2, budget: 4000, mood: '肉多め', excludeDishes: ['ポテサラ', '唐揚げ'] });
  const t = full.contents[0].parts[0].text;
  assert.ok(t.includes('¥4000'));
  assert.ok(t.includes('肉多め'));
  assert.ok(t.includes('ポテサラ、唐揚げ'));
});

test('リクエスト: google_search ツールと実在メニュー厳格ルールを含む', () => {
  const body = buildOrderPlanRequestBody({ shop: 'X', partySize: 2, budget: null, mood: '', excludeDishes: [] });
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('最低3回'), '多観点検索の指示');
  assert.ok(sys.includes('shopFound'), '情報不足時の返し方の指示');
});

// ── parseOrderPlanResponse ──

const wrap = (text) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
const VALID = {
  shopFound: true,
  plan: [
    { category: '前菜', items: [{ name: 'ポテサラ', qty: 2, price: '¥500前後', why: '定番' }] },
    { category: 'メイン', items: [{ name: '焼き鳥盛り', qty: 2, price: '¥1,200前後', why: '看板' }] },
  ],
  totalEstimate: '¥3,000/人 前後',
  notes: '',
};

test('パース: コードフェンス付きでも最初の{から最後の}を抽出する', () => {
  const p = parseOrderPlanResponse(wrap('```json\n' + JSON.stringify(VALID) + '\n```'));
  assert.equal(p.shopFound, true);
  assert.equal(p.plan.length, 2);
  assert.equal(p.plan[0].items[0].name, 'ポテサラ');
});

test('パース: 壊れたJSONは診断情報付きで throw する', () => {
  assert.throws(() => parseOrderPlanResponse(wrap('{"shopFound": true, "plan": [')), /failed to parse JSON/);
});

test('パース: 空応答は blockReason/finishReason を含めて throw する', () => {
  assert.throws(() => parseOrderPlanResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }), /blockReason=SAFETY/);
  assert.throws(() => parseOrderPlanResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }), /finishReason=SAFETY/);
});

test('パース: qty が文字列 "2" でも整数に正規化される', () => {
  const j = JSON.parse(JSON.stringify(VALID));
  j.plan[0].items[0].qty = '2';
  const p = parseOrderPlanResponse(wrap(JSON.stringify(j)));
  assert.equal(p.plan[0].items[0].qty, 2);
});

// ── validateOrderPlan ──

test('検証: 正常なプランは true', () => {
  assert.equal(validateOrderPlan(VALID), true);
});

test('検証: カテゴリ1個 or 6個は false（2〜5の範囲外）', () => {
  const one = { ...VALID, plan: VALID.plan.slice(0, 1) };
  assert.equal(validateOrderPlan(one), false);
  const six = { ...VALID, plan: Array.from({ length: 6 }, () => VALID.plan[0]) };
  assert.equal(validateOrderPlan(six), false);
});

test('検証: カテゴリ内 0品 or 5品は false（1〜4の範囲外）', () => {
  const zero = JSON.parse(JSON.stringify(VALID)); zero.plan[0].items = [];
  assert.equal(validateOrderPlan(zero), false);
  const five = JSON.parse(JSON.stringify(VALID));
  five.plan[0].items = Array.from({ length: 5 }, () => VALID.plan[0].items[0]);
  assert.equal(validateOrderPlan(five), false);
});

test('検証: name/why 空・qty 0 は false', () => {
  const noName = JSON.parse(JSON.stringify(VALID)); noName.plan[0].items[0].name = '';
  assert.equal(validateOrderPlan(noName), false);
  const qty0 = JSON.parse(JSON.stringify(VALID)); qty0.plan[0].items[0].qty = 0;
  assert.equal(validateOrderPlan(qty0), false);
});

test('検証: totalEstimate 空・shopFound false は false', () => {
  assert.equal(validateOrderPlan({ ...VALID, totalEstimate: '' }), false);
  assert.equal(validateOrderPlan({ ...VALID, shopFound: false }), false);
  assert.equal(validateOrderPlan(null), false);
});

// ── extractSourceUrls ──

test('extractSourceUrls: http(s)以外のスキームは除外し、重複除去・最大5件', () => {
  const { extractSourceUrls } = require('../prompt');
  const mk = uris => ({ candidates: [{ groundingMetadata: { groundingChunks: uris.map(u => ({ web: { uri: u } })) } }] });
  const urls = extractSourceUrls(mk(['https://a.com', 'javascript:alert(1)', 'https://a.com', 'http://b.com', 'https://c.com', 'https://d.com', 'https://e.com', 'https://f.com']));
  assert.deepEqual(urls, ['https://a.com', 'http://b.com', 'https://c.com', 'https://d.com', 'https://e.com']);
});

// ── extras（追加のおすすめ2品程度） ──

test('systemInstruction: extras（追加のおすすめ）の指示と出力形式を含む', () => {
  const body = buildOrderPlanRequestBody({ shop: 'X', partySize: 2, budget: null, mood: '', excludeDishes: [] });
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('extras'), 'extras フィールドの言及');
  assert.ok(sys.includes('2品程度'), '品数の目安');
});

test('パース: extras は最大3件に切詰め・name無しは除外・qty不要', () => {
  const j = JSON.parse(JSON.stringify(VALID));
  j.extras = [
    { name: '追加A', price: '¥600前後', why: '余裕があれば' },
    { name: '', price: '¥1', why: 'name無し' },
    { name: '追加B', why: '' },
    { name: '追加C', price: '', why: 'w' },
    { name: '追加D', price: '', why: 'w' },
  ];
  const p = parseOrderPlanResponse(wrap(JSON.stringify(j)));
  assert.deepEqual(p.extras.map(e => e.name), ['追加A', '追加B', '追加C']);
  assert.equal(p.extras[0].price, '¥600前後');
});

test('パース: extras が無い応答でも空配列で壊れない・validateも通る', () => {
  const p = parseOrderPlanResponse(wrap(JSON.stringify(VALID)));
  assert.deepEqual(p.extras, []);
  assert.equal(validateOrderPlan(p), true);
});
