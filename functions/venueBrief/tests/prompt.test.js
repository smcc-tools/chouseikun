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

test('buildGeminiRequestBody: URL が渡された時は user text に「参考URL」を含む', () => {
  const body = buildGeminiRequestBody('銀座 うち山', 'https://tabelog.com/x');
  assert.ok(body.contents[0].parts[0].text.includes('参考URL'));
  assert.ok(body.contents[0].parts[0].text.includes('https://tabelog.com/x'));
});

test('buildGeminiRequestBody: URL 空の時は「参考URL」を含めない', () => {
  const body = buildGeminiRequestBody('銀座 うち山', '');
  assert.ok(!body.contents[0].parts[0].text.includes('参考URL'));
});

test('buildGeminiRequestBody: responseMimeType=application/json とスキーマ強制', () => {
  const body = buildGeminiRequestBody('X', '');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema);
  assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
  assert.ok(body.generationConfig.responseSchema.properties.overview);
  assert.ok(body.generationConfig.responseSchema.properties.dishes);
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
