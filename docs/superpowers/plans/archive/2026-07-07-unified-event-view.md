# 統合イベント（1URL・表示画面切替）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1イベント=1参加者URLにし、ホストが「参加者に表示」ボタンで公開画面(`activeView`)を切り替え、各機能は独立ページ＋ホスト用下部ナビで遷移できるようにする。

**Architecture:** 全機能データを `events/{id}` 1ドキュメントに内包。参加者に見える画面は共有フィールド `activeView`、ホストの作業画面はローカル状態 `hostView`。`onSnapshot` 内の中央ルータ `showEventPage(view)` が該当機能の1ページだけを表示する。旧「イベントハブ（子レコード/parentEventId）」は撤去して作り替える。

**Tech Stack:** 静的 `test/index.html`（inline ESM）、Firebase v11（firestore/auth/messaging）、Firestore Rules、GitHub Pages(main push→Actions)。

## Global Constraints

- 変更対象は `test/index.html` と `firestore.rules` のみ（本番 root `index.html` は触らない。承認後に別途 promote）。
- ブランチは `feature/unified-event-view`（`main` から分岐済み）。
- Firebase/gcloud は `--project chouseikun-tabel --account takedakyoichi0926@gmail.com`。
- テストランナー非搭載。各タスクの検証は「抽出した `<script type="module">` を `node --check`」＋コードレビュー＋（最終）ユーザーのブラウザ実機確認（`/chouseikun/test/`）。ブラウザ自動E2Eは不可（Googleログイン要）。
- `activeView` ∈ `'scheduleCreate' | 'schedule' | 'announce' | 'seating' | 'walica' | 'settle'`。`gourmet`（お店検索）はホスト専用作業画面で `activeView` の値にはしない。
- 旧データ互換：`activeView` 未設定なら `data.walica?'walica':data.seating?'seating':data.settleOnly?'settle':'schedule'` に読み替える（書込なし）。
- 「参加者に表示」ボタンは 日程調整/お知らせ/座席決め/割り勘/精算 の5画面のみ。スケジュール作成・お店検索には置かない。
- 各機能は独立ページ（他機能の内容を同一ページに混在させない）。参加者には下部ナビを表示しない。
- `node --check` 用の抽出コマンド（各検証ステップで使用）:
  ```bash
  cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ && node -e "const fs=require('fs');const h=fs.readFileSync('test/index.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/_chk.mjs',m[1]);" && node --check /tmp/_chk.mjs && echo SYNTAX_OK
  ```

**既存コードの主要な位置（実装者向けの地図）:**
- 画面カード（HTML）: `menuCard`(857) `myEventsCard`(918) `setupCard`(929, 日程作成) `settleSetupCard`(1012) `walicaSetupCard`(1032) `seatingSetupCard`(1061) `gourmetCard`(1090, Tabel iframe `gFrame`) `viewCard`(1099, 日程投票) `settleCard`(1229) `walicaCard`(1341) `seatingCard`(1380)。
- venue: `venueWrap`(1121, 表示) `venueEdit`(1146, ホスト用URL入力) `renderVenue`(3183) `data.venue`、Cloud Function `fetchVenuePreview`（`functions/index.js`、url保存でpreview補完）。
- ナビ関数: `goToMenu`(1794) `hideOtherSetupCards`(1802) `goToSchedule`(1808) `goToSettleSetup`(1813) `goToWalicaSetup`(1822) `goToSeatingSetup`(1832) `goToGourmet`(1849)、`SETUP_CARDS` 配列。
- イベント描画: `onSnapshot`(2656) ハンドラ。現状 `data.walica`→walicaCard / `data.seating`→seatingCard / `settleOnly|settlePublished`→settle / それ以外→viewCard。`evaluateHost`(2612)、`renderVenue`呼び出し(2704)、参加者/ホストの精算オートオープン(2745-2757)。
- 各機能描画: `renderTable`（日程投票）、`renderWalicaBoard`(3408)、`renderSeatingBoard`(3819)、`openSettlePage`(4971)。
- 撤去対象（旧ハブ）: `renderEventHub`(1889)＋呼出(2667)、`launchFromEvent`(1864)、`migrateEmbeddedSettles`(2079)＋`onAuthStateChanged`内の呼出、`hubParentEventId` 宣言＋全使用、作成ハンドラの `...(hubParentEventId?{parentEventId...}:{})` スプレッド、`#eventHub` HTML(1216-1222付近)、`.hub-link` CSS、`HUB_LINK_LABEL`、ハブボタン `hubSettle/hubWalica/hubSeating/hubGourmet`。
- 作成ハンドラ: 日程作成(~2395)、`createSettleBtn`(2411)、`createWalicaBtn`(2455)、`createSeatingBtn`(2497)。`addMyEvent`(2071)、`randomId`(1563)。
- メニュータイル: `menuScheduleBtn`(860) `menuSettleBtn`(872) `menuWalicaBtn`(879) `menuSeatingBtn`(890) `menuGourmetBtn`(903)、配線(2057付近)。

---

# フェーズA：統合イベント基盤（既存4機能で成立）

## Task 1: Firestore ルールを activeView 方式へ

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Produces: `events` の create が `activeView`（任意・string）を許容し `parentEventId` 前提を撤去。update は `isOwner()` が全項目許可（`activeView`/`meetTime`/`venue` 含む）。参加者の hasOnly ホワイトリスト（`isParticipantWrite`/`isPaidToggle`/`isWalicaWrite`/`isLegacyClaim`）は不変。

- [ ] **Step 1: create ルールの parentEventId を activeView に差し替え**

`firestore.rules` の `allow create` を次に変更（`parentEventId` の行を `activeView` に置換）:

```
      allow create: if request.auth != null
        && request.resource.data.ownerUids is list
        && request.resource.data.ownerUids.size() == 1
        && request.auth.uid in request.resource.data.ownerUids
        && (!('activeView' in request.resource.data)
            || request.resource.data.activeView is string);
```

- [ ] **Step 2: update ルールは変更不要を確認**

`allow update: if isOwner() || isParticipantWrite() || isPaidToggle() || isWalicaWrite() || isLegacyClaim();` はそのまま。`isOwner()` がホストの全項目更新（`activeView`/`meetTime`/`venue`）を許可し、参加者ホワイトリストには `activeView` 等を含めない（＝参加者は変更不可）。コードを読んで確認するだけ。

- [ ] **Step 3: デプロイ**

Run:
```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ && firebase deploy --only firestore:rules --project chouseikun-tabel --account takedakyoichi0926@gmail.com
```
Expected: `Deploy complete!`

- [ ] **Step 4: Commit**

```bash
git add firestore.rules && git commit -m "feat(rules): allow optional activeView on events, drop parentEventId"
```

---

## Task 2: 旧「イベントハブ」機構を撤去

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Produces: `renderEventHub` / `launchFromEvent` / `migrateEmbeddedSettles` / `hubParentEventId` / `#eventHub` / `.hub-link` / `HUB_LINK_LABEL` が存在しないクリーンな基盤。作成ハンドラは `parentEventId` を書かない。

- [ ] **Step 1: JS の撤去**

`test/index.html` から以下を削除：
- 関数 `renderEventHub`（1889付近、`const HUB_LINK_LABEL` 行から関数閉じ `}` まで）と、`onSnapshot` 内の呼出 `renderEventHub(data, eventId);`（2667）。
- 関数 `launchFromEvent`（1864付近、全体）。
- 関数 `migrateEmbeddedSettles`（2079付近、全体）と `let settleMigrationRan = false;`、および `onAuthStateChanged` 内の `await migrateEmbeddedSettles();` 呼出。
- `let hubParentEventId = null;` 宣言、`goToSettleSetup`/`goToWalicaSetup`/`goToSeatingSetup` 冒頭の `hubParentEventId = null;` 行。
- 作成ハンドラ3箇所（`createSettleBtn`2443 / `createWalicaBtn`2486 / `createSeatingBtn`のsetDoc）の `...(hubParentEventId ? { parentEventId: hubParentEventId } : {}),` 行。

- [ ] **Step 2: HTML/CSS の撤去**

- `#eventHub` ブロック（`viewCard` 内、1216-1222付近の「この会でできること」〜`<div id="hubLinked">`まで）を削除。
- `.hub-link` / `.hub-link:hover` の CSS を削除。

- [ ] **Step 3: 未使用 import の整理**

`renderEventHub` 撤去で `query`,`where` が他で未使用なら 1447 の firestore import から外す。Run で使用箇所を確認：
```bash
cd /Users/kyoichi/Downloads/Claud用/日程調整アプリ && grep -n "query(\|where(" test/index.html
```
Expected: 0件なら import から `query, where` を削除。1件以上残るなら import はそのまま。

- [ ] **Step 4: 構文チェック**

Global Constraints の抽出コマンドを実行。Expected: `SYNTAX_OK`。加えて `grep -n "hubParentEventId\|renderEventHub\|launchFromEvent\|migrateEmbeddedSettles\|parentEventId\|hub-link\|eventHub" test/index.html` が 0件。

- [ ] **Step 5: Commit**

```bash
git add test/index.html && git commit -m "refactor: remove event-hub (parentEventId/child-record) machinery"
```

---

## Task 3: activeView 導出 ＋ 中央ルータ showEventPage

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: 既存 `renderTable`/`renderWalicaBoard`/`renderSeatingBoard`/`openSettlePage`/`renderVenue`。
- Produces:
  - `function deriveView(data)` → `'scheduleCreate'|'schedule'|'announce'|'seating'|'walica'|'settle'`。
  - `const EVENT_PAGE_IDS = ['viewCard','settleCard','walicaCard','seatingCard','gourmetCard','announceCard']`（`announceCard` はフェーズBで追加。今はコメントで予約）。
  - `function showEventPage(view)` — イベントページ用コンテナを全て隠し、`view` に対応する1つだけ表示。
  - `let hostView = null;`（ホストのローカル作業画面。null=未選択→participantView にフォールバック）。

- [ ] **Step 1: deriveView とページマップを追加**

`onSnapshot`(2656) の直前（イベント描画ブロック内、`if (eventId) {` の後・`onSnapshot` の前）に追加：

```js
    // 参加者に見せる画面。activeView 優先、無ければ旧フラグから読み替え。
    function deriveView(data) {
      if (data.activeView) return data.activeView;
      if (data.walica) return 'walica';
      if (data.seating) return 'seating';
      if (data.settleOnly) return 'settle';
      return 'schedule';
    }
    // view → 表示するカードID（gourmet はホスト専用作業画面）
    const PAGE_OF = {
      scheduleCreate: 'viewCard', schedule: 'viewCard',
      announce: 'announceCard', seating: 'seatingCard',
      walica: 'walicaCard', settle: 'settleCard', gourmet: 'gourmetCard',
    };
    const EVENT_PAGE_IDS = ['viewCard','settleCard','walicaCard','seatingCard','gourmetCard','announceCard'];
    let hostView = null; // ホストのローカル作業画面（null=公開中の画面を見る）
    function showEventPage(view) {
      const keep = PAGE_OF[view] || 'viewCard';
      EVENT_PAGE_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === keep) ? 'block' : 'none';
      });
    }
```

（`announceCard` はフェーズBで実体を追加。存在しない間 `getElementById` は null を返し無害。）

- [ ] **Step 2: onSnapshot を「1ページだけ描画」に再構成**

`onSnapshot`(2656) ハンドラ本体を、次の骨組みに置き換える（既存の各機能描画呼び出しは温存し、分岐を `view` ベースに統一する）：

```js
    onSnapshot(eventRef, (snap) => {
      if (!snap.exists()) {
        document.getElementById('viewCard').style.display = 'block';
        document.getElementById('tableWrap').innerHTML = '<p class="empty-msg">イベントが見つかりません</p>';
        return;
      }
      const data = snap.data();
      latestEventData = data;
      currentDates = data.dates;
      currentParticipantOrder = data.participantOrder || [];

      evaluateHost(data);

      const participantView = deriveView(data);
      // ホストは hostView（作業画面）を優先。未選択なら公開中の画面。参加者は常に公開中の画面。
      const view = (isHost && hostView) ? hostView : participantView;
      showEventPage(view);
      renderEventView(view, data);
    });
```

- [ ] **Step 3: renderEventView を実装（既存描画を集約）**

`onSnapshot` の直後に、view ごとに既存描画関数へ振り分ける関数を追加。既存の「タイトル/メモ/venue/table/settle同期」ロジックを各 case に移設する（元 2687-2773 の内容を流用）：

```js
    function renderEventView(view, data) {
      // タイトルは全ページ共通で反映
      const titleEl = document.getElementById('viewTitle');
      if (titleEl && titleEl.tagName !== 'INPUT') titleEl.textContent = data.name || '';
      switch (view) {
        case 'schedule':
        case 'scheduleCreate':
          renderScheduleView(data, view); break;   // Task 6 で scheduleCreate 分岐を実装。今は両方 voting。
        case 'walica':   renderWalicaBoard(data); break;
        case 'seating':  renderSeatingBoard(data); break;
        case 'settle':   openSettlePage(data, !isHost); break;
        case 'announce': renderAnnounceView(data); break; // Task 8
        case 'gourmet':  break; // iframe は常設。ホスト作業のみ
        default:         renderScheduleView(data, 'schedule');
      }
    }
    // 既存の日程調整UI（メモ/venue/投票表）をまとめる。フェーズAでは scheduleCreate も voting と同じ表示。
    function renderScheduleView(data, view) {
      renderVenue(data.venue || {});
      renderTable(data.dates, data.participants || {}, data.confirmedDate ?? null, data.participantOrder || []);
    }
```

（注：元ハンドラにあった walica/seating 早期 return や settleOnly 分岐は本 switch に統合するため削除する。`renderAnnounceView`/`scheduleCreate` 実体はフェーズBだが、参照だけ先に用意。フェーズA時点で `renderAnnounceView` が未定義だと `announce` 到達時にエラーになるため、Task 8 まで暫定の空実装 `function renderAnnounceView(){}` を置く。）

- [ ] **Step 4: 構文チェック**

Global Constraints の抽出コマンド。Expected: `SYNTAX_OK`。

- [ ] **Step 5: Commit**

```bash
git add test/index.html && git commit -m "feat: activeView router (showEventPage) renders one function page"
```

---

## Task 4: ホスト用 下部ナビゲーション

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: `hostView`, `showEventPage`, `renderEventView`, `latestEventData`, `isHost`。
- Produces: `#hostNav` 固定バー（7ボタン）。押下で `hostView` を設定し再描画。ホスト時のみ表示。`function setHostView(view)`。

- [ ] **Step 1: 下部ナビの HTML を追加**

`viewCard`〜`seatingCard` 群の後（`</div>` 群の直後、`<script>` の前）に追加：

```html
<nav id="hostNav" style="display:none;position:fixed;left:0;right:0;bottom:0;z-index:50;background:#fff;border-top:1px solid var(--border);display:none;">
  <div style="max-width:760px;margin:0 auto;display:grid;grid-template-columns:repeat(7,1fr);">
    <button type="button" class="hostnav-btn" data-view="scheduleCreate">作成</button>
    <button type="button" class="hostnav-btn" data-view="schedule">日程</button>
    <button type="button" class="hostnav-btn" data-view="gourmet">お店</button>
    <button type="button" class="hostnav-btn" data-view="announce">お知らせ</button>
    <button type="button" class="hostnav-btn" data-view="seating">座席</button>
    <button type="button" class="hostnav-btn" data-view="walica">割り勘</button>
    <button type="button" class="hostnav-btn" data-view="settle">精算</button>
  </div>
</nav>
```

- [ ] **Step 2: CSS を追加**

```css
.hostnav-btn { border:none;background:none;padding:8px 2px;font-size:.72rem;color:var(--text-muted);cursor:pointer;border-top:2px solid transparent; }
.hostnav-btn.active { color:var(--green);border-top-color:var(--green);font-weight:700; }
#hostNav ~ * { }
body.has-hostnav { padding-bottom:56px; }
```

- [ ] **Step 3: setHostView と配線**

`showEventPage` の直後に追加：

```js
    function setHostView(view) {
      hostView = view;
      showEventPage(view);
      if (latestEventData) renderEventView(view, latestEventData);
      document.querySelectorAll('#hostNav .hostnav-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === view));
      window.scrollTo(0, 0);
    }
    document.querySelectorAll('#hostNav .hostnav-btn').forEach(b =>
      b.addEventListener('click', () => setHostView(b.dataset.view)));
```

- [ ] **Step 4: ホスト時に下部ナビを表示**

`evaluateHost`(2612) の `isHost = true;` 分岐内に追加：
```js
      document.getElementById('hostNav').style.display = 'block';
      document.body.classList.add('has-hostnav');
```
また `showEventPage` の `keep` に応じて active を同期するため、`onSnapshot` 内 `showEventPage(view)` の後で（Step 3 の active 反映と同じ処理を）呼ぶ：`document.querySelectorAll('#hostNav .hostnav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));`

- [ ] **Step 5: 構文チェック＋Commit**

抽出コマンドで `SYNTAX_OK`。
```bash
git add test/index.html && git commit -m "feat: host bottom navigation to switch working view"
```

---

## Task 5: 「参加者に表示」ボタン（公開）

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: `eventId`, `isHost`, `updateDoc`, `doc`, `db`, `showToast`。
- Produces: `function publishView(view)` — `updateDoc(events/{id}, {activeView: view})`。日程調整/お知らせ/座席決め/割り勘/精算 の各ページにホスト用「この画面を参加者に表示」ボタンを配置。押下で `publishView`。

- [ ] **Step 1: publishView を実装**

```js
    async function publishView(view) {
      if (!isHost) return;
      try {
        await updateDoc(doc(db, 'events', eventId), { activeView: view });
        showToast('参加者に表示しました');
      } catch (e) { console.error('publishView error:', e); showToast('切り替えに失敗しました'); }
    }
```

- [ ] **Step 2: 各ページに公開ボタンを追加**

`viewCard`(schedule) / `settleCard` / `walicaCard` / `seatingCard` の各ホスト向け領域、および Task 8 の `announceCard` に、`class="host-only"` のボタンを追加（`activeView` 値を data 属性で持たせ、汎用ハンドラで拾う）：

```html
<button type="button" class="btn btn-primary publish-view-btn host-only" data-view="schedule" style="display:none;">この画面を参加者に表示</button>
```
（`viewCard`→`data-view="schedule"`、`settleCard`→`settle`、`walicaCard`→`walica`、`seatingCard`→`seating`、`announceCard`→`announce`。スケジュール作成・お店検索には置かない＝`gourmetCard` と scheduleCreate 用UIには追加しない。）

- [ ] **Step 3: 公開ボタンの配線**

Step 1 の直後に追加：
```js
    document.querySelectorAll('.publish-view-btn').forEach(b =>
      b.addEventListener('click', () => publishView(b.dataset.view)));
```
（`.host-only` は `evaluateHost` が `display:inline-block` で表示制御する既存挙動を利用。）

- [ ] **Step 4: 構文チェック＋Commit**

`SYNTAX_OK` を確認。
```bash
git add test/index.html && git commit -m "feat: publish-view buttons set activeView for participants"
```

---

## Task 6: 作成フローを activeView 方式へ（単体利用の温存）

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Produces: 各作成 setDoc が `activeView` を明示設定（旧フラグは互換のため残置可だが新規は activeView 主導）。日程作成は `activeView:'scheduleCreate'`、単体 精算/割り勘/座席 は各 `activeView:'settle'|'walica'|'seating'`。`renderMyEvents` の種別導出は `deriveView` 相当に統一。

- [ ] **Step 1: 日程作成に activeView を付与**

日程作成の setDoc（~2395, `setDoc(doc(db,'events',eventId), { name, dates, memo, participants, ownerUids:[...], confirmedDate:null, participantOrder })`）に `activeView: 'scheduleCreate'` を追加。

- [ ] **Step 2: 単体作成3種に activeView を付与**

`createSettleBtn`(2439 setDoc) に `activeView: 'settle'`、`createWalicaBtn`(2482 setDoc) に `activeView: 'walica'`、`createSeatingBtn` の setDoc に `activeView: 'seating'` を追加（既存の `settleOnly:true`/`walica:true`/`seating:true` はそのまま残置＝旧互換）。

- [ ] **Step 3: renderMyEvents の種別導出を統一**

`renderMyEvents`(2090) 内の種別導出（2136付近 `data.walica ? ... : 'schedule'`）を、`activeView` 優先に変更：
```js
          e.type = data.activeView
            ? (data.activeView === 'scheduleCreate' ? 'schedule' : data.activeView)
            : (data.walica ? 'walica' : (data.seating ? 'seating' : (data.settleOnly ? 'settle' : 'schedule')));
```

- [ ] **Step 4: 構文チェック＋Commit**

`SYNTAX_OK`。
```bash
git add test/index.html && git commit -m "feat: creation flows set activeView; myEvents type from activeView"
```

---

# フェーズB：ライフサイクル細分化（作成/検索/お知らせ）

## Task 7: お店検索ページで店を venue に保存

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: 既存 `venueEdit`(1146, ホスト用URL入力→`data.venue` 保存→`fetchVenuePreview` が preview 補完)、`gourmetCard`(Tabel iframe)、`showEventPage('gourmet')`。
- Produces: gourmet ページ（ホスト作業）で Tabel を表示しつつ、`venueEdit` の保存で `data.venue` を更新できる導線。参加者には `gourmet` を公開しない（Task 3/5 済み）。

- [ ] **Step 1: gourmet ページから venue 保存へ導線**

`gourmetCard`(1090) の下部（iframe の後）に、ホスト用の「この店を会場にする」導線として既存 `venueEdit` の URL 入力・保存を露出する。`venueEdit` を `gourmetCard` 内（またはナビで gourmet 選択時）に表示するよう、`setHostView('gourmet')` 時に `venueEdit` を `display:block` にする一行を `setHostView` に追加：
```js
      const ve = document.getElementById('venueEdit');
      if (ve) ve.style.display = (view === 'gourmet' && isHost) ? 'block' : 'none';
```

- [ ] **Step 2: venue 保存が activeView を変えないことを確認**

既存の venue 保存ハンドラ（`venueEdit` の保存ボタン→`updateDoc(events/{id}, {venue})`）は `activeView` を変更しない。コードを読んで確認（変更不要なら変更なし）。保存後 `fetchVenuePreview`（Cloud Function）が `venue.preview` を補完する既存挙動を利用。

- [ ] **Step 3: 構文チェック＋Commit**

`SYNTAX_OK`。
```bash
git add test/index.html && git commit -m "feat: expose venue save on gourmet page (host only)"
```

---

## Task 8: お知らせページ（集合時間・お店）

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: `data.confirmedDate`, `data.venue.preview`, `data.meetTime`, `isHost`, `updateDoc`, `publishView`。
- Produces: `#announceCard`（独立ページ）、`function renderAnnounceView(data)`（Task 3 の暫定空実装を実体化）、ホスト用 `meetTime` 入力＋保存、参加者用 読み取り表示。

- [ ] **Step 1: announceCard の HTML を追加**

`seatingCard`(1380) の後に追加：
```html
<div class="card" id="announceCard" style="display:none;">
  <div class="card-title">集合時間・お店のお知らせ</div>
  <div id="announceView"></div>
  <div class="host-only" style="display:none;margin-top:12px;">
    <label style="font-size:.85rem;">集合時間</label>
    <input type="text" id="meetTimeInput" placeholder="例：18:30 現地集合" style="width:100%;margin:6px 0 10px;">
    <button type="button" class="btn btn-secondary" id="saveMeetTimeBtn">集合時間を保存</button>
    <button type="button" class="btn btn-primary publish-view-btn" data-view="announce" style="margin-top:8px;">この画面を参加者に表示</button>
  </div>
</div>
```

- [ ] **Step 2: renderAnnounceView を実体化**

Task 3 で置いた暫定 `function renderAnnounceView(){}` を次に置換：
```js
    function renderAnnounceView(data) {
      const v = data.venue || {}; const pv = v.preview || {};
      const dateStr = data.confirmedDate ? escHtml(data.confirmedDate) : '（開催日 未確定）';
      const timeStr = data.meetTime ? escHtml(data.meetTime) : '（集合時間 未設定）';
      const shop = pv.name ? `<div>お店：${escHtml(pv.name)}</div>` : '<div>お店：（未設定）</div>';
      const link = v.url ? `<div><a href="${escHtml(v.url)}" target="_blank" rel="noopener">お店の情報を見る</a></div>` : '';
      document.getElementById('announceView').innerHTML =
        `<div style="line-height:1.9;"><div>開催日：${dateStr}</div><div>集合：${timeStr}</div>${shop}${link}</div>`;
      const inp = document.getElementById('meetTimeInput');
      if (inp && document.activeElement !== inp) inp.value = data.meetTime || '';
    }
```

- [ ] **Step 3: 集合時間の保存を配線**

Task 5 の publish 配線付近に追加：
```js
    document.getElementById('saveMeetTimeBtn')?.addEventListener('click', async () => {
      if (!isHost) return;
      const val = (document.getElementById('meetTimeInput')?.value || '').trim();
      try { await updateDoc(doc(db, 'events', eventId), { meetTime: val }); showToast('集合時間を保存しました'); }
      catch (e) { console.error(e); showToast('保存に失敗しました'); }
    });
```

- [ ] **Step 4: EVENT_PAGE_IDS に announceCard が含まれることを確認**

Task 3 で `EVENT_PAGE_IDS` に `'announceCard'` を含めた。実体ができたのでルータが正しく切替える。コード確認のみ。

- [ ] **Step 5: 構文チェック＋Commit**

`SYNTAX_OK`。
```bash
git add test/index.html && git commit -m "feat: announce page (meet time + venue) with publish"
```

---

## Task 9: スケジュール作成 と 日程調整 の分離

**Files:**
- Modify: `test/index.html`

**Interfaces:**
- Consumes: `renderScheduleView`(Task 3)、`renderTable`、`isHost`、候補日編集UI（既存 `setupCard` の候補日入力を流用）。
- Produces: `scheduleCreate` ではホストに候補日編集、参加者に「準備中」を表示。`schedule` は投票表。両者を `renderScheduleView(data, view)` で分岐。

- [ ] **Step 1: renderScheduleView に view 分岐を追加**

Task 3 の `renderScheduleView` を次に更新：
```js
    function renderScheduleView(data, view) {
      renderVenue(data.venue || {});
      if (view === 'scheduleCreate') {
        if (isHost) {
          renderTable(data.dates, data.participants || {}, data.confirmedDate ?? null, data.participantOrder || []);
          // ホストは候補日編集（既存の日程編集UIを表示）。参加者には準備中。
        } else {
          document.getElementById('tableWrap').innerHTML = '<p class="empty-msg">日程調整の準備中です。しばらくお待ちください。</p>';
        }
      } else {
        renderTable(data.dates, data.participants || {}, data.confirmedDate ?? null, data.participantOrder || []);
      }
    }
```

- [ ] **Step 2: scheduleCreate に公開ボタン無し・schedule に公開ボタン**

Task 5 で `viewCard` に付けた `data-view="schedule"` の「参加者に表示」ボタンは、`hostView==='scheduleCreate'` の時は隠す。`setHostView` に追加：
```js
      const pubBtn = document.querySelector('.publish-view-btn[data-view="schedule"]');
      if (pubBtn) pubBtn.style.display = (view === 'schedule' && isHost) ? 'inline-block' : 'none';
```
（scheduleCreate 選択時は公開ボタン非表示＝スケジュール作成に公開ボタンを置かない、を満たす。）

- [ ] **Step 3: 新規日程イベントの初期ホスト画面**

Task 6 で日程作成は `activeView:'scheduleCreate'`。作成直後にホストが開くと `deriveView='scheduleCreate'` かつ `hostView=null`→候補日編集が出る。ホストが「日程」ナビ→`schedule`→「参加者に表示」で投票公開、の導線を手動で確認（コードレビュー）。

- [ ] **Step 4: 構文チェック＋Commit**

`SYNTAX_OK`。
```bash
git add test/index.html && git commit -m "feat: split scheduleCreate (host editor) from schedule (voting)"
```

---

## 統合検証・本番反映（全タスク後）

- [ ] ローカル/test で通し確認：1イベント=1URL、ホスト下部ナビで7画面を行き来、各ページは独立表示（他機能混在なし）、「参加者に表示」で参加者の公開画面が切替、お店検索・スケジュール作成は参加者非公開、お知らせに開催日/集合時間/店が出る、単体利用（メニュー）は従来通り、旧データ（旧フラグ）が読み替えで表示。
- [ ] `main` へマージ→push（Actions で `/chouseikun/test/` にデプロイ）。**ユーザー承認を得てから push**。
- [ ] ユーザーが `/chouseikun/test/` で実機確認。
- [ ] 承認後、`test/index.html`→root `index.html` を promote（cp + commit + push）。firestore.rules は Task 1 で prod=test 共有プロジェクトにデプロイ済み。

## Self-Review 結果（spec カバレッジ）

- spec §1 データモデル/activeView 導出 → Task 3,6 ✓
- spec §2 参加者体験（公開は明示切替・gourmet非公開）→ Task 3,5 ✓
- spec §3 ホスト操作（作業画面/公開ボタン分離）→ Task 4,5 ✓
- spec §4 単体利用の温存 → Task 6 ✓
- spec §5 旧ハブ撤去 → Task 2 ✓
- spec §6 Firestoreルール → Task 1 ✓
- spec §7 通知・共有（1URL・既存トリガー）→ 参加者URLは常に `?event=<id>`（Task 2撤去後は子URL無し）、functions 変更なし ✓
- spec §8 独立ページ＋下部ナビ → Task 3(ルータ),4(ナビ) ✓
- 7画面：scheduleCreate/schedule(Task 9)、gourmet(Task 7)、announce(Task 8)、seating/walica/settle(Task 3 ルータで既存描画) ✓

留意：本アプリはテストランナー非搭載のため各「検証」ステップは `node --check`＋コードレビュー＋ユーザー実機確認に置換。実装者は既存の `renderTable`/`renderWalicaBoard`/`renderSeatingBoard`/`openSettlePage`/`renderVenue`/`venueEdit` の実データ形式に合わせること。
