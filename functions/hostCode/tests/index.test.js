const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateClaimInput } = require('../index');

test('入力検証: 正常系（trim込み）', () => {
  const r = validateClaimInput({ eventId: ' abc123XYZ_-4 ', code: 'a1b2c3d4e5f6g7h8i9j0' });
  assert.deepEqual(r, { eventId: 'abc123XYZ_-4', code: 'a1b2c3d4e5f6g7h8i9j0' });
});

test('入力検証: eventId 空・65字・不正文字はエラー', () => {
  assert.equal(validateClaimInput({ eventId: '', code: 'a'.repeat(20) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'x'.repeat(65), code: 'a'.repeat(20) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'a/b', code: 'a'.repeat(20) }).error, 'INVALID_ARG');
});

test('入力検証: code は英小文字+数字ちょうど20文字のみ', () => {
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'a'.repeat(19) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'a'.repeat(21) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'A'.repeat(20) }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: '' }).error, 'INVALID_ARG');
  assert.equal(validateClaimInput({ eventId: 'e1', code: 'a1b2c3d4e5f6g7h8i9j0' }).code, 'a1b2c3d4e5f6g7h8i9j0');
});
