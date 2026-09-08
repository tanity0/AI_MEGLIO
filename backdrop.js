// §45: 背景色の変更 — 透明部分とキャンバス周りの「表示」色を切り替える。
// 実装は CSS カスタムプロパティ（--bd-*）のみで行い、描画データ（canvas の画素・
// frame.pixels）には一切触れない。書き出し（PNG/GIF/シート/ゲーム）はすべて
// オフスクリーン canvas の別経路なので、構造的に影響しない（§45.3）。
const KEY = "aiMeglio.backdrop";

// 単色プリセット（§45.1）
const SOLID_PRESETS = {
  dark: "#202020",
  lightgray: "#c8c8c8",
  white: "#ffffff",
  black: "#000000",
  green: "#00b140",
  magenta: "#ff00ff",
};

// 市松の2色（§45.1: 明/暗）
const CHECKER = {
  "checker-dark": { base: "#202020", square: "#333333" }, // 従来のプレビュー/サムネと同じ
  "checker-light": { base: "#ffffff", square: "#cccccc" },
};

function clamp8(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => clamp8(v).toString(16).padStart(2, "0")).join("");
}

// キャンバス外周（#canvasWrap の余白）: 同系で僅かに明暗差を付ける（§45.2）。
// 明るい背景 → 少し暗く、暗い背景 → 少し明るく（真っ黒でも境界が見えるように）。
function wrapColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const d = luma > 96 ? -26 : 22;
  return rgbToHex(r + d, g + d, b + d);
}

// 市松模様の background-image（既存のプレビュー/サムネと同じ4グラデーション構成）
function checkerImage(square) {
  return [
    `linear-gradient(45deg, ${square} 25%, transparent 25%)`,
    `linear-gradient(-45deg, ${square} 25%, transparent 25%)`,
    `linear-gradient(45deg, transparent 75%, ${square} 75%)`,
    `linear-gradient(-45deg, transparent 75%, ${square} 75%)`,
  ].join(", ");
}

function normalizeConfig(cfg) {
  const mode = cfg && typeof cfg.mode === "string" ? cfg.mode : "checker-dark";
  const color = cfg && /^#[0-9a-fA-F]{6}$/.test(cfg.color || "") ? cfg.color.toLowerCase() : "#202020";
  if (!(mode in CHECKER) && !(mode in SOLID_PRESETS) && mode !== "custom") {
    return { mode: "checker-dark", color };
  }
  return { mode, color };
}

function loadConfig() {
  try { return normalizeConfig(JSON.parse(localStorage.getItem(KEY) || "null")); }
  catch { return normalizeConfig(null); }
}

function saveConfig(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
}

// cfg → CSS カスタムプロパティへ反映（表示専用）
export function applyBackdrop(cfg) {
  const { mode, color } = normalizeConfig(cfg);
  let base, img;
  if (mode in CHECKER) {
    base = CHECKER[mode].base;
    img = checkerImage(CHECKER[mode].square);
  } else {
    base = mode === "custom" ? color : SOLID_PRESETS[mode];
    img = "none";
  }
  const st = document.documentElement.style;
  st.setProperty("--bd-color", base);
  st.setProperty("--bd-img", img);
  st.setProperty("--bd-wrap", wrapColor(base));
}

export function initBackdrop() {
  const select = document.getElementById("backdropSelect");
  const picker = document.getElementById("backdropColor");
  if (!select || !picker) return;

  let cfg = loadConfig();
  select.value = cfg.mode;
  picker.value = cfg.mode in SOLID_PRESETS ? SOLID_PRESETS[cfg.mode] : cfg.color;
  applyBackdrop(cfg);

  select.addEventListener("change", () => {
    cfg = normalizeConfig({ mode: select.value, color: picker.value });
    // 単色プリセットを選んだらピッカーも同色に（そこから微調整すると「任意色」になる）
    if (cfg.mode in SOLID_PRESETS) picker.value = SOLID_PRESETS[cfg.mode];
    saveConfig(cfg);
    applyBackdrop(cfg);
  });
  picker.addEventListener("input", () => {
    cfg = normalizeConfig({ mode: "custom", color: picker.value });
    select.value = "custom";
    saveConfig(cfg);
    applyBackdrop(cfg);
  });
}
