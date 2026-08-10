// convert.js — §18.2 変換スタジオの画像処理パイプライン（純関数群）+ §18.3 メインパレット抽出
// 背景除去 → 疑似グリッド推定（セル内分散最小） → 支配色サンプリング → k-means減色

// ---------------------------------------------------------------------------
// 色ユーティリティ
// ---------------------------------------------------------------------------
// §70/§79: 出力キャンバスの上限（§18.1の128 → 256 → 512）
export const MAX_OUT = 512; // §79: 256→512

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// 背景除去（§18.2-1）: 外周フラッドフィル + フチ光彩除去
// data は破壊せず、alpha を書き換えた新しい Uint8ClampedArray を返す
// ---------------------------------------------------------------------------
export function removeBackground(data, w, h, opts = {}) {
  const { bgColor = null, threshold = 48, glowWidth = 0, multiBg = false } = opts;
  const out = new Uint8ClampedArray(data);

  // 自動背景色: 外周ピクセルの最頻色（16段量子化）
  // §59.6: 外周がほぼ透明（60%以上）なら背景色の自動検出をしない。端に接した
  // スプライトの輪郭色を「背景」と誤検出し、閾値ぶんの暗色（黒い輪郭・足元）を
  // 外側から食い尽くす事故を防ぐ（透明背景の画像に色ベースの除去は不要）。
  let bg = bgColor;
  let skipAutoBg = false;
  if (!bg) {
    let border = 0, clearBorder = 0;
    const look = (x, y) => { border++; if (out[(y * w + x) * 4 + 3] < 32) clearBorder++; };
    for (let x = 0; x < w; x++) { look(x, 0); look(x, h - 1); }
    for (let y = 0; y < h; y++) { look(0, y); look(w - 1, y); }
    skipAutoBg = border > 0 && clearBorder / border >= 0.6;
  }
  if (!bg && !skipAutoBg) {
    const counts = new Map();
    const consider = (x, y) => {
      const o = (y * w + x) * 4;
      if (out[o + 3] < 32) return;
      const key = `${out[o] >> 4},${out[o + 1] >> 4},${out[o + 2] >> 4}`;
      const e = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += out[o]; e.g += out[o + 1]; e.b += out[o + 2];
      counts.set(key, e);
    };
    for (let x = 0; x < w; x++) { consider(x, 0); consider(x, h - 1); }
    for (let y = 0; y < h; y++) { consider(0, y); consider(w - 1, y); }
    const entries = [...counts.values()].sort((a, b) => b.n - a.n);
    if (entries.length) {
      const best = entries[0];
      bg = [best.r / best.n, best.g / best.n, best.b / best.n];
      // §65: 多色背景（市松・枠など）— 外周の8%以上を占める色クラスタを最大4件まで背景色に
      if (multiBg) {
        const total = entries.reduce((s, e) => s + e.n, 0);
        bg = entries.slice(0, 4).filter((e) => e.n >= Math.max(4, total * 0.08))
          .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
      }
    }
  }
  const bgColors = !bg ? [] : Array.isArray(bg[0]) ? bg : [bg];

  const isBgLike = (o) => {
    if (out[o + 3] < 32) return true; // 元から透明
    for (const c of bgColors) {
      const dr = out[o] - c[0], dg = out[o + 1] - c[1], db = out[o + 2] - c[2];
      if (dr * dr + dg * dg + db * db <= threshold * threshold) return true;
    }
    return false;
  };

  // 外周からのフラッドフィル
  // §65: multiBg 時は「除去済みの隣接画素と近い色」も連鎖して除去
  // （グラデーション背景を外側から食べ進む。キャラ輪郭=急な色差で止まる）
  const chainThr = multiBg && bgColors.length ? Math.min(28, threshold) : 0;
  const visited = new Uint8Array(w * h);
  const flat = [];
  for (let x = 0; x < w; x++) { flat.push([x, 0], [x, h - 1]); }
  for (let y = 0; y < h; y++) { flat.push([0, y], [w - 1, y]); }
  while (flat.length) {
    const [x, y, pr, pg, pb] = flat.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const idx = y * w + x;
    if (visited[idx]) continue;
    visited[idx] = 1;
    const o = idx * 4;
    let remove = isBgLike(o);
    if (!remove && chainThr > 0 && pr !== undefined) {
      const dr = out[o] - pr, dg = out[o + 1] - pg, db = out[o + 2] - pb;
      remove = dr * dr + dg * dg + db * db <= chainThr * chainThr;
    }
    if (!remove) continue;
    const wasOpaque = out[o + 3] >= 32;
    out[o + 3] = 0;
    if (chainThr > 0 && wasOpaque) {
      flat.push([x + 1, y, out[o], out[o + 1], out[o + 2]], [x - 1, y, out[o], out[o + 1], out[o + 2]],
        [x, y + 1, out[o], out[o + 1], out[o + 2]], [x, y - 1, out[o], out[o + 1], out[o + 2]]);
    } else {
      flat.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  // フチ光彩除去（§18.2-1）: 透明に隣接する帯（1〜glowWidth px）のうち、
  // 内部の主要色から色距離が遠いピクセルを除去
  if (glowWidth > 0) {
    // 透明からの距離（チェビシェフ・BFS層）
    const dist = new Int16Array(w * h).fill(32767);
    let frontier = [];
    for (let i = 0; i < w * h; i++) {
      if (out[i * 4 + 3] === 0) { dist[i] = 0; frontier.push(i); }
    }
    for (let d = 1; d <= glowWidth && frontier.length; d++) {
      const next = [];
      for (const idx of frontier) {
        const x = idx % w, y = (idx / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (dist[ni] > d && out[ni * 4 + 3] > 0) { dist[ni] = d; next.push(ni); }
        }
      }
      frontier = next;
    }
    // 内部（帯より奥）の主要色 上位24
    const interior = new Map();
    for (let i = 0; i < w * h; i++) {
      if (out[i * 4 + 3] === 0 || dist[i] <= glowWidth) continue;
      const o = i * 4;
      const key = `${out[o] >> 3},${out[o + 1] >> 3},${out[o + 2] >> 3}`;
      const e = interior.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += out[o]; e.g += out[o + 1]; e.b += out[o + 2];
      interior.set(key, e);
    }
    const tops = [...interior.values()].sort((a, b) => b.n - a.n).slice(0, 24)
      .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
    if (tops.length) {
      for (let i = 0; i < w * h; i++) {
        if (out[i * 4 + 3] === 0 || dist[i] > glowWidth) continue;
        const o = i * 4;
        let mind = Infinity;
        for (const t of tops) {
          const dr = out[o] - t[0], dg = out[o + 1] - t[1], db = out[o + 2] - t[2];
          const d2 = dr * dr + dg * dg + db * db;
          if (d2 < mind) mind = d2;
        }
        if (mind > 80 * 80) out[o + 3] = 0;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 疑似グリッド推定（§18.2-2）: セル内分散の総和が最小になる (s, ox, oy)
// 粗探索（縮小画像）→ 細探索。透明はマゼンタ番兵として合成。
// 縮退（小さすぎるs）対策: 最小分散の1.12倍以内で最大のsを採用。
// ---------------------------------------------------------------------------
function buildIntegrals(data, w, h) {
  const W = w + 1;
  const sum = [new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1))];
  const sq = [new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const t = data[o + 3] < 128;
      const vals = t ? [255, 0, 255] : [data[o], data[o + 1], data[o + 2]];
      for (let c = 0; c < 3; c++) {
        const v = vals[c];
        sum[c][(y + 1) * W + (x + 1)] = v + sum[c][y * W + (x + 1)] + sum[c][(y + 1) * W + x] - sum[c][y * W + x];
        sq[c][(y + 1) * W + (x + 1)] = v * v + sq[c][y * W + (x + 1)] + sq[c][(y + 1) * W + x] - sq[c][y * W + x];
      }
    }
  }
  return { sum, sq, W };
}

function varianceScore(integ, w, h, s, ox, oy) {
  const { sum, sq, W } = integ;
  let total = 0;
  let npx = 0;
  const startX = ox - Math.ceil(ox / s) * s;
  const startY = oy - Math.ceil(oy / s) * s;
  for (let cy = startY; cy < h; cy += s) {
    const y0 = Math.max(0, Math.round(cy));
    const y1 = Math.min(h, Math.round(cy + s));
    if (y1 <= y0) continue;
    for (let cx = startX; cx < w; cx += s) {
      const x0 = Math.max(0, Math.round(cx));
      const x1 = Math.min(w, Math.round(cx + s));
      if (x1 <= x0) continue;
      const n = (x1 - x0) * (y1 - y0);
      for (let c = 0; c < 3; c++) {
        const S = sum[c][y1 * W + x1] - sum[c][y0 * W + x1] - sum[c][y1 * W + x0] + sum[c][y0 * W + x0];
        const Q = sq[c][y1 * W + x1] - sq[c][y0 * W + x1] - sq[c][y1 * W + x0] + sq[c][y0 * W + x0];
        total += Q - (S * S) / n;
      }
      npx += n;
    }
  }
  return npx > 0 ? total / npx : Infinity;
}

function downsampleData(data, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return { data, w, h, scale: 1 };
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
      const so = (sy * w + sx) * 4;
      const dof = (y * dw + x) * 4;
      out[dof] = data[so]; out[dof + 1] = data[so + 1]; out[dof + 2] = data[so + 2]; out[dof + 3] = data[so + 3];
    }
  }
  return { data: out, w: dw, h: dh, scale };
}

export async function estimateGrid(data, w, h, onProgress) {
  // 粗探索（長辺320）
  const coarse = downsampleData(data, w, h, 320);
  const integA = buildIntegrals(coarse.data, coarse.w, coarse.h);
  const cands = [];
  let step = 0;
  for (let sSrc = 2; sSrc <= 40; sSrc += 0.5) {
    const sW = sSrc * coarse.scale;
    if (sW < 1.75) continue;
    const offStep = Math.max(0.5, sW / 6);
    for (let ox = 0; ox < sW; ox += offStep) {
      for (let oy = 0; oy < sW; oy += offStep) {
        cands.push([sSrc, sW, ox, oy, varianceScore(integA, coarse.w, coarse.h, sW, ox, oy)]);
      }
    }
    if (++step % 12 === 0) {
      if (onProgress) onProgress(`グリッド推定中（粗探索 ${Math.round(((sSrc - 2) / 38) * 100)}%）`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  cands.sort((a, b) => a[4] - b[4]);
  const minVar = cands[0][4];
  const medVar = cands[Math.floor(cands.length / 2)][4];
  // 最小分散の1.12倍以内で最大のセルサイズを採用（縮退対策）
  let best = cands[0];
  for (const c of cands) {
    if (c[4] <= minVar * 1.12 && c[0] > best[0]) best = c;
  }

  // 細探索（長辺1024・±1.0を0.25刻み、位相±2pxを0.25刻み）
  const fine = downsampleData(data, w, h, 1024);
  const integB = buildIntegrals(fine.data, fine.w, fine.h);
  const oxSrc0 = best[2] / coarse.scale;
  const oySrc0 = best[3] / coarse.scale;
  let bestFine = null;
  let i = 0;
  for (let sSrc = Math.max(2, best[0] - 1); sSrc <= best[0] + 1; sSrc += 0.25) {
    for (let dx = -2; dx <= 2; dx += 0.25) {
      for (let dy = -2; dy <= 2; dy += 0.25) {
        const sW = sSrc * fine.scale;
        const v = varianceScore(integB, fine.w, fine.h, sW, ((oxSrc0 + dx) % sSrc + sSrc) % sSrc * fine.scale, ((oySrc0 + dy) % sSrc + sSrc) % sSrc * fine.scale);
        if (!bestFine || v < bestFine.v) {
          bestFine = { s: sSrc, ox: ((oxSrc0 + dx) % sSrc + sSrc) % sSrc, oy: ((oySrc0 + dy) % sSrc + sSrc) % sSrc, v };
        }
      }
      if (++i % 40 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress("");
  const confidence = medVar > 0 ? Math.max(0, Math.min(1, 1 - bestFine.v / medVar)) : 0;
  return { s: bestFine.s, ox: bestFine.ox, oy: bestFine.oy, confidence };
}

// ---------------------------------------------------------------------------
// セル代表色サンプリング + 減色（§18.2-3,4,6）
// params: { s, ox, oy, targetH(0=1:1), colors, domBlend, centerWeight,
//           edgeProtect, satProtect }
// ---------------------------------------------------------------------------
// セル代表色サンプリング（共通ヘルパー・§18.2-3,6 / §20.2 で共用）
function sampleCellsRegion(data, w, h, { cs, gx0, gy0, cols, rows, domBlend, centerWeight, edgeProtect }) {
  const cellColors = new Array(cols * rows).fill(null);
  for (let cy = 0; cy < rows; cy++) {
    const py0 = Math.max(0, Math.round(gy0 + cy * cs));
    const py1 = Math.min(h, Math.round(gy0 + (cy + 1) * cs));
    for (let cx = 0; cx < cols; cx++) {
      const px0 = Math.max(0, Math.round(gx0 + cx * cs));
      const px1 = Math.min(w, Math.round(gx0 + (cx + 1) * cs));
      if (px1 <= px0 || py1 <= py0) continue;
      const midX = (px0 + px1) / 2, midY = (py0 + py1) / 2;
      const half = Math.max(1, (px1 - px0) / 2);
      const buckets = new Map(); // 5bit/ch量子化 → {wsum, r,g,b}
      let total = 0, opaque = 0;
      let mr = 0, mg = 0, mb = 0, mw = 0;
      let darkW = 0, dr = 0, dg = 0, db = 0;
      for (let py = py0; py < py1; py++) {
        for (let px = px0; px < px1; px++) {
          total++;
          const o = (py * w + px) * 4;
          if (data[o + 3] < 128) continue;
          opaque++;
          const ddx = (px + 0.5 - midX) / half, ddy = (py + 0.5 - midY) / half;
          const wgt = 1 + centerWeight * 2 * Math.exp(-(ddx * ddx + ddy * ddy) * 1.5);
          const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
          const e = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
          e.w += wgt; e.r += data[o] * wgt; e.g += data[o + 1] * wgt; e.b += data[o + 2] * wgt;
          buckets.set(key, e);
          mr += data[o] * wgt; mg += data[o + 1] * wgt; mb += data[o + 2] * wgt; mw += wgt;
          const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
          if (lum < 90) { darkW += wgt; dr += data[o] * wgt; dg += data[o + 1] * wgt; db += data[o + 2] * wgt; }
        }
      }
      if (opaque / total < 0.4) continue; // 非背景率<40% → 透明
      let bestB = null;
      for (const e of buckets.values()) if (!bestB || e.w > bestB.w) bestB = e;
      let r = bestB.r / bestB.w, g = bestB.g / bestB.w, b = bestB.b / bestB.w;
      r = r * (1 - domBlend) + (mr / mw) * domBlend;
      g = g * (1 - domBlend) + (mg / mw) * domBlend;
      b = b * (1 - domBlend) + (mb / mw) * domBlend;
      if (edgeProtect > 0 && darkW / mw >= Math.max(0.12, 0.5 - 0.38 * edgeProtect)) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= 90) { r = dr / darkW; g = dg / darkW; b = db / darkW; }
      }
      cellColors[cy * cols + cx] = [r, g, b];
    }
  }
  return cellColors;
}

// 減色（共通ヘルパー）: セル色配列（複数リージョン分の連結でよい）→ 重心
function quantizeCellColors(allCellColors, colors, satProtect) {
  const uniq = new Map();
  for (const c of allCellColors) {
    if (!c) continue;
    const key = `${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])}`;
    const e = uniq.get(key) || { c: [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])], n: 0 };
    e.n++;
    uniq.set(key, e);
  }
  const points = [...uniq.values()];
  const K = Math.min(colors, 255, points.length);
  let centroids;
  if (points.length <= K) {
    centroids = points.map((p) => p.c.slice());
  } else {
    centroids = kmeansSeeds(points, K, satProtect);
    for (let iter = 0; iter < 10; iter++) {
      const acc = centroids.map(() => [0, 0, 0, 0]);
      for (const p of points) {
        const ci = nearestIdx(centroids, p.c);
        const a = acc[ci];
        a[0] += p.c[0] * p.n; a[1] += p.c[1] * p.n; a[2] += p.c[2] * p.n; a[3] += p.n;
      }
      let moved = 0;
      for (let i = 0; i < centroids.length; i++) {
        if (acc[i][3] === 0) continue;
        const nc = [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]];
        moved += Math.abs(nc[0] - centroids[i][0]) + Math.abs(nc[1] - centroids[i][1]) + Math.abs(nc[2] - centroids[i][2]);
        centroids[i] = nc;
      }
      if (moved < 1) break;
    }
  }
  return centroids;
}

export function convertImage(data, w, h, params) {
  const { s, ox, oy, targetH = 0, colors = 64, domBlend = 0.15, centerWeight = 0.5, edgeProtect = 0.3, satProtect = 0.5, offsetDX = 0, offsetDY = 0, sizeDelta = 0 } = params;

  // 非透明のバウンディングボックス
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] >= 128) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("不透明ピクセルがありません（背景除去の閾値を下げてください）");

  // セルサイズと開始位相
  let cs, gx0, gy0;
  if (targetH > 0) {
    // §49.12: sizeDelta を反映後、0.5px 未満にはクランプ（幅128クランプより先）
    cs = (y1 - y0 + 1) / targetH + sizeDelta;
    if (cs < 0.5) cs = 0.5;
    gx0 = x0 + offsetDX; gy0 = y0 + offsetDY;
  } else {
    cs = s;
    gx0 = x0 - (((x0 - ox) % s) + s) % s;
    gy0 = y0 - (((y0 - oy) % s) + s) % s;
  }
  // 横長素材対策: 高さ指定モードでは幅も上限に収まるようセルサイズを自動クランプ（§79: 512）
  if (targetH > 0) {
    const minCsForWidth = (x1 + 1 - gx0) / (MAX_OUT - 0.5);
    if (cs < minCsForWidth) cs = minCsForWidth;
  }
  const cols = Math.ceil((x1 + 1 - gx0) / cs);
  const rows = Math.ceil((y1 + 1 - gy0) / cs);
  if (cols > MAX_OUT || rows > MAX_OUT) {
    throw new Error(`出力が${MAX_OUT}pxを超えます（${cols}×${rows}）。解像度を下げてください`);
  }

  const cellColors = sampleCellsRegion(data, w, h, { cs, gx0, gy0, cols, rows, domBlend, centerWeight, edgeProtect });
  const centroids = quantizeCellColors(cellColors, colors, satProtect);

  const palette = ["#00000000", ...centroids.map((c) => rgbToHex(c[0], c[1], c[2]))];
  const pixels = new Uint8Array(cols * rows);
  const counts = new Uint32Array(palette.length);
  for (let i = 0; i < cellColors.length; i++) {
    const c = cellColors[i];
    if (!c) { pixels[i] = 0; continue; }
    const idx = nearestIdx(centroids, c) + 1;
    pixels[i] = idx;
    counts[idx]++;
  }
  return { width: cols, height: rows, pixels, palette, counts, originX: gx0, originY: gy0, srcCellSize: cs };
}

// ---------------------------------------------------------------------------
// §20.1: 連結成分検出（8近傍・面積が最大成分の5%未満は無視）
// 行クラスタ（y重なり）→ 行内x順で並べて返す
// ---------------------------------------------------------------------------
export function detectComponents(data, w, h) {
  return detectComponentsDetailed(data, w, h).boxes;
}

// §63: detectComponents の詳細版。マージ後ボックスに加えて、マージ前の細分成分
// （重心つき）とラベルマップを返す。ストリップ分割で「どの画素がどのポーズか」を
// 矩形でなく連結成分で判定するために使う。
export function detectComponentsDetailed(data, w, h, opts = {}) {
  const labels = new Int32Array(w * h).fill(-1);
  const boxes = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1 || data[start * 4 + 3] < 128) continue;
    const label = boxes.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0, sx = 0, sy = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w, y = (idx / w) | 0;
      area++;
      sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (labels[ni] === -1 && data[ni * 4 + 3] >= 128) {
            labels[ni] = label;
            stack[sp++] = ni;
          }
        }
      }
    }
    boxes.push({ x0, y0, x1, y1, area, cx: sx / area, cy: sy / area });
  }
  if (!boxes.length) return { boxes: [], fine: [], labelMap: labels };
  // 近接ボックスのマージ: 同一ポーズ内の分離パーツ（銃先・帽子など）を1体に統合。
  // マージン = 最大ボックス辺の5%（最低8px）。ポーズ間の大きな間隔は維持される。
  let merged = boxes.map((b, i) => ({ ...b, labels: [i] }));
  const maxDim = Math.max(...merged.map((b) => Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1)));
  // §77: mergeMargin 指定で近接マージ距離を上書き可能（小さな変換後グリッドでは既定の
  // 最低8pxが広すぎてパーツ同士が融合するため）
  const margin = Number.isFinite(opts.mergeMargin) ? opts.mergeMargin : Math.max(8, Math.round(maxDim * 0.05));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        const overlapX = a.x0 - margin <= b.x1 && b.x0 - margin <= a.x1;
        const overlapY = a.y0 - margin <= b.y1 && b.y0 - margin <= a.y1;
        if (overlapX && overlapY) {
          merged[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
            area: a.area + b.area,
            labels: a.labels.concat(b.labels),
          };
          merged.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  const maxArea = Math.max(...merged.map((b) => b.area));
  const kept = merged.filter((b) => b.area >= maxArea * 0.05);
  // 行クラスタリング: y範囲が重なるものを同じ行に
  kept.sort((a, b) => a.y0 - b.y0);
  const rows = [];
  for (const b of kept) {
    const cy = (b.y0 + b.y1) / 2;
    let row = rows.find((r) => cy <= r.maxY1);
    if (!row) {
      row = { boxes: [], maxY1: b.y1 };
      rows.push(row);
    }
    row.boxes.push(b);
    row.maxY1 = Math.max(row.maxY1, b.y1);
  }
  const ordered = [];
  for (const row of rows) {
    row.boxes.sort((a, b) => a.x0 - b.x0);
    ordered.push(...row.boxes);
  }
  return { boxes: ordered, fine: boxes, labelMap: labels };
}

// ---------------------------------------------------------------------------
// §20.2: マルチポーズシート → Nフレーム変換
// 共通キャンバス（最大box+パディング・128クランプ）、下端中央 or 中央アライン、
// 共通パレット（全ポーズ一括k-means）、共通セルサイズ
// ---------------------------------------------------------------------------
export function convertSheetImage(data, w, h, params, boxes, align = "bottom") {
  const { s, targetH = 0, colors = 64, domBlend = 0.15, centerWeight = 0.5, edgeProtect = 0.3, satProtect = 0.5, offsetDX = 0, offsetDY = 0, sizeDelta = 0 } = params;
  if (!boxes || boxes.length < 1) throw new Error("分割対象がありません");

  const maxBoxW = Math.max(...boxes.map((b) => b.x1 - b.x0 + 1));
  const maxBoxH = Math.max(...boxes.map((b) => b.y1 - b.y0 + 1));

  // 共通セルサイズ（最大ポーズ基準）。§49.12: sizeDelta を反映後、0.5px 未満はクランプ（幅128クランプより先）
  let cs = targetH > 0 ? maxBoxH / targetH + sizeDelta : s;
  if (targetH > 0 && cs < 0.5) cs = 0.5;
  // モーション用パディング: 左右2セル・上2セル・下0（接地）
  const PAD_X = 2, PAD_TOP = 2, PAD_BOTTOM = 0;
  // 上限クランプ（§18.1→§70→§79: 512）
  cs = Math.max(cs, maxBoxW / (MAX_OUT - PAD_X * 2), maxBoxH / (MAX_OUT - PAD_TOP - PAD_BOTTOM));
  const poseColsMax = Math.ceil(maxBoxW / cs);
  const poseRowsMax = Math.ceil(maxBoxH / cs);
  const outW = Math.min(MAX_OUT, poseColsMax + PAD_X * 2);
  const outH = Math.min(MAX_OUT, poseRowsMax + PAD_TOP + PAD_BOTTOM);

  // 各ポーズのセル色をサンプリング（グリッドはポーズboxの下端に揃える）
  const poseCells = [];
  for (const b of boxes) {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const cols = Math.min(poseColsMax, Math.ceil(bw / cs));
    const rows = Math.min(poseRowsMax, Math.ceil(bh / cs));
    // 下端揃え・中央x（ポーズ内サンプリング原点）。§49.12: offsetDX/DY を適用
    const gy0 = b.y1 + 1 - rows * cs + offsetDY;
    const gx0 = (b.x0 + b.x1 + 1) / 2 - (cols * cs) / 2 + offsetDX;
    const cells = sampleCellsRegion(data, w, h, { cs, gx0, gy0, cols, rows, domBlend, centerWeight, edgeProtect });
    poseCells.push({ cells, cols, rows });
  }

  // 共通パレット: 全ポーズのセル色を一括k-means（§20.2）
  const allColors = [];
  for (const p of poseCells) for (const c of p.cells) if (c) allColors.push(c);
  if (!allColors.length) throw new Error("不透明ピクセルがありません（背景除去の閾値を下げてください）");
  const centroids = quantizeCellColors(allColors, colors, satProtect);
  const palette = ["#00000000", ...centroids.map((c) => rgbToHex(c[0], c[1], c[2]))];
  const counts = new Uint32Array(palette.length);

  // 共通キャンバスへ配置（下端中央 / 中央）
  const framesPixels = [];
  for (const p of poseCells) {
    const pixels = new Uint8Array(outW * outH);
    const offX = Math.floor((outW - p.cols) / 2);
    const offY = align === "center" ? Math.floor((outH - p.rows) / 2) : outH - PAD_BOTTOM - p.rows;
    for (let y = 0; y < p.rows; y++) {
      for (let x = 0; x < p.cols; x++) {
        const c = p.cells[y * p.cols + x];
        if (!c) continue;
        const tx = offX + x, ty = offY + y;
        if (tx < 0 || ty < 0 || tx >= outW || ty >= outH) continue;
        const idx = nearestIdx(centroids, c) + 1;
        pixels[ty * outW + tx] = idx;
        counts[idx]++;
      }
    }
    framesPixels.push(pixels);
  }
  return {
    width: outW,
    height: outH,
    pixels: framesPixels[0],
    framesPixels,
    palette,
    counts,
    originX: boxes[0].x0,
    originY: boxes[0].y0,
    srcCellSize: cs,
  };
}

// ---------------------------------------------------------------------------
// §30: フレーム別変換設定（サイズ・共有パレットは固定）
// 各フレームは自前の背景除去つまみ + サンプリングつまみを持つ。
// pass1: 各フレームをそのフレーム別つまみで RGB サンプリング → 全フレーム結合で1つの共有パレット抽出。
// pass2: 各フレームを共有パレットへ最近色マッピング。
// → 全フレームのパレット配列が完全一致（アニメのチラつき防止）。
//
// rawData: 元画像 RGBA（背景除去前・共通）。boxes: 各フレームの領域（rawData座標）。
// global: { targetH, colors, oneToOne, s }
// perFrameParams[i]: { bgThreshold, glowWidth, domBlend, centerWeight, edgeProtect, satProtect, offsetDX, offsetDY }
// ---------------------------------------------------------------------------
// 各ボックスを margin だけ広げる。隣接ボックス（垂直/水平で射影が重なるもの）とは
// 半間隔でクランプして他ポーズ領域に食い込まないようにする。
function expandBoxesForPerFrame(boxes, w, h) {
  const maxDim = Math.max(...boxes.map((b) => Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1)));
  const M = Math.max(4, Math.round(maxDim * 0.2));
  return boxes.map((b, i) => {
    let x0 = Math.max(0, b.x0 - M), y0 = Math.max(0, b.y0 - M);
    let x1 = Math.min(w - 1, b.x1 + M), y1 = Math.min(h - 1, b.y1 + M);
    for (let j = 0; j < boxes.length; j++) {
      if (j === i) continue;
      const o = boxes[j];
      const overlapY = !(o.y1 < b.y0 || o.y0 > b.y1);
      const overlapX = !(o.x1 < b.x0 || o.x0 > b.x1);
      if (o.x0 > b.x1 && overlapY) x1 = Math.min(x1, Math.floor((b.x1 + o.x0) / 2));
      if (o.x1 < b.x0 && overlapY) x0 = Math.max(x0, Math.ceil((o.x1 + b.x0) / 2));
      if (o.y0 > b.y1 && overlapX) y1 = Math.min(y1, Math.floor((b.y1 + o.y0) / 2));
      if (o.y1 < b.y0 && overlapX) y0 = Math.max(y0, Math.ceil((o.y1 + b.y0) / 2));
    }
    return { x0, y0, x1, y1 };
  });
}

export function convertFramesShared(rawData, w, h, global, boxes, perFrameParams, align = "bottom") {
  const { targetH = 64, colors = 64, oneToOne = false, s = 8 } = global || {};
  const N = boxes.length;
  if (N < 1) throw new Error("フレームがありません");

  // 各ボックスをマージン分だけ広げる（フレーム別背景除去がポーズ周縁のフリンジに効くように）。
  // 隣接ボックスとの半間隔でクランプして他ポーズを取り込まない。
  const regions = expandBoxesForPerFrame(boxes, w, h);

  // pass0: フレームごとに背景除去（フレーム別つまみ）→ その領域内の不透明bbox
  const frameBg = [];
  const bboxes = [];
  for (let i = 0; i < N; i++) {
    const pf = perFrameParams[i] || {};
    const bg = removeBackground(rawData, w, h, { threshold: pf.bgThreshold ?? 48, glowWidth: pf.glowWidth ?? 0 });
    frameBg.push(bg);
    const reg = regions[i];
    let x0 = reg.x1 + 1, y0 = reg.y1 + 1, x1 = reg.x0 - 1, y1 = reg.y0 - 1;
    for (let y = reg.y0; y <= reg.y1; y++) {
      for (let x = reg.x0; x <= reg.x1; x++) {
        if (bg[(y * w + x) * 4 + 3] >= 128) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    bboxes.push(x1 >= reg.x0 ? { x0, y0, x1, y1 } : null);
  }
  const valid = bboxes.filter(Boolean);
  if (!valid.length) throw new Error("不透明ピクセルがありません（背景除去の閾値を下げてください）");

  // 共通セルサイズ（最大ポーズ基準）・共通キャンバス（128クランプ・パディング）
  const maxBoxW = Math.max(...valid.map((b) => b.x1 - b.x0 + 1));
  const maxBoxH = Math.max(...valid.map((b) => b.y1 - b.y0 + 1));
  let cs = oneToOne ? s : maxBoxH / targetH;
  const PAD_X = 2, PAD_TOP = 2, PAD_BOTTOM = 0;
  cs = Math.max(cs, maxBoxW / (MAX_OUT - PAD_X * 2), maxBoxH / (MAX_OUT - PAD_TOP - PAD_BOTTOM));
  const poseColsMax = Math.ceil(maxBoxW / cs);
  const poseRowsMax = Math.ceil(maxBoxH / cs);
  const outW = Math.min(MAX_OUT, poseColsMax + PAD_X * 2);
  const outH = Math.min(MAX_OUT, poseRowsMax + PAD_TOP + PAD_BOTTOM);

  // pass1: 各フレームをフレーム別つまみでサンプリング（下端揃え・中央x）
  const poseCells = [];
  for (let i = 0; i < N; i++) {
    const bbox = bboxes[i];
    if (!bbox) { poseCells.push(null); continue; }
    const pf = perFrameParams[i] || {};
    const bw = bbox.x1 - bbox.x0 + 1, bh = bbox.y1 - bbox.y0 + 1;
    const cols = Math.min(poseColsMax, Math.ceil(bw / cs));
    const rows = Math.min(poseRowsMax, Math.ceil(bh / cs));
    const gy0 = bbox.y1 + 1 - rows * cs + (pf.offsetDY || 0);
    const gx0 = (bbox.x0 + bbox.x1 + 1) / 2 - (cols * cs) / 2 + (pf.offsetDX || 0);
    const cells = sampleCellsRegion(frameBg[i], w, h, {
      cs, gx0, gy0, cols, rows,
      domBlend: pf.domBlend ?? 0.15,
      centerWeight: pf.centerWeight ?? 0.5,
      edgeProtect: pf.edgeProtect ?? 0.3,
    });
    poseCells.push({ cells, cols, rows, bbox });
  }

  // 共有パレット: 全フレームのセル色を結合して1回だけ k-means（→ 全フレーム同一パレット）
  const allColors = [];
  for (const p of poseCells) if (p) for (const c of p.cells) if (c) allColors.push(c);
  if (!allColors.length) throw new Error("不透明ピクセルがありません（背景除去の閾値を下げてください）");
  // satProtect は共有パレット抽出に効く。フレーム別に持てるが決定的にするため最大値を採用。
  const satProtect = Math.max(...perFrameParams.map((pf) => (pf && typeof pf.satProtect === "number") ? pf.satProtect : 0.5));
  const centroids = quantizeCellColors(allColors, colors, satProtect);
  const palette = ["#00000000", ...centroids.map((c) => rgbToHex(c[0], c[1], c[2]))];
  const counts = new Uint32Array(palette.length);

  // pass2: 各フレームを共有パレットへ最近色マッピング → 共通キャンバスへ配置
  const framesPixels = [];
  for (const p of poseCells) {
    const pixels = new Uint8Array(outW * outH);
    if (p) {
      const offX = Math.floor((outW - p.cols) / 2);
      const offY = align === "center" ? Math.floor((outH - p.rows) / 2) : outH - PAD_BOTTOM - p.rows;
      for (let y = 0; y < p.rows; y++) {
        for (let x = 0; x < p.cols; x++) {
          const c = p.cells[y * p.cols + x];
          if (!c) continue;
          const tx = offX + x, ty = offY + y;
          if (tx < 0 || ty < 0 || tx >= outW || ty >= outH) continue;
          const idx = nearestIdx(centroids, c) + 1;
          pixels[ty * outW + tx] = idx;
          counts[idx]++;
        }
      }
    }
    framesPixels.push(pixels);
  }

  const firstValid = bboxes.find(Boolean);
  return {
    width: outW, height: outH,
    pixels: framesPixels[0], framesPixels,
    palette, counts,
    originX: firstValid.x0, originY: firstValid.y0,
    srcCellSize: cs,
    frameBBoxes: bboxes,
  };
}

function nearestIdx(centroids, c) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const dr = centroids[i][0] - c[0], dg = centroids[i][1] - c[1], db = centroids[i][2] - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// 頻度加重 k-means++ シード + 孤立色相の優先シード（§18.2-4 / 彩度保護つまみ）
function kmeansSeeds(points, K, satProtect) {
  const seeds = [];
  // 孤立色相の保護シード: 彩度が高く、より高頻度の色から色相が離れている色
  if (satProtect > 0) {
    const withHue = points
      .map((p) => ({ p, hsv: rgbToHsv(p.c[0], p.c[1], p.c[2]) }))
      .filter((e) => e.hsv[1] > 0.25 && e.hsv[2] > 0.15);
    const isolated = [];
    for (const e of withHue) {
      let isolatedHue = true;
      for (const o of withHue) {
        if (o === e || o.p.n < e.p.n * 3) continue;
        if (hueDist(o.hsv[0], e.hsv[0]) < 40) { isolatedHue = false; break; }
      }
      if (isolatedHue) isolated.push(e);
    }
    isolated.sort((a, b) => b.p.n - a.p.n);
    const nProtect = Math.min(isolated.length, Math.max(0, Math.round(satProtect * K * 0.25)));
    for (let i = 0; i < nProtect; i++) seeds.push(isolated[i].p.c.slice());
  }
  // k-means++（頻度加重）
  if (seeds.length === 0) {
    let heaviest = points[0];
    for (const p of points) if (p.n > heaviest.n) heaviest = p;
    seeds.push(heaviest.c.slice());
  }
  while (seeds.length < K) {
    let sum = 0;
    const d2s = points.map((p) => {
      let bd = Infinity;
      for (const s of seeds) {
        const dr = s[0] - p.c[0], dg = s[1] - p.c[1], db = s[2] - p.c[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) bd = d;
      }
      const v = bd * p.n;
      sum += v;
      return v;
    });
    if (sum === 0) break;
    let r = Math.random() * sum;
    let pick = 0;
    for (let i = 0; i < points.length; i++) { r -= d2s[i]; if (r <= 0) { pick = i; break; } }
    seeds.push(points[pick].c.slice());
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// §18.3 メインパレット抽出: フルパレットを使用数で重み付けし k-means
// 戻り値: { colors: [hex...], groups: [mainIndex per full index]（index0は-1）}
// ---------------------------------------------------------------------------
export function extractMainPalette(palette, counts, mainCount = 32) {
  const points = [];
  for (let i = 1; i < palette.length; i++) {
    const hex = palette[i].replace("#", "");
    points.push({
      c: [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)],
      n: Math.max(1, counts ? counts[i] || 0 : 1),
      full: i,
    });
  }
  const K = Math.min(mainCount, points.length);
  let centroids = kmeansSeeds(points, K, 0.5);
  for (let iter = 0; iter < 12; iter++) {
    const acc = centroids.map(() => [0, 0, 0, 0]);
    for (const p of points) {
      const ci = nearestIdx(centroids, p.c);
      const a = acc[ci];
      a[0] += p.c[0] * p.n; a[1] += p.c[1] * p.n; a[2] += p.c[2] * p.n; a[3] += p.n;
    }
    for (let i = 0; i < centroids.length; i++) {
      if (acc[i][3] > 0) centroids[i] = [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]];
    }
  }
  const groups = new Array(palette.length).fill(-1);
  for (const p of points) groups[p.full] = nearestIdx(centroids, p.c);
  return {
    colors: centroids.map((c) => rgbToHex(c[0], c[1], c[2])),
    groups,
  };
}

// ---------------------------------------------------------------------------
// §59.2: 真ドット絵の無劣化1:1変換（変換スタジオ用）
// 「整数倍スケールのドット絵（全体で≤255色・アルファ込み）」を検出したら、
// 推定グリッド＋減色のリサンプリングを使わず、ブロック中心の色をそのまま採用する。
// 検出はラン長GCD（原点に依らない）＋変化点の mod ヒストグラムでグリッド原点を推定。
// ---------------------------------------------------------------------------
export function detectExactPixelArt(data, w, h) {
  // ラン長GCDでブロックサイズ（import.js detectBlockSize と同ロジック・アルファ込み）
  const px = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 8) return -1;
    return (((data[i + 3] << 24) | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) >>> 0);
  };
  let g = 0;
  const scan = (outer, inner, at) => {
    for (let a = 0; a < outer; a++) {
      let run = 1, prev = at(a, 0);
      for (let b = 1; b < inner; b++) {
        const c = at(a, b);
        if (c === prev) run++;
        else {
          g = gcd2(g, run);
          if (g === 1) return false;
          run = 1;
          prev = c;
        }
      }
      g = gcd2(g, run);
      if (g === 1) return false;
    }
    return true;
  };
  if (!scan(h, w, (y, x) => px(x, y)) || !scan(w, h, (x, y) => px(x, y))) return { ok: false };
  const block = Math.max(1, g);

  // 色数（≤255・アルファ込み）
  const colors = new Set();
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] < 8) continue;
    colors.add((((data[o + 3] << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]) >>> 0));
    if (colors.size > 255) return { ok: false };
  }
  if (!colors.size) return { ok: false };

  // グリッド原点: 色の変化点位置 mod block の最頻値（クリーンな絵なら全変化点が一致する）
  const originOf = (horizontal) => {
    if (block === 1) return 0;
    const hist = new Array(block).fill(0);
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    for (let a = 0; a < outer; a++) {
      let prev = horizontal ? px(0, a) : px(a, 0);
      for (let b = 1; b < inner; b++) {
        const c = horizontal ? px(b, a) : px(a, b);
        if (c !== prev) hist[b % block]++;
        prev = c;
      }
    }
    let best = 0;
    for (let i = 1; i < block; i++) if (hist[i] > hist[best]) best = i;
    return hist.some((v) => v > 0) ? best : 0;
  };
  // §59.4: 原点候補でセル均一率を検証（真のN倍ドット絵なら全セルが単色のはず）。
  // 合格しない場合は無劣化モードを無効にする（黙ってズレた絵を出さない）。
  const uniformity = (ox, oy) => {
    let total = 0, uniform = 0;
    for (let cy = 0; ; cy++) {
      const y0 = oy + cy * block;
      if (y0 >= h) break;
      for (let cx = 0; ; cx++) {
        const x0 = ox + cx * block;
        if (x0 >= w) break;
        let first = null, same = true, any = false;
        for (let y = y0; y < Math.min(h, y0 + block); y++) {
          for (let x = x0; x < Math.min(w, x0 + block); x++) {
            const c = px(x, y);
            if (c === -1) continue;
            any = true;
            if (first === null) first = c;
            else if (c !== first) { same = false; }
          }
        }
        if (!any) continue; // 全透明セルは判定外
        total++;
        if (same) uniform++;
      }
    }
    return total ? uniform / total : 0;
  };
  const candidates = [[originOf(true), originOf(false)], [0, 0]];
  for (const [ox, oy] of candidates) {
    if (block === 1 || uniformity(ox, oy) >= 0.99) {
      return { ok: true, block, ox, oy, colors: colors.size };
    }
  }
  return { ok: false };
}

function gcd2(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// boxes（元画像座標）をブロック格子へスナップし、各セル中心の色をそのまま採用。
// 戻り値は convertSheetImage / convertFramesShared と同形（共通キャンバス・共有パレット）。
export function convertFramesExact(data, w, h, boxes, align = "bottom", info) {
  const { block, ox, oy } = info;
  if (!boxes || !boxes.length) throw new Error("フレームがありません");
  const snapped = boxes.map((b) => {
    const cx0 = Math.floor((b.x0 - ox) / block);
    const cx1 = Math.floor((b.x1 - ox) / block);
    const cy0 = Math.floor((b.y0 - oy) / block);
    const cy1 = Math.floor((b.y1 - oy) / block);
    return { cx0, cy0, cols: cx1 - cx0 + 1, rows: cy1 - cy0 + 1 };
  });
  const PAD_X = 2, PAD_TOP = 2, PAD_BOTTOM = 0;
  const outW = Math.max(...snapped.map((s) => s.cols)) + PAD_X * 2;
  const outH = Math.max(...snapped.map((s) => s.rows)) + PAD_TOP + PAD_BOTTOM;
  if (outW > MAX_OUT || outH > MAX_OUT) throw new Error(`無劣化1:1では出力が${MAX_OUT}pxを超えます（${outW}×${outH}）。無劣化を外して解像度指定で変換してください`);

  // §59.4: セル内の全ピクセル多数決（中心1点だと原点の推定誤差で1マス幅の輪郭が消える）
  const sample = (cx, cy) => {
    const x0 = Math.max(0, ox + cx * block);
    const y0 = Math.max(0, oy + cy * block);
    const x1 = Math.min(w, x0 + block);
    const y1 = Math.min(h, y0 + block);
    const local = new Map();
    let transparent = 0, opaque = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        if (data[o + 3] < 8) { transparent++; continue; }
        opaque++;
        const key = (((data[o + 3] << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]) >>> 0);
        local.set(key, (local.get(key) || 0) + 1);
      }
    }
    if (!opaque || transparent > opaque) return null;
    let bestKey = null, bestN = 0;
    for (const [k, n] of local) if (n > bestN) { bestN = n; bestKey = k; }
    return { key: bestKey };
  };

  // pass1: 全フレームの出現色 → 頻度順の共有パレット（#rrggbbaa・≤255は検出済み）
  const freq = new Map();
  for (const s of snapped) {
    for (let cy = 0; cy < s.rows; cy++) {
      for (let cx = 0; cx < s.cols; cx++) {
        const c = sample(s.cx0 + cx, s.cy0 + cy);
        if (c) freq.set(c.key, (freq.get(c.key) || 0) + 1);
      }
    }
  }
  const kept = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 255);
  const keyToIndex = new Map();
  kept.forEach((k, i) => keyToIndex.set(k, i + 1));
  const palette = ["#00000000", ...kept.map((k) => {
    const a = (k >>> 24) & 255, r = (k >>> 16) & 255, gg = (k >>> 8) & 255, b = k & 255;
    const rgb = "#" + [r, gg, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return a < 255 ? rgb + a.toString(16).padStart(2, "0") : rgb;
  })];

  // pass2: 共通キャンバスへ配置（下端中央 / 中央）。§59.7: 各フレームの出力(0,0)が
  // 元画像のどこに当たるか（frameOrigins）も返す（比較ビューの位置合わせ用）
  const counts = new Uint32Array(palette.length);
  const frameOrigins = [];
  const framesPixels = snapped.map((s) => {
    const pixels = new Uint8Array(outW * outH);
    const offX = Math.floor((outW - s.cols) / 2);
    const offY = align === "center" ? Math.floor((outH - s.rows) / 2) : outH - PAD_BOTTOM - s.rows;
    frameOrigins.push({ x: ox + (s.cx0 - offX) * block, y: oy + (s.cy0 - offY) * block });
    for (let cy = 0; cy < s.rows; cy++) {
      for (let cx = 0; cx < s.cols; cx++) {
        const c = sample(s.cx0 + cx, s.cy0 + cy);
        if (!c) continue;
        const idx = keyToIndex.get(c.key) || 0;
        pixels[(offY + cy) * outW + (offX + cx)] = idx;
        counts[idx]++;
      }
    }
    return pixels;
  });
  return {
    width: outW,
    height: outH,
    pixels: framesPixels[0],
    framesPixels,
    palette,
    counts,
    originX: frameOrigins[0].x,
    originY: frameOrigins[0].y,
    frameOrigins, // §59.7
    srcCellSize: block,
    exact: true,
  };
}
