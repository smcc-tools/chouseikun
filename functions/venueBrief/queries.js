// venue.shop 文字列から店名と URL を抽出する。純粋関数のみ。副作用なし。

function extractShopName(s) {
  if (!s || typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (!trimmed) return '';
  const lines = trimmed.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const nonUrl = lines.filter(l => !/^https?:\/\//i.test(l));
  if (nonUrl.length > 0) {
    return nonUrl.reduce((a, b) => b.length > a.length ? b : a);
  }
  try {
    return new URL(lines[0]).hostname;
  } catch (_) {
    return trimmed;
  }
}

function extractShopUrl(s) {
  if (!s || typeof s !== 'string') return '';
  const m = s.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

module.exports = { extractShopName, extractShopUrl };
