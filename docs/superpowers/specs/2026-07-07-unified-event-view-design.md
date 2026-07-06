# 調整くん「統合イベント（1URL・表示画面切替）」設計

- 日付: 2026-07-07
- 対象: 調整くん（`日程調整アプリ`, GitHub Pages: smcc-tools/chouseikun, Firebase: chouseikun-tabel）
- ステータス: 設計承認済み（実装計画待ち）
- 前提: [[chouseikun-event-hub]] の「イベントハブ化」（parentEventId 子レコード方式）を本設計で差し替える。ハブ機能は **test 環境のみデプロイ済み・本番未反映** のため安全に作り替え可能。

## 背景・現状

「イベントハブ化」では、日程調整イベントから精算/割り勘/座席決めを起動すると **機能ごとに別ドキュメント（別 `?event=<子ID>` URL）** の子レコードを作る方式だった。結果、参加者に配るURLが機能ごとに異なる。

ユーザー要件：**イベントにつき参加者URLは1本にし、ホストが「今どの機能の画面を参加者に見せるか」を切り替えられるようにしたい。さらに機能を会のライフサイクルに沿って細分化する。**

## ゴール（要件）

1. **参加者URLは1イベント1本**（`?event=<イベントID>` のみ。機能ごとの別URLを廃止）。
2. **ホストが表示画面を切替**：下記7画面のうち、今 参加者に見せる画面をホストが選べる。切替は参加者にリアルタイム反映。
3. **7画面を会のライフサイクル順に用意**（自由に往復可・データは各画面に保持）：
   1. **スケジュール作成**（`scheduleCreate`）：ホストが候補日を作成・編集。参加者には「準備中」を表示。
   2. **日程調整**（`schedule`）：候補日への投票・開催日決定。
   3. **お店検索**（`gourmet`）：Tabel で店を検索し、選んだ店をイベントに保存。
   4. **集合時間・お店をお知らせ**（`announce`）：確定した開催日＋集合時間＋保存した店を参加者に表示。
   5. **座席決め**（`seating`）：条件付きランダム卓分け。
   6. **割り勘**（`walica`）：立替の最小回数精算。
   7. **精算**（`settle`）：傾斜精算。
4. **単体利用を温存**：メニューから割り勘/精算/座席を直接作れる（従来通りすぐ使える）。
5. **既存データを移行なしで動かす**：旧フラグ（walica/seating/settleOnly）のイベントは読み替えで従来通り表示。

## 非ゴール（YAGNI）

- 精算・割り勘・座席の計算ロジック自体の変更（既存描画関数を再利用）。
- 機能ごとの権限を跨ぐ複雑な公開制御（表示は `activeView` 1つで決まる）。
- 旧「イベントハブ」子レコードの温存（撤去する）。
- Tabel 側の新機能（検索は既存の埋め込みを流用。保存するのは選択結果の店情報のみ）。

## 設計

### 1. データモデル（単一ドキュメント統合）

イベントは `events/{id}` の1ドキュメントに全画面のデータを内包できる：

- スケジュール作成／日程調整：`dates`, `participants`, `confirmedDate`, `participantOrder`
- お店検索／お知らせ：`venue{ url, preview{...} }`（既存の venue 構造。Cloud Function `fetchVenuePreview` が url 設定時に preview を補完）、`meetTime`（集合時間の文字列・新規）
- 座席決め：既存の座席データ構造（`parties[]` 等・実装に合わせる）
- 割り勘：`expenses[]`
- 精算：`settle{ ... }`, `settlePublished`

新フィールド **`activeView`** ∈ `'scheduleCreate' | 'schedule' | 'gourmet' | 'announce' | 'seating' | 'walica' | 'settle'`（＝今 参加者に見せる画面。ホストのみ変更可）。

**旧データ互換（書込不要の読み替え）**：レンダリング時に
```
const view = data.activeView
  || (data.walica ? 'walica' : data.seating ? 'seating' : data.settleOnly ? 'settle' : 'schedule');
```
で決定。既存の walica/seating/settleOnly/日程調整 イベントは `activeView` 未設定でも従来の画面に解決される（移行不要）。新規作成イベントは `activeView` を明示設定する。マイイベント一覧の種別表示も同じ導出を使う。

旧フラグ（walica/seating/settleOnly）は新規作成では設定せず `activeView` に一本化する。ただし読み替え互換のため参照は残す。

### 2. 参加者体験（URL 1本）

- 参加者URLは常に `?event=<イベントID>`。共有リンクも1本のみ。
- `onSnapshot` で `activeView` を監視し、その画面を描画：
  - `scheduleCreate` → 「日程調整の準備中です」空状態（参加者は編集不可）。
  - `schedule` → 候補日・投票・開催日決定（既存 `renderTable` 等）。
  - `gourmet` → 参加者向けは店情報の閲覧（検索操作はホストのみ）。未保存なら「準備中」。
  - `announce` → 開催日・集合時間・お店（`venue.preview` の店名/場所/リンク）を読み取り専用で表示。
  - `seating` → 座席ボード（既存 `renderSeatingBoard`）。
  - `walica` → 立替ボード（既存 `renderWalicaBoard`）。
  - `settle` → 精算画面（既存 `openSettlePage` 等）。
- ホストが `activeView` を変更すると、参加者の画面もリアルタイムに切り替わる。
- どの画面もデータ未整備時はエラーにせず「準備中」の空状態を表示する。

### 3. ホスト操作

- ホストのイベント画面に「**参加者に表示する画面**」切替 UI（上記7画面をライフサイクル順に列挙）。選択で `activeView` を `updateDoc`（ホスト本人のみ）→ 参加者に即反映。
- 各画面のホスト操作：
  - スケジュール作成：候補日の追加・編集（既存の候補日編集UIを流用）。
  - 日程調整：投票状況の確認・開催日決定。
  - お店検索：Tabel 埋め込みで検索 → 選んだ店を `venue` に保存（url 保存で既存 `fetchVenuePreview` が preview を補完）。
  - お知らせ：集合時間 `meetTime` を入力。開催日（`confirmedDate`）と `venue` は自動反映。
  - 座席決め／割り勘／精算：既存の入力UIを同一イベント内で使用。
- 旧「この会でできること」＝子レコード起動ボタン、「この会に紐付く記録」一覧は撤去し、上記の `activeView` 切替UIに置き換える。

### 4. 単体利用（温存）

- メニューから割り勘/精算/座席を作成すると、`activeView` をその画面に初期設定した `events/{id}` を1件作成（従来通りすぐ使える・参加者URLは1本）。
- 日程調整からの新規作成は `activeView='scheduleCreate'` で開始（ホストが候補日を用意 → `schedule` に切り替えて投票開始）。
- 全イベントが同一構造のため、ホストは単体作成イベントでも必要なら別画面に切替可能。

### 5. 旧「イベントハブ」からの差し替え

test 環境のみに存在する以下を撤去する（本番 root は未反映のため影響なし）：

- `parentEventId` / `hubParentEventId` の受け渡し。
- 子レコード起動 `launchFromEvent`、ハブの「紐付く記録」一覧 `renderEventHub` の子クエリ部。
- 子レコード移行 `migrateEmbeddedSettles`。

ハブUIの枠（「この会でできること」）は `activeView` 切替UIとして作り替える。

### 6. Firestore ルール

- `events` の `allow create`：`parentEventId` 許可は不要化。代わりに `activeView`（任意の許可文字列 or 未設定）の書込を許可。
- `allow update`：`activeView` / `meetTime` / `venue` の変更はホスト本人（`isOwner()`）のみ。既存の参加者書込（投票 `isParticipantWrite` / 支払済み `isPaidToggle` / 立替 `isWalicaWrite` / 旧クレーム `isLegacyClaim`）の hasOnly ホワイトリストは不変（これらのホスト専用項目は含めない＝参加者は変更不可）。

### 7. 通知・共有

- 参加者URL・共有リンクは1本に統一（画面切替でも不変）。
- FCM 通知は既存の `events/{id}` トリガー（新規回答登録・支払済みトグル、`functions/index.js`）をそのまま利用。イベントが単一ドキュメントに集約されても発火条件は不変。将来「お知らせ公開」等の通知を足す余地はあるが今回は非ゴール。

## ロールアウト

[[test-first-deploy-workflow]] に従う：`test/index.html` に実装 → 検証 → ユーザー承認後に本番(root)へ promote。Firestoreルール変更は `firebase deploy --only firestore:rules --project chouseikun-tabel --account takedakyoichi0926@gmail.com`。

## リスク・留意

- 単一ドキュメントに全画面データが同居する。参加者書込ルール（支払済み・立替・投票）は該当サブフィールドのみを許可する既存 hasOnly ルールで担保されるため、機能横断でも権限は崩れない。
- 旧フラグ→`activeView` 読み替えの一貫性（レンダリング・マイイベント種別・空状態）を全経路で使うこと。
- 7画面それぞれにデータ未整備時の「準備中」空状態を用意し、参加者側がエラーにならないようにする。
- お店検索の店保存は既存 `venue`＋`fetchVenuePreview` を流用（Tabel 側は変更しない）。
- テストランナー非搭載のため検証は `node --check`（抽出モジュール）＋コードレビュー＋ユーザーのブラウザ実機確認（/test/）に置換する。
