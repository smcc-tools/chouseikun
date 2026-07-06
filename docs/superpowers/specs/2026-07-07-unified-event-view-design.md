# 調整くん「統合イベント（1URL・表示画面切替）」設計

- 日付: 2026-07-07
- 対象: 調整くん（`日程調整アプリ`, GitHub Pages: smcc-tools/chouseikun, Firebase: chouseikun-tabel）
- ステータス: 設計承認済み（実装計画待ち）
- 前提: [[chouseikun-event-hub]] の「イベントハブ化」（parentEventId 子レコード方式）を本設計で差し替える。ハブ機能は **test 環境のみデプロイ済み・本番未反映** のため安全に作り替え可能。

## 背景・現状

「イベントハブ化」では、日程調整イベントから精算/割り勘/座席決めを起動すると **機能ごとに別ドキュメント（別 `?event=<子ID>` URL）** の子レコードを作る方式だった。結果、参加者に配るURLが機能ごとに異なる。

ユーザー要件：**イベントにつき参加者URLは1本にし、ホストが「今どの機能の画面を参加者に見せるか」を切り替えられるようにしたい。**

## ゴール（要件）

1. **参加者URLは1イベント1本**（`?event=<イベントID>` のみ。機能ごとの別URLを廃止）。
2. **ホストが表示画面を切替**：日程調整／精算／割り勘／座席決めのうち、今 参加者に見せる画面をホストが選べる。切替は参加者にリアルタイム反映。
3. **4機能を自由に行き来**：各機能のデータは同一イベント内に保持され、ホストは何度でも切り替えられる（一方通行の段階遷移ではない）。
4. **単体利用を温存**：メニューから割り勘/精算/座席を直接作れる（従来通りすぐ使える）。
5. **既存データを移行なしで動かす**：旧フラグ（walica/seating/settleOnly）のイベントは読み替えで従来通り表示。

## 非ゴール（YAGNI）

- 精算・割り勘・座席の計算ロジック自体の変更（既存描画関数を再利用）。
- 機能ごとの権限を跨ぐ複雑な公開制御（表示は `activeView` 1つで決まる）。
- 旧「イベントハブ」子レコードの温存（撤去する）。

## 設計

### 1. データモデル（単一ドキュメント統合）

イベントは `events/{id}` の1ドキュメントに全機能データを内包できる：

- 日程調整：`dates`, `participants`, `confirmedDate`, `participantOrder`
- 精算：`settle{ ... }`, `settlePublished`
- 割り勘：`expenses[]`
- 座席決め：既存の座席データ構造（`parties[]` 等・実装に合わせる）

新フィールド **`activeView`** ∈ `'schedule' | 'settle' | 'walica' | 'seating'`（＝今 参加者に見せる画面。ホストのみ変更可）。

**旧データ互換（書込不要の読み替え）**：レンダリング時に
```
const view = data.activeView
  || (data.walica ? 'walica' : data.seating ? 'seating' : data.settleOnly ? 'settle' : 'schedule');
```
で決定。既存の walica/seating/settleOnly イベントは `activeView` 未設定でも従来の画面に解決される（移行不要）。新規作成イベントは `activeView` を明示設定する。マイイベント一覧の種別表示も同じ導出を使う。

旧フラグ（walica/seating/settleOnly）は新規作成では設定せず `activeView` に一本化する。ただし読み替え互換のため参照は残す。

### 2. 参加者体験（URL 1本）

- 参加者URLは常に `?event=<イベントID>`。共有リンクも1本のみ。
- `onSnapshot` で `activeView` を監視し、その機能の画面を既存描画関数で描画：
  - `schedule` → 候補日・投票・開催日決定（`renderTable` 等）
  - `settle` → 精算画面（`openSettlePage` 等）
  - `walica` → 立替ボード（`renderWalicaBoard`）
  - `seating` → 座席ボード（`renderSeatingBoard`）
- ホストが `activeView` を変更すると、参加者の画面もリアルタイムに切り替わる。
- 対象機能のデータ未整備時は「準備中」の空状態を表示（例：精算未入力なら「精算はまだ準備中です」）。

### 3. ホスト操作

- ホストのイベント画面に「**参加者に表示する画面**」切替 UI（日程調整／精算／割り勘／座席決め）。選択で `activeView` を `updateDoc`（ホスト本人のみ）→ 参加者に即反映。
- 各機能の入力（候補日・精算金額・立替・卓割り）は同一イベント内でホストが設定。
- 旧「この会でできること」＝子レコード起動ボタンは、この「表示画面の切替＋その機能の設定」に置き換える。「この会に紐付く記録」一覧は廃止（子レコードが無くなるため）。

### 4. 単体利用（温存）

- メニューから割り勘/精算/座席を作成すると、`activeView` をその機能に初期設定した `events/{id}` を1件作成（従来通りすぐ使える・参加者URLは1本）。
- 全イベントが同一構造のため、ホストは単体作成イベントでも必要なら別機能に切替可能。

### 5. 旧「イベントハブ」からの差し替え

test 環境のみに存在する以下を撤去する（本番 root は未反映のため影響なし）：

- `parentEventId` / `hubParentEventId` の受け渡し。
- 子レコード起動 `launchFromEvent`、ハブの「紐付く記録」一覧 `renderEventHub` の子クエリ部。
- 子レコード移行 `migrateEmbeddedSettles`。

ハブUIの枠（「この会でできること」）は `activeView` 切替UIとして作り替える。

### 6. Firestore ルール

- `events` の `allow create`：`parentEventId` 許可は不要化。代わりに `activeView`（任意の許可文字列 or 未設定）の書込を許可。
- `allow update`：`activeView` 変更はホスト本人（`isOwner()`）のみ。既存の参加者書込（投票 `isParticipantWrite` / 支払済み `isPaidToggle` / 立替 `isWalicaWrite` / 旧クレーム `isLegacyClaim`）の hasOnly ホワイトリストは不変（`activeView` はそれらに含めない＝参加者は変更不可）。

### 7. 通知・共有

- 参加者URL・共有リンクは1本に統一（機能切替でも不変）。
- FCM 通知は既存の `events/{id}` トリガー（新規回答登録・支払済みトグル、`functions/index.js`）をそのまま利用。イベントが単一ドキュメントに集約されても発火条件は不変。

## ロールアウト

[[test-first-deploy-workflow]] に従う：`test/index.html` に実装 → 検証 → ユーザー承認後に本番(root)へ promote。Firestoreルール変更は `firebase deploy --only firestore:rules --project chouseikun-tabel --account takedakyoichi0926@gmail.com`。

## リスク・留意

- 単一ドキュメントに全機能データが同居する。参加者書込ルール（支払済み・立替・投票）は該当サブフィールドのみを許可する既存 hasOnly ルールで担保されるため、機能横断でも権限は崩れない。
- 旧フラグ→`activeView` 読み替えの一貫性（レンダリング・マイイベント種別・空状態）を全経路で使うこと。
- `activeView` 切替時、対象機能のデータ未整備でも参加者側がエラーにならない「準備中」空状態を必ず用意する。
- テストランナー非搭載のため検証は `node --check`（抽出モジュール）＋コードレビュー＋ユーザーのブラウザ実機確認（/test/）に置換する。
