// 参加者が回答を登録（events/{id}.participants に新しい名前が追加）されたら、
// そのイベントで通知ONにしているホスト(notifyUids)へFCMプッシュを送る。
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
admin.initializeApp();

exports.notifyOnParticipantRegister = onDocumentUpdated('events/{eventId}', async (event) => {
  const before = event.data.before.data() || {};
  const after  = event.data.after.data()  || {};

  const notifyUids = after.notifyUids || [];
  if (!notifyUids.length) return;

  const beforeP = before.participants || {};
  const afterP  = after.participants  || {};
  // 新たに追加された参加者名のみ（既存の編集は対象外）
  const newNames = Object.keys(afterP).filter(n => !(n in beforeP));
  if (!newNames.length) return;

  const db = admin.firestore();

  // 通知ONホストのトークンを収集
  let tokens = [];
  for (const uid of notifyUids) {
    const snap = await db.doc(`fcmTokens/${uid}`).get();
    if (snap.exists && Array.isArray(snap.data().tokens)) tokens.push(...snap.data().tokens);
  }
  tokens = [...new Set(tokens)];
  if (!tokens.length) return;

  const eventName = after.name || 'イベント';
  const who = newNames.join('、');
  const url = `https://smcc-tools.github.io/chouseikun/?event=${event.params.eventId}`;

  // data-only メッセージ（表示はService Worker側で行う）
  const resp = await admin.messaging().sendEachForMulticast({
    tokens,
    data: {
      title: `「${eventName}」に新しい回答`,
      body: `${who} さんが回答を登録しました`,
      url,
      tag: `evt-${event.params.eventId}`
    }
  });

  // 無効になったトークンを掃除
  const invalid = new Set();
  resp.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (!r.success && (code === 'messaging/invalid-registration-token' ||
                       code === 'messaging/registration-token-not-registered')) {
      invalid.add(tokens[i]);
    }
  });
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
  if (afterUrl === beforeUrl) return; // URL変化なし（preview書き込みでの再発火を防ぐ）

  const ref = admin.firestore().doc(`events/${event.params.eventId}`);
  if (!afterUrl) {
    await ref.update({ 'venue.preview': admin.firestore.FieldValue.delete() }).catch(() => {});
    return;
  }
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
