# ホスト専用URL（Googleログイン不要のホスト権限）設計書

作成: 2026-07-17 / ステータス: 承認済み（実装前）

## 目的

Google ログインしていない人でもホスト権限を持てるようにする。
既存ホストが「ホスト専用URL」を発行し、そのURLを開いた人（未ログイン含む）をホスト化する。

## 要件（確定事項）

| 項目 | 決定 |
|---|---|
| 引き換えUX | **URLのみ**（`?event=<id>&hostcode=<code>` を開くだけ）。コード手入力UIは作らない |
| コード | 1イベント1コード・**発行したら固定**（再発行・無効化なし） |
| 未ログイン対応 | **Firebase 匿名認証**で自動サインイン（ユーザーに操作は見えない）。権限はブラウザ(端末)に紐づき、データ削除後もURLを開き直せば復帰 |
| Googleログイン済みの人 | 同じURLで共同ホスト化できる（uid手入力より簡単な招待手段を兼ねる） |
| 権限モデル | 匿名/Google問わず uid を `ownerUids` に追加。**既存ルール・全ホスト機能がそのまま動く** |
| セキュリティ | コードは非公開サブコレクションに保存（参加者は読めない）。照合はサーバー(Cloud Function)で実施 |

## アーキテクチャ

```
[発行: 既存ホスト]
  共同ホスト管理UIの「ホスト専用URLを発行」ボタン
    → randomId(20) を生成し events/{id}/private/host に {code, createdAt} を保存（owner のみ書込可）
    → URL 表示: ${origin}${path}?event=<id>&hostcode=<code> ＋ コピー
    → 既に発行済みなら既存コードのURLを表示（固定仕様）

[引き換え: URLを開いた人]
  ページ初期化時に hostcode パラメータを検出
    → 未ログインなら signInAnonymously(auth)
    → callable claimHostByCode({eventId, code})
         サーバー: events/{id}/private/host を読み、code 照合
         一致 → events/{id}.ownerUids に arrayUnion(uid)（Admin SDK・ルール非依存）
    → 成功: onSnapshot が ownerUids 変化を拾い evaluateHost がホストUIを表示
      URL から hostcode を除去（history.replaceState、再読込・共有時の漏えい防止）
    → 失敗: showToast('ホスト用URLが無効です')（画面は参加者として表示継続）
```

## Firestore ルール変更（追加のみ）

```
// ホストコード等の非公開データ：イベントのホストのみ読み書き可（参加者・匿名は不可）
match /events/{eventId}/private/{docId} {
  allow read, write: if request.auth != null
    && get(/databases/$(database)/documents/events/$(eventId)).data.ownerUids.hasAny([request.auth.uid]);
}
```

- `events/{id}` 本体のルールは変更なし（ownerUids の追加は Admin SDK が行うためルール不要）。

## Cloud Function

`claimHostByCode`（onCall / asia-northeast1 / 256MiB / secrets 不要）:

- 認証必須（匿名認証も `request.auth` に載る）
- 入力検証: eventId string / code は20文字の英数字
- `events/{id}/private/host` を読み、`code` を照合。doc 不在 or 不一致 → `INVALID_CODE`
- 一致 → `events/{id}` に `ownerUids: FieldValue.arrayUnion(uid)`
- uid 単位レート制限 3 秒（総当たり抑止。コードは 36^20 空間なので実質不要だが保険）
- HttpsError マップ: UNAUTHENTICATED / INVALID_ARG / INVALID_CODE→permission-denied / その他 internal

## フロント変更

**発行UI**（`renderCoHostList` 付近の共同ホスト管理エリア）:
- ホストのみ表示のボタン「ホスト専用URLを発行」
- 押下時: `events/{id}/private/host` を getDoc → 在れば既存コード、無ければ `randomId(20)` を setDoc
- URL を readonly input + コピー（既存 `copyText` 流用）で表示
- 注意書き:「このURLを開いた人はGoogleログイン不要でホストになれます。取り扱いにご注意ください（コードは固定で無効化できません）」

**引き換えフロー**（イベントページ初期化）:
- `params.get('hostcode')` があれば:
  1. `auth.currentUser` が無ければ `signInAnonymously(auth)`（firebase-auth の import に追加）
  2. `claimHostByCodeCallable({ eventId, code })`
  3. 成否に関わらず `history.replaceState` で URL から hostcode を除去
  4. 失敗時 `showToast('ホスト用URLが無効です')`
- 実行タイミングは onAuthStateChanged 解決後（二重実行ガード付き）

**匿名ユーザーのヘッダー表示**:
- `onAuthStateChanged` で `user.isAnonymous` の場合は「Googleでログイン」ボタンを表示したままにする
  （名前/アバター空の authUser 表示にしない）。マイイベント・通知等は匿名 uid でそのまま動作

## 注意点・既知の制約（仕様として明記）

- URL を知っている人は誰でもホストになれる（共同ホスト相当の取り扱い注意。固定コードのため漏えい時の無効化手段なし — 承認済みの仕様）
- 匿名ホストが後から Google ログインすると uid が変わる。ホスト専用URLをもう一度開けば Google アカウント側にも権限が付与される
- Firebase コンソールで匿名認証プロバイダの有効化が必要（API 経由の有効化を試み、不可なら手順案内）
- 共同ホスト一覧には匿名 uid がそのまま表示される（区別表示は今回スコープ外）

## テスト計画

- functions: `claimHostByCode` の入力検証・レート制限の純関数部を node:test（コード照合ロジックは
  Firestore 依存のため、検証関数 `validateClaimInput` を切り出してテスト）
- フロント: 引き換えフローは auth 依存のため headless 検証は限定的。URL からの hostcode 除去
  ロジックを純関数 `stripHostCodeFromUrl(search)` に切り出して特性化テスト
- 実機: test/ デプロイ → 発行→シークレットモードで URL を開く→ホストUI表示 を確認 → promote

## 実装順序（概要）

1. firestore.rules に private サブコレクションのブロック追加 → デプロイ
2. functions: claimHostByCode（検証関数 TDD → 本体 → onCall export）→ デプロイ
3. 匿名認証プロバイダ有効化（API or 手動）
4. フロント: 発行UI → 引き換えフロー → ヘッダーの匿名対応（test/index.html）
5. テスト → test/ デプロイ → 実機確認 → promote
