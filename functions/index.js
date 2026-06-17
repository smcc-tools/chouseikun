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
