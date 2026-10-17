// ちいかわテーマの文字が読めること（WCAG AA・コントラスト比4.5以上）の特性化テスト。
// test/index.html の :root[data-theme="chiikawa"] から値を読み、var(--x) の別名も解決して計算する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'index.html'), 'utf8');
const OPENER = ':root[data-theme="chiikawa"] {';
const start = HTML.indexOf(OPENER);
const BLOCK = start < 0 ? '' : HTML.slice(start, HTML.indexOf('}', start));
const TOKENS = Object.fromEntries([...BLOCK.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));

function resolve(name, seen = new Set()) {
  const v = TOKENS[name];
  if (v === undefined || seen.has(name)) return undefined;
  seen.add(name);
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  return m ? resolve(m[1], seen) : v;
}
function lum(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const color = n => (n === 'white' ? '#FFFFFF' : resolve(n));

test('ちいかわのブロックが見つかる', () => {
  assert.ok(start >= 0 && TOKENS.green, 'ちいかわのトークンが読めない');
});

const PAIRS = [
  ['white', 'green', '主ボタンの文字'],
  ['text', 'bg', '本文'],
  ['text', 'surface', 'カードの本文'],
  ['text-muted', 'bg', '補足の文字'],
  ['text-muted', 'surface', 'カードの補足の文字'],
  ['gold-text', 'gold-tint', '確定した日付'],
  ['on-dark', 'forest', '濃い帯の文字'],
  ['white', 'host-badge', 'HOSTバッジ'],
  ['clay', 'surface', '✕・削除'],
];
for (const [fg, bg, why] of PAIRS) {
  test(`${why}: --${fg} × --${bg} が4.5以上`, () => {
    const a = color(fg), b = color(bg);
    assert.match(a || '', /^#[0-9A-Fa-f]{6}$/, `--${fg} が色として読めない`);
    assert.match(b || '', /^#[0-9A-Fa-f]{6}$/, `--${bg} が色として読めない`);
    assert.ok(contrast(a, b) >= 4.5, `${contrast(a, b).toFixed(2)}`);
  });
}

test('◯（主役）と ✕ が別の色', () => {
  assert.notEqual(color('green').toUpperCase(), color('clay').toUpperCase());
  assert.notEqual(color('vote-yes').toUpperCase(), color('vote-no').toUpperCase());
});
