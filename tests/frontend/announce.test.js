// お知らせ（会場表示）まわりの特性化テスト
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { buildPlaceQuery } = loadFunctions(['buildPlaceQuery']);

// ── buildPlaceQuery（Google店舗概要への検索クエリ組み立て） ──

test('店名＋食べログOGPタイトルの駅名で一意なクエリを作る', () => {
  assert.equal(
    buildPlaceQuery('渋谷 三心', '渋谷 三心（神泉/居酒屋） - 食べログ'),
    '渋谷 三心 神泉'
  );
  assert.equal(
    buildPlaceQuery('jinen.', 'jinen.（渋谷／ダイニングバー） - 食べログ'),
    'jinen. 渋谷'
  );
});

test('半角括弧のOGPタイトル（実際の食べログ形式）にも対応する', () => {
  // 実際のog:titleは「渋谷 三心 (渋谷/日本料理)」のような半角括弧
  assert.equal(buildPlaceQuery('三心', '渋谷 三心 (神泉/日本料理)'), '三心 神泉');
  assert.equal(buildPlaceQuery('', '渋谷 三心 (神泉/日本料理)'), '渋谷 三心 神泉');
  // 店名に駅名を含む場合は重複させない
  assert.equal(buildPlaceQuery('渋谷 三心', '渋谷 三心 (渋谷/日本料理)'), '渋谷 三心');
});

test('店名に駅名が含まれる場合は重複して付けない', () => {
  assert.equal(
    buildPlaceQuery('神泉ホルモン', '神泉ホルモン（神泉/ホルモン） - 食べログ'),
    '神泉ホルモン'
  );
});

test('店名が空ならOGPタイトルから店名を復元（括弧・食べログ表記は除去）', () => {
  assert.equal(
    buildPlaceQuery('', '渋谷 三心（神泉/居酒屋） - 食べログ'),
    '渋谷 三心 神泉'
  );
});

test('プレビューが無ければ店名のみ。両方無ければ空文字', () => {
  assert.equal(buildPlaceQuery('渋谷 三心', ''), '渋谷 三心');
  assert.equal(buildPlaceQuery('', ''), '');
});
