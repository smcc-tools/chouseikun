# 調整くん「イベントハブ化」設計

- 日付: 2026-07-06
- 対象: 調整くん（`日程調整アプリ`, GitHub Pages: smcc-tools/chouseikun, Firebase: chouseikun-tabel）
- ステータス: 設計承認済み（実装計画待ち）

## 背景・現状

調整くんは以下の5機能を持つ静的Webアプリ（`index.html` 1ファイル + Firestore/Auth/FCM）。

- **日程調整（schedule）**: 候補日で◯△✕投票→開催日決定。**さらに会終了後の「精算」が同じイベントに組み込まれている**（イベントdocの `settle` オブジェクト、「会が終了したので精算に進む」ボタン、精算カード）。
- **精算（settle）**: 傾斜精算。メニューから単体でも作れる（`type: 'settle'` の独立イベント）。
- **割り勘（walica）**: 立替の最小回数精算（`type: 'walica'`）。**既に「日程調整から取り込む」で参加者を取り込める**。
- **座席決め（seating）**: 条件付きランダム卓分け（`type: 'seating'`）。**既に「日程調整から取り込む」あり**。
- **お店検索（gourmet）**: 食べログ検索アプリ(Tabel)を iframe 埋め込み。記録は作らない。

データ: `events/{eventId}`（`type`, `participants`, `dates`, `settle`, `ownerUids`, `notifyUids` 等）。参加者取り込みは `loadScheduleEventsForImport()` が既存。マイイベントは `type` 別に一覧表示。

## ゴール（要件）

1. **日程調整をスケジュール専用にする**：組み込み精算を撤去し、候補日投票・開催日決定のみにする。
2. **イベントをハブにする**：マイイベント（schedule）を開くと、その会の参加者を引き継いで「精算／割り勘／座席決め／お店検索」を起動できる。
3. **結果はイベントに紐付けて残す**：イベントから起動した精算・割り勘・座席は、そのイベントに紐付く記録として残り、ハブの一覧から開ける・共有できる。お店検索は起動のみ（紐付け・保存なし）。
4. **単体利用を温存（ハイブリッド）**：メニューからの単体利用（イベントなしで精算・割り勘・座席・お店検索）は従来通り完全に維持する。
5. **既存データを損失なく移行**：日程調整イベントに組み込まれた既存の精算データを、紐付き精算レコードへ自動移行する。

## 非ゴール（YAGNI）

- お店検索の「会場」保存（今回はしない＝起動のみ）。
- 予約枠ごとの空席フィルタ等 Tabel 側の新機能。
- 精算・割り勘・座席の計算ロジック自体の変更（既存を再利用）。

## 設計

### 1. データモデル（親子リンク方式）

`events` コレクションと `type`（schedule / settle / walica / seating）は維持。

- **settle / walica / seating のドキュメントに任意フィールド `parentEventId`（親＝schedule イベントのID）を追加**。
  - `parentEventId` あり → その日程調整イベントに紐付く（ハブに表示）。
  - `parentEventId` なし（未設定/null）→ 単体利用（従来通り）。
- 親（schedule）側は子IDを持たない。ハブは `where type in (settle,walica,seating) and parentEventId == <eventId> and ownerUids contains <uid>` 相当のクライアント側フィルタで子を集める（マイイベント読込は既に全件取得しているため、その中から `parentEventId` で絞るだけで追加クエリ不要）。
- お店検索は記録を作らないので `parentEventId` 対象外。

### 2. 日程調整＝スケジュール専用

schedule イベントから以下を撤去：

- イベントdocの `settle` オブジェクトへの新規書込。
- 「会が終了したので精算に進む」ホスト用ボタン、「精算を確認する」参加者用ボタン、イベント内「精算カード」表示。
- 関連CSS/JSのうち schedule 内精算専用のもの（settle レコード側で使う共通部分は残す）。

schedule の詳細画面は「候補日・投票・開催日決定」＋後述のハブUIのみになる。

### 3. イベントハブUI（schedule イベント詳細）

schedule イベント詳細画面に2ブロックを追加：

- **「この会でできること」**：ボタン `精算する / 割り勘 / 座席を決める / お店を探す`。各ボタンは対応する既存の作成フローを開き、参加者を自動投入＋`parentEventId` を今のイベントIDにセット。
- **「この会に紐付く記録」**：`parentEventId == このイベント` の settle/walica/seating を一覧（名称・種別・開く・共有）。無ければ非表示 or 空状態。

ハブは**ホスト（ownerUids に自分が含まれる）向け**に表示。参加者向けの見せ方は最小（紐付き記録が公開されていれば閲覧可能な範囲）。

### 4. 起動フロー（ハブ→各機能）

- **精算 / 割り勘 / 座席**：既存の作成カード（settleSetupCard / walicaSetupCard / seatingSetupCard）を再利用。ハブ起動時に (a) メンバー欄へイベント参加者を自動投入（既存の取り込みロジック `loadScheduleEventsForImport` を流用）、(b) 「作成」時に `parentEventId` を保存。作成後はハブ（元の schedule 詳細）に戻り、一覧に反映。
- **お店検索**：現在地検索を開くだけ（`parentEventId` なし・保存なし）。既存の goToGourmet を流用。

単体利用時（メニューから直接）は `parentEventId` を付けない＝従来通り。

### 5. 既存データ移行

一度きりのクライアント側マイグレーション（ログイン後、対象ユーザーの自分のイベントに対して）：

1. `type == 'schedule'` かつ `settle` オブジェクトを持つイベントを検出。
2. その `settle` 内容 + 参加者で、新しい settle レコード（`type:'settle'`, `parentEventId` = その schedule のID, `ownerUids` = 同じ）を作成。
3. 元 schedule の組み込み精算は表示対象から外す（`settle` は残置でも良いが UI からは辿らない。二重表示防止のためフラグ `settleMigrated: true` を付ける）。

データ損失なし。移行は冪等（`settleMigrated` で二重実行防止）。

### 6. 共有・通知・Firestoreルール

- **共有リンク**：各 settle/walica/seating の既存リンク（`?event=<id>`）をそのまま維持。ハブからも辿れる。
- **Firestoreルール**（`firestore.rules`）：settle/walica/seating の作成・更新時に `parentEventId`（任意の文字列 or 未設定）の書込を許可。本人のみ書込等の既存制約は維持。
- **通知（FCM）**：「精算を支払済み」等の通知は settle レコード側で発火する既存ロジックを維持（`functions/`）。schedule から精算が外れても、settle レコード側で同等に動く。

## ロールアウト

[[test-first-deploy-workflow]] に従う：`test/index.html` に実装→検証→ユーザー承認後に本番(root)へ promote。Firestoreルール変更は `firebase deploy --only firestore:rules --project chouseikun-tabel`。移行は本番反映後、各ユーザーのログイン時に一度だけ走る。

## リスク・留意

- schedule 内精算の撤去で、既存の schedule 詳細UIのレイアウト崩れに注意（撤去箇所のCSS残骸）。
- 移行の冪等性（`settleMigrated` フラグ）を必ず確認。
- 単体利用と紐付き利用で作成フローを共有するため、`parentEventId` の有無だけで分岐する薄い作りにする（ロジック重複を避ける）。
