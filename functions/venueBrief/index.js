// 統合オーケストレータ：Gemini + Google Search grounding で
// 店情報を要約し、venue.brief に書き込む。認証と rate limit もここで担う。
const admin = require('firebase-admin');
const { extractShopName, extractShopUrl } = require('./queries');
const { buildGeminiRequestBody, parseGeminiResponse, extractSourceUrls, validateBrief } = require('./prompt');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）
const _lastCallAt = new Map(); // key: `${uid}:${eventId}` → timestampMs

const RATE_LIMIT_MS = 5000;
// gemini-2.5-pro は "no longer available to new users" で 404 のため、Pro 相当のエイリアス gemini-pro-latest を使う
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent';

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

// Gemini 側で JSON 構造がまれに壊れる (Pro thinking mode で dishes 配列の [{ が抜ける等) 対策。
// - Gemini HTTP 4xx/5xx は認可/クォータ/仕様上の非可逆エラーなので即失敗（再試行しない）
// - SAFETY ブロックは同じプロンプトで再試行しても同じ結果になるので即失敗
// - JSON parse 失敗・BRIEF_INVALID・empty candidates(SAFETY以外) は一時的エラーとして再試行対象
function isRetryableError(err) {
  const msg = String((err && err.message) || '');
  if (/^Gemini \d+:/.test(msg)) return false;
  if (/blockReason=SAFETY/.test(msg)) return false;
  return true;
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

  // venue.preview（OGP/JSON-LDから確定済みの店舗情報）を「検証済み情報」として Gemini に渡し、
  // 別店舗と混同することを防ぐ
  const preview = (data.venue && data.venue.preview) || null;

  // コース名が入力されていれば、おすすめメニューではなくコースの特徴を生成する
  const course = ((data.venue && data.venue.course) || '').trim();

  // Gemini + grounding で要約（Pro の thinking mode で JSON 構造がまれに壊れるため最大3回試行）
  const geminiBody = buildGeminiRequestBody(shopName, shopUrl, preview, course);
  const MAX_ATTEMPTS = 3;
  let parsed = null;
  let sourceUrls = [];
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const geminiJson = await callGemini(geminiBody, secrets.geminiKey);
      const p = parseGeminiResponse(geminiJson);
      if (!validateBrief(p)) throw new Error('BRIEF_INVALID');
      parsed = p;
      sourceUrls = extractSourceUrls(geminiJson);
      break;
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || attempt === MAX_ATTEMPTS) throw e;
      console.warn(JSON.stringify({ fn: 'generateVenueBrief', eventId, attempt, of: MAX_ATTEMPTS, retryable: true, error: String(e.message || e).slice(0, 300) }));
    }
  }

  // 全料理が「（情報不足）」= 実質情報無しならエラー扱い
  const allUnknown = parsed.dishes.every(d => /情報不足/.test(d.name) && /情報不足/.test(d.why));
  if (allUnknown && !parsed.overview.replace(/[（）\s]/g, '').length) {
    throw new Error('NO_RESULTS');
  }

  // Firestore に書込（既存 visible を保持）
  // ドット記法で各フィールドを top-level に書き込む（FieldValue.delete が top-level 必須のため）
  const priorVisible = !!(data.venue && data.venue.brief && data.venue.brief.visible);
  const mode = course ? 'course' : 'dishes';
  await ref.update({
    'venue.brief.overview': parsed.overview,
    'venue.brief.dishes': parsed.dishes,
    'venue.brief.mode': mode,
    'venue.brief.generatedAt': now,
    'venue.brief.sourceUrls': sourceUrls,
    'venue.brief.edited': false,
    'venue.brief.visible': priorVisible,
    'venue.brief.error': admin.firestore.FieldValue.delete(),
  });

  const brief = {
    overview: parsed.overview,
    dishes: parsed.dishes,
    mode,
    generatedAt: now,
    sourceUrls,
    edited: false,
    visible: priorVisible,
  };
  return { ok: true, brief };
}

module.exports = { generateVenueBriefImpl, isRetryableError };
