// テーマ画像の差し込み（空の画面）の特性化テスト。
// 画像が読み込めないときは onerror で自分を消し、枠だけが残らないようにしている。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const NAMES = ['DECO_KINDS', 'TOAST_ART_KINDS', 'THEMES', 'normalizeTheme', 'themeAssetBase', 'themeAssetUrl', 'escHtml', 'themeArtHtml'];
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

test('画面ごとの空の画面は empty と同じ大きさの枠で、違う絵を出す', () => {
  const { themeArtHtml } = load('chiikawa', '/chouseikun/');
  const html = themeArtHtml('empty-sleep');
  assert.match(html, /src="themes\/chiikawa\/empty-sleep\.png"/);
  assert.match(html, /class="theme-art theme-art-empty theme-art-empty-sleep"/);
});

test('◯△✕ の顔は3つそろっている（1つでも欠けると記号のままになる）', () => {
  const { themeAssetUrl } = load('chiikawa', '/chouseikun/');
  for (const k of ['o', 't', 'x']) {
    assert.equal(themeAssetUrl('chiikawa', 'vote-' + k, '/chouseikun/'), `themes/chiikawa/vote-${k}.png`);
    assert.equal(themeAssetUrl('olive', 'vote-' + k, '/chouseikun/'), '');
  }
});

test('飾りの8枚と通知のキャラ12体がそろっている（オリーブには無い）', () => {
  const { themeAssetUrl, DECO_KINDS, TOAST_ART_KINDS } = load('chiikawa', '/chouseikun/');
  assert.equal(DECO_KINDS.length, 8);
  assert.equal(TOAST_ART_KINDS.length, 12);
  for (const k of [...DECO_KINDS, ...TOAST_ART_KINDS, 'empty-lying', 'empty-field']) {
    assert.equal(themeAssetUrl('chiikawa', k, '/chouseikun/'), `themes/chiikawa/${k}.png`);
    assert.equal(themeAssetUrl('olive', k, '/chouseikun/'), '');
  }
});

test('ロゴの3人並びはちいかわにだけある', () => {
  const { themeAssetUrl } = load('chiikawa', '/chouseikun/');
  assert.equal(themeAssetUrl('chiikawa', 'header-wide', '/chouseikun/'), 'themes/chiikawa/header-wide.png');
  assert.equal(themeAssetUrl('olive', 'header-wide', '/chouseikun/'), '');
});
