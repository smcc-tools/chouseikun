// 統合オーケストレータ：Gemini + Google Search grounding で
// 店情報を要約し、venue.brief に書き込む。認証と rate limit もここで担う。
const admin = require('firebase-admin');
const { extractShopName, extractShopUrl } = require('./queries');
const { buildGeminiRequestBody, parseGeminiResponse, extractSourceUrls, validateBrief } = require('./prompt');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）
const _lastCallAt = new Map(); // key: `${uid}:${eventId}` → timestampMs

const RATE_LIMIT_MS = 5000;
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

async function callGemini(body, geminiKey) {
  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function generateVenueBriefImpl({ uid, eventId, secrets }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (!eventId || typeof eventId !== 'string') throw new Error('INVALID_ARG');
  if (!secrets || !secrets.geminiKey) throw new Error('SECRETS_MISSING');

  // Rate limit
  const rlKey = `${uid}:${eventId}`;
  const last = _lastCallAt.get(rlKey) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) throw new Error('RATE_LIMITED');
  _lastCallAt.set(rlKey, now);

  const db = admin.firestore();
  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND');
  const data = snap.data() || {};
  const owners = Array.isArray(data.ownerUids) ? data.ownerUids : [];
  if (!owners.includes(uid)) throw new Error('PERMISSION_DENIED');

  const shopField = (data.venue && data.venue.shop) || '';
  const shopName = extractShopName(shopField);
  const shopUrl = extractShopUrl(shopField);
  if (!shopName) throw new Error('SHOP_EMPTY');

  // Gemini + grounding で1コール要約
  const geminiBody = buildGeminiRequestBody(shopName, shopUrl);
  const geminiJson = await callGemini(geminiBody, secrets.geminiKey);
  const parsed = parseGeminiResponse(geminiJson);
  const sourceUrls = extractSourceUrls(geminiJson);
  if (!validateBrief(parsed)) throw new Error('BRIEF_INVALID');

  // 全料理が「（情報不足）」= 実質情報無しならエラー扱い
  const allUnknown = parsed.dishes.every(d => /情報不足/.test(d.name) && /情報不足/.test(d.why));
  if (allUnknown && !parsed.overview.replace(/[（）\s]/g, '').length) {
    throw new Error('NO_RESULTS');
  }

  // Firestore に書込（既存 visible を保持）
  const priorVisible = !!(data.venue && data.venue.brief && data.venue.brief.visible);
  const brief = {
    overview: parsed.overview,
    dishes: parsed.dishes,
    generatedAt: now,
    sourceUrls,
    edited: false,
    visible: priorVisible,
    error: admin.firestore.FieldValue.delete(),
  };
  await ref.update({ 'venue.brief': brief });

  return { ok: true, brief: { ...brief, error: undefined } };
}

module.exports = { generateVenueBriefImpl };
