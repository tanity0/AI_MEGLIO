// §114: 変換 op の実装本体。
//
// ここはワーカーとメインスレッド（フォールバック）の両方から読み込まれる。
// 同じコードが動くので「ワーカーのときだけ結果が違う」が起こらない。
//
// DOM には一切触らない（convert.js と同じ制約）。
import {
  removeBackground, estimateGrid, convertImage, convertSheetImage,
  convertFramesShared, convertFramesExact, detectComponents,
  detectExactPixelArt, applyFlatten, ALPHA_VISIBLE,
} from "./convert.js";

// 元画像と背景除去済み配列を保持する入れ物を作る。
// src.data / bg はここだけが持つ（§114.4: メモリを二重に持たない）。
export function createOps() {
  let src = null; // { data, w, h }
  let bg = null;  // 背景除去済み RGBA

  const needSrc = () => { if (!src) throw new Error("元画像が渡されていません"); };
  const needBg = () => { needSrc(); if (!bg) throw new Error("背景除去がまだ実行されていません"); };

  return {
    // 元画像を受け取る。呼び出し側は渡した配列をもう使わない約束
    // （ワーカー経路では transfer 済みで触れない）。
    setSource({ data, w, h }) {
      src = { data, w, h };
      bg = null;
      return { w, h };
    },

    // 背景つまみが変わったときのキャッシュ破棄
    clearBg() { bg = null; return {}; },

    hasSource() { return { has: !!src }; },

    // 背景除去 → 真ドット絵検出 → 連結成分検出。
    // studio.js の ensureBg が3回に分けて呼んでいたものを1往復にまとめる。
    prepare({ threshold, glowWidth }) {
      needSrc();
      if (!bg) bg = removeBackground(src.data, src.w, src.h, { threshold, glowWidth });
      return {
        exactInfo: detectExactPixelArt(bg, src.w, src.h),
        comps: detectComponents(bg, src.w, src.h),
      };
    },

    components() {
      needBg();
      return { comps: detectComponents(bg, src.w, src.h) };
    },

    // 進捗は onProgress 経由で呼び出し側へ逐次返す
    async estimateGrid(_payload, onProgress) {
      needBg();
      return await estimateGrid(bg, src.w, src.h, onProgress);
    },

    // 手動「横N×縦M均等分割」。各区画内の不透明bboxへ詰める（下端アラインを正確に）
    gridBoxes({ cols, rows }) {
      needBg();
      const { w, h } = src;
      const out = [];
      const cw = w / cols, ch = h / rows;
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const x0 = Math.round(rx * cw), x1 = Math.round((rx + 1) * cw) - 1;
          const y0 = Math.round(ry * ch), y1 = Math.round((ry + 1) * ch) - 1;
          let bx0 = x1 + 1, by0 = y1 + 1, bx1 = -1, by1 = -1;
          for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
              if (bg[(y * w + x) * 4 + 3] >= ALPHA_VISIBLE) { // §109
                if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
                if (y < by0) by0 = y; if (y > by1) by1 = y;
              }
            }
          }
          if (bx1 >= 0) out.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, area: 0 });
        }
      }
      return { boxes: out };
    },

    // 画像全体の不透明bbox（無劣化1:1の単体変換用）
    bbox({ alphaMin = 8 }) {
      needBg();
      const { w, h } = src;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (bg[(y * w + x) * 4 + 3] >= alphaMin) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      return x1 < 0 ? { box: null } : { box: { x0, y0, x1, y1 } };
    },

    // 背景除去が全ピクセルを消していないかの確認
    hasOpaque({ alphaMin = 128 }) {
      needBg();
      for (let i = 3; i < bg.length; i += 4) if (bg[i] >= alphaMin) return { has: true };
      return { has: false };
    },

    // 変換本体。kind は studio.js の4つの分岐と1対1。
    convert({ kind, params, boxes, align, global, frameParams, exactInfo, flatten }) {
      needBg();
      const { w, h } = src;
      let res;
      if (kind === "exact") {
        res = convertFramesExact(bg, w, h, boxes, align, exactInfo);
      } else if (kind === "shared") {
        // §30: 多フレームは背景除去前の生データを渡し、フレーム別に除去する
        res = convertFramesShared(src.data, w, h, global, boxes, frameParams, align);
      } else if (kind === "sheet") {
        res = convertSheetImage(bg, w, h, params, boxes, align);
      } else {
        res = convertImage(bg, w, h, params);
      }
      applyFlatten(res, flatten); // §99/§101（未指定・0なら中で素通り）
      return res;
    },
  };
}
