// メールアカウント登録の入力チェックとエラー文言の特性化テスト。
// ログイン失敗の理由を区別しないこと（アカウント列挙対策）を含めて固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunctions } = require('./extract');

const { validateAccountInput, authErrorToJa } =
  loadFunctions(['validateAccountInput', 'authErrorToJa', 'isValidEmail'], { ACCOUNT_MIN_PASSWORD: 8 });

const ok = (mode, input) => validateAccountInput(mode, input);

// ── validateAccountInput：ログイン ──

test('ログイン：メールとパスワードが揃っていれば通る', () => {
  const r = ok('login', { email: 'a@example.com', password: 'password1' });
  assert.equal(r.ok, true);
  assert.equal(r.error, '');
});

test('ログイン：メールが空ならエラー', () => {
  const r = ok('login', { email: '', password: 'password1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /メールアドレス/);
});

test('ログイン：パスワードが空ならエラー', () => {
  const r = ok('login', { email: 'a@example.com', password: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /パスワード/);
});

test('ログインでは8文字未満でも入力チェックでは弾かない（既存アカウントを締め出さない）', () => {
  // 8文字の制限は新規登録時のみ。認証の成否はサーバに任せる
  assert.equal(ok('login', { email: 'a@example.com', password: 'abc' }).ok, true);
});

// ── validateAccountInput：新規登録 ──

test('新規登録：正しい入力なら通り、表示名がそのまま返る', () => {
  const r = ok('signup', { email: 'a@example.com', password: 'password1', password2: 'password1', displayName: '田中' });
  assert.equal(r.ok, true);
  assert.equal(r.displayName, '田中');
});

test('新規登録：表示名が未入力ならメールの@より前を使う', () => {
  const r = ok('signup', { email: 'taro.yamada@example.com', password: 'password1', password2: 'password1', displayName: '' });
  assert.equal(r.ok, true);
  assert.equal(r.displayName, 'taro.yamada');
});

test('新規登録：表示名の前後の空白は落とす', () => {
  const r = ok('signup', { email: 'a@example.com', password: 'password1', password2: 'password1', displayName: '  花子  ' });
  assert.equal(r.displayName, '花子');
});

test('新規登録：パスワードは8文字以上', () => {
  const r7 = ok('signup', { email: 'a@example.com', password: '1234567', password2: '1234567' });
  assert.equal(r7.ok, false);
  assert.match(r7.error, /8文字/);
  const r8 = ok('signup', { email: 'a@example.com', password: '12345678', password2: '12345678' });
  assert.equal(r8.ok, true);
});

test('新規登録：確認用パスワードが一致しないとエラー', () => {
  const r = ok('signup', { email: 'a@example.com', password: 'password1', password2: 'password2' });
  assert.equal(r.ok, false);
  assert.match(r.error, /一致/);
});

test('メール形式：@とドメインが無いものは弾く', () => {
  for (const bad of ['abc', 'a@', '@example.com', 'a@b', 'a b@example.com', '']) {
    const r = ok('signup', { email: bad, password: 'password1', password2: 'password1' });
    assert.equal(r.ok, false, `${bad} が通ってしまった`);
  }
});

test('メール形式：一般的なアドレスは通る', () => {
  for (const good of ['a@example.com', 'taro.yamada+tag@example.co.jp', 'A_B-C@sub.example.org']) {
    const r = ok('signup', { email: good, password: 'password1', password2: 'password1' });
    assert.equal(r.ok, true, `${good} が弾かれた`);
  }
});

test('メール形式：@の重複や連続・末尾のドットを弾く（正規表現が緩んだら落ちる）', () => {
  // ここは「今の正規表現でしか通らない」ケース。ドメイン部を \S+ 等に緩めると素通りする
  for (const bad of ['a@b@example.com', 'a@example..com', 'a@example.com.', 'a@.example.com', 'a@example.']) {
    const r = validateAccountInput('signup', { email: bad, password: 'password1', password2: 'password1' });
    assert.equal(r.ok, false, `${bad} が通ってしまった`);
  }
});

test('入力が欠けていても落ちない', () => {
  for (const input of [undefined, null, {}]) {
    const r = validateAccountInput('signup', input);
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
});

// ── authErrorToJa ──

test('ログイン失敗の3コードは同じ文言（アカウント列挙対策）', () => {
  const a = authErrorToJa('auth/invalid-credential');
  const b = authErrorToJa('auth/wrong-password');
  const c = authErrorToJa('auth/user-not-found');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(a, /メールアドレスまたはパスワード/);
});

test('登録済みメールはGoogleの可能性にも触れる', () => {
  const m = authErrorToJa('auth/email-already-in-use');
  assert.match(m, /既に登録/);
  assert.match(m, /Google/);
});

test('個別のコードに対応する文言を返す', () => {
  assert.match(authErrorToJa('auth/invalid-email'), /形式/);
  assert.match(authErrorToJa('auth/weak-password'), /8文字/);
  assert.match(authErrorToJa('auth/too-many-requests'), /しばらく/);
  assert.match(authErrorToJa('auth/network-request-failed'), /通信/);
});

test('未知のコードでも英語を露出させない', () => {
  for (const code of ['auth/some-new-code', '', null, undefined, 'internal-error']) {
    const m = authErrorToJa(code);
    assert.ok(m.length > 0, `${code} で空文字が返った`);
    assert.ok(!/auth\//.test(m), `${code} でコードがそのまま出た: ${m}`);
    assert.ok(!/[a-z]{4,}-[a-z]{4,}/.test(m), `${code} で英語が露出した: ${m}`);
  }
});
