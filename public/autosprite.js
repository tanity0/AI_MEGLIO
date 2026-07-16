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
  engine: "text",      // §53: "image"（Gemini/Codex）| "text"（motionframe フォールバック）
  referencePng: null,  // §53: Gemini に渡す参照画像（元画像を白背景合成・最大768px）
  directKey: null,     // §55: 静的モード（Web版）のGeminiブラウザ直叩き用キー（端末内のみ）
  directModel: null,   // §55.4: 直叩きモデル（フォールバックで自動更新）
};
// §55.4: 直叩きの候補モデル（先頭=既定。404/権限エラー時は次を自動で試す）
const DIRECT_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
];
const DIRECT_KEY_STORAGE = "autosprite.geminiKey";
const DIRECT_MODEL_STORAGE = "autosprite.geminiModel";

const $ = (id) => document.getElementById(id);

// §55.8: バージョンは常時表示（ヘッダーとフッター。更新が届いているかの確認用）
let appVersion = "";
function setAppVersion(v) {
  if (!v) return;
  appVersion = v;
  $("verBadge").textContent = `v${v}`;
  renderFooter();
}
let footerBase = "AI Meglio — クイック生成ウィザード";
function setFooter(text) {
  footerBase = text;
  renderFooter();
}
function renderFooter() {
  $("footerInfo").textContent = `${footerBase}${appVersion ? `｜v${appVersion}` : ""}`;
}

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
    setAppVersion(cfg.version);
    setFooter(`AI Meglio — クイック生成ウィザード（§52〜§54）｜生成エンジン: ${engineLabel}`);
    if (cfg.spriteEngine !== "mock" && state.engine === "text") {
      const b = $("serverBanner");
      b.style.display = "block";
      b.textContent = "テキストAIで生成します（品質は低めです）。Codexバックエンド（start-gpt.bat・APIキー不要）か、Gemini APIキー（https://aistudio.google.com/apikey で無料取得）を設定して起動すると、画像生成AIで大幅に品質が上がります。";
    }
  } catch {
    // §55: 静的モード（Web版）。Gemini はブラウザから直接呼べるため、キー入力で生成を有効化する
    state.serverOk = false;
    setupDirectKeyUi();
  }
}

// §55: 静的モードのキー入力UI。キーは既定でメモリ内のみ（「この端末に保存」ONで localStorage）
function setupDirectKeyUi() {
  const b = $("serverBanner");
  b.style.display = "block";
  b.innerHTML = "";
  const note = document.createElement("div");
  note.textContent = "Web版です。Gemini APIキー（https://aistudio.google.com/apikey で無料取得）を入力すると、この端末だけで生成できます。キーはGoogleのAPI呼び出し以外には送信されません。";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px";
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "GEMINI_API_KEY";
  input.style.cssText = "flex:1;min-width:180px;background:#242836;color:#e6e8ef;border:1px solid #333849;border-radius:6px;padding:5px 8px";
  const btn = document.createElement("button");
  btn.textContent = "生成を有効にする";
  const remember = document.createElement("label");
  remember.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  remember.append(chk, "この端末に保存");
  // §55.4: モデル選択（404/権限エラー時は他候補を自動で試す）
  const modelSel = document.createElement("select");
  for (const m of DIRECT_MODELS) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    modelSel.append(o);
  }
  try { modelSel.value = localStorage.getItem(DIRECT_MODEL_STORAGE) || DIRECT_MODELS[0]; } catch {}
  if (!modelSel.value) modelSel.value = DIRECT_MODELS[0];
  modelSel.addEventListener("change", () => {
    state.directModel = modelSel.value;
    try { localStorage.setItem(DIRECT_MODEL_STORAGE, modelSel.value); } catch {}
  });
  const status = document.createElement("span");
  status.style.fontSize = "12px";
  row.append(input, btn, remember, modelSel, status);
  b.append(note, row);

  const apply = (key) => {
    state.directKey = key;
    state.directModel = modelSel.value;
    state.engine = "image";
    $("generateBtn").disabled = false;
    status.textContent = "✔ 有効";
    setFooter(`AI Meglio — クイック生成ウィザード（§52〜§55）｜生成エンジン: Gemini画像生成（ブラウザ直接・${state.directModel}）`);
  };
  btn.addEventListener("click", () => {
    const key = input.value.trim();
    if (!key) { status.textContent = "キーを入力してください"; return; }
    if (chk.checked) { try { localStorage.setItem(DIRECT_KEY_STORAGE, key); } catch {} }
    else { try { localStorage.removeItem(DIRECT_KEY_STORAGE); } catch {} }
    apply(key);
  });

  $("generateBtn").disabled = true;
  setFooter("AI Meglio — クイック生成ウィザード（§52〜§55）｜Web版（キー未設定・生成無効）");
  // §55.7/§55.8: 実行中バージョンを表示（更新が届いているかの確認用）
  fetch("./version.json", { cache: "no-store" }).then((r) => r.json()).then((v) => setAppVersion(v?.version)).catch(() => {});
  let saved = null;
  try { saved = localStorage.getItem(DIRECT_KEY_STORAGE); } catch {}
  if (saved) {
    input.value = saved;
    chk.checked = true;
    apply(saved);
  }
}

// §55: ブラウザ→Gemini 直叩き（サーバー §53.2 buildSpritePrompt/callGeminiImage と同一ロジックの複製）
const DIRECT_MOVE_PROMPTS = {
  walk: "a walking cycle (contact, down, passing, up positions; arms swinging opposite to legs; body lowest on contact frames)",
  run: "a running cycle (leaning forward, wide strides, big arm swings, including airborne frames where both feet leave the ground)",
  attack: "an attack animation (wind-up anticipation, then the hit pose at maximum reach, then follow-through)",
  idle: "an idle animation (subtle breathing motion, tiny up-and-down movement, silhouette mostly unchanged)",
  jump: "a jump animation (crouch, launch upward, stretched airborne pose at the top, landing with bent knees)",
};

function buildDirectPrompt(payload) {
  const { kind, preset, customText, count, index, desc } = payload;
  const moveDesc = preset === "custom" ? String(customText || "").trim() : DIRECT_MOVE_PROMPTS[preset];
  const lines = [];
  if (kind === "strip") {
    lines.push(`Create a pixel art sprite animation strip of the character in the reference image: exactly ${count} frames of ${moveDesc}.`);
    lines.push(`Arrange all ${count} frames in a single horizontal row, evenly spaced, with clear gaps between frames so the characters never touch each other.`);
  } else {
    lines.push(`Create a single pixel art animation frame of the character in the reference image: frame ${index + 1} of ${count} of ${moveDesc}.`);
    lines.push("Draw exactly one character, full body.");
  }
  lines.push("Keep the character's design, colors, proportions, outline style and pixel-art rendering exactly consistent with the reference image in every frame.");
  lines.push("Keep the same facing direction as the reference image.");
  lines.push("Plain solid white background. No grid lines, no frame borders, no text, no labels, no shadows on the ground.");
  if (desc) lines.push(`Character description: ${desc}`);
  return lines.join("\n");
}

// §55.4: よくある失敗を日本語の対処つきメッセージに変換
function friendlyGeminiError(err) {
  const raw = err.message || String(err);
  if (err.name === "TypeError" || /Failed to fetch|NetworkError/i.test(raw)) {
    return "Gemini APIに接続できませんでした（ネットワーク遮断/フィルタの可能性。Wi-Fiを変えるかモバイル回線で試してください）";
  }
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) return "APIキーが無効です。https://aistudio.google.com/apikey で作成したキーをコピーし直してください";
  if (/API_KEY_HTTP_REFERRER_BLOCKED|referer/i.test(raw)) return "APIキーのウェブサイト制限でブロックされています。キー設定で「なし」または tanity0.github.io を許可してください";
  if (err.status === 429 && /limit:\s*0/i.test(raw)) return "このキーではこのモデルの無料枠が0になっています（Google側の既知バグ）。AI Studio で新しいプロジェクトを作ってキーを作り直すと直ることが多いです";
  if (err.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw)) return "レート/無料枠の上限です。1〜2分待ってから失敗したムーブだけ再生成してください";
  if (err.status === 404 || /not found/i.test(raw)) return `モデルが見つかりません（${raw.slice(0, 120)}）。モデル選択を変えて試してください`;
  if (err.status === 403 || /PERMISSION_DENIED/i.test(raw)) return `このキーではこのモデルを使えません（${raw.slice(0, 120)}）。モデル選択を変えて試してください`;
  return raw;
}

async function callGeminiDirect(payload) {
  const referenceB64 = payload.reference.split(",")[1];
  const prompt = buildDirectPrompt(payload);
  const aspect = payload.kind === "strip" && payload.count > 1 ? (payload.count >= 4 ? "21:9" : "16:9") : null;
  const call = async (model, aspectRatio) => {
    const req = {
      contents: [{ parts: [{ inline_data: { mime_type: "image/png", data: referenceB64 } }, { text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    };
    if (aspectRatio) req.generationConfig.imageConfig = { aspectRatio };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": state.directKey },
      body: JSON.stringify(req),
      signal: state.abortController?.signal,
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error?.message || ""; } catch {}
      const err = new Error(`Gemini APIエラー (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
    if (!img) throw new Error("Geminiが画像を返しませんでした（プロンプトが安全フィルタに触れた可能性）");
    const b64 = img.inlineData?.data || img.inline_data?.data;
    const mime = img.inlineData?.mimeType || img.inline_data?.mime_type || "image/png";
    return `data:${mime};base64,${b64}`;
  };
  const callWithAspectRetry = async (model) => {
    try {
      return await call(model, aspect);
    } catch (err) {
      if (aspect && err.status === 400) return call(model, null); // imageConfig 未対応モデル
      throw err;
    }
  };
  // §55.4: 選択モデル→残りの候補の順で自動フォールバック（404/403のみ。キー無効等は即失敗）
  const models = [state.directModel || DIRECT_MODELS[0], ...DIRECT_MODELS.filter((m) => m !== (state.directModel || DIRECT_MODELS[0]))];
  let lastErr = null;
  for (const model of models) {
    try {
      const image = await callWithAspectRetry(model);
      if (model !== state.directModel) {
        state.directModel = model; // 効いたモデルを記憶
        try { localStorage.setItem(DIRECT_MODEL_STORAGE, model); } catch {}
      }
      return image;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastErr = err;
      // §55.6: モデル起因（404/403、または「429だが limit: 0」=枠ゼロ誤判定バグ）のみ次候補を試す
      const quotaZero = err.status === 429 && /limit:\s*0/i.test(err.message || "");
      if (err.status !== 404 && err.status !== 403 && !quotaZero) break;
    }
  }
  const e = new Error(friendlyGeminiError(lastErr));
  e.status = lastErr?.status; // §55.5: 429自動リトライの判定用
  e.raw = lastErr?.message;   // §55.5: retryDelay秒・1日上限（PerDay）の検出用
  throw e;
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
  if (state.directKey) return callGeminiDirect(payload); // §55: Web版はブラウザ直叩き
  const res = await fetch("/api/spriteframe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: state.abortController?.signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `サーバーエラー (HTTP ${res.status})`);
    err.status = res.status; // §55.5: 429自動リトライの判定用
    throw err;
  }
  if (!json.image) throw new Error("画像が返されませんでした");
  return json.image;
}

// §55.5: 429（無料枠のレート制限）は自動で待って再試行する。1日上限は即失敗（待っても無駄）。
// onWait(残り秒, 試行回数) で待機状況をUIに流す。
async function fetchSpriteFrameWithRetry(payload, onWait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchSpriteFrame(payload);
    } catch (err) {
      const msg = `${err.message || ""} ${err.raw || ""}`;
      const daily = /PerDay|per day|daily/i.test(msg);
      // §55.6: 枠ゼロ誤判定（limit: 0）は待っても直らないので再試行しない
      if (/limit:\s*0|無料枠が0/i.test(msg)) throw err;
      if (err.status !== 429 && !/レート\/無料枠の上限/.test(msg)) throw err;
      if (daily) throw new Error("本日の無料枠を使い切りました（翌日にリセットされます）。フレーム数やムーブ数を減らすか、ローカルのCodexエンジン（無料枠制限なし）をお試しください");
      if (attempt >= 2) throw err;
      // エラー文中の retryDelay（例 "retry in 34s" / "retryDelay: 34s"）があれば従い、無ければ62秒
      const m = /(\d+(?:\.\d+)?)\s*s/i.exec(msg);
      const waitSec = Math.min(120, m ? Math.ceil(parseFloat(m[1])) + 2 : 62);
      for (let s = waitSec; s > 0; s--) {
        if (state.abortController?.signal.aborted) {
          const e = new Error("中断しました");
          e.name = "AbortError";
          throw e;
        }
        onWait?.(s, attempt + 1);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// §55.5: ムーブブロックの注記表示（待機カウントダウン等。エラー行を色違いで流用）
function setMoveNote(move, text, isError = false) {
  const block = $("results").querySelector(`.moveResult[data-move="${move.key}"]`);
  const line = block?.querySelector(".errLine");
  if (!line) return;
  line.textContent = text || "";
  line.style.color = isError ? "#e05c5c" : "#f5a623";
  line.style.display = text ? "block" : "none";
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
    const image = await fetchSpriteFrameWithRetry(
      { ...spritePayloadBase(move), kind: "strip", count: slots.length },
      (sec, n) => setMoveNote(move, `⏳ 無料枠のレート制限のため待機中… ${sec}秒後に自動再試行（${n}回目）`)
    );
    setMoveNote(move, "");
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
    const image = await fetchSpriteFrameWithRetry(
      { ...spritePayloadBase(move), kind: "single", count: slots.length, index },
      (sec, n) => setMoveNote(move, `⏳ 無料枠のレート制限のため待機中… ${sec}秒後に自動再試行（${n}回目）`)
    );
    setMoveNote(move, "");
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
  // §55.5: 画像エンジンは直列1本（Gemini無料枠のレート制限対策。ムーブ単位なので所要は十分短い）
  await Promise.all(Array.from({ length: state.engine === "image" ? 1 : CONCURRENCY }, worker));

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
  const errSlots = [...state.results.values()].flat().filter((s) => s.status === "error");
  const unit = state.engine === "image" ? "ムーブ" : "フレーム"; // §53: 画像エンジンはムーブ単位
  // §55.4: 失敗時は最初のエラー内容を進捗行にも出す（スマホで原因が見えるように）
  const errNote = errSlots.length ? `（失敗 ${errSlots.length}コマ: ${(errSlots[0].error || "").slice(0, 140)} — ↻ で再生成できます）` : "";
  $("progressText").textContent = finished
    ? `完了: ${state.done}/${state.total}${unit}${errNote}・所要 ${sec}秒`
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

    // §55.4: ムーブ単位のエラー表示（スマホでも見えるように・ツールチップ非依存）
    const errLine = document.createElement("div");
    errLine.className = "errLine";
    errLine.style.cssText = "width:100%;color:#e05c5c;font-size:12px;display:none;word-break:break-all";

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
    block.append(h3, player, thumbs, errLine);
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
  // §55.4: ✕タップでエラー全文（モバイル）
  lbl.style.cursor = slot.status === "error" ? "pointer" : "";
  lbl.onclick = slot.status === "error" ? () => alert(slot.error || "エラー") : null;
  // ムーブ内の最初のエラーを赤字で表示
  const errLine = block.querySelector(".errLine");
  if (errLine) {
    const firstErr = state.results.get(move.key).find((s) => s.status === "error" && s.error);
    if (firstErr) {
      errLine.textContent = `⚠ ${firstErr.error}`;
      errLine.style.color = "#e05c5c"; // §55.5: 待機注記（橙）からエラー（赤）へ戻す
      errLine.style.display = "block";
    } else if (errLine.style.color !== "rgb(245, 166, 35)") {
      // 待機カウントダウン表示中は消さない
      errLine.textContent = "";
      errLine.style.display = "none";
    }
  }
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
