# ホスト/参加者URLの1本化 設計書

**日付:** 2026-07-11
**対象:** 調整くん（smcc-tools/chouseikun, Firebase chouseikun-tabel）
**ファイル:** `日程調整アプリ/test/index.html`（フロントのみ、Firestoreルール変更なし）

## 目的

ホスト用URLと参加者用URLを `?event=<id>` の1本に統一する。

現状、マイイベント一覧の「開く」ボタンは、レコードに旧 `hostKey` が残っている場合に
`?event=<id>&host=<key>` を生成する。参加者に配るのは `?event=<id>`。この2種類を
ホストが目にして「URLが違う」と感じている。

## 背景（現状の仕組み）

- ホスト判定はアカウント uid ベース（`events/{id}.ownerUids` に自分の uid が含まれるか）。
- `?host=<key>`（`hostKey`）は**統合前に作った旧イベント**（`ownerUids` 未設定）を、
  正当なホストがクレーム（自分の uid を `ownerUids` に登録）して新方式へ移行するための互換パラメータ。
- 統合後に作ったイベントは作成時に `ownerUids:[uid]` を必ずセットするため、
  ホストも参加者も既に `?event=<id>` の1本。`host=` は付かない。
- Firestore ルール `isLegacyClaim()` は「`ownerUids` 未設定のイベントに、ログインユーザーが
  `ownerUids` の新規付与のみ」を許可済み（ルール変更不要）。

## 方針（案B：自動引き継ぎ付きで統一）

URL から `host=` を外しつつ、旧イベントはマイイベントを開いた瞬間に裏で自動移行することで、
古いイベントのホスト権限を取りこぼさずに URL を1本化する。

## 変更内容

### 1. マイイベント「開く」リンク（既存 2242行目付近）

`&host=<key>` を削除し、常に `?event=<id>` を出力する。

変更前:
```html
<a class="btn btn-secondary my-event-open" href="${base}?event=${encodeURIComponent(e.eventId)}${e.hostKey ? `&host=${encodeURIComponent(e.hostKey)}` : ''}">開く</a>
```
変更後:
```html
<a class="btn btn-secondary my-event-open" href="${base}?event=${encodeURIComponent(e.eventId)}">開く</a>
```

### 2. マイイベント一覧の描画ループで旧イベントを自動移行（既存 2187行目付近）

各イベント本体を `getDoc` する既存処理の中で、`ownerUids` が空 かつ 自分のマイイベント
レコードの `hostKey` がイベント本体の `hostKeys`/`hostKey` に一致する旧イベントを検出したら、
`updateDoc({ownerUids:[currentUser.uid]})` で新方式へ移行する。

```javascript
// data 取得済みブロックの末尾に追加
const owners = data.ownerUids || [];
const legacyKeys = data.hostKeys || (data.hostKey ? [data.hostKey] : []);
if (owners.length === 0 && e.hostKey && legacyKeys.includes(e.hostKey)) {
  try { await updateDoc(doc(db, 'events', e.eventId), { ownerUids: [currentUser.uid] }); } catch (_) {}
}
```

移行後はその端末で `?event=<id>` だけでホスト判定される。

### 3. 後方互換の維持（変更なし・2658行目付近）

`evaluateHost` の既存 `?host=` クレーム経路は残す。昔ブックマーク／共有した
`&host=` 付きリンクは引き続きホスト権限を復元できる。

## データフロー

1. ログイン → マイイベント一覧描画で各イベント本体を読む（既存処理）
2. 旧イベント（`ownerUids` 空・`hostKey` 一致）を検出 → 裏で `ownerUids` に自分を登録
3. 「開く」リンクは `host=` なしの `?event=<id>`
4. 個別イベントページ（`evaluateHost`）は `ownerUids` に自分がいる → ホストUI表示

## エラー処理

- 自動移行の `updateDoc` は try/catch で握りつぶす。失敗しても一覧表示は継続
  （既存の getDoc 失敗時と同方針）。移行は次回以降の一覧表示で再試行される。

## 安全性

- ルール `isLegacyClaim()` はサーバ側で hostKey を検証しないが、クライアントで
  `hostKey` の一致を確認してからクレームするため、参加者として保存したイベント
  （hostKey なし）を誤って乗っ取ることはない。

## テスト

フロントはテストフレームワークを持たないため、test環境（GitHub Pages `/test/`）へ
デプロイして実機確認する。

- ① 統合後に作ったイベントをマイイベントから開く → URLに `host=` が付かず、ホストUIが出る
- ② 参加イベントを開く → 参加者UI（ホストUIは出ない）
- ③（旧イベントがあれば）マイイベントから開く → 自動移行してホストUI、URLは `?event=<id>`

## リスク / 非対象

- 一覧を一度も開かずに旧イベントの `?event=<id>`（host= なし）を直接開いた場合、
  初回はまだ `ownerUids` 未設定でホストUIが出ない可能性がある。ただし既存の
  `?host=` 付きリンクは引き続き機能するため後退はしない。一覧を一度開けば移行完了。
  この直接アクセス初回の救済は YAGNI として対象外。
