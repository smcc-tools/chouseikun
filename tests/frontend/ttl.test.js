// 保存期限(1年)の延長判定 needsTtlRefresh の特性化テスト。
// この判定を間違えると「使っているのに1年後に消える」「毎回書き込んで無料枠を食う」の
// どちらかになり、どちらも1年近く経つまで表に出ない。境界を明示的に固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const DAY = 24 * 3600 * 1000;
const EVENT_TTL_MS = 365 * DAY;
const EVENT_TTL_REFRESH_SLACK_MS = 30 * DAY;

const { needsTtlRefresh } = loadFunctions(['needsTtlRefresh'], { EVENT_TTL_MS, EVENT_TTL_REFRESH_SLACK_MS });

const NOW = Date.parse('2026-07-28T00:00:00Z');

test('期限が未設定（TTL導入前のデータ）なら必ず延長する', () => {
  for (const v of [0, null, undefined, NaN, -1]) {
    assert.equal(needsTtlRefresh(v, NOW), true, `${v} で延長されなかった`);
  }
});

test('今しがた延長したばかりなら書き込まない', () => {
  assert.equal(needsTtlRefresh(NOW + EVENT_TTL_MS, NOW), false);
});

test('前回延長から30日以内なら書き込まない（開くたびの無駄な書き込みを防ぐ）', () => {
  assert.equal(needsTtlRefresh(NOW + EVENT_TTL_MS - 29 * DAY, NOW), false);
});

test('前回延長から30日を超えたら延長する', () => {
  assert.equal(needsTtlRefresh(NOW + EVENT_TTL_MS - 31 * DAY, NOW), true);
});

test('境界ちょうど（30日）は書き込まない', () => {
  assert.equal(needsTtlRefresh(NOW + EVENT_TTL_MS - EVENT_TTL_REFRESH_SLACK_MS, NOW), false);
});

test('期限切れ間近・期限切れ後も延長する（開けば必ず生き延びる）', () => {
  assert.equal(needsTtlRefresh(NOW + DAY, NOW), true);
  assert.equal(needsTtlRefresh(NOW - DAY, NOW), true);
});

test('開き続ける限り期限が1年先に維持される（11か月ごとに開くケース）', () => {
  let ttl = 0, now = NOW, writes = 0;
  for (let i = 0; i < 10; i++) {
    if (needsTtlRefresh(ttl, now)) { ttl = now + EVENT_TTL_MS; writes++; }
    assert.ok(ttl > now, `${i}回目で期限切れになった`);
    now += 330 * DAY; // 11か月ごとに開く
  }
  assert.equal(writes, 10, '毎回延長されるはず');
});

test('毎日開いても書き込みは月1回程度に収まる', () => {
  let ttl = 0, now = NOW, writes = 0;
  for (let i = 0; i < 365; i++) {
    if (needsTtlRefresh(ttl, now)) { ttl = now + EVENT_TTL_MS; writes++; }
    now += DAY;
  }
  assert.ok(writes <= 13, `1年で${writes}回書き込んだ（多すぎる）`);
  assert.ok(writes >= 12, `1年で${writes}回しか書き込まなかった（期限が延びない恐れ）`);
});
