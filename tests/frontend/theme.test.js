// テーマ名の正規化と、テーマ画像の場所の特性化テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { normalizeTheme, themeAssetBase, themeAssetUrl } =
  loadFunctions(['DECO_KINDS', 'TOAST_ART_KINDS', 'THEMES', 'normalizeTheme', 'themeAssetBase', 'themeAssetUrl']);

test('chiikawa はそのまま', () => {
  assert.equal(normalizeTheme('chiikawa'), 'chiikawa');
});

test('olive はそのまま', () => {
  assert.equal(normalizeTheme('olive'), 'olive');
});

test('未設定はオリーブ（既存イベントの移行が要らない）', () => {
  assert.equal(normalizeTheme(undefined), 'olive');
  assert.equal(normalizeTheme(null), 'olive');
  assert.equal(normalizeTheme(''), 'olive');
});

test('知らない値・大文字違いはオリーブ', () => {
  assert.equal(normalizeTheme('sakura'), 'olive');
  assert.equal(normalizeTheme('Chiikawa'), 'olive');
  assert.equal(normalizeTheme(1), 'olive');
});

test('test 環境のページからは1つ上の themes/ を読む', () => {
  assert.equal(themeAssetBase('/chouseikun/test/index.html'), '../themes/');
  assert.equal(themeAssetBase('/chouseikun/test/'), '../themes/');
});

test('本番のページからは同じ階層の themes/ を読む', () => {
  assert.equal(themeAssetBase('/chouseikun/'), 'themes/');
  assert.equal(themeAssetBase('/chouseikun/index.html'), 'themes/');
});

test('ちいかわの画像の場所', () => {
  assert.equal(themeAssetUrl('chiikawa', 'header', '/chouseikun/'), 'themes/chiikawa/header.png');
  assert.equal(themeAssetUrl('chiikawa', 'empty', '/chouseikun/test/'), '../themes/chiikawa/empty.png');
  assert.equal(themeAssetUrl('chiikawa', 'celebrate', '/chouseikun/'), 'themes/chiikawa/celebrate.png');
});

test('オリーブには画像が無い', () => {
  assert.equal(themeAssetUrl('olive', 'header', '/chouseikun/'), '');
  assert.equal(themeAssetUrl(undefined, 'empty', '/chouseikun/'), '');
});

test('知らない種類の画像は空', () => {
  assert.equal(themeAssetUrl('chiikawa', 'banner', '/chouseikun/'), '');
});
