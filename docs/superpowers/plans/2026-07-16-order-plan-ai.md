# AI注文提案（注文提案ツール）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メニューから使える単体ツール「注文提案」— 店名/URL・人数・予算・好みを入力すると、AIが実在メニューだけで注文プラン一式を返す。

**Architecture:** venue-brief の実証済みパイプライン（Gemini pro-latest + Google検索グラウンディング、25秒個別タイムアウト、3回リトライ）を `functions/shared/gemini.js` に共通化し、新 callable `suggestOrderPlan` が使う。結果は Firestore に書かず戻り値で返す。フロントは `test/index.html` に単体カード1枚を追加。

**Tech Stack:** Firebase Cloud Functions v2 (Node 22, onCall), Gemini API (`gemini-pro-latest` + google_search grounding), 素の HTML/JS（単一ファイル）, node:test

## Global Constraints

- スペック: `docs/superpowers/specs/2026-07-16-order-plan-ai-design.md`（要件・エラー表・JSON形式はここが正）
- フロントの編集対象は **`test/index.html` のみ**（root `index.html` は promote スクリプト経由。直接編集禁止）
- functions テスト実行: `cd functions && npm test`（= `node --test venueBrief/tests/*.test.js`。orderPlan 追加時に glob を広げる）
- フロントテスト実行: `node --test tests/frontend/*.test.js`（リポジトリルートから）
- functions デプロイ: `firebase deploy --only functions:suggestOrderPlan --project chouseikun-tabel --account takedakyoichi0926@gmail.com`
- Firestore の読み書き・ルール変更は**一切なし**
- UI文言は日本語。「実在確認できたメニューのみ」方針（推測で埋めない）
- コミットメッセージ末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `functions/shared/gemini.js` の抽出（venueBrief から共通化）

**Files:**
- Create: `functions/shared/gemini.js`
- Modify: `functions/venueBrief/index.js`（callGemini / isRetryableError / 定数の定義を削除して import に置換）
- Test: 既存 `functions/venueBrief/tests/*.test.js`（53件・無修正で通ることが合格条件）

**Interfaces:**
- Produces: `callGemini(body, geminiKey) -> Promise<object>`（25秒タイムアウト、失敗時 `Error('GEMINI_TIMEOUT: ...')` or `Error('Gemini <status>: ...')`）、`isRetryableError(err) -> boolean`

- [ ] **Step 1: shared/gemini.js を作成**（内容は現在の `functions/venueBrief/index.js` の該当部を移す）

```js
// Gemini API 呼び出しの共通部品。venueBrief / orderPlan の両方から使う。
// gemini-2.5-pro は "no longer available to new users" で 404 のため、Pro 相当のエイリアス gemini-pro-latest を使う
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent';

// 1回の呼び出しに個別タイムアウトを設ける。これが無いと1回目の応答遅延だけで
// 関数全体の timeoutSeconds(90s) を食い潰し、2回目以降のリトライが実行されない。
// 25s × 3回 + 前後処理 < 90s に収まる設計。
const GEMINI_CALL_TIMEOUT_MS = 25000;

async function callGemini(body, geminiKey) {
  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(geminiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_CALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`GEMINI_TIMEOUT: no response in ${GEMINI_CALL_TIMEOUT_MS / 1000}s`); // 再試行対象
    }
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// - Gemini HTTP 4xx/5xx は認可/クォータ/仕様上の非可逆エラーなので即失敗（再試行しない）
// - SAFETY はプロンプトレベル(blockReason)・候補レベル(finishReason)とも同じ入力で再現するため再試行しない
// - JSON parse 失敗・タイムアウト・その他は一時的エラーとして再試行対象
function isRetryableError(err) {
  const msg = String((err && err.message) || '');
  if (/^Gemini \d+:/.test(msg)) return false;
  if (/blockReason=SAFETY/.test(msg)) return false;
  if (/finishReason=SAFETY/.test(msg)) return false;
  return true;
}

module.exports = { callGemini, isRetryableError, GEMINI_ENDPOINT, GEMINI_CALL_TIMEOUT_MS };
```

- [ ] **Step 2: venueBrief/index.js を import に切替**

`functions/venueBrief/index.js` から `GEMINI_ENDPOINT`・`GEMINI_CALL_TIMEOUT_MS`・`callGemini`・`isRetryableError` の定義を削除し、冒頭の require 群に追加:

```js
const { callGemini, isRetryableError } = require('../shared/gemini');
```

末尾の `module.exports = { generateVenueBriefImpl, isRetryableError };` は**そのまま残す**
（tests/index.test.js が venueBrief から isRetryableError を import しているため、re-export として機能させる）。

- [ ] **Step 3: 回帰テスト実行**

Run: `cd functions && npm test`
Expected: `tests 53 / pass 53 / fail 0`（無修正で全通過）

- [ ] **Step 4: Commit**

```bash
git add functions/shared/gemini.js functions/venueBrief/index.js
git commit -m "refactor(functions): Gemini呼び出しをshared/gemini.jsへ共通化（venueBriefは再輸出で互換維持）"
```

---

### Task 2: `functions/orderPlan/prompt.js`（TDD・純関数）

**Files:**
- Create: `functions/orderPlan/prompt.js`
- Test: `functions/orderPlan/tests/prompt.test.js`

**Interfaces:**
- Produces:
  - `buildOrderPlanRequestBody({shop, partySize, budget, mood, excludeDishes}) -> object`（Gemini リクエストボディ）
  - `parseOrderPlanResponse(apiJson) -> {shopFound, plan, totalEstimate, notes}`（壊れJSONは診断付き throw）
  - `validateOrderPlan(parsed) -> boolean`（構造検証。shopFound===true 前提の形チェック）
  - `extractSourceUrls(apiJson) -> string[]`（グラウンディング出典 最大5件）

- [ ] **Step 1: 失敗するテストを書く**（`functions/orderPlan/tests/prompt.test.js`）

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOrderPlanRequestBody, parseOrderPlanResponse, validateOrderPlan } = require('../prompt');

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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd functions && node --test orderPlan/tests/*.test.js`
Expected: FAIL（`Cannot find module '../prompt'`）

- [ ] **Step 3: prompt.js を実装**

```js
// AI注文提案: Gemini リクエスト組立とレスポンスパース。純粋関数のみ。
const SYS = `あなたは実在する飲食店のメニューをウェブ検索して、注文プランを組み立てるアシスタントです。

【最重要ルール — 実在メニューのみ】
- 必ず google_search で対象店舗を検索する。検索は最低3回、観点を変えて行う：
  ①「店名＋メニュー」②「店名＋口コミ＋おすすめ」③「店名＋公式サイト」
- 実在が確認できたメニューのみ提案する。推測や「このジャンルの定番」で埋めない。
- 別店舗の情報は絶対に使わない（同名の別店舗に特に注意）。
- メニュー情報が見つからない場合は {"shopFound": false, "plan": [], "totalEstimate": "", "notes": ""} を返す。

【プランの組み立て】
- 人数分をシェアして食べる前提で数量(qty)を決める。
- 予算が指定されていれば、合計が「人数×予算」を超えない構成にする。
- 好み・気分の指定があれば品選びに反映する。
- 「除外リスト」の品は前回提案済みのため提案しない。
- カテゴリは店に合わせて2〜5個（例: 居酒屋=前菜/焼き物/しめ、イタリアン=前菜/パスタ/メイン）。
- 各カテゴリ1〜4品。price は「¥800前後」のような目安表記。分からなければ「価格不明」。
- notes にはラストオーダーや量の注意など、あれば一言（任意・1文）。

【出力形式】
- 出力は必ず有効な JSON オブジェクト1つのみ。コードフェンスや前置きは一切含めない。
- 応答の1文字目は { 、最終文字は } でなければならない。

{"shopFound": true, "plan": [{"category": "前菜", "items": [{"name": "品名", "qty": 2, "price": "¥500前後", "why": "一言理由"}]}], "totalEstimate": "¥3,500/人 前後", "notes": "補足（任意）"}`;

function buildOrderPlanRequestBody({ shop, partySize, budget, mood, excludeDishes }) {
  const lines = ['【対象店舗と条件】'];
  lines.push(`- 店名/URL: ${shop}`);
  lines.push(`- 人数: ${partySize}人`);
  if (budget) lines.push(`- 予算: 1人あたり ¥${budget} 以内`);
  if (mood) lines.push(`- 好み・気分: ${mood}`);
  if (Array.isArray(excludeDishes) && excludeDishes.length) {
    lines.push(`- 除外リスト（前回提案済み）: ${excludeDishes.join('、')}`);
  }
  lines.push('');
  lines.push('必ず google_search で実際に検索し、この店の実在メニューだけで注文プランを JSON で返してください。');
  return {
    tools: [{ google_search: {} }],
    systemInstruction: { parts: [{ text: SYS }] },
    contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 1024 },
    },
  };
}

function parseOrderPlanResponse(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) {
    const pf = (apiJson && apiJson.promptFeedback) || {};
    const blockReason = pf.blockReason ? ` blockReason=${pf.blockReason}` : '';
    throw new Error(`gemini: empty candidates${blockReason}`);
  }
  const finishReason = cands[0].finishReason || '';
  const parts = (cands[0].content && cands[0].content.parts) || [];
  const rawText = parts.map(p => p.text || '').join('');
  if (!rawText) throw new Error(`gemini: empty parts text (finishReason=${finishReason || 'unknown'})`);
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`gemini: failed to parse JSON: no JSON object found (finishReason=${finishReason || 'unknown'}, textLen=${rawText.length})`);
  }
  const jsonText = rawText.slice(first, last + 1);
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`gemini: failed to parse JSON: ${e.message} (finishReason=${finishReason || 'unknown'}, jsonLen=${jsonText.length}, tail=${JSON.stringify(jsonText.slice(-40))})`);
  }
  return {
    shopFound: obj.shopFound === true,
    plan: Array.isArray(obj.plan) ? obj.plan.map(c => ({
      category: String((c && c.category) || '').trim(),
      items: Array.isArray(c && c.items) ? c.items.map(it => ({
        name: String((it && it.name) || '').trim(),
        qty: Number.isInteger(it && it.qty) ? it.qty : (parseInt(it && it.qty) || 0),
        price: String((it && it.price) || '').trim(),
        why: String((it && it.why) || '').trim(),
      })) : [],
    })) : [],
    totalEstimate: String(obj.totalEstimate || '').trim(),
    notes: String(obj.notes || '').trim(),
  };
}

function validateOrderPlan(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.shopFound !== true) return false;
  if (!Array.isArray(p.plan) || p.plan.length < 2 || p.plan.length > 5) return false;
  if (!p.totalEstimate || typeof p.totalEstimate !== 'string') return false;
  return p.plan.every(c => c && typeof c.category === 'string' && c.category
    && Array.isArray(c.items) && c.items.length >= 1 && c.items.length <= 4
    && c.items.every(it => it && typeof it.name === 'string' && it.name
      && typeof it.why === 'string' && it.why
      && Number.isInteger(it.qty) && it.qty > 0));
}

// グラウンディング出典（venueBrief/prompt.js と同形。8行のため重複を許容し独立性を優先）
function extractSourceUrls(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) return [];
  const chunks = (cands[0].groundingMetadata && cands[0].groundingMetadata.groundingChunks) || [];
  const seen = new Set();
  const urls = [];
  for (const c of chunks) {
    const uri = c && c.web && c.web.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    urls.push(uri);
    if (urls.length >= 5) break;
  }
  return urls;
}

module.exports = { buildOrderPlanRequestBody, parseOrderPlanResponse, validateOrderPlan, extractSourceUrls };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd functions && node --test orderPlan/tests/*.test.js`
Expected: 全 PASS（12件前後）

- [ ] **Step 5: Commit**

```bash
git add functions/orderPlan/prompt.js functions/orderPlan/tests/prompt.test.js
git commit -m "feat(order-plan): プロンプト組立・パース・検証の純関数とテスト"
```

---

### Task 3: `functions/orderPlan/index.js`（入力検証 TDD + 本体実装）

**Files:**
- Create: `functions/orderPlan/index.js`
- Test: `functions/orderPlan/tests/index.test.js`

**Interfaces:**
- Consumes: Task 1 の `callGemini`/`isRetryableError`、Task 2 の prompt 4関数
- Produces: `suggestOrderPlanImpl({uid, data, secrets}) -> Promise<{ok, plan, totalEstimate, notes, sourceUrls}>`、`validateOrderInput(data) -> {error} | {shop, partySize, budget, mood, excludeDishes}`

- [ ] **Step 1: validateOrderInput の失敗するテストを書く**（`functions/orderPlan/tests/index.test.js`）

```js
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
```

- [ ] **Step 2: 失敗を確認**

Run: `cd functions && node --test orderPlan/tests/index.test.js`
Expected: FAIL（`Cannot find module '../index'`）

- [ ] **Step 3: index.js を実装**

```js
// AI注文提案の本体。認証・入力検証・レート制限・Gemini呼び出し(最大3回)。
// Firestore の読み書きは行わない（結果は戻り値でその場限り）。
const { callGemini, isRetryableError } = require('../shared/gemini');
const { buildOrderPlanRequestBody, parseOrderPlanResponse, validateOrderPlan, extractSourceUrls } = require('./prompt');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）。key = uid
const _lastCallAt = new Map();
const RATE_LIMIT_MS = 10000; // 「別の案」連打対策で venue-brief(5s) より長め

function validateOrderInput(data) {
  const shop = String((data && data.shop) || '').trim();
  if (!shop || shop.length > 200) return { error: 'INVALID_ARG' };
  const partySize = parseInt(data.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 50) return { error: 'INVALID_ARG' };
  let budget = null;
  if (data.budget != null && data.budget !== '') {
    budget = parseInt(data.budget);
    if (!Number.isInteger(budget) || budget <= 0) return { error: 'INVALID_ARG' };
  }
  const mood = String(data.mood || '').trim().slice(0, 100);
  let excludeDishes = [];
  if (data.excludeDishes != null) {
    if (!Array.isArray(data.excludeDishes) || data.excludeDishes.length > 20) return { error: 'INVALID_ARG' };
    excludeDishes = data.excludeDishes.map(s => String(s).trim().slice(0, 60)).filter(Boolean);
  }
  return { shop, partySize, budget, mood, excludeDishes };
}

async function suggestOrderPlanImpl({ uid, data, secrets }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (!secrets || !secrets.geminiKey) throw new Error('SECRETS_MISSING');
  const input = validateOrderInput(data || {});
  if (input.error) throw new Error(input.error);

  const last = _lastCallAt.get(uid) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) throw new Error('RATE_LIMITED');
  _lastCallAt.set(uid, now);

  const body = buildOrderPlanRequestBody(input);
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const apiJson = await callGemini(body, secrets.geminiKey);
      const parsed = parseOrderPlanResponse(apiJson);
      if (parsed.shopFound === false) throw new Error('NO_RESULTS');
      if (!validateOrderPlan(parsed)) throw new Error('PLAN_INVALID');
      return {
        ok: true,
        plan: parsed.plan,
        totalEstimate: parsed.totalEstimate,
        notes: parsed.notes,
        sourceUrls: extractSourceUrls(apiJson),
      };
    } catch (e) {
      lastErr = e;
      if (e.message === 'NO_RESULTS') throw e; // 情報不足はリトライしても同じ
      if (!isRetryableError(e) || attempt === MAX_ATTEMPTS) throw e;
      console.warn(JSON.stringify({ fn: 'suggestOrderPlan', attempt, of: MAX_ATTEMPTS, retryable: true, error: String(e.message || e).slice(0, 300) }));
    }
  }
  throw lastErr;
}

module.exports = { suggestOrderPlanImpl, validateOrderInput, RATE_LIMIT_MS };
```

- [ ] **Step 4: テスト通過と npm test glob の拡張**

`functions/package.json` の test スクリプトを両モジュール対象に変更:

```json
"scripts": {
  "test": "node --test venueBrief/tests/*.test.js orderPlan/tests/*.test.js"
}
```

Run: `cd functions && npm test`
Expected: venueBrief 53件 + orderPlan 17件前後、全 PASS

- [ ] **Step 5: Commit**

```bash
git add functions/orderPlan/index.js functions/orderPlan/tests/index.test.js functions/package.json
git commit -m "feat(order-plan): suggestOrderPlanImpl（認証・検証・10秒レート制限・3回リトライ）"
```

---

### Task 4: `functions/index.js` に callable `suggestOrderPlan` を追加

**Files:**
- Modify: `functions/index.js`（末尾、generateVenueBrief の onCall 定義の直後）

**Interfaces:**
- Consumes: Task 3 の `suggestOrderPlanImpl`
- Produces: callable `suggestOrderPlan`（フロントから `httpsCallable(functions, 'suggestOrderPlan')` で呼ぶ）

- [ ] **Step 1: onCall を追加**（`onCall`/`HttpsError` は generateVenueBrief 用に import 済み。同じものを使う）

```js
// AI注文提案（Callable、ログイン必須・Firestore 書き込みなし）
const { suggestOrderPlanImpl } = require('./orderPlan');

exports.suggestOrderPlan = onCall({
  region: 'asia-northeast1',
  timeoutSeconds: 90,   // 25s×3回リトライ + 前後処理
  memory: '256MiB',
  secrets: ['GEMINI_API_KEY'],
}, async (request) => {
  const uid = request.auth && request.auth.uid;
  try {
    return await suggestOrderPlanImpl({
      uid,
      data: request.data || {},
      secrets: { geminiKey: process.env.GEMINI_API_KEY },
    });
  } catch (e) {
    const code = e.message === 'UNAUTHENTICATED' ? 'unauthenticated'
      : e.message === 'INVALID_ARG' ? 'invalid-argument'
      : e.message === 'RATE_LIMITED' ? 'resource-exhausted'
      : e.message === 'NO_RESULTS' ? 'not-found'
      : 'internal';
    throw new HttpsError(code, e.message);
  }
});
```

- [ ] **Step 2: 構文チェックとテスト**

Run: `cd functions && node --check index.js && npm test`
Expected: 構文OK・全テスト PASS

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "feat(order-plan): callable suggestOrderPlan を追加（HttpsErrorマップ付き）"
```

---

### Task 5: フロント — `aiErrorToJa` 共通化（briefErrorToJa の置換え）

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Produces: トップレベル関数 `aiErrorToJa(raw) -> string`（venue-brief と注文提案の両方が使う）

- [ ] **Step 1: 現在の briefErrorToJa の位置を確認**

Run: `grep -n "briefErrorToJa" test/index.html`
Expected: 関数定義1箇所 + 呼び出し2箇所（applyVenueBriefState 内の errDetail と invokeGenerateVenueBrief の catch）

- [ ] **Step 2: トップレベルへ移設・改名**

`briefErrorToJa` の関数定義を削除し、トップレベル（`function showToast` の近く）に以下を追加。
呼び出し2箇所を `aiErrorToJa(...)` に置換:

```js
  // AI機能（venue-brief / 注文提案）のエラーコードをユーザー向けの日本語に変換
  function aiErrorToJa(raw) {
    const rules = [
      [/RATE_LIMITED|resource-exhausted/i, '連続で実行されています。数秒おいてからもう一度お試しください'],
      [/SHOP_EMPTY|INVALID_ARG|invalid-argument/i, '入力内容を確認してください（お店の名前またはURLは必須です）'],
      [/NO_RESULTS/, 'このお店のメニュー情報が見つかりませんでした。店名や食べログURLを見直してください'],
      [/PERMISSION_DENIED|permission-denied/i, 'この操作はホストのみ実行できます'],
      [/UNAUTHENTICATED|unauthenticated/i, 'Googleログインが必要です'],
      [/GEMINI_TIMEOUT|deadline/i, 'AIの応答が時間内に返りませんでした。しばらくしてから再試行してください'],
      [/SAFETY/, 'AIが内容の生成を控えました。店名の表記を変えて試してください'],
      [/Gemini 429|quota/i, 'AIの利用枠が一時的に上限に達しています。時間をおいて再試行してください'],
    ];
    for (const [re, msg] of rules) if (re.test(raw)) return msg;
    return '取得に失敗しました。時間をおいてもう一度お試しください';
  }
```

- [ ] **Step 3: 構文チェックと確認**

Run:
```bash
grep -c "aiErrorToJa" test/index.html   # 定義1+呼び出し2 = 3以上
python3 -c "
import re
html = open('test/index.html').read()
s = re.findall(r'<script type=\"module\">(.*?)</script>', html, re.S)[0]
open('/tmp/mod.mjs','w').write(s)" && node --check /tmp/mod.mjs
```
Expected: briefErrorToJa の残存なし（`grep -c "briefErrorToJa" test/index.html` が 0）・構文OK

- [ ] **Step 4: Commit**

```bash
git add test/index.html
git commit -m "refactor(front): AIエラーの日本語変換を aiErrorToJa としてトップレベルへ共通化 (test)"
```

---

### Task 6: フロント — メニュータイル・orderAiCard・呼び出しハンドラ

**Files:**
- Modify: `test/index.html`（メニューHTML・カードHTML・ナビ・JS ハンドラ・`buildOrderPlanHtml`）

**Interfaces:**
- Consumes: Task 4 の callable、Task 5 の `aiErrorToJa`、既存 `escHtml`/`showToast`/`signIn`/`pushNav`/`hideOtherSetupCards`
- Produces: トップレベル純関数 `buildOrderPlanHtml(plan, totalEstimate, notes, sourceUrls) -> string`（Task 7 のテスト対象）

- [ ] **Step 1: メニュータイルを追加**（`menuAnnounceBtn` タイルの直後に挿入）

```html
    <div class="menu-tile" id="menuOrderAiBtn" role="button" tabindex="0">
      <div class="mt-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 3v7M4 3v4a3 3 0 0 0 6 0V3M7 13v8" stroke="#EDF1E4" stroke-width="2" stroke-linecap="round"/>
          <path d="M17 3c-2 2-2 5 0 7s2 5 0 7" stroke="#EDF1E4" stroke-width="2" stroke-linecap="round"/>
          <circle cx="19.5" cy="5.5" r="1.3" fill="#D9A73E"/>
        </svg>
      </div>
      <div class="mt-title">注文提案</div>
      <div class="mt-desc">お店で迷ったらAIが注文プランを提案</div>
    </div>
```

CSS の並び順ブロック（`#menuGourmetBtn { order:1; } ...`）に追記: `#menuOrderAiBtn { order:6; }`

- [ ] **Step 2: orderAiCard を追加**（`announceSetupCard` の閉じタグ直後に挿入）

```html
<!-- AI注文提案（単体ツール） -->
<div class="card" id="orderAiCard" style="display:none;">
  <button class="back-to-menu js-back-to-menu">← メニューに戻る</button>
  <h2 class="card-title">注文提案（AI）</h2>
  <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:16px;line-height:1.7;font-weight:400;">お店の実在メニューを調べて、人数・予算に合わせた注文プランをAIが提案します。</p>
  <label class="ve-lbl">お店（店名 or 食べログURL）</label>
  <input type="text" id="orderShopInput" placeholder="店名／食べログURL" style="margin-bottom:8px;">
  <div style="display:flex;gap:8px;margin-bottom:8px;">
    <div style="flex:1;">
      <label class="ve-lbl">人数</label>
      <input type="number" id="orderPartySizeInput" min="1" max="50" value="2" style="width:100%;margin-bottom:0;">
    </div>
    <div style="flex:1;">
      <label class="ve-lbl">予算/人（円・任意）</label>
      <input type="number" id="orderBudgetInput" min="0" placeholder="例: 4000" style="width:100%;margin-bottom:0;">
    </div>
  </div>
  <label class="ve-lbl">好み・気分（任意）</label>
  <input type="text" id="orderMoodInput" placeholder="例: 肉多め・お酒に合う・さっぱりめ" style="margin-bottom:14px;">
  <button class="btn btn-primary btn-full" id="orderSuggestBtn">注文プランを提案してもらう</button>
  <div id="orderPlanLoading" style="display:none;text-align:center;padding:14px;color:var(--text-muted);">メニューを調べています…（20〜40秒）</div>
  <div id="orderPlanError" style="display:none;margin-top:10px;padding:10px;background:#FDF2E9;border:1px solid #F0B090;border-radius:6px;">
    <div id="orderPlanErrorText" style="font-size:0.85rem;color:var(--text);"></div>
    <button class="btn btn-secondary" id="orderRetryBtn" style="margin-top:8px;">再試行</button>
  </div>
  <div id="orderPlanResult" style="display:none;margin-top:14px;"></div>
  <button class="btn btn-secondary btn-full" id="orderAnotherBtn" style="display:none;margin-top:10px;">別の案を出す</button>
  <p style="font-size:0.72rem;color:var(--text-muted);margin-top:10px;line-height:1.6;">ネット上の情報に基づく提案です。価格・提供状況は変わることがあります。アレルギー等の除外は「好み・気分」欄に書けば考慮されますが、保証はされません。必ずお店でご確認ください。</p>
</div>
```

- [ ] **Step 3: ナビゲーション組込み**

1. `SETUP_CARDS` 配列に `'orderAiCard'` を追加
2. `goToSettleSetup` と同様の遷移関数を隣に追加:

```js
  function goToOrderAi() {
    hideOtherSetupCards('orderAiCard');
    document.getElementById('orderAiCard').style.display = 'block';
    window.scrollTo(0, 0);
    pushNav('orderAiCard');
  }
```

3. popstate の switch（`case 'settleSetupCard': goToSettleSetup(); break;` の並び）に追加:
   `case 'orderAiCard': goToOrderAi(); break;`
4. メニューボタン結線（`menuSettleBtn` の listener の隣）:
   `document.getElementById('menuOrderAiBtn')?.addEventListener('click', goToOrderAi);`

- [ ] **Step 4: buildOrderPlanHtml（トップレベル純関数）とハンドラを追加**

`aiErrorToJa` の近くにトップレベルで追加:

```js
  // 注文プランの描画（純関数・テスト対象）。ユーザー入力由来は全て escHtml を通す
  function buildOrderPlanHtml(plan, totalEstimate, notes, sourceUrls) {
    const cats = (plan || []).map(c => `
      <div style="margin-bottom:12px;">
        <div style="font-weight:700;color:var(--green);font-size:0.9rem;margin-bottom:4px;">${escHtml(c.category)}</div>
        ${(c.items || []).map(it => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--line-soft);">
            <div style="min-width:0;">
              <div style="font-weight:600;">${escHtml(it.name)} <span style="color:var(--text-muted);font-weight:400;">× ${parseInt(it.qty) || 1}</span></div>
              <div style="font-size:0.78rem;color:var(--text-muted);">${escHtml(it.why)}</div>
            </div>
            <div style="white-space:nowrap;font-size:0.82rem;">${escHtml(it.price || '')}</div>
          </div>`).join('')}
      </div>`).join('');
    const totalRow = totalEstimate ? `<div style="font-weight:700;margin-top:6px;">合計目安: ${escHtml(totalEstimate)}</div>` : '';
    const notesRow = notes ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:6px;">${escHtml(notes)}</div>` : '';
    const links = (sourceUrls && sourceUrls.length)
      ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px;">参考: ${sourceUrls.map((u, i) => `<a href="${escHtml(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(' ')}</div>` : '';
    return cats + totalRow + notesRow + links;
  }
```

callable の定義（`test/index.html` 1678行付近、`generateVenueBriefCallable` の直後に併記。
インスタンス変数は既存の `const functions = getFunctions(app, 'asia-northeast1');` を使う）:

```js
  const suggestOrderPlanCallable = httpsCallable(functions, 'suggestOrderPlan');
```

送信ハンドラ（menuOrderAiBtn の結線の近く）:

```js
  // ── AI注文提案 ──
  let lastOrderPlanDishes = [];   // 「別の案」用: 直前プランの品名
  async function invokeSuggestOrderPlan(excludeDishes) {
    if (!currentUser) { showToast('Googleログインが必要です'); await signIn(); return; }
    const shop = (document.getElementById('orderShopInput')?.value || '').trim();
    if (!shop) { showToast('お店の名前またはURLを入力してください'); return; }
    const partySize = parseInt(document.getElementById('orderPartySizeInput')?.value) || 2;
    const budgetRaw = (document.getElementById('orderBudgetInput')?.value || '').trim();
    const mood = (document.getElementById('orderMoodInput')?.value || '').trim();
    const btn = document.getElementById('orderSuggestBtn');
    const loading = document.getElementById('orderPlanLoading');
    const errBox = document.getElementById('orderPlanError');
    const result = document.getElementById('orderPlanResult');
    const another = document.getElementById('orderAnotherBtn');
    btn.disabled = true; another.disabled = true;
    loading.style.display = 'block'; errBox.style.display = 'none';
    try {
      const payload = { shop, partySize };
      if (budgetRaw) payload.budget = parseInt(budgetRaw) || 0;
      if (mood) payload.mood = mood;
      if (excludeDishes && excludeDishes.length) payload.excludeDishes = excludeDishes;
      const res = await suggestOrderPlanCallable(payload);
      const d = res.data || {};
      lastOrderPlanDishes = (d.plan || []).flatMap(c => (c.items || []).map(it => it.name)).filter(Boolean).slice(0, 20);
      result.innerHTML = buildOrderPlanHtml(d.plan, d.totalEstimate, d.notes, d.sourceUrls);
      result.style.display = 'block';
      another.style.display = 'block';
    } catch (e) {
      document.getElementById('orderPlanErrorText').textContent = aiErrorToJa(String(e.message || ''));
      errBox.style.display = 'block';
      console.error('order-plan error:', e);
    } finally {
      btn.disabled = false; another.disabled = false;
      loading.style.display = 'none';
    }
  }
  document.getElementById('orderSuggestBtn')?.addEventListener('click', () => invokeSuggestOrderPlan());
  document.getElementById('orderAnotherBtn')?.addEventListener('click', () => invokeSuggestOrderPlan(lastOrderPlanDishes));
  document.getElementById('orderRetryBtn')?.addEventListener('click', () => invokeSuggestOrderPlan());
```

- [ ] **Step 5: 構文チェック**

Run:
```bash
python3 -c "
import re
html = open('test/index.html').read()
s = re.findall(r'<script type=\"module\">(.*?)</script>', html, re.S)[0]
open('/tmp/mod.mjs','w').write(s)" && node --check /tmp/mod.mjs
```
Expected: OK

- [ ] **Step 6: Commit**

```bash
git add test/index.html
git commit -m "feat(order-plan): メニュータイル・注文提案カード・呼び出しハンドラ (test)"
```

---

### Task 7: フロント特性化テスト（buildOrderPlanHtml）

**Files:**
- Create: `tests/frontend/orderplan.test.js`

**Interfaces:**
- Consumes: Task 6 の `buildOrderPlanHtml`、既存 `escHtml`（両方とも `tests/frontend/extract.js` で抽出）

- [ ] **Step 1: テストを書く**

```js
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
```

- [ ] **Step 2: 実行して通過確認**

Run: `node --test tests/frontend/orderplan.test.js`
Expected: 4件 PASS（Task 6 実装済みのため。落ちたら Task 6 の buildOrderPlanHtml を修正）

- [ ] **Step 3: 全テスト実行**

Run: `node --test tests/frontend/*.test.js && (cd functions && npm test)`
Expected: フロント41件前後 + functions 70件前後、全 PASS

- [ ] **Step 4: Commit**

```bash
git add tests/frontend/orderplan.test.js
git commit -m "test(order-plan): プラン描画のXSS・数量・空入力の特性化テスト"
```

---

### Task 8: デプロイと検証

**Files:** なし（デプロイ・検証のみ）

- [ ] **Step 1: functions を本番デプロイ**

Run: `firebase deploy --only functions:suggestOrderPlan --project chouseikun-tabel --account takedakyoichi0926@gmail.com`
Expected: `✔ Deploy complete!`（新規関数として作成される）

- [ ] **Step 2: test/ を push して検証環境へ**

```bash
git push origin main
gh run watch $(gh run list --repo smcc-tools/chouseikun --limit 1 --json databaseId -q '.[0].databaseId') --repo smcc-tools/chouseikun --exit-status
```
Expected: CI の test ジョブ（全テスト）→ deploy 通過

- [ ] **Step 3: 検証環境の実機確認を依頼**

ユーザーに `https://smcc-tools.github.io/chouseikun/test/` のメニュー →「注文提案」で
実在店舗（例: よく行く居酒屋）を入れて動作確認してもらう。確認観点:
①ログイン誘導 ②プラン生成（20〜40秒）③「別の案」で品が入れ替わる ④架空店名で「情報不足」エラー

- [ ] **Step 4: 承認後 promote**（ユーザー承認が出るまで実行しない）

```bash
echo y | bash scripts/promote.sh
git add index.html && git commit -m "release: promote AI注文提案ツール to production" && git push origin main
```
