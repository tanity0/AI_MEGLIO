// import.js — 画像インポート（§13.1）
// PNG/GIF(1枚目)/WebP を読み込み、拡大率の自動検出・パレット抽出を行い、
// frame 0 = ベースフレームのプロジェクトを返す。

import { detectComponents } from "./convert.js"; // §78: シート判定

const MAX_SIZE = 256; // §70: 128→256
// §59: プロジェクトのパレット上限（256・§18.1のワイドパレット）に合わせる。
// 旧上限32のままだと、変換スタジオ（既定64色）で作った自作ドット絵の書き出しを
// 読み込み直したとき上位31色へ丸められ「少し崩れる」劣化が起きていた。
const MAX_COLORS = 256; // index 0 = 透明を含む

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// 各行・各列の同色ラン長のGCDからドット1個のブロックサイズを推定する
export function detectBlockSize(data, width, height) {
  let g = 0;
  const px = (x, y) => {
    const i = (y * width + x) * 4;
    // §59.1: ほぼ完全な透明のみ同一色として扱う（半透明はアルファ込みで色とみなす）
    if (data[i + 3] < 8) return -1;
    return (((data[i + 3] << 24) | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) >>> 0);
  };
  // 行方向のラン
  for (let y = 0; y < height; y++) {
    let run = 1;
    let prev = px(0, y);
    for (let x = 1; x < width; x++) {
      const c = px(x, y);
      if (c === prev) {
        run++;
      } else {
        g = gcd(g, run);
        if (g === 1) return 1;
        run = 1;
        prev = c;
      }
    }
    g = gcd(g, run);
    if (g === 1) return 1;
  }
  // 列方向のラン
  for (let x = 0; x < width; x++) {
    let run = 1;
    let prev = px(x, 0);
    for (let y = 1; y < height; y++) {
      const c = px(x, y);
      if (c === prev) {
        run++;
      } else {
        g = gcd(g, run);
        if (g === 1) return 1;
        run = 1;
        prev = c;
      }
    }
    g = gcd(g, run);
    if (g === 1) return 1;
  }
  // 画像サイズも割り切れる必要がある
  g = gcd(g, gcd(width, height));
  return Math.max(1, g);
}

// 最近傍で実寸グリッドにダウンサンプル（各ブロックの中心をサンプル）
function downsample(data, width, height, realW, realH) {
  const out = new Uint8ClampedArray(realW * realH * 4);
  for (let y = 0; y < realH; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / realH));
    for (let x = 0; x < realW; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / realW));
      const si = (sy * width + sx) * 4;
      const di = (y * realW + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return out;
}

// パレット抽出: 出現色を頻度順に列挙。上限を超えたら上位色+透明に量子化。
// §59.1: opts.alpha=true でアルファを色の一部として保持（#rrggbbaa）。
// 旧来の呼び出し（styleref.js 等）は既定 false のまま（RGBキー・alpha<128=透明）。
export function extractPalette(data, count, opts = {}) {
  const useAlpha = opts.alpha === true;
  const thr = useAlpha ? 8 : 128; // 透明とみなすアルファ閾値
  const keyAt = (o) => useAlpha
    ? (((data[o + 3] << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]) >>> 0)
    : ((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
  const freq = new Map(); // key -> count
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] < thr) continue; // 透明
    freq.set(keyAt(o), (freq.get(keyAt(o)) || 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const kept = sorted.slice(0, MAX_COLORS - 1);
  const keyToIndex = new Map();
  kept.forEach((key, i) => keyToIndex.set(key, i + 1));

  const parts = (key) => useAlpha
    ? [(key >>> 16) & 255, (key >>> 8) & 255, key & 255, (key >>> 24) & 255]
    : [(key >> 16) & 255, (key >> 8) & 255, key & 255, 255];
  const toHex = (key) => {
    const [r, g, b, a] = parts(key);
    const rgb = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return a < 255 ? rgb + a.toString(16).padStart(2, "0") : rgb; // §59.1: 半透明は #rrggbbaa
  };
  const palette = ["#00000000", ...kept.map(toHex)];

  // 収まらなかった色の最近色マップ（RGBA距離）
  const nearest = (key) => {
    const [r, g, b, a] = parts(key);
    let best = 1, bestD = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const [kr, kg, kb, ka] = parts(kept[i]);
      const d = (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2 + (a - ka) ** 2;
      if (d < bestD) { bestD = d; best = i + 1; }
    }
    return best;
  };
  for (const key of sorted.slice(MAX_COLORS - 1)) {
    keyToIndex.set(key, nearest(key));
  }

  return { palette, keyToIndex, totalColors: sorted.length, keyAt, alphaThreshold: thr };
}

function imageDataFromBitmap(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function parseSizeInput(text) {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(text || "");
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * §18.2: ショートカット判定 — ブロック検出が効き（≥2）、実寸≤128、
 * 生の色数が量子化不要な範囲の「真ドット絵」のみ従来経路。
 * §59: 上限を32→256に緩和（33色以上の自作ドット絵が変換スタジオへ回されて
 * リサンプリング劣化していた問題の修正）。
 */
export async function probeImage(file) {
  if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) return { shortcut: false };
  try {
    const bitmap = await createImageBitmap(file);
    const imageData = imageDataFromBitmap(bitmap);
    const data = imageData.data;
    const block = detectBlockSize(data, bitmap.width, bitmap.height);
    const realW = Math.max(1, Math.round(bitmap.width / block));
    const realH = Math.max(1, Math.round(bitmap.height / block));
    if (block < 2 && (bitmap.width > 256 || bitmap.height > 256)) return { shortcut: false }; // §70
    if (realW > 256 || realH > 256) return { shortcut: false }; // §70
    // 生の色数（量子化なし・§59.1: アルファ込み）
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      colors.add((((data[i + 3] << 24) | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) >>> 0));
      if (colors.size > MAX_COLORS - 1) return { shortcut: false }; // §59: 256色パレットまで無劣化経路
    }
    // §78: コマが並んだシート（透明背景で離れた塊が2つ以上）はスタジオへ回して
    // 自動フレーム分割の機会を残す。白背景の1枚絵は塊1つ＝従来どおり直接取り込み。
    let sheet = false;
    try {
      sheet = detectComponents(data, bitmap.width, bitmap.height).length >= 2;
    } catch {}
    return { shortcut: true, sheet };
  } catch {
    return { shortcut: false };
  }
}

/**
 * 画像ファイルからプロジェクトを構築する。
 * 戻り値: project オブジェクト（frame 0 = ベースフレーム、project.baseFrame 保持）
 *         null = ユーザーがダイアログでキャンセル
 */
export async function importImageFile(file) {
  if (!/^image\/(png|gif|webp)$/.test(file.type)) {
    throw new Error("PNG / GIF / WebP のみ対応しています");
  }
  const bitmap = await createImageBitmap(file); // GIFは1枚目のフレーム
  const { width, height } = bitmap;
  const imageData = imageDataFromBitmap(bitmap);
  const data = imageData.data;

  // 拡大率の自動検出
  const block = detectBlockSize(data, width, height);
  let realW = Math.max(1, Math.round(width / block));
  let realH = Math.max(1, Math.round(height / block));

  // ダイアログで確認（手動上書き可）
  const answer = prompt(
    `画像 ${width}×${height} を実寸 ${realW}×${realH} のドット絵として読み込みます。\n` +
      `よければこのままOK、実寸を変更する場合は「幅x高さ」を入力してください。`,
    `${realW}x${realH}`
  );
  if (answer === null) return null; // キャンセル
  const override = parseSizeInput(answer);
  if (!override) throw new Error("サイズの形式が不正です（例: 32x32）");
  realW = override.w;
  realH = override.h;

  if (realW < 1 || realH < 1) throw new Error("サイズが不正です");
  if (realW > MAX_SIZE || realH > MAX_SIZE) {
    throw new Error(`実寸 ${realW}×${realH} は上限（${MAX_SIZE}×${MAX_SIZE}）を超えています。画像を縮小するか、より大きなブロックサイズ（例: ${Math.ceil(realW / MAX_SIZE)}倍）を指定してください`);
  }

  // ダウンサンプル → パレット抽出 → ピクセル配列化（§59.1: 半透明色はアルファ込みで保持）
  const small = realW === width && realH === height ? data : downsample(data, width, height, realW, realH);
  const { palette, keyToIndex, keyAt, alphaThreshold } = extractPalette(small, realW * realH, { alpha: true });

  const pixels = new Uint8Array(realW * realH);
  for (let i = 0; i < realW * realH; i++) {
    const o = i * 4;
    if (small[o + 3] < alphaThreshold) { pixels[i] = 0; continue; }
    pixels[i] = keyToIndex.get(keyAt(o)) ?? 0;
  }

  const minDim = 8;
  // データモデルの下限(8)未満なら中央配置でパディング
  let outW = Math.max(minDim, realW);
  let outH = Math.max(minDim, realH);
  let outPixels = pixels;
  if (outW !== realW || outH !== realH) {
    outPixels = new Uint8Array(outW * outH);
    const ox = Math.floor((outW - realW) / 2);
    const oy = Math.floor((outH - realH) / 2);
    for (let y = 0; y < realH; y++) {
      for (let x = 0; x < realW; x++) {
        outPixels[(oy + y) * outW + (ox + x)] = pixels[y * realW + x];
      }
    }
  }

  const project = {
    width: outW,
    height: outH,
    fps: 8,
    palette,
    frames: [{ pixels: outPixels }],
    baseFrame: Uint8Array.from(outPixels),
    lockedRects: [],
    variants: [],
    profile: null,
  };
  project.tags = [{ name: "all", start: 0, end: 0, fps: 8, loop: true }];
  return project;
}
