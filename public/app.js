// app.js — エントリ・状態管理・Undo/Redo・共有ユーティリティ
import { initEditor } from "./editor.js";
import { initTimeline } from "./timeline.js";
import { initAi } from "./ai.js";
import { encodeGif } from "./gif.js";
import { importImageFile, probeImage } from "./import.js";
import { initRig } from "./rig.js";
import { initGameExport, initGameView } from "./gameexport.js";
import { initStyleRef } from "./styleref.js";
import { initStudio, openStudio } from "./studio.js";
import { initHelp } from "./help.js";

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

// §18.1: 33色以上は1ピクセル=2文字hex表現
export function isWidePalette(paletteLen) { return paletteLen > 32; }
export function cellChars(paletteLen) { return isWidePalette(paletteLen) ? 2 : 1; }
export function tokenForIndex(i, wide) {
  if (wide) return i === 0 ? ".." : i.toString(16).padStart(2, "0");
  return charForIndex(i) ?? ".";
}
// 0..255 = index / -1 = 変更しない / -2 = 不正
export function indexForToken(tok, wide) {
  if (wide) {
    if (tok === "..") return 0;
    if (tok === "??") return -1;
    if (/^[0-9a-f]{2}$/.test(tok)) return parseInt(tok, 16);
    return -2;
  }
  if (tok === ".") return 0;
  if (tok === "?") return -1;
  const i = indexForChar(tok);
  return i >= 0 ? i : -2;
}
export function splitTokens(row, cw) {
  if (cw === 1) return row.split("");
  const out = [];
  for (let i = 0; i < row.length; i += 2) out.push(row.slice(i, i + 2));
  return out;
}

export function frameToGridRows(project, frameIndex) {
  const { width, height, frames } = project;
  const wide = isWidePalette(project.palette.length);
  const pixels = frames[frameIndex].pixels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) row += tokenForIndex(pixels[y * width + x], wide);
    rows.push(row);
  }
  return rows;
}
export function frameToGridString(project, frameIndex) {
  return frameToGridRows(project, frameIndex).join("\n");
}

// 任意のピクセル配列（Uint8Array）をグリッド文字列に変換（ベースフレーム用）
export function pixelsToGridString(pixels, width, height, paletteLen = 32) {
  const wide = isWidePalette(paletteLen);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) row += tokenForIndex(pixels[y * width + x], wide);
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
function cloneRig(rig, toPlain) {
  if (!rig) return null;
  const conv = toPlain ? (px) => Array.from(px) : (px) => Uint8Array.from(px);
  return {
    parts: (rig.parts || []).map((p) => ({
      id: p.id,
      name: p.name,
      patch: { x: p.patch.x, y: p.patch.y, w: p.patch.w, h: p.patch.h, pixels: conv(p.patch.pixels) },
      pivot: { x: p.pivot.x, y: p.pivot.y },
      z: p.z,
      parent: p.parent || "",
      visible: p.visible !== false,
      fixed: p.fixed === true,
    })),
    keyframes: (rig.keyframes || []).map((kf) => {
      const out = {};
      for (const [id, t] of Object.entries(kf)) out[id] = { dx: t.dx || 0, dy: t.dy || 0, rot: t.rot || 0 };
      return out;
    }),
    generatedAt: Number.isInteger(rig.generatedAt) ? rig.generatedAt : null,
  };
}

// ---------------------------------------------------------------------------
// アニメーションタグ（§16.1）: フレーム範囲参照 {name, start, end, fps, loop}
// ---------------------------------------------------------------------------
export function defaultTags(project) {
  return [{ name: "all", start: 0, end: project.frames.length - 1, fps: project.fps, loop: true }];
}

function cloneTags(tags) {
  return (tags || []).map((t) => ({ name: t.name, start: t.start, end: t.end, fps: t.fps, loop: !!t.loop }));
}

function tagsFromPlain(raw, frameCount, fps) {
  const tags = [];
  if (Array.isArray(raw)) {
    for (const t of raw) {
      if (!t || typeof t.name !== "string" || !t.name.trim()) continue;
      if (!Number.isInteger(t.start) || !Number.isInteger(t.end)) continue;
      const start = Math.max(0, Math.min(frameCount - 1, t.start));
      const end = Math.max(start, Math.min(frameCount - 1, t.end));
      const tfps = Number.isInteger(t.fps) && t.fps >= 1 && t.fps <= 24 ? t.fps : fps;
      tags.push({ name: t.name.trim().slice(0, 32), start, end, fps: tfps, loop: t.loop !== false });
    }
  }
  return tags;
}

function variantsFromPlain(raw, paletteLen) {
  const variants = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (!v || typeof v.name !== "string" || !v.name.trim()) continue;
      if (!Array.isArray(v.palette) || v.palette.length < 1 || v.palette.length > 32) continue;
      if (!v.palette.every((c) => typeof c === "string")) continue;
      variants.push({ name: v.name.trim().slice(0, 32), palette: v.palette.slice() });
    }
  }
  return variants;
}

// フレーム挿入時のタグ範囲自動補正（index の位置に count 枚挿入）
export function adjustTagsOnInsert(project, index, count = 1) {
  for (const t of project.tags || []) {
    if (index <= t.start) {
      t.start += count;
      t.end += count;
    } else if (index <= t.end) {
      t.end += count; // タグ内部への挿入はタグを広げる
    }
  }
}

// フレーム削除時のタグ範囲自動補正（index のフレームを1枚削除した後に呼ぶ）
export function adjustTagsOnDelete(project, index) {
  const tags = project.tags || [];
  for (let i = tags.length - 1; i >= 0; i--) {
    const t = tags[i];
    if (index < t.start) {
      t.start--;
      t.end--;
    } else if (index <= t.end) {
      t.end--;
    }
    if (t.end < t.start || t.start < 0) tags.splice(i, 1);
  }
}

export function uniqueTagName(project, baseName) {
  const names = new Set((project.tags || []).map((t) => t.name));
  if (!names.has(baseName)) return baseName;
  let n = 2;
  while (names.has(`${baseName}_${n}`)) n++;
  return `${baseName}_${n}`;
}

// モーション/リグ生成結果を新しいタグとして末尾に追加（§16.1）
export function addGeneratedTag(project, baseName, start, end) {
  if (!Array.isArray(project.tags)) project.tags = [];
  const tag = {
    name: uniqueTagName(project, baseName),
    start,
    end,
    fps: project.fps,
    loop: true,
  };
  project.tags.push(tag);
  return tag;
}

// §17.1: トンマナ参照 {imageDataUrl, guide, enabled}
function cloneStyleRef(s) {
  if (!s || typeof s !== "object") return null;
  return {
    imageDataUrl: typeof s.imageDataUrl === "string" ? s.imageDataUrl : "",
    guide: typeof s.guide === "string" ? s.guide : "",
    enabled: !!s.enabled,
  };
}
function mainPaletteFromPlain(raw, paletteLen) {
  if (!raw || !Array.isArray(raw.colors) || !Array.isArray(raw.groups)) return null;
  if (raw.groups.length !== paletteLen) return null;
  if (!raw.colors.every((c) => typeof c === "string") || raw.colors.length < 1 || raw.colors.length > 64) return null;
  if (!raw.groups.every((g) => Number.isInteger(g) && g >= -1 && g < raw.colors.length)) return null;
  return { colors: raw.colors.slice(), groups: raw.groups.slice() };
}

function styleRefFromPlain(raw) {
  if (!raw || typeof raw !== "object") return null;
  const imageDataUrl = typeof raw.imageDataUrl === "string" && raw.imageDataUrl.startsWith("data:image/") ? raw.imageDataUrl : "";
  const guide = typeof raw.guide === "string" ? raw.guide.slice(0, 4000) : "";
  if (!imageDataUrl && !guide) return null;
  return { imageDataUrl, guide, enabled: !!raw.enabled };
}

// §17.3: styleRef.enabled のとき全AIリクエストに付与するフィールド
// （画像はAPIバックエンドのみ。CLIではテキストのみ）
export function styleRequestFields(project, serverConfig) {
  const s = project.styleRef;
  if (!s || !s.enabled || !s.guide.trim()) return {};
  const fields = { styleGuide: s.guide.trim() };
  const backend = serverConfig?.backend || "api";
  if (backend === "api" && s.imageDataUrl && s.imageDataUrl.startsWith("data:image/png;base64,")) {
    fields.styleImage = s.imageDataUrl;
  }
  return fields;
}

export function cloneProject(project) {
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    palette: project.palette.slice(),
    frames: project.frames.map((f) => ({ pixels: Uint8Array.from(f.pixels) })),
    baseFrame: project.baseFrame ? Uint8Array.from(project.baseFrame) : null,
    lockedRects: (project.lockedRects || []).map((r) => ({ ...r })),
    rig: cloneRig(project.rig, false),
    tags: cloneTags(project.tags),
    variants: (project.variants || []).map((v) => ({ name: v.name, palette: v.palette.slice() })),
    profile: project.profile ? JSON.parse(JSON.stringify(project.profile)) : null,
    styleRef: cloneStyleRef(project.styleRef),
    sourceImage: typeof project.sourceImage === "string" ? project.sourceImage : null,
    conversionParams: project.conversionParams ? JSON.parse(JSON.stringify(project.conversionParams)) : null,
    mainPalette: project.mainPalette ? { colors: project.mainPalette.colors.slice(), groups: project.mainPalette.groups.slice() } : null,
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
    rig: cloneRig(project.rig, true),
    tags: cloneTags(project.tags),
    variants: (project.variants || []).map((v) => ({ name: v.name, palette: v.palette.slice() })),
    profile: project.profile ? JSON.parse(JSON.stringify(project.profile)) : null,
    styleRef: cloneStyleRef(project.styleRef),
    sourceImage: typeof project.sourceImage === "string" ? project.sourceImage : null,
    conversionParams: project.conversionParams ? JSON.parse(JSON.stringify(project.conversionParams)) : null,
    mainPalette: project.mainPalette ? { colors: project.mainPalette.colors.slice(), groups: project.mainPalette.groups.slice() } : null,
  };
}
function rigFromPlain(raw, width, height) {
  if (!raw || typeof raw !== "object") return null;
  const parts = [];
  const seen = new Set();
  if (Array.isArray(raw.parts)) {
    for (const p of raw.parts) {
      if (!p || typeof p.id !== "string" || seen.has(p.id) || typeof p.name !== "string") continue;
      const pa = p.patch;
      if (!pa || ![pa.x, pa.y, pa.w, pa.h].every(Number.isInteger)) continue;
      if (pa.x < 0 || pa.y < 0 || pa.w <= 0 || pa.h <= 0 || pa.x + pa.w > width || pa.y + pa.h > height) continue;
      if (!Array.isArray(pa.pixels) || pa.pixels.length !== pa.w * pa.h) continue;
      if (!p.pivot || !Number.isInteger(p.pivot.x) || !Number.isInteger(p.pivot.y)) continue;
      parts.push({
        id: p.id,
        name: p.name,
        patch: { x: pa.x, y: pa.y, w: pa.w, h: pa.h, pixels: Uint8Array.from(pa.pixels) },
        pivot: {
          x: Math.max(0, Math.min(pa.w - 1, p.pivot.x)),
          y: Math.max(0, Math.min(pa.h - 1, p.pivot.y)),
        },
        z: Number.isInteger(p.z) ? p.z : 0,
        parent: typeof p.parent === "string" ? p.parent : "",
        visible: p.visible !== false,
        fixed: p.fixed === true,
      });
      seen.add(p.id);
    }
  }
  for (const p of parts) if (p.parent && !seen.has(p.parent)) p.parent = "";
  const keyframes = [];
  if (Array.isArray(raw.keyframes)) {
    for (const kf of raw.keyframes) {
      if (!kf || typeof kf !== "object") continue;
      const out = {};
      for (const [id, t] of Object.entries(kf)) {
        if (!seen.has(id) || !t) continue;
        out[id] = {
          dx: Number.isFinite(t.dx) ? Math.round(t.dx) : 0,
          dy: Number.isFinite(t.dy) ? Math.round(t.dy) : 0,
          rot: Number.isFinite(t.rot) ? Math.round(t.rot / 15) * 15 : 0,
        };
      }
      keyframes.push(out);
    }
  }
  return {
    parts,
    keyframes,
    generatedAt: Number.isInteger(raw.generatedAt) ? raw.generatedAt : null,
  };
}

export function projectFromPlain(o) {
  if (!o || typeof o !== "object") throw new Error("不正なプロジェクトファイルです");
  const { width, height, fps, palette, frames, baseFrame, lockedRects } = o;
  if (!Number.isInteger(width) || width < 8 || width > 128) throw new Error("width が不正です");
  if (!Number.isInteger(height) || height < 8 || height > 128) throw new Error("height が不正です");
  if (!Number.isInteger(fps) || fps < 1 || fps > 24) throw new Error("fps が不正です");
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 256) throw new Error("palette が不正です");
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
  const project = {
    width, height, fps,
    palette: palette.slice(),
    frames: frames.map((arr) => {
      const pixels = Uint8Array.from(arr);
      if (pixels.length !== width * height) throw new Error("frame のピクセル数が width*height と一致しません");
      return { pixels };
    }),
    baseFrame: base,
    lockedRects: locked,
    rig: rigFromPlain(o.rig, width, height),
    variants: variantsFromPlain(o.variants, palette.length),
    profile: o.profile && typeof o.profile === "object" ? o.profile : null,
    styleRef: styleRefFromPlain(o.styleRef),
    sourceImage: typeof o.sourceImage === "string" && o.sourceImage.startsWith("data:image/") ? o.sourceImage : null,
    conversionParams: o.conversionParams && typeof o.conversionParams === "object" ? o.conversionParams : null,
    mainPalette: mainPaletteFromPlain(o.mainPalette, palette.length),
  };
  // §16.1: 既存プロジェクト（tags無し）は「all」タグを自動生成
  const tags = tagsFromPlain(o.tags, project.frames.length, fps);
  project.tags = tags.length ? tags : defaultTags(project);
  return project;
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
  const project = { width, height, fps: 8, palette, frames, baseFrame, lockedRects: [], variants: [], profile: null, styleRef: null };
  project.tags = defaultTags(project);
  return project;
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
      rigSelectedPart: null,
      rigAdjustMode: false,
      activeTagIndex: -1, // §16.1: 選択中タグ（-1 = 全体）
      serverConfig: null, // /api/config の内容（§17でバックエンド判定に使用）
      highlightGroup: null, // §18.3: メイングループハイライト
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
    const rig = this.state.project.rig;
    if (this.state.rigSelectedPart && !(rig && rig.parts.some((p) => p.id === this.state.rigSelectedPart))) {
      this.state.rigSelectedPart = null;
    }
    const p = this.state.project;
    if (!Array.isArray(p.tags)) p.tags = defaultTags(p);
    for (let i = p.tags.length - 1; i >= 0; i--) {
      const t = p.tags[i];
      t.start = Math.max(0, Math.min(n - 1, t.start));
      t.end = Math.max(t.start, Math.min(n - 1, t.end));
      if (t.end < t.start) p.tags.splice(i, 1);
    }
    if (this.state.activeTagIndex >= p.tags.length) this.state.activeTagIndex = -1;
    if (!Array.isArray(p.variants)) p.variants = [];
    if (this.state.highlightGroup !== null && !(p.mainPalette && this.state.highlightGroup < p.mainPalette.colors.length)) {
      this.state.highlightGroup = null;
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
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
      // §18.2: 32色以下の真ドット絵で自動判定成功時のみ従来ショートカット、
      // それ以外は変換スタジオを開く
      const probe = await probeImage(file);
      if (probe.shortcut) {
        const project = await importImageFile(file);
        if (!project) return; // ユーザーキャンセル
        store.resetProject(project);
        toast(`画像を ${project.width}×${project.height}・${project.palette.length}色 として読み込みました（frame 0 = ベースフレーム）`);
      } else {
        const dataUrl = await fileToDataUrl(file);
        toast("変換スタジオを開きます（真ドット絵と判定できなかったため）");
        await openStudio(dataUrl);
      }
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
      const project = store.state.project;
      const tag = store.state.activeTagIndex >= 0 ? project.tags[store.state.activeTagIndex] : null;
      const target = tag
        ? { ...project, fps: tag.fps, frames: project.frames.slice(tag.start, tag.end + 1) }
        : project;
      const bytes = encodeGif(target);
      const name = tag ? `ai-meglio_${tag.name}.gif` : "ai-meglio.gif";
      downloadBlob(new Blob([bytes], { type: "image/gif" }), name);
      toast(tag ? `タグ「${tag.name}」をGIF書き出ししました` : "GIFを書き出しました");
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
  document.getElementById("undoBtn")?.addEventListener("click", () => {
    if (!store.undo()) toast("これ以上元に戻せません");
  });
  document.getElementById("redoBtn")?.addEventListener("click", () => {
    if (!store.redo()) toast("これ以上やり直せません");
  });
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
// サーバー設定を取得してバックエンド表示（§15.1）
async function initBackendLabel() {
  const label = document.getElementById("backendLabel");
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    store.state.serverConfig = cfg;
    const name = cfg.mock ? "MOCK" : cfg.backend === "cli" ? "Claude Code CLI" : "API";
    label.textContent = `バックエンド: ${name}`;
    label.title = cfg.mock
      ? "MOCKモード（APIを呼びません）"
      : cfg.backend === "cli"
        ? `Claude Code CLI（モデル: ${cfg.cliModel}。画像は送信されません）`
        : `Anthropic API（モデル: ${cfg.model}, effort: ${cfg.effort}）`;
  } catch {
    label.textContent = "バックエンド: 不明";
  }
}

function main() {
  initHeader();
  initGlobalShortcuts();
  initEditor(store, toast);
  initTimeline(store, toast);
  initAi(store, toast);
  initRig(store, toast);
  initGameExport(store, toast);
  initGameView(store);
  initStyleRef(store, toast);
  initStudio(store, toast);
  initHelp();
  initBackendLabel();
  store.notify();
  // デバッグ/E2Eテスト用フック（UIには影響しない）
  window.aiMeglio = { store };
}

document.addEventListener("DOMContentLoaded", main);
