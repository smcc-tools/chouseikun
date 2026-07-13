// 立替・割り勘（Walica式）の精算ロジックの特性化テスト。
// お金の計算はバグが直接ユーザーの損得になるため、端数・相殺・不正入力を重点的に固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { computeWalicaSettlement } = loadFunctions(['computeWalicaSettlement']);

// 送金リストから各人の最終収支を再計算するヘルパ（保存性チェック用）
function balancesAfter(expenses, txns) {
  const bal = {};
  const add = (n, v) => { bal[n] = (bal[n] || 0) + v; };
  for (const e of expenses) {
    const amt = Math.round(e.amount) || 0;
    const shares = (e.sharedWith || []).filter(Boolean);
    if (amt <= 0 || shares.length === 0) continue;
    add(e.payer, amt);
    const base = Math.floor(amt / shares.length);
    let rem = amt - base * shares.length;
    shares.forEach(n => { add(n, -(base + (rem > 0 ? 1 : 0))); if (rem > 0) rem--; });
  }
  for (const t of txns) { add(t.from, t.amount); add(t.to, -t.amount); }
  return bal;
}

test('立替なしなら送金なし', () => {
  assert.deepEqual(computeWalicaSettlement([]), []);
  assert.deepEqual(computeWalicaSettlement(undefined), []);
});

test('1件・割り切れる場合: 各人が均等額を払い、送金は参加者数-1 回以下', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 3000, sharedWith: ['A', 'B', 'C'] },
  ]);
  assert.equal(txns.length, 2);
  for (const t of txns) {
    assert.equal(t.to, 'A');
    assert.equal(t.amount, 1000);
  }
  assert.deepEqual(new Set(txns.map(t => t.from)), new Set(['B', 'C']));
});

test('端数は先頭メンバーから1円ずつ負担する（1001円を3人）', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 1001, sharedWith: ['A', 'B', 'C'] },
  ]);
  // A=334, B=334, C=333 の負担。A は 1001 立替済みなので B:334, C:333 を受け取る
  const byFrom = Object.fromEntries(txns.map(t => [t.from, t.amount]));
  assert.deepEqual(byFrom, { B: 334, C: 333 });
});

test('支払者が割り勘対象に入っていない場合は全額回収する', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 2000, sharedWith: ['B', 'C'] },
  ]);
  const total = txns.reduce((s, t) => s + t.amount, 0);
  assert.equal(total, 2000);
  assert.ok(txns.every(t => t.to === 'A'));
});

test('相互の立替は相殺され、差額のみ送金される', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 1000, sharedWith: ['A', 'B'] }, // B は A に 500 借り
    { payer: 'B', amount: 600, sharedWith: ['A', 'B'] },  // A は B に 300 借り
  ]);
  assert.deepEqual(txns, [{ from: 'B', to: 'A', amount: 200 }]);
});

test('完全に相殺されるケースでは送金ゼロ', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 1000, sharedWith: ['A', 'B'] },
    { payer: 'B', amount: 1000, sharedWith: ['A', 'B'] },
  ]);
  assert.deepEqual(txns, []);
});

test('金額0以下・対象者なしの立替は無視される', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 0, sharedWith: ['A', 'B'] },
    { payer: 'A', amount: -500, sharedWith: ['A', 'B'] },
    { payer: 'A', amount: 1000, sharedWith: [] },
    { payer: 'A', amount: 1000, sharedWith: [null, ''] },
  ]);
  assert.deepEqual(txns, []);
});

test('小数の金額は四捨五入して精算する', () => {
  const txns = computeWalicaSettlement([
    { payer: 'A', amount: 999.5, sharedWith: ['A', 'B'] }, // 1000 として扱う
  ]);
  assert.deepEqual(txns, [{ from: 'B', to: 'A', amount: 500 }]);
});

test('複数立替の複雑ケース: 精算後の全員の収支がゼロになる（保存性）', () => {
  const expenses = [
    { payer: 'A', amount: 12345, sharedWith: ['A', 'B', 'C', 'D'] },
    { payer: 'B', amount: 6789, sharedWith: ['B', 'C'] },
    { payer: 'C', amount: 1001, sharedWith: ['A', 'D'] },
    { payer: 'D', amount: 4444, sharedWith: ['A', 'B', 'C', 'D'] },
  ];
  const txns = computeWalicaSettlement(expenses);
  const bal = balancesAfter(expenses, txns);
  for (const [name, v] of Object.entries(bal)) {
    assert.equal(v, 0, `${name} の収支が精算後もゼロでない: ${v}`);
  }
  // 送金額は必ず正
  assert.ok(txns.every(t => t.amount > 0));
});

test('送金回数は最大でも人数-1 回（貪欲法の性質）', () => {
  const expenses = [
    { payer: 'A', amount: 5000, sharedWith: ['A', 'B', 'C', 'D', 'E'] },
    { payer: 'B', amount: 3000, sharedWith: ['A', 'B', 'C', 'D', 'E'] },
  ];
  const txns = computeWalicaSettlement(expenses);
  assert.ok(txns.length <= 4, `送金 ${txns.length} 回は多すぎる`);
});
