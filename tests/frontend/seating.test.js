// 座席決めロジックの特性化テスト。
// 乱数を使う関数（arrangeTableSeats / computeSeating）は「必ず成り立つ不変条件」を検証する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const {
  seatNeighborPairs,
  normalizeAssignment,
  arrangeTableSeats,
  computeSeating,
} = loadFunctions(
  [
    'SEAT_TAG_COLORS',
    'seatColorOf',
    'pairKey',
    'spreadByColor',
    'seatNeighborPairs',
    'arrangeTableSeats',
    'getParties',
    'clampActiveIdx',
    'roundMembers',
    'getSortedNames',
    'normalizeAssignment',
    'buildAvoidance',
    'computeSeating',
  ],
  { seatingActiveParty: 0 } // index.html のモジュールスコープ変数を注入
);

// ── seatNeighborPairs ──

test('円卓は円周でつながる（4席: 0-1-2-3-0）', () => {
  assert.deepEqual(seatNeighborPairs(4, 'round'), [[0, 1], [1, 2], [2, 3], [3, 0]]);
});

test('長机6席は左右の隣＋対面がペアになる', () => {
  // 上段 0,1,2 / 下段 3,4,5
  assert.deepEqual(seatNeighborPairs(6, 'rect'), [
    [0, 1], [1, 2],       // 上段の隣
    [3, 4], [4, 5],       // 下段の隣
    [0, 3], [1, 4], [2, 5], // 対面
  ]);
});

test('長机の奇数席（5席）は上段3・下段2で対面は2組', () => {
  assert.deepEqual(seatNeighborPairs(5, 'rect'), [
    [0, 1], [1, 2],
    [3, 4],
    [0, 3], [1, 4],
  ]);
});

test('席が1以下ならペアなし。shape未指定は長机扱い', () => {
  assert.deepEqual(seatNeighborPairs(0, 'round'), []);
  assert.deepEqual(seatNeighborPairs(1, 'rect'), []);
  assert.deepEqual(seatNeighborPairs(4, undefined), seatNeighborPairs(4, 'rect'));
});

// ── normalizeAssignment ──

test('割当は定員長に正規化される（不足はnull埋め・超過は切り捨て）', () => {
  const tables = [{ id: 't1', capacity: 3 }];
  const members = ['A', 'B', 'C', 'D'];
  assert.deepEqual(
    normalizeAssignment(tables, { t1: ['A'] }, members),
    { t1: ['A', null, null] }
  );
  assert.deepEqual(
    normalizeAssignment(tables, { t1: ['A', 'B', 'C', 'D'] }, members),
    { t1: ['A', 'B', 'C'] }
  );
});

test('メンバーから外れた人（欠席・削除）は割当から消える', () => {
  const tables = [{ id: 't1', capacity: 2 }];
  assert.deepEqual(
    normalizeAssignment(tables, { t1: ['A', 'B'] }, ['A']),
    { t1: ['A', null] }
  );
});

test('割当データがない卓は全席nullになる', () => {
  const tables = [{ id: 't1', capacity: 2 }, { id: 't2', capacity: 1 }];
  assert.deepEqual(
    normalizeAssignment(tables, {}, ['A']),
    { t1: [null, null], t2: [null] }
  );
});

// ── arrangeTableSeats ──

test('全員が着席し、残りは空席(null)になる', () => {
  const arr = arrangeTableSeats(5, 'rect', {}, ['A', 'B', 'C'], () => null, null);
  assert.equal(arr.length, 5);
  assert.deepEqual([...arr.filter(Boolean)].sort(), ['A', 'B', 'C']);
  assert.equal(arr.filter(x => x === null).length, 2);
});

test('ロックされた席は必ず維持される', () => {
  const arr = arrangeTableSeats(4, 'round', { 2: 'X' }, ['A', 'B', 'C'], () => null, null);
  assert.equal(arr[2], 'X');
  assert.deepEqual([...arr].sort(), ['A', 'B', 'C', 'X']);
});

test('2色2人ずつの円卓4席では同色が隣り合わない配置が選ばれる', () => {
  const color = n => ({ A: 'red', B: 'blue', C: 'red', D: 'blue' }[n]);
  const arr = arrangeTableSeats(4, 'round', {}, ['A', 'B', 'C', 'D'], color, null);
  for (const [i, j] of seatNeighborPairs(4, 'round')) {
    assert.notEqual(color(arr[i]), color(arr[j]), `席${i}と席${j}が同色: ${arr[i]}, ${arr[j]}`);
  }
});

// ── computeSeating ──

const baseData = (over = {}) => ({
  participants: { A: {}, B: {}, C: {}, D: {} },
  participantOrder: ['A', 'B', 'C', 'D'],
  seatParties: [{
    id: 'p1', name: '1次会',
    tables: [{ id: 't1', name: '卓1', capacity: 2, shape: 'rect' }, { id: 't2', name: '卓2', capacity: 3, shape: 'round' }],
    assignment: null, locks: [], absent: [],
  }],
  ...over,
});

test('卓がなければエラーを返す', () => {
  const data = baseData();
  data.seatParties[0].tables = [];
  const r = computeSeating(data);
  assert.match(r.error, /卓がありません/);
});

test('参加者がいなければエラーを返す', () => {
  const data = baseData({ participants: {}, participantOrder: [] });
  const r = computeSeating(data);
  assert.match(r.error, /参加者がいません/);
});

test('定員合計が参加者数より少なければ不足を伝えるエラー', () => {
  const data = baseData();
  data.seatParties[0].tables = [{ id: 't1', name: '卓1', capacity: 3 }];
  const r = computeSeating(data);
  assert.match(r.error, /定員の合計（3）が参加者数（4）より少ない/);
});

test('正常系: 全員がちょうど1回ずつ着席し、定員を超えない', () => {
  const r = computeSeating(baseData());
  assert.ok(!r.error, r.error);
  const seated = Object.values(r.assignment).flat().filter(Boolean);
  assert.deepEqual([...seated].sort(), ['A', 'B', 'C', 'D']);
  assert.equal(r.assignment.t1.length, 2);
  assert.equal(r.assignment.t2.length, 3);
});

test('席ロック(🔒)した人は同じ卓・同じ席に残る', () => {
  const data = baseData();
  data.seatParties[0].assignment = { t1: ['A', 'B'], t2: ['C', 'D', null] };
  data.seatParties[0].locks = ['t1:0'];
  for (let i = 0; i < 5; i++) { // 乱数を挟むので複数回検証
    const r = computeSeating(data);
    assert.ok(!r.error, r.error);
    assert.equal(r.assignment.t1[0], 'A');
  }
});

test('欠席者(absent)は着席しない', () => {
  const data = baseData();
  data.seatParties[0].absent = ['D'];
  const r = computeSeating(data);
  assert.ok(!r.error, r.error);
  const seated = Object.values(r.assignment).flat().filter(Boolean);
  assert.deepEqual([...seated].sort(), ['A', 'B', 'C']);
});
