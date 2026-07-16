// ホスト専用URLの引き換え：コードを非公開領域と照合し、呼び出し元 uid を ownerUids に追加する。
// コードの照合はサーバー側のみ（events/{id}/private はルールでホスト以外読めない）。
const admin = require('firebase-admin');

// 直近呼び出し時刻（プロセス内キャッシュ、Rate limit 用）。key = uid
const _lastCallAt = new Map();
const RATE_LIMIT_MS = 3000; // コード空間は 36^20 なので総当たりは実質不可能だが保険

function validateClaimInput(data) {
  const eventId = String((data && data.eventId) || '').trim();
  if (!eventId || eventId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(eventId)) return { error: 'INVALID_ARG' };
  const code = String((data && data.code) || '').trim();
  if (!/^[a-z0-9]{20}$/.test(code)) return { error: 'INVALID_ARG' };
  return { eventId, code };
}

async function claimHostByCodeImpl({ uid, data }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  const input = validateClaimInput(data || {});
  if (input.error) throw new Error(input.error);

  const last = _lastCallAt.get(uid) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) throw new Error('RATE_LIMITED');
  _lastCallAt.set(uid, now);

  const db = admin.firestore();
  const privSnap = await db.doc(`events/${input.eventId}/private/host`).get();
  if (!privSnap.exists || String((privSnap.data() || {}).code || '') !== input.code) {
    throw new Error('INVALID_CODE'); // doc 不在と不一致は区別しない（存在の探索を防ぐ）
  }
  await db.doc(`events/${input.eventId}`).update({
    ownerUids: admin.firestore.FieldValue.arrayUnion(uid),
  });
  return { ok: true };
}

module.exports = { claimHostByCodeImpl, validateClaimInput, RATE_LIMIT_MS };
