// autotune.js — §43/§52 自動調整エンジン（スコア関数 + 探索）の共通実装
// motionstudio.js（ギャラリー候補・§43/§44）と studio.js（変換スタジオ本体・§52）が共用する。
// DOM/プロジェクト状態に依存しない純関数＋非同期探索のみ。
import { hexToRgba } from "./app.js";

// §43.1 スコアの重み（低いほど良い）。gunman 実素材（白背景+紫グロー縁・480x700）と
// 人工素材（純色キャラ+ノイズ背景）でチューニングした根拠:
//  - COLOR(1.0): 再構成が前景と主張する画素の平均色距離。パレット近似の粗さに加え、
//    背景の取り込みすぎ（背景色がキャラ色へ強制スナップされ大距離になる）を検出する主項。
//    §52 ではグリッドずれ（セルが2色境界を跨ぐと平均色が濁る）にも最も敏感に反応する。
//  - EDGE(0.6): 簡易エッジ（隣接輝度差）の Dice 一致率。グロー縁の余計な輪郭や
//    輪郭の欠けに反応する。色項より弱く（エッジはセル境界の量子化で常に部分一致のため）。
//  - MISS(2.0): 「明らかにキャラ」（背景色から色距離90超）の画素が透明化された率。
//    背景除去のしすぎ＝欠けは見た目に最も致命的なので最大の重み。
//  - RESIDUE(1.0): 「明らかに背景」（背景色から色距離20以下 or 元から透明）の画素が
//    前景として残った率。残りは欠けより修正しやすいので MISS の半分。
export const TUNE_W = { COLOR: 1.0, EDGE: 0.6, MISS: 2.0, RESIDUE: 1.0 };
export const TUNE_BG_STEPS = [16, 32, 48, 64, 88, 112]; // 粗探索6点（§43.2）
export const TUNE_GLOW_STEPS = [0, 1, 2];
export const TUNE_EDGE_STEPS = [0, 0.3, 0.6];
export const TUNE_SAT_STEPS = [0.2, 0.5, 0.8];
export const TUNE_MAX_EVALS = 40; // 一段目（bg/glow/保護系）の変換回数上限（§43.2）
export const TUNE_MAX_ALIGN_EVALS = 20; // 二段目（整列: offset/size）の上限（§52.2）
export const TUNE_MAX_TOTAL = TUNE_MAX_EVALS + TUNE_MAX_ALIGN_EVALS; // 1フレーム ≤60

export function defaultTuneParams() {
  return { bgThreshold: 48, glowWidth: 0, edgeProtect: 0.3, satProtect: 0.5, offsetDX: 0, offsetDY: 0, sizeDelta: 0 };
}

// 元クロップの前処理（1コマにつき1回）: 背景色推定・強前景/強背景マスク・簡易エッジ
// region: { data(RGBA), width, height }
export function prepScoreRegion(region, opts = {}) {
  const { data, width: w, height: h } = region;
  const noBg = opts.bgMode === "none"; // §53: 背景色推定を使わない（アルファのみで前景/背景を判定）
  // 背景色 = 外周の不透明画素の最頻色（removeBackground と同じ発想の16段量子化）
  const counts = new Map();
  const consider = (x, y) => {
    const o = (y * w + x) * 4;
    if (data[o + 3] < 32) return;
    const key = `${data[o] >> 4},${data[o + 1] >> 4},${data[o + 2] >> 4}`;
    const e = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[o]; e.g += data[o + 1]; e.b += data[o + 2];
    counts.set(key, e);
  };
  if (!noBg) {
    for (let x = 0; x < w; x++) { consider(x, 0); consider(x, h - 1); }
    for (let y = 0; y < h; y++) { consider(0, y); consider(w - 1, y); }
  }
  let bgEntry = null;
  for (const e of counts.values()) if (!bgEntry || e.n > bgEntry.n) bgEntry = e;
  const bg = bgEntry ? [bgEntry.r / bgEntry.n, bgEntry.g / bgEntry.n, bgEntry.b / bgEntry.n] : null;

  const strongFg = new Uint8Array(w * h);
  const strongBg = new Uint8Array(w * h);
  const lum = new Float32Array(w * h);
  let strongFgN = 0, strongBgN = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a < 32) {
      strongBg[i] = 1; strongBgN++;
      lum[i] = -1000; // 透明は輝度の番兵（不透明との境界を必ずエッジにする）
      continue;
    }
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (!bg) {
      if (a >= 128) { strongFg[i] = 1; strongFgN++; }
      continue;
    }
    const d = Math.hypot(data[o] - bg[0], data[o + 1] - bg[1], data[o + 2] - bg[2]);
    if (d > 90) { strongFg[i] = 1; strongFgN++; }
    else if (d <= 20) { strongBg[i] = 1; strongBgN++; }
  }
  // 簡易エッジ: 右/下隣との輝度差 > 40
  const edges = new Uint8Array(w * h);
  let edgeN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x + 1 < w && Math.abs(lum[i] - lum[i + 1]) > 40)
        || (y + 1 < h && Math.abs(lum[i] - lum[i + w]) > 40)) { edges[i] = 1; edgeN++; }
    }
  }
  return { bg, strongFg, strongFgN, strongBg, strongBgN, edges, edgeN };
}

// §43.1: 変換結果を最近傍で region サイズへ拡大し、元クロップと比較（低いほど良い）
// conv: { width, height, pixels, palette(hex[]), srcCellSize, originX, originY }
// lut: パレットindex→[r,g,b,a]（省略時 conv.palette 自身）。map: conv.palette index→lut index（省略時 恒等）
export function scoreRecon(region, prep, conv, lut, map) {
  const { data, width: w, height: h } = region;
  const rgbLUT = lut || conv.palette.map((hex) => hexToRgba(hex));
  const cs = conv.srcCellSize, gx0 = conv.originX, gy0 = conv.originY;
  // 画素→セルの対応は変換器（sampleCellsRegion）と同じ丸め境界 [round(g0+k*cs), round(g0+(k+1)*cs)) を使う。
  // floor((p-g0)/cs) だと cs が整数セルに僅かにずれたとき境界画素が隣のセルへ誤って割り当たり、
  // 整列が合っていても色距離が悪化する（§52 の整列探索で顕在化）。
  const axisMap = (len, g0, n) => {
    const m = new Int32Array(len).fill(-1);
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, Math.round(g0 + k * cs)), b = Math.min(len, Math.round(g0 + (k + 1) * cs));
      for (let p = a; p < b; p++) m[p] = k;
    }
    return m;
  };
  const mapX = axisMap(w, gx0, conv.width), mapY = axisMap(h, gy0, conv.height);
  const recon = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = mapY[y];
    if (cy < 0) continue;
    for (let x = 0; x < w; x++) {
      const cx = mapX[x];
      if (cx < 0) continue;
      const v = conv.pixels[cy * conv.width + cx];
      recon[y * w + x] = map ? map[v] : v;
    }
  }
  let colorSum = 0, colorN = 0, missN = 0, resN = 0;
  for (let i = 0; i < w * h; i++) {
    const idx = recon[i];
    if (idx > 0) {
      const c = rgbLUT[idx];
      const o = i * 4;
      colorSum += Math.hypot(data[o] - c[0], data[o + 1] - c[1], data[o + 2] - c[2]);
      colorN++;
      if (prep.strongBg[i]) resN++;
    } else if (prep.strongFg[i]) {
      missN++;
    }
  }
  // 再構成エッジ: 右/下隣とセル値が変わる位置。元エッジとの Dice 一致率
  let reconEdgeN = 0, inter = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const e = (x + 1 < w && recon[i] !== recon[i + 1]) || (y + 1 < h && recon[i] !== recon[i + w]);
      if (e) { reconEdgeN++; if (prep.edges[i]) inter++; }
    }
  }
  const dice = (prep.edgeN + reconEdgeN) > 0 ? (2 * inter) / (prep.edgeN + reconEdgeN) : 1;
  const colorTerm = colorN ? colorSum / colorN / 441.7 : 1; // 最大RGB距離√(3·255²)で正規化
  const missTerm = prep.strongFgN ? missN / prep.strongFgN : 0;
  const resTerm = prep.strongBgN ? resN / prep.strongBgN : 0;
  return TUNE_W.COLOR * colorTerm + TUNE_W.EDGE * (1 - dice) + TUNE_W.MISS * missTerm + TUNE_W.RESIDUE * resTerm;
}

const r2 = (v) => Math.round(v * 100) / 100;

// 二段階探索（§43.2 + §52.2）。
//   一段目: bgThreshold × glowWidth 全探索 → 上位2件に edgeProtect × satProtect（≤40）
//   二段目: 整列 — offsetDX/DY を ±s/4 の3×3格子（粗）→ ±s/8（細）、sizeDelta を ±2u（粗）→ ±u（細）
//           （u = max(0.25, s*0.02)＝§49.10 のサイズ刻み。s≤12.5 なら ±0.5/±0.25。計20）
// opts:
//   evalFn(params) → { score, cs } | Promise（例外 = そのパラメータは不採用）
//   cache: Map（key → entry。呼び出し側で region 単位に保持すると再計算を避けられる）
//   cacheTag: キャッシュキーに足す文字列（cellDelta 等、params 外の評価条件）
//   start: 初期値（既定 defaultTuneParams()）。defaultScore はこの点のスコア
//   align: 二段目を実行するか / size: 二段目で sizeDelta も探索するか / flag: {aborted}
//   delayMs: 各評価後の待ち（0 なら setTimeout 0 でUIへ譲る）/ onProgress(evalsDone)
// 戻り値 { params, score, defaultScore, evals, aborted, cs }
export async function searchTune(opts) {
  const { evalFn, cache = new Map(), cacheTag = "", flag = null, delayMs = 0, onProgress = null } = opts;
  const doAlign = opts.align !== false;
  const doSize = opts.size !== false;
  const bgFixed = opts.bgMode === "none"; // §53: 背景透過「なし」→ bg/glow 軸は探索しない
  const d = { ...defaultTuneParams(), ...(opts.start || {}) };
  let evals1 = 0, evals2 = 0;
  const keyOf = (p) => `${p.bgThreshold}|${p.glowWidth}|${p.edgeProtect}|${p.satProtect}|${p.offsetDX}|${p.offsetDY}|${p.sizeDelta}|${cacheTag}`;
  const evalP = async (p, stage) => {
    const key = keyOf(p);
    if (cache.has(key)) return cache.get(key);
    if (stage === 1 ? evals1 >= TUNE_MAX_EVALS : evals2 >= TUNE_MAX_ALIGN_EVALS) return null; // 上限ガード
    if (stage === 1) evals1++; else evals2++;
    let score = Infinity, cs = 0;
    try {
      const r = await evalFn({ ...p });
      score = r.score; cs = r.cs || 0;
    } catch { /* 不透明画素なし等 → そのパラメータは不採用 */ }
    const entry = { params: { ...p }, score, cs };
    cache.set(key, entry);
    if (onProgress) onProgress(evals1 + evals2);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    else await new Promise((r) => setTimeout(r, 0)); // UIへ譲る（非同期・§43.2）
    return entry;
  };
  const results = [];
  const push = (r) => { if (r) results.push(r); return r; };
  const aborted = () => !!(flag && flag.aborted);

  // 初期値（= ユーザーが今見ている設定）のスコア。レポート・改善判定の基準
  const defEntry = push(await evalP(d, 1));
  // 一段目: bgThreshold × glowWidth（edge/sat/整列は初期値）
  outer1: for (const bgT of (bgFixed ? [] : TUNE_BG_STEPS)) {
    for (const glow of TUNE_GLOW_STEPS) {
      if (aborted()) break outer1;
      push(await evalP({ ...d, bgThreshold: bgT, glowWidth: glow }, 1));
    }
  }
  // 上位2つに対し edgeProtect × satProtect を粗く
  const top = [...results].filter((r) => r.score !== Infinity).sort((a, b) => a.score - b.score).slice(0, 2);
  outer2: for (const t of top) {
    for (const edge of TUNE_EDGE_STEPS) {
      for (const sat of TUNE_SAT_STEPS) {
        if (aborted()) break outer2;
        push(await evalP({ ...t.params, edgeProtect: edge, satProtect: sat }, 1));
      }
    }
  }
  const pickBest = () => {
    let best = null;
    for (const r of results) if (r.score !== Infinity && (!best || r.score < best.score - 1e-9)) best = r;
    return best;
  };
  // 二段目: 整列（§52.2）。一段目のベストを起点に粗→細
  if (doAlign && !aborted()) {
    let base = pickBest();
    const s = base && base.cs > 0 ? base.cs : 0;
    if (base && s > 0) {
      const nine = (c, step) => {
        const out = [];
        for (const dx of [-step, 0, step]) for (const dy of [-step, 0, step]) {
          if (dx === 0 && dy === 0) continue;
          out.push({ ...c.params, offsetDX: r2(c.params.offsetDX + dx), offsetDY: r2(c.params.offsetDY + dy) });
        }
        return out;
      };
      for (const step of [s / 4, s / 8]) {
        for (const p of nine(base, step)) {
          if (aborted()) break;
          push(await evalP(p, 2));
        }
        base = pickBest() || base;
      }
      if (doSize && !aborted()) {
        const u = Math.max(0.25, s * 0.02);
        for (const k of [2, 1]) {
          for (const sg of [-1, 1]) {
            if (aborted()) break;
            push(await evalP({ ...base.params, sizeDelta: r2(base.params.sizeDelta + sg * k * u) }, 2));
          }
          base = pickBest() || base;
        }
      }
    }
  }
  let best = pickBest();
  if (!best) best = { params: { ...d }, score: Infinity, cs: 0 };
  return {
    params: { ...best.params },
    score: best.score,
    defaultScore: defEntry ? defEntry.score : Infinity,
    evals: evals1 + evals2,
    aborted: aborted(),
    cs: best.cs,
  };
}
