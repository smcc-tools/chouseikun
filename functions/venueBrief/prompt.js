// Gemini 1.5 Flash + Google Search grounding 用の
// リクエスト組立とレスポンスパース。純粋関数のみ。

const SYSTEM_INSTRUCTION = `あなたは日本のグルメサイトを検索して要約するアシスタントです。
Google 検索で店の情報を集め、店の概要と、頻出するおすすめ料理3品を JSON 形式で回答してください。

制約:
- 事実として確認できないことは書かない。
- 概要には雰囲気・ジャンル・予算目安・向いているシーンを含める（2〜4文の日本語）。
- おすすめメニューは検索結果に複数回出現する料理を優先。
- 情報が不足している項目は「（情報不足）」と記載。
- 出力は必ず有効な JSON（他のテキストは含めない）。`;

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
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          overview: { type: 'STRING' },
          dishes: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                why: { type: 'STRING' },
              },
              required: ['name', 'why'],
            },
          },
        },
        required: ['overview', 'dishes'],
      },
    },
  };
}

function parseGeminiResponse(apiJson) {
  const cands = (apiJson && apiJson.candidates) || [];
  if (!cands.length) throw new Error('gemini: empty candidates');
  const parts = (cands[0].content && cands[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text) throw new Error('gemini: empty parts text');
  let obj;
  try {
    obj = JSON.parse(text);
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
