const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableError } = require('../index');

test('isRetryableError: Gemini HTTP 4xx/5xx は再試行しない（認可・クォータ・仕様上の非可逆エラー）', () => {
  assert.equal(isRetryableError(new Error('Gemini 401: unauthorized')), false);
  assert.equal(isRetryableError(new Error('Gemini 429: quota exceeded')), false);
  assert.equal(isRetryableError(new Error('Gemini 404: model not found')), false);
  assert.equal(isRetryableError(new Error('Gemini 500: internal')), false);
});

test('isRetryableError: SAFETY ブロックは再試行しない（同じプロンプトで再現する）', () => {
  assert.equal(isRetryableError(new Error('gemini: empty candidates blockReason=SAFETY')), false);
});

test('isRetryableError: JSON parse 失敗は再試行対象（Pro thinking mode の一時的な出力乱れ）', () => {
  assert.equal(isRetryableError(new Error('gemini: failed to parse JSON: Expecting value (finishReason=STOP, jsonLen=200, tail="...")')), true);
});

test('isRetryableError: BRIEF_INVALID も再試行対象', () => {
  assert.equal(isRetryableError(new Error('BRIEF_INVALID')), true);
});

test('isRetryableError: empty parts text（SAFETY 以外）は再試行対象', () => {
  assert.equal(isRetryableError(new Error('gemini: empty parts text (finishReason=MAX_TOKENS)')), true);
});

test('isRetryableError: null/undefined でも例外を投げず false 系扱い', () => {
  // .message が読めなくてもクラッシュしないこと（想定外エラーは再試行対象扱いで安全側）
  assert.equal(isRetryableError(null), true);
  assert.equal(isRetryableError(undefined), true);
  assert.equal(isRetryableError({}), true);
});
