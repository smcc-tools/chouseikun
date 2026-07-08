const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractShopName, extractShopUrl } = require('../queries');

test('extractShopName: URL のみの入力からホスト名を返す', () => {
  const url = 'https://tabelog.com/tokyo/A1301/A130103/13001234/';
  assert.equal(extractShopName(url), 'tabelog.com');
});

test('extractShopName: 店名 + URL の入力から店名部分だけを返す', () => {
  const input = '銀座 うち山\nhttps://tabelog.com/tokyo/A1301/A130103/13001234/';
  assert.equal(extractShopName(input), '銀座 うち山');
});

test('extractShopName: 店名のみの入力はそのまま返す', () => {
  assert.equal(extractShopName('鮨さいとう'), '鮨さいとう');
});

test('extractShopName: 空文字/null は空文字を返す', () => {
  assert.equal(extractShopName(''), '');
  assert.equal(extractShopName(null), '');
  assert.equal(extractShopName(undefined), '');
});

test('extractShopName: 前後の空白と改行を除去', () => {
  assert.equal(extractShopName('  銀座 うち山  \n'), '銀座 うち山');
});

test('extractShopName: 複数行の非URL行のうち最長を返す', () => {
  const input = '短\n銀座 うち山\n中';
  assert.equal(extractShopName(input), '銀座 うち山');
});

test('extractShopUrl: URL が含まれれば最初のURLを返す', () => {
  const input = '銀座 うち山\nhttps://tabelog.com/tokyo/A1301/';
  assert.equal(extractShopUrl(input), 'https://tabelog.com/tokyo/A1301/');
});

test('extractShopUrl: URL がなければ空文字', () => {
  assert.equal(extractShopUrl('銀座 うち山'), '');
});

test('extractShopUrl: 空入力は空文字', () => {
  assert.equal(extractShopUrl(''), '');
  assert.equal(extractShopUrl(null), '');
});

test('extractShopUrl: http と https 両方対応', () => {
  assert.equal(extractShopUrl('http://example.com/x'), 'http://example.com/x');
  assert.equal(extractShopUrl('https://example.com/x'), 'https://example.com/x');
});
