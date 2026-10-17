// テーマ用のトークンが「オリーブの見た目を変えない」形で使われていることの特性化テスト。
//
// 直書きの色は var(--新トークン, 元の色) に置き換えてある。新トークンはオリーブの :root で
// 定義しないので、オリーブでは元の色（フォールバック）がそのまま使われる。
// ここが崩れる（新トークンをオリーブで定義する／フォールバックを書き忘れる／
// 色味のある直書きの色を新しく足す）とオリーブの見た目が変わるか、ちいかわに
// オリーブの色が残るので、3つの約束を固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'index.html'), 'utf8');

// 直書きの色を置き換えたトークン（フォールバック必須）
const REPLACED_TOKENS = [
  'deco-on-dark', 'on-dark', 'text-label', 'gold-tint', 'gold-tint-strong', 'gold-text',
  'clay-border', 'clay-tint', 'clay-text', 'brand-tint', 'brand-tint-soft', 'brand-tint-head',
  'brand-tint-hover', 'brand-hover', 'brand-disabled', 'surface-sunken', 'panel-cream',
  'row-hover', 'table-head', 'text-faint', 'text-strong', 'nav-text', 'bg-glow', 'scrollbar',
  'deco-gold', 'vote-yes', 'vote-no', 'host-badge',
  'confetti-1', 'confetti-2', 'confetti-3', 'confetti-4', 'confetti-5', 'confetti-6', 'confetti-7',
  'press-rgb', 'brand-rgb', 'shadow-rgb', 'muted-rgb', 'gold-rgb', 'bg-rgb', 'bg-glow-rgb',
  'vote-radius', 'nav-radius', 'nav-radius-sm', 'bulk-radius',
];

// どのテーマでも馴染むので直書きのままでよい色
const NEUTRAL = new Set(['#fff', '#ffffff', '#000', '#000000', '#333', '#333333', '#fafafa', '#f5f5f5',
  '#eee', '#eeeeee', '#bbb', '#ccc', '#ddd', '#999', '#666', '#888', '#444', '#222', '#111', '#555',
  '#aaa', '#f0f0f0', '#e0e0e0', '#e5e5e5']);

function block(src, opener) {
  const i = src.indexOf(opener);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('}', i) + 1);
}
const OLIVE_ROOT = block(HTML, '\n:root {');

test('オリーブの :root ブロックが見つかる（以降のテストの前提）', () => {
  assert.ok(OLIVE_ROOT.includes('--green:'), 'オリーブの :root が見つからない');
});

test('新トークンはオリーブの :root で定義しない（定義すると元の色が使われなくなる）', () => {
  const defined = REPLACED_TOKENS.filter(t => OLIVE_ROOT.includes(`--${t}:`));
  assert.deepEqual(defined, []);
});

test('置き換えたトークンの var() には必ずフォールバックがある', () => {
  const pat = new RegExp(`var\\(--(${REPLACED_TOKENS.join('|')})\\s*\\)`, 'g');
  assert.deepEqual(HTML.match(pat) || [], []);
});

test('色味のある直書きの色が残っていない', () => {
  let s = HTML;
  // トークンの定義ブロック（オリーブ・ちいかわ・ポケモン）は直書きの色を持つのが正しい
  s = s.replace(OLIVE_ROOT, '');
  s = s.replace(block(s, ':root[data-theme="chiikawa"] {'), '');
  s = s.replace(block(s, ':root[data-theme="pokemon"] {'), '');
  // データURI（CSSで描いたロゴなど）は var() が使えない
  s = s.replace(/url\(\s*["']?data:[^)]*\)/g, '');
  // var(--x, フォールバック) はフォールバックごと取り除く
  s = s.replace(/var\(--[a-z0-9-]+\s*,[^()]*\)/g, '');
  // 意図して残している行: ブラウザ上部の色・座席の色タグ（保存データ）・未使用の colorMap・
  // 明示的に許可した行（テーマの見本の色など）
  s = s.split('\n').filter(l => !/name="theme-color"|const colorMap|\{ key: 'c\d'|theme-literal-ok/.test(l)).join('\n');
  const hex = (s.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [])
    .map(h => h.toLowerCase()).filter(h => !NEUTRAL.has(h));
  assert.deepEqual([...new Set(hex)], []);
  const rgb = [...s.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)]
    .map(m => `${m[1]},${m[2]},${m[3]}`)
    .filter(t => t !== '0,0,0' && t !== '255,255,255');
  assert.deepEqual([...new Set(rgb)], []);
});
