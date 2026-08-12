// 座席の「確定」判定の特性化テスト。
// 未設定を未確定として扱う（移行処理を書かないための前提）ことを固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { isPartyConfirmed } = loadFunctions(['isPartyConfirmed']);

// updateActiveParty はトランザクションで書くため、Firestore まわりを差し替えて評価する。
// showToast は文言の確認に使う。
// latestEventDataSnapshot が指定されると、それをローカルの写しとして使用。
// Firestore 側（store.data）と異なる値にすることで、トランザクション内での
// 最新値読み直しの重要性を検証できる。
function makeEnv(seatParties, activeIdx = 0, latestEventDataSnapshot = null) {
  const store = { data: { seatParties }, writes: [] };
  const toasts = [];
  const runTransaction = async (_db, fn) => fn({
    get: async () => ({ data: () => store.data }),
    update: (_ref, patch) => { store.writes.push(patch); store.data = { ...store.data, ...patch }; },
  });
  const globals = {
    db: {}, doc: () => ({}), eventId: 'ev1', runTransaction,
    latestEventData: latestEventDataSnapshot !== null ? latestEventDataSnapshot : store.data, seatingActiveParty: activeIdx,
    showToast: (m) => toasts.push(m),
  };
  return { store, toasts, globals };
}

const NAMES = ['updateActiveParty', 'mutateParties', 'isPartyConfirmed', 'getParties', 'activeParty', 'clampActiveIdx'];
const P = (id, name, extra = {}) => ({ id, name, tables: [], assignment: null, locks: [], ...extra });

test('confirmed 未設定の次会は未確定', () => {
  assert.equal(isPartyConfirmed({ id: 'p1', name: '1次会' }), false);
});

test('confirmed:false は未確定', () => {
  assert.equal(isPartyConfirmed({ id: 'p1', confirmed: false }), false);
});

test('confirmed:true は確定', () => {
  assert.equal(isPartyConfirmed({ id: 'p1', confirmed: true }), true);
});

test('null / undefined は未確定（呼び出し側で分岐を書かなくて済むように）', () => {
  assert.equal(isPartyConfirmed(null), false);
  assert.equal(isPartyConfirmed(undefined), false);
});

test('文字列の "true" は確定にしない（真偽値だけを認める）', () => {
  assert.equal(isPartyConfirmed({ confirmed: 'true' }), false);
});

test('1 は確定にしない', () => {
  assert.equal(isPartyConfirmed({ confirmed: 1 }), false);
});

test('未確定なら書き込める', async () => {
  const env = makeEnv([P('a', '1次会')]);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, 0);
  assert.deepEqual(env.store.data.seatParties[0].locks, ['t1:0']);
});

test('確定中は書き込まず、理由をトーストで知らせる', async () => {
  const env = makeEnv([P('a', '1次会', { confirmed: true })]);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, -2);
  assert.equal(env.store.writes.length, 0, '確定中に座席を書き換えてはいけない');
  assert.match(env.toasts.join(''), /確定/, '何が起きたか分かる文言を出す');
});

test('確定中でも allowConfirmed 付きなら書ける（解除の経路）', async () => {
  const env = makeEnv([P('a', '1次会', { confirmed: true })]);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  const r = await updateActiveParty({ confirmed: false }, { allowConfirmed: true });
  assert.equal(r, 0);
  assert.equal(env.store.data.seatParties[0].confirmed, false);
});

test('表示中の次会だけを書き換える', async () => {
  const env = makeEnv([P('a', '1次会'), P('b', '2次会')], 1);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  await updateActiveParty({ locks: ['t1:0'] });
  assert.deepEqual(env.store.data.seatParties[0].locks, [], '表示していない次会は触らない');
  assert.deepEqual(env.store.data.seatParties[1].locks, ['t1:0']);
});

test('1次会が確定していても2次会は書き換えられる', async () => {
  const env = makeEnv([P('a', '1次会', { confirmed: true }), P('b', '2次会')], 1);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, 1);
  assert.deepEqual(env.store.data.seatParties[1].locks, ['t1:0']);
});

test('ローカルが未確定でも、Firestore が確定中なら書き込まない（共同ホスト同時確定への防御）', async () => {
  // latestEventData（ローカルの写し）: 未確定
  const localParty = P('a', '1次会', { confirmed: false });
  // store.data（Firestore 側）: 確定済み
  const firebaseParty = P('a', '1次会', { confirmed: true });
  const env = makeEnv([firebaseParty], 0, { seatParties: [localParty] });
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  // ローカルは未確定に見えるが、mutateParties 内のトランザクションで Firestore を読み直し、
  // 確定中であることを発見して拒否する必要がある。
  // 誤った実装（ローカルの latestEventData だけで判定）なら、この書き込みは通ってしまう。
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, -2, '共同ホストが直前に確定していたら、書き込みは止まるべき');
  assert.equal(env.store.writes.length, 0, '確定中は書き込まない');
  assert.match(env.toasts.join(''), /確定/, '確定中であることをユーザーに知らせる');
});

test('ローカルが確定中でも、Firestore が未確定なら書き込める（最新値で判定）', async () => {
  // latestEventData（ローカルの写し）: 確定済み（古い情報）
  const localParty = P('a', '1次会', { confirmed: true });
  // store.data（Firestore 側）: 未確定（誰かが解除した）
  const firebaseParty = P('a', '1次会', { confirmed: false });
  const env = makeEnv([firebaseParty], 0, { seatParties: [localParty] });
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  // ローカルは確定中に見えるが、トランザクション内で Firestore を読み直し、
  // 未確定であることを発見して書き込みを許可する必要がある。
  // 誤った実装（ローカルの latestEventData だけで判定）なら、この書き込みは拒否される。
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, 0, 'Firestore が未確定なら書き込めるべき');
  assert.deepEqual(env.store.data.seatParties[0].locks, ['t1:0']);
});
