// editor.js — キャンバス描画・ツール・選択
import {
  drawFrameToContext,
  drawPixels,
  hexToRgba,
  syncFrameLayers,
  frameActiveLayer,
  frameActiveLayerPixels,
  recompositeFrame,
  makeLayer,
} from "./app.js";
import { extractMainPalette } from "./convert.js";

const MIN_ZOOM = 2;
const MAX_ZOOM = 48;
const BRUSH_SIZES = [1, 2, 3, 4, 8];

export function initEditor(store, toast) {
  const canvas = document.getElementById("mainCanvas");
  const cursorCanvas = document.getElementById("cursorCanvas");
  const cctx = cursorCanvas.getContext("2d");
  const wrap = document.getElementById("canvasWrap");
  const ctx = canvas.getContext("2d");
  const onionModeSelect = document.getElementById("onionModeSelect");
  const onionOpacityRange = document.getElementById("onionOpacityRange");
  const onionOpacityLabel = document.getElementById("onionOpacityLabel");
  const diffToggle = document.getElementById("diffViewToggle");
  const gridToggle = document.getElementById("gridToggle");
  const gridMajorSelect = document.getElementById("gridMajorSelect");
  const mirrorToggle = document.getElementById("mirrorToggle");
  const mirrorAxisInput = document.getElementById("mirrorAxisInput");
  const fingerOffsetToggle = document.getElementById("fingerOffsetToggle"); // §50.3
  const colorReplaceBtn = document.getElementById("colorReplaceBtn");
  const colorReplacePanel = document.getElementById("colorReplacePanel");
  const colorReplaceFrom = document.getElementById("colorReplaceFrom");
  const colorReplaceTo = document.getElementById("colorReplaceTo");
  const colorReplaceExecBtn = document.getElementById("colorReplaceExecBtn");
  const colorReplaceCancelBtn = document.getElementById("colorReplaceCancelBtn");
  const floatPalette = document.getElementById("floatPalette");
  const floatPaletteTitlebar = document.getElementById("floatPaletteTitlebar");
  const floatPaletteCloseBtn = document.getElementById("floatPaletteCloseBtn");
  const floatPaletteToggleBtn = document.getElementById("floatPaletteToggleBtn");
  const floatPaletteTabs = document.getElementById("floatPaletteTabs");
  const floatPaletteScopeRow = document.getElementById("floatPaletteScopeRow");
  const floatPaletteAllFrames = document.getElementById("floatPaletteAllFrames");
  const floatPaletteGrid = document.getElementById("floatPaletteGrid");
  const lockSelectionBtn = document.getElementById("lockSelectionBtn");
  const clearLocksBtn = document.getElementById("clearLocksBtn");
  const lockCountEl = document.getElementById("lockCount");
  const zoomRange = document.getElementById("zoomRange");
  const zoomLabel = document.getElementById("zoomLabel");
  const clearSelectionBtn = document.getElementById("clearSelectionBtn");
  const paletteGrid = document.getElementById("paletteGrid");
  const paletteAddBtn = document.getElementById("paletteAddBtn");
  const mainPaletteRow = document.getElementById("mainPaletteRow");
  const mainPaletteGrid = document.getElementById("mainPaletteGrid");
  const mainPaletteReextractBtn = document.getElementById("mainPaletteReextractBtn");
  const mainPaletteCount = document.getElementById("mainPaletteCount");
  const canvasSizeLabel = document.getElementById("canvasSizeLabel");
  const cursorPosLabel = document.getElementById("cursorPosLabel");
  const toolButtons = Array.from(document.querySelectorAll(".tool-btn"));
  const brushSizeButtons = Array.from(document.querySelectorAll(".brush-size-btn"));

  // §31.2: ブラシサイズ（UIの初期状態が無ければ既定1px）
  if (!BRUSH_SIZES.includes(store.state.brushSize)) store.state.brushSize = 1;

  // §34.2: グリッド表示 ON/OFF と補助線Nは localStorage に保持
  const GRID_SHOW_KEY = "aiMeglio.grid.show";
  const GRID_MAJOR_KEY = "aiMeglio.grid.major";
  try {
    const savedShow = localStorage.getItem(GRID_SHOW_KEY);
    if (savedShow === "1") store.state.gridShow = true;
    else if (savedShow === "0") store.state.gridShow = false;
    const savedMajor = Number(localStorage.getItem(GRID_MAJOR_KEY));
    if (savedMajor === 8 || savedMajor === 16) store.state.gridMajor = savedMajor;
  } catch {}

  // §50.3: 指先オフセットモード（タッチのみ・既定OFF・localStorageに保持）。
  // ONで描画点を接触点の上方≈24px（CSS px。キャンバス座標はズームでセル単位に自然に丸まる）にずらす。
  const FINGER_OFFSET_KEY = "aiMeglio.fingerOffset";
  const FINGER_OFFSET_PX = 24;
  store.state.fingerOffset = false;
  try {
    if (localStorage.getItem(FINGER_OFFSET_KEY) === "1") store.state.fingerOffset = true;
  } catch {}

  let dragging = false;
  let dragTool = null;
  let dragStart = null; // {x,y} cell coords for select tool
  let lastPaintedCell = null;
  let lastCell = null; // ブレゼンハム補間の直前セル（§31.1: 高速ドラッグでも隙間なし）

  // §32: 選択範囲の変形（フローティング）。持ち上げ中はフレームを直接変更せず、
  // 確定（commit）時に pushUndo→焼き込み。Esc で取消。move ドラッグ用のグラブ情報も保持。
  // floating = { buf:Uint8Array(w*h), w, h, x, y, origX, origY, origW, origH, frameIndex, copy }
  let floating = null;
  let moveGrabCell = null; // ドラッグ開始セル
  let moveStartXY = null;  // ドラッグ開始時の floating.x/y

  function project() { return store.state.project; }

  // ------------------------------------------------------------------ §32
  function pointInRect(px, py, r) {
    return r && px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  }
  function currentSelRect() {
    const sel = store.state.selection;
    return sel && sel.frameIndex === store.state.currentFrame ? sel : null;
  }
  // フローティング中の当たり判定用の矩形（floating 優先、なければ現在フレームの選択）
  function activeMoveRect() {
    if (floating && floating.frameIndex === store.state.currentFrame) {
      return { x: floating.x, y: floating.y, w: floating.w, h: floating.h };
    }
    return currentSelRect();
  }
  // 現在の選択領域のピクセルをフローティングバッファへ持ち上げる（フレームは未変更）
  function liftSelection(copy) {
    const sel = currentSelRect();
    if (!sel || sel.w <= 0 || sel.h <= 0) return false;
    const p = project();
    const buf = new Uint8Array(sel.w * sel.h);
    const px = frameActiveLayerPixels(p.frames[sel.frameIndex]); // §35: 変形はアクティブレイヤー対象
    for (let yy = 0; yy < sel.h; yy++) {
      for (let xx = 0; xx < sel.w; xx++) {
        const sx = sel.x + xx, sy = sel.y + yy;
        if (sx >= 0 && sy >= 0 && sx < p.width && sy < p.height) {
          buf[yy * sel.w + xx] = px[sy * p.width + sx];
        }
      }
    }
    floating = {
      buf, w: sel.w, h: sel.h, x: sel.x, y: sel.y,
      origX: sel.x, origY: sel.y, origW: sel.w, origH: sel.h,
      frameIndex: sel.frameIndex, copy: !!copy,
    };
    return true;
  }
  // フローティングを現在フレームへ焼き込む（アンドゥ対象）
  function commitFloating() {
    if (!floating) return;
    const f = floating;
    floating = null; // 二重コミット防止
    const p = project();
    store.pushUndo();
    const frame = p.frames[f.frameIndex];
    const px = frameActiveLayerPixels(frame); // §35: アクティブレイヤーへ焼き込む
    // 元領域をクリア（コピー移動でなければ）
    if (!f.copy) {
      for (let yy = 0; yy < f.origH; yy++) {
        for (let xx = 0; xx < f.origW; xx++) {
          const dx = f.origX + xx, dy = f.origY + yy;
          if (dx >= 0 && dy >= 0 && dx < p.width && dy < p.height) px[dy * p.width + dx] = 0;
        }
      }
    }
    // フローティングを配置（非透明のみ焼く＝形状のみ移動、下地は残す）
    for (let yy = 0; yy < f.h; yy++) {
      for (let xx = 0; xx < f.w; xx++) {
        const v = f.buf[yy * f.w + xx];
        if (v === 0) continue;
        const dx = f.x + xx, dy = f.y + yy;
        if (dx >= 0 && dy >= 0 && dx < p.width && dy < p.height) px[dy * p.width + dx] = v;
      }
    }
    recompositeFrame(frame); // §35: 合成キャッシュ更新
    // 新しい選択 = 焼き込み後の矩形（キャンバス内でクランプ）
    store.state.selection = clampSelToCanvas(f.frameIndex, f.x, f.y, f.w, f.h);
    store.notify();
  }
  // フローティングを破棄（フレーム未変更なので元の選択に戻す）
  function cancelFloating() {
    if (!floating) return;
    const f = floating;
    floating = null;
    store.state.selection = clampSelToCanvas(f.frameIndex, f.origX, f.origY, f.origW, f.origH);
    store.notify();
  }
  function clampSelToCanvas(frameIndex, x, y, w, h) {
    const p = project();
    const x1 = Math.max(0, x), y1 = Math.max(0, y);
    const x2 = Math.min(p.width, x + w), y2 = Math.min(p.height, y + h);
    if (x2 <= x1 || y2 <= y1) return null;
    return { frameIndex, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  // 選択の表示矩形をフローティングに追従させる
  function syncSelToFloat() {
    if (!floating) return;
    store.state.selection = { frameIndex: floating.frameIndex, x: floating.x, y: floating.y, w: floating.w, h: floating.h };
  }
  // フローティングが無ければ選択から持ち上げる（変形ボタン用）
  function ensureFloat() {
    if (floating) return true;
    if (!currentSelRect()) return false;
    return liftSelection(false);
  }

  // 変形（buf/w/h を書き換え）— いずれも「きれい」（回転自由角のみ最近傍）
  function transformFlipH() {
    const f = floating, nb = new Uint8Array(f.w * f.h);
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) nb[y * f.w + x] = f.buf[y * f.w + (f.w - 1 - x)];
    f.buf = nb;
  }
  function transformFlipV() {
    const f = floating, nb = new Uint8Array(f.w * f.h);
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) nb[y * f.w + x] = f.buf[(f.h - 1 - y) * f.w + x];
    f.buf = nb;
  }
  function transformRot90() {
    // 時計回り: (sx,sy) -> (h-1-sy, sx)。寸法は w×h -> h×w。左上を固定してリサイズ。
    const f = floating, nw = f.h, nh = f.w, nb = new Uint8Array(nw * nh);
    for (let sy = 0; sy < f.h; sy++) {
      for (let sx = 0; sx < f.w; sx++) {
        const dx = f.h - 1 - sy, dy = sx;
        nb[dy * nw + dx] = f.buf[sy * f.w + sx];
      }
    }
    f.buf = nb; f.w = nw; f.h = nh;
  }
  function transformRotFree(deg) {
    const f = floating, nb = new Uint8Array(f.w * f.h);
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = (f.w - 1) / 2, cy = (f.h - 1) / 2;
    for (let dy = 0; dy < f.h; dy++) {
      for (let dx = 0; dx < f.w; dx++) {
        const rx = dx - cx, ry = dy - cy;
        const sx = Math.round(cos * rx + sin * ry + cx);
        const sy = Math.round(-sin * rx + cos * ry + cy);
        if (sx >= 0 && sy >= 0 && sx < f.w && sy < f.h) nb[dy * f.w + dx] = f.buf[sy * f.w + sx];
      }
    }
    f.buf = nb;
  }
  function applyTransform(fn) {
    if (!ensureFloat()) {
      toast("先に矩形選択ツールで範囲を選んでください", "error");
      return;
    }
    fn();
    syncSelToFloat();
    store.notify();
  }

  // ------------------------------------------------------------------ §33
  // コピー / 切り取り / 貼り付け。セッション内クリップボード（同一プロジェクト＝同一パレット前提）。
  // 貼り付けは §32 のフローティングとして生成し、移動/反転/回転・確定/取消・アンドゥ経路を再利用。
  let clipboard = null; // { buf:Uint8Array(w*h), w, h }
  function updateClipboardUi() {
    const btn = document.getElementById("selPasteBtn");
    if (btn) btn.disabled = !clipboard;
  }
  // 現在フレームの選択領域をクリップボードへ複製（フレーム未変更）
  function copySelectionToClipboard() {
    const sel = currentSelRect();
    if (!sel) return false;
    const p = project();
    const px = frameActiveLayerPixels(p.frames[sel.frameIndex]); // §35: コピペはアクティブレイヤー対象
    const buf = new Uint8Array(sel.w * sel.h);
    for (let yy = 0; yy < sel.h; yy++) {
      for (let xx = 0; xx < sel.w; xx++) {
        const sx = sel.x + xx, sy = sel.y + yy;
        if (sx >= 0 && sy >= 0 && sx < p.width && sy < p.height) buf[yy * sel.w + xx] = px[sy * p.width + sx];
      }
    }
    clipboard = { buf, w: sel.w, h: sel.h, x: sel.x, y: sel.y }; // x,y = コピー元位置（フレーム間貼付の初期位置に流用）
    updateClipboardUi();
    return true;
  }
  function doCopy() {
    if (floating) commitFloating(); // 保留中の変形を確定してから、見えているものをコピー
    if (!copySelectionToClipboard()) { toast("コピーする範囲を矩形選択してください", "error"); return; }
    toast(`コピーしました（${clipboard.w}×${clipboard.h}）`);
  }
  function doCut() {
    if (floating) commitFloating();
    const sel = currentSelRect();
    if (!sel) { toast("切り取る範囲を矩形選択してください", "error"); return; }
    copySelectionToClipboard();
    store.pushUndo();
    const p = project();
    const frame = p.frames[sel.frameIndex];
    const px = frameActiveLayerPixels(frame); // §35: 切り取りはアクティブレイヤー対象
    for (let yy = 0; yy < sel.h; yy++) {
      for (let xx = 0; xx < sel.w; xx++) {
        const dx = sel.x + xx, dy = sel.y + yy;
        if (dx >= 0 && dy >= 0 && dx < p.width && dy < p.height) px[dy * p.width + dx] = 0;
      }
    }
    recompositeFrame(frame);
    store.notify();
    toast(`切り取りました（${clipboard.w}×${clipboard.h}）`);
  }
  function doPaste() {
    if (!clipboard) { toast("クリップボードが空です", "error"); return; }
    if (floating) commitFloating();
    const p = project();
    const w = clipboard.w, h = clipboard.h;
    const sel = currentSelRect();
    // 初期位置: 現在フレームに選択があればその位置、無ければコピー元位置（フレーム間貼付で同位置に揃う）、
    // それも無ければキャンバス中央。
    let x, y;
    if (sel) { x = sel.x; y = sel.y; }
    else if (Number.isInteger(clipboard.x) && Number.isInteger(clipboard.y)) { x = clipboard.x; y = clipboard.y; }
    else { x = Math.floor((p.width - w) / 2); y = Math.floor((p.height - h) / 2); }
    // §32 のフローティングとして生成。copy=true（下地を消さない・新規内容の貼り付け）。
    floating = {
      buf: Uint8Array.from(clipboard.buf), w, h, x, y,
      origX: x, origY: y, origW: w, origH: h,
      frameIndex: store.state.currentFrame, copy: true,
    };
    store.state.tool = "select"; // 直後にドラッグ移動できるように
    syncSelToFloat();
    store.notify();
    toast("貼り付け: ドラッグで配置、変形も可、Enterで確定・Escで取消");
  }

  // ---------------------------------------------------------------------
  // §31.1性能: 重い render() をポインタ移動のたびに同期実行せず、
  // rAFで1フレーム1回にまとめる（高速ドラッグ・カーソル追従のもたつき対策）
  // ---------------------------------------------------------------------
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function computeAutoZoom() {
    const p = project();
    const availW = wrap.clientWidth - 8;
    const availH = wrap.clientHeight - 8;
    if (availW <= 0 || availH <= 0) return store.state.zoom;
    const z = Math.floor(Math.min(availW / p.width, availH / p.height));
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z || MIN_ZOOM));
  }

  function setZoom(z, opts = {}) {
    store.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
    if (!opts.keepAuto) store.state.zoomAuto = false;
    render();
    zoomRange.value = String(store.state.zoom);
    zoomLabel.textContent = `${store.state.zoom}x`;
  }

  function cellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const cellSize = store.state.zoom;
    // §50.3: 指先オフセットモード。タッチ入力のみ、接触点の上方≈24pxを描画点とする
    // （マウス/ペンは対象外＝pointerType厳密判定）。floorでセル境界に自然に丸まる。
    const offsetY = (store.state.fingerOffset && ev.pointerType === "touch") ? FINGER_OFFSET_PX : 0;
    const x = Math.floor((ev.clientX - rect.left) / cellSize);
    const y = Math.floor((ev.clientY - offsetY - rect.top) / cellSize);
    return { x, y };
  }

  function inBounds(x, y) {
    const p = project();
    return x >= 0 && y >= 0 && x < p.width && y < p.height;
  }

  // §35: ペン/消しゴムはアクティブレイヤーへ書き、合成キャッシュ（frame.pixels）を
  // 増分更新する（単一可視レイヤー時は共有参照なので追加コストなし）。
  function setPixel(frameIndex, x, y, colorIndex) {
    if (!inBounds(x, y)) return false;
    const p = project();
    const idx = y * p.width + x;
    const frame = p.frames[frameIndex];
    const pixels = frameActiveLayerPixels(frame);
    if (pixels[idx] === colorIndex) return false;
    pixels[idx] = colorIndex;
    if (frame.pixels !== pixels) {
      // 合成の増分更新: このセルだけ z順で「可視・非透明の最上位」を再決定
      let v = 0;
      for (const l of frame.layers) {
        if (l.visible !== false && l.pixels[idx] !== 0) v = l.pixels[idx];
      }
      frame.pixels[idx] = v;
    }
    return true;
  }

  // §34.3: 左右対称ミラー描画。軸は既定=キャンバス中央((width-1)/2)、
  // store.state.mirrorAxisX が数値なら任意軸。ピクセル座標 x の対称位置を返す。
  function mirrorAxisX() {
    const custom = store.state.mirrorAxisX;
    if (Number.isFinite(custom)) return custom;
    return (project().width - 1) / 2;
  }
  function mirrorX(x, axis) {
    return Math.round(2 * axis - x);
  }

  // §31.2: サイズ分の正方ブラシで1点を塗る（中心寄せ。size=1は従来どおり1px）
  // §34.3: mirrorDraw が ON なら、ブラシを構成する各ピクセルを縦軸対称位置にも同時に塗る
  // （ブラシサイズ・ブレゼンハム補間経由のストロークにも自然に適用される：paintStroke は
  // 補間した各点でこの関数を呼ぶため）。
  function paintBrushAt(frameIndex, cx, cy, colorIndex, size) {
    const half = Math.floor((size - 1) / 2);
    let changed = false;
    const mirror = store.state.mirrorDraw;
    const axis = mirror ? mirrorAxisX() : 0;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const px = cx - half + dx, py = cy - half + dy;
        if (setPixel(frameIndex, px, py, colorIndex)) changed = true;
        if (mirror) {
          const mx = mirrorX(px, axis);
          if (mx !== px && setPixel(frameIndex, mx, py, colorIndex)) changed = true;
        }
      }
    }
    return changed;
  }

  // §31.1: ブレゼンハムのセル列（始点・終点を含む、隙間なし）
  function bresenhamLine(x0, y0, x1, y1) {
    const pts = [];
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0, y = y0;
    while (true) {
      pts.push({ x, y });
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return pts;
  }

  // 直前セル→現在セルをブレゼンハムで結び、各点にブラシを乗せる
  function paintStroke(frameIndex, fromCell, toCell, colorIndex, size) {
    let changed = false;
    for (const pt of bresenhamLine(fromCell.x, fromCell.y, toCell.x, toCell.y)) {
      if (paintBrushAt(frameIndex, pt.x, pt.y, colorIndex, size)) changed = true;
    }
    return changed;
  }

  function floodFill(frameIndex, startX, startY, colorIndex) {
    const p = project();
    if (!inBounds(startX, startY)) return;
    const frame = p.frames[frameIndex];
    const pixels = frameActiveLayerPixels(frame); // §35: 塗りつぶしはアクティブレイヤー対象
    const target = pixels[startY * p.width + startX];
    if (target === colorIndex) return;
    const stack = [[startX, startY]];
    const seen = new Uint8Array(p.width * p.height);
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!inBounds(x, y)) continue;
      const idx = y * p.width + x;
      if (seen[idx]) continue;
      seen[idx] = 1;
      if (pixels[idx] !== target) continue;
      pixels[idx] = colorIndex;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    recompositeFrame(frame); // §35: 合成キャッシュ更新
  }

  function normalizedSelectionRect(a, b) {
    const p = project();
    const x1 = Math.max(0, Math.min(a.x, b.x));
    const y1 = Math.max(0, Math.min(a.y, b.y));
    const x2 = Math.min(p.width - 1, Math.max(a.x, b.x));
    const y2 = Math.min(p.height - 1, Math.max(a.y, b.y));
    return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
  }

  // ---------------------------------------------------------------------
  // ポインタ操作（§31.3: PointerEvents統一。mouse/touch/pen）
  // ---------------------------------------------------------------------
  // ペンの長押しスポイト（0.7秒静止で発動、離すと色を拾ってペンに戻る）。
  // 3方向ジェスチャー: 即離す=ドット / すぐ動かす=線 / 0.7秒静止=スポイト。
  const HOLD_EYEDROP_MS = 700;
  let holdTimer = null;
  let holdEyedrop = false;
  let holdStartCell = null;
  let pendingPen = null; // {x, y} 押下直後の未確定ドット
  function clearHoldTimer() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  }
  function pickColorAt(x, y) {
    const p = project();
    const frameIndex = store.state.currentFrame;
    if (!inBounds(x, y)) return;
    store.state.colorIndex = p.frames[frameIndex].pixels[y * p.width + x];
    fpPushRecent(store.state.colorIndex); // §37: スポイトで拾った色を「最近」へ
    store.notify();
  }

  // §31.3: 2本指トラッキング（パン・ピンチズーム用）。window捕捉フェーズで
  // 更新するため、canvas/wrap側のpointerdownハンドラより必ず先に走る。
  const touchPoints = new Map(); // pointerId -> {x, y}
  let pinch = null; // {startDist, startZoom, lastMidX, lastMidY}
  let pendingPinch = null;
  let pinchRafScheduled = false;

  function touchDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function touchMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  // §50.3: 2本指タップ=Undo・3本指タップ=Redo。
  // 判定: 2本指(または3本指)そろった時点を起点に、300ms以内・各指の移動が10px未満で
  // 全指が離れたら発火。パン/ピンチで実際に指が動いた場合や4本指以上が絡んだ場合は
  // moved扱いにして無効化する（既存の2本指パン/ピンチの挙動には一切手を入れない）。
  // タップ自体はstore.undo()/redo()を呼ぶだけで、描画ストロークのpushUndo/paintは
  // 一切行わない＝2本指開始時の既存abortStroke()（未確定の保留ドットを捨てるだけ）以上の
  // 副作用を持たない。
  const TAP_MS = 300;
  const TAP_MOVE_PX = 10;
  let tapGesture = null; // {startTime, maxCount, moved, starts:Map<pointerId,{x,y}>}

  function tapGestureBeginOrExtend() {
    if (!tapGesture) tapGesture = { startTime: performance.now(), maxCount: 0, moved: false, starts: new Map() };
    tapGesture.maxCount = Math.max(tapGesture.maxCount, touchPoints.size);
    for (const [id, pos] of touchPoints) {
      if (!tapGesture.starts.has(id)) tapGesture.starts.set(id, { x: pos.x, y: pos.y });
    }
  }
  function tapGestureCheckMove(ev) {
    if (!tapGesture) return;
    const start = tapGesture.starts.get(ev.pointerId);
    if (!start) return;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= TAP_MOVE_PX) tapGesture.moved = true;
  }
  function tapGestureFinish(cancelled) {
    if (!tapGesture) return;
    const g = tapGesture;
    tapGesture = null;
    if (cancelled || g.moved) return;
    if (performance.now() - g.startTime > TAP_MS) return;
    if (g.maxCount === 2) {
      if (!store.undo()) toast("これ以上元に戻せません");
    } else if (g.maxCount === 3) {
      if (!store.redo()) toast("これ以上やり直せません");
    }
  }

  function abortStroke() {
    clearHoldTimer();
    pendingPen = null;
    holdEyedrop = false;
    dragging = false;
    dragTool = null;
    dragStart = null;
    lastPaintedCell = null;
    lastCell = null;
    canvas.style.cursor = "";
  }

  window.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    touchPoints.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touchPoints.size === 2 || touchPoints.size === 3) {
      tapGestureBeginOrExtend(); // §50.3: 2本指/3本指タップの起点候補として記録
    } else if (touchPoints.size > 3 && tapGesture) {
      tapGesture.moved = true; // §50.3: 4本指以上が絡んだらタップ扱いにしない
    }
    if (touchPoints.size === 2) {
      // 2本指ジェスチャー開始：進行中の1本指ストロークやパンは中断してパン/ズームに切替
      abortStroke();
      panning = null;
      wrap.classList.remove("panning");
      const pts = Array.from(touchPoints.values());
      const mid = touchMid(pts[0], pts[1]);
      pinch = { startDist: touchDist(pts[0], pts[1]) || 1, startZoom: store.state.zoom, lastMidX: mid.x, lastMidY: mid.y };
    } else if (touchPoints.size > 2) {
      pinch = null; // 3本指以上は無視（パン/ピンチ対象外。タップ判定は続行）
    }
  }, true);

  // rAFフレーム到達前に指が離れても最後の増分を取りこぼさないよう、
  // 計算結果（mid/dist）をイベント時点でスナップショットしてから適用する。
  function flushPinch() {
    pinchRafScheduled = false;
    if (!pendingPinch || !pinch) { pendingPinch = null; return; }
    const { mid, dist } = pendingPinch;
    pendingPinch = null;
    wrap.scrollLeft -= mid.x - pinch.lastMidX;
    wrap.scrollTop -= mid.y - pinch.lastMidY;
    pinch.lastMidX = mid.x;
    pinch.lastMidY = mid.y;
    const nextZoom = Math.round(pinch.startZoom * (dist / pinch.startDist));
    if (nextZoom !== store.state.zoom) setZoom(nextZoom, { keepAuto: false });
  }

  window.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "touch" || !touchPoints.has(ev.pointerId)) return;
    touchPoints.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    tapGestureCheckMove(ev); // §50.3: 指が動いたらタップ扱いを取り消す（パン/ピンチ中も含め常時監視）
    if (touchPoints.size !== 2 || !pinch) return;
    const pts = Array.from(touchPoints.values());
    pendingPinch = { mid: touchMid(pts[0], pts[1]), dist: touchDist(pts[0], pts[1]) || 1 };
    if (pinchRafScheduled) return;
    pinchRafScheduled = true;
    requestAnimationFrame(flushPinch);
  }, true);

  function endTouch(ev) {
    if (ev.pointerType !== "touch") return;
    touchPoints.delete(ev.pointerId);
    if (touchPoints.size < 2) {
      flushPinch(); // 保留中の最終増分を破棄せず適用してから終了
      pinch = null;
    }
    if (touchPoints.size === 0) {
      // §50.3: 全指が離れた時点でタップ判定を確定（pointercancelは無効なタップとして破棄）
      tapGestureFinish(ev.type !== "pointerup");
    }
  }
  window.addEventListener("pointerup", endTouch, true);
  window.addEventListener("pointercancel", endTouch, true);

  // 空き領域の左ドラッグ / どこでも中ボタンドラッグで表示位置をパン
  let panning = null;
  let pendingPanPos = null;
  let panRafScheduled = false;
  wrap.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "touch" && touchPoints.size >= 2) return; // 2本指ジェスチャー中はパン開始しない
    const middle = ev.button === 1;
    if (!middle && (ev.button !== 0 || ev.target !== wrap)) return;
    panning = { x: ev.clientX, y: ev.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
    wrap.classList.add("panning");
    ev.preventDefault(); // 中ボタンのオートスクロールと、キャンバスの互換mousedownを抑止
  });
  window.addEventListener("pointermove", (ev) => {
    if (!panning) return;
    pendingPanPos = { clientX: ev.clientX, clientY: ev.clientY };
    if (panRafScheduled) return;
    panRafScheduled = true;
    requestAnimationFrame(() => {
      panRafScheduled = false;
      if (!panning || !pendingPanPos) return;
      wrap.scrollLeft = panning.left - (pendingPanPos.clientX - panning.x);
      wrap.scrollTop = panning.top - (pendingPanPos.clientY - panning.y);
    });
  });
  window.addEventListener("pointerup", () => {
    panning = null;
    wrap.classList.remove("panning");
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return; // 描画は左ボタン/主ボタンのみ（中ボタンはパン）
    if (ev.pointerType === "touch" && touchPoints.size >= 2) return; // 2本指ジェスチャー中は描画しない
    if (store.state.rigAdjustMode) return; // リグ調整モード中はrig.jsがドラッグを処理する
    const { x, y } = cellFromEvent(ev);
    // §50.3: 拡大鏡/指先オフセットマーカー用のホバー状態を、タッチはpointermoveが来る前に
    // ここで先行更新しておく（静止した長押しではpointermoveが発生しないため）。
    hoverCell = { x, y };
    hoverClient = { x: ev.clientX, y: ev.clientY };
    hoverIsTouch = ev.pointerType === "touch";
    const tool = store.state.tool;
    const frameIndex = store.state.currentFrame;

    // Alt+クリック = どのツールでも即スポイト
    if (ev.altKey && (tool === "pen" || tool === "eraser" || tool === "fill")) {
      pickColorAt(x, y);
      return;
    }

    ev.preventDefault(); // touch/penの互換mouseイベント・既定ジェスチャーを抑止（PointerEventsに一本化）

    // §32: フローティング中の処理。選択ツールでフロート内を押下＝移動継続、
    // それ以外（フロート外/描画ツール）は焼き込んでから通常処理へ。
    if (floating) {
      if (tool === "select" && pointInRect(x, y, activeMoveRect())) {
        dragging = true;
        dragTool = "move";
        moveGrabCell = { x, y };
        moveStartXY = { x: floating.x, y: floating.y };
        return;
      }
      commitFloating();
    }

    dragging = true;
    dragTool = tool;
    lastPaintedCell = null;
    lastCell = { x, y };

    if (tool === "pen") {
      // ペンは押下時点では打たない。すぐ離す=ドット / 動かす=線 / 0.7秒静止=スポイト（3方向ジェスチャー）
      pendingPen = { x, y };
      holdStartCell = `${x},${y}`;
      clearHoldTimer();
      holdTimer = setTimeout(() => {
        if (!dragging || dragTool !== "pen" || !pendingPen) return;
        pendingPen = null;
        holdEyedrop = true;
        dragTool = null;
        canvas.style.cursor = "copy";
        scheduleHoverUpdate(); // §50.3: 拡大鏡を即座に表示（次のpointermoveを待たない）
      }, HOLD_EYEDROP_MS);
    } else if (tool === "eraser") {
      store.pushUndo();
      if (paintBrushAt(frameIndex, x, y, 0, store.state.brushSize)) scheduleRender();
      lastPaintedCell = `${x},${y}`;
    } else if (tool === "fill") {
      store.pushUndo();
      floodFill(frameIndex, x, y, store.state.colorIndex);
      render();
    } else if (tool === "select") {
      // §32: 既存選択の内側を押下＝ピクセルを持ち上げて移動（Alt/⌥ でコピー移動）。
      // 外側を押下＝新規選択。
      const sel = currentSelRect();
      if (sel && pointInRect(x, y, sel)) {
        if (liftSelection(ev.altKey)) {
          dragTool = "move";
          moveGrabCell = { x, y };
          moveStartXY = { x: floating.x, y: floating.y };
          syncSelToFloat();
          store.notify();
        }
      } else {
        dragStart = { x, y };
        store.state.selection = { frameIndex, ...normalizedSelectionRect({ x, y }, { x, y }) };
        store.notify();
      }
    } else if (tool === "eyedropper") {
      pickColorAt(x, y);
    }
  });

  window.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const { x, y } = cellFromEvent(ev);
    const frameIndex = store.state.currentFrame;
    if (holdTimer && `${x},${y}` !== holdStartCell) clearHoldTimer();
    if (dragTool === "pen" && pendingPen && `${x},${y}` !== `${pendingPen.x},${pendingPen.y}`) {
      // 保留中のドットを起点に、動いた瞬間から即座に線を引き始める（移動しきい値=1セルでラグなし）。
      // 起点→現在点をブレゼンハムで補間するため、高速ドラッグでも隙間が出ない。
      store.pushUndo();
      paintStroke(frameIndex, pendingPen, { x, y }, store.state.colorIndex, store.state.brushSize);
      pendingPen = null;
      lastCell = { x, y };
      lastPaintedCell = `${x},${y}`;
      scheduleRender();
      return;
    }
    if ((dragTool === "pen" && !pendingPen) || dragTool === "eraser") {
      const key = `${x},${y}`;
      if (key !== lastPaintedCell) {
        const color = dragTool === "eraser" ? 0 : store.state.colorIndex;
        // 直前セル→現在セルをブレゼンハムで結んで塗る（高速ドラッグでも途切れない）
        const from = lastCell || { x, y };
        if (paintStroke(frameIndex, from, { x, y }, color, store.state.brushSize)) scheduleRender();
        lastPaintedCell = key;
        lastCell = { x, y };
      }
    } else if (dragTool === "select" && dragStart) {
      store.state.selection = { frameIndex, ...normalizedSelectionRect(dragStart, { x, y }) };
      store.notify();
    } else if (dragTool === "move" && floating) {
      // §32: フローティングをセルスナップで再配置
      floating.x = moveStartXY.x + (x - moveGrabCell.x);
      floating.y = moveStartXY.y + (y - moveGrabCell.y);
      syncSelToFloat();
      scheduleRender();
    }
  });

  window.addEventListener("pointerup", (ev) => {
    clearHoldTimer();
    if (holdEyedrop) {
      const { x, y } = cellFromEvent(ev);
      pickColorAt(x, y);
      holdEyedrop = false;
      canvas.style.cursor = "";
    } else if (pendingPen && dragTool === "pen") {
      // すぐ離した → ドット確定
      store.pushUndo();
      paintBrushAt(store.state.currentFrame, pendingPen.x, pendingPen.y, store.state.colorIndex, store.state.brushSize);
      render();
    } else if (dragging && (dragTool === "pen" || dragTool === "eraser")) {
      // ストローク終了：バッチ中の最終状態を確実に描画
      render();
    } else if (dragTool === "move") {
      // §32: 移動ドラッグ終了。フローティングは保持（Enter/ツール切替/枠外クリック/Escで確定or取消）。
      render();
    }
    pendingPen = null;
    dragging = false;
    dragTool = null;
    dragStart = null;
    lastPaintedCell = null;
    lastCell = null;
    moveGrabCell = null;
    moveStartXY = null;
    if (ev.pointerType === "touch") {
      // §50.3: タッチは離した後にhoverが残らないため、拡大鏡/オフセットマーカー/
      // ブラシ枠のゴースト表示を明示的に消す（離すと確定して消える）。
      hoverCell = null;
      hoverClient = null;
      hoverIsTouch = false;
    }
    scheduleHoverUpdate();
  });

  // ---------------------------------------------------------------------
  // §31.2 カーソルプレビュー（軽量オーバーレイ）
  // 専用の透明canvasに枠だけ描くため、ホバーのたびにキャンバス全体を
  // 再描画する必要がなく、高ズーム/大キャンバスでもカーソル追従が滑らか。
  // ---------------------------------------------------------------------
  let hoverCell = null;
  let hoverClient = null; // §50.3: 拡大鏡の画面配置に使うクライアント座標(x,y)
  let hoverIsTouch = false; // §50.3: 拡大鏡・指先オフセットマーカーはタッチのみ表示（デスクトップ非表示）
  let hoverRafScheduled = false;
  function scheduleHoverUpdate() {
    if (hoverRafScheduled) return;
    hoverRafScheduled = true;
    requestAnimationFrame(() => {
      hoverRafScheduled = false;
      updateHoverDisplay();
    });
  }
  function updateHoverDisplay() {
    if (hoverCell && inBounds(hoverCell.x, hoverCell.y)) {
      cursorPosLabel.textContent = `(${hoverCell.x}, ${hoverCell.y})`;
    } else {
      cursorPosLabel.textContent = "";
    }
    renderCursorOverlay();
  }
  function syncCursorCanvasSize() {
    const p = project();
    const cellSize = store.state.zoom;
    const w = p.width * cellSize, h = p.height * cellSize;
    if (cursorCanvas.width !== w || cursorCanvas.height !== h) {
      cursorCanvas.width = w;
      cursorCanvas.height = h;
      cursorCanvas.style.width = w + "px";
      cursorCanvas.style.height = h + "px";
    }
  }
  // §34.2: グリッド表示（オーバーレイ層=cursorCanvas。書き出しPNG/GIFは別経路で
  // project.pixelsを読むだけなのでここに描いても混入しない）。1セル格子 + Nセル毎の太い補助線。
  function drawGridOverlay() {
    if (!store.state.gridShow) return;
    const p = project();
    const cellSize = store.state.zoom;
    const major = store.state.gridMajor === 16 ? 16 : 8;
    cctx.save();
    cctx.strokeStyle = "rgba(255,255,255,0.16)";
    cctx.lineWidth = 1;
    for (let x = 0; x <= p.width; x++) {
      if (x % major === 0) continue;
      cctx.beginPath();
      cctx.moveTo(x * cellSize + 0.5, 0);
      cctx.lineTo(x * cellSize + 0.5, p.height * cellSize);
      cctx.stroke();
    }
    for (let y = 0; y <= p.height; y++) {
      if (y % major === 0) continue;
      cctx.beginPath();
      cctx.moveTo(0, y * cellSize + 0.5);
      cctx.lineTo(p.width * cellSize, y * cellSize + 0.5);
      cctx.stroke();
    }
    cctx.strokeStyle = "rgba(255,214,102,0.6)";
    cctx.lineWidth = 1.5;
    for (let x = 0; x <= p.width; x += major) {
      cctx.beginPath();
      cctx.moveTo(x * cellSize + 0.5, 0);
      cctx.lineTo(x * cellSize + 0.5, p.height * cellSize);
      cctx.stroke();
    }
    for (let y = 0; y <= p.height; y += major) {
      cctx.beginPath();
      cctx.moveTo(0, y * cellSize + 0.5);
      cctx.lineTo(p.width * cellSize, y * cellSize + 0.5);
      cctx.stroke();
    }
    cctx.restore();
  }

  // §34.3: ミラー軸の可視化（オーバーレイのみ・書き出し非影響）
  function drawMirrorAxisOverlay() {
    if (!store.state.mirrorDraw) return;
    const p = project();
    const cellSize = store.state.zoom;
    const axis = mirrorAxisX();
    const lineX = (axis + 0.5) * cellSize;
    if (lineX < 0 || lineX > p.width * cellSize) return;
    cctx.save();
    cctx.strokeStyle = "rgba(255,100,220,0.7)";
    cctx.lineWidth = 1.5;
    cctx.setLineDash([4, 3]);
    cctx.beginPath();
    cctx.moveTo(lineX, 0);
    cctx.lineTo(lineX, p.height * cellSize);
    cctx.stroke();
    cctx.restore();
  }

  // §50.3: 指先オフセットの実描画点マーカー（タッチ×オフセットON時のみ・常時表示）
  function drawFingerOffsetMarker() {
    if (!store.state.fingerOffset || !hoverIsTouch || !hoverCell) return;
    const cellSize = store.state.zoom;
    const cx = (hoverCell.x + 0.5) * cellSize;
    const cy = (hoverCell.y + 0.5) * cellSize;
    const r = Math.max(4, Math.min(cellSize * 0.4, 10));
    cctx.save();
    cctx.fillStyle = "rgba(255,214,102,0.30)";
    cctx.strokeStyle = "#ffd666";
    cctx.lineWidth = 1.5;
    cctx.beginPath();
    cctx.arc(cx, cy, r, 0, Math.PI * 2);
    cctx.fill();
    cctx.stroke();
    cctx.beginPath();
    cctx.moveTo(cx - r - 4, cy); cctx.lineTo(cx - r, cy);
    cctx.moveTo(cx + r, cy); cctx.lineTo(cx + r + 4, cy);
    cctx.moveTo(cx, cy - r - 4); cctx.lineTo(cx, cy - r);
    cctx.moveTo(cx, cy + r); cctx.lineTo(cx, cy + r + 4);
    cctx.stroke();
    cctx.restore();
  }

  // §50.3: スポイト長押し中の拡大鏡（周辺9x9セル・中心マーカー・吸い取り色プレビュー）。
  // タッチのみ表示（マウス/ペンの長押しスポイトはcursor:copyのみで拡大鏡は出さない＝
  // デスクトップ操作への影響ゼロ）。指の上方に離して表示し、指で隠れないようにする。
  const EYEDROP_MAG_CELLS = 9;
  const EYEDROP_MAG_CELL_PX = 14;
  function colorForIndex(colorIndex) {
    const hex = project().palette[colorIndex];
    if (!hex || colorIndex === 0) return null; // 透明
    const [r, g, b, a] = hexToRgba(hex);
    if (a === 0) return null;
    return a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a / 255})`;
  }
  function drawEyedropMagnifier() {
    if (!holdEyedrop || !hoverIsTouch || !hoverCell || !hoverClient) return;
    const p = project();
    const frameIndex = store.state.currentFrame;
    const half = Math.floor(EYEDROP_MAG_CELLS / 2);
    const magSize = EYEDROP_MAG_CELLS * EYEDROP_MAG_CELL_PX;
    const pad = 6;
    const rect = canvas.getBoundingClientRect();
    const fx = hoverClient.x - rect.left; // cursorCanvasはcanvasと同一のCSSサイズ・原点
    const fy = hoverClient.y - rect.top;
    const gap = 20; // 指の上方に離す（指で隠れないように）
    let mx = fx - magSize / 2;
    let my = fy - gap - magSize;
    mx = Math.max(pad, Math.min(cursorCanvas.width - magSize - pad, mx));
    my = Math.max(pad, my);
    cctx.save();
    cctx.fillStyle = "rgba(18,18,22,0.92)";
    cctx.fillRect(mx - pad, my - pad, magSize + pad * 2, magSize + pad * 2);
    cctx.strokeStyle = "rgba(255,255,255,0.55)";
    cctx.lineWidth = 1;
    cctx.strokeRect(mx - pad + 0.5, my - pad + 0.5, magSize + pad * 2 - 1, magSize + pad * 2 - 1);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const cx = hoverCell.x + dx, cy = hoverCell.y + dy;
        let fill = "#2a2a30"; // キャンバス範囲外
        if (inBounds(cx, cy)) {
          const idx = cy * p.width + cx;
          const col = colorForIndex(p.frames[frameIndex].pixels[idx]);
          fill = col || (((cx + cy) % 2 === 0) ? "#3a3a40" : "#2e2e34"); // 透明=市松
        }
        cctx.fillStyle = fill;
        cctx.fillRect(mx + (dx + half) * EYEDROP_MAG_CELL_PX, my + (dy + half) * EYEDROP_MAG_CELL_PX, EYEDROP_MAG_CELL_PX, EYEDROP_MAG_CELL_PX);
      }
    }
    cctx.strokeStyle = "rgba(255,255,255,0.18)";
    cctx.lineWidth = 1;
    for (let i = 0; i <= EYEDROP_MAG_CELLS; i++) {
      cctx.beginPath();
      cctx.moveTo(mx + i * EYEDROP_MAG_CELL_PX, my);
      cctx.lineTo(mx + i * EYEDROP_MAG_CELL_PX, my + magSize);
      cctx.stroke();
      cctx.beginPath();
      cctx.moveTo(mx, my + i * EYEDROP_MAG_CELL_PX);
      cctx.lineTo(mx + magSize, my + i * EYEDROP_MAG_CELL_PX);
      cctx.stroke();
    }
    // 中心マーカー（吸い取り対象セル）
    cctx.strokeStyle = "#ffd666";
    cctx.lineWidth = 2;
    cctx.strokeRect(mx + half * EYEDROP_MAG_CELL_PX + 1, my + half * EYEDROP_MAG_CELL_PX + 1, EYEDROP_MAG_CELL_PX - 2, EYEDROP_MAG_CELL_PX - 2);
    // 吸い取り色プレビュー（パネル右上の丸スウォッチ）
    const previewIdx = inBounds(hoverCell.x, hoverCell.y) ? p.frames[frameIndex].pixels[hoverCell.y * p.width + hoverCell.x] : 0;
    const previewColor = colorForIndex(previewIdx);
    const swR = 8;
    const swX = Math.min(cursorCanvas.width - swR - 2, mx + magSize + pad + swR + 2);
    const swY = Math.max(swR + 2, my - pad + swR + 2);
    cctx.beginPath();
    cctx.arc(swX, swY, swR, 0, Math.PI * 2);
    cctx.fillStyle = previewColor || "#111";
    cctx.fill();
    cctx.strokeStyle = "#fff";
    cctx.lineWidth = 1.5;
    cctx.stroke();
    cctx.restore();
  }

  function renderCursorOverlay() {
    syncCursorCanvasSize();
    cctx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    drawGridOverlay(); // §34.2
    drawMirrorAxisOverlay(); // §34.3
    drawFingerOffsetMarker(); // §50.3: 実描画点を常時表示（タッチ×指先オフセットON時のみ）
    const tool = store.state.tool;
    if (hoverCell && (tool === "pen" || tool === "eraser")) {
      const cellSize = store.state.zoom;
      const size = store.state.brushSize;
      const half = Math.floor((size - 1) / 2);
      const bx = hoverCell.x - half, by = hoverCell.y - half;
      cctx.save();
      cctx.strokeStyle = tool === "eraser" ? "#ef6d7a" : "#6ee7c8";
      cctx.lineWidth = 1.5;
      cctx.strokeRect(bx * cellSize + 1, by * cellSize + 1, size * cellSize - 2, size * cellSize - 2);
      cctx.restore();
    }
    drawEyedropMagnifier(); // §50.3: 長押しスポイト中の拡大鏡（最前面）
  }

  canvas.addEventListener("pointermove", (ev) => {
    const { x, y } = cellFromEvent(ev);
    hoverCell = { x, y };
    hoverClient = { x: ev.clientX, y: ev.clientY };
    hoverIsTouch = ev.pointerType === "touch";
    scheduleHoverUpdate();
  });
  canvas.addEventListener("pointerleave", () => {
    hoverCell = null;
    hoverClient = null;
    scheduleHoverUpdate();
  });

  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  let pendingWheelDir = 0;
  let wheelRafScheduled = false;
  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      pendingWheelDir += ev.deltaY > 0 ? -1 : 1;
      if (wheelRafScheduled) return;
      wheelRafScheduled = true;
      requestAnimationFrame(() => {
        wheelRafScheduled = false;
        if (pendingWheelDir !== 0) {
          setZoom(store.state.zoom + Math.sign(pendingWheelDir));
          pendingWheelDir = 0;
        }
      });
    },
    { passive: false }
  );

  zoomRange.addEventListener("input", () => setZoom(Number(zoomRange.value)));

  // §49.3: モバイル専用のキャンバスズームUI（＋/−/⤢全体）。ボタン自体はCSSでデスクトップ
  // では非表示だが、リスナーは常時登録して問題ない（非表示中はクリックされない）。
  // ＋/−は既存 zoom を1段階（±2）増減、⤢は zoomAuto（全体フィット）に戻す。
  const mobileZoomInBtn = document.getElementById("mobileZoomInBtn");
  const mobileZoomOutBtn = document.getElementById("mobileZoomOutBtn");
  const mobileZoomFitBtn = document.getElementById("mobileZoomFitBtn");
  mobileZoomInBtn?.addEventListener("click", () => setZoom(store.state.zoom + 2));
  mobileZoomOutBtn?.addEventListener("click", () => setZoom(store.state.zoom - 2));
  mobileZoomFitBtn?.addEventListener("click", () => {
    store.state.zoomAuto = true;
    store.state.zoom = computeAutoZoom();
    render();
    zoomRange.value = String(store.state.zoom);
    zoomLabel.textContent = `${store.state.zoom}x`;
  });

  clearSelectionBtn.addEventListener("click", () => {
    if (floating) commitFloating(); // 保留中の変形は焼き込んでから選択解除
    store.state.selection = null;
    store.notify();
  });

  // --- §32: 選択範囲の変形ボタン ---
  document.getElementById("selMoveBtn").addEventListener("click", () => {
    if (floating) { commitFloating(); return; } // 押下でトグル的に確定
    if (!ensureFloat()) { toast("先に矩形選択ツールで範囲を選んでください", "error"); return; }
    syncSelToFloat();
    store.notify();
    toast("選択を持ち上げました。ドラッグで移動、Enterで確定、Escで取消（Alt/⌥ドラッグでコピー）");
  });
  document.getElementById("selFlipHBtn").addEventListener("click", () => applyTransform(transformFlipH));
  document.getElementById("selFlipVBtn").addEventListener("click", () => applyTransform(transformFlipV));
  document.getElementById("selRot90Btn").addEventListener("click", () => applyTransform(transformRot90));
  document.getElementById("selRotFreeBtn").addEventListener("click", () => {
    if (!floating && !currentSelRect()) { toast("先に矩形選択ツールで範囲を選んでください", "error"); return; }
    // §32.2: 自由角度回転は最近傍でドットが粗くなる。明示操作時のみ警告。
    if (!window.confirm("自由角度回転はドットが粗くなります（最近傍）。90°/反転はきれいです。仕上げに部分修正を推奨。続けますか？")) return;
    const raw = window.prompt("回転角（度・時計回り。例: 15, -30）", "15");
    if (raw === null) return;
    const deg = Number(raw);
    if (!Number.isFinite(deg) || deg === 0) { toast("有効な角度を入力してください", "error"); return; }
    applyTransform(() => transformRotFree(deg));
    toast(`${deg}°回転しました（最近傍・粗）。Enterで確定、Escで取消`);
  });

  // §33: コピー / 切り取り / 貼り付け ボタン（iPad 等キーボード無し環境用）
  document.getElementById("selCopyBtn").addEventListener("click", doCopy);
  document.getElementById("selCutBtn").addEventListener("click", doCut);
  document.getElementById("selPasteBtn").addEventListener("click", doPaste);
  updateClipboardUi();

  // §34.4: オニオンスキン強化（表示モード・不透明度）
  onionModeSelect.addEventListener("change", () => {
    store.state.onionMode = onionModeSelect.value;
    store.notify();
  });
  onionOpacityRange.addEventListener("input", () => {
    store.state.onionOpacity = Number(onionOpacityRange.value) / 100;
    onionOpacityLabel.textContent = `${onionOpacityRange.value}%`;
    scheduleRender();
  });

  diffToggle.addEventListener("change", () => {
    store.state.diffView = diffToggle.checked;
    if (diffToggle.checked && !project().baseFrame) {
      toast("ベースフレームがありません（画像を開くとベースフレームが設定されます）");
    }
    store.notify();
  });

  // §34.2: グリッド表示 ON/OFF・補助線N（localStorage 保持）
  gridToggle.addEventListener("change", () => {
    store.state.gridShow = gridToggle.checked;
    try { localStorage.setItem(GRID_SHOW_KEY, store.state.gridShow ? "1" : "0"); } catch {}
    scheduleRender();
  });
  gridMajorSelect.addEventListener("change", () => {
    const n = Number(gridMajorSelect.value) === 16 ? 16 : 8;
    store.state.gridMajor = n;
    try { localStorage.setItem(GRID_MAJOR_KEY, String(n)); } catch {}
    scheduleRender();
  });

  // §34.3: 左右対称ミラー描画
  mirrorToggle.addEventListener("change", () => {
    store.state.mirrorDraw = mirrorToggle.checked;
    store.notify();
  });
  mirrorAxisInput.addEventListener("change", () => {
    const raw = mirrorAxisInput.value.trim();
    if (raw === "") {
      store.state.mirrorAxisX = null;
    } else {
      const v = Number(raw);
      store.state.mirrorAxisX = Number.isFinite(v) ? v : null;
    }
    store.notify();
  });

  // §34.1: 色の入れ替え / 置換（パレット自体は不変・ピクセルindexの付け替えのみ）
  function fillColorReplaceSelect(sel, selected) {
    const p = project();
    sel.innerHTML = "";
    p.palette.forEach((hex, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${i}: ${hex}`;
      sel.appendChild(opt);
    });
    if (Number.isInteger(selected) && selected >= 0 && selected < p.palette.length) sel.value = String(selected);
  }
  function openColorReplacePanel(presetFrom) {
    if (floating) commitFloating(); // §32との整合: 保留中の変形は先に確定
    const from = Number.isInteger(presetFrom) ? presetFrom : store.state.colorIndex;
    fillColorReplaceSelect(colorReplaceFrom, from);
    const toDefault = from === 0 ? 1 : 0;
    fillColorReplaceSelect(colorReplaceTo, toDefault < project().palette.length ? toDefault : 0);
    colorReplacePanel.hidden = false;
  }
  colorReplaceBtn.addEventListener("click", () => {
    if (!colorReplacePanel.hidden) { colorReplacePanel.hidden = true; return; }
    openColorReplacePanel();
  });
  colorReplaceCancelBtn.addEventListener("click", () => { colorReplacePanel.hidden = true; });
  colorReplaceExecBtn.addEventListener("click", () => {
    const fromIdx = Number(colorReplaceFrom.value);
    const toIdx = Number(colorReplaceTo.value);
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return;
    if (fromIdx === toIdx) { toast("元と先が同じ色です", "error"); return; }
    const scopeAll = document.getElementById("colorReplaceScopeAll").checked;
    const p = project();
    if (floating) commitFloating();
    store.pushUndo();
    let changed = 0;
    // §35: 現在フレームスコープはアクティブレイヤーのみ、全フレームスコープは
    // 全フレームの全レイヤー（=indexの一括付け替え）を対象にする。
    if (scopeAll) {
      for (const f of p.frames) {
        syncFrameLayers(f);
        for (const l of f.layers) {
          const px = l.pixels;
          for (let i = 0; i < px.length; i++) {
            if (px[i] === fromIdx) { px[i] = toIdx; changed++; }
          }
        }
        recompositeFrame(f);
      }
    } else {
      const f = p.frames[store.state.currentFrame];
      const px = frameActiveLayerPixels(f);
      for (let i = 0; i < px.length; i++) {
        if (px[i] === fromIdx) { px[i] = toIdx; changed++; }
      }
      recompositeFrame(f);
    }
    store.notify();
    colorReplacePanel.hidden = true;
    toast(`色を置換しました（${changed}px・${scopeAll ? "全フレーム" : "現在フレーム"}）`);
  });

  // ------------------------------------------------------------------ §35
  // レイヤーパネル: 一覧（上=最前面）・アクティブ選択・追加/削除/複製/上下並替/
  // 名前変更/表示トグル/不透明度（表示専用）/下に結合。すべてアンドゥ対象
  // （不透明度は操作終了時に1回捕捉）。
  const layerList = document.getElementById("layerList");
  const layerCountLabel = document.getElementById("layerCountLabel");
  let layerOpacityDrag = null; // スライダー操作中はパネル再構築を抑制（DOM差し替えでドラッグが切れないように）

  function currentFrameSynced() {
    const f = project().frames[store.state.currentFrame];
    syncFrameLayers(f);
    return f;
  }

  document.getElementById("layerAddBtn").addEventListener("click", () => {
    if (floating) commitFloating();
    const p = project();
    const f = currentFrameSynced();
    store.pushUndo();
    const nl = makeLayer(new Uint8Array(p.width * p.height), `レイヤー${f.layers.length + 1}`);
    f.layers.splice(f.activeLayer + 1, 0, nl); // アクティブの上（前面側）に追加
    f.activeLayer += 1;
    recompositeFrame(f);
    store.notify();
  });

  document.getElementById("layerDupBtn").addEventListener("click", () => {
    if (floating) commitFloating();
    const f = currentFrameSynced();
    const src = f.layers[f.activeLayer];
    store.pushUndo();
    const nl = makeLayer(Uint8Array.from(src.pixels), `${src.name}のコピー`.slice(0, 32));
    nl.visible = src.visible !== false;
    nl.opacity = Number.isFinite(src.opacity) ? src.opacity : 1;
    f.layers.splice(f.activeLayer + 1, 0, nl);
    f.activeLayer += 1;
    recompositeFrame(f);
    store.notify();
  });

  document.getElementById("layerDelBtn").addEventListener("click", () => {
    if (floating) commitFloating();
    const f = currentFrameSynced();
    if (f.layers.length <= 1) { toast("最後の1レイヤーは削除できません", "error"); return; }
    store.pushUndo();
    f.layers.splice(f.activeLayer, 1);
    f.activeLayer = Math.max(0, Math.min(f.layers.length - 1, f.activeLayer));
    recompositeFrame(f);
    store.notify();
  });

  function moveActiveLayer(dir) {
    if (floating) commitFloating();
    const f = currentFrameSynced();
    const i = f.activeLayer, j = i + dir;
    if (j < 0 || j >= f.layers.length) return;
    store.pushUndo();
    [f.layers[i], f.layers[j]] = [f.layers[j], f.layers[i]];
    f.activeLayer = j;
    recompositeFrame(f);
    store.notify();
  }
  document.getElementById("layerUpBtn").addEventListener("click", () => moveActiveLayer(+1)); // 前面へ（配列末尾方向）
  document.getElementById("layerDownBtn").addEventListener("click", () => moveActiveLayer(-1)); // 背面へ

  document.getElementById("layerMergeBtn").addEventListener("click", () => {
    if (floating) commitFloating();
    const f = currentFrameSynced();
    if (f.activeLayer <= 0) { toast("すぐ下のレイヤーがありません", "error"); return; }
    store.pushUndo();
    const act = f.layers[f.activeLayer];
    const below = f.layers[f.activeLayer - 1];
    const a = act.pixels, b = below.pixels;
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) b[i] = a[i]; // 非透明が上勝ちで焼き込み
    f.layers.splice(f.activeLayer, 1);
    f.activeLayer -= 1;
    recompositeFrame(f);
    store.notify();
  });

  function renderLayerPanel() {
    const f = currentFrameSynced();
    layerCountLabel.textContent = f.layers.length > 1 ? `(${f.layers.length})` : "";
    if (layerOpacityDrag) return; // スライダー操作中は再構築しない
    layerList.innerHTML = "";
    for (let i = f.layers.length - 1; i >= 0; i--) {
      const l = f.layers[i];
      const row = document.createElement("div");
      row.className = "layer-row" + (i === f.activeLayer ? " is-active" : "");
      row.dataset.index = String(i);
      row.title = `${l.name}（クリックでアクティブに）`;

      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = l.visible !== false;
      vis.title = "表示/非表示";
      vis.addEventListener("click", (ev) => ev.stopPropagation());
      vis.addEventListener("change", () => {
        store.pushUndo();
        l.visible = vis.checked;
        recompositeFrame(f);
        store.notify();
      });
      row.appendChild(vis);

      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = l.name;
      row.appendChild(name);

      const ren = document.createElement("button");
      ren.className = "layer-rename";
      ren.textContent = "✎";
      ren.title = "名前を変更";
      ren.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const raw = window.prompt("レイヤー名", l.name);
        if (raw === null) return;
        const nn = raw.trim().slice(0, 32);
        if (!nn || nn === l.name) return;
        store.pushUndo();
        l.name = nn;
        store.notify();
      });
      row.appendChild(ren);

      const op = document.createElement("input");
      op.type = "range";
      op.min = "0"; op.max = "100"; op.step = "5";
      op.value = String(Math.round((Number.isFinite(l.opacity) ? l.opacity : 1) * 100));
      op.title = "不透明度（編集画面の表示専用・書き出し/frame.pixelsには影響しない）";
      op.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        layerOpacityDrag = { layer: l, start: Number.isFinite(l.opacity) ? l.opacity : 1 };
      });
      op.addEventListener("click", (ev) => ev.stopPropagation());
      op.addEventListener("input", () => {
        l.opacity = Number(op.value) / 100;
        scheduleRender(); // 表示のみ更新（layerOpacityDrag ガードでパネルは再構築されない）
      });
      op.addEventListener("change", () => {
        const final = Number(op.value) / 100;
        const start = layerOpacityDrag ? layerOpacityDrag.start : (Number.isFinite(l.opacity) ? l.opacity : 1);
        layerOpacityDrag = null;
        if (final !== start) {
          // アンドゥは「変更前の状態」を捕捉してから最終値を適用
          l.opacity = start;
          store.pushUndo();
          l.opacity = final;
        }
        store.notify();
      });
      row.appendChild(op);

      row.addEventListener("click", () => {
        if (f.activeLayer === i) return;
        if (floating) commitFloating();
        f.activeLayer = i;
        store.notify();
      });
      layerList.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ §37
  // フローティングパレット窓: 「使用中（出現数順）/最近/全色」の3タブ。
  // タイトルバードラッグで移動（画面内クランプ）。位置・表示状態・タブ・
  // 全フレーム集計トグルは localStorage 保持。スウォッチクリックで描画色に
  // （左パネルと双方向同期）。窓のイベントは stopPropagation でキャンバス操作と分離。
  const FP_KEY = "aiMeglio.floatPalette";
  const FP_RECENT_MAX = 16;
  let fpState = { x: null, y: null, visible: false, tab: "used", scopeAll: false };
  try {
    const saved = JSON.parse(localStorage.getItem(FP_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (Number.isFinite(saved.x)) fpState.x = saved.x;
      if (Number.isFinite(saved.y)) fpState.y = saved.y;
      if (typeof saved.visible === "boolean") fpState.visible = saved.visible;
      if (["used", "recent", "all"].includes(saved.tab)) fpState.tab = saved.tab;
      if (typeof saved.scopeAll === "boolean") fpState.scopeAll = saved.scopeAll;
    }
  } catch {}
  let fpRecent = []; // 最近拾った色（palette index・新しい順・重複除去・最大16）
  let fpLastSignature = ""; // DOM再構築の抑制用（rAF毎の再集計を軽量に）

  function fpSave() {
    try { localStorage.setItem(FP_KEY, JSON.stringify(fpState)); } catch {}
  }
  function fpClampPosition() {
    const w = floatPalette.offsetWidth || 196;
    const h = floatPalette.offsetHeight || 140;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    if (!Number.isFinite(fpState.x)) fpState.x = Math.max(0, maxX - 24); // 既定: 右上寄り
    if (!Number.isFinite(fpState.y)) fpState.y = Math.min(120, maxY);
    fpState.x = Math.max(0, Math.min(maxX, fpState.x));
    fpState.y = Math.max(0, Math.min(maxY, fpState.y));
    floatPalette.style.left = fpState.x + "px";
    floatPalette.style.top = fpState.y + "px";
  }
  function fpSetVisible(visible) {
    fpState.visible = !!visible;
    floatPalette.hidden = !fpState.visible;
    floatPaletteToggleBtn.classList.toggle("is-active", fpState.visible);
    if (fpState.visible) {
      fpClampPosition();
      fpLastSignature = ""; // 再表示時は必ず再構築
      updateFloatPalette();
    }
    fpSave();
  }
  // 選択/スポイトで「拾った」色を履歴へ（新しい順・重複除去・最大16）
  function fpPushRecent(index) {
    if (!Number.isInteger(index) || index < 0) return;
    fpRecent = [index, ...fpRecent.filter((v) => v !== index)].slice(0, FP_RECENT_MAX);
  }

  // タイトルバーのドラッグ移動。setPointerCapture でポインタを窓に固定し、
  // stopPropagation でキャンバス側（描画/パン/2本指ジェスチャー）と競合させない。
  let fpDrag = null; // { dx, dy }
  floatPaletteTitlebar.addEventListener("pointerdown", (ev) => {
    if (ev.target === floatPaletteCloseBtn) return;
    ev.preventDefault();
    ev.stopPropagation();
    fpDrag = { dx: ev.clientX - fpState.x, dy: ev.clientY - fpState.y };
    try { floatPaletteTitlebar.setPointerCapture(ev.pointerId); } catch {}
  });
  floatPaletteTitlebar.addEventListener("pointermove", (ev) => {
    if (!fpDrag) return;
    ev.stopPropagation();
    fpState.x = ev.clientX - fpDrag.dx;
    fpState.y = ev.clientY - fpDrag.dy;
    fpClampPosition();
  });
  function fpEndDrag(ev) {
    if (!fpDrag) return;
    ev.stopPropagation();
    fpDrag = null;
    fpSave();
  }
  floatPaletteTitlebar.addEventListener("pointerup", fpEndDrag);
  floatPaletteTitlebar.addEventListener("pointercancel", fpEndDrag);
  // 窓内のポインタ操作がキャンバスのwindowレベルハンドラに波及しないように
  floatPalette.addEventListener("pointerdown", (ev) => ev.stopPropagation());

  floatPaletteCloseBtn.addEventListener("click", () => fpSetVisible(false));
  floatPaletteToggleBtn.addEventListener("click", () => fpSetVisible(!fpState.visible));
  floatPaletteTabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".fp-tab");
    if (!btn) return;
    fpState.tab = btn.dataset.fptab;
    fpSave();
    fpLastSignature = "";
    updateFloatPalette();
  });
  floatPaletteAllFrames.addEventListener("change", () => {
    fpState.scopeAll = floatPaletteAllFrames.checked;
    fpSave();
    fpLastSignature = "";
    updateFloatPalette();
  });
  window.addEventListener("resize", () => {
    if (fpState.visible) fpClampPosition();
  });

  // 使用色の自動集計: 現在フレーム（or 全フレーム）の出現数順（index0=透明は除外）
  function fpUsedEntries() {
    const p = project();
    const counts = new Uint32Array(p.palette.length);
    if (fpState.scopeAll) {
      for (const f of p.frames) {
        const px = f.pixels;
        for (let i = 0; i < px.length; i++) counts[px[i]]++;
      }
    } else {
      const px = p.frames[store.state.currentFrame].pixels;
      for (let i = 0; i < px.length; i++) counts[px[i]]++;
    }
    const entries = [];
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] > 0) entries.push({ index: i, count: counts[i] });
    }
    entries.sort((a, b) => b.count - a.count || a.index - b.index);
    return entries;
  }

  // 表示中のみ集計・シグネチャ一致ならDOM再構築をスキップ（render はrAFバッチ済みなので軽量）
  function updateFloatPalette() {
    if (!fpState.visible) return;
    const p = project();
    let entries;
    if (fpState.tab === "used") {
      entries = fpUsedEntries();
    } else if (fpState.tab === "recent") {
      entries = fpRecent.filter((i) => i < p.palette.length).map((i) => ({ index: i, count: null }));
    } else {
      entries = p.palette.map((_, i) => ({ index: i, count: null }));
    }
    const sig = [
      fpState.tab, fpState.scopeAll ? 1 : 0, store.state.colorIndex,
      p.palette.join(","),
      entries.map((e) => `${e.index}:${e.count}`).join("|"),
    ].join("§");
    if (sig === fpLastSignature) return;
    fpLastSignature = sig;

    for (const btn of floatPaletteTabs.querySelectorAll(".fp-tab")) {
      btn.classList.toggle("is-active", btn.dataset.fptab === fpState.tab);
    }
    floatPaletteScopeRow.hidden = fpState.tab !== "used";
    floatPaletteAllFrames.checked = !!fpState.scopeAll;

    floatPaletteGrid.innerHTML = "";
    if (entries.length === 0) {
      const d = document.createElement("div");
      d.className = "fp-empty";
      d.textContent = fpState.tab === "recent" ? "（履歴なし）" : "（使用色なし）";
      floatPaletteGrid.appendChild(d);
      return;
    }
    for (const e of entries) {
      const hex = p.palette[e.index];
      if (hex === undefined) continue;
      const sw = document.createElement("button");
      sw.className = "swatch" + (e.index === store.state.colorIndex ? " is-selected" : "");
      sw.dataset.index = String(e.index);
      if (e.count !== null) sw.dataset.count = String(e.count);
      sw.title = e.count !== null ? `index ${e.index}: ${hex}（${e.count}px）` : `index ${e.index}: ${hex}`;
      const inner = document.createElement("i");
      inner.style.background = hex;
      sw.appendChild(inner);
      sw.addEventListener("click", () => {
        fpPushRecent(e.index);
        store.state.colorIndex = e.index;
        store.notify();
      });
      floatPaletteGrid.appendChild(sw);
    }
  }

  // 初期表示（localStorage 復元）
  fpSetVisible(fpState.visible);

  // --- ブラシサイズ（§31.2）---
  brushSizeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const size = Number(btn.dataset.size) || 1;
      store.state.brushSize = size;
      store.notify();
    });
  });

  // --- 指先オフセットモード（§50.3・タッチのみ・既定OFF・localStorage保持）---
  if (fingerOffsetToggle) {
    fingerOffsetToggle.checked = store.state.fingerOffset;
    fingerOffsetToggle.addEventListener("change", () => {
      store.state.fingerOffset = fingerOffsetToggle.checked;
      try { localStorage.setItem(FINGER_OFFSET_KEY, store.state.fingerOffset ? "1" : "0"); } catch {}
      store.notify();
      scheduleHoverUpdate(); // マーカー表示をトグル直後から反映
    });
  }

  // --- ロック領域（§13.2-3）---
  lockSelectionBtn.addEventListener("click", () => {
    const sel = store.state.selection;
    if (!sel) {
      toast("先に矩形選択ツールでロックする範囲を選択してください", "error");
      return;
    }
    const p = project();
    store.pushUndo();
    if (!Array.isArray(p.lockedRects)) p.lockedRects = [];
    p.lockedRects.push({ x: sel.x, y: sel.y, w: sel.w, h: sel.h });
    store.state.selection = null;
    store.notify();
    toast(`ロック領域を追加しました（計 ${p.lockedRects.length} 件）`);
  });

  clearLocksBtn.addEventListener("click", () => {
    const p = project();
    if (!p.lockedRects || p.lockedRects.length === 0) return;
    store.pushUndo();
    p.lockedRects = [];
    store.notify();
    toast("すべてのロック領域を解除しました");
  });

  // ---------------------------------------------------------------------
  // ツール切替
  // ---------------------------------------------------------------------
  const TOOL_KEYS = { b: "pen", e: "eraser", f: "fill", s: "select", i: "eyedropper" };
  function switchTool(tool) {
    if (floating && tool !== store.state.tool) commitFloating(); // §32: ツール切替で焼き込み
    store.state.tool = tool;
    store.notify();
  }
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => switchTool(btn.dataset.tool));
  });
  window.addEventListener("keydown", (ev) => {
    const tag = document.activeElement?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    // §33: コピー/切り取り/貼り付け（Ctrl/⌘+C/X/V）。選択orクリップボードがある時のみ横取り。
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
      const k = ev.key.toLowerCase();
      if (k === "c" && (currentSelRect() || floating)) { doCopy(); ev.preventDefault(); return; }
      if (k === "x" && (currentSelRect() || floating)) { doCut(); ev.preventDefault(); return; }
      if (k === "v" && clipboard) { doPaste(); ev.preventDefault(); return; }
    }
    // §32: フローティング中の確定/取消・アンドゥ整合
    if (floating) {
      if (ev.key === "Escape") { cancelFloating(); ev.preventDefault(); return; }
      if (ev.key === "Enter") { commitFloating(); ev.preventDefault(); return; }
      // アンドゥ/リドゥはフレーム状態を巻き戻すため、先に保留中フロートを破棄して整合を保つ
      if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "z" || ev.key.toLowerCase() === "y")) {
        cancelFloating();
        // undo/redo 自体は app.js のグローバルショートカットが処理する
      }
    }
    // §37: P = フローティングパレット窓のトグル
    if (ev.key.toLowerCase() === "p" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      fpSetVisible(!fpState.visible);
      return;
    }
    const tool = TOOL_KEYS[ev.key.toLowerCase()];
    if (tool) switchTool(tool);
  });

  // ---------------------------------------------------------------------
  // パレット
  // ---------------------------------------------------------------------
  // §18.3: メインパレット段（クリックで所属グループをハイライト）
  function renderMainPalette() {
    const p = project();
    // 33色以上なら（未抽出でも）再抽出コントロールを出す
    mainPaletteRow.hidden = !(p.mainPalette || p.palette.length > 32);
    mainPaletteGrid.innerHTML = "";
    if (!p.mainPalette) return;
    p.mainPalette.colors.forEach((hex, mi) => {
      const sw = document.createElement("button");
      sw.className = "swatch" + (store.state.highlightGroup === mi ? " is-group-active" : "");
      sw.title = `メイン ${mi}: ${hex}（クリックでグループをハイライト）`;
      const inner = document.createElement("i");
      inner.style.background = hex;
      sw.appendChild(inner);
      sw.addEventListener("click", () => {
        store.state.highlightGroup = store.state.highlightGroup === mi ? null : mi;
        store.notify();
      });
      mainPaletteGrid.appendChild(sw);
    });
  }

  function renderPalette() {
    const p = project();
    renderMainPalette();
    paletteGrid.innerHTML = "";
    p.palette.forEach((hex, i) => {
      const sw = document.createElement("button");
      sw.className = "swatch" + (i === store.state.colorIndex ? " is-selected" : "");
      sw.title = `index ${i}: ${hex}`;
      const inner = document.createElement("i");
      inner.style.background = hex;
      sw.appendChild(inner);
      sw.addEventListener("click", () => {
        fpPushRecent(i); // §37: 選択した色を「最近」へ
        store.state.colorIndex = i;
        store.notify();
      });
      // §34.1: スウォッチ右クリック→色置換パネルを開く（元=このスウォッチ）
      sw.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openColorReplacePanel(i);
      });
      sw.addEventListener("dblclick", () => {
        if (i === 0) {
          toast("index 0（透明）は色を変更できません");
          return;
        }
        const input = document.createElement("input");
        input.type = "color";
        const [r, g, b] = hexToRgba(hex);
        input.value = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        input.addEventListener("input", () => {
          store.pushUndo();
          project().palette[i] = input.value;
          store.notify();
        });
        input.click();
      });
      paletteGrid.appendChild(sw);
    });
  }
  mainPaletteReextractBtn.addEventListener("click", () => {
    const p = project();
    const count = Math.max(8, Math.min(64, Number(mainPaletteCount.value) || 32));
    // 使用ピクセル数を集計して頻度重み付き再抽出（§18.3）
    const counts = new Uint32Array(p.palette.length);
    for (const f of p.frames) for (const v of f.pixels) counts[v]++;
    store.pushUndo();
    p.mainPalette = extractMainPalette(p.palette, counts, count);
    store.state.highlightGroup = null;
    store.notify();
    toast(`メインパレットを再抽出しました（${p.mainPalette.colors.length}色）`);
  });

  paletteAddBtn.addEventListener("click", () => {
    const p = project();
    if (p.palette.length >= 256) {
      toast("パレットは最大256色です", "error");
      return;
    }
    store.pushUndo();
    p.palette.push("#ffffff");
    store.state.colorIndex = p.palette.length - 1;
    store.notify();
  });

  // ---------------------------------------------------------------------
  // §34.4: オニオンスキン強化（前/前+次・不透明度・方向ティント）。
  // 現在フレームを描画した後、globalCompositeOperation="destination-over" で
  // 既存内容の「下」に焼くため、正しいz順（ゴーストは現在フレームの後ろ）を維持しつつ、
  // mainCanvas はあくまで表示専用（書き出しは frameToPngDataUrl 等の別経路で
  // project.pixels のみを読むため、このゴーストは混入しない）。
  // ---------------------------------------------------------------------
  const ONION_COOL_TINT = [90, 150, 255]; // 前フレーム=寒色
  const ONION_WARM_TINT = [255, 150, 70]; // 次フレーム=暖色
  const ONION_TINT_AMOUNT = 0.5;
  function drawOnionGhost(p, frameIndex, tint, opacity, cellSize) {
    const frame = p.frames[frameIndex];
    if (!frame) return;
    const pixels = frame.pixels;
    const pal = p.palette;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const v = pixels[y * p.width + x];
        const hex = pal[v];
        if (!hex) continue;
        let [r, g, b, a] = hexToRgba(hex);
        if (a === 0) continue;
        r = Math.round(r * (1 - ONION_TINT_AMOUNT) + tint[0] * ONION_TINT_AMOUNT);
        g = Math.round(g * (1 - ONION_TINT_AMOUNT) + tint[1] * ONION_TINT_AMOUNT);
        b = Math.round(b * (1 - ONION_TINT_AMOUNT) + tint[2] * ONION_TINT_AMOUNT);
        ctx.fillStyle = `rgba(${r},${g},${b},${(opacity * (a / 255)).toFixed(3)})`;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }
  }
  function renderOnionGhosts(p, cellSize) {
    const mode = store.state.onionMode;
    if (mode !== "prev" && mode !== "both") return;
    const cur = store.state.currentFrame;
    const opacity = store.state.onionOpacity;
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    if (mode === "both") drawOnionGhost(p, cur + 1, ONION_WARM_TINT, opacity, cellSize);
    drawOnionGhost(p, cur - 1, ONION_COOL_TINT, opacity, cellSize);
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------
  function render() {
    const p = project();
    const cellSize = store.state.zoom;
    canvas.width = p.width * cellSize;
    canvas.height = p.height * cellSize;
    canvas.style.width = canvas.width + "px";
    canvas.style.height = canvas.height + "px";

    // §35: レイヤー表示。単一の不透明可視レイヤーは従来経路（合成キャッシュ描画）。
    // それ以外はレイヤーを下から順に opacity 付きで重ね描き（opacityは表示専用＝
    // frame.pixels・書き出しには影響しない）。
    const curFrame = p.frames[store.state.currentFrame];
    syncFrameLayers(curFrame);
    const simpleDraw = curFrame.layers.length === 1 && curFrame.layers[0].visible !== false && curFrame.layers[0].opacity === 1;
    if (simpleDraw) {
      drawFrameToContext(ctx, p, store.state.currentFrame, cellSize);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const l of curFrame.layers) {
        if (l.visible === false || l.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = Number.isFinite(l.opacity) ? Math.max(0, Math.min(1, l.opacity)) : 1;
        drawPixels(ctx, l.pixels, p.width, p.height, p.palette, cellSize);
        ctx.restore();
      }
    }
    renderOnionGhosts(p, cellSize);

    // §32: フローティング（持ち上げ中の選択ピクセル）を合成表示。
    // コピー移動でなければ元領域を透明の「穴」として見せてから、フロートを上に描く。
    if (floating && floating.frameIndex === store.state.currentFrame) {
      const f = floating;
      if (!f.copy) {
        ctx.clearRect(f.origX * cellSize, f.origY * cellSize, f.origW * cellSize, f.origH * cellSize);
      }
      const pal = p.palette;
      for (let yy = 0; yy < f.h; yy++) {
        for (let xx = 0; xx < f.w; xx++) {
          const v = f.buf[yy * f.w + xx];
          if (v === 0) continue;
          const hex = pal[v];
          if (!hex) continue;
          const [r, g, b, a] = hexToRgba(hex);
          if (a === 0) continue;
          const dx = f.x + xx, dy = f.y + yy;
          if (dx < 0 || dy < 0 || dx >= p.width || dy >= p.height) continue;
          ctx.fillStyle = a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a / 255})`;
          ctx.fillRect(dx * cellSize, dy * cellSize, cellSize, cellSize);
        }
      }
    }

    // グリッド線（ある程度ズームしているときのみ）
    if (cellSize >= 6) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= p.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cellSize + 0.5, 0);
        ctx.lineTo(x * cellSize + 0.5, p.height * cellSize);
        ctx.stroke();
      }
      for (let y = 0; y <= p.height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cellSize + 0.5);
        ctx.lineTo(p.width * cellSize, y * cellSize + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // フラッシュハイライト（AI適用直後のセル）
    const sel = store.state.selection;
    const now = performance.now();
    if (store.state.flashCells.size) {
      ctx.save();
      ctx.fillStyle = "rgba(110, 231, 200, 0.55)";
      for (const [key, expiry] of store.state.flashCells) {
        if (expiry < now) continue;
        const [f, x, y] = key.split(":").map(Number);
        if (f !== store.state.currentFrame) continue;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
      ctx.restore();
    }

    // §18.3: メイングループのハイライト
    if (store.state.highlightGroup !== null && store.state.highlightGroup !== undefined && p.mainPalette) {
      const pixels = p.frames[store.state.currentFrame].pixels;
      ctx.save();
      ctx.strokeStyle = "#e8b654";
      ctx.lineWidth = Math.max(1, Math.min(2, cellSize / 6));
      for (let y = 0; y < p.height; y++) {
        for (let x = 0; x < p.width; x++) {
          const idx = pixels[y * p.width + x];
          if (idx > 0 && p.mainPalette.groups[idx] === store.state.highlightGroup) {
            ctx.strokeRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);
          }
        }
      }
      ctx.restore();
    }

    // 差分ビュー（§13.2-5）: ベースフレームとの差分セルをマゼンタ枠で表示
    if (store.state.diffView && p.baseFrame) {
      const pixels = p.frames[store.state.currentFrame].pixels;
      ctx.save();
      ctx.strokeStyle = "#ff3df0";
      ctx.lineWidth = Math.max(1, Math.min(2, cellSize / 6));
      for (let y = 0; y < p.height; y++) {
        for (let x = 0; x < p.width; x++) {
          const i = y * p.width + x;
          if (pixels[i] !== p.baseFrame[i]) {
            ctx.strokeRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
          }
        }
      }
      ctx.restore();
    }

    // ロック領域（半透明赤）
    const locked = p.lockedRects || [];
    if (locked.length) {
      ctx.save();
      ctx.fillStyle = "rgba(239, 109, 122, 0.25)";
      ctx.strokeStyle = "rgba(239, 109, 122, 0.9)";
      ctx.lineWidth = 1.5;
      for (const r of locked) {
        ctx.fillRect(r.x * cellSize, r.y * cellSize, r.w * cellSize, r.h * cellSize);
        ctx.strokeRect(r.x * cellSize + 0.5, r.y * cellSize + 0.5, r.w * cellSize - 1, r.h * cellSize - 1);
      }
      ctx.restore();
    }

    // 選択範囲（点線）
    if (sel && sel.frameIndex === store.state.currentFrame) {
      ctx.save();
      ctx.strokeStyle = "#6ee7c8";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(sel.x * cellSize + 1, sel.y * cellSize + 1, sel.w * cellSize - 2, sel.h * cellSize - 2);
      ctx.restore();
    }

    // リグパーツの境界オーバーレイ（リグタブ表示中のみ。§14 分割位置の可視化）
    const rigTabEl = document.getElementById("rigTab");
    if (rigTabEl && !rigTabEl.hidden && p.rig && p.rig.parts && p.rig.parts.length) {
      const hues = [180, 45, 300, 120, 10, 220, 270, 90];
      ctx.save();
      p.rig.parts.forEach((part, i) => {
        const isSel = store.state.rigSelectedPart === part.id;
        const col = `hsl(${hues[i % hues.length]}, 85%, ${isSel ? 70 : 55}%)`;
        const r = part.patch;
        ctx.strokeStyle = col;
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.setLineDash(part.visible === false ? [3, 3] : []);
        ctx.strokeRect(r.x * cellSize + 0.5, r.y * cellSize + 0.5, r.w * cellSize - 1, r.h * cellSize - 1);
        // §22.8: 選択中パーツはリサイズ用の8ハンドル（四隅+四辺中点）を描画
        if (isSel) {
          const hx0 = r.x * cellSize, hy0 = r.y * cellSize;
          const hx1 = (r.x + r.w) * cellSize, hy1 = (r.y + r.h) * cellSize;
          const xs = [hx0, (hx0 + hx1) / 2, hx1];
          const ys = [hy0, (hy0 + hy1) / 2, hy1];
          ctx.setLineDash([]);
          for (let iy = 0; iy < 3; iy++) {
            for (let ix = 0; ix < 3; ix++) {
              if (ix === 1 && iy === 1) continue;
              ctx.fillStyle = col;
              ctx.fillRect(xs[ix] - 3, ys[iy] - 3, 6, 6);
              ctx.strokeStyle = "rgba(0,0,0,0.8)";
              ctx.lineWidth = 1;
              ctx.strokeRect(xs[ix] - 3.5, ys[iy] - 3.5, 7, 7);
            }
          }
          ctx.strokeStyle = col;
          ctx.lineWidth = 2.5;
        }
        // 支点（＋マーク）
        const px = (r.x + part.pivot.x + 0.5) * cellSize;
        const py = (r.y + part.pivot.y + 0.5) * cellSize;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(px - 5, py); ctx.lineTo(px + 5, py);
        ctx.moveTo(px, py - 5); ctx.lineTo(px, py + 5);
        ctx.stroke();
        // 名前ラベル（枠の左上）
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = col;
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 3;
        const lx = r.x * cellSize + 3, ly = Math.max(11, r.y * cellSize + 12);
        ctx.strokeText(part.name, lx, ly);
        ctx.fillText(part.name, lx, ly);
      });
      ctx.restore();
    }

    renderPalette();
    canvasSizeLabel.textContent = `${p.width} x ${p.height}`;
    lockCountEl.textContent = String((p.lockedRects || []).length);
    diffToggle.checked = store.state.diffView;
    onionModeSelect.value = store.state.onionMode;
    onionOpacityRange.value = String(Math.round(store.state.onionOpacity * 100));
    onionOpacityLabel.textContent = `${Math.round(store.state.onionOpacity * 100)}%`;
    gridToggle.checked = store.state.gridShow;
    gridMajorSelect.value = String(store.state.gridMajor);
    mirrorToggle.checked = store.state.mirrorDraw;
    mirrorAxisInput.value = Number.isFinite(store.state.mirrorAxisX) ? String(store.state.mirrorAxisX) : "";
    zoomRange.value = String(store.state.zoom);
    zoomLabel.textContent = `${store.state.zoom}x`;
    toolButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.tool === store.state.tool));
    brushSizeButtons.forEach((btn) => btn.classList.toggle("is-active", Number(btn.dataset.size) === store.state.brushSize));
    document.getElementById("selMoveBtn")?.classList.toggle("is-active", !!floating); // §32
    renderLayerPanel(); // §35
    updateFloatPalette(); // §37: 編集のたび使用色を再集計（シグネチャ一致ならDOM再構築なし）
    renderCursorOverlay();
  }

  for (const id of ["tabPatchBtn", "tabMotionBtn", "tabRigBtn"]) {
    document.getElementById(id)?.addEventListener("click", () => setTimeout(render, 0));
  }

  window.addEventListener("resize", () => {
    if (store.state.zoomAuto) {
      store.state.zoom = computeAutoZoom();
      render();
    }
  });

  // 初期ズームは自動フィット
  requestAnimationFrame(() => {
    store.state.zoom = computeAutoZoom();
    render();
  });

  store.subscribe(render);
}
