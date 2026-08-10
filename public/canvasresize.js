// canvasresize.js — §28 キャンバスのリサイズ
// 足元アンカー基準でキャンバスを拡大/縮小する。フロント主体（サーバーは width/height 8〜512 のみ関与）。
import { hexToRgba, recompositeFrame } from "./app.js";

const MIN_SIZE = 16;
const MAX_SIZE = 512; // §79: 256→512（§70.1の漏れ再発防止でここを最初に確認）

// アンカー id -> [横, 縦]（l/m/r, t/m/b）
const ANCHOR_AXES = {
  tl: ["l", "t"], tm: ["m", "t"], tr: ["r", "t"],
  ml: ["l", "m"], mm: ["m", "m"], mr: ["r", "m"],
  bl: ["l", "b"], bm: ["m", "b"], br: ["r", "b"],
};
const DEFAULT_ANCHOR = "bm"; // 下中央＝足元

// 旧内容の左上が新キャンバスに載る位置 (dx,dy) を算出
function anchorOffset(anchor, W, H, W2, H2) {
  const [h, v] = ANCHOR_AXES[anchor] || ANCHOR_AXES[DEFAULT_ANCHOR];
  const dx = h === "l" ? 0 : h === "r" ? W2 - W : Math.floor((W2 - W) / 2);
  const dy = v === "t" ? 0 : v === "b" ? H2 - H : Math.floor((H2 - H) / 2);
  return { dx, dy };
}

// (dx,dy) でピクセルを新キャンバスへコピー（範囲外は破棄、はみ出た側は透明=0のまま）
function resizePixelArray(pixels, W, H, W2, H2, dx, dy) {
  const out = new Uint8Array(W2 * H2);
  for (let y = 0; y < H; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= H2) continue;
    const srcRow = y * W;
    const dstRow = ny * W2;
    for (let x = 0; x < W; x++) {
      const nx = x + dx;
      if (nx < 0 || nx >= W2) continue;
      out[dstRow + nx] = pixels[srcRow + x];
    }
  }
  return out;
}

// 縮小によって非透明画素が切れるかどうかを判定
function willClip(project, W2, H2, dx, dy) {
  const { width: W, height: H, palette, frames, baseFrame } = project;
  const isOpaque = (idx) => {
    const hex = palette[idx];
    if (!hex) return false;
    return hexToRgba(hex)[3] !== 0;
  };
  const checkOne = (pixels) => {
    for (let y = 0; y < H; y++) {
      const ny = y + dy;
      const srcRow = y * W;
      for (let x = 0; x < W; x++) {
        if (!isOpaque(pixels[srcRow + x])) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= W2 || ny < 0 || ny >= H2) return true;
      }
    }
    return false;
  };
  if (baseFrame && checkOne(baseFrame)) return true;
  for (const f of frames) if (checkOne(f.pixels)) return true;
  return false;
}

// (dx,dy) を lockedRects に適用し、新キャンバス範囲でクランプ（面積0になったものは破棄）
function resizeLockedRects(lockedRects, W2, H2, dx, dy) {
  const out = [];
  for (const r of lockedRects || []) {
    const x0 = Math.max(0, r.x + dx);
    const y0 = Math.max(0, r.y + dy);
    const x1 = Math.min(W2, r.x + r.w + dx);
    const y1 = Math.min(H2, r.y + r.h + dy);
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

// プロジェクトへキャンバスリサイズを適用（呼び出し側で pushUndo 済みを想定）
export function applyResizeToProject(project, W2, H2, anchor) {
  const W = project.width, H = project.height;
  const { dx, dy } = anchorOffset(anchor, W, H, W2, H2);
  for (const f of project.frames) {
    // §35: 全レイヤーをリサイズしてから合成キャッシュを再構築（単一レイヤーは共有再構築）
    if (Array.isArray(f.layers) && f.layers.length > 0) {
      for (const l of f.layers) l.pixels = resizePixelArray(l.pixels, W, H, W2, H2, dx, dy);
      f.pixels = null;
      recompositeFrame(f);
    } else {
      f.pixels = resizePixelArray(f.pixels, W, H, W2, H2, dx, dy);
    }
  }
  if (project.baseFrame) project.baseFrame = resizePixelArray(project.baseFrame, W, H, W2, H2, dx, dy);
  project.lockedRects = resizeLockedRects(project.lockedRects, W2, H2, dx, dy);
  if (project.rig && Array.isArray(project.rig.parts)) {
    for (const p of project.rig.parts) {
      p.patch.x += dx;
      p.patch.y += dy;
      // pivot はパッチ内ローカル座標なので不変。part.layerPixels があればパッチ相対のためそのまま維持。
    }
  }
  project.width = W2;
  project.height = H2;
  return { dx, dy };
}

export function initCanvasResize(store, toast) {
  const openBtn = document.getElementById("canvasResizeBtn");
  const sizeLabel = document.getElementById("canvasSizeLabel");
  const modal = document.getElementById("canvasResizeModal");
  const currentSizeEl = document.getElementById("crCurrentSize");
  const widthInput = document.getElementById("crWidthInput");
  const heightInput = document.getElementById("crHeightInput");
  const anchorGrid = document.getElementById("crAnchorGrid");
  const anchorCells = Array.from(anchorGrid.querySelectorAll(".cr-anchor-cell"));
  const applyBtn = document.getElementById("crApplyBtn");
  const cancelBtn = document.getElementById("crCancelBtn");
  const closeBtn = document.getElementById("crCloseBtn");

  let selectedAnchor = DEFAULT_ANCHOR;

  function setAnchor(anchor) {
    selectedAnchor = anchor;
    for (const cell of anchorCells) cell.classList.toggle("is-active", cell.dataset.anchor === anchor);
  }

  function closeModal() {
    modal.hidden = true;
  }

  function openModal() {
    const p = store.state.project;
    currentSizeEl.textContent = `${p.width} x ${p.height}`;
    widthInput.value = String(p.width);
    heightInput.value = String(p.height);
    setAnchor(DEFAULT_ANCHOR);
    modal.hidden = false;
    widthInput.focus();
  }

  for (const cell of anchorCells) {
    cell.addEventListener("click", () => setAnchor(cell.dataset.anchor));
  }

  openBtn.addEventListener("click", openModal);
  sizeLabel.addEventListener("click", openModal);
  cancelBtn.addEventListener("click", closeModal);
  closeBtn.addEventListener("click", closeModal);

  applyBtn.addEventListener("click", () => {
    const project = store.state.project;
    const W2 = Math.round(Number(widthInput.value));
    const H2 = Math.round(Number(heightInput.value));
    if (!Number.isInteger(W2) || W2 < MIN_SIZE || W2 > MAX_SIZE || !Number.isInteger(H2) || H2 < MIN_SIZE || H2 > MAX_SIZE) {
      toast(`幅・高さは ${MIN_SIZE}〜${MAX_SIZE} の範囲で指定してください`, "error");
      return;
    }
    const W = project.width, H = project.height;
    if (W2 === W && H2 === H) {
      closeModal();
      return;
    }
    const { dx, dy } = anchorOffset(selectedAnchor, W, H, W2, H2);
    if ((W2 < W || H2 < H) && willClip(project, W2, H2, dx, dy)) {
      if (!window.confirm("一部が切り取られます。続けますか？")) return;
    }
    store.pushUndo();
    applyResizeToProject(project, W2, H2, selectedAnchor);
    store.clampAfterProjectChange();
    store.notify();
    toast(`キャンバスを ${W2} x ${H2} にリサイズしました`);
    closeModal();
  });
}
