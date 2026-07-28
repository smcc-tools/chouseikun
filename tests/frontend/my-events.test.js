// マイイベント索引に複製する表示用サマリ（myEventSummary）の特性化テスト。
// 一覧はこのサマリだけで描画するため、ここがズレると「日程調整中」「開催日」の表示が
// イベント本体と食い違う。イベント本体を読み直していた頃のロジックと同値であることを固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { myEventSummary, tsMillis } = loadFunctions(['myEventSummary', 'tsMillis']);

const ts = ymd => new Date(ymd + 'T00:00:00').getTime();

test('activeView がそのままステータスになる', () => {
  assert.equal(myEventSummary({ activeView: 'settle' }).type, 'settle');
  assert.equal(myEventSummary({ activeView: 'seating' }).type, 'seating');
});

test('activeView が無い旧データは個別フラグから読み替える', () => {
  assert.equal(myEventSummary({ walica: true }).type, 'walica');
  assert.equal(myEventSummary({ seating: true }).type, 'seating');
  assert.equal(myEventSummary({ settleOnly: true }).type, 'settle');
  assert.equal(myEventSummary({}).type, 'schedule');
});

test('activeView は旧フラグより優先される', () => {
  assert.equal(myEventSummary({ activeView: 'announce', walica: true }).type, 'announce');
});

test('入力開催日(eventDate)があれば dateSource=input で採用する', () => {
  const s = myEventSummary({ eventDate: '2026-08-01' });
  assert.equal(s.confirmedTs, ts('2026-08-01'));
  assert.equal(s.dateSource, 'input');
});

test('eventDate が無ければ日程調整の確定日を使い dateSource=confirmed', () => {
  const s = myEventSummary({ confirmedDate: 1, dates: ['2026-08-01 19:00', '2026-08-02 18:00'] });
  assert.equal(s.confirmedTs, ts('2026-08-02'));
  assert.equal(s.dateSource, 'confirmed');
});

test('eventDate は確定日より優先される', () => {
  const s = myEventSummary({ eventDate: '2026-09-09', confirmedDate: 0, dates: ['2026-08-01'] });
  assert.equal(s.confirmedTs, ts('2026-09-09'));
  assert.equal(s.dateSource, 'input');
});

test('confirmedDate=0（先頭の候補日）を未確定として捨てない', () => {
  // 0 は falsy なので `if (ci)` と書くと先頭候補の確定が消える
  const s = myEventSummary({ confirmedDate: 0, dates: ['2026-08-01 19:00'] });
  assert.equal(s.confirmedTs, ts('2026-08-01'));
  assert.equal(s.dateSource, 'confirmed');
});

test('日付が無い場合は null を返す（Firestoreに書くため undefined にしない）', () => {
  const s = myEventSummary({ activeView: 'schedule' });
  assert.equal(s.confirmedTs, null);
  assert.equal(s.dateSource, null);
  assert.ok(!Object.values(s).includes(undefined), 'undefined を含むと Firestore の書き込みが失敗する');
});

test('不正な日付形式は採用しない', () => {
  for (const bad of ['2026/08/01', '8月1日', '', '   ', 'null']) {
    const s = myEventSummary({ eventDate: bad });
    assert.equal(s.confirmedTs, null, `${bad} を日付として採用してしまった`);
  }
});

test('確定インデックスが候補日の範囲外なら未確定扱い', () => {
  const s = myEventSummary({ confirmedDate: 5, dates: ['2026-08-01'] });
  assert.equal(s.confirmedTs, null);
});

test('parentEventId 付き（旧ハブ方式の子）は orphan=true で一覧から除外できる', () => {
  assert.equal(myEventSummary({ parentEventId: 'abc' }).orphan, true);
  assert.equal(myEventSummary({}).orphan, false);
});

test('data が null/undefined でも落ちない', () => {
  for (const d of [null, undefined]) {
    const s = myEventSummary(d);
    assert.equal(s.type, 'schedule');
    assert.equal(s.confirmedTs, null);
    assert.equal(s.orphan, false);
  }
});

// 索引キャッシュの水位(watermark)は tsMillis で算出する。ここがズレると差分同期が
// 取りこぼす（古すぎる水位＝毎回全件、新しすぎる水位＝更新を見落とす）。
test('Firestore の Timestamp をミリ秒に変換する', () => {
  const t = { toMillis: () => 1767225600000 };
  assert.equal(tsMillis(t), 1767225600000);
});

test('数値はそのまま返す（ローカル更新でキャッシュに入れた値）', () => {
  assert.equal(tsMillis(1767225600000), 1767225600000);
});

test('未設定・不正値は0（＝全同期に倒す）', () => {
  // NaN/Infinity を水位にすると Timestamp.fromMillis が投げて一覧が固まる
  for (const [label, v] of [['undefined', undefined], ['null', null], ['空文字', ''],
                            ['オブジェクト', {}], ['文字列', 'abc'], ['NaN', NaN], ['Infinity', Infinity]]) {
    assert.equal(tsMillis(v), 0, `${label} が0にならなかった`);
  }
});
