// gif.js — GIF89a エンコーダ（自前実装・依存なし）
// LZW圧縮を含む最小構成のアニメーションGIFエンコーダ。
import { hexToRgba } from "./app.js";

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
  writeBits(value, count) {
    for (let i = 0; i < count; i++) {
      const bit = (value >> i) & 1;
      this.bitBuffer |= bit << this.bitCount;
      this.bitCount++;
      if (this.bitCount === 8) {
        this.bytes.push(this.bitBuffer);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }
  getBytes() {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuffer);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
    return this.bytes;
  }
}

// GIF標準のLZW可変長符号化（LSBファースト、コードサイズは255時に拡張、4096到達でクリア）
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const writer = new BitWriter();

  let dict, codeSize, nextCode;
  function resetDict() {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  }
  resetDict();
  writer.writeBits(clearCode, codeSize);

  let w = "";
  for (let n = 0; n < indices.length; n++) {
    const k = indices[n];
    const wk = w + String.fromCharCode(k);
    if (dict.has(wk)) {
      w = wk;
      continue;
    }
    writer.writeBits(dict.get(w), codeSize);
    if (nextCode < 4096) {
      dict.set(wk, nextCode);
      nextCode++;
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      writer.writeBits(clearCode, codeSize);
      resetDict();
    }
    w = String.fromCharCode(k);
  }
  if (w !== "") writer.writeBits(dict.get(w), codeSize);
  writer.writeBits(eoiCode, codeSize);
  return writer.getBytes();
}

function bitsForColorCount(n) {
  let b = 1;
  while (1 << b < n) b++;
  return b;
}

/**
 * project: { width, height, fps, palette: [hex,...], frames: [{pixels:Uint8Array}] }
 * 戻り値: Uint8Array（GIF89aバイナリ）
 */
// §25.9-4: ピンポン（往復）展開 — 端フレームを重複させない（4Fなら 1,2,3,4,3,2 の 2N-2 枚）
export function pingpongFrames(frames) {
  if (!Array.isArray(frames) || frames.length <= 2) return frames ? frames.slice() : [];
  return frames.concat(frames.slice(1, -1).reverse());
}

export function encodeGif(project) {
  const { width, height, fps, palette, frames } = project;
  if (!width || !height || !frames || !frames.length) throw new Error("不正なプロジェクトです");
  if (width > 0xffff || height > 0xffff) throw new Error("サイズが大きすぎます");

  const bitsPerPixel = Math.max(2, bitsForColorCount(Math.max(2, palette.length)));
  const gctSize = 1 << bitsPerPixel;

  const gct = new Uint8Array(gctSize * 3);
  let transparentIndex = -1;
  for (let i = 0; i < gctSize; i++) {
    const hex = palette[i] || "#000000";
    const [r, g, b, a] = hexToRgba(hex);
    gct[i * 3] = r;
    gct[i * 3 + 1] = g;
    gct[i * 3 + 2] = b;
    if (a === 0 && transparentIndex === -1) transparentIndex = i;
  }

  const bytes = [];
  const pushByte = (b) => bytes.push(b & 0xff);
  const pushShort = (v) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
  const pushStr = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
  const pushBytes = (arr) => { for (let i = 0; i < arr.length; i++) bytes.push(arr[i] & 0xff); };

  // --- ヘッダ + 論理画面記述子 ---
  pushStr("GIF89a");
  pushShort(width);
  pushShort(height);
  const packed = 0x80 | ((bitsPerPixel - 1) << 4) | (bitsPerPixel - 1); // GCTフラグ, 色深度, ソート無, GCTサイズ
  pushByte(packed);
  pushByte(0); // 背景色index
  pushByte(0); // ピクセルアスペクト比
  pushBytes(gct);

  // --- NETSCAPE2.0 拡張（無限ループ） ---
  pushByte(0x21); pushByte(0xff); pushByte(11);
  pushStr("NETSCAPE2.0");
  pushByte(3); pushByte(1); pushShort(0); pushByte(0);

  const delayCentis = Math.max(1, Math.round(100 / Math.max(1, fps)));

  for (const frame of frames) {
    // --- グラフィック制御拡張 ---
    pushByte(0x21); pushByte(0xf9); pushByte(4);
    const disposalMethod = 2; // 背景に復元（透明を正しく扱うため）
    const transparentFlag = transparentIndex >= 0 ? 1 : 0;
    pushByte((disposalMethod << 2) | transparentFlag);
    pushShort(delayCentis);
    pushByte(transparentIndex >= 0 ? transparentIndex : 0);
    pushByte(0);

    // --- 画像記述子 ---
    pushByte(0x2c);
    pushShort(0); pushShort(0); pushShort(width); pushShort(height);
    pushByte(0); // ローカルカラーテーブル無し・インターレース無し

    // --- LZW圧縮画像データ ---
    pushByte(bitsPerPixel); // LZW最小コードサイズ
    const lzwBytes = lzwEncode(frame.pixels, bitsPerPixel);
    let offset = 0;
    while (offset < lzwBytes.length) {
      const chunkLen = Math.min(255, lzwBytes.length - offset);
      pushByte(chunkLen);
      for (let i = 0; i < chunkLen; i++) pushByte(lzwBytes[offset + i]);
      offset += chunkLen;
    }
    pushByte(0); // サブブロック終端
  }

  pushByte(0x3b); // トレーラー
  return Uint8Array.from(bytes);
}
