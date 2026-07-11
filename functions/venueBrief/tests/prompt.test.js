const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGeminiRequestBody, parseGeminiResponse, extractSourceUrls, validateBrief } = require('../prompt');

test('buildGeminiRequestBody: tools に google_search を含む (Gemini 2.x)', () => {
  const body = buildGeminiRequestBody('銀座 うち山', '');
  assert.ok(Array.isArray(body.tools));
  assert.ok(body.tools.some(t => t.google_search !== undefined));
});

test('buildGeminiRequestBody: systemInstruction と contents に店名を含む', () => {
  const body = buildGeminiRequestBody('銀座 うち山', '');
  assert.ok(body.systemInstruction);
  assert.ok(Array.isArray(body.contents));
  assert.ok(body.contents[0].parts[0].text.includes('銀座 うち山'));
});

test('buildGeminiRequestBody: URL が渡された時は user text に URL を含む', () => {
  const body = buildGeminiRequestBody('銀座 うち山', 'https://tabelog.com/x');
  assert.ok(body.contents[0].parts[0].text.includes('URL:'));
  assert.ok(body.contents[0].parts[0].text.includes('https://tabelog.com/x'));
});

test('buildGeminiRequestBody: URL 空の時は URL 行を含めない', () => {
  const body = buildGeminiRequestBody('銀座 うち山', '');
  assert.ok(!body.contents[0].parts[0].text.includes('URL:'));
});

test('buildGeminiRequestBody: URL が渡された時は url_context ツールも追加される', () => {
  const body = buildGeminiRequestBody('X', 'https://tabelog.com/x');
  assert.ok(body.tools.some(t => t.url_context !== undefined));
});

test('buildGeminiRequestBody: URL 空なら url_context ツールは追加されない', () => {
  const body = buildGeminiRequestBody('X', '');
  assert.ok(!body.tools.some(t => t.url_context !== undefined));
});

test('buildGeminiRequestBody: preview が渡されたら「検証済み情報」を prompt に含める', () => {
  const preview = { title: '銀座 うち山', sub: '銀座 / 割烹', rating: '4.10', price: '¥30,000〜' };
  const body = buildGeminiRequestBody('銀座 うち山', 'https://tabelog.com/x', preview);
  const text = body.contents[0].parts[0].text;
  assert.ok(text.includes('検証済み情報'));
  assert.ok(text.includes('銀座 / 割烹'));
  assert.ok(text.includes('¥30,000'));
});

test('buildGeminiRequestBody: preview が null なら「検証済み情報」ブロックを含めない', () => {
  const body = buildGeminiRequestBody('銀座 うち山', 'https://tabelog.com/x', null);
  assert.ok(!body.contents[0].parts[0].text.includes('検証済み情報'));
});

test('systemInstruction: overview の書き方に 4〜7文と6つの要素を含む指示がある', () => {
  const body = buildGeminiRequestBody('X', '');
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('4〜7文'), 'overview の文数指定');
  assert.ok(sys.includes('何屋か'), '要素1: ジャンル');
  assert.ok(sys.includes('差別化'), '要素2: 特徴');
  assert.ok(sys.includes('価格帯'), '要素3: 予算');
  assert.ok(sys.includes('席の雰囲気'), '要素4: 席');
  assert.ok(sys.includes('利用シーン'), '要素5: シーン');
  assert.ok(sys.includes('予約'), '要素6: 予約');
});

test('systemInstruction: dishes の書き方に具体的な料理名の指示と根拠フレーズ禁止例がある', () => {
  const body = buildGeminiRequestBody('X', '');
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('具体的な料理名'), '具体性の要求');
  assert.ok(sys.includes('看板料理'), '禁止フレーズの明示例');
});

test('systemInstruction: 推奨手順と自問セクションを含む', () => {
  const body = buildGeminiRequestBody('X', '');
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('推奨手順'), '手順明示');
  assert.ok(sys.includes('自問'), 'self-check');
});

test('buildGeminiRequestBody: generationConfig は temperature のみ（tools と mimeType 併用不可のため schema 撤廃）', () => {
  const body = buildGeminiRequestBody('X', '');
  assert.equal(typeof body.generationConfig.temperature, 'number');
  assert.equal(body.generationConfig.responseMimeType, undefined);
  assert.equal(body.generationConfig.responseSchema, undefined);
});

test('buildGeminiRequestBody: 温度は低め (<=0.4) で事実重視', () => {
  const body = buildGeminiRequestBody('X', '');
  assert.ok(body.generationConfig.temperature <= 0.4);
});

test('parseGeminiResponse: 正常な candidates から overview と dishes を抽出', () => {
  const apiJson = {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            overview: '落ち着いた大人向けの創作和食。個室あり。',
            dishes: [
              { name: '胡麻豆腐', why: '看板料理' },
              { name: '天ぷら盛合せ', why: '旬野菜が魅力' },
              { name: '土鍋ご飯', why: 'シメの定番' },
            ],
          }),
        }],
      },
    }],
  };
  const brief = parseGeminiResponse(apiJson);
  assert.equal(brief.overview, '落ち着いた大人向けの創作和食。個室あり。');
  assert.equal(brief.dishes.length, 3);
  assert.equal(brief.dishes[0].name, '胡麻豆腐');
});

test('parseGeminiResponse: コードフェンスに囲まれた JSON も抽出できる', () => {
  const apiJson = {
    candidates: [{
      content: {
        parts: [{
          text: '以下が要約です:\n```json\n{"overview":"落ち着いた和食店","dishes":[{"name":"胡麻豆腐","why":"看板"},{"name":"天ぷら","why":"旬"},{"name":"土鍋ご飯","why":"シメ"}]}\n```\nお楽しみください。',
        }],
      },
    }],
  };
  const brief = parseGeminiResponse(apiJson);
  assert.equal(brief.overview, '落ち着いた和食店');
  assert.equal(brief.dishes.length, 3);
  assert.equal(brief.dishes[0].name, '胡麻豆腐');
});

test('parseGeminiResponse: candidates が空なら例外', () => {
  assert.throws(() => parseGeminiResponse({ candidates: [] }), /empty/);
});

test('parseGeminiResponse: parts のテキストが JSON でなければ例外', () => {
  const apiJson = { candidates: [{ content: { parts: [{ text: 'not json' }] } }] };
  assert.throws(() => parseGeminiResponse(apiJson), /parse/);
});

test('extractSourceUrls: groundingMetadata.groundingChunks から web.uri を抽出', () => {
  const apiJson = {
    candidates: [{
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://a.com', title: 'A' } },
          { web: { uri: 'https://b.com', title: 'B' } },
          { web: { uri: 'https://a.com', title: 'A dup' } },  // 重複
        ],
      },
    }],
  };
  const urls = extractSourceUrls(apiJson);
  assert.equal(urls.length, 2);
  assert.deepEqual(urls, ['https://a.com', 'https://b.com']);
});

test('extractSourceUrls: groundingMetadata が無ければ空配列', () => {
  assert.deepEqual(extractSourceUrls({ candidates: [{}] }), []);
  assert.deepEqual(extractSourceUrls({}), []);
});

test('extractSourceUrls: 最大5件に制限', () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ web: { uri: `https://s${i}.com` } }));
  const apiJson = { candidates: [{ groundingMetadata: { groundingChunks: chunks } }] };
  assert.equal(extractSourceUrls(apiJson).length, 5);
});

test('validateBrief: overview が空文字なら false', () => {
  assert.equal(validateBrief({ overview: '', dishes: [{name:'a',why:'b'}] }), false);
});

test('validateBrief: dishes が 3件でなければ false', () => {
  assert.equal(validateBrief({ overview: 'x', dishes: [] }), false);
  assert.equal(validateBrief({ overview: 'x', dishes: [{name:'a',why:'b'}] }), false);
});

test('validateBrief: dishes の why が空文字なら false', () => {
  assert.equal(validateBrief({
    overview: 'x',
    dishes: [{name:'a',why:'b'},{name:'c',why:'d'},{name:'e',why:''}],
  }), false);
});

test('validateBrief: 正しい形なら true', () => {
  assert.equal(validateBrief({
    overview: 'x',
    dishes: [{name:'a',why:'b'},{name:'c',why:'d'},{name:'e',why:'f'}],
  }), true);
});

// ── コース対応・Pro化 ──────────────────────────

test('buildGeminiRequestBody: course が渡されたら systemInstruction にコース特徴モードの指示を含む', () => {
  const body = buildGeminiRequestBody('銀座 うち山', 'https://tabelog.com/x', null, '特選会席コース ¥10,000');
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('コース特徴モード'), 'コース特徴モードの指示');
  assert.ok(sys.includes('品数と価格'), 'コース3項目の見出し1');
  assert.ok(sys.includes('主な料理の流れ'), 'コース3項目の見出し2');
  assert.ok(sys.includes('目玉'), 'コース3項目の見出し3');
});

test('buildGeminiRequestBody: course が渡されたら user text にコース名を明示する', () => {
  const body = buildGeminiRequestBody('銀座 うち山', '', null, '特選会席コース');
  assert.ok(body.contents[0].parts[0].text.includes('特選会席コース'));
});

test('buildGeminiRequestBody: course 空なら従来のおすすめメニュー指示（コース特徴モードは含まない）', () => {
  const body = buildGeminiRequestBody('X', '', null, '');
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(!sys.includes('コース特徴モード'), 'コースモードは含まない');
  assert.ok(sys.includes('具体的な料理名'), 'おすすめメニュー指示');
});

test('buildGeminiRequestBody: course 未指定（3引数）でも従来どおり動く（後方互換）', () => {
  const body = buildGeminiRequestBody('X', '', null);
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(!sys.includes('コース特徴モード'));
  assert.ok(sys.includes('具体的な料理名'));
});

test('buildGeminiRequestBody: maxOutputTokens を 4096 に設定（Pro の thinking で出力が切れないように）', () => {
  const body = buildGeminiRequestBody('X', '');
  assert.equal(body.generationConfig.maxOutputTokens, 4096);
});

test('systemInstruction: プロンプト強化（検索の多観点化・情報源の厳格化）を含む', () => {
  const body = buildGeminiRequestBody('X', '');
  const sys = body.systemInstruction.parts[0].text;
  assert.ok(sys.includes('最低2回'), '検索の多観点化');
  assert.ok(sys.includes('口コミ'), '情報源の言及');
});
