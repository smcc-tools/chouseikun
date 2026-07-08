# お店の概要・おすすめメニュー機能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ホストが「店情報を取得」ボタンで、Google Custom Search（無料枠100/日）＋ Gemini 1.5 Flash（無料枠1500/日）を使って、店の概要とおすすめメニューTop3を生成し、独立トグルで参加者に見せる機能を追加する。

**Architecture:** 純粋関数（クエリ組立・スニペット整形・プロンプト構築・レスポンスパース）を `functions/venueBrief/` に切り出して `node --test` で TDD。副作用のある統合部（CSE呼出・Gemini呼出・Firestore書込）は Firebase Callable Function `generateVenueBrief` に集約し、test 環境デプロイで実機検証。クライアント UI は `test/index.html` の `announceCard` 内 `venueEdit` に `venueBriefSection` を新設し、onSnapshot 経由で描画。

**Tech Stack:** Node 22 / firebase-functions v5.1 (v2 Callable) / firebase-admin v12.6 / Google Custom Search JSON API / Google Gemini 1.5 Flash (application/json レスポンス) / firebase JS SDK v11.8.1 (httpsCallable) / vanilla HTML+CSS

## Global Constraints

- 完全無料運用（Google CSE 100/日、Gemini 1500/日の無料枠内）
- 既存 `venue` フィールドは非破壊（`brief` を追加するのみ）
- Cloud Functions リージョン: `asia-northeast1`（既存 `notifyOnParticipantRegister` と同じ）
- Node 22, `firebase-functions/v2/https` の `onCall` を使用
- Secrets 3件: `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`, `GEMINI_API_KEY`
- テスト環境優先ワークフロー: `test/index.html` に実装 → 実機確認 → root promote
- Firebase project: `chouseikun-tabel` / account: `takedakyoichi0926@gmail.com`
- 生成JSONスキーマ: `{ overview: string, dishes: [{ name, why }] × 3 }`
- Rate limit: 同一ホストが5秒以内の連続呼び出しは 429（サーバ側）
- Function timeout 30秒、メモリ 256MB
- Firestoreルール変更なし（既存 `isOwner()` が `venue.brief` をカバー）

---

## File Structure

**Create:**
- `functions/venueBrief/queries.js` — 純粋関数: 店名抽出・検索クエリ組立
- `functions/venueBrief/snippets.js` — 純粋関数: CSE レスポンスの整形・重複除去
- `functions/venueBrief/prompt.js` — 純粋関数: Gemini プロンプト構築・レスポンスパース
- `functions/venueBrief/index.js` — 統合オーケストレータ（純粋関数側と副作用側の合流点）
- `functions/venueBrief/tests/queries.test.js` — node --test
- `functions/venueBrief/tests/snippets.test.js` — node --test
- `functions/venueBrief/tests/prompt.test.js` — node --test

**Modify:**
- `functions/index.js` — `generateVenueBrief` Callable エクスポート追加
- `functions/package.json` — Node ネイティブ fetch は Node 22 で標準、依存追加なし
- `test/index.html` — `announceCard` 内の `venueEdit` に `venueBriefSection` HTML と JS 追加、`renderAnnounceView` 参加者側描画拡張、`app` インスタンスから `httpsCallable` を利用

**Not Modified (verified):**
- `firestore.rules` — `isOwner()` で `venue.brief` の書込・トグル・削除すべてカバー済み

---

## Task 1: Secrets 登録 + Callable Function 雛形デプロイ

**Files:**
- Create: `functions/venueBrief/index.js`
- Modify: `functions/index.js` (追加のみ)

**Interfaces:**
- Consumes: なし（起点）
- Produces:
  - Callable `generateVenueBrief({ eventId: string })` → `{ ok: true, stage: 'stub' }`
  - Region: `asia-northeast1`
  - Auth 必須: `request.auth.uid` が `events/{eventId}.ownerUids` に含まれること

- [ ] **Step 1: Google Custom Search Engine を作成し API Key を発行**

手動作業（ユーザー側）:
1. https://programmablesearchengine.google.com/ で新規 CSE 作成（「ウェブ全体を検索」ON、日本語優先）
2. CSE ID (`cx`) を控える
3. https://console.cloud.google.com/apis/library/customsearch.googleapis.com で Custom Search API を有効化
4. https://console.cloud.google.com/apis/credentials で API Key を発行、`customsearch.googleapis.com` のみに制限
5. https://aistudio.google.com/apikey で Gemini API Key を発行

- [ ] **Step 2: Firebase Secrets に登録**

```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ/functions
firebase functions:secrets:set GOOGLE_CSE_KEY --project chouseikun-tabel --account takedakyoichi0926@gmail.com
# プロンプトで CSE API Key を貼付
firebase functions:secrets:set GOOGLE_CSE_CX --project chouseikun-tabel --account takedakyoichi0926@gmail.com
# プロンプトで CSE ID (cx) を貼付
firebase functions:secrets:set GEMINI_API_KEY --project chouseikun-tabel --account takedakyoichi0926@gmail.com
# プロンプトで Gemini API Key を貼付
```

期待: 各コマンドで `Created a new secret version projects/.../GOOGLE_CSE_KEY/versions/1` 等が表示される。

- [ ] **Step 3: 雛形オーケストレータを作成**

`functions/venueBrief/index.js`:
```javascript
// 統合オーケストレータ：純粋関数群と副作用（CSE/Gemini/Firestore）を組み立てる。
// Task 1 の時点では雛形。認証チェックのみ実装。
const admin = require('firebase-admin');

async function generateVenueBriefImpl({ uid, eventId, secrets }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (!eventId || typeof eventId !== 'string') throw new Error('INVALID_ARG');

  const db = admin.firestore();
  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND');
  const data = snap.data() || {};
  const owners = Array.isArray(data.ownerUids) ? data.ownerUids : [];
  if (!owners.includes(uid)) throw new Error('PERMISSION_DENIED');

  return { ok: true, stage: 'stub' };
}

module.exports = { generateVenueBriefImpl };
```

- [ ] **Step 4: Callable エクスポートを functions/index.js に追加**

`functions/index.js` の末尾に追記:
```javascript
// 店の概要・おすすめメニュー生成（Callable、ホスト認証必須）
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { generateVenueBriefImpl } = require('./venueBrief');

exports.generateVenueBrief = onCall({
  region: 'asia-northeast1',
  timeoutSeconds: 30,
  memory: '256MiB',
  secrets: ['GOOGLE_CSE_KEY', 'GOOGLE_CSE_CX', 'GEMINI_API_KEY'],
}, async (request) => {
  const uid = request.auth && request.auth.uid;
  const { eventId } = request.data || {};
  try {
    return await generateVenueBriefImpl({
      uid,
      eventId,
      secrets: {
        cseKey: process.env.GOOGLE_CSE_KEY,
        cseCx: process.env.GOOGLE_CSE_CX,
        geminiKey: process.env.GEMINI_API_KEY,
      },
    });
  } catch (e) {
    const code = e.message === 'UNAUTHENTICATED' ? 'unauthenticated'
      : e.message === 'INVALID_ARG' ? 'invalid-argument'
      : e.message === 'NOT_FOUND' ? 'not-found'
      : e.message === 'PERMISSION_DENIED' ? 'permission-denied'
      : 'internal';
    throw new HttpsError(code, e.message);
  }
});
```

- [ ] **Step 5: デプロイして雛形が呼べることを確認**

```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ
firebase deploy --only functions:generateVenueBrief --project chouseikun-tabel --account takedakyoichi0926@gmail.com 2>&1 | tail -15
```

期待: `Deploy complete!` と `Function URL (generateVenueBrief)` が出力される。

- [ ] **Step 6: コミット**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ
git -C "$R" add functions/venueBrief/index.js functions/index.js
git -C "$R" commit -m "feat(functions): scaffold generateVenueBrief callable (auth check only)"
```

---

## Task 2: 店名抽出＆検索クエリ組立（純粋関数, TDD）

**Files:**
- Create: `functions/venueBrief/queries.js`
- Create: `functions/venueBrief/tests/queries.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `extractShopName(venueShop: string) → string` — venue.shop から店名を推定
  - `buildCseQueries(shopName: string) → string[]` — 検索クエリを2件返す
  - `pickLongestNonUrlSegment(s: string) → string` — extractShopName の内部ヘルパー（export しない）

- [ ] **Step 1: テストを書く（失敗させる）**

`functions/venueBrief/tests/queries.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractShopName, buildCseQueries } = require('../queries');

test('extractShopName: URL のみの入力からドメイン内テキストを抽出', () => {
  const url = 'https://tabelog.com/tokyo/A1301/A130103/13001234/';
  assert.equal(extractShopName(url), 'tabelog.com');
});

test('extractShopName: 店名 + URL の入力から店名部分だけを返す', () => {
  const input = '銀座 うち山\nhttps://tabelog.com/tokyo/A1301/A130103/13001234/';
  assert.equal(extractShopName(input), '銀座 うち山');
});

test('extractShopName: 店名のみの入力はそのまま返す', () => {
  assert.equal(extractShopName('鮨さいとう'), '鮨さいとう');
});

test('extractShopName: 空文字は空文字を返す', () => {
  assert.equal(extractShopName(''), '');
  assert.equal(extractShopName(null), '');
});

test('extractShopName: 前後の空白と改行を除去', () => {
  assert.equal(extractShopName('  銀座 うち山  \n'), '銀座 うち山');
});

test('buildCseQueries: 2つの異なるクエリを返す', () => {
  const qs = buildCseQueries('銀座 うち山');
  assert.equal(qs.length, 2);
  assert.match(qs[0], /銀座 うち山/);
  assert.match(qs[1], /銀座 うち山/);
  assert.notEqual(qs[0], qs[1]);
});

test('buildCseQueries: クエリ1は「メニュー おすすめ」を含む', () => {
  const qs = buildCseQueries('鮨さいとう');
  assert.match(qs[0], /メニュー|おすすめ/);
});

test('buildCseQueries: クエリ2は「口コミ|レビュー|評判」を含む', () => {
  const qs = buildCseQueries('鮨さいとう');
  assert.match(qs[1], /口コミ|レビュー|評判/);
});

test('buildCseQueries: 空店名なら空配列を返す', () => {
  assert.deepEqual(buildCseQueries(''), []);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ/functions
node --test venueBrief/tests/queries.test.js
```

期待: `Error: Cannot find module '../queries'` またはそれに類する失敗。

- [ ] **Step 3: 最小実装**

`functions/venueBrief/queries.js`:
```javascript
// venue.shop 文字列から店名を抽出し、Google CSE 用のクエリを組み立てる。
// 純粋関数のみ。副作用なし。

function extractShopName(s) {
  if (!s || typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (!trimmed) return '';
  // URL を除去した残りを行単位で見て、最も長い非空・非URL行を返す
  const lines = trimmed.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const nonUrl = lines.filter(l => !/^https?:\/\//i.test(l));
  if (nonUrl.length > 0) {
    // 最長行を店名候補として返す
    return nonUrl.reduce((a, b) => b.length > a.length ? b : a);
  }
  // 全部URLの場合はホスト名を返す
  try {
    return new URL(lines[0]).hostname;
  } catch (_) {
    return trimmed;
  }
}

function buildCseQueries(shopName) {
  const name = (shopName || '').trim();
  if (!name) return [];
  return [
    `${name} メニュー おすすめ`,
    `${name} 口コミ 評判`,
  ];
}

module.exports = { extractShopName, buildCseQueries };
```

- [ ] **Step 4: テストが通ることを確認**

```bash
node --test venueBrief/tests/queries.test.js
```

期待: `# pass 9` または全テスト通過。

- [ ] **Step 5: コミット**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ
git -C "$R" add functions/venueBrief/queries.js functions/venueBrief/tests/queries.test.js
git -C "$R" commit -m "feat(functions): extractShopName + buildCseQueries with unit tests"
```

---

## Task 3: CSE レスポンス整形（純粋関数, TDD）

**Files:**
- Create: `functions/venueBrief/snippets.js`
- Create: `functions/venueBrief/tests/snippets.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `normalizeSnippets(cseJson: object) → Array<{ title, snippet, link }>` — CSE JSON レスポンスから title/snippet/link を抽出
  - `dedupeSnippets(items: Array<{title,snippet,link}>) → Array<{title,snippet,link}>` — link ドメイン単位で重複除去

- [ ] **Step 1: テストを書く（失敗させる）**

`functions/venueBrief/tests/snippets.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnippets, dedupeSnippets } = require('../snippets');

test('normalizeSnippets: items がない場合は空配列', () => {
  assert.deepEqual(normalizeSnippets({}), []);
  assert.deepEqual(normalizeSnippets({ items: [] }), []);
  assert.deepEqual(normalizeSnippets(null), []);
});

test('normalizeSnippets: title / snippet / link を抽出', () => {
  const cseJson = {
    items: [
      { title: '銀座 うち山', snippet: '和食の名店。', link: 'https://tabelog.com/...' },
      { title: '別サイト', snippet: 'コメント', link: 'https://retty.me/...' },
    ],
  };
  const out = normalizeSnippets(cseJson);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: '銀座 うち山', snippet: '和食の名店。', link: 'https://tabelog.com/...' });
});

test('normalizeSnippets: htmlSnippet があれば HTMLタグを剥がして採用', () => {
  const cseJson = {
    items: [
      { title: 'T', htmlSnippet: '<b>ある</b>店の情報&amp;など', link: 'https://x.com/' },
    ],
  };
  const out = normalizeSnippets(cseJson);
  assert.equal(out[0].snippet, 'ある店の情報&など');
});

test('normalizeSnippets: title/link/snippet 欠損は空文字補完', () => {
  const cseJson = { items: [{ title: 'T' }] };
  const out = normalizeSnippets(cseJson);
  assert.deepEqual(out[0], { title: 'T', snippet: '', link: '' });
});

test('dedupeSnippets: 同一ドメインの重複を削除、最初の1件のみ残す', () => {
  const items = [
    { title: 'A', snippet: 'a', link: 'https://tabelog.com/x' },
    { title: 'B', snippet: 'b', link: 'https://tabelog.com/y' },
    { title: 'C', snippet: 'c', link: 'https://retty.me/z' },
  ];
  const out = dedupeSnippets(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A');
  assert.equal(out[1].title, 'C');
});

test('dedupeSnippets: link が空の項目は落とさない（別要素扱い）', () => {
  const items = [
    { title: 'A', snippet: 'a', link: '' },
    { title: 'B', snippet: 'b', link: '' },
  ];
  const out = dedupeSnippets(items);
  assert.equal(out.length, 2);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

```bash
node --test venueBrief/tests/snippets.test.js
```

期待: モジュール未定義エラーで失敗。

- [ ] **Step 3: 最小実装**

`functions/venueBrief/snippets.js`:
```javascript
// Google Custom Search JSON レスポンスの整形。純粋関数のみ。

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'");
}

function normalizeSnippets(cseJson) {
  if (!cseJson || !Array.isArray(cseJson.items)) return [];
  return cseJson.items.map(it => ({
    title: String(it.title || '').trim(),
    snippet: it.snippet != null
      ? String(it.snippet).trim()
      : stripHtml(it.htmlSnippet || '').trim(),
    link: String(it.link || '').trim(),
  }));
}

function dedupeSnippets(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    if (!it.link) { out.push(it); continue; }
    let host = '';
    try { host = new URL(it.link).hostname; } catch (_) { host = it.link; }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(it);
  }
  return out;
}

module.exports = { normalizeSnippets, dedupeSnippets };
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test venueBrief/tests/snippets.test.js
```

期待: 全テスト pass。

- [ ] **Step 5: コミット**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ
git -C "$R" add functions/venueBrief/snippets.js functions/venueBrief/tests/snippets.test.js
git -C "$R" commit -m "feat(functions): normalizeSnippets + dedupeSnippets with unit tests"
```

---

## Task 4: Gemini プロンプト構築＆レスポンスパース（純粋関数, TDD）

**Files:**
- Create: `functions/venueBrief/prompt.js`
- Create: `functions/venueBrief/tests/prompt.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `buildGeminiRequestBody(shopName: string, snippets: Array<{title,snippet,link}>) → object` — Gemini API v1beta の generateContent へ渡す JSON ボディ全体
  - `parseGeminiResponse(apiJson: object) → { overview: string, dishes: [{name,why}] }` — Gemini レスポンスからパース、失敗時は例外
  - `validateBrief(brief: object) → boolean` — 出力の型・件数を検証

- [ ] **Step 1: テストを書く（失敗させる）**

`functions/venueBrief/tests/prompt.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGeminiRequestBody, parseGeminiResponse, validateBrief } = require('../prompt');

test('buildGeminiRequestBody: system_instruction と contents を含む', () => {
  const body = buildGeminiRequestBody('銀座 うち山', [
    { title: 'T1', snippet: 'S1', link: 'https://a.com' },
  ]);
  assert.ok(body.systemInstruction);
  assert.ok(Array.isArray(body.contents));
  assert.ok(body.contents[0].parts[0].text.includes('銀座 うち山'));
  assert.ok(body.contents[0].parts[0].text.includes('T1'));
  assert.ok(body.contents[0].parts[0].text.includes('S1'));
});

test('buildGeminiRequestBody: response_mime_type=application/json とスキーマ強制', () => {
  const body = buildGeminiRequestBody('X', []);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema);
  assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
  assert.ok(body.generationConfig.responseSchema.properties.overview);
  assert.ok(body.generationConfig.responseSchema.properties.dishes);
});

test('buildGeminiRequestBody: 温度は低め (<=0.4) で事実重視', () => {
  const body = buildGeminiRequestBody('X', []);
  assert.ok(body.generationConfig.temperature <= 0.4);
});

test('parseGeminiResponse: 正常な candidates から overview と dishes を抽出', () => {
  const apiJson = {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            overview: '落ち着いた大人向けの創作和食。個室あり。',
            dishes: [
              { name: '胡麻豆腐', why: '看板料理' },
              { name: '天ぷら盛合せ', why: '旬野菜が魅力' },
              { name: '土鍋ご飯', why: 'シメの定番' },
            ],
          }),
        }],
      },
    }],
  };
  const brief = parseGeminiResponse(apiJson);
  assert.equal(brief.overview, '落ち着いた大人向けの創作和食。個室あり。');
  assert.equal(brief.dishes.length, 3);
  assert.equal(brief.dishes[0].name, '胡麻豆腐');
});

test('parseGeminiResponse: candidates が空なら例外', () => {
  assert.throws(() => parseGeminiResponse({ candidates: [] }), /empty/);
});

test('parseGeminiResponse: parts のテキストが JSON でなければ例外', () => {
  const apiJson = { candidates: [{ content: { parts: [{ text: 'not json' }] } }] };
  assert.throws(() => parseGeminiResponse(apiJson), /parse/);
});

test('validateBrief: overview が空文字なら false', () => {
  assert.equal(validateBrief({ overview: '', dishes: [{name:'a',why:'b'}] }), false);
});

test('validateBrief: dishes が 3件でなければ false', () => {
  assert.equal(validateBrief({ overview: 'x', dishes: [] }), false);
  assert.equal(validateBrief({ overview: 'x', dishes: [{name:'a',why:'b'}] }), false);
});

test('validateBrief: 正しい形なら true', () => {
  assert.equal(validateBrief({
    overview: 'x',
    dishes: [{name:'a',why:'b'},{name:'c',why:'d'},{name:'e',why:'f'}],
  }), true);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

```bash
node --test venueBrief/tests/prompt.test.js
```

期待: モジュール未定義エラー。

- [ ] **Step 3: 最小実装**

`functions/venueBrief/prompt.js`:
```javascript
// Gemini 1.5 Flash 用のプロンプト構築とレスポンスパース。純粋関数のみ。

const SYSTEM_INSTRUCTION = `あなたは日本のグルメサイトの要約を作るアシスタントです。
複数の検索結果スニペットから、店の概要と、頻出する料理3品を抽出し、JSON形式で回答してください。

制約:
- 事実として確認できないことは書かない。
- 概要には雰囲気・ジャンル・予算目安・向いているシーンを含める（2〜4文の日本語）。
- おすすめメニューは検索スニペットに複数回出現する料理を優先。
- 情報が不足している項目は「（情報不足）」と記載。
- 出力は必ず有効な JSON。他のテキストは含めない。`;

function buildGeminiRequestBody(shopName, snippets) {
  const items = (snippets || []).slice(0, 10);
  const listed = items.map((s, i) =>
    `${i + 1}. ${s.title || ''}\n   ${s.snippet || ''}`
  ).join('\n');

  const userText = `店名: ${shopName || '(不明)'}\n\n検索スニペット:\n${listed || '(スニペットなし)'}`;

  return {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          overview: { type: 'STRING' },
          dishes: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                why: { type: 'STRING' },
              },
              required: ['name', 'why'],
            },
          },
        },
        required: ['overview', 'dishes'],
      },
    },
  };
}

function parseGeminiResponse(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) throw new Error('gemini: empty candidates');
  const parts = (cands[0].content && cands[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text) throw new Error('gemini: empty parts text');
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`gemini: failed to parse JSON: ${e.message}`);
  }
  return {
    overview: String(obj.overview || '').trim(),
    dishes: Array.isArray(obj.dishes) ? obj.dishes.slice(0, 3).map(d => ({
      name: String(d.name || '').trim(),
      why: String(d.why || '').trim(),
    })) : [],
  };
}

function validateBrief(brief) {
  if (!brief || typeof brief !== 'object') return false;
  if (!brief.overview || typeof brief.overview !== 'string') return false;
  if (!Array.isArray(brief.dishes) || brief.dishes.length !== 3) return false;
  return brief.dishes.every(d => d && typeof d.name === 'string' && d.name && typeof d.why === 'string');
}

module.exports = { buildGeminiRequestBody, parseGeminiResponse, validateBrief };
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test venueBrief/tests/prompt.test.js
```

期待: 全テスト pass。

- [ ] **Step 5: コミット**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ
git -C "$R" add functions/venueBrief/prompt.js functions/venueBrief/tests/prompt.test.js
git -C "$R" commit -m "feat(functions): Gemini prompt builder + response parser with unit tests"
```

---

## Task 5: 統合オーケストレータ（CSE 呼出＋Gemini 呼出＋Firestore 書込）

**Files:**
- Modify: `functions/venueBrief/index.js`

**Interfaces:**
- Consumes: Task 2〜4 の全純粋関数
- Produces:
  - `generateVenueBriefImpl({ uid, eventId, secrets })` の本体（雛形→完成品）
  - 副作用: CSE fetch × 2、Gemini fetch × 1、Firestore update × 1
  - 戻り値: `{ ok: true, brief: {overview, dishes, generatedAt, sourceQuery, edited:false, visible:<旧値または false>} }`
  - Rate limit: 同一 uid が同 eventId で 5秒以内の再呼び出しは `Error('RATE_LIMITED')` を投げる

- [ ] **Step 1: 実装（Task 1 の雛形を置き換え）**

`functions/venueBrief/index.js`（全置き換え）:
```javascript
// 統合オーケストレータ：CSE で検索スニペットを収集し Gemini で要約、
// venue.brief に書き込む。認証と rate limit もここで担う。
const admin = require('firebase-admin');
const { extractShopName, buildCseQueries } = require('./queries');
const { normalizeSnippets, dedupeSnippets } = require('./snippets');
const { buildGeminiRequestBody, parseGeminiResponse, validateBrief } = require('./prompt');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）
const _lastCallAt = new Map(); // key: `${uid}:${eventId}` → timestampMs

const RATE_LIMIT_MS = 5000;
const CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

async function fetchCse(query, cseKey, cseCx) {
  const url = new URL(CSE_ENDPOINT);
  url.searchParams.set('key', cseKey);
  url.searchParams.set('cx', cseCx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '5');
  url.searchParams.set('hl', 'ja');
  url.searchParams.set('lr', 'lang_ja');
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CSE ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function callGemini(body, geminiKey) {
  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function generateVenueBriefImpl({ uid, eventId, secrets }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (!eventId || typeof eventId !== 'string') throw new Error('INVALID_ARG');
  if (!secrets || !secrets.cseKey || !secrets.cseCx || !secrets.geminiKey) {
    throw new Error('SECRETS_MISSING');
  }

  // Rate limit
  const rlKey = `${uid}:${eventId}`;
  const last = _lastCallAt.get(rlKey) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) throw new Error('RATE_LIMITED');
  _lastCallAt.set(rlKey, now);

  const db = admin.firestore();
  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND');
  const data = snap.data() || {};
  const owners = Array.isArray(data.ownerUids) ? data.ownerUids : [];
  if (!owners.includes(uid)) throw new Error('PERMISSION_DENIED');

  const shopField = (data.venue && data.venue.shop) || '';
  const shopName = extractShopName(shopField);
  if (!shopName) throw new Error('SHOP_EMPTY');

  // CSE を2クエリ並列で叩く
  const queries = buildCseQueries(shopName);
  const cseResponses = await Promise.all(
    queries.map(q => fetchCse(q, secrets.cseKey, secrets.cseCx))
  );
  const allSnippets = cseResponses.flatMap(normalizeSnippets);
  const snippets = dedupeSnippets(allSnippets).slice(0, 10);
  if (snippets.length === 0) throw new Error('NO_RESULTS');

  // Gemini で要約
  const geminiBody = buildGeminiRequestBody(shopName, snippets);
  const geminiJson = await callGemini(geminiBody, secrets.geminiKey);
  const parsed = parseGeminiResponse(geminiJson);
  if (!validateBrief(parsed)) throw new Error('BRIEF_INVALID');

  // Firestore に書込（既存 visible を保持）
  const priorVisible = !!(data.venue && data.venue.brief && data.venue.brief.visible);
  const brief = {
    overview: parsed.overview,
    dishes: parsed.dishes,
    generatedAt: now,
    sourceQuery: queries.join(' | '),
    edited: false,
    visible: priorVisible,
    error: admin.firestore.FieldValue.delete(),
  };
  await ref.update({ 'venue.brief': brief });

  return { ok: true, brief: { ...brief, error: undefined } };
}

module.exports = { generateVenueBriefImpl };
```

- [ ] **Step 2: 純粋関数テストが引き続き通ることを確認**

```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ/functions
node --test venueBrief/tests/queries.test.js venueBrief/tests/snippets.test.js venueBrief/tests/prompt.test.js
```

期待: 全 pass。

- [ ] **Step 3: デプロイ**

```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ
firebase deploy --only functions:generateVenueBrief --project chouseikun-tabel --account takedakyoichi0926@gmail.com 2>&1 | tail -12
```

期待: `Deploy complete!`。

- [ ] **Step 4: 実機で 1 回だけ呼び出し検証（curl はauthトークン取得が煩雑なため、後続 Task 6 の UI 完成時にまとめて検証する。ここではデプロイ成功のみを確認）**

- [ ] **Step 5: コミット**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ
git -C "$R" add functions/venueBrief/index.js
git -C "$R" commit -m "feat(functions): implement CSE + Gemini orchestration with rate limit"
```

---

## Task 6: ホスト UI — venueBriefSection HTML と取得ボタン

**Files:**
- Modify: `test/index.html` （venueEdit ブロック内に追記、および末尾 script 内にハンドラ追加）

**Interfaces:**
- Consumes: Callable `generateVenueBrief({ eventId })` → `{ ok, brief? }`
- Produces:
  - HTML: `#venueBriefSection`, `#fetchVenueBriefBtn`, `#venueBriefLoading`, `#venueBriefPreview`, `#venueBriefError`, `#briefOverviewInput`, `#briefDishesList`, `#regenerateVenueBriefBtn`, `#deleteVenueBriefBtn`, `#briefVisibleToggle`, `#retryVenueBriefBtn`, `#briefErrorDetail`
  - JS: `applyVenueBriefState(brief)` — 状態遷移（未取得/取得中/プレビュー/エラー）
  - JS: `fetchVenueBriefBtn` クリックハンドラ

- [ ] **Step 1: `venueEdit` ブロックの `venueNoteInput` の直後に venueBriefSection の HTML を追加**

`test/index.html` の該当 venueEdit（announceCard 内）で、`venueNoteInput` の直後に以下を追加:

```html
<div id="venueBriefSection" class="host-only" style="margin-top:14px; padding-top:14px; border-top:1px solid var(--border);">
  <div style="font-size:0.9rem; font-weight:700; color:var(--text); margin-bottom:6px;">お店の情報</div>
  <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">
    ネット上の情報を集めて、店の概要とおすすめメニューを自動生成します。参加者に見せるかはトグルで切替できます。
  </div>

  <button id="fetchVenueBriefBtn" class="btn btn-secondary" type="button" style="width:100%;">
    店情報を取得
  </button>

  <div id="venueBriefLoading" style="display:none; text-align:center; padding:12px; color:var(--text-muted);">
    店の情報を集めています…（10〜15秒）
  </div>

  <div id="venueBriefPreview" style="display:none; margin-top:10px;">
    <div class="field" style="margin-bottom:10px;">
      <label style="font-size:0.75rem; color:var(--text-muted);">概要</label>
      <textarea id="briefOverviewInput" rows="4" style="width:100%; padding:8px; border:1px solid var(--border); border-radius:6px; font-family:inherit; font-size:0.85rem; box-sizing:border-box;"></textarea>
    </div>
    <div class="field" style="margin-bottom:10px;">
      <label style="font-size:0.75rem; color:var(--text-muted);">おすすめメニュー</label>
      <div id="briefDishesList"></div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:10px;">
      <button id="regenerateVenueBriefBtn" class="btn btn-tertiary" type="button" style="flex:1;">🔄 再取得</button>
      <button id="deleteVenueBriefBtn" class="btn btn-tertiary" type="button" style="flex:1;">🗑 削除</button>
    </div>
    <label style="display:flex; align-items:center; gap:8px; font-size:0.85rem;">
      <input type="checkbox" id="briefVisibleToggle">
      <span>参加者に見せる</span>
    </label>
    <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px;">
      ※ AIによる自動要約のため、実際の情報と異なる場合があります。
    </div>
  </div>

  <div id="venueBriefError" style="display:none; margin-top:10px; padding:10px; background:#FDF2E9; border:1px solid #F0B090; border-radius:6px;">
    <div style="font-size:0.85rem; color:#C05010; margin-bottom:8px;">
      店の情報を取得できませんでした。<span id="briefErrorDetail"></span>
    </div>
    <button id="retryVenueBriefBtn" class="btn btn-secondary" type="button" style="width:100%;">再取得</button>
  </div>
</div>
```

- [ ] **Step 2: JS: Firebase Functions SDK を module import に追加**

`test/index.html` の既存 `import { getFirestore, ... }` の後に：

```javascript
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-functions.js";
```

そして初期化ブロックで（`db = getFirestore(...)` の直後）:

```javascript
const functions = getFunctions(app, 'asia-northeast1');
const generateVenueBriefCallable = httpsCallable(functions, 'generateVenueBrief');
```

- [ ] **Step 3: JS: 状態遷移関数と取得ボタンハンドラを追加**

`test/index.html` の末尾 script、`saveVenueBtn` ハンドラの直後に：

```javascript
// venueBrief: 状態を UI に反映（未取得/取得中/プレビュー/エラー）
function applyVenueBriefState(brief) {
  const btn = document.getElementById('fetchVenueBriefBtn');
  const loading = document.getElementById('venueBriefLoading');
  const preview = document.getElementById('venueBriefPreview');
  const errBox = document.getElementById('venueBriefError');
  const errDetail = document.getElementById('briefErrorDetail');
  if (!btn || !preview || !loading || !errBox) return;

  const isFetching = document.body.dataset.briefFetching === '1';
  const hasBrief = brief && brief.overview;
  const hasErr = brief && brief.error;

  btn.style.display = (!hasBrief && !isFetching && !hasErr) ? '' : 'none';
  loading.style.display = isFetching ? '' : 'none';
  preview.style.display = (hasBrief && !isFetching) ? '' : 'none';
  errBox.style.display = (hasErr && !isFetching) ? '' : 'none';
  if (hasErr && errDetail) errDetail.textContent = String(brief.error || '').slice(0, 100);

  if (hasBrief) {
    const ov = document.getElementById('briefOverviewInput');
    if (ov && document.activeElement !== ov && ov.dataset.dirty !== '1') {
      ov.value = brief.overview || '';
    }
    const list = document.getElementById('briefDishesList');
    if (list && list.dataset.dirty !== '1') {
      list.innerHTML = (brief.dishes || []).map((d, i) => `
        <div style="display:flex; gap:6px; margin-bottom:4px;">
          <input type="text" data-brief-dish="${i}" data-field="name" value="${escHtml(d.name || '')}" placeholder="料理名" style="flex:1; padding:6px; border:1px solid var(--border); border-radius:6px; font-size:0.82rem;">
          <input type="text" data-brief-dish="${i}" data-field="why" value="${escHtml(d.why || '')}" placeholder="理由" style="flex:2; padding:6px; border:1px solid var(--border); border-radius:6px; font-size:0.82rem;">
        </div>
      `).join('');
    }
    const tog = document.getElementById('briefVisibleToggle');
    if (tog) tog.checked = !!brief.visible;
  }
}

// 「店情報を取得」クリック
async function invokeGenerateVenueBrief() {
  if (!currentUser) { showToast('ログインが必要です'); return; }
  document.body.dataset.briefFetching = '1';
  applyVenueBriefState(latestEventData?.venue?.brief);
  try {
    await generateVenueBriefCallable({ eventId });
    // 結果は onSnapshot で自動反映されるためここでは何もしない
  } catch (e) {
    // Firestore に error を書けないので Toast のみ
    showToast('取得に失敗しました：' + (e.message || 'エラー'));
  } finally {
    document.body.dataset.briefFetching = '';
    applyVenueBriefState(latestEventData?.venue?.brief);
  }
}

document.getElementById('fetchVenueBriefBtn')?.addEventListener('click', invokeGenerateVenueBrief);
document.getElementById('retryVenueBriefBtn')?.addEventListener('click', invokeGenerateVenueBrief);
```

- [ ] **Step 4: renderAnnounceView 内で applyVenueBriefState を呼ぶ**

`renderAnnounceView(data)` 内、既存の `set('venueNoteInput', v.note)` の直後に：

```javascript
applyVenueBriefState(data.venue && data.venue.brief);
```

- [ ] **Step 5: 構文チェック＆push（テスト環境デプロイ）**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ; cd "$R"
node -e "const fs=require('fs');const h=fs.readFileSync('test/index.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/_chk.mjs',m[1]);" && node --check /tmp/_chk.mjs && echo SYNTAX_OK
git -C "$R" add test/index.html
git -C "$R" commit -m "feat(ui): venueBriefSection UI + fetchVenueBriefBtn"
git -C "$R" push origin main
```

期待: SYNTAX_OK と、Pages ビルド成功。

- [ ] **Step 6: 手動検証（テスト環境）**

Pages ビルド完了後、ユーザーに以下を確認してもらう:
- `https://smcc-tools.github.io/chouseikun/test/` を開く
- 任意のお知らせイベントで venue.shop に店名を入れて保存
- 「店情報を取得」ボタンが表示される
- クリック → ローディング → 10〜15秒後に プレビュー表示
- 概要とおすすめメニュー3件が入っている

問題があれば Task 5/6 に戻る。

---

## Task 7: ホスト UI — 編集・再取得・削除・トグル

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: 既存 `updateDoc`, `latestEventData`, Task 6 の `applyVenueBriefState`
- Produces:
  - 編集ハンドラ: overview textarea・dishes inputs → 600ms debounce → `updateDoc('venue.brief.overview' / 'venue.brief.dishes' / 'venue.brief.edited')`
  - 再取得ハンドラ: `edited=true` 時は confirm 経由で `invokeGenerateVenueBrief()`
  - 削除ハンドラ: confirm → `updateDoc({ 'venue.brief': deleteField() })`
  - visible トグルハンドラ: `updateDoc('venue.brief.visible')`

- [ ] **Step 1: JS: `deleteField` import 追加**

既存の `import { getFirestore, doc, setDoc, getDoc, updateDoc, ... }` に `deleteField` を追加:

```javascript
import { getFirestore, doc, setDoc, getDoc, updateDoc, onSnapshot, collection, getDocs, deleteDoc, runTransaction, deleteField } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js";
```

- [ ] **Step 2: JS: 編集・トグル・削除・再取得ハンドラを追加**

Task 6 の `invokeGenerateVenueBrief` の直後に：

```javascript
// 編集ハンドラ（600ms debounce）
let _briefSaveTimer = null;
function scheduleBriefSave() {
  if (_briefSaveTimer) clearTimeout(_briefSaveTimer);
  _briefSaveTimer = setTimeout(async () => {
    _briefSaveTimer = null;
    const ov = document.getElementById('briefOverviewInput');
    const list = document.getElementById('briefDishesList');
    if (!ov || !list) return;
    const dishes = [0, 1, 2].map(i => ({
      name: (list.querySelector(`[data-brief-dish="${i}"][data-field="name"]`)?.value || '').trim(),
      why:  (list.querySelector(`[data-brief-dish="${i}"][data-field="why"]`)?.value  || '').trim(),
    }));
    try {
      await updateDoc(doc(db, 'events', eventId), {
        'venue.brief.overview': ov.value.trim(),
        'venue.brief.dishes': dishes,
        'venue.brief.edited': true,
      });
      ov.dataset.dirty = '';
      list.dataset.dirty = '';
    } catch (e) { console.error('brief save error:', e); }
  }, 600);
}

document.getElementById('briefOverviewInput')?.addEventListener('input', (e) => {
  e.target.dataset.dirty = '1';
  scheduleBriefSave();
});
document.getElementById('briefDishesList')?.addEventListener('input', (e) => {
  const list = document.getElementById('briefDishesList');
  if (list) list.dataset.dirty = '1';
  scheduleBriefSave();
});

// 参加者に見せるトグル
document.getElementById('briefVisibleToggle')?.addEventListener('change', async (e) => {
  try {
    await updateDoc(doc(db, 'events', eventId), { 'venue.brief.visible': !!e.target.checked });
  } catch (err) {
    showToast('切替に失敗しました');
    e.target.checked = !e.target.checked;
  }
});

// 再取得ボタン（edited=true なら確認）
document.getElementById('regenerateVenueBriefBtn')?.addEventListener('click', () => {
  const b = latestEventData?.venue?.brief;
  if (b && b.edited) {
    if (!confirm('編集した内容は上書きされます。よろしいですか？')) return;
  }
  invokeGenerateVenueBrief();
});

// 削除ボタン
document.getElementById('deleteVenueBriefBtn')?.addEventListener('click', async () => {
  if (!confirm('店情報を削除しますか？')) return;
  try {
    await updateDoc(doc(db, 'events', eventId), { 'venue.brief': deleteField() });
    showToast('店情報を削除しました');
  } catch (e) { showToast('削除に失敗しました'); console.error(e); }
});
```

- [ ] **Step 3: 構文チェック & push**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ; cd "$R"
node -e "const fs=require('fs');const h=fs.readFileSync('test/index.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/_chk.mjs',m[1]);" && node --check /tmp/_chk.mjs && echo SYNTAX_OK
git -C "$R" add test/index.html
git -C "$R" commit -m "feat(ui): venue brief edit/regenerate/delete/toggle handlers"
git -C "$R" push origin main
```

- [ ] **Step 4: 手動検証（テスト環境）**

ユーザーに以下を確認してもらう:
- 概要を編集 → 別画面に移動 → 戻ってきて編集が保存されている
- 「参加者に見せる」ON → 参加者URL で見えるようになる（Task 8 で仕上げ）
- 「再取得」→ 編集有りなら confirm、なしなら即再生成
- 「削除」→ confirm → プレビューが消え「店情報を取得」ボタンに戻る

---

## Task 8: 参加者側 brief 描画

**Files:**
- Modify: `test/index.html` （`renderAnnounceView` および `announceCard` 内 HTML）

**Interfaces:**
- Consumes: `data.venue.brief`（`visible=true` の時のみ表示）
- Produces:
  - HTML: `#participantBriefSection`（announceCard 内、既存 venue プレビューの下）
  - JS: `renderAnnounceView` 内で `brief.visible === true` の時のみ埋め込み

- [ ] **Step 1: 参加者側の表示エリア HTML を追加**

`announceCard` 内、既存の `venueWrap`（読み取り用 venue プレビュー）の直後に：

```html
<div id="participantBriefSection" style="display:none; margin-top:14px; padding:14px; background:#FBF7EC; border:1px solid var(--border); border-radius:10px;">
  <div style="font-size:0.85rem; font-weight:700; color:var(--green); margin-bottom:6px;">📖 お店の概要</div>
  <p id="participantBriefOverview" style="font-size:0.86rem; line-height:1.7; color:var(--text); margin:0 0 12px;"></p>
  <div style="font-size:0.85rem; font-weight:700; color:var(--green); margin-bottom:6px;">🍽 おすすめメニュー</div>
  <ol id="participantBriefDishes" style="font-size:0.86rem; line-height:1.7; color:var(--text); padding-left:1.2em; margin:0;"></ol>
  <div style="font-size:0.68rem; color:var(--text-muted); margin-top:8px;">
    ※ AIによる自動要約のため、実際の情報と異なる場合があります。
  </div>
</div>
```

- [ ] **Step 2: renderAnnounceView 内に参加者描画ロジックを追加**

`renderAnnounceView(data)` の末尾（既存の `if (shareInput) shareInput.value = ...` の直後）に：

```javascript
// 参加者側 brief 描画（visible=true かつ overview あり かつ dishes 有効時のみ）
const briefSec = document.getElementById('participantBriefSection');
const brief = data.venue && data.venue.brief;
const showBrief = brief && brief.visible === true && brief.overview
  && Array.isArray(brief.dishes) && brief.dishes.length > 0;
if (briefSec) {
  if (showBrief && !isHost) {
    briefSec.style.display = 'block';
    const ovEl = document.getElementById('participantBriefOverview');
    const dishesEl = document.getElementById('participantBriefDishes');
    if (ovEl) ovEl.textContent = brief.overview;
    if (dishesEl) {
      dishesEl.innerHTML = brief.dishes.filter(d => d && d.name).map(d =>
        `<li><strong>${escHtml(d.name)}</strong>：${escHtml(d.why || '')}</li>`
      ).join('');
    }
  } else {
    briefSec.style.display = 'none';
  }
}
```

- [ ] **Step 3: 構文チェック & push**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ; cd "$R"
node -e "const fs=require('fs');const h=fs.readFileSync('test/index.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/_chk.mjs',m[1]);" && node --check /tmp/_chk.mjs && echo SYNTAX_OK
git -C "$R" add test/index.html
git -C "$R" commit -m "feat(ui): participant view for venue brief"
git -C "$R" push origin main
```

- [ ] **Step 4: 手動検証**

ユーザーに以下を確認してもらう:
- ホストで brief 取得 → 「参加者に見せる」OFF → 参加者URL で brief が見えない
- ON → 参加者URL で brief が見える
- 参加者URLで overview と dishes が escHtml 経由で安全に描画される（HTML タグを含む文字列を入れて再検証）

---

## Task 9: テスト環境で最終確認 → 本番反映

**Files:**
- Modify: `index.html`（root, promote 対象）

**Interfaces:**
- Consumes: `test/index.html`（承認済み）
- Produces: `index.html`（root と同一）

- [ ] **Step 1: テスト環境の総合動作確認**

ユーザーに以下シナリオを試してもらう:
- venue.shop 空欄 → 「店情報を取得」ボタンが disabled（実装は Task 6 のボタン disabled 制御 → Function 側で SHOP_EMPTY 例外を Toast 表示）
- venue.shop に有名店（例：「銀座 うち山」）を入れて取得 → 妥当な概要と料理3件
- venue.shop に架空の店名を入れて取得 → NO_RESULTS もしくは低精度な要約が返る → 削除して再入力
- 5秒以内に連続クリック → RATE_LIMITED（Toast）
- 別ホスト（共同ホスト）でも取得可能
- 参加者では取得ボタン自体が見えない（`.host-only`）

- [ ] **Step 2: 本番へ promote**

```bash
R=/Users/kyoichi/Downloads/Claud用/日程調整アプリ
cp "$R/test/index.html" "$R/index.html"
diff -q "$R/test/index.html" "$R/index.html" && echo "root == test ✓"
git -C "$R" add index.html
git -C "$R" commit -m "release: promote venue brief feature to production"
git -C "$R" push origin main
```

- [ ] **Step 3: 本番稼働確認**

Pages ビルド完了後、`https://smcc-tools.github.io/chouseikun/` で新機能が本番に反映されていることを確認。

```bash
sleep 60
C=$(curl -s "https://smcc-tools.github.io/chouseikun/")
echo -n "本番: venueBriefSection: "; echo "$C" | grep -c 'id="venueBriefSection"'
echo -n "本番: participantBriefSection: "; echo "$C" | grep -c 'id="participantBriefSection"'
```

期待: 各 1。

---

## Self-Review

**1. Spec coverage:**
- ゴール1（無料枠運用）→ Task 1 で Secrets 3件、Task 5 で CSE/Gemini 呼び出し ✓
- ゴール2（複数情報源）→ Task 2 で 2種のクエリ、Task 3 でドメイン重複除去 ✓
- ゴール3（2項目に絞り精度重視）→ Task 4 で JSON schema 強制＋温度 0.3 ✓
- ゴール4（ホストが完全制御）→ Task 6 の取得ボタン、Task 7 の編集・再取得・削除・トグル ✓
- ゴール5（既存 venue に非破壊追加）→ 全 task で `venue.brief` のみ触る ✓
- ゴール6（失敗時グレースフルデグラデーション）→ Task 6 の 4 状態表示 + Task 8 の visible ガード ✓

**2. Placeholder scan:** TBD/TODO/「適切なエラー処理」等の抽象語なし。

**3. Type consistency:**
- `generateVenueBriefImpl({ uid, eventId, secrets })` — Task 1 と Task 5 で一致 ✓
- `brief = { overview, dishes[3], generatedAt, sourceQuery, edited, visible, error? }` — spec と全 UI 経路で一致 ✓
- `dishes[i] = { name, why }` — Task 4/6/7/8 で一致 ✓
- `applyVenueBriefState(brief)` — Task 6 で定義、Task 6/7/8 の renderAnnounceView 内から呼出 ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-09-venue-brief.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 各タスクを fresh subagent に task-brief と共に渡して実装 → タスクごとに review → 完了後に broad review。純粋関数（Task 2〜4）は node --test で TDD 完結、統合部（Task 5〜9）は test 環境デプロイで実機検証。

**2. Inline Execution** - このセッションで一気に実行、Task 完了ごとに checkpoint でユーザーレビュー。デプロイ待ちや Secrets 登録が挟まるため、ユーザー側の操作待ちタスクが多い（Task 1 の Google CSE / Gemini API Key 発行、各 Task 後の test 環境実機確認）。

**Which approach?**
