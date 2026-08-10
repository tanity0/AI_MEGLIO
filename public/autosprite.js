// autosprite.js — §52 クイック生成ウィザード（AutoSprite風・ワンショット・ムーブセット生成）
// 1枚のキャラ画像 → ドット絵変換 → ムーブセット選択 → mode:"motionframe" で全フレーム一括生成
// → プレビュー → スプライトシートPNG + アトラス（汎用JSON / Phaser 3 / Godot 4）書き出し。
// app.js（本体エントリ）には依存しない自己完結モジュール。グリッド文字規則の小ヘルパは
// server.js / app.js と同一の規則（透明= '.'、1-9、a-v。33色以上は2文字hex）を複製している。
import { streamEdit } from "./api.js";
import { removeBackground, convertImage, convertSheetImage, detectComponents, detectComponentsDetailed } from "./convert.js";
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
// §62: ムーブパック（MOTION_PACK_FORMAT.md）
const PACK_STORAGE = "autosprite.motionPack";
const RESERVED_MOVE_KEYS = new Set(["idle", "walk", "run", "jump", "attack", "custom"]);
const CONCURRENCY = 2; // §52.3: CLIバックエンド配慮（§15 と同じ理由）

const state = {
  base: null,          // { width, height, pixels: Uint8Array, palette: [hex...] }
  results: new Map(),  // moveKey -> [{ status, pixels, error }]
  prevResults: new Map(), // §67.3: 破壊的操作の直前スナップショット（ムーブ単位・1世代）
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
  note.textContent = "Web版です。Gemini APIキー（課金設定のあるもの。現在、画像生成APIに無料枠はありません）を入力すると、この端末だけで生成できます。キーはGoogleのAPI呼び出し以外には送信されません。キーなしでも、Geminiアプリ等で作った「コマを横一列に並べた画像」を各ムーブの📥から取り込んでスプライトシート化できます。";
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

// §57.2: コマ別の局面記述（server.js spritePhaseLines と同一ロジック）
function directPhaseLines(preset, count) {
  const pick = (arr, i) => arr[Math.min(arr.length - 1, Math.floor((i * arr.length) / count))];
  const phases = {
    walk: ["left foot forward, contact with ground, body slightly low", "passing pose, legs together under the body, body highest", "right foot forward, contact with ground, body slightly low", "passing pose, legs together, body highest"],
    run: ["contact: left foot planted under the hips with the knee bent to absorb impact, right leg trailing behind with the knee folded and heel kicked up toward the hip, torso leaning forward, right arm swinging forward", "airborne: both feet off the ground, left leg extended back after push-off, right thigh driving forward and up with the knee sharply bent and shin folded under, left arm swinging forward", "contact: right foot planted under the hips with the knee bent to absorb impact, left leg trailing behind with the knee folded and heel kicked up toward the hip, left arm swinging forward", "airborne: both feet off the ground, right leg extended back after push-off, left thigh driving forward and up with the knee sharply bent, right arm swinging forward"], // §68
    attack: ["wind-up: weapon/arm pulled back, weight on back foot", "strike: maximum forward reach, widest silhouette", "follow-through: motion settling back toward stance"],
    idle: ["neutral stance, chest relaxed (exhale)", "chest slightly raised, head up ~1px (inhale)", "neutral stance (exhale)", "chest slightly lowered (deep exhale)"],
    jump: ["crouch: knees bent, body compressed low", "launch: body fully extended upward, feet leaving ground", "apex: airborne, legs tucked, highest point", "landing: knees bending to absorb impact"],
  };
  const arr = phases[preset];
  if (!arr) return [];
  return Array.from({ length: count }, (_, i) => `Frame ${i + 1}: ${pick(arr, i)}.`);
}

function buildDirectPrompt(payload) {
  const { kind, preset, customText, count, index, desc } = payload;
  const moveDesc = preset === "custom" ? String(customText || "").trim() : DIRECT_MOVE_PROMPTS[preset];
  const lines = [];
  if (kind === "strip") {
    lines.push(`Create a pixel art sprite animation strip of the character in the reference image: exactly ${count} frames of ${moveDesc}.`);
    lines.push(`Arrange all ${count} frames in a single horizontal row, evenly spaced, with clear gaps between frames so the characters never touch each other.`);
    lines.push("Even wide poses (weapon swings, stretched arms or legs) must fit entirely inside their own frame area and must never cross into or overlap a neighboring frame."); // §63.2
    if (Array.isArray(payload.phases) && payload.phases.length) {
      payload.phases.slice(0, count).forEach((ph, i) => lines.push(`Frame ${i + 1}: ${ph}.`)); // §62
    } else {
      lines.push(...directPhaseLines(preset, count));
    }
    lines.push("All frames share the same ground line (feet baseline) and the same scale.");
    // §68: 走りは「毎コマ同じ大開脚」への退化が多いので明示的に禁止する
    if (preset === "run") lines.push("Make each frame clearly different: the legs alternate left/right through the cycle, knees always stay bent, and the trailing heel kicks up toward the hip. Never draw the same wide-legged splits pose with both legs straight in every frame.");
    // §60: ムーブ単位の修正指示つき再生成（Image 2 = 前回のストリップ）
    if (payload.current) {
      // §64: コマ数変更後の🔁 — 前回ストリップのコマ数が要求と異なる場合は「参照として使い、新コマ数へ配分」
      if (Number.isInteger(payload.currentCount) && payload.currentCount !== count) {
        lines.push(`Image 2 is a previous attempt of this animation with ${payload.currentCount} frames. Use it as the reference for the character, style and overall motion, but now draw exactly ${count} frames, re-spacing the motion evenly across them.`);
      } else {
        lines.push("Image 2 is the previous attempt of this exact animation strip. Keep the same frame count, layout, poses and style.");
      }
      if (payload.instruction) lines.push(`Change ONLY this across all frames: ${payload.instruction}. Keep everything else identical to Image 2.`);
      else if (!Number.isInteger(payload.currentCount) || payload.currentCount === count) lines.push("Redraw it more cleanly while keeping the same poses.");
    } else if (payload.instruction) {
      lines.push(`Additional request: ${payload.instruction}`);
    }
  } else {
    lines.push(`Create a single pixel art animation frame of the character in the reference image: frame ${index + 1} of ${count} of ${moveDesc}.`);
    const packPhase = Array.isArray(payload.phases) ? payload.phases[index] : null; // §62
    const phase = packPhase ? `Frame ${index + 1}: ${packPhase}.` : directPhaseLines(preset, count)[index];
    if (phase) lines.push(`This frame's pose — ${phase}`);
    lines.push("Draw exactly one character, full body.");
    if (payload.current) {
      lines.push("Image 2 is the previous attempt of this exact frame. Keep its overall pose and composition.");
      if (payload.instruction) lines.push(`Change ONLY this: ${payload.instruction}. Keep everything else identical to Image 2.`);
      else lines.push("Redraw it more cleanly while keeping the same pose.");
    } else if (payload.instruction) {
      lines.push(`Additional request: ${payload.instruction}`);
    }
  }
  lines.push("Keep the character's design, colors, proportions, outline style and pixel-art rendering exactly consistent with the reference image in every frame.");
  lines.push("Keep the same facing direction as the reference image.");
  lines.push("Crisp pixel-art rendering: hard pixel edges, no blur, no anti-aliasing halos, no gradients beyond the reference's shading style.");
  lines.push("Plain solid white background across the whole image. No grid lines, no frame borders, no text, no labels, no shadows on the ground, no checkerboard or transparency pattern, no gradient background.");
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
  if (err.status === 429 && /limit:\s*0/i.test(raw)) return "現在、Gemini画像生成APIには無料枠がありません（課金設定のあるキーが必要）。無料で使うには、Geminiアプリで「Nコマ横並び」の画像を作り、ムーブカードの📥から取り込んでください";
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
      contents: [{ parts: [
        { inline_data: { mime_type: "image/png", data: referenceB64 } },
        // §57.3: Image 2 = 前回のコマ（指示つき再生成のとき）
        ...(payload.current ? [{ inline_data: { mime_type: "image/png", data: payload.current.split(",")[1] } }] : []),
        { text: prompt },
      ] }],
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
    scheduleSessionSave(); // §67.1
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

// §58.2: エディタからの受け渡し（エディタの変換スタジオで作った素体・パレットをそのままベースに使う）
function receiveEditorHandoff() {
  if (location.hash !== "#editor-handoff") return;
  history.replaceState(null, "", location.pathname + location.search);
  let p;
  try {
    const raw = localStorage.getItem("aiMeglioHandoffToQuick");
    if (!raw) return;
    localStorage.removeItem("aiMeglioHandoffToQuick");
    p = JSON.parse(raw);
    if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || !Array.isArray(p.basePixels) || !Array.isArray(p.palette)) throw new Error("形式が不正です");
  } catch (err) {
    alert(`エディタからの受け取りに失敗しました: ${err.message}`);
    return;
  }
  state.base = { width: p.width, height: p.height, pixels: Uint8Array.from(p.basePixels), palette: p.palette };
  state.results.clear();
  $("results").innerHTML = "";
  // §58.6: 参照画像は「編集後のドット絵」を使う（sourceImage=元写真で上書きすると、
  // エディタで消した/直した箇所が生成時に元へ戻ってしまう）。sourceImage は
  // 再変換つまみ用に sourceImageData として復元だけしておく。
  state.referencePng = pixelsToPngDataUrl(state.base.pixels, p.width, p.height, p.palette, p.width > 64 ? 4 : 8);
  if (p.sourceImage) {
    dataUrlToImageData(p.sourceImage).then((img) => { sourceImageData = img; }).catch(() => {});
  }
  renderBasePreview();
  $("baseInfo").textContent += "（エディタから取り込み）";
  setLocked("step2", false);
  setLocked("step3", false);
  setLocked("step4", true);
  // §58.3/§58.4: エディタのフレームをムーブ結果として復元
  applyTaggedFrames(p);
}

// §58.4: タグ付きフレーム（{width,height,frames,tags}）をムーブ結果へ反映する共通処理。
// タグ名 = ムーブ名が原則。**ムーブ名に一致するタグが1つも無い場合**（シート取り込み等の
// 「all」タグなど）は、最初のタグ範囲を「カスタム」ムーブとして受け入れる。
function applyTaggedFrames(p) {
  if (!state.base || !Array.isArray(p.frames) || !Array.isArray(p.tags)) return false;
  const size = p.width * p.height;
  const framesOf = (tag) => {
    if (!Number.isInteger(tag.start) || !Number.isInteger(tag.end) || tag.end < tag.start) return [];
    return p.frames.slice(tag.start, tag.end + 1).filter((f) => f && f.length === size);
  };
  let applied = false;
  for (const tag of p.tags) {
    const move = MOVES.find((m) => m.key === tag.name);
    if (!move) continue;
    const frames = framesOf(tag);
    if (!frames.length) continue;
    move.on = true;
    move.frames = frames.length;
    state.results.set(move.key, frames.map((f) => ({ status: "ok", pixels: Uint8Array.from(f), error: null })));
    applied = true;
  }
  if (!applied) {
    // フォールバック: 先頭タグ（例: "all"）→ カスタムムーブとして復元
    const tag = p.tags[0];
    const frames = tag ? framesOf(tag) : [];
    if (frames.length) {
      const move = MOVES.find((m) => m.key === "custom");
      move.on = true;
      move.frames = frames.length;
      if (!move.customText) move.customText = tag.name || "imported";
      state.results.set(move.key, frames.map((f) => ({ status: "ok", pixels: Uint8Array.from(f), error: null })));
      applied = true;
    }
  }
  if (!applied) return false;
  const withResults = MOVES.filter((m) => state.results.has(m.key));
  renderMoveCards();
  renderResults(withResults);
  for (const m of withResults) state.results.get(m.key).forEach((_, i) => renderThumb(m, i));
  updateExportState();
  return true;
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
    const choices = FRAME_CHOICES.includes(m.frames) ? FRAME_CHOICES : [...FRAME_CHOICES, m.frames].sort((a, b) => a - b);
    for (const n of choices) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = String(n);
      if (n === m.frames) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => { m.frames = parseInt(sel.value, 10); });
    fr.append(sel);
    // §56: 手動ストリップ取り込み（AI不要。Geminiアプリ等で作った「Nコマ横並び画像」をドット化）
    const imp = document.createElement("button");
    imp.textContent = "📥";
    imp.title = "コマ画像を取り込み（AI不要）: Geminiアプリ等で作った「コマを横一列に並べた画像」を選ぶと、自動で分割してこのムーブのフレームにします";
    imp.style.cssText = "margin-left:auto;padding:0 8px";
    imp.addEventListener("click", () => {
      if (!state.base) { alert("先にステップ1でキャラ画像を取り込んでください（サイズとパレットの基準になります）"); return; }
      pendingImportMove = m;
      $("stripImportInput").click();
    });
    fr.append(imp);
    if (m.pack) card.title = m.customText; // §62: パックはプロンプトをツールチップ表示
    card.append(top, fr);
    if (m.key === "custom") {
      const txt = document.createElement("input");
      txt.type = "text";
      txt.maxLength = 300;
      txt.placeholder = "例: しゃがんで盾を構える";
      txt.value = m.customText || "";
      txt.addEventListener("input", () => { m.customText = txt.value; });
      card.append(txt);
    }
    wrap.append(card);
  }
}

// §62: ムーブパックの検証（MOTION_PACK_FORMAT.md v1）。不正は日本語メッセージで throw
function validateMotionPack(raw) {
  if (!raw || raw.format !== "aimeglio-motion-pack") throw new Error('format が "aimeglio-motion-pack" ではありません');
  if (raw.version !== 1) throw new Error("version は 1 のみ対応です");
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("name（パック名）が必要です");
  if (!Array.isArray(raw.moves) || raw.moves.length < 1 || raw.moves.length > 24) throw new Error("moves は1〜24個です");
  const seen = new Set();
  const moves = raw.moves.map((mv, i) => {
    const at = `moves[${i}]`;
    if (!mv || typeof mv !== "object") throw new Error(`${at} が不正です`);
    if (typeof mv.key !== "string" || !/^[a-zA-Z0-9_]{1,24}$/.test(mv.key)) throw new Error(`${at}.key は半角英数字と_のみ（1〜24字）です`);
    if (RESERVED_MOVE_KEYS.has(mv.key)) throw new Error(`${at}.key "${mv.key}" は予約名のため使えません`);
    if (seen.has(mv.key)) throw new Error(`${at}.key "${mv.key}" が重複しています`);
    seen.add(mv.key);
    if (typeof mv.label !== "string" || !mv.label.trim()) throw new Error(`${at}.label が必要です`);
    if (!Number.isInteger(mv.frames) || mv.frames < 2 || mv.frames > 8) throw new Error(`${at}.frames は2〜8です`);
    if (typeof mv.prompt !== "string" || !mv.prompt.trim() || mv.prompt.length > 300) throw new Error(`${at}.prompt が必要です（〜300字）`);
    if (mv.fps !== undefined && (!Number.isInteger(mv.fps) || mv.fps < 1 || mv.fps > 24)) throw new Error(`${at}.fps は1〜24です`);
    if (mv.phases !== undefined && (!Array.isArray(mv.phases) || mv.phases.length > 12 || !mv.phases.every((x) => typeof x === "string" && x.length <= 200))) {
      throw new Error(`${at}.phases が不正です（各〜200字・最大12）`);
    }
    if (mv.notes !== undefined && (typeof mv.notes !== "string" || mv.notes.length > 200)) throw new Error(`${at}.notes が不正です（〜200字）`);
    return mv;
  });
  return { name: raw.name.trim(), moves };
}

function clearMotionPack() {
  for (let i = MOVES.length - 1; i >= 0; i--) if (MOVES[i].pack) MOVES.splice(i, 1);
  try { localStorage.removeItem(PACK_STORAGE); } catch {}
  $("packInfo").textContent = "";
  $("packClearBtn").hidden = true;
  renderMoveCards();
}

function applyMotionPack(pack) {
  for (let i = MOVES.length - 1; i >= 0; i--) if (MOVES[i].pack) MOVES.splice(i, 1);
  const customIdx = MOVES.findIndex((m) => m.key === "custom");
  const moves = pack.moves.map((mv) => ({
    key: mv.key,
    preset: "custom",
    label: mv.label.trim(),
    icon: (typeof mv.icon === "string" && mv.icon.trim()) ? mv.icon.trim() : "🎞",
    frames: mv.frames,
    fps: mv.fps,
    loop: mv.loop !== false,
    on: true,
    customText: `${mv.prompt.trim()}${mv.notes ? `。禁止・補足: ${mv.notes.trim()}` : ""}`,
    phases: Array.isArray(mv.phases) && mv.phases.length ? mv.phases.slice() : null,
    pack: true,
  }));
  MOVES.splice(customIdx, 0, ...moves);
  renderMoveCards();
  $("packInfo").textContent = `📚 ${pack.name}（${moves.length}ムーブ）`;
  $("packClearBtn").hidden = false;
}

// phases をコマ数へ配分（server.js spritePhaseLines と同じ pick 方式）
function phasesForCount(phases, count) {
  if (!phases || !phases.length) return null;
  return Array.from({ length: count }, (_, i) => phases[Math.min(phases.length - 1, Math.floor((i * phases.length) / count))]);
}

function activeMoves() {
  return MOVES.filter((m) => m.on && (m.preset !== "custom" || m.customText.trim()));
}

// ---------------------------------------------------------------------------
// §56: 手動ストリップ取り込み（生成AIを使わないフォールバック）
// Geminiアプリ/ChatGPT等で作った「コマを横一列に並べた画像」を分割→ドット化して
// ムーブのフレームにする。コマ数は検出結果（2〜8体）を優先し、ムーブ設定を上書きする。
// ---------------------------------------------------------------------------
let pendingImportMove = null;

async function importStripForMove(move, file) {
  if (!file || !file.type.startsWith("image/") || !state.base) return;
  try {
    const strip = await fileToImageData(file);
    // コマ数の自動判定（検出できたらムーブのフレーム数を合わせる）
    const bg = removeBackground(strip.data, strip.w, strip.h, { multiBg: true }); // §65
    const boxes = detectComponents(bg, strip.w, strip.h);
    if (!boxes.length) throw new Error("キャラクターを検出できませんでした（背景が単色の画像を使ってください）");
    let n = boxes.length >= 2 && boxes.length <= 8 ? boxes.length : move.frames;
    // §63: 極端に幅の広いボックスはポーズ同士のbbox重なりで融合した疑い →
    // 検出数よりムーブの既定コマ数を信頼する（stripToFrames が谷分割で復元する）
    const widths = boxes.map((b) => b.x1 - b.x0 + 1).sort((a, b) => a - b);
    const fused = widths[widths.length - 1] >= widths[widths.length >> 1] * 1.6;
    if (fused && move.frames > boxes.length) n = move.frames;
    snapshotMove(move); // §67.3
    move.frames = n;
    move.on = true;
    const frames = stripToFrames(strip, n);
    state.results.set(move.key, frames.map((pixels) => ({ status: "ok", pixels, error: null })));
    // 結果ブロックを再描画（既存の他ムーブの結果は維持）
    const withResults = MOVES.filter((m) => state.results.has(m.key));
    renderResults(withResults);
    for (const m of withResults) state.results.get(m.key).forEach((_, i) => renderThumb(m, i));
    renderMoveCards(); // フレーム数・ONを反映
    updateExportState();
  } catch (err) {
    alert(`取り込みに失敗しました: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// ステップ3: 一括生成（並列2）
// ---------------------------------------------------------------------------
function baseGridString() {
  const b = state.base;
  return pixelsToGridString(b.pixels, b.width, b.height, b.palette.length);
}

function buildJobBody(move, index, total, regen, fixText) {
  const b = state.base;
  const grid = baseGridString();
  const mf = { preset: move.preset, index, total, variant: 0 };
  if (move.preset === "custom") mf.customText = move.customText.trim().slice(0, 500);
  if (fixText) mf.instruction = fixText.slice(0, 300); // §60
  else if (regen) mf.instruction = "前回と違うポーズ解釈で描き直してください";
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

async function runJob(move, index, regen = false, fixText = "") {
  const slots = state.results.get(move.key);
  const slot = slots[index];
  slot.status = "running";
  slot.error = null;
  renderThumb(move, index);
  try {
    const body = buildJobBody(move, index, slots.length, regen, fixText);
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
  if (x1 < 0) return { charH: b.height, charW: b.width, baselineY: b.height - 1, centerX: b.width / 2 };
  return { charH: y1 - y0 + 1, charW: x1 - x0 + 1, baselineY: y1, centerX: (x0 + x1 + 1) / 2 };
}

// §57.1: 変換パレット→ベースパレットの最近色スナップ表
function buildSnapMap(palette) {
  const baseRgb = state.base.palette.map(hexToRgba);
  return palette.map((hex, i) => {
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
}

// 変換フレーム（共通キャンバス cw×ch）をベースキャンバスへ足元基準・中央合わせで配置
function composeGrid(pixels, cw, ch, snap, metrics) {
  const b = state.base;
  const out = new Uint8Array(b.width * b.height);
  let offX = Math.round(metrics.centerX - cw / 2);
  let offY = metrics.baselineY + 1 - ch;
  // §63.2: キャンバスに収まるサイズなのに配置位置ではみ出す場合は枠内へシフト（切り捨て防止）
  if (cw <= b.width) offX = Math.max(0, Math.min(offX, b.width - cw));
  if (ch <= b.height) offY = Math.max(0, Math.min(offY, b.height - ch));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const idx = pixels[y * cw + x];
      if (idx === 0) continue;
      const tx = offX + x, ty = offY + y;
      if (tx < 0 || ty < 0 || tx >= b.width || ty >= b.height) continue;
      out[ty * b.width + tx] = snap[idx];
    }
  }
  return out;
}

// §57.4: はみ出すポーズが来たらキャンバスを自動拡張（上限512〔§79〕・足元は下端基準を維持）
// ベース・生成済みの全フレームを新キャンバスへ埋め直す
function expandBaseCanvas(needW, needH) {
  const b = state.base;
  const newW = Math.min(512, Math.max(b.width, needW));
  const newH = Math.min(512, Math.max(b.height, needH));
  if (newW === b.width && newH === b.height) return;
  const dx = Math.floor((newW - b.width) / 2);
  const dy = newH - b.height;
  const embed = (pixels) => {
    const out = new Uint8Array(newW * newH);
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        const v = pixels[y * b.width + x];
        if (v) out[(y + dy) * newW + (x + dx)] = v;
      }
    }
    return out;
  };
  const newBase = embed(b.pixels);
  for (const slots of state.results.values()) {
    for (const s of slots) if (s.pixels) s.pixels = embed(s.pixels);
  }
  b.pixels = newBase;
  b.width = newW;
  b.height = newH;
  renderBasePreview();
  // キャンバス寸法が変わったので結果ブロックを描画し直す
  const withResults = MOVES.filter((m) => state.results.has(m.key));
  if (withResults.length) {
    renderResults(withResults);
    for (const m of withResults) state.results.get(m.key).forEach((_, i) => renderThumb(m, i));
  }
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

// §63: コマ数の照合。検出数>Nは最近接ペアのマージ、検出数<Nは最大幅ボックスの谷分割。
// 返り値は「セル」= { x0,x1,y0,y1（走査範囲）, labelSet（丸ごと帰属する成分）,
// rectLabels+rectX0/X1（切断線をまたぐ成分の矩形切り範囲） }
function planStripCells(det, n, bg, w) {
  let cells = det.boxes.map((b) => ({
    x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1,
    labelSet: new Set(b.labels), rectLabels: new Set(), rectX0: 0, rectX1: -1,
  }));
  if (cells.length === 1 && n > 1) {
    // §63.4: 1成分でも、ベースキャラよりずっと横長なら「全ポーズが融合したストリップ」と
    // みなして谷分割へ回す（複製すると1コマに全ポーズが入ってしまう）。
    // 本当に1体だけ（MOCK・縮退）のときだけ全コマへ複製する。
    const c0 = cells[0];
    const m = baseCharMetrics();
    const baseAspect = Math.max(0.2, m.charW / Math.max(1, m.charH));
    const boxAspect = (c0.x1 - c0.x0 + 1) / Math.max(1, c0.y1 - c0.y0 + 1);
    if (boxAspect < baseAspect * 1.8) return Array.from({ length: n }, () => c0);
  }
  // 検出数 > N: 最も近い隣接ペアをマージ（別成分になった剣先などを正しいポーズへ戻す）
  while (cells.length > n) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i + 1 < cells.length; i++) {
      const d = cells[i + 1].x0 - cells[i].x1;
      if (d < bd) { bd = d; bi = i; }
    }
    const a = cells[bi], b = cells[bi + 1];
    cells.splice(bi, 2, {
      x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
      y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
      labelSet: new Set([...a.labelSet, ...b.labelSet]), rectLabels: new Set(), rectX0: 0, rectX1: -1,
    });
  }
  // 検出数 < N: 最大幅ボックスを列密度の谷で分割。成分は重心xで左右へ丸ごと帰属し、
  // 切断線をまたぐ成分だけ矩形で切る（伸ばした腕・剣先を可能な限り切断しない）
  while (cells.length < n) {
    let wi = 0;
    for (let i = 1; i < cells.length; i++) {
      if (cells[i].x1 - cells[i].x0 > cells[wi].x1 - cells[wi].x0) wi = i;
    }
    const c = cells[wi];
    const cw = c.x1 - c.x0 + 1;
    if (cw < 4) break; // これ以上割れない
    let cutX = c.x0 + (cw >> 1), best = Infinity;
    for (let x = c.x0 + Math.round(cw * 0.25); x <= c.x0 + Math.round(cw * 0.75); x++) {
      let dens = 0;
      for (let y = c.y0; y <= c.y1; y++) if (bg[(y * w + x) * 4 + 3] >= 128) dens++;
      if (dens < best) { best = dens; cutX = x; }
    }
    const mk = (rx0, rx1) => ({ x0: rx0, x1: rx1, y0: c.y0, y1: c.y1, labelSet: new Set(), rectLabels: new Set(), rectX0: rx0, rectX1: rx1 });
    // §63.4: 子セルの有効範囲は切断線で二分する（再分割時の幅測定・谷探索の基準）。
    // 丸ごと帰属した成分が範囲外へ伸びる場合だけ走査範囲を広げる
    const left = mk(c.x0, cutX), right = mk(cutX + 1, c.x1);
    const adopt = (cell, lbl) => {
      const f = det.fine[lbl];
      cell.labelSet.add(lbl);
      if (f.x0 < cell.x0) cell.x0 = f.x0;
      if (f.x1 > cell.x1) cell.x1 = f.x1;
    };
    for (const lbl of c.labelSet) {
      const f = det.fine[lbl];
      if (f.x1 <= cutX) { left.labelSet.add(lbl); continue; }
      if (f.x0 > cutX) { right.labelSet.add(lbl); continue; }
      // 切断線をまたぐ成分: セル幅いっぱいの成分（複数ポーズが融合した塊）は常に矩形切り。
      // それ以外は、片側に偏っていれば（剣先・伸ばした腕）重心側へ丸ごと帰属し、
      // 両側にほぼ半々のときだけ矩形で切る
      const fw = f.x1 - f.x0 + 1;
      if (fw >= cw * 0.85) { left.rectLabels.add(lbl); right.rectLabels.add(lbl); continue; }
      if (Math.min(cutX - f.x0 + 1, f.x1 - cutX) <= fw * 0.4) adopt(f.cx <= cutX ? left : right, lbl);
      else { left.rectLabels.add(lbl); right.rectLabels.add(lbl); }
    }
    for (const lbl of c.rectLabels) { left.rectLabels.add(lbl); right.rectLabels.add(lbl); }
    cells.splice(wi, 1, left, right);
  }
  while (cells.length < n) cells.push(cells[cells.length - 1]); // 分割不能時の安全弁（最終セル複製）
  return cells;
}

// §63: 各セルに帰属する画素だけをラベルマスクで抜き出し、透明ギャップを挟んで
// 並べ直したクリーンなストリップを作る（矩形が重なっていても隣ポーズは混入しない）
function buildCleanStrip(bg, w, h, cells, det) {
  const GAP = 4;
  const crops = cells.map((c) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    const buf = new Uint8ClampedArray(cw * ch * 4);
    let mx0 = cw, my0 = ch, mx1 = -1, my1 = -1;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const lbl = det.labelMap[y * w + x];
        if (lbl < 0) continue;
        const own = c.labelSet.has(lbl) || (c.rectLabels.has(lbl) && x >= c.rectX0 && x <= c.rectX1);
        if (!own) continue;
        const src = (y * w + x) * 4, dst = ((y - c.y0) * cw + (x - c.x0)) * 4;
        buf[dst] = bg[src]; buf[dst + 1] = bg[src + 1]; buf[dst + 2] = bg[src + 2]; buf[dst + 3] = bg[src + 3];
        const lx = x - c.x0, ly = y - c.y0;
        if (lx < mx0) mx0 = lx; if (lx > mx1) mx1 = lx;
        if (ly < my0) my0 = ly; if (ly > my1) my1 = ly;
      }
    }
    if (mx1 < 0) { mx0 = 0; my0 = 0; mx1 = cw - 1; my1 = ch - 1; } // 空セル安全弁
    return { buf, cw, x0: mx0, y0: my0, x1: mx1, y1: my1, srcY0: c.y0 };
  });
  const outW = crops.reduce((s, cr) => s + (cr.x1 - cr.x0 + 1), 0) + GAP * (crops.length + 1);
  const out = new Uint8ClampedArray(outW * h * 4);
  const boxes = [];
  let cursor = GAP;
  for (const cr of crops) {
    const bw = cr.x1 - cr.x0 + 1, bh = cr.y1 - cr.y0 + 1;
    const py0 = Math.max(0, Math.min(h - bh, cr.srcY0 + cr.y0)); // 元の縦位置を維持
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const src = ((cr.y0 + y) * cr.cw + (cr.x0 + x)) * 4;
        if (cr.buf[src + 3] === 0) continue;
        const dst = ((py0 + y) * outW + (cursor + x)) * 4;
        out[dst] = cr.buf[src]; out[dst + 1] = cr.buf[src + 1]; out[dst + 2] = cr.buf[src + 2]; out[dst + 3] = cr.buf[src + 3];
      }
    }
    boxes.push({ x0: cursor, y0: py0, x1: cursor + bw - 1, y1: py0 + bh - 1 });
    cursor += bw + GAP;
  }
  return { data: out, w: outW, h, boxes };
}

// 生成ストリップ → N個のベース互換フレーム（§53.3/§63: N一致 / 1体複製 / マージ・谷分割）
function stripToFrames(strip, n) {
  const bg = removeBackground(strip.data, strip.w, strip.h, { multiBg: true }); // §65
  const det = detectComponentsDetailed(bg, strip.w, strip.h);
  if (!det.boxes.length) throw new Error("生成画像からキャラクターを検出できませんでした");
  const cells = planStripCells(det, n, bg, strip.w);
  const clean = buildCleanStrip(bg, strip.w, strip.h, cells, det);
  // §57.1: 全コマ共通のセルサイズ・共通パレットで一括変換（しゃがみ/ジャンプの高さ差を保持し、コマ間の色ブレを防ぐ）
  const conv = convertSheetImage(clean.data, clean.w, clean.h, { targetH: baseCharMetrics().charH, colors: state.base.palette.length - 1 }, clean.boxes, "bottom");
  if (conv.width > state.base.width || conv.height > state.base.height) expandBaseCanvas(conv.width, conv.height); // §57.4
  const metrics = baseCharMetrics();
  const snap = buildSnapMap(conv.palette);
  return conv.framesPixels.map((px) => composeGrid(px, conv.width, conv.height, snap, metrics));
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
// §60: 現在のokコマを横並びストリップPNGに（ムーブ再生成の Image 2 用・白背景・コマ間ギャップ）
function currentStripPng(move) {
  const slots = state.results.get(move.key) || [];
  const frames = slots.filter((s) => s.status === "ok").map((s) => s.pixels);
  if (!frames.length) return null;
  const b = state.base;
  const sc = b.width > 64 ? 2 : 4;
  const gap = 8 * sc;
  const canvas = document.createElement("canvas");
  canvas.width = frames.length * b.width * sc + gap * (frames.length + 1);
  canvas.height = b.height * sc + gap * 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  frames.forEach((px, i) => {
    drawPixels(ctx, px, b.width, b.height, b.palette, sc, gap + i * (b.width * sc + gap), gap);
  });
  return canvas.toDataURL("image/png");
}

// §69: 生成中の経過表示（毎秒更新）。429待機カウントダウンは wait() で同枠に優先表示
function startMoveTicker(move, label) {
  const started = Date.now();
  let waitMsg = "";
  const render = () => {
    const sec = Math.round((Date.now() - started) / 1000);
    const slow = state.engine === "image" ? "。画像生成は1〜2分かかることがあります" : "";
    setMoveNote(move, waitMsg || `🎨 ${label}を生成中…（経過 ${sec}秒${slow}）`);
  };
  render();
  const t = setInterval(render, 1000);
  return {
    wait(msg) { waitMsg = msg; render(); },
    stop() { clearInterval(t); },
  };
}

async function runMoveStrip(move, opts = {}) {
  const slots = state.results.get(move.key);
  // §60: 前回ストリップは running へ変える前に取得する（ok コマから合成するため）
  const cur = opts.withCurrent ? currentStripPng(move) : null;
  const curCount = cur ? slots.filter((s) => s.status === "ok").length : 0; // §64
  slots.forEach((s, i) => { s.status = "running"; s.error = null; renderThumb(move, i); });
  const ticker = startMoveTicker(move, `「${move.label}」`); // §69
  try {
    const payload = { ...spritePayloadBase(move), kind: "strip", count: slots.length };
    const packPhases = phasesForCount(move.phases, slots.length); // §62
    if (packPhases) payload.phases = packPhases;
    if (opts.instruction) payload.instruction = opts.instruction.slice(0, 300);
    if (cur) payload.current = cur;
    if (cur && curCount && curCount !== slots.length) payload.currentCount = curCount; // §64: コマ数変更後の🔁
    const image = await fetchSpriteFrameWithRetry(
      payload,
      (sec, n) => ticker.wait(`⏳ 無料枠のレート制限のため待機中… ${sec}秒後に自動再試行（${n}回目）`)
    );
    ticker.stop();
    setMoveNote(move, "");
    const frames = stripToFrames(await dataUrlToImageData(image), slots.length);
    frames.forEach((pixels, i) => { slots[i].pixels = pixels; slots[i].status = "ok"; });
  } catch (err) {
    ticker.stop();
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
  // §57.3: 修正指示（任意）。キャンセルで中止。前回のコマがあれば画像も渡して「それ以外は維持」
  const instruction = window.prompt("このコマへの修正指示（任意。例: 左足を前に / 空欄=描き直しだけ）", "");
  if (instruction === null) return;
  snapshotMove(move); // §67.3
  slot.status = "running";
  slot.error = null;
  renderThumb(move, index);
  const ticker = startMoveTicker(move, `コマ${index + 1}`); // §69
  try {
    const b = state.base;
    const payload = { ...spritePayloadBase(move), kind: "single", count: slots.length, index };
    const packPhases = phasesForCount(move.phases, slots.length); // §62
    if (packPhases) payload.phases = packPhases;
    if (instruction.trim()) payload.instruction = instruction.trim().slice(0, 300);
    if (slot.pixels) payload.current = pixelsToPngDataUrl(slot.pixels, b.width, b.height, b.palette, b.width > 64 ? 4 : 8);
    const image = await fetchSpriteFrameWithRetry(
      payload,
      (sec, n) => ticker.wait(`⏳ 無料枠のレート制限のため待機中… ${sec}秒後に自動再試行（${n}回目）`)
    );
    ticker.stop();
    setMoveNote(move, "");
    const strip = await dataUrlToImageData(image);
    const bg = removeBackground(strip.data, strip.w, strip.h, { multiBg: true }); // §65
    const boxes = detectComponents(bg, strip.w, strip.h);
    if (!boxes.length) throw new Error("生成画像からキャラクターを検出できませんでした");
    const box = boxes.reduce((a, c) => ((c.area || 0) > (a.area || 0) ? c : a)); // 最大成分
    const conv = convertSheetImage(bg, strip.w, strip.h, { targetH: baseCharMetrics().charH, colors: state.base.palette.length - 1 }, [box], "bottom");
    if (conv.width > state.base.width || conv.height > state.base.height) expandBaseCanvas(conv.width, conv.height);
    slot.pixels = composeGrid(conv.framesPixels[0], conv.width, conv.height, buildSnapMap(conv.palette), baseCharMetrics());
    slot.status = "ok";
  } catch (err) {
    ticker.stop(); // §69
    slot.status = "error";
    slot.error = err.name === "AbortError" ? "中断しました" : err.message;
  }
  ticker.stop(); // §69: 成功経路（stripToFrames後）の停止も兼ねる
  renderThumb(move, index);
  updateExportState();
}

// §60: ムーブ単位の修正指示つき再生成（画像エンジン=ストリップごと・テキスト=フレーム順次）
async function regenMove(move) {
  const slots = state.results.get(move.key);
  if (!slots || state.running || slots.some((s) => s.status === "running")) return;
  state.abortController = null;
  snapshotMove(move); // §67.3
  const instruction = (move.fixText || "").trim();
  if (state.engine === "image") {
    await runMoveStrip(move, { instruction, withCurrent: true });
  } else {
    const ticker = startMoveTicker(move, `「${move.label}」`); // §69
    try {
      for (let i = 0; i < slots.length; i++) await runJob(move, i, true, instruction);
    } finally {
      ticker.stop();
      if (slots.some((s) => s.status === "error")) renderThumb(move, 0); // エラー行を復元
      else setMoveNote(move, "");
    }
    updateExportState();
  }
}

async function generateAll() {
  const moves = activeMoves();
  if (!moves.length) { alert("ムーブを1つ以上選択してください（カスタムはテキスト必須）"); return; }
  if (!state.base) return;
  // §69: 進行中の🔁/↻がある間は一括生成を始めない（結果の競合防止）
  if ([...state.results.values()].flat().some((s) => s.status === "running")) {
    alert("生成中のムーブがあります。完了を待ってから実行してください");
    return;
  }
  // §67.2: 生成済みムーブの上書き確認（OFFムーブの結果は消さず維持する）
  const overwriting = moves.filter((m) => (state.results.get(m.key) || []).some((s) => s.status === "ok"));
  if (overwriting.length) {
    const names = overwriting.map((m) => m.label).join("・");
    if (!confirm(`生成済みの${overwriting.length}ムーブ（${names}）を作り直します。よろしいですか？\n（1ムーブだけ直したいときは、各ブロックの「🔁 このムーブを再生成」が便利です）`)) return;
    for (const m of overwriting) snapshotMove(m); // §67.3: ↩で戻せるように
  }
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
  // §67.2: OFFムーブの既存結果も表示に残す（MOVES順）
  const withResults = MOVES.filter((mm) => state.results.has(mm.key));
  renderResults(withResults);
  for (const mm of withResults) {
    if (!moves.includes(mm)) state.results.get(mm.key).forEach((_, i) => renderThumb(mm, i));
  }
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
  // §60.2: ステップ1の変換プレビューと同じ大きさ（160px基準）
  const b = state.base;
  return Math.max(1, Math.floor(160 / Math.max(b.width, b.height)));
}

// §64: 生成後のコマ数変更。減=末尾削除、増=pendingを追加（↻か🔁で埋める）
function setMoveFrameCount(move, n) {
  const slots = state.results.get(move.key);
  if (!slots || state.running || slots.some((s) => s.status === "running")) return;
  if (!Number.isInteger(n) || n < 2 || n > 8 || n === slots.length) return;
  snapshotMove(move); // §67.3
  const grew = n > slots.length;
  if (grew) while (slots.length < n) slots.push({ status: "pending", pixels: null, error: null });
  else slots.length = n;
  move.frames = n;
  const withResults = MOVES.filter((m) => state.results.has(m.key));
  renderResults(withResults);
  for (const m of withResults) state.results.get(m.key).forEach((_, i) => renderThumb(m, i));
  renderMoveCards(); // ステップ2のカードのコマ数と同期
  updateExportState();
  if (grew) setMoveNote(move, "追加したコマは各コマの↻で個別生成、または「🔁 このムーブを再生成」で全コマまとめて埋められます");
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
    // §64: コマ数セレクト（生成後の変更）
    const cntSel = document.createElement("select");
    cntSel.className = "frameCountSel";
    cntSel.title = "コマ数を変更（減らす=末尾を削除・増やす=追加コマを↻か🔁で生成）";
    for (let v = 2; v <= 8; v++) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${v}コマ`;
      cntSel.append(o);
    }
    cntSel.value = String(state.results.get(m.key).length);
    cntSel.addEventListener("change", () => {
      setMoveFrameCount(m, parseInt(cntSel.value, 10));
      cntSel.value = String(state.results.get(m.key).length); // 変更が弾かれた場合は表示を戻す
    });
    const gifBtn = document.createElement("button");
    gifBtn.className = "gifBtn";
    gifBtn.textContent = "GIF保存";
    gifBtn.addEventListener("click", () => downloadMoveGif(m));
    // §66: このムーブの生成結果を削除
    const delBtn = document.createElement("button");
    delBtn.className = "delBtn";
    delBtn.textContent = "🗑";
    delBtn.title = "このムーブの生成結果を削除（ステップ2のカードもOFFになります）";
    delBtn.addEventListener("click", () => {
      const slots = state.results.get(m.key);
      if (state.running || !slots || slots.some((s) => s.status === "running")) return;
      if (!confirm(`「${m.label}」の生成結果を削除しますか？\n（ステップ2のカードもOFFになります。再度作るにはONにして生成してください）`)) return;
      state.results.delete(m.key);
      m.on = false;
      const withResults = MOVES.filter((mm) => state.results.has(mm.key));
      renderResults(withResults);
      for (const mm of withResults) state.results.get(mm.key).forEach((_, i) => renderThumb(mm, i));
      renderMoveCards();
      updateExportState();
    });
    h3.append(cntSel, gifBtn, delBtn);

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
    // §60: ムーブ単位の修正指示 + 再生成
    const fixRow = document.createElement("div");
    fixRow.style.cssText = "width:100%;display:flex;gap:8px;flex-wrap:wrap;align-items:center";
    const fixInput = document.createElement("input");
    fixInput.type = "text";
    fixInput.maxLength = 300;
    fixInput.placeholder = "このムーブへの修正指示（例: 腕をもっと大きく振る・もっと前傾で）";
    fixInput.style.cssText = "flex:1;min-width:160px;background:#1d2029;color:#e6e8ef;border:1px solid #333849;border-radius:6px;padding:4px 8px;font-size:12px";
    fixInput.value = m.fixText || "";
    fixInput.addEventListener("input", () => { m.fixText = fixInput.value; });
    const fixBtn = document.createElement("button");
    fixBtn.className = "fixBtn";
    fixBtn.textContent = "🔁 このムーブを再生成";
    fixBtn.title = "現在のコマ（ストリップ）をAIに渡し、ポーズ構成は維持したまま指示の点だけ変えて描き直します（指示が空なら描き直しのみ）";
    fixBtn.addEventListener("click", () => regenMove(m));
    // §67.3: 直前スナップショットとの入れ替え（もう一度押せば戻る）
    const undoBtn = document.createElement("button");
    undoBtn.className = "undoBtn";
    undoBtn.textContent = "↩ 直前と入れ替え";
    undoBtn.title = "再生成・↻・📥・コマ数変更の直前の結果と入れ替えます。もう一度押すと戻せます";
    undoBtn.style.display = state.prevResults.has(m.key) ? "" : "none";
    undoBtn.addEventListener("click", () => {
      const cur = state.results.get(m.key);
      const prev = state.prevResults.get(m.key);
      if (state.running || !cur || !prev || cur.some((s) => s.status === "running")) return;
      state.prevResults.set(m.key, cur);
      state.results.set(m.key, prev);
      m.frames = prev.length;
      const withResults = MOVES.filter((mm) => state.results.has(mm.key));
      renderResults(withResults);
      for (const mm of withResults) state.results.get(mm.key).forEach((_, i) => renderThumb(mm, i));
      renderMoveCards();
      updateExportState();
    });
    fixRow.append(fixInput, fixBtn, undoBtn);
    block.append(h3, player, thumbs, errLine, fixRow);
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
  // §67.3: スナップショットができていたら↩を出す（再生成の進行中に snapshot される）
  const ub = block.querySelector(".undoBtn");
  if (ub) ub.style.display = state.prevResults.has(move.key) ? "" : "none";
  // §69: 生成中は🔁を無効化（見た目でも「実行中」がわかるように）
  const fb = block.querySelector(".fixBtn");
  if (fb) fb.disabled = state.results.get(move.key).some((s) => s.status === "running");
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
    const mv = MOVES.find((m) => m.key === e.move); // §62: ムーブ別 fps/loop
    (animations[e.move] ||= { frames: [], fps: mv?.fps || fps, loop: mv ? mv.loop !== false : true }).frames.push(e.name);
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
    const mv = MOVES.find((m) => m.key === move); // §62
    return `"frames": [${fr}],\n"loop": ${mv ? mv.loop !== false : true},\n"name": &"${move}",\n"speed": ${(mv?.fps || fps)}.0`;
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
    tags.push({ name: r.move.key, start, end: frames.length - 1, fps: r.move.fps || fps, loop: r.move.loop !== false }); // §62
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

// §67.3: 破壊的操作（🔁・↻・📥・コマ数変更・一括生成の差し替え）前のスナップショット
function snapshotMove(move) {
  const slots = state.results.get(move.key);
  if (!slots || !slots.some((s) => s.status === "ok")) return;
  state.prevResults.set(move.key, slots.map((s) => ({ ...s })));
}

// §67.1: セッション自動保存（localStorage・debounce）。グリッド文字列で圧縮保存
const SESSION_KEY = "autosprite.session";
let sessionSaveTimer = null;
function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 800);
}
function saveSession() {
  if (!state.base) return;
  try {
    const b = state.base;
    const enc = (px) => pixelsToGridString(px, b.width, b.height, b.palette.length);
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: 1,
      base: { width: b.width, height: b.height, palette: b.palette, grid: enc(b.pixels) },
      referencePng: state.referencePng || null,
      charName: $("charName").value,
      charDesc: $("charDesc").value,
      fps: $("fpsSel").value,
      moves: MOVES.map((m) => ({ key: m.key, frames: m.frames, on: m.on, fixText: m.fixText || "", customText: m.key === "custom" ? m.customText : undefined })),
      results: [...state.results.entries()].map(([key, slots]) => ({
        key,
        slots: slots.map((s) => ({ ok: s.status === "ok" && !!s.pixels, grid: s.status === "ok" && s.pixels ? enc(s.pixels) : null })),
      })),
    }));
  } catch (e) {
    console.warn("セッション保存に失敗:", e);
  }
}
// §67.1: 起動時の復元（⚡受け渡しが無いときのみ呼ばれる）
function restoreSession() {
  let d;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    d = JSON.parse(raw);
    if (!d || d.v !== 1 || !d.base || !d.base.grid) return false;
  } catch { return false; }
  try {
    const { width, height, palette } = d.base;
    state.base = { width, height, palette, pixels: pixelsFromRows(d.base.grid.split("\n"), width, height, palette.length) };
    state.referencePng = d.referencePng || pixelsToPngDataUrl(state.base.pixels, width, height, palette, width > 64 ? 4 : 8);
    if (typeof d.charName === "string") $("charName").value = d.charName;
    if (typeof d.charDesc === "string") $("charDesc").value = d.charDesc;
    if (d.fps && [...$("fpsSel").options].some((o) => o.value === d.fps)) $("fpsSel").value = d.fps;
    for (const sm of d.moves || []) {
      const m = MOVES.find((x) => x.key === sm.key);
      if (!m) continue;
      if (Number.isInteger(sm.frames) && sm.frames >= 2 && sm.frames <= 8) m.frames = sm.frames;
      m.on = !!sm.on;
      m.fixText = sm.fixText || "";
      if (sm.customText !== undefined) m.customText = sm.customText;
    }
    for (const rm of d.results || []) {
      if (!MOVES.some((x) => x.key === rm.key) || !Array.isArray(rm.slots) || !rm.slots.length) continue;
      state.results.set(rm.key, rm.slots.map((sl) => sl.ok && sl.grid
        ? { status: "ok", pixels: pixelsFromRows(sl.grid.split("\n"), width, height, palette.length), error: null }
        : { status: "error", pixels: null, error: "保存時に未完成でした（↻で生成できます）" }));
    }
    renderBasePreview();
    $("baseInfo").textContent += "（前回の続きを復元）";
    setLocked("step2", false);
    setLocked("step3", false);
    renderMoveCards();
    const withResults = MOVES.filter((mm) => state.results.has(mm.key));
    if (withResults.length) {
      renderResults(withResults);
      for (const mm of withResults) state.results.get(mm.key).forEach((_, i) => renderThumb(mm, i));
    }
    updateExportState();
    return true;
  } catch (e) {
    console.warn("セッション復元に失敗:", e);
    return false;
  }
}

function updateExportState() {
  const rows = collectSheet();
  const has = rows.length > 0;
  setLocked("step4", !has);
  if (has) renderSheetPreview();
  // §67.4: 一部コマが未生成/エラーのムーブを警告（書き出しには ok コマしか載らない）
  const warnEl = $("exportWarn");
  if (warnEl) {
    const warns = [];
    for (const m of MOVES) {
      const slots = state.results.get(m.key);
      if (!slots) continue;
      const ok = slots.filter((s) => s.status === "ok").length;
      if (ok > 0 && ok < slots.length) warns.push(`${m.label} ${ok}/${slots.length}コマ`);
    }
    warnEl.textContent = warns.length ? `⚠ 未完成のコマは書き出しに載りません: ${warns.join("・")}（各コマの↻で生成できます）` : "";
    warnEl.style.display = warns.length ? "block" : "none";
  }
  scheduleSessionSave(); // §67.1
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

// §58: 本体エディタへワンクリック受け渡し（localStorage 経由・別タブ。このページの状態は保持される）
function openInEditor() {
  const rows = collectSheet();
  if (!rows.length) return;
  const fps = parseInt($("fpsSel").value, 10) || 8;
  try {
    localStorage.setItem("aiMeglioHandoff", buildProjectJson(rows, fps));
  } catch (err) {
    alert(`受け渡しに失敗しました（容量オーバーの可能性）: ${err.message}。「プロジェクトJSON」でダウンロードしてエディタの読込を使ってください`);
    return;
  }
  window.open("./index.html#quickgen-handoff", "_blank");
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
  // §62: ムーブパック読込
  $("packLoadBtn").addEventListener("click", () => $("packInput").click());
  $("packInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const raw = await file.text();
      const pack = validateMotionPack(JSON.parse(raw));
      applyMotionPack(pack);
      try { localStorage.setItem(PACK_STORAGE, raw); } catch {}
    } catch (err) {
      alert(`ムーブパックの読込に失敗しました: ${err.message}\n（形式は MOTION_PACK_FORMAT.md を参照）`);
    }
  });
  $("packClearBtn").addEventListener("click", clearMotionPack);
  try {
    const saved = localStorage.getItem(PACK_STORAGE);
    if (saved) applyMotionPack(validateMotionPack(JSON.parse(saved)));
  } catch {}

  // §56: 手動ストリップ取り込み
  $("stripImportInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (pendingImportMove) importStripForMove(pendingImportMove, file);
    pendingImportMove = null;
  });
  $("generateBtn").addEventListener("click", generateAll);
  $("abortBtn").addEventListener("click", () => { state.abortController?.abort(); $("abortBtn").disabled = true; });
  $("scaleSel").addEventListener("change", renderSheetPreview);
  $("dlSheetBtn").addEventListener("click", exportSheet);
  $("dlAtlasBtn").addEventListener("click", exportAtlas);
  $("dlProjectBtn").addEventListener("click", exportProject);
  $("openInEditorBtn").addEventListener("click", openInEditor); // §58

  // §61: スマホ長押し対策（キャンバスの長押しメニュー・ドラッグ抑止）
  document.addEventListener("contextmenu", (e) => {
    if (e.target instanceof HTMLCanvasElement) e.preventDefault();
  });
  document.addEventListener("dragstart", (e) => {
    if (e.target instanceof HTMLCanvasElement || e.target instanceof HTMLImageElement) e.preventDefault();
  });

  requestAnimationFrame(animLoop);
  receiveEditorHandoff(); // §58.2
  if (!state.base) restoreSession(); // §67.1: ⚡受け渡しが無ければ前回の続きを復元
  // §67.1: 入力欄の変更も保存対象（結果の更新は updateExportState 経由で保存される）
  $("charName").addEventListener("input", scheduleSessionSave);
  $("charDesc").addEventListener("input", scheduleSessionSave);
  $("fpsSel").addEventListener("change", scheduleSessionSave);

  // §58.4: エディタからのライブ同期を受信（同一ブラウザの別タブ）。
  // ベースとキャンバス寸法が一致するときだけ反映（無関係なプロジェクトは無視）。
  if ("BroadcastChannel" in window) {
    const liveBc = new BroadcastChannel("aimeglio-live");
    liveBc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.type !== "quickgen-frames" || state.running) return;
      // §58.7: ベースは編集中の現在フレーム（無ければ先頭）を使う
      const curIdx = Number.isInteger(m.current) ? m.current : 0;
      const curRaw = m.frames && (m.frames[curIdx] || m.frames[0]);
      if (!state.base) {
        // §58.5: ウィザードが空なら、エディタのプロジェクトをそのまま土台として受け入れる
        // （JSON読み込み直後などでも⚡を押し直さずに同期が始まる）
        const first = curRaw ? Uint8Array.from(curRaw) : null;
        if (!first || first.length !== m.width * m.height) return;
        state.base = { width: m.width, height: m.height, pixels: first, palette: m.palette };
        state.referencePng = pixelsToPngDataUrl(state.base.pixels, m.width, m.height, m.palette, m.width > 64 ? 4 : 8);
        renderBasePreview();
        $("baseInfo").textContent += "（エディタからライブ同期）";
        setLocked("step2", false);
        setLocked("step3", false);
        setLocked("step4", true);
      } else if (m.width !== state.base.width || m.height !== state.base.height) {
        // §58.5: 黙って無視せず理由を表示
        $("progressWrap").style.display = "flex";
        $("progressText").textContent = `⚠ エディタ側（${m.width}×${m.height}）とキャンバスサイズが違うため同期していません。エディタの「⚡ クイック生成」で渡し直してください`;
        return;
      }
      state.base.palette = m.palette; // パレット編集も追従
      // §58.7: ベースと生成用参照（referencePng）も編集後の絵へ追従させる。
      // これを怠るとムーブのコマだけ更新され、生成のたびに編集前の参照がAIへ渡り続ける
      if (curRaw && curRaw.length === state.base.width * state.base.height) {
        const arr = Uint8Array.from(curRaw);
        if (arr.some((v) => v !== 0)) {
          state.base.pixels = arr;
          state.referencePng = pixelsToPngDataUrl(arr, state.base.width, state.base.height, state.base.palette, state.base.width > 64 ? 4 : 8);
          renderBasePreview();
          $("baseInfo").textContent += "（エディタからライブ同期）";
          scheduleSessionSave();
        }
      }
      if (applyTaggedFrames(m)) {
        $("progressWrap").style.display = "flex";
        $("progressText").textContent = "🔄 エディタの編集を反映しました（ライブ同期）";
      }
    };
  }

  // §59.3: 旧SW（cache-first時代・§55.7以前）を掴んだままのブラウザを自己回復させる。
  // このページからも SW 本体の更新チェックと version.json の再確認を明示的に起こす
  // （swupdate.js は index.html 専用のため、ここに最小限を複製）。
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      reg.update().catch(() => {});
      if (navigator.serviceWorker.controller) {
        const ch = new MessageChannel();
        navigator.serviceWorker.controller.postMessage({ type: "AI_MEGLIO_CHECK_VERSION" }, [ch.port2]);
      }
    }).catch(() => {});
  }
}

init();
