// §114: 変換ワーカーの呼び出し口（メインスレッド側）。
//
// ワーカーが使えない環境（モジュールワーカー非対応・file:// 直開き・
// CSPで止められている等）では、同じ convertops.js をメインスレッドで
// 実行するフォールバックへ自動で落ちる。呼び出し側は違いを意識しない。
import { createOps } from "./convertops.js";

let worker = null;
let localOps = null;      // フォールバック用
let workerBroken = false; // 一度壊れたら作り直すまで true
let seq = 0;
let generation = 1; // ワーカーを作り直すたびに増える。呼び出し側が「渡し直しが要るか」を判断する用
const pending = new Map(); // id -> { resolve, reject, onProgress }

// ワーカーが落ちた/作れなかったときに呼ぶ。待っている呼び出しは全部失敗させる。
function teardown(reason) {
  if (worker) { try { worker.terminate(); } catch { /* 無視 */ } }
  worker = null;
  workerBroken = true;
  localOps = null; // 落ちた側の状態は捨てる（元画像から渡し直し）
  generation++;
  const err = new Error(reason);
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function ensureWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL("./convert.worker.js", import.meta.url), { type: "module" });
  } catch {
    workerBroken = true;
    generation++;
    return null;
  }
  worker.addEventListener("message", (ev) => {
    const d = ev.data || {};
    if (d.ready) return;
    const slot = pending.get(d.id);
    if (!slot) return;
    if (d.progress !== undefined) { if (slot.onProgress) slot.onProgress(d.progress); return; }
    pending.delete(d.id);
    if (d.ok) slot.resolve(d.result);
    else slot.reject(new Error(d.error || "変換に失敗しました"));
  });
  // ワーカーがメモリ不足などで死んだ場合。タブは生きているので復帰できる。
  worker.addEventListener("error", () => teardown("変換処理が停止しました（画像が大きすぎる可能性があります）"));
  return worker;
}

// ワーカーを作り直す。次の setSource からやり直しになる。
export function resetWorker() {
  if (worker) { try { worker.terminate(); } catch { /* 無視 */ } }
  worker = null;
  workerBroken = false;
  localOps = null;
  pending.clear();
  generation++;
}

// 「元画像を渡し直す必要があるか」の判定に使う世代番号
export function sessionGeneration() {
  if (!forceLocal) ensureWorker(); // フォールバックへ落ちるならこの時点で確定させる
  return generation;
}

export function isWorkerActive() { return !!worker && !workerBroken; }

// テスト用: ワーカーを使わずフォールバック経路を強制する（§114.7 の等価性検証）
let forceLocal = false;
export function setForceLocal(on) {
  forceLocal = !!on;
  if (worker) { try { worker.terminate(); } catch { /* 無視 */ } worker = null; }
  workerBroken = false;
  pending.clear();
  localOps = null; // 元画像を渡し直すところからやり直す
  generation++;
}

export function call(op, payload = {}, { transfer = [], onProgress = null } = {}) {
  if (!forceLocal) {
    const w = ensureWorker();
    if (w) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        try {
          w.postMessage({ id, op, payload }, transfer);
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    }
  }
  // フォールバック: 同じ op 実装をこのスレッドで実行する
  if (!localOps) localOps = createOps();
  const fn = localOps[op];
  if (!fn) return Promise.reject(new Error(`未知の op: ${op}`));
  return Promise.resolve().then(() => fn(payload, onProgress));
}
