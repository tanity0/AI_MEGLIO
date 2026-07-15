// autosprite.js — §52 クイック生成ウィザード（AutoSprite風・ワンショット・ムーブセット生成）
// 1枚のキャラ画像 → ドット絵変換 → ムーブセット選択 → mode:"motionframe" で全フレーム一括生成
// → プレビュー → スプライトシートPNG + アトラス（汎用JSON / Phaser 3 / Godot 4）書き出し。
// app.js（本体エントリ）には依存しない自己完結モジュール。グリッド文字規則の小ヘルパは
// server.js / app.js と同一の規則（透明= '.'、1-9、a-v。33色以上は2文字hex）を複製している。
import { streamEdit } from "./api.js";
import { removeBackground, convertImage, detectComponents } from "./convert.js";
import { encodeGif } from "./gif.js";

// ---------------------------------------------------------------------------
// グリッド文字ヘルパ（server.js と同一規則・app.js から複製）
// ---------------------------------------------------------------------------
function isWidePalette(paletteLen) { return paletteLen > 32; }
function cellChars(paletteLen) { return isWidePalette(paletteLen) ? 2 : 1; }
function charForIndex(i) {
  if (i === 0) return ".";
  if (i >= 1 && i <= 9) return String(i);
  if (i >= 10 && i <= 31) return String.fromCharCode(97 + (i - 10));
  return null;
}
function tokenForIndex(i, wide) {
  if (wide) return i === 0 ? ".." : i.toString(16).padStart(2, "0");
  return charForIndex(i) ?? ".";
}
function indexForToken(tok, wide) {
  if (wide) {
    if (tok === "..") return 0;
    if (tok === "??") return -1;
    if (/^[0-9a-f]{2}$/.test(tok)) return parseInt(tok, 16);
    return -2;
  }
  if (tok === ".") return 0;
  if (tok === "?") return -1;
  if (tok >= "0" && tok <= "9") return tok.charCodeAt(0) - 48;
  if (tok >= "a" && tok <= "v") return tok.charCodeAt(0) - 97 + 10;
  return -2;
}
function splitTokens(row, cw) {
  if (cw === 1) return row.split("");
  const out = [];
  for (let i = 0; i < row.length; i += 2) out.push(row.slice(i, i + 2));
  return out;
}
function pixelsToGridString(pixels, width, height, paletteLen) {
  const wide = isWidePalette(paletteLen);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) row += tokenForIndex(pixels[y * width + x], wide);
    rows.push(row);
  }
  return rows.join("\n");
}
function pixelsFromRows(rows, width, height, paletteLen) {
  const cw = cellChars(paletteLen);
  const wide = cw === 2;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < Math.min(rows.length, height); y++) {
    const tokens = splitTokens(rows[y], cw) || [];
    for (let x = 0; x < Math.min(tokens.length, width); x++) {
      const idx = indexForToken(tokens[x], wide);
      pixels[y * width + x] = idx >= 0 && idx < paletteLen ? idx : 0;
    }
  }
  return pixels;
}
function hexToRgba(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16)];
}
function drawPixels(ctx, pixels, width, height, palette, cellSize, dx = 0, dy = 0) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = pixels[y * width + x];
      const hex = palette[idx];
      if (!hex) continue;
      const [r, g, b, a] = hexToRgba(hex);
      if (a === 0) continue;
      ctx.fillStyle = a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a / 255})`;
      ctx.fillRect(dx + x * cellSize, dy + y * cellSize, cellSize, cellSize);
    }
  }
}
function pixelsToPngDataUrl(pixels, width, height, palette, cellSize) {
  const canvas = document.createElement("canvas");
  canvas.width = width * cellSize;
  canvas.height = height * cellSize;
  drawPixels(canvas.getContext("2d"), pixels, width, height, palette, cellSize);
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
const MOVES = [
  { key: "idle",   preset: "idle",   label: "待機",     icon: "🧍", frames: 4, on: true },
  { key: "walk",   preset: "walk",   label: "歩き",     icon: "🚶", frames: 4, on: true },
  { key: "run",    preset: "run",    label: "走り",     icon: "🏃", frames: 6, on: false },
  { key: "jump",   preset: "jump",   label: "ジャンプ", icon: "🦘", frames: 6, on: false },
  { key: "attack", preset: "attack", label: "攻撃",     icon: "⚔️", frames: 4, on: false },
  { key: "custom", preset: "custom", label: "カスタム", icon: "✨", frames: 4, on: false, customText: "" },
];
const FRAME_CHOICES = [2, 3, 4, 5, 6, 8];
const CONCURRENCY = 2; // §52.3: CLIバックエンド配慮（§15 と同じ理由）

const state = {
  base: null,          // { width, height, pixels: Uint8Array, palette: [hex...] }
  results: new Map(),  // moveKey -> [{ status, pixels, error }]
  running: false,
  abortController: null,
  done: 0,
  total: 0,
  startedAt: 0,
  serverOk: false,
  engine: "text",      // §53: "image"（Gemini）| "text"（motionframe フォールバック）
  referencePng: null,  // §53: Gemini に渡す参照画像（元画像を白背景合成・最大768px）
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// サーバー確認（§48: 静的モードでは生成不可）
// ---------------------------------------------------------------------------
async function detectServer() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    state.serverOk = true;
    // §53/§54: 画像エンジン優先。?engine=text で従来のテキストエンジンを強制（検証用）
    const forced = new URLSearchParams(location.search).get("engine");
    state.engine = forced === "text" ? "text" : cfg.spriteEngine ? "image" : "text";
    const textBackend = cfg.backend === "cli" ? "Claude Code CLI" : cfg.backend === "codex" ? "Codex CLI" : "API";
    const engineLabel =
      cfg.spriteEngine === "mock" ? "MOCK"
      : state.engine === "image"
        ? (cfg.spriteEngine === "codex" ? "Codex CLI画像生成（$imagegen / gpt-image-2）" : `Gemini画像生成（${cfg.geminiModel}）`)
        : `テキスト（${textBackend}）`;
    $("footerInfo").textContent = `AI Meglio — クイック生成ウィザード（§52〜§54）｜生成エンジン: ${engineLabel}`;
    if (cfg.spriteEngine !== "mock" && state.engine === "text") {
      const b = $("serverBanner");
      b.style.display = "block";
      b.textContent = "テキストAIで生成します（品質は低めです）。Codexバックエンド（start-gpt.bat・APIキー不要）か、Gemini APIキー（https://aistudio.google.com/apikey で無料取得）を設定して起動すると、画像生成AIで大幅に品質が上がります。";
    }
  } catch {
    state.serverOk = false;
    const b = $("serverBanner");
    b.style.display = "block";
    b.textContent = "生成APIに接続できません（Web静的版では生成は使えません）。ローカルで `npm start` したサーバー版で開いてください。";
    $("generateBtn").disabled = true;
  }
}

// ---------------------------------------------------------------------------
// ステップ1: 画像取り込み → ドット絵変換
// ---------------------------------------------------------------------------
let sourceImageData = null; // { data, w, h } 変換パラメータ変更時の再変換用

function fileToImageData(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1024; // 巨大画像は縮小してから処理（変換品質には十分）
      const sc = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc));
      const h = Math.max(1, Math.round(img.naturalHeight * sc));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ data: ctx.getImageData(0, 0, w, h).data, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

function reconvert() {
  if (!sourceImageData) return;
  const { data, w, h } = sourceImageData;
  const targetH = parseInt($("sizeSel").value, 10);
  const totalColors = parseInt($("colorSel").value, 10);
  try {
    const src = $("bgRemove").checked ? removeBackground(data, w, h) : data;
    const conv = convertImage(src, w, h, { targetH, colors: totalColors - 1 });
    if (conv.width < 8 || conv.height < 8) throw new Error("変換結果が小さすぎます（8px未満）。大きい画像を使ってください");
    state.base = { width: conv.width, height: conv.height, pixels: conv.pixels, palette: conv.palette };
    renderBasePreview();
    // 変換し直したら既存の生成結果は破棄（パレット・サイズが変わるため）
    state.results.clear();
    $("results").innerHTML = "";
    setLocked("step2", false);
    setLocked("step3", false);
    setLocked("step4", true);
  } catch (err) {
    state.base = null;
    $("basePreviewWrap").style.display = "flex";
    $("basePreview").width = 0; $("basePreview").height = 0;
    $("baseInfo").textContent = `変換エラー: ${err.message}`;
    setLocked("step2", true);
    setLocked("step3", true);
    setLocked("step4", true);
  }
}

function renderBasePreview() {
  const b = state.base;
  const sc = Math.max(1, Math.floor(160 / Math.max(b.width, b.height)));
  const canvas = $("basePreview");
  canvas.width = b.width * sc;
  canvas.height = b.height * sc;
  drawPixels(canvas.getContext("2d"), b.pixels, b.width, b.height, b.palette, sc);
  $("basePreviewWrap").style.display = "flex";
  $("baseInfo").textContent = `${b.width}×${b.height}px・${b.palette.length - 1}色`;
}

// §53: Gemini に渡す参照画像（元画像を白背景に合成・最大768px・PNG dataURL）
function buildReferencePng() {
  const { data, w, h } = sourceImageData;
  const sc = Math.min(1, 768 / Math.max(w, h));
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  tmp.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * sc));
  out.height = Math.max(1, Math.round(h * sc));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(tmp, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

async function acceptFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  try {
    sourceImageData = await fileToImageData(file);
    state.referencePng = buildReferencePng();
    reconvert();
  } catch (err) {
    alert(err.message);
  }
}

function setLocked(id, locked) {
  $(id).classList.toggle("locked", locked);
}

// ---------------------------------------------------------------------------
// ステップ2: ムーブセットカード
// ---------------------------------------------------------------------------
function renderMoveCards() {
  const wrap = $("moveCards");
  wrap.innerHTML = "";
  for (const m of MOVES) {
    const card = document.createElement("div");
    card.className = "moveCard" + (m.on ? " on" : "");
    const top = document.createElement("div");
    top.className = "top";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = m.on;
    cb.addEventListener("change", () => { m.on = cb.checked; card.classList.toggle("on", m.on); });
    const name = document.createElement("span");
    name.textContent = `${m.icon} ${m.label}`;
    top.append(cb, name);
    top.addEventListener("click", (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });
    const fr = document.createElement("div");
    fr.className = "frames";
    fr.append("フレーム数 ");
    const sel = document.createElement("select");
    for (const n of FRAME_CHOICES) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = String(n);
      if (n === m.frames) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => { m.frames = parseInt(sel.value, 10); });
    fr.append(sel);
    card.append(top, fr);
    if (m.preset === "custom") {
      const txt = document.createElement("input");
      txt.type = "text";
      txt.maxLength = 300;
      txt.placeholder = "例: しゃがんで盾を構える";
      txt.addEventListener("input", () => { m.customText = txt.value; });
      card.append(txt);
    }
    wrap.append(card);
  }
}

function activeMoves() {
  return MOVES.filter((m) => m.on && (m.preset !== "custom" || m.customText.trim()));
}

// ---------------------------------------------------------------------------
// ステップ3: 一括生成（並列2）
// ---------------------------------------------------------------------------
function baseGridString() {
  const b = state.base;
  return pixelsToGridString(b.pixels, b.width, b.height, b.palette.length);
}

function buildJobBody(move, index, total, regen) {
  const b = state.base;
  const grid = baseGridString();
  const mf = { preset: move.preset, index, total, variant: 0 };
  if (move.preset === "custom") mf.customText = move.customText.trim().slice(0, 500);
  if (regen) mf.instruction = "前回と違うポーズ解釈で描き直してください";
  const desc = $("charDesc").value.trim();
  let instruction = `「${move.label}」モーションの第${index + 1}/${total}フレームを生成`;
  if (desc) instruction += `。キャラクター: ${desc}`;
  return {
    project: {
      width: b.width,
      height: b.height,
      fps: parseInt($("fpsSel").value, 10),
      palette: b.palette,
      framesGrid: [grid],
    },
    scope: "all",
    mode: "motionframe",
    baseFrameGrid: grid,
    motionframe: mf,
    instruction: instruction.slice(0, 2000),
    images: [{ frame: 0, dataUrl: pixelsToPngDataUrl(b.pixels, b.width, b.height, b.palette, b.width > 64 ? 4 : 8) }],
  };
}

async function runJob(move, index, regen = false) {
  const slots = state.results.get(move.key);
  const slot = slots[index];
  slot.status = "running";
  slot.error = null;
  renderThumb(move, index);
  try {
    const body = buildJobBody(move, index, slots.length, regen);
    const evt = await streamEdit(body, { signal: state.abortController?.signal });
    const nf = evt.patch?.newFrames?.[0];
    if (!nf || !Array.isArray(nf.rows)) throw new Error("フレームが返されませんでした");
    slot.pixels = pixelsFromRows(nf.rows, state.base.width, state.base.height, state.base.palette.length);
    slot.status = "ok";
  } catch (err) {
    slot.status = "error";
    slot.error = err.name === "AbortError" ? "中断しました" : err.message;
  }
  renderThumb(move, index);
  updateExportState();
}

// ---------------------------------------------------------------------------
// §53: 画像生成エンジン（Gemini）— ムーブ単位のストリップ生成 → 分割 → ドット絵化
// ---------------------------------------------------------------------------
function dataUrlToImageData(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      resolve({ data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height });
    };
    img.onerror = () => reject(new Error("生成画像を読み込めませんでした"));
    img.src = dataUrl;
  });
}

// ベース素体の bbox（足元基準・中央合わせとセル高の基準。§53.3）
function baseCharMetrics() {
  const b = state.base;
  let x0 = b.width, y0 = b.height, x1 = -1, y1 = -1;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (b.pixels[y * b.width + x] !== 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { charH: b.height, baselineY: b.height - 1, centerX: b.width / 2 };
  return { charH: y1 - y0 + 1, baselineY: y1, centerX: (x0 + x1 + 1) / 2 };
}

// 変換結果（独自パレット）をベースキャンバスへ配置し、ベースパレットへ最近色スナップ
function composeToBase(conv, metrics) {
  const b = state.base;
  const baseRgb = b.palette.map(hexToRgba);
  const snap = conv.palette.map((hex, i) => {
    if (i === 0) return 0;
    const [r, g, bl] = hexToRgba(hex);
    let best = 1, bd = Infinity;
    for (let j = 1; j < baseRgb.length; j++) {
      if (baseRgb[j][3] === 0) continue;
      const d = (baseRgb[j][0] - r) ** 2 + (baseRgb[j][1] - g) ** 2 + (baseRgb[j][2] - bl) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  });
  const out = new Uint8Array(b.width * b.height);
  const offX = Math.round(metrics.centerX - conv.width / 2);
  const offY = metrics.baselineY + 1 - conv.height;
  for (let y = 0; y < conv.height; y++) {
    for (let x = 0; x < conv.width; x++) {
      const idx = conv.pixels[y * conv.width + x];
      if (idx === 0) continue;
      const tx = offX + x, ty = offY + y;
      if (tx < 0 || ty < 0 || tx >= b.width || ty >= b.height) continue;
      out[ty * b.width + tx] = snap[idx];
    }
  }
  return out;
}

function cropRegion(data, w, box) {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const out = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    const src = ((box.y0 + y) * w + box.x0) * 4;
    out.set(data.subarray(src, src + bw * 4), y * bw * 4);
  }
  return { data: out, w: bw, h: bh };
}

// 生成ストリップ → N個のベース互換フレーム（§53.3: N一致 / 1体複製 / N等分のフォールバック）
function stripToFrames(strip, n) {
  const bg = removeBackground(strip.data, strip.w, strip.h);
  let boxes = detectComponents(bg, strip.w, strip.h);
  if (!boxes.length) throw new Error("生成画像からキャラクターを検出できませんでした");
  if (boxes.length !== n) {
    if (boxes.length === 1) {
      boxes = Array.from({ length: n }, () => boxes[0]); // 1体 → 全コマ複製（MOCK・縮退）
    } else {
      // 全体bboxのN等分割にフォールバック
      const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1));
      const y0 = Math.min(...boxes.map((b) => b.y0)), y1 = Math.max(...boxes.map((b) => b.y1));
      const cw = (x1 - x0 + 1) / n;
      boxes = Array.from({ length: n }, (_, i) => ({
        x0: Math.round(x0 + i * cw), x1: Math.round(x0 + (i + 1) * cw) - 1, y0, y1,
      }));
    }
  }
  const metrics = baseCharMetrics();
  const colors = state.base.palette.length - 1;
  return boxes.map((box) => {
    const sub = cropRegion(bg, strip.w, box);
    const conv = convertImage(sub.data, sub.w, sub.h, { targetH: metrics.charH, colors });
    return composeToBase(conv, metrics);
  });
}

async function fetchSpriteFrame(payload) {
  const res = await fetch("/api/spriteframe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: state.abortController?.signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `サーバーエラー (HTTP ${res.status})`);
  if (!json.image) throw new Error("画像が返されませんでした");
  return json.image;
}

function spritePayloadBase(move) {
  const payload = {
    preset: move.preset,
    desc: $("charDesc").value.trim().slice(0, 500),
    reference: state.referencePng,
  };
  if (move.preset === "custom") payload.customText = move.customText.trim().slice(0, 500);
  return payload;
}

// 1ムーブぶんを一括生成（ストリップ→分割）。失敗時は全コマ error
async function runMoveStrip(move) {
  const slots = state.results.get(move.key);
  slots.forEach((s, i) => { s.status = "running"; s.error = null; renderThumb(move, i); });
  try {
    const image = await fetchSpriteFrame({ ...spritePayloadBase(move), kind: "strip", count: slots.length });
    const frames = stripToFrames(await dataUrlToImageData(image), slots.length);
    frames.forEach((pixels, i) => { slots[i].pixels = pixels; slots[i].status = "ok"; });
  } catch (err) {
    const msg = err.name === "AbortError" ? "中断しました" : err.message;
    slots.forEach((s) => { if (s.status === "running") { s.status = "error"; s.error = msg; } });
  }
  slots.forEach((_, i) => renderThumb(move, i));
  updateExportState();
}

// ↻ 1コマ再生成（画像エンジン: kind=single）
async function regenSingleImage(move, index) {
  const slots = state.results.get(move.key);
  const slot = slots[index];
  slot.status = "running";
  slot.error = null;
  renderThumb(move, index);
  try {
    const image = await fetchSpriteFrame({ ...spritePayloadBase(move), kind: "single", count: slots.length, index });
    const strip = await dataUrlToImageData(image);
    const bg = removeBackground(strip.data, strip.w, strip.h);
    const boxes = detectComponents(bg, strip.w, strip.h);
    if (!boxes.length) throw new Error("生成画像からキャラクターを検出できませんでした");
    const box = boxes.reduce((a, b) => ((b.area || 0) > (a.area || 0) ? b : a)); // 最大成分
    const metrics = baseCharMetrics();
    const sub = cropRegion(bg, strip.w, box);
    const conv = convertImage(sub.data, sub.w, sub.h, { targetH: metrics.charH, colors: state.base.palette.length - 1 });
    slot.pixels = composeToBase(conv, metrics);
    slot.status = "ok";
  } catch (err) {
    slot.status = "error";
    slot.error = err.name === "AbortError" ? "中断しました" : err.message;
  }
  renderThumb(move, index);
  updateExportState();
}

async function generateAll() {
  const moves = activeMoves();
  if (!moves.length) { alert("ムーブを1つ以上選択してください（カスタムはテキスト必須）"); return; }
  if (!state.base) return;
  state.results.clear();
  for (const m of moves) {
    state.results.set(m.key, Array.from({ length: m.frames }, () => ({ status: "pending", pixels: null, error: null })));
  }
  // 画像エンジンはムーブ単位・テキストエンジンはフレーム単位のジョブ列（進捗の分母も対応）
  const jobs = [];
  if (state.engine === "image") {
    for (const m of moves) jobs.push({ run: () => runMoveStrip(m), move: m });
  } else {
    for (const m of moves) for (let i = 0; i < m.frames; i++) jobs.push({ run: () => runJob(m, i), move: m, index: i });
  }
  renderResults(moves);
  state.running = true;
  state.abortController = new AbortController();
  state.done = 0;
  state.total = jobs.length;
  state.startedAt = Date.now();
  $("generateBtn").disabled = true;
  $("abortBtn").disabled = false;
  $("progressWrap").style.display = "flex";
  const tick = setInterval(renderProgress, 1000);
  renderProgress();

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (state.abortController.signal.aborted) {
        // 未着手ジョブは中断扱いにして抜ける
        const slots = state.results.get(j.move.key);
        const target = j.index !== undefined ? [slots[j.index]] : slots;
        target.forEach((slot, k) => {
          if (slot.status === "pending") {
            slot.status = "error";
            slot.error = "中断しました";
            renderThumb(j.move, j.index !== undefined ? j.index : k);
          }
        });
        continue;
      }
      await j.run();
      state.done++;
      renderProgress();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  clearInterval(tick);
  state.running = false;
  state.abortController = null;
  $("generateBtn").disabled = false;
  $("abortBtn").disabled = true;
  renderProgress(true);
}

function renderProgress(finished = false) {
  const sec = Math.round((Date.now() - state.startedAt) / 1000);
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  $("progressBar").firstElementChild.style.width = `${pct}%`;
  const failed = [...state.results.values()].flat().filter((s) => s.status === "error").length;
  const unit = state.engine === "image" ? "ムーブ" : "フレーム"; // §53: 画像エンジンはムーブ単位
  $("progressText").textContent = finished
    ? `完了: ${state.done}/${state.total}${unit}${failed ? `（失敗 ${failed}コマ — サムネイルの ↻ で再生成できます）` : ""}・所要 ${sec}秒`
    : `生成中… ${state.done}/${state.total}${unit}・経過 ${sec}秒`;
}

// ---------------------------------------------------------------------------
// 結果表示（ムーブごと: プレイヤー + フレームサムネイル）
// ---------------------------------------------------------------------------
const players = new Map(); // moveKey -> { canvas, idx, lastT, playing }

function thumbScale() {
  const b = state.base;
  return Math.max(1, Math.floor(64 / Math.max(b.width, b.height)));
}
function playerScale() {
  const b = state.base;
  return Math.max(1, Math.floor(128 / Math.max(b.width, b.height)));
}

function renderResults(moves) {
  const wrap = $("results");
  wrap.innerHTML = "";
  players.clear();
  const b = state.base;
  for (const m of moves) {
    const block = document.createElement("div");
    block.className = "moveResult";
    block.dataset.move = m.key;
    const h3 = document.createElement("h3");
    h3.textContent = `${m.icon} ${m.label}`;
    const gifBtn = document.createElement("button");
    gifBtn.className = "gifBtn";
    gifBtn.textContent = "GIF保存";
    gifBtn.addEventListener("click", () => downloadMoveGif(m));
    h3.append(gifBtn);

    const player = document.createElement("div");
    player.className = "player";
    const pc = document.createElement("canvas");
    const psc = playerScale();
    pc.width = b.width * psc;
    pc.height = b.height * psc;
    pc.className = "checker";
    const ctl = document.createElement("div");
    ctl.className = "playerCtl";
    const playBtn = document.createElement("button");
    playBtn.textContent = "⏸";
    playBtn.addEventListener("click", () => {
      const p = players.get(m.key);
      p.playing = !p.playing;
      playBtn.textContent = p.playing ? "⏸" : "▶";
    });
    ctl.append(playBtn, "ループ再生");
    player.append(pc, ctl);
    players.set(m.key, { canvas: pc, idx: 0, lastT: 0, playing: true });

    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    const slots = state.results.get(m.key);
    const tsc = thumbScale();
    for (let i = 0; i < slots.length; i++) {
      const t = document.createElement("div");
      t.className = "thumb pending";
      t.dataset.index = String(i);
      const c = document.createElement("canvas");
      c.width = b.width * tsc;
      c.height = b.height * tsc;
      const st = document.createElement("div");
      st.className = "st";
      const lbl = document.createElement("span");
      lbl.textContent = `${i + 1}`;
      const rb = document.createElement("button");
      rb.textContent = "↻";
      rb.title = "このフレームだけ再生成";
      rb.addEventListener("click", () => {
        if (state.running) return;
        state.abortController = null;
        if (state.engine === "image") regenSingleImage(m, i); // §53
        else runJob(m, i, true);
      });
      st.append(lbl, rb);
      t.append(c, st);
      thumbs.append(t);
    }
    block.append(h3, player, thumbs);
    wrap.append(block);
  }
}

function renderThumb(move, index) {
  const block = $("results").querySelector(`.moveResult[data-move="${move.key}"]`);
  if (!block) return;
  const t = block.querySelectorAll(".thumb")[index];
  if (!t) return;
  const slot = state.results.get(move.key)[index];
  t.className = `thumb ${slot.status}`;
  const c = t.querySelector("canvas");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (slot.pixels) drawPixels(ctx, slot.pixels, state.base.width, state.base.height, state.base.palette, thumbScale());
  t.title = slot.error || "";
  const lbl = t.querySelector(".st span");
  lbl.textContent = slot.status === "running" ? "…" : slot.status === "error" ? "✕" : `${index + 1}`;
}

// プレイヤー描画ループ（全ムーブ共通の rAF 1本）
function animLoop(t) {
  const fps = parseInt($("fpsSel").value, 10) || 8;
  const frameMs = 1000 / fps;
  for (const [key, p] of players) {
    const slots = state.results.get(key);
    if (!slots) continue;
    const okFrames = slots.filter((s) => s.status === "ok");
    if (!okFrames.length) continue;
    if (p.playing && t - p.lastT >= frameMs) {
      p.idx = (p.idx + 1) % okFrames.length;
      p.lastT = t;
    }
    const frame = okFrames[Math.min(p.idx, okFrames.length - 1)];
    const ctx = p.canvas.getContext("2d");
    ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    drawPixels(ctx, frame.pixels, state.base.width, state.base.height, state.base.palette, playerScale());
  }
  requestAnimationFrame(animLoop);
}

// ---------------------------------------------------------------------------
// ステップ4: 書き出し
// ---------------------------------------------------------------------------
function safeName(s) {
  return (s.trim() || "character").replace(/[\\/:*?"<>|\s\x00-\x1f]/g, "_");
}

// 生成済み（ok）フレームだけを行=ムーブ・列=フレームで敷き詰める
function collectSheet() {
  const rows = [];
  for (const m of MOVES) {
    const slots = state.results.get(m.key);
    if (!slots) continue;
    const frames = slots.filter((s) => s.status === "ok").map((s) => s.pixels);
    if (frames.length) rows.push({ move: m, frames });
  }
  return rows;
}

function buildSheetCanvas(rows, scale) {
  const b = state.base;
  const cols = Math.max(...rows.map((r) => r.frames.length));
  const canvas = document.createElement("canvas");
  canvas.width = b.width * scale * cols;
  canvas.height = b.height * scale * rows.length;
  const ctx = canvas.getContext("2d");
  const entries = [];
  rows.forEach((r, ri) => {
    r.frames.forEach((pixels, ci) => {
      drawPixels(ctx, pixels, b.width, b.height, b.palette, scale, ci * b.width * scale, ri * b.height * scale);
      entries.push({
        name: `${r.move.key}_${ci}`,
        move: r.move.key,
        index: ci,
        x: ci * b.width * scale,
        y: ri * b.height * scale,
        w: b.width * scale,
        h: b.height * scale,
      });
    });
  });
  return { canvas, entries, cols };
}

function buildGenericAtlas(entries, canvas, scale, fps, charName) {
  const b = state.base;
  const animations = {};
  for (const e of entries) {
    (animations[e.move] ||= { frames: [], fps, loop: true }).frames.push(e.name);
  }
  return JSON.stringify({
    meta: {
      app: "AI Meglio クイック生成",
      image: `${charName}_sheet.png`,
      size: { w: canvas.width, h: canvas.height },
      frameSize: { w: b.width * scale, h: b.height * scale },
      scale,
      fps,
    },
    frames: entries.map((e) => ({ name: e.name, x: e.x, y: e.y, w: e.w, h: e.h, move: e.move, index: e.index })),
    animations,
  }, null, 2);
}

function buildPhaserAtlas(entries, canvas, scale, charName) {
  const frames = {};
  for (const e of entries) {
    frames[e.name] = {
      frame: { x: e.x, y: e.y, w: e.w, h: e.h },
      rotated: false,
      trimmed: false,
      sourceSize: { w: e.w, h: e.h },
      spriteSourceSize: { x: 0, y: 0, w: e.w, h: e.h },
    };
  }
  return JSON.stringify({
    frames,
    meta: { app: "AI Meglio クイック生成", image: `${charName}_sheet.png`, size: { w: canvas.width, h: canvas.height }, scale: String(scale) },
  }, null, 2);
}

function buildGodotTres(entries, fps, charName) {
  // Godot 4 SpriteFrames リソース（AtlasTexture でシートの矩形を参照）
  const lines = [];
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${entries.length + 2} format=3]`);
  lines.push("");
  lines.push(`[ext_resource type="Texture2D" path="res://${charName}_sheet.png" id="1"]`);
  lines.push("");
  entries.forEach((e, i) => {
    lines.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${i + 1}"]`);
    lines.push(`atlas = ExtResource("1")`);
    lines.push(`region = Rect2(${e.x}, ${e.y}, ${e.w}, ${e.h})`);
    lines.push("");
  });
  const byMove = new Map();
  entries.forEach((e, i) => {
    if (!byMove.has(e.move)) byMove.set(e.move, []);
    byMove.get(e.move).push(i + 1);
  });
  lines.push("[resource]");
  lines.push("animations = [{");
  const anims = [...byMove.entries()].map(([move, ids]) => {
    const fr = ids.map((id) => `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${id}")\n}`).join(", ");
    return `"frames": [${fr}],\n"loop": true,\n"name": &"${move}",\n"speed": ${fps}.0`;
  });
  lines.push(anims.join("\n}, {\n"));
  lines.push("}]");
  return lines.join("\n");
}

// 本体エディタで開けるプロジェクトJSON（app.js projectFromPlain 互換・フレームは旧形式=配列）
function buildProjectJson(rows, fps) {
  const b = state.base;
  const frames = [];
  const tags = [];
  for (const r of rows) {
    const start = frames.length;
    for (const pixels of r.frames) frames.push(Array.from(pixels));
    tags.push({ name: r.move.key, start, end: frames.length - 1, fps, loop: true });
  }
  return JSON.stringify({
    width: b.width,
    height: b.height,
    fps,
    palette: b.palette.slice(),
    frames,
    baseFrame: Array.from(b.pixels),
    tags,
    playMode: "loop",
  });
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); // DOM外の <a> だと download 属性のファイル名が無視されることがある
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function downloadMoveGif(move) {
  const slots = state.results.get(move.key);
  const frames = (slots || []).filter((s) => s.status === "ok").map((s) => ({ pixels: s.pixels }));
  if (!frames.length) { alert("生成済みフレームがありません"); return; }
  const b = state.base;
  const fps = parseInt($("fpsSel").value, 10) || 8;
  const bytes = encodeGif({ width: b.width, height: b.height, fps, palette: b.palette, frames });
  downloadBlob(new Blob([bytes], { type: "image/gif" }), `${safeName($("charName").value)}_${move.key}.gif`);
}

function updateExportState() {
  const rows = collectSheet();
  const has = rows.length > 0;
  setLocked("step4", !has);
  if (has) renderSheetPreview();
}

function renderSheetPreview() {
  const rows = collectSheet();
  if (!rows.length) return;
  const { canvas } = buildSheetCanvas(rows, parseInt($("scaleSel").value, 10));
  const prev = $("sheetPreview");
  prev.width = canvas.width;
  prev.height = canvas.height;
  prev.getContext("2d").drawImage(canvas, 0, 0);
}

function exportSheet() {
  const rows = collectSheet();
  if (!rows.length) return;
  const { canvas } = buildSheetCanvas(rows, parseInt($("scaleSel").value, 10));
  canvas.toBlob((blob) => downloadBlob(blob, `${safeName($("charName").value)}_sheet.png`), "image/png");
}

function exportAtlas() {
  const rows = collectSheet();
  if (!rows.length) return;
  const scale = parseInt($("scaleSel").value, 10);
  const fps = parseInt($("fpsSel").value, 10) || 8;
  const charName = safeName($("charName").value);
  const { canvas, entries } = buildSheetCanvas(rows, scale);
  const format = $("formatSel").value;
  if (format === "phaser") {
    downloadBlob(new Blob([buildPhaserAtlas(entries, canvas, scale, charName)], { type: "application/json" }), `${charName}_atlas.json`);
  } else if (format === "godot") {
    downloadBlob(new Blob([buildGodotTres(entries, fps, charName)], { type: "text/plain" }), `${charName}_sprite_frames.tres`);
  } else {
    downloadBlob(new Blob([buildGenericAtlas(entries, canvas, scale, fps, charName)], { type: "application/json" }), `${charName}_atlas.json`);
  }
}

function exportProject() {
  const rows = collectSheet();
  if (!rows.length) return;
  const fps = parseInt($("fpsSel").value, 10) || 8;
  downloadBlob(new Blob([buildProjectJson(rows, fps)], { type: "application/json" }), `${safeName($("charName").value)}_project.json`);
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
function init() {
  renderMoveCards();
  detectServer();

  const dz = $("dropZone");
  dz.addEventListener("click", () => $("fileInput").click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") $("fileInput").click(); });
  $("fileInput").addEventListener("change", (e) => acceptFile(e.target.files[0]));
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    acceptFile(e.dataTransfer.files[0]);
  });
  document.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) acceptFile(item.getAsFile());
  });

  for (const id of ["sizeSel", "colorSel", "bgRemove"]) $(id).addEventListener("change", reconvert);
  $("generateBtn").addEventListener("click", generateAll);
  $("abortBtn").addEventListener("click", () => { state.abortController?.abort(); $("abortBtn").disabled = true; });
  $("scaleSel").addEventListener("change", renderSheetPreview);
  $("dlSheetBtn").addEventListener("click", exportSheet);
  $("dlAtlasBtn").addEventListener("click", exportAtlas);
  $("dlProjectBtn").addEventListener("click", exportProject);

  requestAnimationFrame(animLoop);
}

init();
