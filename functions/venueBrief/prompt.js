// Gemini 1.5 Flash + Google Search grounding 用の
// リクエスト組立とレスポンスパース。純粋関数のみ。

const SYSTEM_INSTRUCTION = `あなたは日本のグルメサイトを実際に検索して要約するアシスタントです。

【最重要ルール — 別の店の情報を書かない】
- 必ず最初に google_search で「対象店舗」の情報を検索する。
- 検索結果の中で、後述の【検証済み情報】（エリア・ジャンル・URL 等）と一致する店舗のページのみ参照する。
- URL が提供されている場合、url_context でその URL の内容を読み込み最優先で使う。
- エリアやジャンルが明らかに違う別店舗の情報は絶対に使わない。同名の別店舗が混ざるとき特に注意。
- 対象店舗の情報が Web 上に見つからない、または検証済み情報と合致する店舗が特定できない場合は、
  overview に「この店の詳細情報が見つかりませんでした」と書き、dishes は 3件すべて {"name":"（情報不足）", "why":"（情報不足）"} とする。決して推測で書かない。

【出力形式】
- 出力は必ず有効な JSON オブジェクト1つのみ。
- コードフェンス（\`\`\`json 等）や説明文、前置きは一切含めない。
- 応答の1文字目は \`{\`、最終文字は \`}\` でなければならない。

出力する JSON の形:
{"overview": "2〜4文の日本語（雰囲気・ジャンル・予算目安・向いているシーン含む）", "dishes": [{"name": "料理名1", "why": "理由1"}, {"name": "料理名2", "why": "理由2"}, {"name": "料理名3", "why": "理由3"}]}

【内容の制約】
- 事実として確認できないことは書かない。
- おすすめメニューは検索結果に複数回出現する料理を優先。実際に対象店舗のメニューにある料理のみ。
- 概要には雰囲気・ジャンル・予算目安・向いているシーンを含める（2〜4文の日本語）。
- dishes は必ず3件（情報不足時も「（情報不足）」で埋めて3件にする）。`;

function buildGeminiRequestBody(shopName, shopUrl, preview) {
  // ユーザーメッセージ内で対象店舗を強く明示（別店舗との混同を防ぐアンカー情報）
  const lines = ['【対象店舗】'];
  lines.push(`- 店名: ${shopName || '(不明)'}`);
  if (shopUrl) lines.push(`- URL: ${shopUrl}`);
  if (preview && typeof preview === 'object') {
    const verified = [];
    if (preview.title) verified.push(`  - タイトル: ${String(preview.title).trim()}`);
    if (preview.sub)   verified.push(`  - エリア/ジャンル: ${String(preview.sub).trim()}`);
    if (preview.price) verified.push(`  - 価格帯: ${String(preview.price).trim()}`);
    if (preview.rating) verified.push(`  - 評価: ${String(preview.rating).trim()}`);
    if (verified.length) {
      lines.push('【検証済み情報】（食べログOGPから取得。合致する店舗のみ書くこと）');
      lines.push(...verified);
    }
  }
  lines.push('');
  lines.push('必ず google_search で実際にウェブを検索し、上記の対象店舗に合致する店舗のみの情報を JSON で返してください。');

  const userText = lines.join('\n');

  // ツール：google_search でウェブ検索、url_context で URL を直接読み込み
  // （どちらも Gemini 2.5-flash でサポート。url_context は特定URLの内容を優先取得）
  const tools = [{ google_search: {} }];
  if (shopUrl) tools.push({ url_context: {} });

  return {
    tools,
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.2,  // 事実重視に振る
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
