# 食べログURL自動読み取り 設計書

**日付:** 2026-07-11
**対象:** 調整くん（smcc-tools/chouseikun, Firebase chouseikun-tabel）
**ファイル:** `日程調整アプリ/test/index.html`（フロントのみ。Cloud Function `generateVenueBrief` は既存のまま流用）

## 目的

お知らせページ（ホスト用）の店入力欄に食べログURLを入れたら、「保存」ボタンも
「店情報を取得」ボタンも押さずに、AI（venue-brief）が自動で店情報を読み取るようにする。

## 背景（現状フロー）

1. `venueShopInput`（店名／食べログURL入力欄）に入力
2. 「保存」ボタンで `venue.shop` を保存
3. 「店情報を取得」ボタン（`invokeGenerateVenueBrief`）でAI生成（Gemini, 15-25秒）

`invokeGenerateVenueBrief()` は既に「未保存の入力があれば先に `venue.shop` を保存してから
生成する」作りになっている。つまり自動化は、この関数を URL 検出時に自動で呼ぶだけでよい。

## 方針

`venueShopInput` の `input` を監視し、食べログURL検出時に 1.5秒デバウンスで
`invokeGenerateVenueBrief()` を自動呼び出す。誤発火とAPI浪費を防ぐガードを付ける。

## コンポーネント

### 1. 状態変数（既存の let 変数群の近くに追加）

```javascript
const TABELOG_RE = /https?:\/\/[^\s]*tabelog\.com[^\s]*/i;
let _autoBriefTimer = null;   // 入力デバウンスのタイマー
let _autoBriefLastUrl = '';   // 直近で自動発火した食べログURL（同一URLの再発火を防ぐ）
```

### 2. 入力監視リスナー（既存の手動ボタン登録の直後に追加）

```javascript
document.getElementById('venueShopInput')?.addEventListener('input', (e) => {
  const m = (e.target.value || '').match(TABELOG_RE);
  if (!m) return;                         // 食べログURLが無ければ無視
  const url = m[0];
  if (url === _autoBriefLastUrl) return;  // 同一URLは再発火しない
  if (_autoBriefTimer) clearTimeout(_autoBriefTimer);
  _autoBriefTimer = setTimeout(() => {
    _autoBriefTimer = null;
    if (!currentUser) return;                                  // 未ログインは発火しない
    if (document.body.dataset.briefFetching === '1') return;   // 取得中はスキップ
    _autoBriefLastUrl = url;
    invokeGenerateVenueBrief();
  }, 1500);
});
```

### 3. 既存店の誤発火防止（venue描画箇所、applyVenueBriefState の直後に追加）

```javascript
// 既にbrief生成済みの食べログURLは「処理済み」として記録し、
// ホストが入力欄に触れても自動再取得しないようにする
if (!_autoBriefLastUrl && data.venue && data.venue.brief && data.venue.brief.overview) {
  const _ex = (v.shop || '').match(TABELOG_RE);
  if (_ex) _autoBriefLastUrl = _ex[0];
}
```

## データフロー

```
ホストが食べログURLを入力/貼付
  → input発火 → tabelog URL検出 → 1.5秒デバウンス
  → invokeGenerateVenueBrief()
      → 未保存なら venue.shop を自動保存
      → generateVenueBrief(eventId) 呼び出し（Gemini）
      → briefFetching=1 でローディング表示（自動で読み取り中と分かる）
  → onSnapshot で brief 反映（visible=false のまま：AIが勝手に公開しない）
```

## 誤発火防止の要点

- **プログラムによる `.value=` セット（onSnapshotでの入力欄復元）は `input` を発火しない**ため、
  既存店を開いただけでは自動発火しない。反応するのはユーザーのキー入力／貼り付けのみ。
- brief生成済みの既存店は、その食べログURLを `_autoBriefLastUrl` に記録して再発火を防ぐ
  （コンポーネント3）。`!_autoBriefLastUrl` ガードにより onSnapshot 連発でも一度だけ記録。
- 同一URL・取得中・未ログイン・食べログURL非含有 は発火しない。

## エラー処理

`invokeGenerateVenueBrief` の既存 try/catch（失敗時トースト）をそのまま流用。自動発火でも同じ。

## 既存機能への影響

- 既存の「店情報を取得」「再取得」ボタンは残す（店名だけで生成したいとき用）。
- `venueShopInput` には既に dirty 追跡の `input` リスナーがあるが、リスナーは加算可能で両立する。
- Cloud Function・Firestoreルールの変更なし。

## テスト（test環境で実機）

- ① 食べログURLを貼る → 1.5秒後に自動ローディング → brief生成
- ② 店名だけ入力 → 自動発火しない（手動ボタンは効く）
- ③ brief生成済みの店を開いて入力欄に触れる → 再発火しない
- ④ 同じURLを再入力 → 再発火しない

## 非対象（YAGNI）

- 食べログ以外のグルメサイトURLでの自動発火（要望は食べログのみ）。手動ボタンで対応可能。
- 自動発火の失敗時リトライ（既存の手動「再取得」で足りる）。
