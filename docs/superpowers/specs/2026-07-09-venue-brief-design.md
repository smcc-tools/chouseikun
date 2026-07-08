# 調整くん「お店の概要・おすすめメニュー」機能 設計

- 日付: 2026-07-09
- 対象: 調整くん（`日程調整アプリ`, GitHub Pages: smcc-tools/chouseikun, Firebase: chouseikun-tabel）
- ステータス: 設計承認済み（実装計画待ち）
- 関連: [[unified-event-view-design]]（お知らせ機能・venue モデル）

## 背景・現状

お知らせ画面には既に `venue.shop`（店名/住所/食べログURL）を保存する仕組みがあり、Cloud Function `fetchVenuePreview` が食べログURLからOGP/JSON-LD を取り `venue.preview`（写真・店名・評価・価格・ジャンル）を補完している。しかし、参加者が「行く前にどんな店か・何を頼むといいか」を知るための**要約情報**は含まれていない。

ユーザー要件：**venue.shop が入力済みのイベントで、店の「概要」と「おすすめメニュー」をインターネット上の複数情報源から総合的にまとめて表示する。ホストが取得ボタンで生成→編集→参加者に見せる/隠すを独立トグルで制御。運用は完全無料。**

## ゴール（要件）

1. **無料枠内で運用**：Google Custom Search JSON API（無料 100 req/day）＋ Google Gemini 1.5 Flash（無料 1500 req/day, 15 req/min）のみを使う。
2. **複数情報源からの総合要約**：食べログ・ぐるなび・ホットペッパー・Google Maps・個人ブログ等、複数サイトの検索スニペットを情報源とする。
3. **2項目に絞って高精度で取得**：
   - **概要（overview）**：店の雰囲気・ジャンル・予算目安・向いているシーンを含む2〜4文の文章。
   - **おすすめメニュー（dishes）**：3品まで。各品目に「料理名」と「理由（口コミで人気/看板料理/等）」を付ける。
4. **ホストが完全に制御**：
   - ホストが「店情報を取得」ボタンを押した時のみ生成（自動生成しない）。
   - 生成後にホストがテキストを自由に編集可能。
   - 「再取得」ボタンでいつでも AI 再生成できる。
   - 「参加者に見せる」独立トグルで表示/非表示を切替（お知らせ画面の公開トグルとは別）。
5. **既存 venue モデルへ非破壊で追加**：新フィールド `venue.brief` を追加するだけで、既存の `venue.shop`/`venue.preview`/`venue.meetTime`/`venue.meetPlace`/`venue.note` は不変。
6. **失敗時のグレースフルデグラデーション**：API呼び出し失敗時はホストにエラー表示、参加者側は brief セクション自体を非表示にする。

## 非ゴール（YAGNI）

- 予算目安・雰囲気・アクセス・予約可否 等の追加項目（概要文の中に自然に含める形とし、独立フィールドは作らない）。
- 参加者側での brief 編集（ホスト専用）。
- 情報源URLの参加者への表示（要約のみを見せる）。
- venue.shop 変更検知による自動再生成（明示的な「再取得」ボタンで統一）。
- 有料APIへの切替オプション（無料枠のみで運用）。
- 多言語対応（日本語のみ）。
- 生成履歴の保持（1件の最新結果のみ保持）。

## 設計

### 1. データモデル

`events/{id}.venue` に新フィールド `brief` を追加：

```typescript
venue: {
  // 既存フィールド（不変）
  shop: string;      // 店名/住所/食べログURL
  note: string;
  meetTime: string;
  meetPlace: string;
  preview?: { ... };  // 既存の OGP プレビュー

  // ★新規追加
  brief?: {
    overview: string;                              // 概要文（2〜4文の日本語）
    dishes: Array<{ name: string; why: string }>;  // おすすめメニュー（最大3件）
    generatedAt: number;                           // 生成時刻（unix ms）
    sourceQuery: string;                           // 使用した検索クエリ（デバッグ用）
    edited: boolean;                               // ホストがテキストを編集済みか
    visible: boolean;                              // 参加者に表示するか（デフォルト false）
    error?: string;                                // 直近の生成エラー（成功時は削除）
  };
}
```

- **フィールド全体を1オブジェクトに集約**し、Firestore の deep merge で部分更新可能。
- `visible` は独立トグル（お知らせ全体の公開 `activeView='announce'` とは連動しない）。
- `edited=true` の状態で再取得ボタンを押した場合は、確認ダイアログを出して合意を得る（誤操作で編集内容を消さない）。

### 2. Cloud Function 追加

新規 Callable Function `generateVenueBrief`（`functions/index.js` に追記）：

```typescript
// Callable: ホストのみ呼び出し可能
exports.generateVenueBrief = onCall({
  secrets: ['GOOGLE_CSE_KEY', 'GOOGLE_CSE_CX', 'GEMINI_API_KEY'],
  region: 'asia-northeast1',
}, async (request) => {
  // 1. 認証確認: request.auth.uid が events/{eventId}.ownerUids に含まれるか
  // 2. venue.shop を読み取り（空なら early return + エラー返却）
  // 3. venue.shop から検索クエリを組み立て:
  //    - URL があれば URL のドメイン + パスから店名を抽出
  //    - なければ shop 文字列全体を使用
  //    - 「<店名> メニュー おすすめ」「<店名> レビュー」の2クエリを投げる
  // 4. Google Custom Search JSON API 呼び出し（各クエリ 5件 x 2クエリ = 最大10件のスニペット）
  // 5. スニペットの重複除去・整形
  // 6. Gemini 1.5 Flash に投入:
  //    - system: 「あなたはグルメサイトの要約を作るアシスタントです。
  //               複数の検索スニペットから店の概要と、頻出のおすすめ料理3品を
  //               JSON形式で返してください。」
  //    - user: 検索スニペット群 + 店名
  //    - response_mime_type: application/json でスキーマ強制
  // 7. Firestore events/{eventId}.venue.brief を更新
  //    - overview, dishes, generatedAt, sourceQuery, edited=false, visible=既存値(または false)
  //    - error は削除
  // 8. 成功レスポンス返却
});
```

- **リージョン**は既存 Functions と同じ `asia-northeast1`。
- **Secrets** は Firebase CLI で `firebase functions:secrets:set GEMINI_API_KEY` 等で登録。
- **タイムアウト**: 30秒（デフォルトの60秒より短くし、参加者のインタラクションを阻害しない）。
- **メモリ**: 256MB で十分（大きなJSONの整形程度）。

### 3. Gemini プロンプト仕様

```
system:
あなたは日本のグルメサイトの要約を作るアシスタントです。
複数の検索結果スニペットから、店の概要と、頻出する
おすすめ料理3品を抽出し、JSON形式で回答してください。

出力フォーマット（JSON schema）:
{
  "overview": string,  // 2〜4文の日本語。雰囲気・ジャンル・予算目安・向いているシーンを含める
  "dishes": [
    {
      "name": string,  // 料理名
      "why": string    // 1文の理由。「口コミで頻出」「看板料理」「珍しい」等
    }
  ]  // 必ず3件。情報が不十分な場合は「（情報不足）」と記載
}

制約:
- 事実として確認できないことは書かない。
- 予算・営業時間・住所などの具体情報は概要に入れず、確度の高い雰囲気描写にとどめる。
- おすすめメニューは検索スニペットに複数回出現する料理を優先する。
- 出力は必ず有効な JSON（他のテキストは含めない）。

user:
店名: {venue.shop から抽出した店名}
検索スニペット:
1. [検索結果1のtitle] - [snippet]
2. ...
```

**構造化出力の強制**: Gemini API の `generation_config.response_mime_type = "application/json"` と `response_schema` で JSON スキーマを与え、パース失敗を防ぐ。

### 4. UI変更（テスト環境 `test/index.html`）

#### 4-1. お知らせ画面のホスト側 venueEdit セクション拡張

既存の `venueEdit` div（`announceCard` 内）の中に、新セクション `venueBriefSection` を追加：

```html
<!-- 既存の venueShopInput の直下 -->
<div id="venueBriefSection" class="host-only" style="margin-top:14px;">
  <div class="section-heading">お店の情報</div>

  <!-- 状態1: 未取得 -->
  <button id="fetchVenueBriefBtn" class="btn btn-secondary">
    <svg><!-- 検索アイコン --></svg>
    店情報を取得
  </button>

  <!-- 状態2: 取得中 -->
  <div id="venueBriefLoading" style="display:none;">
    <div class="spinner"></div>
    店の情報を集めています…
  </div>

  <!-- 状態3: 取得済み（プレビュー） -->
  <div id="venueBriefPreview" style="display:none;">
    <div class="field">
      <label>概要</label>
      <textarea id="briefOverviewInput" rows="4"></textarea>
    </div>
    <div class="field">
      <label>おすすめメニュー</label>
      <div id="briefDishesList">
        <!-- JS で 3行の <input> ペア（料理名・理由）を生成 -->
      </div>
    </div>
    <div class="brief-actions">
      <button id="regenerateVenueBriefBtn" class="btn btn-tertiary">🔄 再取得</button>
      <button id="deleteVenueBriefBtn" class="btn btn-tertiary danger">🗑 削除</button>
    </div>
    <label class="toggle">
      <input type="checkbox" id="briefVisibleToggle">
      参加者に見せる
    </label>
  </div>

  <!-- 状態4: エラー -->
  <div id="venueBriefError" style="display:none;">
    <div class="error-msg">
      店の情報を取得できませんでした。<span id="briefErrorDetail"></span>
    </div>
    <button id="retryVenueBriefBtn" class="btn btn-secondary">再取得</button>
  </div>
</div>
```

**JS 挙動:**
- `fetchVenueBriefBtn` クリック → `venue.shop` 空欄チェック → Callable `generateVenueBrief` 呼び出し。
- レスポンス受信 → Firestore の `onSnapshot` で `venue.brief` が更新 → プレビューカードを描画。
- テキスト編集 → 600ms デバウンスで `updateDoc('venue.brief.overview' / 'venue.brief.dishes' / 'venue.brief.edited=true')`。
- `briefVisibleToggle` 変更 → `updateDoc('venue.brief.visible')`。
- 「再取得」→ `edited=true` なら「編集内容は上書きされます。よろしいですか？」の confirm 経由。

#### 4-2. 参加者側 renderAnnounceView 拡張

`data.venue.brief.visible === true` の時のみ、既存の OGP プレビューの下に brief セクションを追加：

```html
<div id="participantBriefSection" class="brief-card">
  <div class="brief-heading">📖 お店の概要</div>
  <p class="brief-overview">[venue.brief.overview]</p>

  <div class="brief-heading">🍽 おすすめメニュー</div>
  <ol class="brief-dishes">
    <li><strong>[dish.name]</strong><br>[dish.why]</li>
    ...
  </ol>
</div>
```

- ホストが編集した文字列にはXSS対策として `escHtml` を通す（既存パターン）。
- 参加者側にはエラー状態を出さない（`visible=false` or `brief` 自体無しの時は完全非表示）。

### 5. Firestore ルール

既存の `isOwner()` ルールは venue 全体を含むため、`venue.brief` の書込は自動的にホスト（ownerUids に含まれるユーザー）のみに限定される。**ルール変更は不要**。

念のため確認：
- `venue.brief.visible` トグルのホスト書込 → `isOwner()` でカバー ✓
- 参加者の brief 書込は `isParticipantWrite()`（participants/participantOrder のみ許可）で拒否 ✓
- `isPaidToggle()` / `isWalicaWrite()` は brief に触れない ✓

### 6. Secrets 設定手順（デプロイ運用）

初回デプロイ時にのみ実行：

```bash
# Google Custom Search Engine 設定（1回のみ）:
# 1. https://programmablesearchengine.google.com/ で新規 CSE 作成
#    - 「ウェブ全体を検索」ON、日本語優先
#    - 検索対象サイト: 空欄でOK（全ウェブ検索）
# 2. CSE ID (cx) を控える
# 3. https://developers.google.com/custom-search/v1/introduction で API Key を発行
# 4. 秘密として登録:
firebase functions:secrets:set GOOGLE_CSE_KEY --project chouseikun-tabel
firebase functions:secrets:set GOOGLE_CSE_CX --project chouseikun-tabel

# Gemini API Key（1回のみ）:
# 1. https://aistudio.google.com/ で無料の API Key を発行
# 2. 秘密として登録:
firebase functions:secrets:set GEMINI_API_KEY --project chouseikun-tabel

# 関数デプロイ
firebase deploy --only functions:generateVenueBrief --project chouseikun-tabel \
  --account takedakyoichi0926@gmail.com
```

### 7. エラー処理・レート制限対策

- **CSE 100/日超過**: Cloud Function が 429 を返す → クライアントに「本日の取得上限に達しました。翌日再試行してください」メッセージ表示。
- **Gemini 15/分・1500/日超過**: 同様に上限メッセージ。
- **CSE 応答が0件**: 「情報が見つかりませんでした。店名を確認してください」メッセージ。
- **Gemini JSON パース失敗**: 自動リトライは行わず「取得に失敗しました。再取得してください」メッセージ。
- **エラーは Firestore の `venue.brief.error` に一時保存**し、UI に表示。次回成功時に削除。

### 8. コスト試算

- **無料枠**: CSE 100/日、Gemini 1500/日
- **想定利用量**: 1イベント作成で 1〜3回の brief 取得 → 数百イベント/日まで完全無料
- **超過時**: Cloud Functions 呼び出し自体は無料枠（Firebase Blaze プランでも呼び出し課金は $0.40/百万回）なので、CSE/Gemini の上限までは実質無料で稼働

## ロールアウト

[[test-first-deploy-workflow]] に従う：

1. `functions/index.js` に `generateVenueBrief` 追加 → `firebase deploy --only functions`（本番/test で共有・環境分離なし）。
2. `test/index.html` に UI 追加 → `git push`（テスト環境にのみ配信）。
3. ユーザーが `/chouseikun/test/` で実機確認：
   - 取得ボタン → プレビュー → 編集 → 参加者トグル → 参加者URL で見え方確認。
   - 誤取得のパターン（店名だけ、URLだけ、両方、空欄）を試す。
4. 承認後に `test/index.html` → root `index.html` へ promote。

## リスク・留意

- **Gemini の要約は事実と異なる可能性**：プロンプトで「確認できないことは書かない」と制約するが、完全は保証できない。「参考情報として」の但し書きを参加者UIに小さく表示する。
- **Google CSE は 100 件/日固定**：拡張したい場合は月額 $5〜（1000クエリ）へ有料アップグレードが必要。運用開始後、需要が超えたらユーザーに通知。
- **食べログの TOS**：本 Function は食べログ本体をスクレイピングせず、Google 検索結果のスニペットのみ利用するため、TOS 違反リスクは低い。ただし CSE 結果に食べログURL の title/snippet が含まれる点は変わらないため、参加者UIに情報源URLは表示しない。
- **API Key 漏洩リスク**：Firebase Secrets Manager で管理し、クライアントに一切露出しない。Callable Function の認証（`request.auth.uid` チェック）でホストのみに限定。
- **venue.shop が空欄で「情報を取得」ボタンが押される事故**：ボタンを disabled 制御。念のため Function 側でも空欄チェック。
- **同時多発リクエストによる 15/分超過**：クライアント側で取得ボタンを実行中に disable、Function 側でも rate limit を実装（同一ホストが 5秒以内に再呼び出しは 429）。
- **旧来イベント（brief フィールド無し）の互換**：UI 側で `data.venue?.brief` の存在チェックを行い、無ければ「未取得」状態として扱う。データ移行は不要。
