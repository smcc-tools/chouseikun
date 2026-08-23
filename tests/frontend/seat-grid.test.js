// 「卓の並び（縦○行 × 横○列）」の特性化テスト。
//
// 実際に踏んだ不具合が2つある。
//  ① 列だけを変えたとき、行セレクタには「前の列数で自動計算された行数」が
//     表示されたままで、それがホストの指定として保存されていた。
//     4卓・1列（行は自動で4）から列を2にすると 4行×2列＝8マスになり、
//     卓を1つも増やしていないのに空きマスが4つ出る。
//  ② 保存された行数は seatGridRows の Math.max(need, r) で盤面を広げる方向
//     にしか効かないため、卓を減らしても盤面が大きいまま残る。
//
// 配置を調整した次会（freeLayout）はホストが意図して空けた配置なので、
// 盤面を勝手に詰めない。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { gridSelectionPatch, shrinkGridPatch, seatGridRows } =
  loadFunctions(['gridSelectionPatch', 'shrinkGridPatch', 'seatGridRows', 'normalizeTableSlots'],
    { SEAT_GRID_MAX: 6 });

const TBL = (id, slot) => (slot === undefined ? { id } : { id, slot });

// ── ① 卓の並びの選択 ──

test('列だけを変えたとき、行は新しい列数に合わせて導き直す', () => {
  // 4卓・1列（行セレクタは自動計算の4を表示）から列を2へ
  const p = { tableCols: 1 };
  assert.deepEqual(gridSelectionPatch(p, 4, 'cols', 4, 2), { tableRows: 2, tableCols: 2 });
});

test('列を変えても卓が全部入る（空きマスが出ない）', () => {
  const p = { tableCols: 1 };
  const patch = gridSelectionPatch(p, 4, 'cols', 4, 2);
  assert.equal(patch.tableRows * patch.tableCols, 4, '4卓ちょうどに収まる');
});

test('行を自分で選んだあとは、その行数を保つ', () => {
  // 一度 4行 を明示した次会で列を3に変えても、行は4のまま（ホストの指定）
  const p = { tableRows: 4, tableCols: 2 };
  assert.deepEqual(gridSelectionPatch(p, 4, 'cols', 4, 3), { tableRows: 4, tableCols: 3 });
});

test('行を変えたときは、その値をそのまま採用する（広い盤面を意図的に作れる）', () => {
  const p = { tableCols: 2 };
  assert.deepEqual(gridSelectionPatch(p, 4, 'rows', 4, 2), { tableRows: 4, tableCols: 2 });
});

test('卓が割り切れない数なら、行は切り上げる', () => {
  const p = { tableCols: 1 };
  assert.deepEqual(gridSelectionPatch(p, 5, 'cols', 5, 2), { tableRows: 3, tableCols: 2 });
});

test('上限(6)を超える値は丸める', () => {
  const p = {};
  assert.deepEqual(gridSelectionPatch(p, 4, 'rows', 99, 99), { tableRows: 6, tableCols: 6 });
});

test('卓が0でも行・列は1以上になる', () => {
  const p = { tableCols: 1 };
  assert.deepEqual(gridSelectionPatch(p, 0, 'cols', 1, 2), { tableRows: 1, tableCols: 2 });
});

// ── ② 卓を減らしたときに盤面を詰める ──
//
// freeLayout（卓を1回でも動かすと立つ）を除外していたら、実際にはほとんどの
// 次会が対象外になり、卓を減らしても盤面が縮まなかった。
// 「卓と卓の間に空けた隙間」は配置なので残し、「後ろに余った空の行」だけ落とす。

test('卓を減らしたら、盤面の行数も必要な数まで詰める', () => {
  assert.deepEqual(shrinkGridPatch({ tableRows: 2, tableCols: 2 }, [TBL('a'), TBL('b')]), { tableRows: 1 });
});

test('必要な行数と同じなら書き込まない', () => {
  assert.equal(shrinkGridPatch({ tableRows: 2, tableCols: 2 }, [TBL('a'), TBL('b'), TBL('c'), TBL('d')]), null);
});

test('必要な行数より小さければ書き込まない（seatGridRows が広げる）', () => {
  assert.equal(shrinkGridPatch({ tableRows: 1, tableCols: 2 }, [TBL('a'), TBL('b'), TBL('c'), TBL('d')]), null);
});

test('行数が未設定の次会は触らない', () => {
  assert.equal(shrinkGridPatch({ tableCols: 2 }, [TBL('a'), TBL('b')]), null);
});

test('配置を調整した次会でも、後ろに余った空の行は落とす', () => {
  // 報告された状態：卓1つが右上(slot 1)に居るのに 3行×2列＝6マスのまま
  const patch = shrinkGridPatch(
    { tableRows: 3, tableCols: 2, freeLayout: true }, [TBL('t2', 1)]);
  assert.deepEqual(patch, { tableRows: 1 }, '5つあった空きが1つ（卓の左）まで減る');
});

test('配置を調整した次会でも、卓と卓の間の隙間は残す', () => {
  // slot 0 と slot 3 に卓。間の 1・2 は意図して空けた配置なので保つ（2行必要）
  const patch = shrinkGridPatch(
    { tableRows: 4, tableCols: 2, freeLayout: true }, [TBL('a', 0), TBL('b', 3)]);
  assert.deepEqual(patch, { tableRows: 2 }, '4行→2行。間の隙間は残る');
});

test('卓が0になっても行は1を下回らない', () => {
  assert.deepEqual(shrinkGridPatch({ tableRows: 4, tableCols: 2 }, []), { tableRows: 1 });
});

test('卓が1つだけなら1行に収まる', () => {
  assert.deepEqual(shrinkGridPatch({ tableRows: 3, tableCols: 1 }, [TBL('a')]), { tableRows: 1 });
});

// ── ①②を通した結合 ──

test('報告された手順：4卓で列を2にし、2卓へ減らしても空きマスが出ない', () => {
  let party = { tableCols: 1 };
  Object.assign(party, gridSelectionPatch(party, 4, 'cols', 4, 2));
  assert.equal(seatGridRows(party, 4, party.tableCols) * party.tableCols, 4, '4卓の時点で空き0');
  Object.assign(party, shrinkGridPatch(party, [TBL('a'), TBL('b')]) || {});
  assert.equal(seatGridRows(party, 2, party.tableCols) * party.tableCols, 2, '2卓に減らしても空き0');
});
