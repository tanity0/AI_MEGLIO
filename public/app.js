// app.js — エントリ・状態管理・Undo/Redo・共有ユーティリティ
import { initEditor } from "./editor.js";
import { initTimeline } from "./timeline.js";
import { initAi } from "./ai.js";
import { encodeGif } from "./gif.js";
import { importImageFile } from "./import.js";

// ---------------------------------------------------------------------------
// テキストグリッド文字割当て（サーバー側 server.js と同一の規則）
// 透明(index0) = '.'、1-9 = '1'-'9'、10-31 = 'a'-'v'
// ---------------------------------------------------------------------------
export function charForIndex(i) {
  if (i === 0) return ".";
  if (i >= 1 && i <= 9) return String(i);
  if (i >= 10 && i <= 31) return String.fromCharCode(97 + (i - 10));
  return null;
}
export function indexForChar(c) {
  if (c === "." || c === "?") return c === "." ? 0 : -1;
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "v") return c.charCodeAt(0) - 97 + 10;
  return -1;
}

export function frameToGridRows(project, frameIndex) {
  const { width, height, frames } = project;
  const pixels = frames[frameIndex].pixels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) row += charForIndex(pixels[y * width + x]) ?? ".";
    rows.push(row);
  }
  return rows;
}
export function frameToGridString(project, frameIndex) {
  return frameToGridRows(project, frameIndex).join("\n");
}

// 任意のピクセル配列（Uint8Array）をグリッド文字列に変換（ベースフレーム用）
export function pixelsToGridString(pixels, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) row += charForIndex(pixels[y * width + x]) ?? ".";
    rows.push(row);
  }
  return rows.join("\n");
}

// ベースフレームとの差分率（%）: §13.2-4 逸脱メーター
export function deviationPercent(project, frameIndex) {
  if (!project.baseFrame) return null;
  const pixels = project.frames[frameIndex].pixels;
  const base = project.baseFrame;
  const n = Math.min(pixels.length, base.length);
  if (n === 0) return 0;
  let diff = 0;
  for (let i = 0; i < n; i++) if (pixels[i] !== base[i]) diff++;
  return Math.round((diff / n) * 100);
}

// ---------------------------------------------------------------------------
// 色ユーティリティ
// ---------------------------------------------------------------------------
export function hexToRgba(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = parseInt(h.slice(6, 8), 16);
  return [r, g, b, a];
}

// ---------------------------------------------------------------------------
// 描画共通処理: フレームをコンテキストに cellSize でドット単位に描く
// ---------------------------------------------------------------------------
function drawPixels(ctx, pixels, width, height, palette, cellSize) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = pixels[y * width + x];
      const hex = palette[idx];
      if (!hex) continue;
      const [r, g, b, a] = hexToRgba(hex);
      if (a === 0) continue;
      ctx.fillStyle = a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a / 255})`;
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }
  }
}

export function drawFrameToContext(ctx, project, frameIndex, cellSize, opts = {}) {
  const { width, height, frames, palette } = project;
  ctx.clearRect(0, 0, width * cellSize, height * cellSize);
  if (opts.onion && frameIndex > 0 && frames[frameIndex - 1]) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    drawPixels(ctx, frames[frameIndex - 1].pixels, width, height, palette, cellSize);
    ctx.restore();
  }
  drawPixels(ctx, frames[frameIndex].pixels, width, height, palette, cellSize);
}

export function frameToPngDataUrl(project, frameIndex, cellSize = 8) {
  const canvas = document.createElement("canvas");
  canvas.width = project.width * cellSize;
  canvas.height = project.height * cellSize;
  const ctx = canvas.getContext("2d");
  drawFrameToContext(ctx, project, frameIndex, cellSize);
  return canvas.toDataURL("image/png");
}

// 任意のピクセル配列をPNG data URLに（ベースフレーム画像用）
export function pixelsToPngDataUrl(pixels, width, height, palette, cellSize = 8) {
  const canvas = document.createElement("canvas");
  canvas.width = width * cellSize;
  canvas.height = height * cellSize;
  const ctx = canvas.getContext("2d");
  const tmpProject = { width, height, palette, frames: [{ pixels }] };
  drawFrameToContext(ctx, tmpProject, 0, cellSize);
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// プロジェクトのシリアライズ（保存/読込・Undo用）
// ---------------------------------------------------------------------------
export function cloneProject(project) {
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    palette: project.palette.slice(),
    frames: project.frames.map((f) => ({ pixels: Uint8Array.from(f.pixels) })),
    baseFrame: project.baseFrame ? Uint8Array.from(project.baseFrame) : null,
    lockedRects: (project.lockedRects || []).map((r) => ({ ...r })),
  };
}
export function projectToPlain(project) {
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    palette: project.palette.slice(),
    frames: project.frames.map((f) => Array.from(f.pixels)),
    baseFrame: project.baseFrame ? Array.from(project.baseFrame) : null,
    lockedRects: (project.lockedRects || []).map((r) => ({ ...r })),
  };
}
export function projectFromPlain(o) {
  if (!o || typeof o !== "object") throw new Error("不正なプロジェクトファイルです");
  const { width, height, fps, palette, frames, baseFrame, lockedRects } = o;
  if (!Number.isInteger(width) || width < 8 || width > 96) throw new Error("width が不正です");
  if (!Number.isInteger(height) || height < 8 || height > 96) throw new Error("height が不正です");
  if (!Number.isInteger(fps) || fps < 1 || fps > 24) throw new Error("fps が不正です");
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 32) throw new Error("palette が不正です");
  if (!Array.isArray(frames) || frames.length < 1) throw new Error("frames が不正です");
  let base = null;
  if (Array.isArray(baseFrame)) {
    base = Uint8Array.from(baseFrame);
    if (base.length !== width * height) throw new Error("baseFrame のピクセル数が不正です");
  }
  const locked = [];
  if (Array.isArray(lockedRects)) {
    for (const r of lockedRects) {
      if (!r || ![r.x, r.y, r.w, r.h].every(Number.isInteger)) continue;
      if (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > width || r.y + r.h > height) continue;
      locked.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
  }
  return {
    width, height, fps,
    palette: palette.slice(),
    frames: frames.map((arr) => {
      const pixels = Uint8Array.from(arr);
      if (pixels.length !== width * height) throw new Error("frame のピクセル数が width*height と一致しません");
      return { pixels };
    }),
    baseFrame: base,
    lockedRects: locked,
  };
}

// ---------------------------------------------------------------------------
// サンプルプロジェクト（起動時ロード）: 32x32 8色 2フレーム、上下バウンド
// ---------------------------------------------------------------------------
function buildSampleFrame(width, height, offsetY, legsVariant) {
  const pixels = new Uint8Array(width * height);
  const sprite = [
    "..2222....",
    ".222222...",
    "22233322..",
    "22333332..",
    "23333332..",
    "23333332..",
    ".2333322..",
    "..111.....",
    ".41111.14.",
    ".41111.14.",
    "..1...1...",
    legsVariant ? "5.5...5.5." : ".55...55..",
  ];
  const ox = Math.floor((width - 10) / 2);
  const oy = Math.floor((height - 12) / 2) + offsetY;
  for (let y = 0; y < sprite.length; y++) {
    const py = oy + y;
    if (py < 0 || py >= height) continue;
    const row = sprite[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ".") continue;
      const px = ox + x;
      if (px < 0 || px >= width) continue;
      pixels[py * width + px] = Number(ch);
    }
  }
  return { pixels };
}

export function createSampleProject() {
  const width = 32, height = 32;
  const palette = [
    "#00000000", // 0: 透明
    "#1a1c2c", // 1: 濃紺（輪郭・足）
    "#5d275d", // 2: 紫（髪）
    "#b13e53", // 3: 赤紫（肌影）
    "#ef7d57", // 4: 橙（肌）
    "#ffcd75", // 5: 黄（靴）
    "#a7f070", // 6: 黄緑（未使用予備）
    "#38b764", // 7: 緑（未使用予備）
  ];
  const frames = [
    buildSampleFrame(width, height, 0, false),
    buildSampleFrame(width, height, -2, true),
  ];
  // frame 0 をベースフレームとして保持（逸脱メーター・差分ビュー・アンカリング用）
  const baseFrame = Uint8Array.from(frames[0].pixels);
  return { width, height, fps: 8, palette, frames, baseFrame, lockedRects: [] };
}

// ---------------------------------------------------------------------------
// ストア（状態管理・Undo/Redo・pub/sub）
// ---------------------------------------------------------------------------
const UNDO_LIMIT = 50;

class Store {
  constructor() {
    this.state = {
      project: createSampleProject(),
      currentFrame: 0,
      tool: "pen",
      colorIndex: 1,
      selection: null, // { frameIndex, x, y, w, h }
      onionSkin: false,
      diffView: false,
      zoom: 12,
      zoomAuto: true,
      timelinePlaying: false,
      flashCells: new Map(), // "frame:x:y" -> expiry ms
      aiBusy: false,
    };
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify() {
    for (const fn of this.listeners) fn();
  }
  pushUndo() {
    this.undoStack.push(projectToPlain(this.state.project));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(projectToPlain(this.state.project));
    const plain = this.undoStack.pop();
    this.state.project = projectFromPlain(plain);
    this.clampAfterProjectChange();
    this.notify();
    return true;
  }
  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(projectToPlain(this.state.project));
    const plain = this.redoStack.pop();
    this.state.project = projectFromPlain(plain);
    this.clampAfterProjectChange();
    this.notify();
    return true;
  }
  clampAfterProjectChange() {
    const n = this.state.project.frames.length;
    if (this.state.currentFrame >= n) this.state.currentFrame = n - 1;
    if (this.state.currentFrame < 0) this.state.currentFrame = 0;
    if (this.state.colorIndex >= this.state.project.palette.length) {
      this.state.colorIndex = this.state.project.palette.length - 1;
    }
    if (this.state.selection) {
      const sel = this.state.selection;
      if (sel.frameIndex >= n || sel.x + sel.w > this.state.project.width || sel.y + sel.h > this.state.project.height) {
        this.state.selection = null;
      }
    }
  }
  resetProject(project) {
    this.pushUndo();
    this.state.project = project;
    this.state.currentFrame = 0;
    this.state.selection = null;
    this.state.colorIndex = Math.min(1, project.palette.length - 1);
    this.notify();
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// トースト通知
// ---------------------------------------------------------------------------
export function toast(message, kind = "info") {
  const root = document.getElementById("toastRoot");
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " is-error" : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 5000 : 3000);
}

// ---------------------------------------------------------------------------
// ヘッダー: 新規 / 保存 / 読込 / PNG書き出し / GIF書き出し
// ---------------------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initHeader() {
  document.getElementById("newProjectBtn").addEventListener("click", () => {
    if (!confirm("現在のプロジェクトを破棄して新規作成しますか？")) return;
    store.resetProject(createSampleProject());
    toast("新規プロジェクトを作成しました");
  });

  document.getElementById("importImageInput").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const project = await importImageFile(file);
      if (!project) return; // ユーザーキャンセル
      store.resetProject(project);
      toast(`画像を ${project.width}×${project.height}・${project.palette.length}色 として読み込みました（frame 0 = ベースフレーム）`);
    } catch (err) {
      toast(`画像の読込に失敗しました: ${err.message}`, "error");
      console.error(err);
    }
  });

  document.getElementById("saveJsonBtn").addEventListener("click", () => {
    const json = JSON.stringify(projectToPlain(store.state.project), null, 0);
    downloadBlob(new Blob([json], { type: "application/json" }), "ai-meglio-project.json");
    toast("プロジェクトをJSON保存しました");
  });

  document.getElementById("loadJsonInput").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const project = projectFromPlain(JSON.parse(text));
      store.resetProject(project);
      toast("プロジェクトを読み込みました");
    } catch (err) {
      toast(`読込に失敗しました: ${err.message}`, "error");
    }
  });

  document.getElementById("exportPngBtn").addEventListener("click", () => {
    const { project } = store.state;
    const scale = 4;
    const canvas = document.createElement("canvas");
    canvas.width = project.width * scale * project.frames.length;
    canvas.height = project.height * scale;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < project.frames.length; i++) {
      ctx.save();
      ctx.translate(i * project.width * scale, 0);
      drawFrameToContext(ctx, project, i, scale);
      ctx.restore();
    }
    canvas.toBlob((blob) => {
      downloadBlob(blob, "ai-meglio-spritesheet.png");
      toast("スプライトシートPNGを書き出しました");
    }, "image/png");
  });

  document.getElementById("exportGifBtn").addEventListener("click", () => {
    try {
      const bytes = encodeGif(store.state.project);
      downloadBlob(new Blob([bytes], { type: "image/gif" }), "ai-meglio.gif");
      toast("GIFを書き出しました");
    } catch (err) {
      toast(`GIF書き出しに失敗しました: ${err.message}`, "error");
      console.error(err);
    }
  });
}

// ---------------------------------------------------------------------------
// グローバル Undo/Redo ショートカット
// ---------------------------------------------------------------------------
function initGlobalShortcuts() {
  window.addEventListener("keydown", (ev) => {
    const tag = document.activeElement?.tagName;
    const inText = tag === "TEXTAREA" || tag === "INPUT";
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod) return;
    const key = ev.key.toLowerCase();
    if (key === "z" && !ev.shiftKey) {
      if (inText) return;
      ev.preventDefault();
      if (!store.undo()) toast("これ以上元に戻せません");
    } else if ((key === "z" && ev.shiftKey) || key === "y") {
      if (inText) return;
      ev.preventDefault();
      if (!store.redo()) toast("これ以上やり直せません");
    }
  });
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
function main() {
  initHeader();
  initGlobalShortcuts();
  initEditor(store, toast);
  initTimeline(store, toast);
  initAi(store, toast);
  store.notify();
  // デバッグ/E2Eテスト用フック（UIには影響しない）
  window.aiMeglio = { store };
}

document.addEventListener("DOMContentLoaded", main);
