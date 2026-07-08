// 統合オーケストレータ：純粋関数群と副作用（Gemini/Firestore）を組み立てる。
// Task 1 の時点では雛形。認証チェックのみ実装。
const admin = require('firebase-admin');

async function generateVenueBriefImpl({ uid, eventId, secrets }) {
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (!eventId || typeof eventId !== 'string') throw new Error('INVALID_ARG');

  const db = admin.firestore();
  const ref = db.doc(`events/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND');
  const data = snap.data() || {};
  const owners = Array.isArray(data.ownerUids) ? data.ownerUids : [];
  if (!owners.includes(uid)) throw new Error('PERMISSION_DENIED');

  return { ok: true, stage: 'stub' };
}

module.exports = { generateVenueBriefImpl };
