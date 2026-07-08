// editor.js — キャンバス描画・ツール・選択
import { drawFrameToContext, hexToRgba } from "./app.js";
import { extractMainPalette } from "./convert.js";

const MIN_ZOOM = 2;
const MAX_ZOOM = 48;

export function initEditor(store, toast) {
  const canvas = document.getElementById("mainCanvas");
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

  let dragging = false;
  let dragTool = null;
  let dragStart = null; // {x,y} cell coords for select tool
  let lastPaintedCell = null;

  function project() { return store.state.project; }

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
  // マウス操作
  // ---------------------------------------------------------------------
  // ペンの長押しスポイト（0.7秒静止で発動、離すと色を拾ってペンに戻る）
  const HOLD_EYEDROP_MS = 700;
  let holdTimer = null;
  let holdEyedrop = false;
  let holdStartCell = null;
  let pendingPen = null; // {x, y} 押下直後の未確定ドット（離す=打つ / 動かす=線 / 0.7秒=スポイト）
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

  // 空き領域の左ドラッグ / どこでも中ボタンドラッグで表示位置をパン
  let panning = null;
  wrap.addEventListener("pointerdown", (ev) => {
    const middle = ev.button === 1;
    if (!middle && (ev.button !== 0 || ev.target !== wrap)) return;
    panning = { x: ev.clientX, y: ev.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
    wrap.classList.add("panning");
    ev.preventDefault(); // 中ボタンのオートスクロールと、キャンバスの互換mousedownを抑止
  });
  window.addEventListener("pointermove", (ev) => {
    if (!panning) return;
    wrap.scrollLeft = panning.left - (ev.clientX - panning.x);
    wrap.scrollTop = panning.top - (ev.clientY - panning.y);
  });
  window.addEventListener("pointerup", () => {
    panning = null;
    wrap.classList.remove("panning");
  });

  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return; // 描画は左ボタンのみ（中ボタンはパン）
    if (store.state.rigAdjustMode) return; // リグ調整モード中はrig.jsがドラッグを処理する
    const { x, y } = cellFromEvent(ev);
    const tool = store.state.tool;
    const frameIndex = store.state.currentFrame;

    // Alt+クリック = どのツールでも即スポイト
    if (ev.altKey && (tool === "pen" || tool === "eraser" || tool === "fill")) {
      pickColorAt(x, y);
      return;
    }

    dragging = true;
    dragTool = tool;
    lastPaintedCell = null;

    if (tool === "pen") {
      // ペンは押下時点では打たない。すぐ離す=ドット / 動かす=線 / 0.7秒静止=スポイト
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
      if (setPixel(frameIndex, x, y, 0)) lastPaintedCell = `${x},${y}`;
      render();
    } else if (tool === "fill") {
      store.pushUndo();
      floodFill(frameIndex, x, y, store.state.colorIndex);
      render();
    } else if (tool === "select") {
      dragStart = { x, y };
      store.state.selection = { frameIndex, ...normalizedSelectionRect({ x, y }, { x, y }) };
      store.notify();
    } else if (tool === "eyedropper") {
      const p = project();
      if (inBounds(x, y)) {
        const idx = p.frames[frameIndex].pixels[y * p.width + x];
        store.state.colorIndex = idx;
        store.notify();
      }
    }
  });

  window.addEventListener("mousemove", (ev) => {
    if (!wrap.contains(document.elementFromPoint(ev.clientX, ev.clientY)) && !dragging) {
      // still update cursor label only when over canvas; handled below via canvas mousemove
    }
    if (!dragging) return;
    const { x, y } = cellFromEvent(ev);
    const frameIndex = store.state.currentFrame;
    if (holdTimer && `${x},${y}` !== holdStartCell) clearHoldTimer();
    if (dragTool === "pen" && pendingPen && `${x},${y}` !== `${pendingPen.x},${pendingPen.y}`) {
      // 保留中のドットを起点に線を開始
      store.pushUndo();
      setPixel(frameIndex, pendingPen.x, pendingPen.y, store.state.colorIndex);
      pendingPen = null;
      lastPaintedCell = null;
    }
    if ((dragTool === "pen" && !pendingPen) || dragTool === "eraser") {
      const key = `${x},${y}`;
      if (key !== lastPaintedCell) {
        const color = dragTool === "eraser" ? 0 : store.state.colorIndex;
        if (setPixel(frameIndex, x, y, color)) render();
        lastPaintedCell = key;
      }
    } else if (dragTool === "select" && dragStart) {
      store.state.selection = { frameIndex, ...normalizedSelectionRect(dragStart, { x, y }) };
      store.notify();
    }
  });

  window.addEventListener("mouseup", (ev) => {
    clearHoldTimer();
    if (holdEyedrop) {
      const { x, y } = cellFromEvent(ev);
      pickColorAt(x, y);
      holdEyedrop = false;
      canvas.style.cursor = "";
    } else if (pendingPen && dragTool === "pen") {
      // すぐ離した → ドット確定
      store.pushUndo();
      setPixel(store.state.currentFrame, pendingPen.x, pendingPen.y, store.state.colorIndex);
      render();
    }
    pendingPen = null;
    dragging = false;
    dragTool = null;
    dragStart = null;
  });

  canvas.addEventListener("mousemove", (ev) => {
    const { x, y } = cellFromEvent(ev);
    if (inBounds(x, y)) {
      cursorPosLabel.textContent = `(${x}, ${y})`;
    } else {
      cursorPosLabel.textContent = "";
    }
  });
  canvas.addEventListener("mouseleave", () => { cursorPosLabel.textContent = ""; });

  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const dir = ev.deltaY > 0 ? -1 : 1;
      setZoom(store.state.zoom + dir);
    },
    { passive: false }
  );

  zoomRange.addEventListener("input", () => setZoom(Number(zoomRange.value)));

  clearSelectionBtn.addEventListener("click", () => {
    store.state.selection = null;
    store.notify();
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
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      store.state.tool = btn.dataset.tool;
      store.notify();
    });
  });
  window.addEventListener("keydown", (ev) => {
    const tag = document.activeElement?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    const tool = TOOL_KEYS[ev.key.toLowerCase()];
    if (tool) {
      store.state.tool = tool;
      store.notify();
    }
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
