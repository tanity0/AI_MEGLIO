// editor.js — キャンバス描画・ツール・選択
import { drawFrameToContext, hexToRgba } from "./app.js";

const MIN_ZOOM = 2;
const MAX_ZOOM = 48;

export function initEditor(store, toast) {
  const canvas = document.getElementById("mainCanvas");
  const wrap = document.getElementById("canvasWrap");
  const ctx = canvas.getContext("2d");
  const onionToggle = document.getElementById("onionSkinToggle");
  const zoomRange = document.getElementById("zoomRange");
  const zoomLabel = document.getElementById("zoomLabel");
  const clearSelectionBtn = document.getElementById("clearSelectionBtn");
  const paletteGrid = document.getElementById("paletteGrid");
  const paletteAddBtn = document.getElementById("paletteAddBtn");
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
  canvas.addEventListener("mousedown", (ev) => {
    const { x, y } = cellFromEvent(ev);
    const tool = store.state.tool;
    const frameIndex = store.state.currentFrame;
    dragging = true;
    dragTool = tool;
    lastPaintedCell = null;

    if (tool === "pen" || tool === "eraser") {
      store.pushUndo();
      const color = tool === "eraser" ? 0 : store.state.colorIndex;
      if (setPixel(frameIndex, x, y, color)) lastPaintedCell = `${x},${y}`;
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
    if (dragTool === "pen" || dragTool === "eraser") {
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

  window.addEventListener("mouseup", () => {
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
  function renderPalette() {
    const p = project();
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
  paletteAddBtn.addEventListener("click", () => {
    const p = project();
    if (p.palette.length >= 32) {
      toast("パレットは最大32色です", "error");
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

    // 選択範囲（点線）
    if (sel && sel.frameIndex === store.state.currentFrame) {
      ctx.save();
      ctx.strokeStyle = "#6ee7c8";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(sel.x * cellSize + 1, sel.y * cellSize + 1, sel.w * cellSize - 2, sel.h * cellSize - 2);
      ctx.restore();
    }

    renderPalette();
    canvasSizeLabel.textContent = `${p.width} x ${p.height}`;
    onionToggle.checked = store.state.onionSkin;
    zoomRange.value = String(store.state.zoom);
    zoomLabel.textContent = `${store.state.zoom}x`;
    toolButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.tool === store.state.tool));
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
