// studio.js — §18.2 変換スタジオ（インポートウィザードv2）UI
// 候補ギャラリー → つまみでリアルタイム再変換 → 元画像との同期ズーム比較 → 確定
import { removeBackground, estimateGrid, convertImage, extractMainPalette } from "./convert.js";
import { hexToRgba, defaultTags } from "./app.js";

let store = null;
let toast = null;

// スタジオ状態
let srcData = null; // {data, w, h} 元画像（フル解像度）
let srcDataUrl = "";
let bgCache = null; // 背景除去済み Uint8ClampedArray
let grid = null; // {s, ox, oy, confidence}
let result = null; // convertImage の結果
let view = { zoom: 1, panX: 0, panY: 0 };
let convertGen = 0;
let knobs = null;

const $ = (id) => document.getElementById(id);

function defaultKnobs() {
  return {
    oneToOne: false,
    targetH: 64,
    colors: 64,
    sizeDelta: 0,
    offsetDX: 0,
    offsetDY: 0,
    domBlend: 0.15,
    centerWeight: 0.5,
    edgeProtect: 0.3,
    satProtect: 0.5,
    bgThreshold: 48,
    glowWidth: 0,
  };
}

function knobsToParams() {
  return {
    s: grid.s + knobs.sizeDelta,
    ox: grid.ox + knobs.offsetDX,
    oy: grid.oy + knobs.offsetDY,
    targetH: knobs.oneToOne ? 0 : knobs.targetH,
    colors: knobs.colors,
    domBlend: knobs.domBlend,
    centerWeight: knobs.centerWeight,
    edgeProtect: knobs.edgeProtect,
    satProtect: knobs.satProtect,
  };
}

// ---------------------------------------------------------------------------
// 変換実行（キャッシュ付き・世代カウンタで陳腐化キャンセル）
// ---------------------------------------------------------------------------
async function ensureBg() {
  if (!bgCache) {
    bgCache = removeBackground(srcData.data, srcData.w, srcData.h, {
      threshold: knobs.bgThreshold,
      glowWidth: knobs.glowWidth,
    });
    grid = null; // 背景が変わればグリッドも再推定
  }
  return bgCache;
}

async function ensureGrid() {
  await ensureBg();
  if (!grid) {
    $("studioStatus").textContent = "グリッド推定中…";
    grid = await estimateGrid(bgCache, srcData.w, srcData.h, (msg) => {
      $("studioStatus").textContent = msg;
    });
    $("studioGridInfo").textContent =
      `グリッド推定: セル ${grid.s.toFixed(2)}px / 位相 (${grid.ox.toFixed(2)}, ${grid.oy.toFixed(2)}) / 信頼度 ${(grid.confidence * 100).toFixed(0)}%` +
      (grid.confidence < 0.5 ? "（低め — グリッド微調整つまみで追い込んでください）" : "");
  }
  return grid;
}

let convertTimer = null;
function scheduleConvert() {
  clearTimeout(convertTimer);
  convertTimer = setTimeout(runConvert, 150);
}

async function runConvert() {
  const gen = ++convertGen;
  try {
    await ensureGrid();
    if (gen !== convertGen) return;
    $("studioStatus").textContent = "変換中…";
    await new Promise((r) => setTimeout(r, 0));
    const res = convertImage(bgCache, srcData.w, srcData.h, knobsToParams());
    if (gen !== convertGen) return;
    result = res;
    $("studioStatus").textContent = `出力: ${res.width}×${res.height}・${res.palette.length - 1}色（+透明）`;
    renderCompare();
  } catch (err) {
    if (gen !== convertGen) return;
    result = null;
    $("studioStatus").textContent = `エラー: ${err.message}`;
    renderCompare();
  }
}

// ---------------------------------------------------------------------------
// 同期ズーム/パンの並列比較ビュー（§18.2-5,6）
// ---------------------------------------------------------------------------
function resultToCanvas(res) {
  const c = document.createElement("canvas");
  c.width = res.width;
  c.height = res.height;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(res.width, res.height);
  for (let i = 0; i < res.pixels.length; i++) {
    const [r, g, b, a] = hexToRgba(res.palette[res.pixels[i]]);
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

let srcBitmapCanvas = null;
function renderCompare() {
  const sc = $("studioSrcCanvas");
  const rc = $("studioResCanvas");
  for (const c of [sc, rc]) {
    const rect = c.parentElement.getBoundingClientRect();
    c.width = Math.max(50, rect.width - 2);
    c.height = Math.max(50, rect.height - 2);
  }
  const zoom = view.zoom;
  // ソース側
  {
    const ctx = sc.getContext("2d");
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.clearRect(0, 0, sc.width, sc.height);
    ctx.drawImage(srcBitmapCanvas, -view.panX * zoom, -view.panY * zoom, srcData.w * zoom, srcData.h * zoom);
  }
  // 結果側（1セル = cs 元px として同倍率で描画）
  {
    const ctx = rc.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, rc.width, rc.height);
    if (result) {
      const p = knobsToParams();
      const cs = p.targetH > 0 ? result.srcCellSize || guessCellSize() : p.s;
      const resCanvas = resultToCanvas(result);
      const originX = result.originX ?? 0;
      const originY = result.originY ?? 0;
      ctx.drawImage(
        resCanvas,
        (originX - view.panX) * zoom,
        (originY - view.panY) * zoom,
        result.width * cs * zoom,
        result.height * cs * zoom
      );
    }
  }
}
function guessCellSize() {
  // targetH モード時のセルサイズ（bboxH/targetH）は convertImage 内と同じ計算
  return result && result.srcCellSize ? result.srcCellSize : grid ? grid.s : 8;
}

function attachViewControls() {
  for (const id of ["studioSrcCanvas", "studioResCanvas"]) {
    const c = $(id);
    c.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 0.85 : 1.18;
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const beforeX = view.panX + mx / view.zoom;
      const beforeY = view.panY + my / view.zoom;
      view.zoom = Math.max(0.05, Math.min(40, view.zoom * factor));
      view.panX = beforeX - mx / view.zoom;
      view.panY = beforeY - my / view.zoom;
      renderCompare();
    }, { passive: false });
    let drag = null;
    c.addEventListener("mousedown", (ev) => { drag = { x: ev.clientX, y: ev.clientY }; });
    window.addEventListener("mousemove", (ev) => {
      if (!drag) return;
      view.panX -= (ev.clientX - drag.x) / view.zoom;
      view.panY -= (ev.clientY - drag.y) / view.zoom;
      drag = { x: ev.clientX, y: ev.clientY };
      renderCompare();
    });
    window.addEventListener("mouseup", () => { drag = null; });
  }
}

function fitView() {
  const c = $("studioSrcCanvas");
  const rect = c.parentElement.getBoundingClientRect();
  view.zoom = Math.min((rect.width - 4) / srcData.w, (rect.height - 4) / srcData.h);
  view.panX = 0;
  view.panY = 0;
}

// ---------------------------------------------------------------------------
// 候補ギャラリー（§18.2-5）: 解像度3段 × スタイル3種
// ---------------------------------------------------------------------------
const CANDIDATE_STYLES = [
  { label: "カリカリ", domBlend: 0, edgeProtect: 0.6, satProtect: 0.7 },
  { label: "標準", domBlend: 0.15, edgeProtect: 0.3, satProtect: 0.5 },
  { label: "なめらか", domBlend: 0.5, edgeProtect: 0, satProtect: 0.3 },
];

async function generateCandidates() {
  await ensureGrid();
  const gallery = $("studioGallery");
  gallery.innerHTML = "";
  const oneToOneRows = Math.round((srcData.h / grid.s) * 0.9);
  const resolutions = [];
  if (oneToOneRows <= 128) resolutions.push({ label: "1:1", oneToOne: true, targetH: 0 });
  else resolutions.push({ label: "H96", oneToOne: false, targetH: 96 });
  resolutions.push({ label: "H64", oneToOne: false, targetH: 64 });
  resolutions.push({ label: "H48", oneToOne: false, targetH: 48 });

  let done = 0;
  for (const res of resolutions) {
    for (const style of CANDIDATE_STYLES) {
      const candKnobs = { ...knobs, ...style, oneToOne: res.oneToOne, targetH: res.targetH || knobs.targetH };
      const saveKnobs = knobs;
      knobs = candKnobs;
      const params = knobsToParams();
      knobs = saveKnobs;
      let conv = null;
      try {
        conv = convertImage(bgCache, srcData.w, srcData.h, params);
      } catch {}
      const cell = document.createElement("div");
      cell.className = "cand-cell";
      const cv = document.createElement("canvas");
      if (conv) {
        const scale = Math.max(1, Math.floor(120 / Math.max(conv.width, conv.height)));
        cv.width = conv.width * scale;
        cv.height = conv.height * scale;
        const cctx = cv.getContext("2d");
        cctx.imageSmoothingEnabled = false;
        cctx.drawImage(resultToCanvas(conv), 0, 0, cv.width, cv.height);
      }
      const label = document.createElement("span");
      label.textContent = conv
        ? `${res.label}（${conv.width}×${conv.height}）・${candKnobs.colors}色・${style.label}`
        : `${res.label}・${style.label}（失敗）`;
      cell.appendChild(cv);
      cell.appendChild(label);
      if (conv) {
        cell.addEventListener("click", () => {
          // これをベースにする: 候補のパラメータを全つまみに反映（§18.2-5）
          knobs = { ...knobs, ...style, oneToOne: res.oneToOne, targetH: res.targetH || knobs.targetH };
          syncKnobUi();
          scheduleConvert();
          gallery.querySelectorAll(".cand-cell").forEach((el) => el.classList.remove("is-active"));
          cell.classList.add("is-active");
        });
      }
      gallery.appendChild(cell);
      done++;
      $("studioStatus").textContent = `候補生成中… ${done}/9`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  $("studioStatus").textContent = "候補から選ぶか、つまみで追い込んでください";
}

// ---------------------------------------------------------------------------
// つまみUI
// ---------------------------------------------------------------------------
const KNOB_BINDINGS = [
  ["studioTargetH", "targetH", Number],
  ["studioColors", "colors", Number],
  ["studioDomBlend", "domBlend", Number],
  ["studioCenterWeight", "centerWeight", Number],
  ["studioEdgeProtect", "edgeProtect", Number],
  ["studioSatProtect", "satProtect", Number],
  ["studioBgThreshold", "bgThreshold", Number],
  ["studioGlowWidth", "glowWidth", Number],
];

function syncKnobUi() {
  $("studioOneToOne").checked = knobs.oneToOne;
  for (const [id, key] of KNOB_BINDINGS) $(id).value = String(knobs[key]);
  $("studioSizeDelta").textContent = knobs.sizeDelta.toFixed(2);
  $("studioOffsetDX").textContent = String(knobs.offsetDX);
  $("studioOffsetDY").textContent = String(knobs.offsetDY);
  $("studioColorsLabel").textContent = String(knobs.colors);
}

function attachKnobs() {
  $("studioOneToOne").addEventListener("change", () => {
    knobs.oneToOne = $("studioOneToOne").checked;
    scheduleConvert();
  });
  for (const [id, key, cast] of KNOB_BINDINGS) {
    $(id).addEventListener("input", () => {
      knobs[key] = cast($(id).value);
      if (key === "colors") $("studioColorsLabel").textContent = String(knobs.colors);
      if (key === "bgThreshold" || key === "glowWidth") {
        bgCache = null; // 背景キャッシュ破棄 → グリッド再推定
      }
      scheduleConvert();
    });
  }
  const nudge = (key, delta, labelId, fmt) => {
    knobs[key] = Math.round((knobs[key] + delta) * 100) / 100;
    $(labelId).textContent = fmt ? knobs[key].toFixed(2) : String(knobs[key]);
    scheduleConvert();
  };
  $("studioSizeMinus").addEventListener("click", () => nudge("sizeDelta", -0.25, "studioSizeDelta", true));
  $("studioSizePlus").addEventListener("click", () => nudge("sizeDelta", 0.25, "studioSizeDelta", true));
  $("studioOxMinus").addEventListener("click", () => nudge("offsetDX", -1, "studioOffsetDX"));
  $("studioOxPlus").addEventListener("click", () => nudge("offsetDX", 1, "studioOffsetDX"));
  $("studioOyMinus").addEventListener("click", () => nudge("offsetDY", -1, "studioOffsetDY"));
  $("studioOyPlus").addEventListener("click", () => nudge("offsetDY", 1, "studioOffsetDY"));
  $("studioRegridBtn").addEventListener("click", () => {
    grid = null;
    knobs.sizeDelta = 0; knobs.offsetDX = 0; knobs.offsetDY = 0;
    syncKnobUi();
    scheduleConvert();
  });
  $("studioGalleryBtn").addEventListener("click", generateCandidates);
}

// ---------------------------------------------------------------------------
// 確定（§18.2-7）: プロジェクト化 + メインパレット抽出 + sourceImage/conversionParams 保存
// ---------------------------------------------------------------------------
function confirmStudio() {
  if (!result) {
    toast("変換結果がありません", "error");
    return;
  }
  const res = result;
  const W = Math.max(8, res.width);
  const H = Math.max(8, res.height);
  // 8px未満は中央パディング
  let pixels = res.pixels;
  if (W !== res.width || H !== res.height) {
    pixels = new Uint8Array(W * H);
    const ox = Math.floor((W - res.width) / 2), oy = Math.floor((H - res.height) / 2);
    for (let y = 0; y < res.height; y++)
      for (let x = 0; x < res.width; x++)
        pixels[(oy + y) * W + (ox + x)] = res.pixels[y * res.width + x];
  }
  // sourceImage: 最大512pxに縮小した dataURL（§18.2）
  const scale = Math.min(1, 512 / Math.max(srcData.w, srcData.h));
  const sc = document.createElement("canvas");
  sc.width = Math.max(1, Math.round(srcData.w * scale));
  sc.height = Math.max(1, Math.round(srcData.h * scale));
  const sctx = sc.getContext("2d");
  sctx.drawImage(srcBitmapCanvas, 0, 0, sc.width, sc.height);

  const project = {
    width: W, height: H, fps: 8,
    palette: res.palette,
    frames: [{ pixels }],
    baseFrame: Uint8Array.from(pixels),
    lockedRects: [], variants: [], profile: null, styleRef: null,
    sourceImage: sc.toDataURL("image/png"),
    conversionParams: { ...knobs, grid: { ...grid } },
  };
  project.tags = defaultTags(project);
  // §18.3: メインパレット抽出を自動実行（33色以上のとき）
  if (res.palette.length > 33) {
    project.mainPalette = extractMainPalette(res.palette, res.counts, 32);
  } else {
    project.mainPalette = null;
  }
  store.resetProject(project);
  $("studioPanel").hidden = true;
  toast(`変換を確定しました（${W}×${H}・${res.palette.length - 1}色）。ペン/消しゴム/スポイトでそのまま仕上げられます`);
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------
export async function openStudio(dataUrl, savedParams = null) {
  srcDataUrl = dataUrl;
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  srcBitmapCanvas = c;
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  srcData = { data: imgData.data, w: c.width, h: c.height };
  bgCache = null;
  grid = null;
  result = null;
  knobs = defaultKnobs();
  if (savedParams) {
    Object.assign(knobs, savedParams);
    if (savedParams.grid) grid = { ...savedParams.grid };
  }
  $("studioPanel").hidden = false;
  $("studioGallery").innerHTML = "";
  $("studioGridInfo").textContent = "";
  syncKnobUi();
  fitView();
  if (grid) {
    $("studioGridInfo").textContent = `保存済みグリッド: セル ${grid.s.toFixed(2)}px（再推定で更新可）`;
  }
  await runConvert();
  renderCompare();
}

export function initStudio(storeRef, toastRef) {
  store = storeRef;
  toast = toastRef;
  attachKnobs();
  attachViewControls();
  $("studioConfirmBtn").addEventListener("click", confirmStudio);
  $("studioCancelBtn").addEventListener("click", () => { $("studioPanel").hidden = true; });
  $("studioFitBtn").addEventListener("click", () => { fitView(); renderCompare(); });

  // 元画像から再変換（§18.2）
  $("reconvertBtn").addEventListener("click", () => {
    const p = store.state.project;
    if (!p.sourceImage) {
      toast("このプロジェクトには元画像が保存されていません（変換スタジオ経由で読み込むと保存されます）", "error");
      return;
    }
    openStudio(p.sourceImage, p.conversionParams || null);
  });
}
