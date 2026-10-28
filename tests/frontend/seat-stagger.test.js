// 奇数定員の長机の「互い違い」配置（少ない側の席を向かい側の席と席の間に置く）。
// 向かい合いの組が変わるので、席替え（同じ色・前回と同じ相手を避ける）もこの組で判定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { seatNeighborPairs, isStaggered } = loadFunctions(['seatNeighborPairs', 'isStaggered']);
const sortPairs = ps => ps.map(([a, b]) => (a < b ? [a, b] : [b, a])).sort((x, y) => x[0] - y[0] || x[1] - y[1]);

test('互い違い・上3下2：下の席は上の2席の間（斜めの2人と向かい合う）', () => {
  // 上段 0,1,2 / 下段 3,4（3 は 0と1の間、4 は 1と2の間）
  assert.deepEqual(sortPairs(seatNeighborPairs(5, 'rect', 3, true)), sortPairs([
    [0, 1], [1, 2], [3, 4],
    [0, 3], [1, 3], [1, 4], [2, 4],
  ]));
});

test('互い違い・上2下3：上の席は下の2席の間', () => {
  // 上段 0,1 / 下段 2,3,4（0 は 2と3の間、1 は 3と4の間）
  assert.deepEqual(sortPairs(seatNeighborPairs(5, 'rect', 2, true)), sortPairs([
    [0, 1], [2, 3], [3, 4],
    [0, 2], [0, 3], [1, 3], [1, 4],
  ]));
});

test('互い違いでないときは今までどおり（真向かいだけ）', () => {
  assert.deepEqual(sortPairs(seatNeighborPairs(5, 'rect', 3, false)), sortPairs([[0, 1], [1, 2], [3, 4], [0, 3], [1, 4]]));
  assert.deepEqual(sortPairs(seatNeighborPairs(5, 'rect', 3)), sortPairs([[0, 1], [1, 2], [3, 4], [0, 3], [1, 4]]));
});

test('互い違いにできるのは奇数定員の長机だけ（偶数・円卓・1席は今までどおり）', () => {
  assert.equal(isStaggered({ capacity: 5, stagger: true }), true);
  assert.equal(isStaggered({ capacity: 7, shape: 'rect', stagger: true, split: 'bottom' }), true);
  assert.equal(isStaggered({ capacity: 6, stagger: true }), false);
  assert.equal(isStaggered({ capacity: 5, shape: 'round', stagger: true }), false);
  assert.equal(isStaggered({ capacity: 1, stagger: true }), false);
  assert.equal(isStaggered({ capacity: 5 }), false);
  // 偶数の卓で stagger が残っていても、向かい合いは真向かいのまま
  assert.deepEqual(sortPairs(seatNeighborPairs(6, 'rect', 3, isStaggered({ capacity: 6, stagger: true }))),
    sortPairs([[0, 1], [1, 2], [3, 4], [4, 5], [0, 3], [1, 4], [2, 5]]));
});

test('席替え：互い違いの卓では、斜め向かいにも同じ色の人を座らせない', () => {
  const { computeSeating } = loadFunctions(
    ['SEAT_TAG_COLORS', 'seatColorOf', 'pairKey', 'spreadByColor', 'isStaggered', 'tableTopCount', 'seatNeighborPairs',
     'W_SAME_COLOR', 'W_PREV_ADJACENT', 'arrangeTableSeats', 'getParties', 'clampActiveIdx', 'roundMembers', 'getSortedNames',
     'membersForView', 'viewMembers', 'normalizeName', 'MEMBER_VIEW_CHAIN', 'normalizeAssignment', 'buildAvoidance', 'computeSeating'],
    { seatingActiveParty: 0 });
  const names = ['A', 'B', 'C', 'D', 'E'];
  const data = {
    participants: Object.fromEntries(names.map(n => [n, {}])), participantOrder: names, seatTags: { A: 'c0', B: 'c0' },
    seatParties: [{ id: 'p', name: '1次会', tables: [{ id: 't', name: '卓', capacity: 5, shape: 'rect', stagger: true }], assignment: null, locks: [], absent: [] }],
  };
  const pairs = seatNeighborPairs(5, 'rect', 3, true);
  for (let i = 0; i < 40; i++) {
    const r = computeSeating(data);
    assert.ok(!r.error, r.error);
    const arr = r.assignment.t;
    for (const [a, b] of pairs) assert.ok(!(['A', 'B'].includes(arr[a]) && ['A', 'B'].includes(arr[b])), `同じ色が隣・向かいに来た: ${arr}`);
  }
});
