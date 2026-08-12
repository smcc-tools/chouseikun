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
  // updateActiveParty は楽観更新の描画に renderSeatingBoard を呼ぶ（DOM を持たないため
  // ここではスタブで差し替え、呼ばれた引数＝「その時点で画面に表示しようとした内容」を控える）。
  const renders = [];
  const runTransaction = async (_db, fn) => fn({
    get: async () => ({ data: () => store.data }),
    update: (_ref, patch) => { store.writes.push(patch); store.data = { ...store.data, ...patch }; },
  });
  const globals = {
    db: {}, doc: () => ({}), eventId: 'ev1', runTransaction,
    latestEventData: latestEventDataSnapshot !== null ? latestEventDataSnapshot : store.data, seatingActiveParty: activeIdx,
    showToast: (m) => toasts.push(m),
    renderSeatingBoard: (d) => renders.push(d),
  };
  return { store, toasts, renders, globals };
}

const NAMES = ['updateActiveParty', 'applyPartyPatch', 'mutateParties', 'isPartyConfirmed', 'getParties', 'activeParty', 'clampActiveIdx'];
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

// ── updateActiveParty の楽観更新（体感速度の改善）──
// runTransaction は updateDoc と違いサーバ往復を待たないと画面に反映されない
// （updateDoc にあるローカルキャッシュへの先読み反映が効かない）ため、書き込みを
// 待つ前に手元の表示を先に更新し、拒否・失敗したら控えておいた元のデータへ戻す。
// renderSeatingBoard に渡された引数を見れば「その時点で画面に表示しようとした内容」を
// 検証できる。
test('楽観更新: 拒否されたら（確定中 -2）、控えておいた元のデータへ戻して再描画する', async () => {
  const env = makeEnv([P('a', '1次会', { confirmed: true })]);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, -2);
  assert.equal(env.renders.length, 2, '楽観更新の描画1回＋拒否後に戻す描画1回の計2回のはず');
  assert.deepEqual(env.renders[0].seatParties[0].locks, ['t1:0'],
    'サーバ応答を待たず、まず楽観更新した内容を描画する（体感速度の改善）');
  assert.deepEqual(env.renders[1].seatParties[0].locks, [],
    '拒否されたら楽観更新を取り消し、元の状態に戻して再描画する（保存されていないのに画面だけ変わったままにしない）');
  assert.equal(env.renders[1].seatParties[0].confirmed, true, '元のデータ（confirmed含む）に完全に戻っている');
  assert.equal(env.store.writes.length, 0, 'サーバへは書き込まれていない');
});

test('楽観更新: 成功したら、手元のデータはパッチ適用後のまま（巻き戻し描画は起きない）', async () => {
  const env = makeEnv([P('a', '1次会')]);
  const { updateActiveParty } = loadFunctions(NAMES, env.globals);
  const r = await updateActiveParty({ locks: ['t1:0'] });
  assert.equal(r, 0);
  assert.equal(env.renders.length, 1, '成功時は楽観更新の描画1回だけ（拒否時の巻き戻し描画は起きない）');
  assert.deepEqual(env.renders[0].seatParties[0].locks, ['t1:0']);
  assert.deepEqual(env.store.data.seatParties[0].locks, ['t1:0'], 'サーバ側にも同じ内容が書かれている');
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

// ── anyPartyConfirmed（メンバー改名・削除は全次会共通のため、表示中の次会だけでは足りない）──
const AC_NAMES = ['anyPartyConfirmed', 'isPartyConfirmed', 'getParties'];

test('anyPartyConfirmed: 全次会が未確定なら false', () => {
  const { anyPartyConfirmed } = loadFunctions(AC_NAMES);
  const data = { seatParties: [P('a', '1次会'), P('b', '2次会')] };
  assert.equal(anyPartyConfirmed(data), false);
});

test('anyPartyConfirmed: 表示中でない次会だけが確定していても true（Critical本体）', () => {
  const { anyPartyConfirmed } = loadFunctions(AC_NAMES);
  // 1次会（表示中を想定）は未確定、2次会（表示していない）だけが確定している。
  // activeParty() だけを見る古い実装ではこのケースを見落とす。
  const data = { seatParties: [P('a', '1次会'), P('b', '2次会', { confirmed: true })] };
  assert.equal(anyPartyConfirmed(data), true);
});

test('anyPartyConfirmed: 次会が1件のみで確定している場合も true', () => {
  const { anyPartyConfirmed } = loadFunctions(AC_NAMES);
  const data = { seatParties: [P('a', '1次会', { confirmed: true })] };
  assert.equal(anyPartyConfirmed(data), true);
});

test('anyPartyConfirmed: seatParties が無い旧データは false', () => {
  const { anyPartyConfirmed } = loadFunctions(AC_NAMES);
  assert.equal(anyPartyConfirmed({}), false);
  assert.equal(anyPartyConfirmed({ seatTables: [], seatAssignment: null, seatLocks: [] }), false);
});

// ── seatingDeleteMember / seatingRenameMember の書き込み層（3層目）──
// メンバーは全次会で共通のため seatTags と全 seatParties を同時に書き換える。
// mutateParties を使えないため updateSeating（素の updateDoc）を直接呼んでいたが、
// それでは書き込み層の確定チェックが効かない。mutateSeatingWide 経由に直したことを検証する。
// 'activeParty' / 'clampActiveIdx' は現在の入口ガード（anyPartyConfirmed）からは
// 呼ばれないが、入口ガードが isPartyConfirmed(activeParty(data)) に後退した場合に
// 抽出対象の関数が呼ぶことになるため、退行検出テストのためにあらかじめ含めておく。
const WIDE_NAMES = [
  'seatingDeleteMember', 'seatingRenameMember', 'mutateSeatingWide',
  'mutateMemberDiff', 'anyPartyConfirmed', 'isPartyConfirmed', 'getParties',
  'viewMembers', 'membersForView', 'getSortedNames', 'normalizeName',
  'MEMBER_VIEW_CHAIN', 'updateMemberDiffEntry', 'SEATING_MEMBER_LOCK_MSG',
  'activeParty', 'clampActiveIdx',
];

function makeWideEnv(dataOverrides, latestEventDataOverride = null) {
  const store = {
    data: { participants: {}, participantOrder: [], memberDiff: {}, seatTags: {}, seatParties: [], ...dataOverrides },
    writes: [],
  };
  const toasts = [];
  const runTransaction = async (_db, fn) => fn({
    get: async () => ({ data: () => store.data }),
    update: (_ref, patch) => { store.writes.push(patch); store.data = { ...store.data, ...patch }; },
  });
  const globals = {
    db: {}, doc: () => ({}), eventId: 'ev1', runTransaction,
    latestEventData: latestEventDataOverride !== null ? latestEventDataOverride : store.data,
    seatingActiveParty: 0, // 表示中は1次会（index 0）を想定
    showToast: (m) => toasts.push(m),
  };
  return { store, toasts, globals };
}

function wideData(overrides = {}) {
  return {
    participants: { '田中': {}, '鈴木': {} },
    participantOrder: ['田中', '鈴木'],
    memberDiff: {},
    seatTags: { '田中': 'red' },
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'] }),
    ],
    ...overrides,
  };
}

test('seatingDeleteMember: 未確定なら従来どおり全次会・タグ・メンバー一覧から削除される', async () => {
  const env = makeWideEnv(wideData());
  const { seatingDeleteMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingDeleteMember('田中');
  assert.equal(env.store.data.seatTags['田中'], undefined);
  assert.equal(env.store.data.seatParties[0].assignment.t1[0], null);
  assert.equal(env.store.data.seatParties[1].assignment.t1[1], null);
  assert.deepEqual(env.store.data.seatParties[1].absent, []);
  assert.ok((env.store.data.memberDiff.seating.remove || []).includes('田中'));
  // 座席側と名簿側を同じトランザクション・同じ書き込みにまとめたことの確認
  // （別トランザクションに分けると部分失敗の窓ができ、read/write 回数も増えるため）。
  assert.equal(env.store.writes.length, 1, '座席と名簿を1回の書き込みにまとめる（1 read/1 write）');
});

test('seatingDeleteMember: 表示していない次会が確定中なら拒否し、確定済みの席を壊さない（Critical再現）', async () => {
  // 2次会（表示中ではない想定）を確定、1次会は未確定のまま。
  const data = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  const env = makeWideEnv(data);
  const { seatingDeleteMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingDeleteMember('田中');
  assert.equal(env.store.writes.length, 0, '確定中の次会があるなら一切書き込んではいけない');
  assert.equal(env.store.data.seatParties[1].assignment.t1[1], '田中', '確定済み2次会の座席は壊れていない');
  assert.match(env.toasts.join(''), /確定/, '拒否理由をトーストで知らせる');
});

test('seatingDeleteMember: ローカルは未確定に見えても、書き込み時に Firestore を読み直して拒否する（共同ホスト同時確定）', async () => {
  const localSnapshot = wideData(); // ローカルの写し：どちらも未確定（古い情報）
  const firestoreData = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  const env = makeWideEnv(firestoreData, localSnapshot);
  const { seatingDeleteMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingDeleteMember('田中');
  assert.equal(env.store.writes.length, 0, 'ローカルの入口ガードを通過しても、書き込み層で読み直して止めるべき');
  assert.match(env.toasts.join(''), /確定/);
});

test('seatingRenameMember: 未確定なら従来どおり全次会・タグ・メンバー一覧で改名される', async () => {
  const env = makeWideEnv(wideData());
  const { seatingRenameMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingRenameMember('田中', '田中太郎');
  assert.equal(env.store.data.seatTags['田中太郎'], 'red');
  assert.equal(env.store.data.seatTags['田中'], undefined);
  assert.equal(env.store.data.seatParties[0].assignment.t1[0], '田中太郎');
  assert.equal(env.store.data.seatParties[1].assignment.t1[1], '田中太郎');
  assert.deepEqual(env.store.data.seatParties[1].absent, ['田中太郎']);
  assert.ok((env.store.data.memberDiff.seating.remove || []).includes('田中'));
  assert.ok((env.store.data.memberDiff.seating.add || []).includes('田中太郎'));
  assert.equal(env.store.writes.length, 1, '座席と名簿を1回の書き込みにまとめる（1 read/1 write）');
});

test('seatingRenameMember: 表示していない次会が確定中なら拒否し、確定済みの座席の名前を書き換えない（Critical再現）', async () => {
  const data = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  const env = makeWideEnv(data);
  const { seatingRenameMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingRenameMember('田中', '田中太郎');
  assert.equal(env.store.writes.length, 0);
  assert.equal(env.store.data.seatParties[1].assignment.t1[1], '田中', '確定済み2次会の名前は書き換わっていない');
  assert.match(env.toasts.join(''), /確定/);
});

test('seatingRenameMember: ローカルは未確定に見えても、書き込み時に Firestore を読み直して拒否する（共同ホスト同時確定）', async () => {
  // ローカルの写し（entrance guard が見る latestEventData）：どちらも未確定（古い情報）。
  const localSnapshot = wideData();
  // Firestore 側（書き込み層 mutateSeatingWide が読み直す先）：2次会が確定済み。
  const firestoreData = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  const env = makeWideEnv(firestoreData, localSnapshot);
  const { seatingRenameMember } = loadFunctions(WIDE_NAMES, env.globals);
  // ローカルの入口ガード（anyPartyConfirmed(latestEventData)）は未確定に見えて通過するが、
  // mutateSeatingWide 内のトランザクションで Firestore を読み直し、確定中であることを
  // 発見して拒否する必要がある。誤った実装（書き込み層に anyPartyConfirmed(d) チェックが
  // 無い）なら、この書き込みは通ってしまう。
  await seatingRenameMember('田中', '田中太郎');
  assert.equal(env.store.writes.length, 0, '共同ホストが直前に確定していたら、書き込みは止まるべき');
  assert.equal(env.store.data.seatParties[1].assignment.t1[1], '田中', '確定済み2次会の名前は書き換わっていない');
  assert.match(env.toasts.join(''), /確定/, '確定中であることをユーザーに知らせる');
});

// ── 入口ガード単体の退行検出 ──
// 現状は書き込み層（mutateSeatingWide 内の anyPartyConfirmed(d) チェック）が常に効くため、
// 入口ガード（seatingDeleteMember/seatingRenameMember 冒頭の anyPartyConfirmed(data)）だけを
// isPartyConfirmed(activeParty(data)) に戻す退行が入っても、書き込み層が代わりに拒否して
// writes.length===0・トースト文言も同じになり、上の Critical再現テストでは検出できない。
// そこで書き込み層が拒否しない状況（Firestore 側は全次会未確定）を作ったうえで、
// ローカルの写し（entrance guard が見る latestEventData）だけ「表示していない次会が確定」
// にする。anyPartyConfirmed を見ていれば拒否・activeParty だけを見ていれば通過する、
// という食い違いが起きるので、入口ガード単体の退行をこのテストだけで検出できる。
test('seatingDeleteMember: 入口ガードは activeParty だけでなく anyPartyConfirmed を見る（入口ガード単体の退行検出）', async () => {
  // ローカルの写し：表示中の1次会(index 0)は未確定、表示していない2次会だけが確定。
  const localSnapshot = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  // Firestore 側は本当に全次会未確定 → 書き込み層(mutateSeatingWide)は拒否しない。
  const env = makeWideEnv(wideData(), localSnapshot);
  const { seatingDeleteMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingDeleteMember('田中');
  assert.equal(env.store.writes.length, 0,
    '表示していない次会がローカルで確定中なら、書き込み層が拒否しなくても入口で止めるべき' +
    '（isPartyConfirmed(activeParty(data)) だけを見る退行が入ると、ここが通ってしまう）');
  assert.match(env.toasts.join(''), /確定/);
});

test('seatingRenameMember: 入口ガードは activeParty だけでなく anyPartyConfirmed を見る（入口ガード単体の退行検出）', async () => {
  const localSnapshot = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  const env = makeWideEnv(wideData(), localSnapshot);
  const { seatingRenameMember } = loadFunctions(WIDE_NAMES, env.globals);
  await seatingRenameMember('田中', '田中太郎');
  assert.equal(env.store.writes.length, 0,
    '表示していない次会がローカルで確定中なら、書き込み層が拒否しなくても入口で止めるべき');
  assert.match(env.toasts.join(''), /確定/);
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

// ── seatingAddMember（Minor指摘: 削除・改名にはあるガードが追加に無かった）──
// メンバーの削除・改名は anyPartyConfirmed(data) で全次会を見てから拒否するのに、
// 追加だけ無防備だった。2次会を確定中に1次会タブで追加すると、確定済み2次会の盤面に
// 「未割当」として現れてしまう。削除・改名と同じ入口ガードを検証する。
const ADD_MEMBER_NAMES = [
  'seatingAddMember', 'mutateMemberDiff', 'updateMemberDiffEntry', 'anyPartyConfirmed', 'isPartyConfirmed', 'getParties',
  'viewMembers', 'membersForView', 'getSortedNames', 'normalizeName', 'MEMBER_VIEW_CHAIN',
  'SEATING_MEMBER_LOCK_MSG',
];

test('seatingAddMember: 未確定なら従来どおり追加できる', async () => {
  const env = makeWideEnv(wideData());
  const { seatingAddMember } = loadFunctions(ADD_MEMBER_NAMES, env.globals);
  await seatingAddMember('佐藤');
  assert.ok((env.store.data.memberDiff.seating.add || []).includes('佐藤'));
  assert.match(env.toasts.join(''), /追加しました/);
});

test('seatingAddMember: 確定中の次会があると拒否し、削除・改名と同じ文言を出す（Minor指摘の再現）', async () => {
  const data = wideData({
    seatParties: [
      P('a', '1次会', { assignment: { t1: ['田中', null] }, absent: [] }),
      P('b', '2次会', { assignment: { t1: [null, '田中'] }, absent: ['田中'], confirmed: true }),
    ],
  });
  const env = makeWideEnv(data);
  const { seatingAddMember, SEATING_MEMBER_LOCK_MSG } = loadFunctions(ADD_MEMBER_NAMES, env.globals);
  await seatingAddMember('佐藤');
  assert.equal(env.store.writes.length, 0, '確定中の次会があるなら追加も書き込んではいけない');
  assert.equal(env.store.data.memberDiff.seating, undefined);
  // Minor指摘の再現: 削除・改名専用の文言（「削除・改名はできません」）のままだと、
  // 追加しようとした人には事実と違う表示になる。文言そのものを固定して退行を検出する。
  assert.equal(env.toasts.join(''), SEATING_MEMBER_LOCK_MSG, '削除・改名と同じ定数（追加・削除・改名を含む文言）を出す');
  assert.match(SEATING_MEMBER_LOCK_MSG, /追加/, '追加しようとした人にも「追加」を含む正しい文言であること');
});
