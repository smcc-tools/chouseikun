// 参加者が回答を登録（events/{id}.participants に新しい名前が追加）されたら、
// そのイベントで通知ONにしているホスト(notifyUids)へFCMプッシュを送る。
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
admin.initializeApp();

exports.notifyOnParticipantRegister = onDocumentUpdated('events/{eventId}', async (event) => {
  const eventId = event.params.eventId;
  const before = event.data.before.data() || {};
  const after  = event.data.after.data()  || {};

  const notifyUids = after.notifyUids || [];

  // ① 新規回答登録
  const beforeP = before.participants || {};
  const afterP  = after.participants  || {};
  const newNames = Object.keys(afterP).filter(n => !(n in beforeP));

  // ② 支払済みにした
  const beforePaid = (before.settle && before.settle.paid) || {};
  const afterPaid  = (after.settle && after.settle.paid)  || {};
  const newlyPaid = Object.keys(afterPaid).filter(n => afterPaid[n] === true && beforePaid[n] !== true);

  // 診断ログ：何もしない場合でも何が起きたか可視化する
  console.log(JSON.stringify({
    fn: 'notify', eventId,
    notifyUidsCount: notifyUids.length,
    newParticipants: newNames.length,
    newlyPaid: newlyPaid.length,
  }));

  if (!notifyUids.length) return;

  const notifications = [];
  const eventName = after.name || 'イベント';
  const url = `https://smcc-tools.github.io/chouseikun/?event=${eventId}`;

  if (newNames.length) {
    notifications.push({
      title: `「${eventName}」に新しい回答`,
      body: `${newNames.join('、')} さんが回答を登録しました`,
      tag: `evt-${eventId}`
    });
  }
  if (newlyPaid.length) {
    notifications.push({
      title: `「${eventName}」の精算`,
      body: `${newlyPaid.join('、')} さんが支払済みにしました`,
      tag: `paid-${eventId}`
    });
  }

  if (!notifications.length) return;

  const db = admin.firestore();

  // 通知ONホストのトークンを収集
  let tokens = [];
  for (const uid of notifyUids) {
    const snap = await db.doc(`fcmTokens/${uid}`).get();
    if (snap.exists && Array.isArray(snap.data().tokens)) tokens.push(...snap.data().tokens);
  }
  tokens = [...new Set(tokens)];

  console.log(JSON.stringify({
    fn: 'notify', eventId,
    tokensFound: tokens.length,
    notificationsToSend: notifications.length,
  }));

  if (!tokens.length) {
    console.warn(JSON.stringify({ fn: 'notify', eventId, warn: 'no_tokens_for_notifyUids', notifyUids }));
    return;
  }

  // data-only メッセージ（表示はService Worker側で行う）
  const invalid = new Set();
  const sendResults = [];
  for (const n of notifications) {
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      data: { title: n.title, body: n.body, url, tag: n.tag }
    });
    sendResults.push({ successCount: resp.successCount, failureCount: resp.failureCount });
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        console.warn(JSON.stringify({ fn: 'notify', eventId, send_error: code || 'unknown', token_hint: tokens[i].slice(-8) }));
        // 旧プロジェクト由来の mismatched-credential も掃除対象に含める
        // （プロジェクト統合前に発行されたトークンが残っているケース）
        if (code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/mismatched-credential') {
          invalid.add(tokens[i]);
        }
      }
    });
  }
  console.log(JSON.stringify({ fn: 'notify', eventId, sendResults, invalidCount: invalid.size }));

  // 無効になったトークンを掃除
  if (invalid.size) {
    for (const uid of notifyUids) {
      const ref = db.doc(`fcmTokens/${uid}`);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const remaining = (snap.data().tokens || []).filter(t => !invalid.has(t));
      await ref.set({ tokens: remaining }, { merge: true });
    }
  }
});

// お店欄にURL（食べログ等）が設定されたら、ページのOGP/JSON-LDを取得して
// venue.preview（写真・店名・評価・価格・ジャンル）を保存する。
exports.fetchVenuePreview = onDocumentUpdated('events/{eventId}', async (event) => {
  const before = event.data.before.data() || {};
  const after  = event.data.after.data()  || {};
  const beforeUrl = extractUrl(before.venue && before.venue.shop);
  const afterUrl  = extractUrl(after.venue && after.venue.shop);
  const curPreview = after.venue && after.venue.preview;

  const ref = admin.firestore().doc(`events/${event.params.eventId}`);

  if (!afterUrl) {
    // URLが無くなった → previewを掃除
    if (beforeUrl || (curPreview && curPreview.url)) {
      await ref.update({ 'venue.preview': admin.firestore.FieldValue.delete() }).catch(() => {});
    }
    return;
  }
  // 既に現URLのpreviewが付いている → 何もしない（書き込みでの再発火を防ぐ）
  if (curPreview && curPreview.url === afterUrl && curPreview.image) return;

  try {
    const preview = await fetchPreview(afterUrl);
    if (preview) await ref.update({ 'venue.preview': preview });
  } catch (e) { console.error('venue preview error:', e); }
});

function extractUrl(s) {
  if (!s) return '';
  const m = String(s).match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'");
}

async function fetchPreview(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChouseikunBot/1.0; +https://smcc-tools.github.io/chouseikun/)' },
    redirect: 'follow'
  });
  if (!res.ok) return null;
  const html = await res.text();

  const meta = (prop) => {
    const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'))
           || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i'));
    return m ? decodeEntities(m[1]) : '';
  };

  let title = meta('og:title');
  let image = meta('og:image');
  let rating = '', reviews = '', price = '', genre = '';

  // JSON-LD（schema.org）から評価・価格・ジャンルなどを補完
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const blk of blocks) {
    const jsonText = blk.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    let data;
    try { data = JSON.parse(jsonText); } catch (_) { continue; }
    const arr = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
    for (const d of arr) {
      if (!d || typeof d !== 'object') continue;
      const type = String(d['@type'] || '');
      const isRest = /Restaurant|FoodEstablishment|LocalBusiness/i.test(type);
      if (!isRest) continue;
      if (!title && d.name) title = d.name;
      if (!image && d.image) image = Array.isArray(d.image) ? d.image[0] : (d.image.url || d.image);
      if (d.aggregateRating) {
        rating = d.aggregateRating.ratingValue || rating;
        reviews = d.aggregateRating.reviewCount || d.aggregateRating.ratingCount || reviews;
      }
      if (d.priceRange) price = d.priceRange;
      if (d.servesCuisine) genre = Array.isArray(d.servesCuisine) ? d.servesCuisine.join('・') : d.servesCuisine;
    }
  }

  if (!image && !title) return null;
  return {
    url,
    title: String(title || '').slice(0, 120),
    image: String(image || ''),
    rating: rating !== '' ? String(rating) : '',
    reviews: reviews !== '' ? String(reviews) : '',
    price: price !== '' ? String(price) : '',
    genre: genre !== '' ? String(genre).slice(0, 80) : ''
  };
}

// 店の概要・おすすめメニュー生成（Callable、ホスト認証必須）
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { generateVenueBriefImpl } = require('./venueBrief');

exports.generateVenueBrief = onCall({
  region: 'asia-northeast1',
  timeoutSeconds: 45,
  memory: '256MiB',
  secrets: ['GEMINI_API_KEY'],
}, async (request) => {
  const uid = request.auth && request.auth.uid;
  const { eventId } = request.data || {};
  try {
    return await generateVenueBriefImpl({
      uid,
      eventId,
      secrets: {
        geminiKey: process.env.GEMINI_API_KEY,
      },
    });
  } catch (e) {
    const code = e.message === 'UNAUTHENTICATED' ? 'unauthenticated'
      : e.message === 'INVALID_ARG' ? 'invalid-argument'
      : e.message === 'NOT_FOUND' ? 'not-found'
      : e.message === 'PERMISSION_DENIED' ? 'permission-denied'
      : e.message === 'RATE_LIMITED' ? 'resource-exhausted'
      : e.message === 'SHOP_EMPTY' ? 'failed-precondition'
      : e.message === 'NO_RESULTS' ? 'not-found'
      : 'internal';
    throw new HttpsError(code, e.message);
  }
});
