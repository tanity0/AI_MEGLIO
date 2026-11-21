// §114: 変換ワーカー。convertops.js を読み込んでメッセージを捌くだけの薄い層。
//
// メイン → ワーカー: { id, op, payload }
// ワーカー → メイン: { id, ok: true, result } / { id, ok: false, error }
//                    { id, progress: "…" }（完了前に何度でも）
import { createOps } from "./convertops.js";

const ops = createOps();

self.addEventListener("message", async (ev) => {
  const { id, op, payload } = ev.data || {};
  const fn = ops[op];
  if (!fn) {
    self.postMessage({ id, ok: false, error: `未知の op: ${op}` });
    return;
  }
  try {
    const result = await fn(payload || {}, (msg) => self.postMessage({ id, progress: msg }));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// 起動できたことをメイン側へ伝える（ワーカーが使えるかの判定に使う）
self.postMessage({ ready: true });
