// ホスト専用URLの hostcode 除去ロジックの特性化テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { stripHostCodeFromUrl } = loadFunctions(['stripHostCodeFromUrl']);

test('hostcode だけを除去し、他のパラメータは維持する', () => {
  assert.equal(stripHostCodeFromUrl('?event=abc&hostcode=xyz'), '?event=abc');
  assert.equal(stripHostCodeFromUrl('?hostcode=xyz&event=abc&foo=1'), '?event=abc&foo=1');
});

test('hostcode が無ければそのまま（正規化差のみ許容）', () => {
  assert.equal(stripHostCodeFromUrl('?event=abc'), '?event=abc');
});

test('hostcode のみの場合は空文字を返す（? を残さない）', () => {
  assert.equal(stripHostCodeFromUrl('?hostcode=xyz'), '');
});

test('空・null 入力でも例外を投げない', () => {
  assert.equal(stripHostCodeFromUrl(''), '');
  assert.equal(stripHostCodeFromUrl(null), '');
});
