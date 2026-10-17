// 作成イベントのドキュメント組み立て（buildEventDoc）の特性化テスト。
// ログイン後の自動継続でも同じ結果になるよう、DOM・認証に非依存な純粋関数であることを担保する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { buildEventDoc } = loadFunctions(['buildEventDoc', 'normalizeTheme']);

// ID生成は決定的なスタブにして比較可能にする
let _n = 0;
const ridStub = () => `id${++_n}`;
const ctx = (over = {}) => ({ uid: 'u1', now: 1000, rid: ridStub, ...over });

test('schedule: 事前参加者は全候補日を未回答(空文字)で初期化', () => {
  const doc = buildEventDoc('schedule', {
    name: '飲み会', memo: 'メモ', dates: ['2026-08-01', '2026-08-02'], presetNames: ['太郎', '花子'],
  }, ctx());
  // 作成直後から回答受付を開始する。'scheduleCreate'（準備中）にすると
  // ホストに不要な「作成」ナビが残り、参加者にはURLを開いても「準備中です」としか出ない。
  assert.equal(doc.activeView, 'schedule');
  assert.deepEqual(doc.dates, ['2026-08-01', '2026-08-02']);
  assert.equal(doc.memo, 'メモ');
  assert.deepEqual(doc.participantOrder, ['太郎', '花子']);
  assert.deepEqual(doc.ownerUids, ['u1']);
  assert.equal(doc.confirmedDate, null);
  assert.equal(doc.participants['太郎'][0], '');
  assert.equal(doc.participants['太郎'][1], '');
  assert.equal(doc.participants['花子']._note, '');
});

test('schedule: 事前参加者なしでも作成できる', () => {
  const doc = buildEventDoc('schedule', { name: 'X', dates: ['2026-08-01'], presetNames: [] }, ctx());
  assert.deepEqual(doc.participants, {});
  assert.deepEqual(doc.participantOrder, []);
});

test('settle: settleOnly と activeView=settle、メンバーが参加者に', () => {
  const doc = buildEventDoc('settle', { name: '精算', members: ['A', 'B'] }, ctx());
  assert.equal(doc.settleOnly, true);
  assert.equal(doc.activeView, 'settle');
  assert.deepEqual(doc.dates, []);
  assert.deepEqual(doc.participantOrder, ['A', 'B']);
  assert.ok(doc.participants['A'] && doc.participants['B']);
});

test('announce: 参加者・日程は空、activeView=announce', () => {
  const doc = buildEventDoc('announce', { name: 'お知らせ' }, ctx());
  assert.equal(doc.activeView, 'announce');
  assert.deepEqual(doc.participants, {});
  assert.deepEqual(doc.participantOrder, []);
  assert.equal(doc.settleOnly, undefined);
});

test('walica: walica フラグ・空の expenses・メンバー', () => {
  const doc = buildEventDoc('walica', { name: '割り勘', members: ['A', 'B', 'C'] }, ctx());
  assert.equal(doc.walica, true);
  assert.deepEqual(doc.expenses, []);
  assert.equal(doc.activeView, 'walica');
  assert.deepEqual(doc.participantOrder, ['A', 'B', 'C']);
});

test('seating: 1卓(定員=人数)・1次会・seatTags空でスタート', () => {
  _n = 0;
  const doc = buildEventDoc('seating', { name: '座席', members: ['A', 'B', 'C'] }, ctx());
  assert.equal(doc.seating, true);
  assert.equal(doc.activeView, 'seating');
  assert.deepEqual(doc.seatTags, {});
  assert.equal(doc.seatParties.length, 1);
  assert.equal(doc.seatParties[0].name, '1次会');
  assert.equal(doc.seatParties[0].tables.length, 1);
  assert.equal(doc.seatParties[0].tables[0].capacity, 3);
  assert.equal(doc.seatParties[0].assignment, null);
});

test('未知のactionIdはnull（想定外の作成を書き込まない）', () => {
  assert.equal(buildEventDoc('unknown', { name: 'X' }, ctx()), null);
});

// ── テーマ（イベントごと） ──

test('テーマ: ちいかわを選ぶと theme が保存される（5種類すべて）', () => {
  for (const kind of ['schedule', 'settle', 'announce', 'walica', 'seating']) {
    const doc = buildEventDoc(kind, { name: 'x', members: ['a'], dates: ['2026-11-01'], theme: 'chiikawa' }, ctx());
    assert.equal(doc.theme, 'chiikawa', kind);
  }
});

test('テーマ: オリーブ・未指定では theme を保存しない（既存と同じ形のまま）', () => {
  for (const theme of ['olive', undefined]) {
    const doc = buildEventDoc('schedule', { name: 'x', dates: ['2026-11-01'], theme }, ctx());
    assert.equal('theme' in doc, false, String(theme));
  }
});

test('テーマ: 知らない値は保存しない', () => {
  const doc = buildEventDoc('walica', { name: 'x', members: ['a'], theme: 'sakura' }, ctx());
  assert.equal('theme' in doc, false);
});
