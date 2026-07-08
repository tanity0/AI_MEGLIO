// convert.js — §18.2 変換スタジオの画像処理パイプライン（純関数群）+ §18.3 メインパレット抽出
// 背景除去 → 疑似グリッド推定（セル内分散最小） → 支配色サンプリング → k-means減色

// ---------------------------------------------------------------------------
// 色ユーティリティ
// ---------------------------------------------------------------------------
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
  const { bgColor = null, threshold = 48, glowWidth = 0 } = opts;
  const out = new Uint8ClampedArray(data);

  // 自動背景色: 外周ピクセルの最頻色（16段量子化）
  let bg = bgColor;
  if (!bg) {
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
    let best = null;
    for (const e of counts.values()) if (!best || e.n > best.n) best = e;
    if (best) bg = [best.r / best.n, best.g / best.n, best.b / best.n];
  }

  const isBgLike = (o) => {
    if (out[o + 3] < 32) return true; // 元から透明
    if (!bg) return false;
    const dr = out[o] - bg[0], dg = out[o + 1] - bg[1], db = out[o + 2] - bg[2];
    return dr * dr + dg * dg + db * db <= threshold * threshold;
  };

  // 外周からのフラッドフィル
  const visited = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }
  const flat = [];
  for (let i = 0; i < stack.length; i += 2) flat.push([stack[i], stack[i + 1]]);
  while (flat.length) {
    const [x, y] = flat.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const idx = y * w + x;
    if (visited[idx]) continue;
    visited[idx] = 1;
    const o = idx * 4;
    if (!isBgLike(o)) continue;
    out[o + 3] = 0;
    flat.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
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
export function convertImage(data, w, h, params) {
  const { s, ox, oy, targetH = 0, colors = 64, domBlend = 0.15, centerWeight = 0.5, edgeProtect = 0.3, satProtect = 0.5 } = params;

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
    cs = (y1 - y0 + 1) / targetH;
    gx0 = x0; gy0 = y0;
  } else {
    cs = s;
    gx0 = x0 - (((x0 - ox) % s) + s) % s;
    gy0 = y0 - (((y0 - oy) % s) + s) % s;
  }
  const cols = Math.ceil((x1 + 1 - gx0) / cs);
  const rows = Math.ceil((y1 + 1 - gy0) / cs);
  if (cols > 128 || rows > 128) {
    throw new Error(`出力が128pxを超えます（${cols}×${rows}）。解像度を下げてください`);
  }

  // セルごとの代表色
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
      // 支配色⇔平均ブレンド
      r = r * (1 - domBlend) + (mr / mw) * domBlend;
      g = g * (1 - domBlend) + (mg / mw) * domBlend;
      b = b * (1 - domBlend) + (mb / mw) * domBlend;
      // 輪郭保護: 暗い輪郭色が一定割合あれば優先
      if (edgeProtect > 0 && darkW / mw >= Math.max(0.12, 0.5 - 0.38 * edgeProtect)) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= 90) { r = dr / darkW; g = dg / darkW; b = db / darkW; }
      }
      cellColors[cy * cols + cx] = [r, g, b];
    }
  }

  // 減色: 頻度加重 k-means（++シード + 孤立色相保護）
  const uniq = new Map();
  for (const c of cellColors) {
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
