# テスト → 本番 反映フロー

## 環境

| | URL | Firebase | ファイル |
|---|---|---|---|
| **本番** | `https://smcc-tools.github.io/chouseikun/` | nomikai-42968（prod） | ルートの `index.html` / `sw.js` / `manifest.json` |
| **テスト** | `https://smcc-tools.github.io/chouseikun/test/` | テスト用プロジェクト（test） | `test/index.html` / `test/sw.js` / `test/manifest.json` |

`index.html` と `sw.js` は **URLに `/test/` を含むか**で本番/テストのFirebase設定を自動で切り替えます（両方の設定を埋め込み済み）。そのため同じファイルが両環境で動き、本番反映は「テスト版をルートへコピー」するだけです。

## 日々の開発フロー

1. **テストに実装**：`test/index.html`（必要なら `test/sw.js`）を編集する。
2. **バックエンドをテストへ反映**（ルール/Functionsを変えた場合）：
   ```bash
   firebase deploy --only firestore:rules,functions -P test
   ```
3. **テストで検証**：`https://smcc-tools.github.io/chouseikun/test/` を開いて動作確認（データ・通知はテスト用Firebase）。
4. **本番へ反映（プロモート）**：
   ```bash
   ./scripts/promote.sh        # test/ の index.html・sw.js をルートへコピー（差分確認あり）
   git add index.html sw.js && git commit -m "promote: test→prod" && git push
   ```
5. **バックエンドを本番へ反映**（ルール/Functionsを変えた場合）：
   ```bash
   firebase deploy --only firestore:rules,functions -P prod
   ```

## セットアップ（Phase 2：テスト用Firebaseプロジェクト作成後に一度だけ）

テスト環境を「本番と別データ」で動かすには、テスト用Firebaseプロジェクトの設定を埋め込む必要があります。

1. Firebaseコンソールで**新規プロジェクト**を作成。
2. **Authentication**：Googleログインを有効化し、承認済みドメインに `smcc-tools.github.io` と `localhost` を追加。
3. **Firestore Database** を作成。
4. **Cloud Messaging**：ウェブ用の **VAPIDキー（公開鍵）** を発行。
5. プロジェクト設定 → **ウェブアプリ**を追加して config（apiKey / authDomain / projectId / storageBucket / messagingSenderId / appId）を取得。
6. 次の3か所の `REPLACE_ME` を実際の値に差し替え：
   - `index.html` の `FB_CONFIGS.test`（vapidKey含む）
   - `sw.js` の `FB_TEST`
   - `test/index.html` と `test/sw.js`（＝上記をコピー、または promote 前に同期）
7. `.firebaserc` の `test` を作成したプロジェクトIDに差し替え。
8. ルール/Functionsをテストへ：`firebase deploy --only firestore:rules,functions -P test`

> 補足：`test` 設定が `REPLACE_ME` の間は、`/test/` を開いても**本番Firebaseにフォールバック**します（壊れません）。Phase 2 完了後にテスト用データへ切り替わります。

## 注意
- **本番URL（`/chouseikun/`）はFunctionsの通知リンク生成にも使用**。テストの通知リンクを `/test/` に向けたい場合は Functions 側でベースURLを環境変数化する（未対応・必要時に追加）。
- `manifest.json` は環境ごとに scope が異なるため promote 対象外（ルート=`/chouseikun/`、テスト=`/chouseikun/test/`）。
