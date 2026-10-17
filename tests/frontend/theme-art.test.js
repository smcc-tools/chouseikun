// テーマ画像の差し込み（空の画面）の特性化テスト。
// 画像が読み込めないときは onerror で自分を消し、枠だけが残らないようにしている。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const NAMES = ['THEMES', 'normalizeTheme', 'themeAssetBase', 'themeAssetUrl', 'escHtml', 'themeArtHtml'];
const load = (currentTheme, pathname) =>
  loadFunctions(NAMES, { currentTheme, location: { pathname } });

test('オリーブでは何も差し込まない', () => {
  const { themeArtHtml } = load('olive', '/chouseikun/');
  assert.equal(themeArtHtml('empty'), '');
});

test('ちいかわでは空の画面の画像を差し込む', () => {
  const { themeArtHtml } = load('chiikawa', '/chouseikun/');
  const html = themeArtHtml('empty');
  assert.match(html, /^<img /);
  assert.match(html, /src="themes\/chiikawa\/empty\.png"/);
  assert.match(html, /class="theme-art theme-art-empty"/);
});

test('読み込めなければ自分を消す（枠だけを残さない）', () => {
  const { themeArtHtml } = load('chiikawa', '/chouseikun/');
  assert.match(themeArtHtml('empty'), /onerror="this\.remove\(\)"/);
});

test('飾りなので読み上げない', () => {
  const { themeArtHtml } = load('chiikawa', '/chouseikun/');
  assert.match(themeArtHtml('empty'), /alt=""/);
});

test('test 環境では1つ上の themes/ を読む', () => {
  const { themeArtHtml } = load('chiikawa', '/chouseikun/test/');
  assert.match(themeArtHtml('empty'), /src="\.\.\/themes\/chiikawa\/empty\.png"/);
});

test('画像の無い種類は何も差し込まない', () => {
  const { themeArtHtml } = load('chiikawa', '/chouseikun/');
  assert.equal(themeArtHtml('banner'), '');
});
