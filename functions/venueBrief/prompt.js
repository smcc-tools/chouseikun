// Gemini 1.5 Flash + Google Search grounding 用の
// リクエスト組立とレスポンスパース。純粋関数のみ。

const SYSTEM_INSTRUCTION = `あなたは日本のグルメサイトを検索して要約するアシスタントです。
Google 検索で店の情報を集め、店の概要と、頻出するおすすめ料理3品を返してください。

**極めて重要な出力形式ルール:**
- 出力は必ず有効な JSON オブジェクト1つのみ。
- コードフェンス（\`\`\`json 等）や説明文、前置きは一切含めない。
- 応答の1文字目は \`{\`、最終文字は \`}\` でなければならない。

出力する JSON の形:
{"overview": "2〜4文の日本語（雰囲気・ジャンル・予算目安・向いているシーン含む）", "dishes": [{"name": "料理名1", "why": "理由1"}, {"name": "料理名2", "why": "理由2"}, {"name": "料理名3", "why": "理由3"}]}

内容の制約:
- 事実として確認できないことは書かない。
- おすすめメニューは検索結果に複数回出現する料理を優先。
- 情報が不足している項目は「（情報不足）」と記載。
- dishes は必ず3件。`;

function buildGeminiRequestBody(shopName, shopUrl) {
  const parts = [`店名: ${shopName || '(不明)'}`];
  if (shopUrl) parts.push(`参考URL: ${shopUrl}`);
  const userText = parts.join('\n');

  return {
    tools: [{ google_search: {} }],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.3,
    },
  };
}

function parseGeminiResponse(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) throw new Error('gemini: empty candidates');
  const parts = (cands[0].content && cands[0].content.parts) || [];
  const rawText = parts.map(p => p.text || '').join('');
  if (!rawText) throw new Error('gemini: empty parts text');

  // grounding では JSON がコードフェンスや前置き付きで返る可能性があるので、
  // 最初の { から最後の } を抽出する（robust JSON extraction）
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error('gemini: failed to parse JSON: no JSON object found in text');
  }
  const jsonText = rawText.slice(first, last + 1);

  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`gemini: failed to parse JSON: ${e.message}`);
  }
  return {
    overview: String(obj.overview || '').trim(),
    dishes: Array.isArray(obj.dishes) ? obj.dishes.slice(0, 3).map(d => ({
      name: String(d.name || '').trim(),
      why: String(d.why || '').trim(),
    })) : [],
  };
}

function extractSourceUrls(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) return [];
  const chunks = (cands[0].groundingMetadata && cands[0].groundingMetadata.groundingChunks) || [];
  const seen = new Set();
  const urls = [];
  for (const c of chunks) {
    const uri = c && c.web && c.web.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    urls.push(uri);
    if (urls.length >= 5) break;
  }
  return urls;
}

function validateBrief(brief) {
  if (!brief || typeof brief !== 'object') return false;
  if (!brief.overview || typeof brief.overview !== 'string') return false;
  if (!Array.isArray(brief.dishes) || brief.dishes.length !== 3) return false;
  return brief.dishes.every(d => d && typeof d.name === 'string' && d.name && d.why && typeof d.why === 'string');
}

module.exports = { buildGeminiRequestBody, parseGeminiResponse, extractSourceUrls, validateBrief };
