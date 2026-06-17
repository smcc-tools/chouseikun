# 参加登録プッシュ通知（FCM）セットアップ手順

参加者が回答を登録したら、通知ONにしたホストへプッシュ通知を送る機能です。
アプリ側のコードは実装済みですが、以下の Firebase 設定が必要です。

## 1. Blaze プランに変更
Cloud Functions の利用に必要です（無料枠あり。通常ほぼ$0だがカード登録が必要）。
- Firebase Console → 左下「アップグレード」→ Blaze を選択

## 2. VAPID 公開鍵を発行して貼り付け
- Firebase Console → ⚙️ プロジェクトの設定 → タブ「Cloud Messaging」
- 「ウェブ構成」→「ウェブプッシュ証明書」→ 鍵ペアを生成
- 表示された公開鍵をコピー
- `index.html` の `FCM_VAPID_KEY = "PUT_YOUR_VAPID_PUBLIC_KEY_HERE"` を、この鍵に置き換えてコミット＆デプロイ

## 3. Cloud Functions をデプロイ
端末（このリポジトリのルート）で：
```bash
npm install -g firebase-tools          # 未インストールなら
firebase login
firebase use nomikai-42968
firebase deploy --only functions
```
※ `functions/` ディレクトリは用意済み。初回は `functions/` で `npm install` が走ります。
※ `firebase.json` が無ければ初回に `firebase init`（Functions と Firestore を選択、既存ファイルは上書きしない）でも可。

## 4. Firestore ルールを反映
`firestore.rules` に `fcmTokens` の許可を追加済み。Console のルールタブに貼り直すか：
```bash
firebase deploy --only firestore:rules
```

## 5. 動作確認
1. ホストとしてイベントを開き、「参加者が回答を登録したらプッシュ通知を受け取る」をON（通知許可を承認）
2. 別ブラウザ/端末で参加者として回答を登録
3. ホスト端末に通知が届く

## 注意
- iOS は **ホーム画面に追加した PWA** かつ iOS 16.4+ のみ対応。
- 通知が来ない場合：通知許可がブロックされていないか、Cloud Messaging API が有効か、関数のログ（Console → Functions → ログ）を確認。
- アプリ前面表示中はプッシュではなくアプリ内トーストで表示されます。
