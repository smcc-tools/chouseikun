// テーマ選択の色見本（.tp-<テーマ>）が、そのテーマの実際の色と食い違わないことの特性化テスト。
// テーマの色を作り変えたのに見本が古い色のまま残った（ちいかわ 2026-10-18）ので、
// 見本に書いた色が、そのテーマの色の一覧（トークン）に実際にある色かを確かめる。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'index.html'), 'utf8');

function tokenBlock(opener) {
  const i = HTML.indexOf(opener);
  return i < 0 ? '' : HTML.slice(i, HTML.indexOf('\n}', i));
}
const BLOCKS = {
  olive: tokenBlock('\n:root {'),
  chiikawa: tokenBlock(':root[data-theme="chiikawa"] {'),
  pokemon: tokenBlock(':root[data-theme="pokemon"] {'),
};

for (const [theme, block] of Object.entries(BLOCKS)) {
  test(`${theme}: 色見本の色はすべてテーマの色の一覧にある`, () => {
    assert.ok(block.includes('--green:'), `${theme} の色の一覧が見つからない`);
    const m = HTML.match(new RegExp(`\\.tp-${theme} \\{([^}]*)\\}`));
    assert.ok(m, `.tp-${theme} が無い（作成画面と🎨メニューの見本）`);
    const colors = (m[1].match(/#[0-9A-Fa-f]{6}/g) || []).map(c => c.toUpperCase());
    assert.ok(colors.length >= 2, `見本の色が少ない: ${colors}`);
    const inBlock = new Set((block.match(/#[0-9A-Fa-f]{6}/g) || []).map(c => c.toUpperCase()));
    assert.deepEqual(colors.filter(c => !inBlock.has(c)), [], 'テーマの色に無い色が見本に使われている');
  });
}

test('テーマの一覧にあるテーマはすべて色見本を持つ', () => {
  const i = HTML.indexOf('const THEMES = {');
  const keys = [...HTML.slice(i, HTML.indexOf('\n  };', i)).matchAll(/^    ([a-z]+): \{/gm)].map(m => m[1]);
  assert.ok(keys.length >= 3, keys);
  for (const k of keys) assert.ok(HTML.includes(`.tp-${k} {`), `.tp-${k} が無い`);
});
