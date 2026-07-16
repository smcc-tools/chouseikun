# AI注文提案（注文提案ツール）設計書

作成: 2026-07-16 / ステータス: 承認済み（実装前）

## 目的

お店で「何を注文すればいいか分からない」場面で、AI がその店の実在メニューから
注文プラン一式（前菜→メイン→しめ等の構成、数量・目安価格付き）を提案する。

## 要件（確定事項）

| 項目 | 決定 |
|---|---|
| 位置づけ | メニュー画面からの**単体ツール**（イベント紐付けなし） |
| 入力 | 店名 or 食べログURL（必須）、人数（デフォルト2）、予算/人（任意）、好み・気分（自由入力・任意） |
| 出力 | 注文プラン一式: カテゴリ構成（AIが店に合わせ2〜5個）× 各1〜4品、品ごとに name/qty/price/why、合計目安、注意書き |
| 品質方針 | **実在確認できたメニューのみ**（venue-brief と同方針）。確認できなければ「情報不足」を正直に返す |
| 認証 | **Googleログイン必須**。uid 単位レート制限 10秒 |
| 保存 | **その場限り**（Firestore 読み書きなし）。「別の案を出す」再生成ボタンあり |
| スコープ外 | アレルギー専用入力（好み欄への自由記述は AI が考慮するが保証しない旨を注意書き）、履歴保存、共有URL、イベント連携 |

## アーキテクチャ（案A: venue-brief の姉妹実装）

```
[orderAiCard (index.html)]
  店名/人数/予算/好み 入力
      │ httpsCallable('suggestOrderPlan', {shop, partySize, budget?, mood?, excludeDishes?})
      ▼
[functions/index.js  suggestOrderPlan (onCall)]
  asia-northeast1 / timeout 90s / 256MiB / secrets: GEMINI_API_KEY
      │
      ▼
[functions/orderPlan/index.js  suggestOrderPlanImpl]
  認証 → 入力検証 → uidレート制限(10s) → プロンプト組立 → Gemini(最大3回) → JSON検証
      │  戻り値 {ok, plan…}（Firestore書き込みなし）
      ▼
[フロント buildOrderPlanHtml(plan) で描画]
```

- **共通化リファクタ**: `callGemini`（25秒個別タイムアウト）と `isRetryableError` を
  `functions/shared/gemini.js` へ移設し、venueBrief / orderPlan の両方から import。
  既存 venueBrief テスト52件が通ることを移設の合格条件とする。
- モデル: `gemini-pro-latest` + Google検索グラウンディング（venue-brief と同一）。

## フロント UI

- メニューの単体ツール群にタイル「**注文提案**」（desc: お店で迷ったらAIが注文プランを提案）。
  id: `menuOrderAiBtn` → カード `orderAiCard`（`SETUP_CARDS` と同様に履歴ナビ組み込み、「← メニューに戻る」あり）。
- フォーム: `orderShopInput`（店名/URL）、`orderPartySizeInput`（number, min1 max50, 初期値2）、
  `orderBudgetInput`（number 円/人, 任意）、`orderMoodInput`（text, 任意, placeholder「例: 肉多め・お酒に合う・さっぱりめ」）。
- 未ログイン時は実行ボタンで「ログインが必要です」トースト＋ログイン導線（精算作成と同じ流儀）。
- ローディング表示「メニューを調べています…（20〜40秒）」。
- 結果: カテゴリ見出し＋品リスト（品名・数量・目安価格・一言理由）、合計目安、
  参考リンク（グラウンディング出典 最大5件）、注意書き
  「ネット上の情報に基づく提案です。価格・提供状況は変わることがあります」。
- 「**別の案を出す**」: 直前プランの品名一覧を `excludeDishes` に載せて再実行。
- エラー表示: venue-brief の日本語変換を `aiErrorToJa` として共通化し、両機能から使用。再試行ボタンあり。

## サーバ仕様

入力検証（`INVALID_ARG`）:
- shop: 必須・トリム後非空・200字以内
- partySize: 整数 1〜50
- budget: 省略可。指定時は正の整数（円）
- mood: 省略可。100字以内
- excludeDishes: 省略可。文字列配列・20件以内・各60字以内

レート制限: `_lastCallAt`（プロセス内 Map、key=uid）で 10 秒未満の連打を `RATE_LIMITED`。

## プロンプト仕様（orderPlan/prompt.js・純関数）

- venue-brief と同じ厳格ルールを継承: 別店舗混同禁止 / 推測禁止 / google_search 最低3回
  （①店名+メニュー ②店名+口コミ+おすすめ ③店名+公式サイト）。
- 追加指示: 人数からシェア前提の qty を算出。予算指定時は合計が「人数×予算」を超えないよう構成。
  好み・気分は品選びに反映。excludeDishes は「前回提案済みのため除外」として扱う。
- 出力 JSON:

```json
{
  "shopFound": true,
  "plan": [
    {"category": "前菜", "items": [
      {"name": "自家製ポテトサラダ", "qty": 2, "price": "¥500前後", "why": "…"}
    ]}
  ],
  "totalEstimate": "¥3,500/人 前後",
  "notes": "ラストオーダー前に…等の補足（任意）"
}
```

- `validateOrderPlan`: カテゴリ2〜5・各カテゴリ1〜4品・name/why 非空文字列・qty は正の整数、
  totalEstimate 非空。違反は `PLAN_INVALID` エラー（一時的な生成乱れとしてリトライ対象）。
- `shopFound: false` は `NO_RESULTS` に変換（リトライしない）。

## エラー分類（HttpsError マップ）

| コード | 条件 | フロント表示（aiErrorToJa） |
|---|---|---|
| unauthenticated | 未ログイン | ログインが必要です |
| invalid-argument | 入力検証NG | 入力内容を確認してください |
| resource-exhausted | RATE_LIMITED | 連続で実行されています。数秒おいて再試行 |
| not-found | NO_RESULTS | この店のメニュー情報が見つかりませんでした |
| internal | GEMINI_TIMEOUT / Gemini NNN / パース失敗(3回後) | 時間をおいて再試行 |

- Gemini呼び出しは venue-brief と同じ分類: HTTP 4xx/5xx・SAFETY は即失敗、
  タイムアウト・JSON崩れはリトライ（最大3回、25秒×3 < 90秒）。

## テスト計画

- `functions/orderPlan/tests/prompt.test.js`（node:test・純関数のみ・20件前後）:
  リクエスト組立（人数/予算/好み/除外の注入）、パース（コードフェンス除去・壊れJSON診断）、
  validateOrderPlan 境界（カテゴリ数・品数・qty型）、shopFound=false 経路。
- `functions/shared/gemini.js` 移設後、既存 venueBrief 52件が無修正で通ること。
- フロント: `buildOrderPlanHtml` をトップレベル純関数とし、特性化テストハーネスで
  XSSエスケープ・数量/価格表示・空プランの3観点（5件前後）。
- 実機: test/ デプロイ → ユーザー確認 → promote。functions は直接本番デプロイ→実機確認。

## セキュリティ・コスト

- API キーはサーバのみ（Secret Manager）。クライアント露出なし。
- Firestore 読み書きなし → セキュリティルール変更不要。
- コスト: 1回 = Gemini Pro + 検索グラウンディング（venue-brief と同等）。
  ログイン必須 + 10秒レート制限 + リトライ上限3回で上限を抑制。

## 実装順序（概要）

1. `functions/shared/gemini.js` 抽出 + venueBrief を import に切替（既存テストで回帰確認）
2. `functions/orderPlan/`（prompt.js → tests → index.js）+ `functions/index.js` に onCall 追加
3. フロント: メニュータイル + orderAiCard + `buildOrderPlanHtml` + `aiErrorToJa` 共通化（test/index.html）
4. フロント特性化テスト → functions デプロイ → test/ デプロイ → 実機確認 → promote
