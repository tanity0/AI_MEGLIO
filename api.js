// api.js — /api/edit の SSE クライアント共通処理（修正/モーション/リグの各タブで共用）

/**
 * /api/edit に POST し、SSEを読み、result イベントを返す。
 * @param {object} body リクエストボディ
 * @param {{signal?: AbortSignal, onDelta?: (text: string) => void}} opts
 * @returns {Promise<object>} result イベント（{ patch } または { segment }）
 * @throws {Error} type:"error" イベント、HTTPエラー、resultなしで終了した場合
 */
export async function streamEdit(body, { signal, onDelta } = {}) {
  const res = await fetch("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let msg = `サーバーエラー (HTTP ${res.status})`;
    try {
      const errJson = await res.json();
      if (errJson.error) msg = errJson.error;
    } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === "delta") {
        if (onDelta) onDelta(evt.text);
      } else if (evt.type === "result") {
        return evt;
      } else if (evt.type === "error") {
        throw new Error(evt.message);
      }
    }
  }
  throw new Error("サーバー応答が完了しませんでした");
}
