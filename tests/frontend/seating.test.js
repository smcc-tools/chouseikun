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
    'tableTopCount',
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

test('席替え: 同じ次会内の再シャッフルは現在の同卓ペアを避ける', () => {
  // 2人×2卓。現在 A-B / C-D の組で座っている状態から再シャッフルすると、
  // 完全回避解（A-C/A-D 系の組み替え）が存在するため毎回そちらが選ばれるはず
  const data = {
    participants: { A: {}, B: {}, C: {}, D: {} },
    participantOrder: ['A', 'B', 'C', 'D'],
    seatParties: [{
      id: 'p1', name: '1次会',
      tables: [
        { id: 't1', name: '卓1', capacity: 2, shape: 'rect' },
        { id: 't2', name: '卓2', capacity: 2, shape: 'rect' },
      ],
      assignment: { t1: ['A', 'B'], t2: ['C', 'D'] },
      locks: [], absent: [],
    }],
  };
  for (let i = 0; i < 6; i++) {
    const r = computeSeating(data);
    assert.ok(!r.error, r.error);
    const tableOf = {};
    Object.entries(r.assignment).forEach(([tid, arr]) => arr.forEach(n => { if (n) tableOf[n] = tid; }));
    assert.notEqual(tableOf.A, tableOf.B, `席替え${i}: A と B が同卓のまま`);
    assert.notEqual(tableOf.C, tableOf.D, `席替え${i}: C と D が同卓のまま`);
  }
});

// ── tableTopCount / seatNeighborPairs の split 対応（奇数定員の上下振り分け） ──

test('奇数定員: splitで上段人数が変わる（7人→上4/下3 か 上3/下4）', () => {
  const { tableTopCount } = loadFunctions(['tableTopCount']);
  assert.equal(tableTopCount({ capacity: 7 }), 4);                  // 既定は上が多い
  assert.equal(tableTopCount({ capacity: 7, split: 'top' }), 4);
  assert.equal(tableTopCount({ capacity: 7, split: 'bottom' }), 3); // 下が多い
  assert.equal(tableTopCount({ capacity: 6, split: 'bottom' }), 3); // 偶数は同数のまま
});

test('上3・下4の7人卓: 隣接・対面ペアがsplitに追従する', () => {
  assert.deepEqual(seatNeighborPairs(7, 'rect', 3), [
    [0, 1], [1, 2],           // 上段の隣
    [3, 4], [4, 5], [5, 6],   // 下段の隣
    [0, 3], [1, 4], [2, 5],   // 対面（上段3人分）
  ]);
  // topCount省略時は従来通り上が多い分割
  assert.deepEqual(seatNeighborPairs(5, 'rect'), seatNeighborPairs(5, 'rect', 3));
});

// ── flipTableRowsPatch（上下振り分け変更時の行入れ替え） ──

test('split変更: 配置済みの行を並びそのまま上下入れ替える（7人 上4下3→上3下4）', () => {
  const { flipTableRowsPatch } = loadFunctions(['flipTableRowsPatch']);
  const party = {
    assignment: { t1: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], t2: ['X'] },
    locks: ['t1:0', 't1:5', 't2:0'],
  };
  const r = flipTableRowsPatch(party, 't1', 4); // 旧上段4人(A-D)
  // 旧下段(E,F,G)が新上段に、旧上段(A,B,C,D)が新下段に。各行の並びは維持
  assert.deepEqual(r.assignment.t1, ['E', 'F', 'G', 'A', 'B', 'C', 'D']);
  assert.deepEqual(r.assignment.t2, ['X']); // 他卓は不変
  // ロックは同じ人に追従: A(旧0)→新3、F(旧5)→新1。他卓のロックは不変
  assert.deepEqual(r.locks.sort(), ['t1:1', 't1:3', 't2:0'].sort());
});

test('split変更: 配置が無い卓は null（何もしない）', () => {
  const { flipTableRowsPatch } = loadFunctions(['flipTableRowsPatch']);
  assert.equal(flipTableRowsPatch({ assignment: {} }, 't1', 4), null);
  assert.equal(flipTableRowsPatch({}, 't1', 4), null);
});

// ── normalizeTableSlots（卓のグリッド位置の正規化） ──

test('卓slot: 未設定なら卓順に詰め、列数の倍数まで空き(null)で埋める', () => {
  const { normalizeTableSlots } = loadFunctions(['normalizeTableSlots']);
  const t1 = { id: 't1' }, t2 = { id: 't2' }, t3 = { id: 't3' };
  assert.deepEqual(normalizeTableSlots([t1, t2, t3], 2), [t1, t2, t3, null]);
  assert.deepEqual(normalizeTableSlots([t1, t2], 1), [t1, t2]);
  assert.deepEqual(normalizeTableSlots([], 2), []);
});

test('卓slot: 割り切れない卓数では明示slotの空きマス位置を保持する', () => {
  const { normalizeTableSlots } = loadFunctions(['normalizeTableSlots']);
  const a = { id: 'a', slot: 3 }, b = { id: 'b', slot: 0 }, c = { id: 'c', slot: 1 };
  assert.deepEqual(normalizeTableSlots([a, b, c], 2), [b, c, null, a]); // 左下が空き
});

test('卓slot: 卓数が列数で割り切れる場合は空きマスを作らず詰める', () => {
  const { normalizeTableSlots } = loadFunctions(['normalizeTableSlots']);
  const a = { id: 'a', slot: 3 }, b = { id: 'b', slot: 0 };
  assert.deepEqual(normalizeTableSlots([a, b], 2), [b, a]);        // 2卓×2列：隙間があっても詰める
  const d = { id: 'd', slot: 5 };
  assert.deepEqual(normalizeTableSlots([a, b, d], 3), [b, a, d]);  // 3卓×3列も同様
});

test('卓slot: 重複・不正slotの卓は空きスロットへ順に退避する', () => {
  const { normalizeTableSlots } = loadFunctions(['normalizeTableSlots']);
  const a = { id: 'a', slot: 1 }, b = { id: 'b', slot: 1 }, c = { id: 'c', slot: -5 };
  const r = normalizeTableSlots([a, b, c], 2);
  assert.deepEqual(r, [b, a, c, null]); // aがslot1を確保、b・cは0,2へ
});

// ── noHonorificsInNames（敬称略の断り書き判定） ──

test('敬称略: 全員敬称なしなら true、1人でも敬称付きがいれば false', () => {
  const { noHonorificsInNames } = loadFunctions(['noHonorificsInNames']);
  assert.equal(noHonorificsInNames(['太郎', '花子', '次郎']), true);
  assert.equal(noHonorificsInNames(['太郎さん', '花子', '次郎']), false);
  assert.equal(noHonorificsInNames(['太郎', '花子ちゃん']), false);
  assert.equal(noHonorificsInNames(['田中様', '佐藤くん']), false);
  assert.equal(noHonorificsInNames(['山田先生']), false);
});

test('敬称略: 空・空白のみの名簿では表示しない(false)', () => {
  const { noHonorificsInNames } = loadFunctions(['noHonorificsInNames']);
  assert.equal(noHonorificsInNames([]), false);
  assert.equal(noHonorificsInNames(null), false);
  assert.equal(noHonorificsInNames(['', '  ']), false);
});

test('席替え履歴: 直前の配置を先頭に追加し直近2件まで保持', () => {
  const { buildAssignmentHistory } = loadFunctions(['buildAssignmentHistory']);
  const a1 = { t1: ['A'] }, a2 = { t1: ['B'] }, a3 = { t1: ['C'] };
  assert.deepEqual(buildAssignmentHistory(a1, []), [a1]);
  assert.deepEqual(buildAssignmentHistory(a2, [a1]), [a2, a1]);
  assert.deepEqual(buildAssignmentHistory(a3, [a2, a1]), [a3, a2]); // 3件目は捨てる
  assert.deepEqual(buildAssignmentHistory(null, [a1]), [a1]);       // 初回(配置なし)は履歴不変
});

test('席替え履歴: 2次会は1次会の現在配置と履歴(前回の席)の両方を避ける', () => {
  // 1次会: 現在 A-C/B-D、履歴に A-B/C-D。2次会で両方避けると A-D/B-C しか残らない
  const data = {
    participants: { A: {}, B: {}, C: {}, D: {} },
    participantOrder: ['A', 'B', 'C', 'D'],
    seatParties: [
      {
        id: 'p1', name: '1次会',
        tables: [
          { id: 't1', name: '卓1', capacity: 2, shape: 'rect' },
          { id: 't2', name: '卓2', capacity: 2, shape: 'rect' },
        ],
        assignment: { t1: ['A', 'C'], t2: ['B', 'D'] },
        assignmentHistory: [{ t1: ['A', 'B'], t2: ['C', 'D'] }],
        locks: [], absent: [],
      },
      {
        id: 'p2', name: '2次会',
        tables: [
          { id: 'u1', name: '卓1', capacity: 2, shape: 'rect' },
          { id: 'u2', name: '卓2', capacity: 2, shape: 'rect' },
        ],
        assignment: null, locks: [], absent: [],
      },
    ],
  };
  const { computeSeating: cs } = loadFunctions(
    ['SEAT_TAG_COLORS', 'seatColorOf', 'pairKey', 'spreadByColor', 'tableTopCount', 'seatNeighborPairs',
     'arrangeTableSeats', 'getParties', 'clampActiveIdx', 'roundMembers', 'getSortedNames',
     'normalizeAssignment', 'buildAvoidance', 'computeSeating'],
    { seatingActiveParty: 1 } // 2次会をアクティブに
  );
  for (let i = 0; i < 4; i++) {
    const r = cs(data);
    assert.ok(!r.error, r.error);
    const tableOf = {};
    Object.entries(r.assignment).forEach(([tid, arr]) => arr.forEach(n => { if (n) tableOf[n] = tid; }));
    assert.equal(tableOf.A, tableOf.D, `2次会${i}: 残された唯一の組合せ A-D にならない`);
    assert.equal(tableOf.B, tableOf.C, `2次会${i}: 残された唯一の組合せ B-C にならない`);
  }
});
