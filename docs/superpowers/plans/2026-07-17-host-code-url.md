# ホスト専用URL（Googleログイン不要ホスト）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存ホストが発行する「ホスト専用URL」を開くだけで、Googleログインしていない人（匿名認証）でもホスト権限（ownerUids）を得られるようにする。

**Architecture:** コードは `events/{id}/private/host`（ホストのみ読み書き可の非公開サブコレクション）に保存。引き換えは callable `claimHostByCode` がサーバー側で照合し Admin SDK で `ownerUids` に arrayUnion。フロントは URL の `hostcode` パラメータ検出→匿名サインイン→claim→URLからコード除去。

**Tech Stack:** Firestore security rules, Cloud Functions v2 (onCall, Node 22), Firebase Auth (anonymous), 素のHTML/JS, node:test

## Global Constraints

- スペック: `docs/superpowers/specs/2026-07-17-host-code-url-design.md`（要件が正）
- フロント編集対象は **`test/index.html` のみ**（root は promote 経由）
- functions テスト: `cd functions && npm test`（既存74件が回帰基準。glob拡張時は hostCode を追加）
- デプロイ: `firebase deploy --only <target> --project chouseikun-tabel --account takedakyoichi0926@gmail.com`
- コード形式: `randomId(20)`（英小文字+数字、フロント既存関数）。検証は `/^[a-z0-9]{20}$/`
- URL形式: `?event=<id>&hostcode=<code>`。引き換え後は成否に関わらず URL から hostcode を除去
- エラーマップ: UNAUTHENTICATED→unauthenticated / INVALID_ARG→invalid-argument / RATE_LIMITED→resource-exhausted / INVALID_CODE→permission-denied / 他→internal
- コミット末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: firestore.rules に非公開サブコレクションのブロック追加＋デプロイ

**Files:**
- Modify: `firestore.rules`（`match /events/{eventId} { ... }` ブロックの**直後**、function 定義群の前）

**Interfaces:**
- Produces: `events/{eventId}/private/{docId}` への read/write が「ownerUids に入っている認証ユーザーのみ」になるルール

- [ ] **Step 1: ルールブロックを追加**

`match /events/{eventId} { ... }` の閉じ括弧の直後に挿入:

```
    // ホストコード等の非公開データ：イベントのホストのみ読み書き可（参加者からは読めない）
    match /events/{eventId}/private/{docId} {
      allow read, write: if request.auth != null
        && get(/databases/$(database)/documents/events/$(eventId)).data.ownerUids.hasAny([request.auth.uid]);
    }
```

- [ ] **Step 2: デプロイ**

Run: `firebase deploy --only firestore:rules --project chouseikun-tabel --account takedakyoichi0926@gmail.com`
Expected: `✔ Deploy complete!`

- [ ] **Step 3: Commit**

```bash
git add firestore.rules
git commit -m "feat(host-code): events/{id}/private をホスト専用の非公開領域としてルール追加"
```

---

### Task 2: functions/hostCode — claimHostByCode（検証TDD＋本体＋export＋デプロイ）

**Files:**
- Create: `functions/hostCode/index.js`
- Create: `functions/hostCode/tests/index.test.js`
- Modify: `functions/index.js`（末尾に onCall 追加）、`functions/package.json`（test glob に hostCode 追加）

**Interfaces:**
- Produces: callable `claimHostByCode`（payload `{eventId, code}` → `{ok:true}`）、
  `validateClaimInput(data) -> {error} | {eventId, code}`

- [ ] **Step 1: 失敗するテストを書く**（`functions/hostCode/tests/index.test.js`）

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateClaimInput } = require('../index');

test('入力検証: 正常系（trim込み）', () => {
  const r = validateClaimInput({ eventId: ' abc123XYZ_-4 ', code: 'a1b2c3d4e5f6g7h8i9j0' });
  assert.deepEqual(r, { eventId: 'abc123XYZ_-4', code: 'a1b2c3d4e5f6g7h8i9j0' });
});

test('入力検証: eventId 空・65字・不正文字はエラー', () => {
  assert.equal(validateClaimInput({ eventId: '', code: 'a'.repeat(20) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'x'.repeat(65), code: 'a'.repeat(20) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'a/b', code: 'a'.repeat(20) }).error, 'INVALID_ARG');
});

test('入力検証: code は英小文字+数字ちょうど20文字のみ', () => {
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'a'.repeat(19) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'a'.repeat(21) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'A'.repeat(20) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: '' }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'a1b2c3d4e5f6g7h8i9j0' }).code, 'a1b2c3d4e5f6g7h8i9j0');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd functions && node --test hostCode/tests/*.test.js`
Expected: FAIL（`Cannot find module '../index'`）

- [ ] **Step 3: hostCode/index.js を実装**

```js
// ホスト専用URLの引き換え：コードを非公開領域と照合し、呼び出し元 uid を ownerUids に追加する。
// コードの照合はサーバー側のみ（events/{id}/private はルールでホスト以外読めない）。
const admin = require('firebase-admin');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）。key = uid
const _lastCallAt = new Map();
const RATE_LIMIT_MS = 3000; // コード空間は 36^20 なので総当たりは実質不可能だが保険

function validateClaimInput(data) {
  const eventId = String((data && data.eventId) || '').trim();
  if (!eventId || eventId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(eventId)) return { error: 'INVALID_ARG' };
  const code = String((data && data.code) || '').trim();
  if (!/^[a-z0-9]{20}$/.test(code)) return { error: 'INVALID_ARG' };
  return { eventId, code };
}

async function claimHostByCodeImpl({ uid, data }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  const input = validateClaimInput(data || {});
  if (input.error) throw new Error(input.error);

  const last = _lastCallAt.get(uid) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) throw new Error('RATE_LIMITED');
  _lastCallAt.set(uid, now);

  const db = admin.firestore();
  const privSnap = await db.doc(`events/${input.eventId}/private/host`).get();
  if (!privSnap.exists || String((privSnap.data() || {}).code || '') !== input.code) {
    throw new Error('INVALID_CODE'); // doc 不在と不一致は区別しない（存在の探索を防ぐ）
  }
  await db.doc(`events/${input.eventId}`).update({
    ownerUids: admin.firestore.FieldValue.arrayUnion(uid),
  });
  return { ok: true };
}

module.exports = { claimHostByCodeImpl, validateClaimInput, RATE_LIMIT_MS };
```

- [ ] **Step 4: functions/index.js に onCall を追加**（suggestOrderPlan の直後。onCall/HttpsError は import 済みを使う）

```js
// ホスト専用URLの引き換え（Callable、匿名認証でも可）
const { claimHostByCodeImpl } = require('./hostCode');

exports.claimHostByCode = onCall({
  region: 'asia-northeast1',
  memory: '256MiB',
}, async (request) => {
  const uid = request.auth && request.auth.uid;
  try {
    return await claimHostByCodeImpl({ uid, data: request.data || {} });
  } catch (e) {
    const code = e.message === 'UNAUTHENTICATED' ? 'unauthenticated'
      : e.message === 'INVALID_ARG' ? 'invalid-argument'
      : e.message === 'RATE_LIMITED' ? 'resource-exhausted'
      : e.message === 'INVALID_CODE' ? 'permission-denied'
      : 'internal';
    throw new HttpsError(code, e.message);
  }
});
```

- [ ] **Step 5: package.json の test glob を拡張してテスト実行**

```json
"test": "node --test venueBrief/tests/*.test.js orderPlan/tests/*.test.js hostCode/tests/*.test.js"
```

Run: `cd functions && node --check index.js && npm test`
Expected: 構文OK・77件全 PASS（74+新規3）

- [ ] **Step 6: デプロイ**

Run: `firebase deploy --only functions:claimHostByCode --project chouseikun-tabel --account takedakyoichi0926@gmail.com`
Expected: `✔ Deploy complete!`（新規関数）

- [ ] **Step 7: Commit**

```bash
git add functions/hostCode functions/index.js functions/package.json
git commit -m "feat(host-code): callable claimHostByCode（匿名可・非公開コード照合・arrayUnion）"
```

---

### Task 3: 匿名認証プロバイダの有効化（コントローラ実施）

**Files:** なし（Firebase プロジェクト設定）

- [ ] **Step 1: API 経由で有効化を試す**

```bash
TOKEN=$(gcloud auth print-access-token 2>/dev/null) && curl -s -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/chouseikun-tabel/config?updateMask=signIn.anonymous.enabled" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"signIn":{"anonymous":{"enabled":true}}}'
```

Expected: JSON応答に `"anonymous": {"enabled": true}`。
gcloud が無い/権限不足なら、ユーザーに Firebase コンソール
（Authentication → Sign-in method → 匿名 → 有効にする）を依頼する。

---

### Task 4: フロント — 発行UI・引き換えフロー・匿名ヘッダー対応

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: Task 2 の callable、既存 `randomId`/`copyText`/`showToast`/`getDoc`/`setDoc`/`doc`/`auth`
- Produces: トップレベル純関数 `stripHostCodeFromUrl(search) -> string`（Task 5 のテスト対象）

- [ ] **Step 1: firebase-auth の import に signInAnonymously を追加**

`import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from ".../firebase-auth.js";`
の import リストに `signInAnonymously` を追加。

- [ ] **Step 2: callable を追加**（`generateVenueBriefCallable`/`suggestOrderPlanCallable` の並び）

```js
  const claimHostByCodeCallable = httpsCallable(functions, 'claimHostByCode');
```

- [ ] **Step 3: stripHostCodeFromUrl（トップレベル、aiErrorToJa の近く）**

```js
  // ホスト専用URLの hostcode をアドレスバーから除去した search 文字列を返す（履歴・共有時の漏えい防止）
  function stripHostCodeFromUrl(search) {
    const p = new URLSearchParams(search || '');
    p.delete('hostcode');
    const s = p.toString();
    return s ? '?' + s : '';
  }
```

- [ ] **Step 4: 引き換えフロー**

`onAuthStateChanged(auth, async user => { ... })` のコールバック冒頭（currentUser 代入直後）に追加:

```js
    // ホスト専用URL（?hostcode=）の引き換え。認証状態が確定してから1回だけ実行
    claimHostByUrlCode();
```

トップレベル（onAuthStateChanged の定義より前でも後でも可、関数宣言なので巻き上げで届く）に追加:

```js
  // ── ホスト専用URLの引き換え ──
  let _hostCodeClaimTried = false;
  async function claimHostByUrlCode() {
    if (_hostCodeClaimTried) return;
    const params = new URLSearchParams(location.search);
    const evId = params.get('event');
    const code = params.get('hostcode');
    if (!evId || !code) return;
    _hostCodeClaimTried = true;
    try {
      if (!auth.currentUser) await signInAnonymously(auth); // 未ログインなら匿名で自動サインイン
      await claimHostByCodeCallable({ eventId: evId, code });
      showToast('ホストとして参加しました');
    } catch (e) {
      showToast('ホスト用URLが無効です');
      console.error('host-code claim error:', e);
    } finally {
      // 成否に関わらず URL からコードを除去（履歴・共有・リロード時の漏えい/再実行防止）
      try { history.replaceState(history.state, '', location.pathname + stripHostCodeFromUrl(location.search)); } catch (_) {}
    }
  }
```

- [ ] **Step 5: 発行UI**

`#coHostWrap` の中（共同ホスト一覧・追加UIの後）に静的HTMLを追加:

```html
    <div style="margin-top:12px;border-top:1px solid var(--line-soft);padding-top:10px;">
      <button class="btn btn-secondary" id="issueHostCodeBtn" style="font-size:0.82rem;">ホスト専用URLを発行</button>
      <div id="hostCodeUrlWrap" style="display:none;margin-top:8px;">
        <div style="display:flex;gap:8px;">
          <input type="text" id="hostCodeUrlInput" readonly style="flex:1;font-size:0.78rem;margin-bottom:0;">
          <button class="btn btn-secondary" id="copyHostCodeUrlBtn" style="white-space:nowrap;">コピー</button>
        </div>
        <p style="font-size:0.7rem;color:var(--text-muted);margin-top:6px;line-height:1.6;">このURLを開いた人は<strong>Googleログイン不要でホスト</strong>になれます。取り扱いにご注意ください（URLは固定で、後から無効化できません）。</p>
      </div>
    </div>
```

JS（イベントページのハンドラ群の近く）:

```js
  // ホスト専用URLの発行（1イベント1コード・固定）。コードは非公開サブコレクションに保存
  document.getElementById('issueHostCodeBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('issueHostCodeBtn');
    const wrap = document.getElementById('hostCodeUrlWrap');
    const inp = document.getElementById('hostCodeUrlInput');
    if (!btn || !wrap || !inp || !eventId) return;
    btn.disabled = true;
    try {
      const ref = doc(db, 'events', eventId, 'private', 'host');
      const snap = await getDoc(ref);
      let code = snap.exists() ? String(snap.data().code || '') : '';
      if (!code) {
        code = randomId(20);
        await setDoc(ref, { code, createdAt: Date.now() });
      }
      inp.value = `${location.origin}${location.pathname}?event=${encodeURIComponent(eventId)}&hostcode=${code}`;
      wrap.style.display = 'block';
    } catch (e) {
      showToast('ホスト専用URLの発行に失敗しました');
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('copyHostCodeUrlBtn')?.addEventListener('click', () => {
    const inp = document.getElementById('hostCodeUrlInput');
    if (inp && inp.value) copyText(inp.value, document.getElementById('copyHostCodeUrlBtn'), 'ホスト専用URL');
  });
```

- [ ] **Step 6: 匿名ユーザーのヘッダー対応**

`onAuthStateChanged` の `if (user) { ... } else { ... }` を3分岐にする。
**匿名ユーザーではホストUIをクリアしない**こと（else 節の「未ログイン：ホストUIをクリア」処理を匿名に適用しない）:

```js
    if (user && !user.isAnonymous) {
      // 既存のログイン済み処理（変更なし）
    } else if (user) {
      // 匿名ユーザー：ログインボタンは出したまま。ホストUI・マイイベントはそのまま動かす
      signInBtn.style.display = 'flex';
      authUser.style.display = 'none';
    } else {
      // 既存の未ログイン処理（変更なし）
    }
```

- [ ] **Step 7: 検証**

```bash
node --test tests/frontend/*.test.js   # 既存43件回帰
python3 -c "
import re
html = open('test/index.html').read()
s = re.findall(r'<script type=\"module\">(.*?)</script>', html, re.S)[0]
open('/tmp/m.mjs','w').write(s)" && node --check /tmp/m.mjs
grep -c "claimHostByUrlCode\|issueHostCodeBtn\|stripHostCodeFromUrl\|signInAnonymously" test/index.html  # 全て存在
```

- [ ] **Step 8: Commit**

```bash
git add test/index.html
git commit -m "feat(host-code): ホスト専用URLの発行UI・引き換えフロー・匿名ヘッダー対応 (test)"
```

---

### Task 5: フロント特性化テスト（stripHostCodeFromUrl）＋全体検証

**Files:**
- Create: `tests/frontend/hostcode.test.js`

- [ ] **Step 1: テストを書く**

```js
// ホスト専用URLの hostcode 除去ロジックの特性化テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { stripHostCodeFromUrl } = loadFunctions(['stripHostCodeFromUrl']);

test('hostcode だけを除去し、他のパラメータは維持する', () => {
  assert.equal(stripHostCodeFromUrl('?event=abc&hostcode=xyz'), '?event=abc');
  assert.equal(stripHostCodeFromUrl('?hostcode=xyz&event=abc&foo=1'), '?event=abc&foo=1');
});

test('hostcode が無ければそのまま（正規化差のみ許容）', () => {
  assert.equal(stripHostCodeFromUrl('?event=abc'), '?event=abc');
});

test('hostcode のみの場合は空文字を返す（? を残さない）', () => {
  assert.equal(stripHostCodeFromUrl('?hostcode=xyz'), '');
});

test('空・null 入力でも例外を投げない', () => {
  assert.equal(stripHostCodeFromUrl(''), '');
  assert.equal(stripHostCodeFromUrl(null), '');
});
```

- [ ] **Step 2: 実行**

Run: `node --test tests/frontend/hostcode.test.js`
Expected: 4件 PASS（Task 4 実装済みのため）

- [ ] **Step 3: 全テスト**

Run: `node --test tests/frontend/*.test.js && (cd functions && npm test)`
Expected: フロント47件 + functions 77件 全 PASS

- [ ] **Step 4: Commit**

```bash
git add tests/frontend/hostcode.test.js
git commit -m "test(host-code): hostcode除去ロジックの特性化テスト"
```

---

### Task 6: test/ デプロイと実機確認依頼（コントローラ実施）

- [ ] **Step 1: push して CI（テストゲート→deploy）通過を確認**
- [ ] **Step 2: ユーザーに実機確認を依頼**: ①ホストで「ホスト専用URLを発行」→URLコピー
  ②シークレットモード（未ログイン）でURLを開く→ホストUIが出る ③URLバーから hostcode が消えている
- [ ] **Step 3: 承認後 promote**（ユーザー承認が出るまで実行しない）
