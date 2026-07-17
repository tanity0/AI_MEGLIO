// studio.js — §18.2 変換スタジオ（インポートウィザードv2）UI
// 候補ギャラリー → つまみでリアルタイム再変換 → 元画像との同期ズーム比較 → 確定
import { removeBackground, estimateGrid, convertImage, convertSheetImage, convertFramesShared, detectComponents, extractMainPalette, detectExactPixelArt, convertFramesExact } from "./convert.js";
import { hexToRgba, defaultTags } from "./app.js";

// §30: フレーム別に持つつまみ（サイズ・共有パレット以外＝サンプリング/背景除去系）
const PER_FRAME_KEYS = ["bgThreshold", "glowWidth", "domBlend", "centerWeight", "edgeProtect", "satProtect", "offsetDX", "offsetDY"];

let store = null;
let toast = null;

// スタジオ状態
let srcData = null; // {data, w, h} 元画像（フル解像度）
let srcDataUrl = "";
let bgCache = null; // 背景除去済み Uint8ClampedArray
let grid = null; // {s, ox, oy, confidence}
let exactInfo = null; // §59.2: 真ドット絵検出（{ok, block, ox, oy, colors}。bgCache 更新時に再検出）
let result = null; // convertImage の結果
let view = { zoom: 1, panX: 0, panY: 0 };
let convertGen = 0;
let knobs = null;
// §20: マルチポーズ分割
let split = { mode: "single", boxes: [], align: "bottom", gridCols: 3, gridRows: 1 };
// §30: フレーム別つまみの配列（多フレーム時のみ使用）+ アクティブフレーム
let frameParams = []; // [{ ...PER_FRAME_KEYS }]
let activeFrame = 0;
// §44.1: 候補モード — ギャラリー候補の「調整」でスタジオを流用する。
// { onApply(convResult, paramsSnapshot), autoTune()?: Promise<{params,score,defaultScore,evals}> } | null
let candidateMode = null;
let candidateAutoNote = ""; // §43 自動調整の結果表示（変換のたびステータスに併記）

const $ = (id) => document.getElementById(id);

// §30: 現在の分割ボックス（doConvertWith と同じ条件）。多フレームなら配列、単一なら null。
function currentBoxes() {
  if (split.mode !== "single" && split.boxes.length >= 2) {
    const boxes = split.mode === "grid" ? gridBoxes(split.gridCols, split.gridRows) : split.boxes;
    if (boxes.length >= 2) return boxes;
  }
  return null;
}
function isMulti() {
  return currentBoxes() !== null;
}

// アクティブフレームのつまみ（knobs）を frameParams[activeFrame] へ書き戻し
function saveActiveFrameParams() {
  if (!frameParams[activeFrame]) frameParams[activeFrame] = {};
  for (const k of PER_FRAME_KEYS) frameParams[activeFrame][k] = knobs[k];
}
// frameParams をフレーム数に合わせる（不足分は現在の knobs のフレーム別サブセットで埋める）
function ensureFrameParams(n) {
  const base = {};
  for (const k of PER_FRAME_KEYS) base[k] = knobs[k];
  const out = [];
  for (let i = 0; i < n; i++) {
    const src = frameParams[i] || base;
    const pf = {};
    for (const k of PER_FRAME_KEYS) pf[k] = src[k];
    out.push(pf);
  }
  frameParams = out;
  if (activeFrame >= n) activeFrame = 0;
}

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
    // 1:1 モード（targetH=0）用: グリッド位相 + オフセットを1本化した従来互換値
    s: grid.s + knobs.sizeDelta,
    ox: grid.ox + knobs.offsetDX,
    oy: grid.oy + knobs.offsetDY,
    // §49.12: 解像度指定モード（targetH>0）用にオフセット/サイズ±を明示的に渡す
    offsetDX: knobs.offsetDX,
    offsetDY: knobs.offsetDY,
    sizeDelta: knobs.sizeDelta,
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
    exactInfo = detectExactPixelArt(bgCache, srcData.w, srcData.h); // §59.2
    const row = $("studioExactRow");
    if (row) row.hidden = !exactInfo.ok;
    detectSplit(); // §20.1: 連結成分の再検出
  }
  return bgCache;
}

// §20.1: 連結成分検出 → 2体以上なら分割UIを表示
function detectSplit() {
  const comps = detectComponents(bgCache, srcData.w, srcData.h);
  const row = $("studioSplitRow");
  // §44.1: 候補モードは常に1コマとして変換（分割UIは出さない）
  if (candidateMode) {
    split.mode = "single";
    split.boxes = comps;
    row.hidden = true;
    return;
  }
  if (split.mode !== "grid") {
    split.boxes = comps;
    if (comps.length >= 2 && split.mode === "single" && !split.userChose) {
      split.mode = "components"; // 既定はフレームとして変換（§20.1）
    }
    if (comps.length < 2 && split.mode === "components") split.mode = "single";
  }
  row.hidden = !(comps.length >= 2 || split.mode === "grid");
  $("studioSplitCount").textContent = String(comps.length);
  syncSplitUi();
}

function syncSplitUi() {
  const radios = document.querySelectorAll('input[name="studioSplit"]');
  radios.forEach((r) => { r.checked = r.value === split.mode; });
  $("studioAlignCenter").checked = split.align === "center";
  $("studioGridCols").value = String(split.gridCols);
  $("studioGridRows").value = String(split.gridRows);
}

// 手動「横N×縦M均等分割」のbox生成（§20.1）
function gridBoxes(cols, rows) {
  const out = [];
  const cw = srcData.w / cols, ch = srcData.h / rows;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.round(rx * cw), x1 = Math.round((rx + 1) * cw) - 1;
      const y0 = Math.round(ry * ch), y1 = Math.round((ry + 1) * ch) - 1;
      // 各区画内の不透明bboxに詰める（下端アラインを正確に）
      let bx0 = x1 + 1, by0 = y1 + 1, bx1 = -1, by1 = -1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (bgCache[(y * srcData.w + x) * 4 + 3] >= 128) {
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
            if (y < by0) by0 = y; if (y > by1) by1 = y;
          }
        }
      }
      if (bx1 >= 0) out.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, area: 0 });
    }
  }
  return out;
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

// §20: 分割モードに応じて単体/シート変換を実行
function doConvertWith(params) {
  if (split.mode !== "single" && split.boxes.length >= 2) {
    const boxes = split.mode === "grid" ? gridBoxes(split.gridCols, split.gridRows) : split.boxes;
    if (boxes.length >= 2) return convertSheetImage(bgCache, srcData.w, srcData.h, params, boxes, split.align);
  }
  return convertImage(bgCache, srcData.w, srcData.h, params);
}

async function runConvert() {
  const gen = ++convertGen;
  try {
    await ensureGrid();
    if (gen !== convertGen) return;
    $("studioStatus").textContent = "変換中…";
    await new Promise((r) => setTimeout(r, 0));
    const boxes = currentBoxes();
    let res;
    // §59.2: 真ドット絵の無劣化1:1（検出済み＋チェックON）— 推定・減色をバイパス
    if (exactInfo?.ok && $("studioExactChk")?.checked && !$("studioExactRow")?.hidden) {
      let exactBoxes = boxes;
      if (!exactBoxes) {
        // 単体: 不透明bbox 1個
        let x0 = srcData.w, y0 = srcData.h, x1 = -1, y1 = -1;
        for (let y = 0; y < srcData.h; y++) {
          for (let x = 0; x < srcData.w; x++) {
            if (bgCache[(y * srcData.w + x) * 4 + 3] >= 8) {
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) throw new Error("不透明ピクセルがありません");
        exactBoxes = [{ x0, y0, x1, y1 }];
      }
      res = convertFramesExact(bgCache, srcData.w, srcData.h, exactBoxes, split.align, exactInfo);
      if (res.framesPixels && res.framesPixels[activeFrame]) {
        res.pixels = res.framesPixels[activeFrame];
        // §59.7: アクティブフレームの元画像座標に重ねて表示（1コマ目の位置に固定されるズレを修正）
        const org = res.frameOrigins && res.frameOrigins[activeFrame];
        if (org) { res.originX = org.x; res.originY = org.y; }
      }
      result = res;
      const nfx = res.framesPixels.length;
      $("studioStatus").textContent =
        `出力: ${res.width}×${res.height}・${res.palette.length - 1}色（+透明）・無劣化1:1（${exactInfo.block}×ドット絵を検出）` +
        (nfx > 1 ? `・${nfx}フレーム（プレビュー: フレーム${activeFrame + 1}）` : "");
      renderFrameBar();
      renderCompare();
      return;
    }
    if (boxes) {
      // §30: 多フレーム = フレーム別つまみ + 共有パレット（二段構え）
      saveActiveFrameParams();
      ensureFrameParams(boxes.length);
      const global = { targetH: knobs.oneToOne ? 0 : knobs.targetH, colors: knobs.colors, oneToOne: knobs.oneToOne, s: grid.s + knobs.sizeDelta };
      res = convertFramesShared(srcData.data, srcData.w, srcData.h, global, boxes, frameParams, split.align);
      // プレビューはアクティブフレーム
      if (res.framesPixels && res.framesPixels[activeFrame]) {
        res.pixels = res.framesPixels[activeFrame];
        const bb = res.frameBBoxes && res.frameBBoxes[activeFrame];
        if (bb) { res.originX = bb.x0; res.originY = bb.y0; }
      }
    } else {
      res = doConvertWith(knobsToParams());
    }
    if (gen !== convertGen) return;
    result = res;
    const nf = res.framesPixels ? res.framesPixels.length : 1;
    $("studioStatus").textContent =
      `出力: ${res.width}×${res.height}・${res.palette.length - 1}色（+透明）` +
      (nf > 1 ? `・${nf}フレーム（プレビュー: フレーム${activeFrame + 1}）・共有パレット` : "") +
      (candidateAutoNote ? ` ｜ ${candidateAutoNote}` : ""); // §43/§44: 自動調整の結果を併記
    renderFrameBar();
    renderCompare();
  } catch (err) {
    if (gen !== convertGen) return;
    result = null;
    $("studioStatus").textContent = `エラー: ${err.message}`;
    renderFrameBar();
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
  // ソース側（§59.5: 多フレーム時はアクティブフレームの領域だけを切り出して表示。
  // 右の変換結果が単フレーム表示なので、左も同じフレームだけの方が比較しやすい）
  {
    const ctx = sc.getContext("2d");
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.clearRect(0, 0, sc.width, sc.height);
    const boxes = currentBoxes();
    const box = boxes && boxes[activeFrame];
    if (box) {
      const M = 4; // 見切れ防止の余白（元px）
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        (box.x0 - M - view.panX) * zoom,
        (box.y0 - M - view.panY) * zoom,
        (box.x1 - box.x0 + 1 + M * 2) * zoom,
        (box.y1 - box.y0 + 1 + M * 2) * zoom
      );
      ctx.clip();
      ctx.drawImage(srcBitmapCanvas, -view.panX * zoom, -view.panY * zoom, srcData.w * zoom, srcData.h * zoom);
      ctx.restore();
    } else {
      ctx.drawImage(srcBitmapCanvas, -view.panX * zoom, -view.panY * zoom, srcData.w * zoom, srcData.h * zoom);
    }
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

// §49.7-3: 変換スタジオのプレビューに2本指ピンチズーム・1本指ドラッグパンを追加。
// この画面には描画操作が無いため（§31.3の主キャンバスと違い1本指=描画を割り当てる必要がない）
// 1本指ドラッグをそのままパンにできる。既存のホイールズーム/マウスドラッグパン（デスクトップ）は
// そのまま維持しつつ、PointerEvents（mouse+touch+pen統一・§31.3方針踏襲）で1本指パンを
// 実装し直し、2本指（pointerId 2つ）をピンチズームとして追加で扱う。studioSrcCanvas /
// studioResCanvas は view.zoom/panX/panY を共有しているため（「同期ズーム」）、片方への操作が
// 両方に反映される既存挙動・全体表示ボタン(fitView)・§44候補モードのスタジオにもそのまま効く。
function attachViewControls() {
  // pointerId -> {x, y}（screen座標）。2点そろったらピンチ、1点だけならパン。
  const touchPoints = new Map();
  let pinch = null; // {startDist, startZoom, startPanX, startPanY, midX, midY, rect}
  let pan = null; // {x, y, panX, panY}

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function beginPinch(rect) {
    pan = null; // ピンチ開始で単指パンは中断
    const pts = Array.from(touchPoints.values());
    const m = mid(pts[0], pts[1]);
    pinch = {
      startDist: dist(pts[0], pts[1]) || 1,
      startZoom: view.zoom,
      // ピンチ中心（screen座標→現在のview上のsrc座標）を固定点として維持する
      anchorX: view.panX + (m.x - rect.left) / view.zoom,
      anchorY: view.panY + (m.y - rect.top) / view.zoom,
      rect,
    };
  }

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

    c.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "touch") {
        touchPoints.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        c.setPointerCapture?.(ev.pointerId); // 2本目もキャプチャ（画面外に指が出てもピンチを継続）
        if (touchPoints.size === 2) {
          beginPinch(c.getBoundingClientRect());
          return;
        }
        if (touchPoints.size > 2) { pinch = null; pan = null; return; }
        // 1本指: パン開始
      } else if (ev.button !== 0) {
        return; // マウスは主ボタンのみ
      } else {
        c.setPointerCapture?.(ev.pointerId);
      }
      pan = { x: ev.clientX, y: ev.clientY, panX: view.panX, panY: view.panY };
    });

    c.addEventListener("pointermove", (ev) => {
      if (ev.pointerType === "touch" && touchPoints.has(ev.pointerId)) {
        touchPoints.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      }
      if (touchPoints.size === 2 && pinch) {
        const pts = Array.from(touchPoints.values());
        const m = mid(pts[0], pts[1]);
        const d = dist(pts[0], pts[1]) || 1;
        view.zoom = Math.max(0.05, Math.min(40, pinch.startZoom * (d / pinch.startDist)));
        view.panX = pinch.anchorX - (m.x - pinch.rect.left) / view.zoom;
        view.panY = pinch.anchorY - (m.y - pinch.rect.top) / view.zoom;
        renderCompare();
        return;
      }
      if (!pan) return;
      view.panX = pan.panX - (ev.clientX - pan.x) / view.zoom;
      view.panY = pan.panY - (ev.clientY - pan.y) / view.zoom;
      renderCompare();
    });

    function endPointer(ev) {
      if (ev.pointerType === "touch") {
        touchPoints.delete(ev.pointerId);
        if (touchPoints.size < 2) pinch = null;
        if (touchPoints.size === 1) {
          // 2本指→1本指に減った: 残った指の現在位置からパンを再開する
          const remaining = Array.from(touchPoints.values())[0];
          pan = { x: remaining.x, y: remaining.y, panX: view.panX, panY: view.panY };
          return;
        }
      }
      pan = null;
    }
    c.addEventListener("pointerup", endPointer);
    c.addEventListener("pointercancel", endPointer);
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
  // 背景除去が全ピクセルを消していないか事前確認（消えていたら除去なしで自動リトライ）
  let hasOpaque = false;
  for (let i = 3; i < bgCache.length; i += 4) { if (bgCache[i] >= 128) { hasOpaque = true; break; } }
  if (!hasOpaque) {
    knobs.bgThreshold = 0;
    knobs.glowWidth = 0;
    bgCache = null;
    await ensureBg();
    syncKnobUi();
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = "背景除去がすべてのピクセルを消したため、背景除去なし（閾値0）で候補を生成しました。つまみで調整し直せます。";
    gallery.appendChild(note);
  }
  // §44.1: 候補モードは解像度固定 → 3×3 の行はサンプリング（セル中心重視）バリエーションにする
  let rows;
  if (candidateMode) {
    rows = [0.2, 0.5, 0.8].map((cw) => ({ label: `中心${cw}`, props: { centerWeight: cw, oneToOne: false, targetH: knobs.targetH } }));
  } else {
    const oneToOneRows = Math.round((srcData.h / grid.s) * 0.9);
    const resolutions = [];
    if (oneToOneRows <= 128) resolutions.push({ label: "1:1", oneToOne: true, targetH: 0 });
    else resolutions.push({ label: "H96", oneToOne: false, targetH: 96 });
    resolutions.push({ label: "H64", oneToOne: false, targetH: 64 });
    resolutions.push({ label: "H48", oneToOne: false, targetH: 48 });
    rows = resolutions.map((res) => ({ label: res.label, props: { oneToOne: res.oneToOne, targetH: res.targetH || knobs.targetH } }));
  }

  let done = 0;
  for (const row of rows) {
    for (const style of CANDIDATE_STYLES) {
      const candKnobs = { ...knobs, ...style, ...row.props };
      const saveKnobs = knobs;
      knobs = candKnobs;
      const params = knobsToParams();
      knobs = saveKnobs;
      let conv = null;
      let convErr = null;
      try {
        conv = doConvertWith(params);
      } catch (e) {
        convErr = e;
        console.error("候補の変換に失敗:", row.label, style.label, e);
      }
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
        ? `${row.label}（${conv.width}×${conv.height}）・${candKnobs.colors}色・${style.label}`
        : `${row.label}・${style.label}（失敗: ${(convErr && convErr.message ? convErr.message : "不明なエラー").slice(0, 60)}）`;
      cell.appendChild(cv);
      cell.appendChild(label);
      if (conv) {
        cell.addEventListener("click", () => {
          // これをベースにする: 候補のパラメータを全つまみに反映（§18.2-5）
          knobs = { ...knobs, ...style, ...row.props };
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
// §30: フレーム選択バー（多フレーム時のみ）
// ---------------------------------------------------------------------------
function renderFrameBar() {
  const bar = $("studioFrameBar");
  const multi = isMulti() && result && result.framesPixels && result.framesPixels.length > 1;
  bar.hidden = !multi;
  $("studioApplyAllFramesBtn").hidden = !multi;
  if (!multi) return;
  const nf = result.framesPixels.length;
  if (activeFrame >= nf) activeFrame = 0;
  bar.innerHTML = "";
  const label = document.createElement("span");
  label.className = "hint";
  label.textContent = "フレーム:";
  bar.appendChild(label);
  for (let i = 0; i < nf; i++) {
    const cell = document.createElement("button");
    cell.className = "studio-frame-thumb" + (i === activeFrame ? " is-active" : "");
    cell.title = `フレーム${i + 1}`;
    const cv = document.createElement("canvas");
    const tmp = { width: result.width, height: result.height, palette: result.palette, pixels: result.framesPixels[i] };
    const scale = Math.max(1, Math.floor(48 / Math.max(result.width, result.height)));
    cv.width = result.width * scale;
    cv.height = result.height * scale;
    const cctx = cv.getContext("2d");
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(resultToCanvas(tmp), 0, 0, cv.width, cv.height);
    cell.appendChild(cv);
    const num = document.createElement("span");
    num.textContent = String(i + 1);
    cell.appendChild(num);
    cell.addEventListener("click", () => switchFrame(i));
    bar.appendChild(cell);
  }
}

function switchFrame(i) {
  if (i === activeFrame) return;
  saveActiveFrameParams(); // 現在のフレームのつまみを退避
  activeFrame = i;
  // 新フレームのつまみを knobs（アクティブ作業セット）へ読み込み
  const pf = frameParams[i] || {};
  for (const k of PER_FRAME_KEYS) if (pf[k] !== undefined) knobs[k] = pf[k];
  focusActiveFrame(); // §59.5: 切替時にそのフレームへ視点を寄せる
  syncKnobUi();
  scheduleConvert();
}

// §59.5: アクティブフレームの領域をソース側プレビューの中央に持ってくる
function focusActiveFrame() {
  const boxes = currentBoxes();
  const box = boxes && boxes[activeFrame];
  if (!box) return;
  const sc = $("studioSrcCanvas");
  const w = sc.width || 400, h = sc.height || 300;
  view.panX = (box.x0 + box.x1 + 1) / 2 - w / (2 * view.zoom);
  view.panY = (box.y0 + box.y1 + 1) / 2 - h / (2 * view.zoom);
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
  $("studioExactChk").addEventListener("change", scheduleConvert); // §59.2
  for (const [id, key, cast] of KNOB_BINDINGS) {
    $(id).addEventListener("input", () => {
      knobs[key] = cast($(id).value);
      candidateAutoNote = ""; // §43: 手動操作で自動調整の表示を解除
      if (key === "colors") $("studioColorsLabel").textContent = String(knobs.colors);
      // §30: 多フレームでは背景除去はフレーム別に convertFramesShared 内で行うため
      // bgCache/ボックス検出は無効化しない（フレーム分割を安定させる）。単一時は従来どおり。
      if ((key === "bgThreshold" || key === "glowWidth") && !isMulti()) {
        bgCache = null; // 背景キャッシュ破棄 → グリッド再推定
      }
      // §30: 多フレームの per-frame つまみはアクティブフレームへ即時反映
      if (isMulti() && PER_FRAME_KEYS.includes(key) && frameParams[activeFrame]) {
        frameParams[activeFrame][key] = knobs[key];
      }
      scheduleConvert();
    });
  }
  // §49.10: 1タップの刻み幅を推定セルサイズ grid.s に比例させる。
  // grid 未推定（null）の間は従来の固定値（offset=1px / size=0.25px）にフォールバック。
  // 保存値（knobs.offsetDX/DY・sizeDelta）の単位は従来どおり実px。
  const offsetNudgeStep = () => (grid ? Math.max(1, Math.round(grid.s / 4)) : 1);
  const sizeNudgeStep = () => (grid ? Math.max(0.25, Math.round((grid.s * 0.02) / 0.25) * 0.25) : 0.25);
  const nudge = (key, dir, labelId, fmt) => {
    const step = key === "sizeDelta" ? sizeNudgeStep() : offsetNudgeStep();
    knobs[key] = Math.round((knobs[key] + dir * step) * 100) / 100;
    $(labelId).textContent = fmt ? knobs[key].toFixed(2) : String(knobs[key]);
    scheduleConvert();
  };
  $("studioSizeMinus").addEventListener("click", () => nudge("sizeDelta", -1, "studioSizeDelta", true));
  $("studioSizePlus").addEventListener("click", () => nudge("sizeDelta", 1, "studioSizeDelta", true));
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

  // §20: 分割UI
  document.querySelectorAll('input[name="studioSplit"]').forEach((r) => {
    r.addEventListener("change", () => {
      split.mode = r.value;
      split.userChose = true;
      if (split.mode !== "grid") detectSplit();
      scheduleConvert();
    });
  });
  $("studioAlignCenter").addEventListener("change", () => {
    split.align = $("studioAlignCenter").checked ? "center" : "bottom";
    scheduleConvert();
  });
  const gridChange = () => {
    split.gridCols = Math.max(1, Math.min(12, Number($("studioGridCols").value) || 1));
    split.gridRows = Math.max(1, Math.min(12, Number($("studioGridRows").value) || 1));
    if (split.mode === "grid") scheduleConvert();
  };
  $("studioGridCols").addEventListener("input", gridChange);
  $("studioGridRows").addEventListener("input", gridChange);

  // §30: この設定を全フレームに適用（アクティブフレームのフレーム別つまみを全フレームへコピー）
  $("studioApplyAllFramesBtn").addEventListener("click", () => {
    if (!isMulti()) return;
    saveActiveFrameParams();
    const src = frameParams[activeFrame];
    for (let i = 0; i < frameParams.length; i++) {
      const pf = {};
      for (const k of PER_FRAME_KEYS) pf[k] = src[k];
      frameParams[i] = pf;
    }
    toast(`フレーム${activeFrame + 1}の設定を全${frameParams.length}フレームに適用しました`);
    scheduleConvert();
  });
}

// ---------------------------------------------------------------------------
// 確定（§18.2-7）: プロジェクト化 + メインパレット抽出 + sourceImage/conversionParams 保存
// ---------------------------------------------------------------------------
function padPixels(srcPx, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Uint8Array.from(srcPx);
  const out = new Uint8Array(dw * dh);
  const ox = Math.floor((dw - sw) / 2), oy = Math.floor((dh - sh) / 2);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) out[(oy + y) * dw + (ox + x)] = srcPx[y * sw + x];
  return out;
}

function confirmStudio() {
  if (!result) {
    toast("変換結果がありません", "error");
    return;
  }
  // §44.1: 候補モード — プロジェクト化ではなく候補へ反映（スナップ/整列は呼び出し側=motionstudio が行う）
  if (candidateMode) {
    // §46: 開いている間にプロジェクトが差し替わっていたら安全側（何も反映せず閉じる）
    if (candidateMode.epoch !== store.state.projectEpoch) {
      $("studioPanel").hidden = true;
      candidateMode = null;
      candidateAutoNote = "";
      toast("プロジェクトが変わったため候補への反映を中止しました", "error");
      return;
    }
    const params = { ...knobs, ...(grid ? { grid: { ...grid } } : {}) };
    const cb = candidateMode.onApply;
    $("studioPanel").hidden = true;
    candidateMode = null;
    candidateAutoNote = "";
    cb(result, params);
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
  // §40: sourceImage はスタジオに渡された原本の dataURL をそのまま保存
  // （縮小・canvas再エンコードなし＝「再変換」の入力が無劣化）。
  // 12MB を超えるときだけ長辺2048pxへ縮小し、その旨をトースト通知。
  const SOURCE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
  let sourceImage = typeof srcDataUrl === "string" && srcDataUrl.startsWith("data:image/") ? srcDataUrl : "";
  if (!sourceImage || sourceImage.length > SOURCE_IMAGE_MAX_BYTES) {
    const scale = Math.min(1, 2048 / Math.max(srcData.w, srcData.h));
    const sc = document.createElement("canvas");
    sc.width = Math.max(1, Math.round(srcData.w * scale));
    sc.height = Math.max(1, Math.round(srcData.h * scale));
    sc.getContext("2d").drawImage(srcBitmapCanvas, 0, 0, sc.width, sc.height);
    if (sourceImage) toast("元画像が12MBを超えるため、保存用に長辺2048pxへ縮小しました（以降の再変換はこの縮小版が入力になります）");
    sourceImage = sc.toDataURL("image/png");
  }

  // §20.2/§30: 複数フレーム（シート分割）対応
  const allFrames = res.framesPixels && res.framesPixels.length > 1
    ? res.framesPixels.map((px) => ({ pixels: padPixels(px, res.width, res.height, W, H) }))
    : [{ pixels }];
  // §30: 多フレームならアクティブフレームのつまみを退避してからフレーム別配列を保存
  const multi = isMulti() && allFrames.length > 1;
  if (multi) saveActiveFrameParams();
  const project = {
    width: W, height: H, fps: 8,
    palette: res.palette,
    frames: allFrames,
    baseFrame: Uint8Array.from(allFrames[0].pixels),
    lockedRects: [], variants: [], profile: null, styleRef: null,
    sourceImage, // §40: 原本 dataURL（12MB超のみ縮小済み）
    conversionParams: {
      ...knobs,
      grid: { ...grid },
      split: { mode: split.mode, align: split.align, gridCols: split.gridCols, gridRows: split.gridRows, boxes: split.boxes.map((b) => ({ ...b })) },
      // §30: フレーム別つまみの配列（多フレーム時のみ。再変換で復元）
      ...(multi ? { frameParams: frameParams.map((pf) => ({ ...pf })) } : {}),
    },
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
  const nFrames = project.frames.length;
  toast(`変換を確定しました（${W}×${H}・${res.palette.length - 1}色${nFrames > 1 ? `・${nFrames}フレーム` : ""}）。ペン/消しゴム/スポイトでそのまま仕上げられます`);
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------
async function loadSource(dataUrl) {
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
  frameParams = [];
  activeFrame = 0;
}

// §44.1: 候補モードのUI差分（解像度・色数はプロジェクト固定＝無効化・自動調整ボタン表示）
function applyCandidateUi(on) {
  $("studioTargetH").disabled = on;
  $("studioOneToOne").disabled = on;
  $("studioColors").disabled = on;
  $("studioAutoTuneBtn").hidden = !on || !(candidateMode && candidateMode.autoTune);
  $("studioConfirmBtn").textContent = on ? "確定（候補へ反映）" : "確定（プロジェクト化）";
  const h2 = document.querySelector("#studioPanel h2");
  if (h2) h2.textContent = on ? "候補の調整（変換スタジオ）" : "変換スタジオ（ドット絵風 → 本物ドット絵）";
}

export async function openStudio(dataUrl, savedParams = null, opts = {}) {
  candidateMode = null; // §44.1: 通常モードへ復帰
  candidateAutoNote = "";
  await loadSource(dataUrl);
  split = { mode: "single", boxes: [], align: "bottom", gridCols: 3, gridRows: 1, userChose: false };
  knobs = defaultKnobs();
  if (savedParams) {
    const { grid: g, split: sp, frameParams: fp, ...rest } = savedParams;
    Object.assign(knobs, rest);
    if (g) grid = { ...g };
    if (sp) {
      split = { ...split, ...sp, boxes: Array.isArray(sp.boxes) ? sp.boxes : [], userChose: true };
    }
    // §30: フレーム別つまみの復元。アクティブフレームの値は作業セット knobs にも反映。
    if (Array.isArray(fp) && fp.length) {
      frameParams = fp.map((pf) => {
        const o = {};
        for (const k of PER_FRAME_KEYS) o[k] = (pf && typeof pf[k] === "number") ? pf[k] : knobs[k];
        return o;
      });
      // §47.2: 「再変換」ではタイムラインで選択中のフレームのタブを初期アクティブにする。
      // フレーム→シートコマの対応は conversionParams.split の boxes 順（=取り込み順=
      // frameParams 順）。範囲外（後から追加されたフレーム等・対応が取れない）は先頭。
      const want = Number.isInteger(opts.initialFrame) ? opts.initialFrame : 0;
      activeFrame = want > 0 && want < frameParams.length ? want : 0;
      for (const k of PER_FRAME_KEYS) if (frameParams[activeFrame][k] !== undefined) knobs[k] = frameParams[activeFrame][k];
    }
  }
  $("studioPanel").hidden = false;
  $("studioGallery").innerHTML = "";
  $("studioGridInfo").textContent = "";
  applyCandidateUi(false);
  syncKnobUi();
  fitView();
  if (grid) {
    $("studioGridInfo").textContent = `保存済みグリッド: セル ${grid.s.toFixed(2)}px（再推定で更新可）`;
  }
  await runConvert();
  renderCompare();
}

// §44.1: 候補モードで開く — 入力 = cand.srcRegion（原寸）、初期つまみ = cand.convParams。
// 解像度=プロジェクト高さ固定・色数=プロジェクトパレット数（確定時に呼び出し側でスナップ）。
// opts = { convParams, autoTune()?: Promise, onApply(convResult, paramsSnapshot) }
export async function openStudioForCandidate(dataUrl, opts) {
  // §46: 開いた時点の世代を記録（差し替え後の確定を無効化するため）
  candidateMode = { onApply: opts.onApply, autoTune: opts.autoTune || null, epoch: store.state.projectEpoch };
  candidateAutoNote = "";
  await loadSource(dataUrl);
  const p = store.state.project;
  split = { mode: "single", boxes: [], align: "bottom", gridCols: 3, gridRows: 1, userChose: true };
  knobs = defaultKnobs();
  knobs.oneToOne = false;
  knobs.targetH = p.height; // 解像度はプロジェクト固定（§44.1）
  knobs.colors = Math.min(64, Math.max(2, p.palette.length - 1)); // §25.6 の変換フェーズと同じ色数
  const cp = opts.convParams || {};
  for (const k of ["bgThreshold", "glowWidth", "edgeProtect", "satProtect", "domBlend", "centerWeight", "sizeDelta", "offsetDX", "offsetDY"]) {
    if (typeof cp[k] === "number") knobs[k] = cp[k];
  }
  if (cp.grid && typeof cp.grid.s === "number") grid = { ...cp.grid };
  $("studioPanel").hidden = false;
  $("studioGallery").innerHTML = "";
  $("studioGridInfo").textContent = "";
  $("studioSplitRow").hidden = true;
  applyCandidateUi(true);
  syncKnobUi();
  fitView();
  await runConvert();
  renderCompare();
}

// §46: 候補モードのスタジオが開いたままプロジェクトが差し替わったときに
// 呼び出し側（motionstudio）から安全に閉じる。通常モードのスタジオには触れない。
export function cancelCandidateStudio() {
  if (!candidateMode) return false;
  $("studioPanel").hidden = true;
  candidateMode = null;
  candidateAutoNote = "";
  return true;
}

// §49.7-3: テスト/デバッグ用の読み取り専用アクセサ（view.zoom/panX/panYの数値検証に使う）。
export function getStudioView() {
  return { zoom: view.zoom, panX: view.panX, panY: view.panY };
}

export function initStudio(storeRef, toastRef) {
  store = storeRef;
  toast = toastRef;
  attachKnobs();
  attachViewControls();
  $("studioConfirmBtn").addEventListener("click", confirmStudio);
  $("studioCancelBtn").addEventListener("click", () => {
    $("studioPanel").hidden = true;
    candidateMode = null; // §44.1: キャンセルで候補へは何も反映しない
    candidateAutoNote = "";
  });
  $("studioFitBtn").addEventListener("click", () => { fitView(); renderCompare(); });

  // §43/§44: 自動調整（候補モードのみ表示）— 探索の最良値をスタジオつまみへセット
  $("studioAutoTuneBtn").addEventListener("click", async () => {
    if (!candidateMode || !candidateMode.autoTune) return;
    const btn = $("studioAutoTuneBtn");
    btn.disabled = true;
    $("studioStatus").textContent = "自動調整中…（最大40変換）";
    try {
      const res = await candidateMode.autoTune();
      if (!candidateMode) return; // 探索中に閉じられた
      if (!res || res.score === Infinity) {
        $("studioStatus").textContent = "自動調整: 有効なパラメータが見つかりませんでした";
        return;
      }
      knobs.bgThreshold = res.params.bgThreshold;
      knobs.glowWidth = res.params.glowWidth;
      knobs.edgeProtect = res.params.edgeProtect;
      knobs.satProtect = res.params.satProtect;
      bgCache = null; // 背景つまみが変わったので再除去
      candidateAutoNote = `自動調整: スコア ${res.defaultScore.toFixed(3)} → ${res.score.toFixed(3)}（低いほど元絵に近い・${res.evals}回変換）`;
      syncKnobUi();
      scheduleConvert();
    } catch (err) {
      if (candidateMode) $("studioStatus").textContent = `自動調整に失敗: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // 元画像から再変換（§18.2）
  $("reconvertBtn").addEventListener("click", () => {
    const p = store.state.project;
    if (!p.sourceImage) {
      toast("このプロジェクトには元画像が保存されていません（変換スタジオ経由で読み込むと保存されます）", "error");
      return;
    }
    // §47.2: 現在選択中のフレームに対応するコマのタブを初期アクティブで開く
    openStudio(p.sourceImage, p.conversionParams || null, { initialFrame: store.state.currentFrame });
  });

  // E2E テスト用フック（UIには影響しない）
  window.aiMeglioStudio = {
    debug: () => ({
      isMulti: isMulti(),
      activeFrame,
      candidateMode: !!candidateMode, // §44.1
      knobs: { ...knobs },
      grid: grid ? { ...grid } : null, // §49.10: 推定セルサイズ（nudge刻み幅の検証用）
      srcW: srcData ? srcData.w : 0, // §40: 再変換入力の解像度検証用
      srcH: srcData ? srcData.h : 0,
      frameCount: result && result.framesPixels ? result.framesPixels.length : (result ? 1 : 0),
      frameParams: frameParams.map((pf) => ({ ...pf })),
      palette: result ? result.palette.slice() : null,
      width: result ? result.width : 0,
      height: result ? result.height : 0,
      framesPixels: result && result.framesPixels ? result.framesPixels.map((px) => Array.from(px)) : (result ? [Array.from(result.pixels)] : []),
    }),
    switchFrame: (i) => switchFrame(i),
  };
}
