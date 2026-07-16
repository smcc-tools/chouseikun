// AI注文提案: Gemini リクエスト組立とレスポンスパース。純粋関数のみ。
const SYS = `あなたは実在する飲食店のメニューをウェブ検索して、注文プランを組み立てるアシスタントです。

【最重要ルール — 実在メニューのみ】
- 必ず google_search で対象店舗を検索する。検索は最低3回、観点を変えて行う：
  ①「店名＋メニュー」②「店名＋口コミ＋おすすめ」③「店名＋公式サイト」
- 実在が確認できたメニューのみ提案する。推測や「このジャンルの定番」で埋めない。
- 別店舗の情報は絶対に使わない（同名の別店舗に特に注意）。
- メニュー情報が見つからない場合は {"shopFound": false, "plan": [], "totalEstimate": "", "notes": ""} を返す。

【プランの組み立て】
- 人数分をシェアして食べる前提で数量(qty)を決める。
- 予算が指定されていれば、合計が「人数×予算」を超えない構成にする。
- 好み・気分の指定があれば品選びに反映する。
- 「除外リスト」の品は前回提案済みのため提案しない。
- カテゴリは店に合わせて2〜5個（例: 居酒屋=前菜/焼き物/しめ、イタリアン=前菜/パスタ/メイン）。
- 各カテゴリ1〜4品。price は「¥800前後」のような目安表記。分からなければ「価格不明」。
- notes にはラストオーダーや量の注意など、あれば一言（任意・1文）。

【出力形式】
- 出力は必ず有効な JSON オブジェクト1つのみ。コードフェンスや前置きは一切含めない。
- 応答の1文字目は { 、最終文字は } でなければならない。

{"shopFound": true, "plan": [{"category": "前菜", "items": [{"name": "品名", "qty": 2, "price": "¥500前後", "why": "一言理由"}]}], "totalEstimate": "¥3,500/人 前後", "notes": "補足（任意）"}`;

function buildOrderPlanRequestBody({ shop, partySize, budget, mood, excludeDishes }) {
  const lines = ['【対象店舗と条件】'];
  lines.push(`- 店名/URL: ${shop}`);
  lines.push(`- 人数: ${partySize}人`);
  if (budget) lines.push(`- 予算: 1人あたり ¥${budget} 以内`);
  if (mood) lines.push(`- 好み・気分: ${mood}`);
  if (Array.isArray(excludeDishes) && excludeDishes.length) {
    lines.push(`- 除外リスト（前回提案済み）: ${excludeDishes.join('、')}`);
  }
  lines.push('');
  lines.push('必ず google_search で実際に検索し、この店の実在メニューだけで注文プランを JSON で返してください。');
  return {
    tools: [{ google_search: {} }],
    systemInstruction: { parts: [{ text: SYS }] },
    contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 1024 },
    },
  };
}

function parseOrderPlanResponse(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) {
    const pf = (apiJson && apiJson.promptFeedback) || {};
    const blockReason = pf.blockReason ? ` blockReason=${pf.blockReason}` : '';
    throw new Error(`gemini: empty candidates${blockReason}`);
  }
  const finishReason = cands[0].finishReason || '';
  const parts = (cands[0].content && cands[0].content.parts) || [];
  const rawText = parts.map(p => p.text || '').join('');
  if (!rawText) throw new Error(`gemini: empty parts text (finishReason=${finishReason || 'unknown'})`);
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`gemini: failed to parse JSON: no JSON object found (finishReason=${finishReason || 'unknown'}, textLen=${rawText.length})`);
  }
  const jsonText = rawText.slice(first, last + 1);
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`gemini: failed to parse JSON: ${e.message} (finishReason=${finishReason || 'unknown'}, jsonLen=${jsonText.length}, tail=${JSON.stringify(jsonText.slice(-40))})`);
  }
  return {
    shopFound: obj.shopFound === true,
    plan: Array.isArray(obj.plan) ? obj.plan.map(c => ({
      category: String((c && c.category) || '').trim(),
      items: Array.isArray(c && c.items) ? c.items.map(it => ({
        name: String((it && it.name) || '').trim(),
        qty: Number.isInteger(it && it.qty) ? it.qty : (parseInt(it && it.qty) || 0),
        price: String((it && it.price) || '').trim(),
        why: String((it && it.why) || '').trim(),
      })) : [],
    })) : [],
    totalEstimate: String(obj.totalEstimate || '').trim(),
    notes: String(obj.notes || '').trim(),
  };
}

function validateOrderPlan(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.shopFound !== true) return false;
  if (!Array.isArray(p.plan) || p.plan.length < 2 || p.plan.length > 5) return false;
  if (!p.totalEstimate || typeof p.totalEstimate !== 'string') return false;
  return p.plan.every(c => c && typeof c.category === 'string' && c.category
    && Array.isArray(c.items) && c.items.length >= 1 && c.items.length <= 4
    && c.items.every(it => it && typeof it.name === 'string' && it.name
      && typeof it.why === 'string' && it.why
      && Number.isInteger(it.qty) && it.qty > 0));
}

// グラウンディング出典（venueBrief/prompt.js と同形。8行のため重複を許容し独立性を優先）
function extractSourceUrls(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) return [];
  const chunks = (cands[0].groundingMetadata && cands[0].groundingMetadata.groundingChunks) || [];
  const seen = new Set();
  const urls = [];
  for (const c of chunks) {
    const uri = c && c.web && c.web.uri;
    if (!uri || seen.has(uri)) continue;
    if (!/^https?:\/\//i.test(uri)) continue; // href に挿入されるため http(s) 以外は捨てる
    seen.add(uri);
    urls.push(uri);
    if (urls.length >= 5) break;
  }
  return urls;
}

module.exports = { buildOrderPlanRequestBody, parseOrderPlanResponse, validateOrderPlan, extractSourceUrls };
