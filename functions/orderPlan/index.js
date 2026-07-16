// AI注文提案の本体。認証・入力検証・レート制限・Gemini呼び出し(最大3回)。
// Firestore の読み書きは行わない（結果は戻り値でその場限り）。
const { callGemini, isRetryableError } = require('../shared/gemini');
const { buildOrderPlanRequestBody, parseOrderPlanResponse, validateOrderPlan, extractSourceUrls } = require('./prompt');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）。key = uid
const _lastCallAt = new Map();
const RATE_LIMIT_MS = 10000; // 「別の案」連打対策で venue-brief(5s) より長め

function validateOrderInput(data) {
  const shop = String((data && data.shop) || '').trim();
  if (!shop || shop.length > 200) return { error: 'INVALID_ARG' };
  const partySize = parseInt(data.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 50) return { error: 'INVALID_ARG' };
  let budget = null;
  if (data.budget != null && data.budget !== '') {
    budget = parseInt(data.budget);
    if (!Number.isInteger(budget) || budget <= 0) return { error: 'INVALID_ARG' };
  }
  const mood = String(data.mood || '').trim().slice(0, 100);
  let excludeDishes = [];
  if (data.excludeDishes != null) {
    if (!Array.isArray(data.excludeDishes) || data.excludeDishes.length > 20) return { error: 'INVALID_ARG' };
    excludeDishes = data.excludeDishes.map(s => String(s).trim().slice(0, 60)).filter(Boolean);
  }
  return { shop, partySize, budget, mood, excludeDishes };
}

async function suggestOrderPlanImpl({ uid, data, secrets }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (!secrets || !secrets.geminiKey) throw new Error('SECRETS_MISSING');
  const input = validateOrderInput(data || {});
  if (input.error) throw new Error(input.error);

  const last = _lastCallAt.get(uid) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) throw new Error('RATE_LIMITED');
  _lastCallAt.set(uid, now);

  const body = buildOrderPlanRequestBody(input);
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const apiJson = await callGemini(body, secrets.geminiKey);
      const parsed = parseOrderPlanResponse(apiJson);
      if (parsed.shopFound === false) throw new Error('NO_RESULTS');
      if (!validateOrderPlan(parsed)) throw new Error('PLAN_INVALID');
      return {
        ok: true,
        plan: parsed.plan,
        totalEstimate: parsed.totalEstimate,
        notes: parsed.notes,
        sourceUrls: extractSourceUrls(apiJson),
      };
    } catch (e) {
      lastErr = e;
      if (e.message === 'NO_RESULTS') throw e; // 情報不足はリトライしても同じ
      if (!isRetryableError(e) || attempt === MAX_ATTEMPTS) throw e;
      console.warn(JSON.stringify({ fn: 'suggestOrderPlan', attempt, of: MAX_ATTEMPTS, retryable: true, error: String(e.message || e).slice(0, 300) }));
    }
  }
  throw lastErr;
}

module.exports = { suggestOrderPlanImpl, validateOrderInput, RATE_LIMIT_MS };
