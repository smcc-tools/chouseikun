// 画面ごとのメンバー差分（membersForView / updateMemberDiffEntry）の特性化テスト。
// 仕様：前のナビ（日程→座席→割り勘→精算）での追加・削除は後続に伝わるが、
//       後ろのナビでの変更は前のナビには戻らない。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { membersForView, updateMemberDiffEntry, MEMBER_VIEW_CHAIN } =
  loadFunctions(['MEMBER_VIEW_CHAIN', 'normalizeName', 'membersForView', 'updateMemberDiffEntry']);

const BASE = ['田中', '佐藤', '鈴木'];

test('チェーンはホストナビの並び順（日程→座席→割り勘→精算）', () => {
  assert.deepEqual(MEMBER_VIEW_CHAIN, ['schedule', 'seating', 'walica', 'settle']);
});

test('差分が無ければ全画面で日程の参加者と同じ', () => {
  for (const v of MEMBER_VIEW_CHAIN) {
    assert.deepEqual(membersForView(BASE, {}, v), BASE, `${v} が土台と違う`);
  }
});

test('座席で追加した人は割り勘・精算に出るが、日程には出ない', () => {
  const diff = { seating: { add: ['山田'], remove: [] } };
  assert.deepEqual(membersForView(BASE, diff, 'schedule'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'seating'), [...BASE, '山田']);
  assert.deepEqual(membersForView(BASE, diff, 'walica'), [...BASE, '山田']);
  assert.deepEqual(membersForView(BASE, diff, 'settle'), [...BASE, '山田']);
});

test('座席で削除した人は割り勘・精算からも消えるが、日程には残る', () => {
  const diff = { seating: { add: [], remove: ['佐藤'] } };
  assert.deepEqual(membersForView(BASE, diff, 'schedule'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'seating'), ['田中', '鈴木']);
  assert.deepEqual(membersForView(BASE, diff, 'settle'), ['田中', '鈴木']);
});

test('精算で削除しても、日程・座席・割り勘には残る', () => {
  const diff = { settle: { add: [], remove: ['鈴木'] } };
  assert.deepEqual(membersForView(BASE, diff, 'schedule'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'seating'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'walica'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'settle'), ['田中', '佐藤']);
});

test('割り勘で追加した人は精算に出るが、座席・日程には出ない', () => {
  const diff = { walica: { add: ['高橋'], remove: [] } };
  assert.deepEqual(membersForView(BASE, diff, 'seating'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'walica'), [...BASE, '高橋']);
  assert.deepEqual(membersForView(BASE, diff, 'settle'), [...BASE, '高橋']);
});

test('日程に後から足した人は、下流が触っていなければ全画面に出る', () => {
  const diff = { settle: { add: [], remove: ['鈴木'] } };
  const base2 = [...BASE, '新人'];
  assert.deepEqual(membersForView(base2, diff, 'seating'), base2);
  assert.deepEqual(membersForView(base2, diff, 'settle'), ['田中', '佐藤', '新人']);
});

test('複数画面の差分は順に重なる', () => {
  const diff = {
    seating: { add: ['山田'], remove: ['佐藤'] },
    walica:  { add: ['高橋'], remove: ['山田'] },   // 座席で足した人を割り勘で外す
    settle:  { add: [], remove: ['田中'] },
  };
  assert.deepEqual(membersForView(BASE, diff, 'schedule'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'seating'), ['田中', '鈴木', '山田']);
  assert.deepEqual(membersForView(BASE, diff, 'walica'), ['田中', '鈴木', '高橋']);
  assert.deepEqual(membersForView(BASE, diff, 'settle'), ['鈴木', '高橋']);
});

test('チェーンに無い画面（お店・お知らせ）は土台をそのまま返す', () => {
  const diff = { seating: { add: ['山田'], remove: ['佐藤'] } };
  assert.deepEqual(membersForView(BASE, diff, 'announce'), BASE);
  assert.deepEqual(membersForView(BASE, diff, 'gourmet'), BASE);
});

test('差分が壊れていても落ちない（null・欠けたキー）', () => {
  assert.deepEqual(membersForView(BASE, null, 'settle'), BASE);
  assert.deepEqual(membersForView(BASE, { settle: {} }, 'settle'), BASE);
  assert.deepEqual(membersForView(null, {}, 'settle'), []);
});

test('同名の重複追加はしない（表記ゆれも同一視）', () => {
  const diff = { seating: { add: ['田中', 'たなか'], remove: [] } };
  const r = membersForView(['田中'], diff, 'seating');
  assert.equal(r.filter(n => n === '田中').length, 1);
});

// ── updateMemberDiffEntry ──

test('この画面で足した人の削除は、remove に積まず add から取り消す', () => {
  const e1 = updateMemberDiffEntry(undefined, 'add', '山田');
  assert.deepEqual(e1, { add: ['山田'], remove: [] });
  const e2 = updateMemberDiffEntry(e1, 'remove', '山田');
  assert.deepEqual(e2, { add: [], remove: [] }, '前の画面の人を消したことになってはいけない');
});

test('前の画面から来た人の削除は remove に積む', () => {
  const e = updateMemberDiffEntry({ add: [], remove: [] }, 'remove', '佐藤');
  assert.deepEqual(e, { add: [], remove: ['佐藤'] });
});

test('一度消した人を足し直すと remove から外れる（addには積まない）', () => {
  const e1 = updateMemberDiffEntry({ add: [], remove: ['佐藤'] }, 'add', '佐藤');
  assert.deepEqual(e1, { add: [], remove: [] });
  assert.deepEqual(membersForView(BASE, { seating: e1 }, 'seating'), BASE);
});

test('同じ操作を繰り返しても差分は増えない', () => {
  let e = { add: [], remove: [] };
  for (let i = 0; i < 3; i++) e = updateMemberDiffEntry(e, 'remove', '佐藤');
  assert.deepEqual(e, { add: [], remove: ['佐藤'] });
  for (let i = 0; i < 3; i++) e = updateMemberDiffEntry(e, 'add', '山田');
  assert.deepEqual(e, { add: ['山田'], remove: ['佐藤'] }); // 先に消した佐藤はそのまま残る
});

test('元の差分オブジェクトを書き換えない（純粋関数）', () => {
  const orig = { add: ['山田'], remove: ['佐藤'] };
  const copy = JSON.parse(JSON.stringify(orig));
  updateMemberDiffEntry(orig, 'add', '高橋');
  updateMemberDiffEntry(orig, 'remove', '鈴木');
  assert.deepEqual(orig, copy);
});

test('改名は「元の名前を削除＋新しい名前を追加」として記録される', () => {
  let e = updateMemberDiffEntry({ add: [], remove: [] }, 'remove', '佐藤');
  e = updateMemberDiffEntry(e, 'add', '佐藤さん');
  assert.deepEqual(membersForView(BASE, { settle: e }, 'settle'), ['田中', '鈴木', '佐藤さん']);
  assert.deepEqual(membersForView(BASE, { settle: e }, 'walica'), BASE, '改名が前のナビに戻ってはいけない');
});
