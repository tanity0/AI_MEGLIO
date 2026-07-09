// editor.js — キャンバス描画・ツール・選択
import { drawFrameToContext, hexToRgba } from "./app.js";
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
  const onionToggle = document.getElementById("onionSkinToggle");
  const diffToggle = document.getElementById("diffViewToggle");
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
    const px = p.frames[sel.frameIndex].pixels;
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
    const px = p.frames[f.frameIndex].pixels;
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
    const x = Math.floor((ev.clientX - rect.left) / cellSize);
    const y = Math.floor((ev.clientY - rect.top) / cellSize);
    return { x, y };
  }

  function inBounds(x, y) {
    const p = project();
    return x >= 0 && y >= 0 && x < p.width && y < p.height;
  }

  function setPixel(frameIndex, x, y, colorIndex) {
    if (!inBounds(x, y)) return false;
    const p = project();
    const idx = y * p.width + x;
    const pixels = p.frames[frameIndex].pixels;
    if (pixels[idx] === colorIndex) return false;
    pixels[idx] = colorIndex;
    return true;
  }

  // §31.2: サイズ分の正方ブラシで1点を塗る（中心寄せ。size=1は従来どおり1px）
  function paintBrushAt(frameIndex, cx, cy, colorIndex, size) {
    const half = Math.floor((size - 1) / 2);
    let changed = false;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        if (setPixel(frameIndex, cx - half + dx, cy - half + dy, colorIndex)) changed = true;
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
    const pixels = p.frames[frameIndex].pixels;
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
    if (touchPoints.size === 2) {
      // 2本指ジェスチャー開始：進行中の1本指ストロークやパンは中断してパン/ズームに切替
      abortStroke();
      panning = null;
      wrap.classList.remove("panning");
      const pts = Array.from(touchPoints.values());
      const mid = touchMid(pts[0], pts[1]);
      pinch = { startDist: touchDist(pts[0], pts[1]) || 1, startZoom: store.state.zoom, lastMidX: mid.x, lastMidY: mid.y };
    } else if (touchPoints.size > 2) {
      pinch = null; // 3本指以上は無視
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
  });

  // ---------------------------------------------------------------------
  // §31.2 カーソルプレビュー（軽量オーバーレイ）
  // 専用の透明canvasに枠だけ描くため、ホバーのたびにキャンバス全体を
  // 再描画する必要がなく、高ズーム/大キャンバスでもカーソル追従が滑らか。
  // ---------------------------------------------------------------------
  let hoverCell = null;
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
  function renderCursorOverlay() {
    syncCursorCanvasSize();
    cctx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    const tool = store.state.tool;
    if (!hoverCell || (tool !== "pen" && tool !== "eraser")) return;
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

  canvas.addEventListener("pointermove", (ev) => {
    const { x, y } = cellFromEvent(ev);
    hoverCell = { x, y };
    scheduleHoverUpdate();
  });
  canvas.addEventListener("pointerleave", () => {
    hoverCell = null;
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

  onionToggle.addEventListener("change", () => {
    store.state.onionSkin = onionToggle.checked;
    store.notify();
  });

  diffToggle.addEventListener("change", () => {
    store.state.diffView = diffToggle.checked;
    if (diffToggle.checked && !project().baseFrame) {
      toast("ベースフレームがありません（画像を開くとベースフレームが設定されます）");
    }
    store.notify();
  });

  // --- ブラシサイズ（§31.2）---
  brushSizeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const size = Number(btn.dataset.size) || 1;
      store.state.brushSize = size;
      store.notify();
    });
  });

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
        store.state.colorIndex = i;
        store.notify();
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
  // 描画
  // ---------------------------------------------------------------------
  function render() {
    const p = project();
    const cellSize = store.state.zoom;
    canvas.width = p.width * cellSize;
    canvas.height = p.height * cellSize;
    canvas.style.width = canvas.width + "px";
    canvas.style.height = canvas.height + "px";

    drawFrameToContext(ctx, p, store.state.currentFrame, cellSize, { onion: store.state.onionSkin });

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
    onionToggle.checked = store.state.onionSkin;
    zoomRange.value = String(store.state.zoom);
    zoomLabel.textContent = `${store.state.zoom}x`;
    toolButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.tool === store.state.tool));
    brushSizeButtons.forEach((btn) => btn.classList.toggle("is-active", Number(btn.dataset.size) === store.state.brushSize));
    document.getElementById("selMoveBtn")?.classList.toggle("is-active", !!floating); // §32
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
