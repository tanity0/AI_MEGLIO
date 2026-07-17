// app.js — エントリ・状態管理・Undo/Redo・共有ユーティリティ
import { initEditor } from "./editor.js";
import { initTimeline } from "./timeline.js";
import { initAi } from "./ai.js";
import { encodeGif, pingpongFrames } from "./gif.js";
import { importImageFile, probeImage } from "./import.js";
import { initRig, PART_ROLES } from "./rig.js";
import { initGameExport, initGameView } from "./gameexport.js";
import { initStyleRef } from "./styleref.js";
import { initStudio, openStudio, getStudioView } from "./studio.js";
import { initMotionStudio } from "./motionstudio.js";
import { initHelp } from "./help.js";
import { initCanvasResize } from "./canvasresize.js"; // §28 キャンバスのリサイズ
import { initLiveSync } from "./livesync.js"; // §29 ライブプロジェクト同期
import { initSendGpt } from "./sendgpt.js"; // §36 「GPTへ送る」
import { initBackdrop } from "./backdrop.js"; // §45 背景色の変更（表示専用）
import { initMobile } from "./mobile.js"; // §49 スマホレイアウト（ドロワー化）
import { initAutosave } from "./autosave.js"; // §50.1 自動保存＆復元（IndexedDB）
import { initSwUpdate } from "./swupdate.js"; // §50.7 SW更新チェック（新バージョン案内バナー）

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
export function drawPixels(ctx, pixels, width, height, palette, cellSize) {
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
      // §22.7: 役割は任意フィールド（未設定なら含めない。undo/保存の双方で透過維持）
      ...(typeof p.role === "string" && p.role ? { role: p.role } : {}),
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
  // §22.9-3: guide が文字列でない壊れた styleRef でも throw しない（busy 表示が残る事故の芽を摘む）
  if (!s || !s.enabled || typeof s.guide !== "string" || !s.guide.trim()) return {};
  const fields = { styleGuide: s.guide.trim() };
  const backend = serverConfig?.backend || "api";
  if (backend === "api" && s.imageDataUrl && s.imageDataUrl.startsWith("data:image/png;base64,")) {
    fields.styleImage = s.imageDataUrl;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// §35: レイヤー（軽量v1・フレームごと独立）
// frame = { layers: [{id,name,pixels,visible,opacity}], activeLayer, pixels }
// frame.pixels は「可視レイヤーの不透明合成」のキャッシュとして常に同期保持し、
// 既存の全読み手（描画/GIF/PNG/書き出し/オニオン/差分/変換/候補/リグ）は無改修で正しい。
// opacity は編集画面の表示専用（合成キャッシュ＝書き出しには影響しない）。
// ---------------------------------------------------------------------------
let layerIdSeq = 1;

export function makeLayer(pixels, name) {
  return { id: `layer${layerIdSeq++}`, name: name || "レイヤー", pixels, visible: true, opacity: 1 };
}

// frame.layers を保証（旧形式 {pixels} のフレームは単一レイヤー化）。
// 自動生成の単一レイヤーは frame.pixels と同じ Uint8Array を共有する
// （単一レイヤー時はレイヤー内容＝合成なので、従来コードと完全に同一挙動・ゼロコスト）。
export function syncFrameLayers(frame) {
  if (!Array.isArray(frame.layers) || frame.layers.length === 0) {
    frame.layers = [makeLayer(frame.pixels, "レイヤー1")];
    frame.activeLayer = 0;
  }
  if (!Number.isInteger(frame.activeLayer)) frame.activeLayer = frame.layers.length - 1;
  frame.activeLayer = Math.max(0, Math.min(frame.layers.length - 1, frame.activeLayer));
  return frame;
}

export function frameActiveLayer(frame) {
  syncFrameLayers(frame);
  return frame.layers[frame.activeLayer];
}

export function frameActiveLayerPixels(frame) {
  return frameActiveLayer(frame).pixels;
}

// 可視レイヤーの不透明合成（z順=配列末尾が最前面。非透明 index≠0 が上勝ち）で
// frame.pixels キャッシュを更新。opacity は反映しない（表示専用）。
export function recompositeFrame(frame) {
  syncFrameLayers(frame);
  const layers = frame.layers;
  if (layers.length === 1 && layers[0].visible !== false) {
    frame.pixels = layers[0].pixels; // 単一可視レイヤーは共有（従来と同一挙動）
    return frame;
  }
  const n = layers[0].pixels.length;
  let out = frame.pixels;
  // 既存バッファを再利用（ただしいずれかのレイヤーと共有中/サイズ不一致なら新規確保）
  if (!(out instanceof Uint8Array) || out.length !== n || layers.some((l) => l.pixels === out)) {
    out = new Uint8Array(n);
  } else {
    out.fill(0);
  }
  for (const l of layers) {
    if (l.visible === false) continue;
    const px = l.pixels;
    for (let i = 0; i < n; i++) if (px[i] !== 0) out[i] = px[i];
  }
  frame.pixels = out;
  return frame;
}

// フレーム内容を「フラットな結果」で丸ごと差し替える（レイヤーは単一に初期化）。
// リグ再合成・候補取り込み等、レイヤー構造を持たない生成結果で置き換える経路用。
export function setFramePixels(frame, pixels) {
  frame.pixels = pixels;
  frame.layers = [makeLayer(pixels, "レイヤー1")];
  frame.activeLayer = 0;
  return frame;
}

// フレームのディープコピー（レイヤー構造ごと複製）
export function cloneFrame(frame) {
  if (Array.isArray(frame.layers) && frame.layers.length > 0) {
    const layers = frame.layers.map((l) => {
      const nl = makeLayer(Uint8Array.from(l.pixels), l.name);
      nl.visible = l.visible !== false;
      nl.opacity = Number.isFinite(l.opacity) ? Math.max(0, Math.min(1, l.opacity)) : 1;
      return nl;
    });
    const nf = { layers, activeLayer: Number.isInteger(frame.activeLayer) ? frame.activeLayer : layers.length - 1, pixels: null };
    recompositeFrame(nf);
    return nf;
  }
  return { pixels: Uint8Array.from(frame.pixels) };
}

// 直列化: 既定の単一レイヤー（名前/表示/不透明度が初期値）は旧形式（配列）のまま
// 書き出して後方互換を維持。それ以外は {layers, activeLayer} 形式（pixelsキャッシュは保存しない）。
function frameToPlain(frame) {
  const layers = Array.isArray(frame.layers) ? frame.layers : null;
  const isDefaultSingle =
    !layers ||
    (layers.length === 1 &&
      layers[0].visible !== false &&
      (!Number.isFinite(layers[0].opacity) || layers[0].opacity === 1) &&
      layers[0].name === "レイヤー1");
  if (isDefaultSingle) return Array.from(frame.pixels);
  return {
    layers: layers.map((l) => ({
      name: typeof l.name === "string" ? l.name : "レイヤー",
      visible: l.visible !== false,
      opacity: Number.isFinite(l.opacity) ? Math.max(0, Math.min(1, l.opacity)) : 1,
      pixels: Array.from(l.pixels),
    })),
    activeLayer: Number.isInteger(frame.activeLayer) ? frame.activeLayer : layers.length - 1,
  };
}

function frameFromPlain(raw, width, height) {
  if (Array.isArray(raw)) {
    // 旧形式（pixels配列のみ）→ そのままロード（レイヤーは初回アクセス時に単一レイヤー化）
    const pixels = Uint8Array.from(raw);
    if (pixels.length !== width * height) throw new Error("frame のピクセル数が width*height と一致しません");
    return { pixels };
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.layers) && raw.layers.length >= 1) {
    const layers = raw.layers.map((l, i) => {
      if (!l || !Array.isArray(l.pixels)) throw new Error("layer が不正です");
      const px = Uint8Array.from(l.pixels);
      if (px.length !== width * height) throw new Error("layer のピクセル数が width*height と一致しません");
      const layer = makeLayer(px, typeof l.name === "string" && l.name.trim() ? l.name.trim().slice(0, 32) : `レイヤー${i + 1}`);
      layer.visible = l.visible !== false;
      layer.opacity = Number.isFinite(l.opacity) ? Math.max(0, Math.min(1, l.opacity)) : 1;
      return layer;
    });
    const frame = { layers, activeLayer: Number.isInteger(raw.activeLayer) ? raw.activeLayer : layers.length - 1, pixels: null };
    recompositeFrame(frame); // pixels キャッシュは読込時に再合成
    return frame;
  }
  throw new Error("frame の形式が不正です");
}

export function cloneProject(project) {
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    palette: project.palette.slice(),
    frames: project.frames.map((f) => cloneFrame(f)),
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
    playMode: project.playMode === "pingpong" ? "pingpong" : "loop", // §25.9-4
  };
}
export function projectToPlain(project) {
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    palette: project.palette.slice(),
    frames: project.frames.map((f) => frameToPlain(f)), // §35: レイヤーを直列化（既定単一レイヤーは旧形式）
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
    playMode: project.playMode === "pingpong" ? "pingpong" : "loop", // §25.9-4
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
        // §22.7: 役割の読込（未知の値は無視 = 名前推定へフォールバック）
        ...(PART_ROLES.includes(p.role) ? { role: p.role } : {}),
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
    frames: frames.map((raw) => frameFromPlain(raw, width, height)), // §35: 旧形式（配列）/新形式（layers）両対応
    baseFrame: base,
    lockedRects: locked,
    rig: rigFromPlain(o.rig, width, height),
    variants: variantsFromPlain(o.variants, palette.length),
    profile: o.profile && typeof o.profile === "object" ? o.profile : null,
    styleRef: styleRefFromPlain(o.styleRef),
    sourceImage: typeof o.sourceImage === "string" && o.sourceImage.startsWith("data:image/") ? o.sourceImage : null,
    conversionParams: o.conversionParams && typeof o.conversionParams === "object" ? o.conversionParams : null,
    mainPalette: mainPaletteFromPlain(o.mainPalette, palette.length),
    playMode: o.playMode === "pingpong" ? "pingpong" : "loop", // §25.9-4（未知値は loop）
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
      onionMode: "none", // §34.4: "none" | "prev" | "both"
      onionOpacity: 0.35, // §34.4: 0..1
      diffView: false,
      gridShow: false, // §34.2（editor.js 初期化時に localStorage で上書き）
      gridMajor: 8, // §34.2: 8 | 16
      mirrorDraw: false, // §34.3
      mirrorAxisX: null, // §34.3: null = キャンバス中央（(width-1)/2）
      rigSelectedPart: null,
      rigAdjustMode: false,
      activeTagIndex: -1, // §16.1: 選択中タグ（-1 = 全体）
      serverConfig: null, // /api/config の内容（§17でバックエンド判定に使用）
      // §48.1: 静的モード（GitHub Pages 等・サーバー無し）。起動時の GET /api/config 失敗で true。
      // 判定はこの1箇所（detectStaticMode）のみ。各モジュールは store.state.staticMode を参照する。
      staticMode: false,
      // §50.1: ライブ同期（§29）が ON かどうか。ON の間は自動保存を停止する（二重管理防止）。
      // livesync.js の enable()/disable() が更新する。
      liveSyncEnabled: false,
      highlightGroup: null, // §18.3: メイングループハイライト
      zoom: 12,
      zoomAuto: true,
      timelinePlaying: false,
      flashCells: new Map(), // "frame:x:y" -> expiry ms
      aiBusy: false,
      // §46: プロジェクト世代。resetProject（新規/変換確定のプロジェクト化/JSON読込/
      // ライブ同期の外部ロード/画像を開くショートカット）で増える。フレーム編集では不変。
      // ギャラリーセッション等の「旧プロジェクト前提の状態」の失効判定に使う。
      projectEpoch: 0,
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
    // §49.7-2: アンドゥ不発の根因。pushUndo() は undoStack/redoStack を変更する唯一の経路の
    // 一つだが、これまで notify() を呼んでいなかった。editor.js のドット/ストローク確定
    // （pointerup/pointermove）は pushUndo() の直後に paintStroke/render を独自に呼ぶだけで
    // store.notify() を経由しないため、#undoBtn/#mobileUndoBtn の disabled 同期
    // （syncUndoRedoButtons は store.subscribe 経由）が更新されないまま取り残されていた。
    // 「描画→即↩」で↩ボタンが disabled のまま（=タップが物理的に無視される）になり、
    // その後たまたま別の操作で notify() が走った時だけ同期されて「たまに効く」ように見えていた。
    // pushUndo() 自体で通知することで、undoStack が増えた瞬間に必ずボタンが活性化する。
    this.notify();
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
    this.state.projectEpoch++; // §46: プロジェクト差し替え = 世代を進める
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

// ---------------------------------------------------------------------------
// §38: サーバー保存（saves/）＋「保存したフォルダを自動で開く」
// ---------------------------------------------------------------------------
const AUTO_OPEN_FOLDER_KEY = "aiMeglio.autoOpenFolder";

export function autoOpenFolderEnabled() {
  try { return localStorage.getItem(AUTO_OPEN_FOLDER_KEY) !== "0"; } catch { return true; } // 既定ON
}

export function setAutoOpenFolderEnabled(on) {
  try { localStorage.setItem(AUTO_OPEN_FOLDER_KEY, on ? "1" : "0"); } catch {}
}

// ホワイトリストの保存先フォルダを OS ファイラーで開く（サーバー側 §38.1）
export async function openServerFolder(target) {
  const res = await fetch("/api/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// トグルONのときだけフォルダを開く（失敗はトースト警告のみ・保存自体は成功扱い）
export async function maybeOpenServerFolder(target) {
  if (!autoOpenFolderEnabled()) return;
  try {
    await openServerFolder(target);
  } catch (err) {
    toast(`フォルダを開けませんでした: ${err.message}`, "error");
  }
}

// サーバー保存用のファイル名サニタイズ（英数-_ 以外は _ に。拡張子は維持）
export function sanitizeSaveName(name) {
  const m = /^(.*)\.(json|png|gif)$/i.exec(name || "");
  const base = (m ? m[1] : String(name || "file")).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "file";
  const ext = m ? m[2].toLowerCase() : "json";
  return `${base}.${ext}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Blob をサーバーの saves/ にアトミック保存し、保存先フルパスを返す
export async function saveBlobToServer(name, blob) {
  const dataBase64 = await blobToBase64(blob);
  const res = await fetch("/api/save-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "saves", name: sanitizeSaveName(name), dataBase64 }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json; // { ok, path, dir, name, bytes }
}

// 「フォルダへ保存」共通経路: saves/ へ保存→トーストにパス→（トグルONなら）フォルダを開く
async function saveBlobToFolder(name, blob) {
  try {
    const json = await saveBlobToServer(name, blob);
    toast(`保存しました: ${json.path}`);
    await maybeOpenServerFolder("saves");
  } catch (err) {
    toast(`サーバー保存に失敗しました: ${err.message}`, "error");
  }
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

  // §38: 保存(JSON)/PNG/GIF の生成を共通化（ダウンロード保存とフォルダへ保存で共用）
  function buildProjectJsonBlob() {
    const json = JSON.stringify(projectToPlain(store.state.project), null, 0);
    return new Blob([json], { type: "application/json" });
  }
  function buildSpritesheetBlob() {
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
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  function buildGifBlob() {
    const project = store.state.project;
    const tag = store.state.activeTagIndex >= 0 ? project.tags[store.state.activeTagIndex] : null;
    let frames = tag ? project.frames.slice(tag.start, tag.end + 1) : project.frames;
    // §25.9-4: ピンポン書き出し（フレーム列を往復展開。端重複なし = 2N-2 枚）
    const pingpong = document.getElementById("gifPingpongChk")?.checked;
    if (pingpong) frames = pingpongFrames(frames);
    const target = { ...project, fps: tag ? tag.fps : project.fps, frames };
    const bytes = encodeGif(target);
    const name = tag ? `ai-meglio_${tag.name}.gif` : "ai-meglio.gif";
    return { blob: new Blob([bytes], { type: "image/gif" }), name, tag };
  }

  document.getElementById("saveJsonBtn").addEventListener("click", () => {
    downloadBlob(buildProjectJsonBlob(), "ai-meglio-project.json");
    toast("プロジェクトをJSON保存しました");
  });

  // §38: フォルダへ保存（saves/ へサーバー保存 → トーストにパス → 自動でフォルダを開く）
  document.getElementById("saveJsonFolderBtn")?.addEventListener("click", async () => {
    await saveBlobToFolder("ai-meglio-project.json", buildProjectJsonBlob());
  });
  document.getElementById("exportPngFolderBtn")?.addEventListener("click", async () => {
    const blob = await buildSpritesheetBlob();
    if (!blob) { toast("PNGの生成に失敗しました", "error"); return; }
    await saveBlobToFolder("ai-meglio-spritesheet.png", blob);
  });
  document.getElementById("exportGifFolderBtn")?.addEventListener("click", async () => {
    try {
      const { blob, name } = buildGifBlob();
      await saveBlobToFolder(name, blob);
    } catch (err) {
      toast(`GIF書き出しに失敗しました: ${err.message}`, "error");
      console.error(err);
    }
  });

  // §38: 「保存後にフォルダを自動で開く」トグル（既定ON・localStorage）
  const autoOpenChk = document.getElementById("autoOpenFolderChk");
  if (autoOpenChk) {
    autoOpenChk.checked = autoOpenFolderEnabled();
    autoOpenChk.addEventListener("change", () => setAutoOpenFolderEnabled(autoOpenChk.checked));
  }

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

  document.getElementById("exportPngBtn").addEventListener("click", async () => {
    const blob = await buildSpritesheetBlob();
    if (!blob) { toast("PNGの生成に失敗しました", "error"); return; }
    downloadBlob(blob, "ai-meglio-spritesheet.png");
    toast("スプライトシートPNGを書き出しました");
  });

  document.getElementById("exportGifBtn").addEventListener("click", () => {
    try {
      const { blob, name, tag } = buildGifBlob();
      downloadBlob(blob, name);
      toast(tag ? `タグ「${tag.name}」をGIF書き出ししました` : "GIFを書き出しました");
    } catch (err) {
      toast(`GIF書き出しに失敗しました: ${err.message}`, "error");
      console.error(err);
    }
  });
}

// ---------------------------------------------------------------------------
// グローバル Undo/Redo ショートカット（§49.5: モバイルのフローティング↩/↪も同じ処理を共有）
// ---------------------------------------------------------------------------
function doUndo() {
  if (!store.undo()) toast("これ以上元に戻せません");
}
function doRedo() {
  if (!store.redo()) toast("これ以上やり直せません");
}
// §49.5: #undoBtn/#redoBtn とモバイル用 #mobileUndoBtn/#mobileRedoBtn の活性状態を
// 履歴（undoStack/redoStack）に合わせて同期する。store.notify() のたびに呼ばれる。
function syncUndoRedoButtons() {
  const canUndo = store.undoStack.length > 0;
  const canRedo = store.redoStack.length > 0;
  for (const id of ["undoBtn", "mobileUndoBtn"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = !canUndo;
  }
  for (const id of ["redoBtn", "mobileRedoBtn"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = !canRedo;
  }
}

function initGlobalShortcuts() {
  document.getElementById("undoBtn")?.addEventListener("click", doUndo);
  document.getElementById("redoBtn")?.addEventListener("click", doRedo);
  document.getElementById("mobileUndoBtn")?.addEventListener("click", doUndo);
  document.getElementById("mobileRedoBtn")?.addEventListener("click", doRedo);
  window.addEventListener("keydown", (ev) => {
    const tag = document.activeElement?.tagName;
    const inText = tag === "TEXTAREA" || tag === "INPUT";
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod) return;
    const key = ev.key.toLowerCase();
    if (key === "z" && !ev.shiftKey) {
      if (inText) return;
      ev.preventDefault();
      doUndo();
    } else if ((key === "z" && ev.shiftKey) || key === "y") {
      if (inText) return;
      ev.preventDefault();
      doRedo();
    }
  });
  store.subscribe(syncUndoRedoButtons);
  syncUndoRedoButtons();
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
// §48.1: 静的モード検知（唯一の判定箇所）。GET /api/config が失敗（reject/非2xx/非JSON）したら
// store.state.staticMode = true。以降、各モジュールは store.state.staticMode を参照するだけで
// 独自に /api/config を叩き直す必要はない。
async function detectStaticMode() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    store.state.staticMode = false;
    store.state.serverConfig = cfg;
  } catch {
    store.state.staticMode = true;
    store.state.serverConfig = null;
  }
}

// §48.1: 静的モードのフッター（バージョン表示）用。public/version.json はビルド不要の
// 静的ファイルなので相対パスで読む（サブパス配信でも壊れない）。取得失敗時は "web" のみ。
async function staticFooterVersionText() {
  try {
    const res = await fetch("version.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.version) return `v${data.version} (web)`;
    throw new Error("no version");
  } catch {
    return "web";
  }
}

// バックエンド/バージョン表示（§15.1・§48.1）。ネットワークは一切叩かない
// （設定取得は detectStaticMode に一本化済み）。静的モードでは "vX.Y.Z (web)" にフォールバック。
async function renderBackendLabel() {
  const label = document.getElementById("backendLabel");
  if (store.state.staticMode) {
    label.textContent = await staticFooterVersionText();
    label.title = "静的モード（GitHub Pages 等）: サーバー機能（AI編集・サーバー保存等）は無効です";
    return;
  }
  const cfg = store.state.serverConfig;
  if (!cfg) { label.textContent = "バックエンド: 不明"; return; }
  const name = cfg.mock ? "MOCK" : cfg.backend === "cli" ? "Claude Code CLI" : cfg.backend === "codex" ? "Codex CLI" : "API";
  const ver = cfg.version ? ` · v${cfg.version}${cfg.commit ? ` (${cfg.commit})` : ""}` : "";
  label.textContent = `バックエンド: ${name}${ver}`;
  label.title = cfg.mock
    ? "MOCKモード（APIを呼びません）"
    : cfg.backend === "cli"
      ? `Claude Code CLI（モデル: ${cfg.cliModel}。画像は送信されません）`
      : cfg.backend === "codex"
        ? `Codex CLI（モデル: ${cfg.codexModel}。画像は送信されません）`
        : `Anthropic API（モデル: ${cfg.model}, effort: ${cfg.effort}）`;
  if (cfg.version) label.title += `\nバージョン: v${cfg.version}${cfg.commit ? ` / コミット: ${cfg.commit}` : ""}（git pull 後はサーバー再起動+ブラウザ再読込で更新）`;
}

// §48.2: 静的モードで隠す・無効化するUI（サーバー前提の機能）。
// [hidden] を使い、CSS側にも display:flex/inline-flex に勝つための保険ルールを用意する。
function applyStaticModeUI() {
  const stat = store.state.staticMode;
  document.body.classList.toggle("static-mode", stat);
  const hideIds = [
    "sendToGptBtn", "liveSyncRow", "liveSaveBtn", "liveSyncStatus", "headerSepGpt",
    "saveJsonFolderBtn", "exportPngFolderBtn", "exportGifFolderBtn", "autoOpenFolderRow",
    "exportDestRepoLabel",
  ];
  for (const id of hideIds) {
    const el = document.getElementById(id);
    if (el) el.hidden = stat || el.hidden; // 既に hidden なもの（liveSaveBtn等）はそのまま維持
  }
  const profileRow = document.querySelector("#profileBar .profile-row");
  if (profileRow) profileRow.hidden = stat;
  const aiPanel = document.getElementById("aiPanel");
  if (aiPanel) aiPanel.hidden = stat;
  // §48.2: AI編集パネルごと消える「ギャラリーを開く」の代わり（ヘッダー・画像読込の隣・静的モードのみ）
  const headerGalleryBtn = document.getElementById("headerGalleryBtn");
  if (headerGalleryBtn) headerGalleryBtn.hidden = !stat;
}

// §27 折りたたみ（<details data-collapse-key>）の開閉状態を localStorage に記憶
function initCollapsePersistence() {
  document.querySelectorAll("details[data-collapse-key]").forEach((det) => {
    const key = "aiMeglio.collapse." + det.dataset.collapseKey;
    try {
      const saved = localStorage.getItem(key);
      if (saved === "1") det.open = true;
      else if (saved === "0") det.open = false;
    } catch {}
    det.addEventListener("toggle", () => {
      try { localStorage.setItem(key, det.open ? "1" : "0"); } catch {}
    });
  });
}

async function main() {
  // §48.1: 静的モード判定を最初に確定させる。以降の init* は store.state.staticMode を
  // 同期的に参照できる（各モジュールが個別に /api/config を叩き直す必要がない）。
  await detectStaticMode();
  initHeader();
  initGlobalShortcuts();
  initCollapsePersistence();
  initEditor(store, toast);
  initTimeline(store, toast);
  initAi(store, toast);
  initRig(store, toast);
  initGameExport(store, toast);
  initGameView(store);
  initStyleRef(store, toast);
  initStudio(store, toast);
  initMotionStudio(store, toast); // §25 モーション候補スタジオ
  initCanvasResize(store, toast); // §28 キャンバスのリサイズ
  initLiveSync(store, toast); // §29 ライブプロジェクト同期
  initSendGpt(store, toast); // §36 「GPTへ送る」ワンクリック
  initBackdrop(); // §45 背景色の変更（透明部分の表示色・localStorage 復元）
  initMobile(); // §49 スマホレイアウト（サイドパネルのドロワー化）
  // §58.2: エディタ→クイック生成の受け渡し。ヘッダーの「⚡ クイック生成」クリック時に
  // 現在の素体（ベースフレーム or フレーム0）・パレット・元画像を渡す（空プロジェクトなら素のリンク遷移）
  const quickLink = document.querySelector('a[href="./autosprite.html"]');
  if (quickLink) {
    quickLink.addEventListener("click", (e) => {
      const p = store.state.project;
      // §58.6: ベースは「現在表示中のフレーム（編集後）」を最優先。baseFrame は取り込み時の
      // 原本でドット編集では更新されないため、これを先に使うと編集前の絵が渡ってしまう。
      const cur = p.frames[store.state.currentFrame]?.pixels || p.frames[0]?.pixels;
      const curHas = cur && Array.prototype.some.call(cur, (v) => v !== 0);
      const src = curHas ? cur : (p.baseFrame || p.frames[0]?.pixels);
      if (!src || !Array.prototype.some.call(src, (v) => v !== 0)) return;
      const payload = {
        width: p.width,
        height: p.height,
        palette: p.palette.slice(),
        basePixels: Array.from(src),
        sourceImage: typeof p.sourceImage === "string" ? p.sourceImage : null,
        // §58.3: 編集済みフレームも往復させる（タグ名がムーブ名と一致するものをウィザード側で復元）
        frames: p.frames.map((f) => Array.from(f.pixels)),
        tags: (p.tags || []).map((t) => ({ name: t.name, start: t.start, end: t.end })),
      };
      try {
        localStorage.setItem("aiMeglioHandoffToQuick", JSON.stringify(payload));
      } catch {
        // 容量超過時はフレームを落としてベースだけでも渡す
        delete payload.frames;
        delete payload.tags;
        try { localStorage.setItem("aiMeglioHandoffToQuick", JSON.stringify(payload)); } catch { return; }
      }
      e.preventDefault();
      window.open("./autosprite.html#editor-handoff", "_blank");
    });
  }

  // §58: クイック生成からのワンクリック受け渡し（autosprite.js が localStorage に置いた
  // プロジェクトを読み込む）。自動保存の復元バナーより優先させるため initAutosave の前に処理。
  if (location.hash === "#quickgen-handoff") {
    try {
      const raw = localStorage.getItem("aiMeglioHandoff");
      if (raw) {
        store.resetProject(projectFromPlain(JSON.parse(raw)));
        localStorage.removeItem("aiMeglioHandoff");
        toast("クイック生成の結果を読み込みました（ムーブはタグとして入っています）");
      }
    } catch (err) {
      toast(`クイック生成の結果の読込に失敗しました: ${err.message}`, "error");
    }
    history.replaceState(null, "", location.pathname + location.search);
  }
  initAutosave(store, toast); // §50.1 自動保存＆復元（IndexedDB）
  initSwUpdate(); // §50.7 SW更新チェック（新バージョン案内バナー）
  initHelp();
  applyStaticModeUI(); // §48.2: サーバー前提UIの非表示・ギャラリーを開くの復活
  renderBackendLabel();
  store.notify();
  // §58.4: クイック生成タブへのライブ同期。編集（notify）のたびに debounce して
  // 全フレーム＋タグを BroadcastChannel で配信（ウィザード側はタグ名=ムーブ名の範囲を反映）。
  if ("BroadcastChannel" in window) {
    const liveBc = new BroadcastChannel("aimeglio-live");
    let liveTimer = null;
    store.subscribe(() => {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        const p = store.state.project;
        try {
          liveBc.postMessage({
            type: "quickgen-frames",
            width: p.width,
            height: p.height,
            palette: p.palette.slice(),
            frames: p.frames.map((f) => Uint8Array.from(f.pixels)),
            tags: (p.tags || []).map((t) => ({ name: t.name, start: t.start, end: t.end })),
          });
        } catch {}
      }, 800);
    });
  }

  // デバッグ/E2Eテスト用フック（UIには影響しない）
  window.aiMeglio = { store, openStudio, studioView: getStudioView };
}

// §61: スマホ長押し対策 — キャンバス/画像の長押しメニューとドラッグ開始を抑止
document.addEventListener("contextmenu", (e) => {
  if (e.target instanceof HTMLCanvasElement) e.preventDefault();
});
document.addEventListener("dragstart", (e) => {
  if (e.target instanceof HTMLCanvasElement || e.target instanceof HTMLImageElement) e.preventDefault();
});

document.addEventListener("DOMContentLoaded", main);
