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
