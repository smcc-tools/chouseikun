// 次会（1次会・2次会…）の名称変更・削除の特性化テスト。
//
// これらの操作は prompt()/confirm() を挟むため、ダイアログを開いている間に
// 共同ホストが同じイベントを編集しうる。開く前に読んだ配列を丸ごと書き戻すと
// その変更が消えるため、mutateParties はトランザクションの中で読み直す。
// また対象を「添字」ではなく「id」で引く。添字のままだと、開いている間に
// 別の会が削除されたときに意図しない会を書き換えてしまうため。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

// runTransaction を差し替え、トランザクション内で見えるドキュメントを
// テスト側から自由に決められるようにする。
// afterRead を渡すと「読み取りの直後＝他ホストの書き込み」を再現できる。
function makeEnv(initialData) {
  const store = { data: initialData, writes: [] };
  const db = {};
  const doc = () => ({});
  const runTransaction = async (_db, fn) => fn({
    get: async () => ({ data: () => store.data }),
    update: (_ref, patch) => { store.writes.push(patch); store.data = { ...store.data, ...patch }; },
  });
  return { store, globals: { db, doc, runTransaction, eventId: 'ev1' } };
}

const P = (id, name, extra = {}) => ({ id, name, tables: [], assignment: null, locks: [], ...extra });

function load(env) {
  return loadFunctions(['mutateParties', 'getParties', 'isPartyConfirmed'], env.globals);
}

test('id で対象を引き当てて書き換える', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会'), P('b', '2次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('b', (ps, at) => { ps[at] = { ...ps[at], name: '二次会' }; return ps; });
  assert.equal(idx, 1);
  assert.deepEqual(env.store.data.seatParties.map(p => p.name), ['1次会', '二次会']);
});

test('対象が既に削除されていたら書き込まずに中断する', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('b', (ps, at) => { ps[at] = { ...ps[at], name: 'X' }; return ps; });
  assert.equal(idx, -1);
  assert.equal(env.store.writes.length, 0, '存在しない会に書き込んではいけない');
});

test('ダイアログ中に前の会が削除されても、添字ではなく id の会を書き換える', async () => {
  // 開いた時点では [a, b, c] で c(3次会) を対象にしていた（添字2）。
  // 開いている間に共同ホストが a を削除し、いま c は添字1にいる。
  const env = makeEnv({ seatParties: [P('b', '2次会'), P('c', '3次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('c', (ps, at) => { ps[at] = { ...ps[at], name: '打ち上げ' }; return ps; });
  assert.equal(idx, 1, '添字は読み直し後のものになる');
  assert.deepEqual(env.store.data.seatParties.map(p => p.name), ['2次会', '打ち上げ'],
    '添字2のまま書くと範囲外、添字を固定すると2次会を壊す');
});

test('ダイアログ中に入った他ホストの変更（席替え）を巻き戻さない', async () => {
  // 開いた時点の b は assignment が null。開いている間に席が決まった。
  const seated = { t1: ['田中', '佐藤'] };
  const env = makeEnv({ seatParties: [P('a', '1次会'), P('b', '2次会', { assignment: seated })] });
  const { mutateParties } = load(env);
  await mutateParties('b', (ps, at) => { ps[at] = { ...ps[at], name: '二次会' }; return ps; });
  assert.deepEqual(env.store.data.seatParties[1].assignment, seated, '席の割り当てが消えてはいけない');
});

test('apply が null を返したら書き込まない', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('a', () => null);
  assert.equal(idx, -1);
  assert.equal(env.store.writes.length, 0);
});

test('id を持たない会には一致しない（誤爆を避けて中断する）', async () => {
  const env = makeEnv({ seatParties: [{ name: '1次会' }, P('b', '2次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties(undefined, (ps, at) => { ps[at] = { ...ps[at], name: 'X' }; return ps; });
  assert.equal(idx, -1, 'id 無し同士が undefined === undefined で一致してはいけない');
  assert.equal(env.store.writes.length, 0);
});

test('seatParties が無い旧データでも既定の1次会(p1)を引ける', async () => {
  const env = makeEnv({ seatTables: [{ id: 't1', name: 'A卓', capacity: 4 }] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('p1', (ps, at) => { ps[at] = { ...ps[at], name: '懇親会' }; return ps; });
  assert.equal(idx, 0);
  assert.equal(env.store.data.seatParties[0].name, '懇親会');
  assert.deepEqual(env.store.data.seatParties[0].tables, [{ id: 't1', name: 'A卓', capacity: 4 }],
    '旧データの卓が引き継がれる');
});

test('削除：対象を消し、連番の名前だけ振り直す', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会'), P('b', '2次会'), P('c', '3次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('b', (ps, at) => {
    if (ps.length <= 1) return null;
    ps.splice(at, 1);
    ps.forEach((p, n) => { if (/^\d+次会$/.test(p.name || '')) p.name = `${n + 1}次会`; });
    return ps;
  });
  assert.equal(idx, 1);
  assert.deepEqual(env.store.data.seatParties.map(p => p.name), ['1次会', '2次会']);
});

test('削除：手で付けた名前は振り直さない', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会'), P('b', '2次会'), P('c', '打ち上げ')] });
  const { mutateParties } = load(env);
  await mutateParties('b', (ps, at) => {
    ps.splice(at, 1);
    ps.forEach((p, n) => { if (/^\d+次会$/.test(p.name || '')) p.name = `${n + 1}次会`; });
    return ps;
  });
  assert.deepEqual(env.store.data.seatParties.map(p => p.name), ['1次会', '打ち上げ']);
});

test('削除：ダイアログ中に他が消されて最後の1つになったら残す', async () => {
  const env = makeEnv({ seatParties: [P('b', '2次会')] });
  const { mutateParties } = load(env);
  const idx = await mutateParties('b', (ps, at) => {
    if (ps.length <= 1) return null;
    ps.splice(at, 1);
    return ps;
  });
  assert.equal(idx, -1);
  assert.equal(env.store.writes.length, 0, '会が0個になってはいけない');
});

test('確定中の次会は書き込まずに -2 を返す', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会', { confirmed: true })] });
  const { mutateParties } = load(env);
  const r = await mutateParties('a', (ps, at) => { ps[at] = { ...ps[at], name: 'X' }; return ps; });
  assert.equal(r, -2);
  assert.equal(env.store.writes.length, 0, '確定中に書き込んではいけない');
});

test('allowConfirmed を渡したときだけ確定中でも通る（解除に使う）', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会', { confirmed: true })] });
  const { mutateParties } = load(env);
  const r = await mutateParties('a', (ps, at) => { ps[at] = { ...ps[at], confirmed: false }; return ps; },
    { allowConfirmed: true });
  assert.equal(r, 0);
  assert.equal(env.store.data.seatParties[0].confirmed, false);
});

test('未確定の次会は allowConfirmed 無しでも通る（従来どおり）', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会')] });
  const { mutateParties } = load(env);
  const r = await mutateParties('a', (ps, at) => { ps[at] = { ...ps[at], name: '懇親会' }; return ps; });
  assert.equal(r, 0);
  assert.equal(env.store.data.seatParties[0].name, '懇親会');
});

test('確定中でも「対象が見つからない」は -1（-2 と取り違えない）', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会', { confirmed: true })] });
  const { mutateParties } = load(env);
  const r = await mutateParties('zzz', (ps, at) => ps);
  assert.equal(r, -1);
});

test('確定は他の次会に及ばない', async () => {
  const env = makeEnv({ seatParties: [P('a', '1次会', { confirmed: true }), P('b', '2次会')] });
  const { mutateParties } = load(env);
  const r = await mutateParties('b', (ps, at) => { ps[at] = { ...ps[at], name: '二次会' }; return ps; });
  assert.equal(r, 1);
  assert.equal(env.store.data.seatParties[1].name, '二次会');
});
