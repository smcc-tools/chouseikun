// Gemini 2.5 Pro + Google Search grounding 用の
// リクエスト組立とレスポンスパース。純粋関数のみ。

// 共通の先頭部（検索・検証ルール、推奨手順、自問、overview の書き方）
const SYS_HEAD = `あなたは日本のグルメサイトを実際に検索して要約するアシスタントです。

【最重要ルール — 別の店の情報を書かない】
- 必ず最初に google_search で対象店舗の情報を検索する。
- URL が提供されている場合、url_context でその URL の内容を読み込み最優先で使う。
- 検索結果の中で、後述の【検証済み情報】（エリア・ジャンル・URL等）と一致する店舗のページのみ参照する。
- エリアやジャンルが明らかに違う別店舗の情報は絶対に使わない。同名の別店舗が混ざるとき特に注意。
- 対象店舗の情報が Web 上に見つからない場合は、overview に「この店の詳細情報が見つかりませんでした」と書き、
  dishes は 3件すべて {"name":"（情報不足）", "why":"（情報不足）"} とする。決して推測で書かない。

【推奨手順】必ずこの順で作業する
1. URL があれば url_context でその内容をまず読み込む
2. google_search で実際のメニュー・コース・レビューを検索する。検索は最低2回行う：
   ① 「対象店舗名＋エリア＋メニュー（またはコース）」
   ② 「対象店舗名＋食べログ＋口コミ」
   実在するメニュー／コース内容と、実際の口コミでの評判を集める。
3. 得られた情報を照合し、【検証済み情報】と一致する店舗の情報のみ採用
4. 【overview の書き方】と下記の書き方に沿って JSON を出力

【自問】書く前に必ず自問すること
- この情報は url_context または google_search で実際に見つけたか？
- 別店舗の情報を混同していないか？
- 「一般的に和食店はこう」のような推測や、学習済み知識だけで書いていないか？
- 料理名・コース内容は、食べログのメニュー欄・写真・口コミで実際に言及されていたものか？

【overview の書き方】
overview は 4〜7文で、以下の要素を全て含めること：
  1. 【何屋か】ジャンルを具体的に（例：「割烹」ではなく「江戸前寿司」「創作和食」「モダンフレンチ」）
  2. 【差別化】この店の特徴・売り（他店にない要素、シェフの経歴、素材のこだわり等）
  3. 【価格帯】ランチとディナーそれぞれの予算目安（例：「ランチ ¥3,000〜、ディナー ¥15,000〜」）
  4. 【席の雰囲気】カウンター/テーブル/個室、席数の目安、静けさ
  5. 【利用シーン】接待・デート・家族・女子会・一人食事 のうち向いているもの
  6. 【予約】必須か、平日/週末どちらが取りやすいか

不明な要素は書かないでよいが、確実に分かるものは全て含める。
テンプレ的な表現（「落ち着いた雰囲気」「宴会に最適」等の抽象語）は避け、具体名詞・数値で書く。
例）× 「落ち着いた大人向けの創作和食」
   ○ 「銀座の裏路地にあるカウンター8席のみの江戸前寿司。二代目大将のこだわり握り。ランチ ¥5,000〜、ディナーコースは ¥18,000〜。仕入れ次第で品書き変動。接待とデートの両方に向くが、要予約（平日推奨）」`;

// おすすめメニューモード（course が無いとき）
const SYS_MENU = `【dishes の書き方】
dishes は必ず3件。各料理について：
- name: 具体的な料理名（実店舗のメニューに実在するもの）
  例）× 「サラダ」 → ○ 「季節野菜のバーニャカウダ」
     × 「寿司」  → ○ 「特上握り10貫（コース）」
     × 「パスタ」→ ○ 「雲丹のクリームパスタ」
- why: 根拠を含めた具体的な理由（1〜2文）。以下を含めるとよい：
  * 価格（分かれば）
  * どのタイミングで頼むか（前菜/看板メニュー/シメ など）
  * 特徴（食材の産地、調理法、季節限定、他店にない要素）

「口コミで頻出」「看板料理」などの根拠なき漠然フレーズは避ける。
「実際にこの店で提供している」ことが確認できるメニューのみ書く。
確認できないなら「（情報不足）」で埋め、無理にでっちあげない。

例）× {"name": "胡麻豆腐", "why": "看板料理"}
   ○ {"name": "自家製胡麻豆腐 (¥800前後)", "why": "前菜の定番。銀座うち山名物。口に入れると滑らかに溶ける食感が特徴。"}`;

// コース特徴モード（course があるとき）。{{COURSE}} を実際のコース名で置換する。
const SYS_COURSE = `【dishes の書き方 — コース特徴モード】
対象コース「{{COURSE}}」について google_search で検索し、そのコースの内容を3項目で説明する。
dishes は必ず3件。各項目の name は下記の見出しをそのまま使い、why に説明を書く：
1. name「品数と価格」/ why: コースの品数・料金（例「全8品 ¥10,000（税サ込）」）。分かる範囲で具体的に。
2. name「主な料理の流れ」/ why: 前菜→メイン→締め→デザート等の構成や、そのコースの名物料理を具体的に。
3. name「このコースの目玉・特徴」/ why: 他コースとの違い・看板料理・ボリューム・ドリンク（飲み放題）の有無など。

コース内容が Web で確認できない項目は why を「（情報不足）」とし、推測で埋めない。
指定されたコースが見つからない場合は、その店の別コースで代替せず、確認できた範囲のみ書く。`;

// 共通の末尾部（出力形式）
const SYS_TAIL = `【出力形式】
- 出力は必ず有効な JSON オブジェクト1つのみ。
- コードフェンス（\`\`\`json 等）や説明文、前置きは一切含めない。
- 応答の1文字目は \`{\`、最終文字は \`}\` でなければならない。

出力する JSON の形:
{"overview": "4〜7文の日本語（上記の6要素を含める）", "dishes": [{"name": "項目1", "why": "説明1"}, {"name": "項目2", "why": "説明2"}, {"name": "項目3", "why": "説明3"}]}`;

// course が渡されたらコース特徴モード、無ければおすすめメニューモードの systemInstruction を組み立てる
function buildSystemInstruction(course) {
  const dishSection = course
    ? SYS_COURSE.replace('{{COURSE}}', course)
    : SYS_MENU;
  return `${SYS_HEAD}\n\n${dishSection}\n\n${SYS_TAIL}`;
}

function buildGeminiRequestBody(shopName, shopUrl, preview, course) {
  const courseStr = (course || '').trim();
  // ユーザーメッセージ内で対象店舗を強く明示（別店舗との混同を防ぐアンカー情報）
  const lines = ['【対象店舗】'];
  lines.push(`- 店名: ${shopName || '(不明)'}`);
  if (shopUrl) lines.push(`- URL: ${shopUrl}`);
  if (courseStr) lines.push(`- 予約/検討中のコース: ${courseStr}`);
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
  lines.push(courseStr
    ? '必ず google_search で実際にウェブを検索し、上記コースの内容・特徴を JSON で返してください。'
    : '必ず google_search で実際にウェブを検索し、上記の対象店舗に合致する店舗のみの情報を JSON で返してください。');

  const userText = lines.join('\n');

  // ツール：google_search でウェブ検索、url_context で URL を直接読み込み
  // （どちらも Gemini 2.5 でサポート。url_context は特定URLの内容を優先取得）
  const tools = [{ google_search: {} }];
  if (shopUrl) tools.push({ url_context: {} });

  return {
    tools,
    systemInstruction: { parts: [{ text: buildSystemInstruction(courseStr) }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.2,       // 事実重視に振る
      maxOutputTokens: 4096,  // Pro は常時 thinking のため、思考で出力が切れないよう十分確保
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
