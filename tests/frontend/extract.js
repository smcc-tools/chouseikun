// test/index.html から純粋関数のソースを抜き出してテスト用に評価するハーネス。
// 本番の index.html には一切手を入れない「特性化テスト」方式:
// - 対象関数がリネーム/削除されると抽出に失敗してテストが明示的に落ちる
// - 抽出対象は DOM/Firebase に依存しない純粋ロジックに限ること
const fs = require('fs');
const path = require('path');

// 開発の起点である test/index.html を対象にする（promote 後は root と同一）
const HTML_PATH = path.join(__dirname, '..', '..', 'test', 'index.html');

// src[start] から始まるコードを、文字列・テンプレートリテラル・コメントを
// スキップしながら走査し、停止条件 stop(depth, ch, i) が真になる位置を返す
function scanBalanced(src, start, stop) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && next === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (ch === '/') {
      // 除算演算子か正規表現リテラルかを直前の非空白文字から判定する。
      // escHtml の /[&<>"']/g のような正規表現を含む関数を正しく抽出するために必要
      // （中の ' が文字列スキャナを、[ ] が括弧深度カウントを狂わせるため事前にスキップする）。
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const prev = j >= 0 ? src[j] : '';
      const isDivision = prev === ')' || prev === ']' || prev === "'" || prev === '"' || prev === '`' || /[A-Za-z0-9_$]/.test(prev);
      if (!isDivision) {
        let k = i + 1;
        let inClass = false;
        for (; k < src.length; k++) {
          if (src[k] === '\\') { k++; continue; }
          if (src[k] === '[') inClass = true;
          else if (src[k] === ']') inClass = false;
          else if (src[k] === '/' && !inClass) break;
        }
        while (k + 1 < src.length && /[a-zA-Z]/.test(src[k + 1])) k++;
        i = k;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '{') { i = scanBalanced(src, i + 1, (d, c) => d === 0 && c === '}'); }
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (stop(depth, ch, i)) return i;
  }
  throw new Error('対応する閉じ括弧が見つかりません (position ' + start + ')');
}

// `function name(...) {...}` または `const name = ...;` の宣言全体を切り出す
function extractSource(html, name) {
  let m = html.match(new RegExp('(?:^|\\n)[ \\t]*function ' + name + '\\s*\\('));
  if (m) {
    const start = html.indexOf('function', m.index);
    const bodyOpen = html.indexOf('{', start);
    const end = scanBalanced(html, bodyOpen, (d, c) => d === 0 && c === '}');
    return html.slice(start, end + 1);
  }
  m = html.match(new RegExp('(?:^|\\n)[ \\t]*const ' + name + '\\s*='));
  if (m) {
    const start = html.indexOf('const', m.index);
    const end = scanBalanced(html, start, (d, c) => d === 0 && c === ';');
    return html.slice(start, end + 1);
  }
  throw new Error(name + ' が ' + HTML_PATH + ' に見つかりません。リネーム/削除されていたらテストも追随してください。');
}

// 指定した関数群を1つのサンドボックスで評価し、{ 関数名: 関数 } を返す。
// 依存関係がある場合は依存先も names に含めること。
// index.html のモジュールスコープ変数（let 宣言など）に依存する関数は
// globals で注入する（例: { seatingActiveParty: 0 }）。
function loadFunctions(names, globals = {}) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const src = names.map(n => extractSource(html, n)).join('\n');
  // vm ではなく new Function で同一 realm 内に閉じ込める
  // （vm は別 realm になり deepStrictEqual のプロトタイプ比較が失敗する）
  const keys = Object.keys(globals);
  const factory = new Function(...keys, src + '\nreturn { ' + names.join(', ') + ' };');
  return factory(...keys.map(k => globals[k]));
}

module.exports = { loadFunctions, extractSource, HTML_PATH };
