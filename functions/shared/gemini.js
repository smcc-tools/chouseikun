// Gemini API 呼び出しの共通部品。venueBrief / orderPlan の両方から使う。
// gemini-2.5-pro は "no longer available to new users" で 404 のため、Pro 相当のエイリアス gemini-pro-latest を使う
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent';

// 1回の呼び出しに個別タイムアウトを設ける。これが無いと1回目の応答遅延だけで
// 関数全体の timeoutSeconds(90s) を食い潰し、2回目以降のリトライが実行されない。
// 25s × 3回 + 前後処理 < 90s に収まる設計。
const GEMINI_CALL_TIMEOUT_MS = 25000;

async function callGemini(body, geminiKey) {
  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(geminiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_CALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`GEMINI_TIMEOUT: no response in ${GEMINI_CALL_TIMEOUT_MS / 1000}s`); // 再試行対象
    }
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// - Gemini HTTP 4xx/5xx は認可/クォータ/仕様上の非可逆エラーなので即失敗（再試行しない）
// - SAFETY はプロンプトレベル(blockReason)・候補レベル(finishReason)とも同じ入力で再現するため再試行しない
// - JSON parse 失敗・タイムアウト・その他は一時的エラーとして再試行対象
function isRetryableError(err) {
  const msg = String((err && err.message) || '');
  if (/^Gemini \d+:/.test(msg)) return false;
  if (/blockReason=SAFETY/.test(msg)) return false;
  if (/finishReason=SAFETY/.test(msg)) return false;
  return true;
}

module.exports = { callGemini, isRetryableError, GEMINI_ENDPOINT, GEMINI_CALL_TIMEOUT_MS };
