# venue-brief 高精度化（Pro化＋プロンプト強化＋コース対応）設計書

**日付:** 2026-07-11
**対象:** 調整くん（smcc-tools/chouseikun, Firebase chouseikun-tabel）
**ファイル:**
- `functions/venueBrief/prompt.js`（生成リクエスト組立・パース）
- `functions/venueBrief/index.js`（オーケストレータ、モデル指定）
- `functions/venueBrief/tests/prompt.test.js`（テスト）
- `functions/index.js`（Callable の timeout）
- `test/index.html`（コース入力欄・保存配線・表示ラベル切替）

## 目的

venue-brief（店概要・おすすめメニュー生成）の精度を上げる。あわせて、コース利用時に
「おすすめメニュー」ではなく「そのコースの特徴」を生成できるようにする。

## 全体像（2本立て）

1. **Gemini 2.5 Pro 化＋プロンプト強化**：推論力の高いモデルへ。出力切れ対策と検索多観点化。
2. **コース対応**：コース名入力欄を新設し、記載があればメニュー欄を「コースの特徴」に切替。

## データモデル

- `venue.course`（新規, string）: コース名（価格込みも可）。ホストが入力。
- `venue.brief.mode`（新規, string）: `'dishes'`（おすすめメニュー）| `'course'`（コース特徴）。表示ラベル切替用。
- `venue.brief.dishes`: 従来の3件（`{name, why}`）を流用。コースモードでは3項目のコース特徴を格納。
- `venue.brief.overview`: 従来どおり店概要（**コースモードでも維持**）。

## AI生成（functions）

### モデル（index.js:11）
`gemini-2.5-flash` → `gemini-2.5-pro`。grounding（google_search / url_context）と
レスポンス形式は共通なので `parseGeminiResponse` / `extractSourceUrls` は無変更。

### 出力切れ対策（prompt.js generationConfig）
Gemini 2.5 Pro は常時 thinking モデルで、思考トークンが出力を圧迫し JSON が途中で切れうる。
`generationConfig` に `maxOutputTokens: 4096` を追加。`temperature: 0.2` は維持。

### コース分岐（prompt.js buildGeminiRequestBody）
`buildGeminiRequestBody(shopName, shopUrl, preview, course)` に `course` 引数を追加。

- `course` が空 → 従来の【dishes の書き方】（おすすめメニュー）
- `course` あり → 【dishes の書き方 — コース特徴モード】に差し替え：

```
【dishes の書き方 — コース特徴モード】
対象コース「{course}」について google_search で検索し、そのコースの内容を3項目で説明する。
dishes は必ず3件。各項目は name（見出し）と why（説明）とする：
1. name「品数と価格」/ why: コースの品数・料金（例「全8品 ¥10,000（税サ込）」）。分かる範囲で具体的に。
2. name「主な料理の流れ」/ why: 前菜→メイン→締め→デザート等の構成や名物料理を具体的に。
3. name「このコースの目玉・特徴」/ why: 他コースとの違い・看板料理・ボリューム・ドリンク有無など。
コース情報が Web で確認できない項目は why を「（情報不足）」とし、推測で埋めない。
```

出力JSONは両モード共通：`{"overview": "...", "dishes": [{"name","why"}×3]}`。
`overview` は共通ルール（店概要4〜7文）で生成。

### プロンプト強化（SYSTEM_INSTRUCTION、両モード共通）
既存の詳細ルールに、精度直結の2点のみ追記（盛りすぎない）：
- **検索の多観点化**: 「google_search を最低2回（①『店名＋エリア＋メニュー/コース』②『店名＋食べログ＋口コミ』）実行し、実在情報と評判を集める」
- **情報源の厳格化**: 「料理名・コース内容は、食べログのメニュー欄・写真・口コミで実際に言及されたものに限る。確認できなければ（情報不足）」

### mode 保存（index.js generateVenueBriefImpl）
```javascript
const course = ((data.venue && data.venue.course) || '').trim();
const geminiBody = buildGeminiRequestBody(shopName, shopUrl, preview, course);
// ... 生成 ...
const mode = course ? 'course' : 'dishes';
await ref.update({
  'venue.brief.overview': parsed.overview,
  'venue.brief.dishes': parsed.dishes,
  'venue.brief.mode': mode,
  'venue.brief.generatedAt': now,
  'venue.brief.sourceUrls': sourceUrls,
  'venue.brief.edited': false,
  'venue.brief.visible': priorVisible,
  'venue.brief.error': admin.firestore.FieldValue.delete(),
});
```
返す `brief` にも `mode` を含める。

### タイムアウト（functions/index.js:211）
`generateVenueBrief` の `timeoutSeconds: 45` → `60`（Pro は Flash より遅い）。

## UI（test/index.html、お知らせページ・ホスト専用）

### コース入力欄（venueShopInput の下, 1530行目付近）
`venueNoteInput` の前に追加：
```html
<input type="text" id="venueCourseInput" placeholder="コース名（任意：記載があればコースの特徴を生成 例 特選会席コース ¥10,000）" style="margin-bottom:8px;">
```

### 保存の配線
- `saveVenueBtn` ハンドラ（3134行目付近）の updates に `'venue.course': (courseInp?.value||'').trim()` を追加
- `invokeGenerateVenueBrief` の未保存保存（3200行目付近）の updates にも `'venue.course'` を追加

### 描画・dirty追跡
- 描画時 `set('venueCourseInput', v.course)` を追加（2990行目付近）
- dirty追跡・保存クリアの配列（2995行目・3142行目付近）に `'venueCourseInput'` を追加

### ラベル切替（mode に応じて「おすすめメニュー」/「コースの特徴」）
- ホスト編集欄のラベル（1557行目付近）に `id="briefDishesLabel"` を付与し、`applyVenueBriefState` で
  `brief.mode === 'course' ? 'コースの特徴' : 'おすすめメニュー'` に切替
- 参加者表示のラベル（participantBriefSection内）に `id="participantBriefDishesLabel"` を付与し、
  参加者描画（3016行目付近）で同様に切替

### ローディング表示（1543行目）
「店の情報を集めています…（15〜25秒）」→「（20〜40秒）」。

## デプロイ・テスト

### テスト（先行）
`functions/venueBrief/tests/prompt.test.js` に追加：
- `buildGeminiRequestBody(name, url, null, 'Aコース')` → systemInstruction に「コース特徴モード」を含む
- `buildGeminiRequestBody(name, url, null, '')` → 従来の「おすすめメニュー」を含む（コース指示を含まない）
- `generationConfig.maxOutputTokens === 4096`
- 既存の tools / temperature テストは維持

`cd functions && node --test venueBrief/tests/` で全パスを確認。

### デプロイ順
1. functions のテストを追加・実装 → `node --test` 全パス
2. `firebase deploy --only functions:generateVenueBrief --project chouseikun-tabel --account takedakyoichi0926@gmail.com`
   （**functions は test 分離が無く直接本番**。ただし generateVenueBrief は明示的呼び出しで既存データ非破壊、
   次回生成分から Pro になるだけ）
3. **ユーザーが実機で生成 → 概要・メニュー・コース特徴の品質を確認**
4. フロント（`test/index.html` のコース欄・ラベル・秒数）は test → 承認 → root へ promote

## リスク / 非対象

- **リスク**: Pro のレイテンシ増（timeout 60で吸収）、出力切れ（maxOutputTokens 4096で対策）。
- コース名変更だけでの自動再生成はしない（食べログURL自動発火は維持、コースは手動「取得」/URL発火時に反映）。
- 旧 brief（mode 無し）は `mode` 未定義 → 表示は既定の「おすすめメニュー」ラベルで後方互換。
- 他グルメサイト対応・コース品書き全列挙は対象外（YAGNI）。

## 実装順序（TDD）

1. prompt.test.js にコースモード・maxOutputTokens のテスト追加（失敗を確認）
2. prompt.js に course 分岐・maxOutputTokens・プロンプト強化を実装 → テスト green
3. index.js モデル Pro化・course読み取り・mode保存
4. functions/index.js timeout 60
5. `node --test` 全パス → functions デプロイ（本番）→ 実機で品質確認
6. test/index.html：コース欄・保存配線・描画・ラベル切替・秒数
7. フロント test デプロイ → 実機確認 → promote
