#!/usr/bin/env bash
# テスト(/test/)で検証済みのフロントを本番(ルート)へ反映する。
# index.html / sw.js は環境自動判定なので、ルートへコピーするだけで本番設定で動く。
# manifest.json / icons は環境別なのでコピー対象外。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f test/index.html ]; then echo "test/index.html がありません"; exit 1; fi

echo "=== 本番ルート ← test/ の差分 ==="
if diff -q index.html test/index.html >/dev/null && diff -q sw.js test/sw.js >/dev/null; then
  echo "差分はありません（すでに反映済み）。"
  exit 0
fi
diff -u index.html test/index.html || true
diff -u sw.js test/sw.js || true

read -r -p "この内容で本番ルートへ反映しますか？ (y/N): " ans
[ "$ans" = "y" ] || { echo "中止しました"; exit 1; }

cp test/index.html index.html
cp test/sw.js sw.js
echo "コピー完了。次のコマンドで本番(GitHub Pages)へ反映されます："
echo "  git add index.html sw.js && git commit -m 'promote: test→prod' && git push"
