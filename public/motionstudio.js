// motionstudio.js — §25/§42 モーション候補スタジオ（プール＋選択順＝フレーム順）
// 画像取り込み・N×K 生成（mode:"motionframe"）・反転コピー・部位合成のすべてを
// 1つのプールに並べ、クリック選択の順番がそのままフレーム順。確定で選択順にタイムラインへ。
import { streamEdit } from "./api.js";
import { removeBackground, detectComponents, convertImage } from "./convert.js";
import {
  frameToGridString,
  pixelsToGridString,
  pixelsToPngDataUrl,
  drawFrameToContext,
  styleRequestFields,
  cellChars,
  splitTokens,
  indexForToken,
  addGeneratedTag,
  hexToRgba,
  maybeOpenServerFolder,
} from "./app.js";

const PRESET_LABELS = { walk: "歩き", run: "走り", attack: "攻撃", idle: "待機", jump: "ジャンプ", custom: "カスタム" };

// §25.7-2: セル差分を8近傍の連結成分（塊）に分割し、少数セルの飛び地は近接統合する。
// 純関数（数値検証用に export）。戻り値: [{ cells:[index...], count, bbox:{x0,y0,x1,y1} }...]（セル数降順）
export function diffBlobs(ref, cand, width, height, opts = {}) {
  const minCells = opts.minCells ?? 8;   // これ未満の塊は「飛び地」候補
  const mergeDist = opts.mergeDist ?? 6; // bbox間チェビシェフ距離がこれ以内なら近接統合
  const labels = new Int32Array(width * height).fill(-1);
  let blobs = [];
  for (let start = 0; start < width * height; start++) {
    if (labels[start] !== -1 || ref[start] === cand[start]) continue;
    const cells = [];
    const stack = [start];
    labels[start] = blobs.length;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width, y = (idx / width) | 0;
      cells.push(idx);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (labels[ni] === -1 && ref[ni] !== cand[ni]) {
            labels[ni] = labels[idx];
            stack.push(ni);
          }
        }
      }
    }
    blobs.push({ cells, count: cells.length, bbox: { x0, y0, x1, y1 } });
  }
  // 近接統合: 小塊を、bbox距離 mergeDist 以内で最も大きい他の塊へ吸収
  const gap = (a, b) => Math.max(
    Math.max(a.bbox.x0 - b.bbox.x1, b.bbox.x0 - a.bbox.x1, 0),
    Math.max(a.bbox.y0 - b.bbox.y1, b.bbox.y0 - a.bbox.y1, 0),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blobs.length; i++) {
      if (blobs[i].count >= minCells) continue;
      let best = -1, bestCount = -1;
      for (let j = 0; j < blobs.length; j++) {
        if (j === i || blobs[j].count <= blobs[i].count) continue;
        if (gap(blobs[i], blobs[j]) <= mergeDist && blobs[j].count > bestCount) {
          best = j; bestCount = blobs[j].count;
        }
      }
      if (best >= 0) {
        const a = blobs[best], b = blobs[i];
        a.cells = a.cells.concat(b.cells);
        a.count = a.cells.length;
        a.bbox = {
          x0: Math.min(a.bbox.x0, b.bbox.x0), y0: Math.min(a.bbox.y0, b.bbox.y0),
          x1: Math.max(a.bbox.x1, b.bbox.x1), y1: Math.max(a.bbox.y1, b.bbox.y1),
        };
        blobs.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  blobs.sort((a, b) => b.count - a.count);
  return blobs;
}

export function initMotionStudio(store, toast) {
  const modal = document.getElementById("mcModal");
  const grid = document.getElementById("mcGrid");
  const progress = document.getElementById("mcProgress");
  const previewCanvas = document.getElementById("mcPreviewCanvas");
  const abortBtn = document.getElementById("mcAbortBtn");
  const confirmBtn = document.getElementById("mcConfirmBtn");
  const closeBtn = document.getElementById("mcCloseBtn");
  const confirmedBar = document.getElementById("mcConfirmedBar");
  const generateBtn = document.getElementById("mcGenerateBtn");
  const candCount = document.getElementById("mcCandCount");
  const imageBtn = document.getElementById("mcImageBtn");
  const imageInput = document.getElementById("mcImageInput");
  const mirrorBtn = document.getElementById("mcMirrorBtn");
  const kitBtn = document.getElementById("mcKitBtn");
  const inboxBadge = document.getElementById("mcInboxBadge");
  const mergePanel = document.getElementById("mcMergePanel");
  const mergeTitle = document.getElementById("mcMergeTitle");
  const mergeChips = document.getElementById("mcMergeChips");
  const mergeCanvas = document.getElementById("mcMergeCanvas");
  const mergeParts = document.getElementById("mcMergeParts");
  const mergeApplyBtn = document.getElementById("mcMergeApply");
  const mergeCancelBtn = document.getElementById("mcMergeCancel");
  const mergeRefSelect = document.getElementById("mcMergeRef"); // §42: 比較先ドロップダウン
  const selCount = document.getElementById("mcSelCount"); // §42: 選択数（=フレーム数）表示
  const motionPreset = document.getElementById("motionPreset");
  const motionCustomText = document.getElementById("motionCustomText");
  const motionFrames = document.getElementById("motionFrames");
  // §41: 候補ごとの変換調整パネル
  const adjustPanel = document.getElementById("mcAdjustPanel");
  const adjustTitle = document.getElementById("mcAdjustTitle");
  const adjustCanvas = document.getElementById("mcAdjustCanvas");
  const adjustBg = document.getElementById("mcAdjustBg");
  const adjustGlow = document.getElementById("mcAdjustGlow");
  const adjustEdge = document.getElementById("mcAdjustEdge");
  const adjustSat = document.getElementById("mcAdjustSat");
  const adjustCell = document.getElementById("mcAdjustCell");
  const adjustStatus = document.getElementById("mcAdjustStatus");
  const adjustApplyBtn = document.getElementById("mcAdjustApplyBtn");
  const adjustCancelBtn = document.getElementById("mcAdjustCancelBtn");

  function project() { return store.state.project; }

  // セッション状態（モーダルを閉じるまで保持）— §42 プールモデル
  // pool = [{ id, status: "pending"|"ok"|"error", pixels?, error?, variant,
  //           source: "grid"|"image"|"mirror"|"merge", snapped?/aligned?（§25.6）,
  //           phase?/phaseTotal?（グリッド生成の位相ヒント・生成パラメータとして維持）,
  //           srcRegion?/convParams?/offset?/autoOffset?（§41） }...]
  // selected = 選択順の候補参照の配列（この順番がそのままフレーム順。§42.1）
  // genTotal/k = 「候補を生成」用パラメータ（フレーム数はプールの選択数で決まる）
  let session = null;
  let abortController = null;
  let inflight = 0;
  let doneCount = 0;
  let totalCount = 0;
  let startedAt = 0;
  let tickTimer = null;
  let previewTimer = null;
  let previewIdx = 0;

  // ---------------------------------------------------------------------
  // 共通
  // ---------------------------------------------------------------------
  function baseRequestFields() {
    const p = project();
    const fields = {
      project: {
        width: p.width,
        height: p.height,
        fps: p.fps,
        palette: p.palette,
        framesGrid: p.frames.map((_, i) => frameToGridString(p, i)),
      },
      lockedRects: (p.lockedRects || []).map((r) => ({ ...r })),
    };
    if (p.baseFrame) fields.baseFrameGrid = pixelsToGridString(p.baseFrame, p.width, p.height, p.palette.length);
    Object.assign(fields, styleRequestFields(p, store.state.serverConfig));
    if (p.mainPalette) fields.mainPalette = p.mainPalette;
    return fields;
  }

  function pixelsFromRows(rows) {
    const p = project();
    const cw = cellChars(p.palette.length);
    const wide = cw === 2;
    const pixels = new Uint8Array(p.width * p.height);
    for (let y = 0; y < Math.min(rows.length, p.height); y++) {
      const tokens = splitTokens(rows[y], cw) || [];
      for (let x = 0; x < Math.min(tokens.length, p.width); x++) {
        const idx = indexForToken(tokens[x], wide);
        pixels[y * p.width + x] = idx >= 0 && idx < p.palette.length ? idx : 0;
      }
    }
    return pixels;
  }

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function renderProgress() {
    if (!session) return;
    if (inflight > 0) {
      progress.textContent = `生成中… ${doneCount}/${totalCount}（経過 ${fmtElapsed(Date.now() - startedAt)}）`;
    }
  }
  function setIdleProgress() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    abortBtn.disabled = true;
    progress.textContent = session
      ? `候補をクリックで選択（選択 ${session.selected.length}件＝フレーム数・選択順がフレーム順）`
      : "";
  }
  function beginBatch(n) {
    if (inflight === 0) {
      doneCount = 0;
      totalCount = 0;
      startedAt = Date.now();
      if (!tickTimer) tickTimer = setInterval(renderProgress, 1000);
      abortBtn.disabled = false;
      if (!abortController) abortController = new AbortController();
    }
    inflight += n;
    totalCount += n;
    renderProgress();
  }
  function endOne() {
    doneCount++;
    inflight--;
    renderProgress();
    if (inflight <= 0) {
      inflight = 0;
      setIdleProgress();
      abortController = null;
    }
  }

  // ---------------------------------------------------------------------
  // 生成（1スロット）— §42: 位相ヒント（phase/phaseTotal）は候補自身が生成パラメータとして保持
  // ---------------------------------------------------------------------
  async function runOne(cand, opts = {}) {
    const p = project();
    const s = session;
    const phase = cand.phase ?? 0;
    const phaseTotal = cand.phaseTotal ?? Math.max(1, s.genTotal || 1);
    cand.status = "pending";
    cand.error = null;
    renderCell(cand);
    const mf = {
      preset: s.preset,
      index: phase,
      total: phaseTotal,
      variant: cand.variant ?? 0,
    };
    if (s.customText) mf.customText = s.customText;
    if (opts.instruction) mf.instruction = opts.instruction;
    // §25.2: 描き直し時は選択列の前後（この候補が選択済みの場合）を連続性の文脈として同梱
    if (opts.withNeighbors) {
      const si = s.selected.indexOf(cand);
      const prev = si > 0 ? s.selected[si - 1] : null;
      const next = si >= 0 && si < s.selected.length - 1 ? s.selected[si + 1] : null;
      if (prev) mf.prevFrameGrid = pixelsToGridString(prev.pixels, p.width, p.height, p.palette.length);
      if (next) mf.nextFrameGrid = pixelsToGridString(next.pixels, p.width, p.height, p.palette.length);
    }
    const body = {
      ...baseRequestFields(),
      mode: "motionframe",
      scope: "all",
      motionframe: mf,
      instruction: `「${s.presetLabel}」モーションの第${phase + 1}/${phaseTotal}フレーム候補を生成`,
      images: p.baseFrame
        ? [{ frame: 0, dataUrl: pixelsToPngDataUrl(p.baseFrame, p.width, p.height, p.palette, p.width > 64 ? 4 : 8) }]
        : [],
    };
    beginBatch(1);
    try {
      const evt = await streamEdit(body, { signal: abortController.signal });
      const nf = evt.patch?.newFrames?.[0];
      if (!nf) throw new Error("フレームが返されませんでした");
      cand.status = "ok";
      cand.pixels = pixelsFromRows(nf.rows);
      if (evt.patch.warnings?.length) cand.warn = evt.patch.warnings.join(" / ");
    } catch (err) {
      cand.status = "error";
      cand.error = err.name === "AbortError" ? "中断しました" : err.message;
    } finally {
      endOne();
      renderCell(cand);
    }
  }

  // ---------------------------------------------------------------------
  // ギャラリー描画
  // ---------------------------------------------------------------------
  function cellScale() {
    const p = project();
    return Math.max(1, Math.floor(120 / Math.max(p.width, p.height)));
  }
  function drawCand(canvas, pixels, cand = null) {
    const p = project();
    const sc = cellScale();
    canvas.width = p.width * sc;
    canvas.height = p.height * sc;
    const ctx = canvas.getContext("2d");
    const tmp = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels }] };
    drawFrameToContext(ctx, tmp, 0, sc);
    // §25.6-2: 整列プレビュー（ベースとの半透明重ね）
    if (cand && cand.overlayBase && p.baseFrame) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      const tb = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels: p.baseFrame }] };
      const off = document.createElement("canvas");
      off.width = p.width * sc; off.height = p.height * sc;
      drawFrameToContext(off.getContext("2d"), tb, 0, sc);
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------
  // §25.6: 画像からの候補追加（パレットスナップ・位置合わせ・ミラー補完）
  // ---------------------------------------------------------------------
  function nearestPaletteIndex(rgbCache, r, g, b) {
    let best = 1, bd = Infinity;
    for (let i = 1; i < rgbCache.length; i++) {
      const c = rgbCache[i];
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // 変換結果（独自パレット）をプロジェクトパレットへスナップし、
  // フルキャンバスへ配置して足元・重心で整列した Uint8Array を返す
  function snapAndAlign(conv) {
    const p = project();
    const rgb = p.palette.map((hex) => hexToRgba(hex));
    // conv.palette[i] → プロジェクトindex の対応表
    const map = conv.palette.map((hex, i) => {
      if (i === 0) return 0;
      const [r, g, b] = hexToRgba(hex);
      return nearestPaletteIndex(rgb, r, g, b);
    });
    const full = new Uint8Array(p.width * p.height);
    // まず中央/下寄せで仮配置
    const ox0 = Math.floor((p.width - conv.width) / 2);
    const oy0 = p.height - conv.height;
    for (let y = 0; y < conv.height; y++) {
      for (let x = 0; x < conv.width; x++) {
        const v = conv.pixels[y * conv.width + x];
        if (v === 0) continue;
        const tx = ox0 + x, ty = oy0 + y;
        if (tx < 0 || ty < 0 || tx >= p.width || ty >= p.height) continue;
        full[ty * p.width + tx] = map[v];
      }
    }
    // §25.6-2: (a) 足元基準（最下段の非透明行を一致）(b) 水平は重心一致
    // §25.9-1: シフト済みピクセルではなく「元配置+オフセット」を返す（ナッジをロスレスにするため）
    const stats = (pixels) => {
      let bottom = -1, sumX = 0, n = 0;
      for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
        if (pixels[y * p.width + x] !== 0) {
          if (y > bottom) bottom = y;
          sumX += x; n++;
        }
      }
      return { bottom, cx: n ? sumX / n : 0, n };
    };
    const base = p.baseFrame || p.frames[0].pixels;
    const sb = stats(base);
    const sc = stats(full);
    const offset = sc.n === 0 ? { dx: 0, dy: 0 } : { dx: Math.round(sb.cx - sc.cx), dy: sb.bottom - sc.bottom };
    return { srcPixels: full, offset };
  }

  // §25.9-1: 画像候補のオフセットを元配置（srcPixels）から適用し直す（ナッジがロスレスになる）
  function applyOffset(cand) {
    cand.pixels = shiftPixels(cand.srcPixels, cand.offset.dx, cand.offset.dy);
  }

  function shiftPixels(pixels, dx, dy) {
    const p = project();
    const out = new Uint8Array(p.width * p.height);
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const v = pixels[y * p.width + x];
        if (v === 0) continue;
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= p.width || ty >= p.height) continue;
        out[ty * p.width + tx] = v;
      }
    }
    return out;
  }

  function flipPixelsH(pixels) {
    const p = project();
    const out = new Uint8Array(p.width * p.height);
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) out[y * p.width + (p.width - 1 - x)] = pixels[y * p.width + x];
    }
    return out;
  }

  async function fileToImageData(file) {
    const bmp = await createImageBitmap(file);
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  }

  // ---------------------------------------------------------------------
  // §41: ギャラリー候補の変換調整（取り込み後のつまみ）
  // srcRegion（元画像の該当コマ領域・原寸・背景除去前）を保持しておき、
  // つまみ変更のたびそこから再変換 → プロジェクトパレットへスナップ → 整列。
  // ---------------------------------------------------------------------
  function defaultConvParams() {
    return { bgThreshold: 48, glowWidth: 0, edgeProtect: 0.3, satProtect: 0.5, cellDelta: 0 };
  }

  function rgbaCropToDataUrl(data, w, h) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    return cv.toDataURL("image/png");
  }

  async function dataUrlToImageData(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  }

  // srcRegion から params（bgThreshold/glowWidth/edgeProtect/satProtect/cellDelta）で再変換し、
  // §25.6 と同じパイプラインでプロジェクトパレットへスナップ・整列した { srcPixels, offset } を返す
  async function reconvertFromRegion(srcRegionUrl, params) {
    const p = project();
    const region = await dataUrlToImageData(srcRegionUrl);
    const bg = removeBackground(region.data, region.width, region.height, {
      threshold: params.bgThreshold, glowWidth: params.glowWidth,
    });
    const targetH = Math.max(2, p.height + (params.cellDelta || 0));
    const conv = convertImage(bg, region.width, region.height, {
      targetH,
      colors: Math.min(64, Math.max(2, p.palette.length - 1)),
      edgeProtect: params.edgeProtect,
      satProtect: params.satProtect,
    });
    return snapAndAlign(conv);
  }

  async function addImageCandidates(file, opts = {}) {
    // opts.auto: 受信箱の自動取り込み（§25.8）— プレビューなしで全コマ取り込み
    const p = project();
    if (!session) return 0;
    let img;
    try {
      img = await fileToImageData(file);
    } catch {
      toast("画像を読み込めませんでした", "error");
      return 0;
    }
    const data = removeBackground(img.data, img.width, img.height);
    const comps = detectComponents(data, img.width, img.height);
    if (!comps.length) {
      toast("キャラクターを検出できませんでした（背景除去に失敗）", "error");
      return 0;
    }
    // 変換フェーズ: セッションにはまだ入れず、コマごとの変換結果を組み立てる（§42: 全コマがプール行き）
    const prepared = [];
    for (let k = 0; k < comps.length; k++) {
      const box = comps[k];
      // コマを切り出して §18 変換（プロジェクト高さ指定）→ パレットスナップ → 整列
      const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
      const crop = new Uint8ClampedArray(bw * bh * 4);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const si = ((box.y0 + y) * img.width + (box.x0 + x)) * 4;
          const di = (y * bw + x) * 4;
          crop[di] = data[si]; crop[di + 1] = data[si + 1]; crop[di + 2] = data[si + 2]; crop[di + 3] = data[si + 3];
        }
      }
      let conv;
      try {
        conv = convertImage(crop, bw, bh, { targetH: p.height, colors: Math.min(64, Math.max(2, p.palette.length - 1)) });
      } catch (err) {
        toast(`コマ${k + 1}の変換に失敗: ${err.message}`, "error");
        continue;
      }
      const { srcPixels, offset } = snapAndAlign(conv);
      // §41-1: 元画像の該当コマ領域（原寸クロップ・背景除去前）を保持 — 「調整」での再変換の入力源。
      // 周囲に PAD px の余白を含めて切り出す（背景除去のフラッドフィルが機能する範囲を確保）。
      const PAD = 8;
      const rx0 = Math.max(0, box.x0 - PAD), ry0 = Math.max(0, box.y0 - PAD);
      const rx1 = Math.min(img.width - 1, box.x1 + PAD), ry1 = Math.min(img.height - 1, box.y1 + PAD);
      const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
      const rawCrop = new Uint8ClampedArray(rw * rh * 4);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const si = ((ry0 + y) * img.width + (rx0 + x)) * 4;
          const di = (y * rw + x) * 4;
          rawCrop[di] = img.data[si]; rawCrop[di + 1] = img.data[si + 1]; rawCrop[di + 2] = img.data[si + 2]; rawCrop[di + 3] = img.data[si + 3];
        }
      }
      const cand = {
        source: "image", snapped: true, aligned: true, srcPixels,
        offset: { ...offset }, autoOffset: { ...offset }, // autoOffset: ナッジ適用前の整列オフセット（再調整時の差分計算用）
        srcRegion: rgbaCropToDataUrl(rawCrop, rw, rh),
        convParams: defaultConvParams(),
      };
      applyOffset(cand); // §25.9-1: pixels = srcPixels + offset（ナッジで再適用）
      prepared.push({ k, cand });
    }
    if (!prepared.length) {
      if (!opts.quiet) toast("候補を追加できませんでした", "error");
      return 0;
    }
    // §39-4: 取り込みプレビュー（拾わないコマをチェックで外す）。
    // gpt-exchange の in/ 自動取り込み（opts.auto）は従来どおり全取り込み（自動性優先）。
    let picked = prepared;
    if (!opts.auto) {
      picked = await showImportPreview(prepared);
      if (picked === null) {
        if (!opts.quiet) toast("取り込みをキャンセルしました");
        return 0;
      }
      if (!picked.length) {
        if (!opts.quiet) toast("取り込むコマが選ばれていません", "error");
        return 0;
      }
    }
    // §42.1: 選択が0件なら取り込んだコマを取り込み順に自動選択（1..M）。既に選択があれば未選択で追加。
    const autoSelect = session.selected.length === 0;
    let added = 0;
    for (const item of picked) {
      const cand = { ...item.cand, id: session.nextId++, status: "ok" };
      session.pool.push(cand);
      if (autoSelect) session.selected.push(cand);
      added++;
    }
    renderPool();
    if (inflight === 0) setIdleProgress();
    if (!opts.quiet) {
      toast(added
        ? `画像から${added}個の候補をプールに追加しました${autoSelect ? `（取り込み順に自動選択 1〜${added}）` : "（未選択）"}`
        : "候補を追加できませんでした", added ? "info" : "error");
    }
    return added;
  }

  // ---------------------------------------------------------------------
  // §39-4: 取り込みプレビュー — サムネイル+チェックボックス（既定=全チェック）。
  // 「取り込む(N)」で選択分を返し、「キャンセル」で null。単一コマ画像でも同UI。
  // ---------------------------------------------------------------------
  const importPreviewPanel = document.getElementById("mcImportPreview");
  const importPreviewGrid = document.getElementById("mcImportGrid");
  const importOkBtn = document.getElementById("mcImportOkBtn");
  const importCancelBtn = document.getElementById("mcImportCancelBtn");
  const importBgInput = document.getElementById("mcImportBg");
  const importGlowInput = document.getElementById("mcImportGlow");
  const importReconvertBtn = document.getElementById("mcImportReconvertBtn");
  let importPreviewAbort = null; // モーダルを閉じたとき保留中のプレビューをキャンセル解決する

  function showImportPreview(prepared) {
    const p = project();
    return new Promise((resolve) => {
      importPreviewGrid.innerHTML = "";
      const checks = [];
      const thumbs = [];
      function renderThumb(idx) {
        thumbs[idx].src = pixelsToPngDataUrl(prepared[idx].cand.pixels, p.width, p.height, p.palette, 4);
      }
      for (const item of prepared) {
        const cell = document.createElement("label");
        cell.className = "mc-import-cell";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = true; // 既定=全チェック
        const img = document.createElement("img");
        img.src = pixelsToPngDataUrl(item.cand.pixels, p.width, p.height, p.palette, 4);
        img.alt = `コマ${item.k + 1}`;
        thumbs.push(img);
        const cap = document.createElement("span");
        cap.textContent = `コマ${item.k + 1}`;
        cell.append(chk, img, cap);
        importPreviewGrid.appendChild(cell);
        checks.push(chk);
        chk.addEventListener("change", updateCount);
      }
      function updateCount() {
        importOkBtn.textContent = `取り込む(${checks.filter((c) => c.checked).length})`;
      }
      updateCount();
      // §41-3: 取り込みプレビューの簡易つまみ（全コマ共通の背景除去閾値/フチ光彩）で変換し直す。
      // 個別の詰めは取り込み後の候補ごとの「調整」で行う（二段構え）。
      const firstParams = prepared[0]?.cand.convParams || defaultConvParams();
      importBgInput.value = String(firstParams.bgThreshold);
      importGlowInput.value = String(firstParams.glowWidth);
      async function onReconvert() {
        const bgThreshold = Number(importBgInput.value);
        const glowWidth = Number(importGlowInput.value);
        importReconvertBtn.disabled = true;
        const origLabel = importReconvertBtn.textContent;
        importReconvertBtn.textContent = "変換中…";
        for (let idx = 0; idx < prepared.length; idx++) {
          const item = prepared[idx];
          if (!item.cand.srcRegion) continue;
          try {
            const params = { ...(item.cand.convParams || defaultConvParams()), bgThreshold, glowWidth };
            const { srcPixels, offset: autoOffset } = await reconvertFromRegion(item.cand.srcRegion, params);
            const nudgeDx = item.cand.offset.dx - item.cand.autoOffset.dx;
            const nudgeDy = item.cand.offset.dy - item.cand.autoOffset.dy;
            const offset = { dx: autoOffset.dx + nudgeDx, dy: autoOffset.dy + nudgeDy };
            item.cand.srcPixels = srcPixels;
            item.cand.autoOffset = autoOffset;
            item.cand.offset = offset;
            item.cand.pixels = shiftPixels(srcPixels, offset.dx, offset.dy);
            item.cand.convParams = params;
            renderThumb(idx);
          } catch (err) {
            toast(`コマ${item.k + 1}の再変換に失敗: ${err.message}`, "error");
          }
        }
        importReconvertBtn.disabled = false;
        importReconvertBtn.textContent = origLabel;
      }
      function cleanup() {
        importPreviewPanel.hidden = true;
        importPreviewAbort = null;
        importOkBtn.removeEventListener("click", onOk);
        importCancelBtn.removeEventListener("click", onCancel);
        importReconvertBtn.removeEventListener("click", onReconvert);
      }
      function onOk() {
        const picked = prepared.filter((_, idx) => checks[idx].checked);
        cleanup();
        resolve(picked);
      }
      function onCancel() {
        cleanup();
        resolve(null);
      }
      importOkBtn.addEventListener("click", onOk);
      importCancelBtn.addEventListener("click", onCancel);
      importReconvertBtn.addEventListener("click", onReconvert);
      importPreviewAbort = onCancel;
      importPreviewPanel.hidden = false;
    });
  }

  // ---------------------------------------------------------------------
  // §25.7: 差分採用マージ — 候補の変化を塊ごとに選んで取り込む
  // ---------------------------------------------------------------------
  const MERGE_HUES = [200, 30, 300, 120, 0, 60, 260, 170];
  let merge = null; // { cand, ref, refLabel, blobs, diffMap, adopted:Set, mask:Uint8Array, rectDrag }
  let adjust = null; // §41: { cand, params, preview:{srcPixels,autoOffset,offset,pixels}|null }

  function basePixels() {
    const p = project();
    return p.baseFrame || p.frames[0].pixels;
  }

  // §42: 比較先の解決（ベースフレーム=既定 / 番号付きの選択候補をドロップダウンで指定）
  function mergeRefInfo() {
    const v = mergeRefSelect.value;
    if (v !== "base") {
      const c = session.pool.find((cc) => String(cc.id) === v);
      if (c) {
        const n = session.selected.indexOf(c);
        return { ref: c.pixels, label: n >= 0 ? `選択#${n + 1}` : "候補" };
      }
    }
    return { ref: basePixels(), label: "ベースフレーム" };
  }

  // 現在の比較先で差分（塊・差分マップ）を組み立て直す。requireDiff=true なら差分ゼロで失敗させる。
  function rebuildMerge(cand, opts = {}) {
    const p = project();
    const { ref, label } = mergeRefInfo();
    const blobs = diffBlobs(ref, cand.pixels, p.width, p.height);
    if (!blobs.length && opts.requireDiff) {
      toast("この候補と比較先に差分がありません", "error");
      return false;
    }
    if (!blobs.length) toast("この比較先とは差分がありません（比較先を変えてください）", "error");
    // §25.10: 矩形・パーツチップ用の差分マップ（ref≠cand のセル）
    const diffMap = new Uint8Array(p.width * p.height);
    for (let k = 0; k < diffMap.length; k++) if (ref[k] !== cand.pixels[k]) diffMap[k] = 1;
    merge = {
      cand,
      refLabel: label,
      ref: Uint8Array.from(ref),
      blobs,
      diffMap,
      adopted: new Set(),
      mask: new Uint8Array(p.width * p.height),
      rectDrag: null,
    };
    mergeTitle.textContent = `部位取り込み — 候補 vs ${label}（${blobs.length}塊）`;
    return true;
  }

  function openMerge(cand) {
    // §25.7-6: スナップなし候補では適用不可（パレット整合が前提）
    if (cand.snapped === false) {
      toast("この候補はパレットスナップされていないため差分採用マージは使えません", "error");
      return;
    }
    // §42: 比較先ドロップダウンを構築（ベースフレーム + 番号付きの選択候補。自分自身は除く）
    mergeRefSelect.innerHTML = "";
    mergeRefSelect.add(new Option("ベースフレーム", "base"));
    session.selected.forEach((c, idx) => {
      if (c === cand) return;
      mergeRefSelect.add(new Option(`選択#${idx + 1}`, String(c.id)));
    });
    mergeRefSelect.value = "base";
    if (!rebuildMerge(cand, { requireDiff: true })) return;
    const rectTool = document.querySelector('input[name="mcMergeTool"][value="rect"]');
    if (rectTool) rectTool.checked = true;
    const compReplace = document.querySelector('input[name="mcMergeComposite"][value="replace"]');
    if (compReplace) compReplace.checked = true; // §25.11: 既定は完全置換
    mergePanel.hidden = false;
    renderMerge();
  }

  // §25.10-2: リグのパーツ矩形を「取り込み範囲のテンプレート」として使う。
  // パーツ矩形内の差分セル集合に対する採用状態（全/一部/未）を返す
  function partDiffState(part) {
    const p = project();
    const r = part.patch;
    let total = 0, sel = 0;
    for (let y = r.y; y < r.y + r.h && y < p.height; y++) {
      for (let x = r.x; x < r.x + r.w && x < p.width; x++) {
        const idx = y * p.width + x;
        if (!merge.diffMap[idx]) continue;
        total++;
        if (merge.mask[idx]) sel++;
      }
    }
    return { total, sel, state: total === 0 ? "none" : sel === 0 ? "off" : sel === total ? "full" : "partial" };
  }
  function togglePart(part) {
    const p = project();
    const st = partDiffState(part);
    if (st.total === 0) return;
    const on = st.state !== "full"; // 全採用でなければ全部入れる・全採用なら外す
    const r = part.patch;
    for (let y = r.y; y < r.y + r.h && y < p.height; y++) {
      for (let x = r.x; x < r.x + r.w && x < p.width; x++) {
        const idx = y * p.width + x;
        if (merge.diffMap[idx]) merge.mask[idx] = on ? 1 : 0;
      }
    }
    renderMerge();
  }

  // §25.11: 取り込み方（完全置換=既定 / 前面=候補非透明のみ / 背面=比較先透明∧候補非透明のみ）
  function compositeMode() {
    return document.querySelector('input[name="mcMergeComposite"]:checked')?.value || "replace";
  }
  function mergeComposite() {
    const cand = merge.cand.pixels;
    const mode = compositeMode();
    const out = Uint8Array.from(merge.ref);
    for (let i = 0; i < out.length; i++) {
      if (!merge.mask[i]) continue;
      if (mode === "front") {
        if (cand[i] !== 0) out[i] = cand[i]; // 候補の透明部は現状維持（上に乗せる）
      } else if (mode === "behind") {
        if (out[i] === 0 && cand[i] !== 0) out[i] = cand[i]; // 透明の後ろに差し込む
      } else {
        out[i] = cand[i]; // 完全置換
      }
    }
    return out;
  }

  function renderMerge() {
    if (!merge) return;
    const p = project();
    const sc = Math.max(3, Math.min(8, Math.floor(560 / Math.max(p.width, p.height))));
    merge.sc = sc;
    mergeCanvas.width = p.width * sc;
    mergeCanvas.height = p.height * sc;
    const ctx = mergeCanvas.getContext("2d");
    // §25.7-3: 採用中の見た目は合成プレビューで常時反映
    const tmp = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels: mergeComposite() }] };
    drawFrameToContext(ctx, tmp, 0, sc);
    // 非採用の塊は色付きオーバーレイ、採用中の塊は枠のみ
    merge.blobs.forEach((blob, k) => {
      const hue = MERGE_HUES[k % MERGE_HUES.length];
      if (merge.adopted.has(k)) {
        ctx.strokeStyle = `hsl(${hue}, 90%, 60%)`;
        ctx.lineWidth = 2;
        ctx.strokeRect(blob.bbox.x0 * sc + 1, blob.bbox.y0 * sc + 1, (blob.bbox.x1 - blob.bbox.x0 + 1) * sc - 2, (blob.bbox.y1 - blob.bbox.y0 + 1) * sc - 2);
      } else {
        ctx.fillStyle = `hsla(${hue}, 90%, 60%, 0.4)`;
        for (const idx of blob.cells) {
          ctx.fillRect((idx % p.width) * sc, ((idx / p.width) | 0) * sc, sc, sc);
        }
      }
    });
    // §25.10-1: 矩形選択のラバーバンド
    if (merge.rectDrag) {
      const d = merge.rectDrag;
      const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1);
      const x1 = Math.max(d.x0, d.x1), y1 = Math.max(d.y0, d.y1);
      ctx.save();
      ctx.strokeStyle = d.erase ? "#ef6d7a" : "#6ee7c8";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x0 * sc + 1, y0 * sc + 1, (x1 - x0 + 1) * sc - 2, (y1 - y0 + 1) * sc - 2);
      ctx.restore();
    }
    // §25.10-2: パーツチップ（リグにパーツ定義があるときだけ表示）
    const parts = p.rig?.parts?.length ? p.rig.parts : null;
    mergeParts.hidden = !parts;
    mergeParts.innerHTML = "";
    if (parts) {
      const label = document.createElement("span");
      label.className = "hint";
      label.textContent = "パーツで取り込み:";
      mergeParts.appendChild(label);
      for (const part of parts) {
        const st = partDiffState(part);
        const b = document.createElement("button");
        b.className = "btn btn-small mc-chip"
          + (st.state === "full" ? " btn-accent" : "")
          + (st.state === "partial" ? " mc-chip-partial" : "");
        b.disabled = st.state === "none";
        b.textContent = `${part.name}${st.state === "full" ? " ✓" : st.state === "partial" ? ` ${st.sel}/${st.total}` : st.state === "none" ? "（差分なし）" : ""}`;
        b.title = st.state === "none" ? "このパーツ矩形に差分はありません" : "パーツ矩形内の差分セルを一括で採用/解除";
        b.addEventListener("click", () => togglePart(part));
        mergeParts.appendChild(b);
      }
    }
    // チップ（塊A 214セル）
    mergeChips.innerHTML = "";
    merge.blobs.forEach((blob, k) => {
      const b = document.createElement("button");
      b.className = "btn btn-small mc-chip" + (merge.adopted.has(k) ? " btn-accent" : "");
      b.style.borderColor = `hsl(${MERGE_HUES[k % MERGE_HUES.length]}, 90%, 60%)`;
      b.textContent = `塊${String.fromCharCode(65 + (k % 26))} ${blob.count}セル`;
      b.addEventListener("click", () => toggleBlob(k));
      mergeChips.appendChild(b);
    });
  }

  function toggleBlob(k) {
    if (!merge) return;
    const blob = merge.blobs[k];
    if (merge.adopted.has(k)) {
      merge.adopted.delete(k);
      for (const idx of blob.cells) merge.mask[idx] = 0;
    } else {
      merge.adopted.add(k);
      for (const idx of blob.cells) merge.mask[idx] = 1;
    }
    renderMerge();
  }

  // 塊クリック採用 / ブラシ加減（足す=候補のセルを取り込む・引く=外す）
  let mergeDrag = false;
  function mergeCellFromEvent(ev) {
    const r = mergeCanvas.getBoundingClientRect();
    const p = project();
    const x = Math.floor((ev.clientX - r.left) / merge.sc);
    const y = Math.floor((ev.clientY - r.top) / merge.sc);
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return -1;
    return y * p.width + x;
  }
  function brushMode() {
    return document.querySelector('input[name="mcBrushMode"]:checked')?.value || "add";
  }
  function mergeTool() {
    return document.querySelector('input[name="mcMergeTool"]:checked')?.value || "rect";
  }
  function mergeXyFromEvent(ev) {
    const r = mergeCanvas.getBoundingClientRect();
    const p = project();
    const x = Math.max(0, Math.min(p.width - 1, Math.floor((ev.clientX - r.left) / merge.sc)));
    const y = Math.max(0, Math.min(p.height - 1, Math.floor((ev.clientY - r.top) / merge.sc)));
    return { x, y };
  }
  mergeCanvas.addEventListener("mousedown", (ev) => {
    if (!merge) return;
    const tool = mergeTool();
    if (tool === "rect") {
      // §25.10-1: 矩形モード — 囲んだ範囲の差分セルを追加（Shift または「引く」で解除）
      const { x, y } = mergeXyFromEvent(ev);
      merge.rectDrag = { x0: x, y0: y, x1: x, y1: y, erase: ev.shiftKey || brushMode() === "del" };
      renderMerge();
      return;
    }
    const idx = mergeCellFromEvent(ev);
    if (idx < 0) return;
    if (tool === "brush") {
      mergeDrag = true;
      merge.mask[idx] = brushMode() === "add" ? 1 : 0;
      renderMerge();
    } else {
      const k = merge.blobs.findIndex((b) => b.cells.includes(idx));
      if (k >= 0) toggleBlob(k);
    }
  });
  window.addEventListener("mousemove", (ev) => {
    if (!merge) return;
    if (merge.rectDrag) {
      const { x, y } = mergeXyFromEvent(ev);
      merge.rectDrag.x1 = x;
      merge.rectDrag.y1 = y;
      renderMerge();
      return;
    }
    if (!mergeDrag) return;
    const idx = mergeCellFromEvent(ev);
    if (idx < 0) return;
    merge.mask[idx] = brushMode() === "add" ? 1 : 0;
    renderMerge();
  });
  window.addEventListener("mouseup", () => {
    mergeDrag = false;
    if (merge && merge.rectDrag) {
      // 矩形確定: 範囲内かつ差分ありのセルだけをマスクへ追加/解除
      const p = project();
      const d = merge.rectDrag;
      const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1);
      const x1 = Math.max(d.x0, d.x1), y1 = Math.max(d.y0, d.y1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = y * p.width + x;
          if (merge.diffMap[idx]) merge.mask[idx] = d.erase ? 0 : 1;
        }
      }
      merge.rectDrag = null;
      renderMerge();
    }
  });

  mergeApplyBtn.addEventListener("click", () => {
    if (!merge) return;
    const adoptedCells = merge.mask.reduce((a, v) => a + v, 0);
    if (adoptedCells === 0) {
      toast("採用中の塊（またはブラシ加算）がありません", "error");
      return;
    }
    // §42: 合成結果は新しい候補としてプールに追加（未選択・元候補の選択状態は維持）
    const composite = mergeComposite();
    const cand = { id: session.nextId++, status: "ok", source: "merge", snapped: true, pixels: composite };
    session.pool.push(cand);
    renderPool();
    toast(`採用塊（${adoptedCells}セル）を合成した候補をプールに追加しました（未選択。クリックで番号を付与）`);
    merge = null;
    mergePanel.hidden = true;
  });
  mergeCancelBtn.addEventListener("click", () => {
    merge = null;
    mergePanel.hidden = true;
  });
  // §25.11-4: 取り込み方の切り替えは合成プレビューへ即時反映
  for (const r of document.querySelectorAll('input[name="mcMergeComposite"]')) {
    r.addEventListener("change", () => { if (merge) renderMerge(); });
  }
  // §42: 比較先の切り替えで差分を組み立て直す（採用済みマスクはリセット）
  mergeRefSelect.addEventListener("change", () => {
    if (!merge) return;
    rebuildMerge(merge.cand);
    renderMerge();
  });

  // ---------------------------------------------------------------------
  // §41: 候補ごとの変換調整（「調整」ボタン → モーダル内サブパネル + ライブプレビュー）
  // srcRegion から bgThreshold/glowWidth/edgeProtect/satProtect/セルサイズを変えて再変換 →
  // プロジェクトパレットへスナップ → 整列。ナッジ済みオフセット（autoOffset との差分）は維持。
  // 「適用」まで cand 自体は書き換えない（キャンセルで安全に破棄できる）。
  // ---------------------------------------------------------------------
  function openAdjust(cand) {
    if (!cand.srcRegion) {
      toast("この候補は元画像領域が保持されていないため調整できません", "error");
      return;
    }
    adjust = { cand, params: { ...(cand.convParams || defaultConvParams()) }, preview: null };
    const n = session.selected.indexOf(cand);
    adjustTitle.textContent = n >= 0 ? `候補調整 — 選択#${n + 1}` : "候補調整 — 未選択の候補";
    adjustBg.value = String(adjust.params.bgThreshold);
    adjustGlow.value = String(adjust.params.glowWidth);
    adjustEdge.value = String(adjust.params.edgeProtect);
    adjustSat.value = String(adjust.params.satProtect);
    adjustCell.value = String(adjust.params.cellDelta || 0);
    adjustStatus.textContent = "";
    adjustPanel.hidden = false;
    scheduleAdjustPreview();
  }

  function closeAdjust() {
    adjustPanel.hidden = true;
    adjust = null;
  }

  function readAdjustParams() {
    return {
      bgThreshold: Number(adjustBg.value),
      glowWidth: Number(adjustGlow.value),
      edgeProtect: Number(adjustEdge.value),
      satProtect: Number(adjustSat.value),
      cellDelta: Number(adjustCell.value),
    };
  }

  let adjustGen = 0;
  let adjustTimer = null;
  function scheduleAdjustPreview() {
    clearTimeout(adjustTimer);
    adjustTimer = setTimeout(runAdjustPreview, 120);
  }
  async function runAdjustPreview() {
    if (!adjust) return;
    const gen = ++adjustGen;
    const params = readAdjustParams();
    adjust.params = params;
    adjustStatus.textContent = "変換中…";
    try {
      const { srcPixels, offset: autoOffset } = await reconvertFromRegion(adjust.cand.srcRegion, params);
      if (gen !== adjustGen || !adjust) return;
      // ナッジ済みオフセット = 元の offset と元の autoOffset の差分。新しい autoOffset に同じ差分を足して維持する。
      const nudgeDx = adjust.cand.offset.dx - adjust.cand.autoOffset.dx;
      const nudgeDy = adjust.cand.offset.dy - adjust.cand.autoOffset.dy;
      const offset = { dx: autoOffset.dx + nudgeDx, dy: autoOffset.dy + nudgeDy };
      const pixels = shiftPixels(srcPixels, offset.dx, offset.dy);
      adjust.preview = { srcPixels, autoOffset, offset, pixels };
      drawCand(adjustCanvas, pixels, adjust.cand);
      adjustStatus.textContent = "";
    } catch (err) {
      if (gen !== adjustGen || !adjust) return;
      adjustStatus.textContent = `変換に失敗: ${err.message}`;
      adjust.preview = null;
    }
  }
  for (const el of [adjustBg, adjustGlow, adjustEdge, adjustSat, adjustCell]) {
    el.addEventListener("input", scheduleAdjustPreview);
  }
  adjustApplyBtn.addEventListener("click", () => {
    if (!adjust || !adjust.preview) { closeAdjust(); return; }
    const { cand, params, preview } = adjust;
    cand.srcPixels = preview.srcPixels;
    cand.autoOffset = preview.autoOffset;
    cand.offset = preview.offset;
    cand.pixels = preview.pixels;
    cand.convParams = params;
    closeAdjust();
    renderCell(cand);
    toast("候補を再変換しました（プロジェクトパレットへスナップ+整列済み・ナッジは維持）");
  });
  adjustCancelBtn.addEventListener("click", closeAdjust);

  // ---------------------------------------------------------------------
  // §25.6-4.5/§25.8: GPT依頼キット（out/ へ reference.png + prompt.txt・依頼文はクリップボードにも）
  // ---------------------------------------------------------------------
  async function exportKit() {
    if (!session) return;
    const p = project();
    if (!p.baseFrame) {
      toast("ベースフレームがありません", "error");
      return;
    }
    // 参照PNG: ベースフレームの8倍最近傍拡大
    const referencePng = pixelsToPngDataUrl(p.baseFrame, p.width, p.height, p.palette, 8);
    const style = styleRequestFields(p, store.state.serverConfig);
    try {
      const res = await fetch("/api/exchange-kit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset: session.preset,
          customText: session.customText,
          total: session.genTotal,
          styleGuide: style.styleGuide || "",
          referencePng,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      let clip = "";
      try {
        await navigator.clipboard.writeText(data.promptText);
        clip = "依頼文をクリップボードにコピーしました。";
      } catch {
        clip = "（クリップボードへのコピーは失敗。prompt.txt を使ってください）";
      }
      toast(`GPT依頼キットを書き出しました: ${data.dir}（reference.png + prompt.txt）。${clip}`);
      await maybeOpenServerFolder("exchange"); // §38: 完了時にフォルダを開く（トグルON時）
    } catch (err) {
      toast(`キットの書き出しに失敗しました: ${err.message}`, "error");
    }
  }

  // ---------------------------------------------------------------------
  // §25.8-3: 受信箱ポーリング — ギャラリー表示中は自動取り込み、閉時はバッジ
  // ---------------------------------------------------------------------
  async function pollInbox() {
    try {
      const open = !modal.hidden && session && !session.confirmed;
      if (open) {
        const res = await fetch("/api/exchange-inbox");
        const data = await res.json();
        if (data.files?.length) {
          let total = 0;
          for (const f of data.files) {
            const blob = await (await fetch(f.dataUrl)).blob();
            total += await addImageCandidates(new File([blob], f.name, { type: blob.type }), { auto: true, quiet: true });
          }
          if (total > 0) toast(`gpt-exchange/in から新しい候補を取り込みました（${total}個・処理済みは in/done/ へ移動）`);
          inboxBadge.hidden = true;
          inboxBadge.textContent = "";
        }
      } else {
        const res = await fetch("/api/exchange-inbox?peek=1");
        const data = await res.json();
        if (data.count > 0) {
          inboxBadge.hidden = false;
          inboxBadge.textContent = `受信箱に${data.count}枚`;
        } else {
          inboxBadge.hidden = true;
        }
      }
    } catch {}
  }
  setInterval(pollInbox, 3000);

  // §42: 反転で補完 — 選択した候補の左右反転コピーをプールに追加（未選択）
  function mirrorComplete() {
    if (!session) return;
    if (!session.selected.length) {
      toast("選択された候補がありません（反転コピーは番号を付けた候補から作られます）", "error");
      return;
    }
    let added = 0;
    for (const src of session.selected) {
      session.pool.push({
        id: session.nextId++, status: "ok",
        source: "mirror", snapped: true, pixels: flipPixelsH(src.pixels),
      });
      added++;
    }
    renderPool();
    toast(`${added}個の反転コピーをプールに追加しました（未選択。武器などの非対称部は確定後に部位修正で直してください）`);
  }

  function renderCell(cand) {
    const el = grid.querySelector(`[data-cell="${cand.id}"]`);
    if (!el) return renderPool();
    fillCell(el, cand);
    updateConfirmState();
  }

  function fillCell(el, cand) {
    el.innerHTML = "";
    const sel = session.selected.indexOf(cand);
    el.classList.toggle("is-selected", sel >= 0);
    el.classList.toggle("is-error", cand.status === "error");
    if (cand.status === "pending") {
      const d = document.createElement("div");
      d.className = "mc-pending";
      d.textContent = "生成中…";
      el.appendChild(d);
    } else if (cand.status === "error") {
      const d = document.createElement("div");
      d.className = "mc-error";
      d.textContent = cand.error || "エラー";
      el.appendChild(d);
      const retry = document.createElement("button");
      retry.className = "btn btn-small";
      retry.textContent = "再生成";
      retry.addEventListener("click", () => runOne(cand));
      el.appendChild(retry);
    } else {
      // §42.1: 選択済み＝大きな番号バッジ。クリックで選択/解除（後続の番号は自動で繰り上げ）
      if (sel >= 0) {
        const num = document.createElement("div");
        num.className = "mc-sel-badge";
        num.textContent = String(sel + 1);
        el.appendChild(num);
      }
      const cv = document.createElement("canvas");
      const srcLabel = cand.source === "image" ? "画像"
        : cand.source === "mirror" ? "反転コピー"
        : cand.source === "merge" ? "部位合成"
        : `生成${(cand.phase ?? 0) + 1}/${cand.phaseTotal ?? "?"}-${(cand.variant ?? 0) + 1}`;
      cv.title = cand.warn || `${srcLabel}（クリックで選択/解除）`;
      drawCand(cv, cand.pixels, cand);
      cv.addEventListener("click", () => toggleSelect(cand));
      el.appendChild(cv);
      const badge = document.createElement("div");
      badge.className = "mc-badge";
      badge.textContent = cand.source === "image" ? "画像（スナップ+整列済み）"
        : cand.source === "mirror" ? "反転コピー"
        : cand.source === "merge" ? "部位合成"
        : srcLabel;
      el.appendChild(badge);
      const row = document.createElement("div");
      row.className = "mc-cell-actions";
      if (cand.source === "grid") {
        const redo = document.createElement("button");
        redo.className = "btn btn-small";
        redo.textContent = "描き直し";
        redo.title = "追記指示を添えて単発再生成（この候補が選択済みなら選択列の前後を文脈として同梱）";
        redo.addEventListener("click", () => {
          const inst = window.prompt("描き直しの追記指示（例: 腕をもっと大きく振って）", "");
          if (inst === null) return;
          runOne(cand, { instruction: inst.trim() || undefined, withNeighbors: true });
        });
        row.appendChild(redo);
      }
      const mg = document.createElement("button");
      mg.className = "btn btn-small";
      mg.textContent = "部位取り込み";
      mg.title = "この候補から部位ごとに選んで合成候補を作る（比較先=ベース/番号付き候補・矩形/パーツチップ/塊/ブラシ・§25.7/§25.10/§42）";
      mg.addEventListener("click", () => openMerge(cand));
      row.appendChild(mg);
      // §41: 画像由来の候補のみ「調整」（グリッド生成候補には出さない）
      if (cand.source === "image" && cand.srcRegion) {
        const adj = document.createElement("button");
        adj.className = "btn btn-small";
        adj.textContent = "調整";
        adj.title = "背景除去閾値・フチ光彩・輪郭/彩度保護・セルサイズを個別調整（元画像領域から再変換→パレットスナップ→整列。ナッジ済みオフセットは維持）";
        adj.addEventListener("click", () => openAdjust(cand));
        row.appendChild(adj);
      }
      const del = document.createElement("button");
      del.className = "btn btn-small";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        session.pool = session.pool.filter((c) => c !== cand);
        const si = session.selected.indexOf(cand);
        if (si >= 0) session.selected.splice(si, 1); // §42: 削除でも後続の番号は自動繰り上げ
        renderPool();
        if (inflight === 0) setIdleProgress();
      });
      row.appendChild(del);
      el.appendChild(row);
      // §25.6-2: 画像候補は±ナッジと「ベース重ね」プレビュー
      if (cand.source === "image") {
        const nudge = document.createElement("div");
        nudge.className = "mc-cell-actions";
        for (const [label, dx, dy] of [["◀", -1, 0], ["▶", 1, 0], ["▲", 0, -1], ["▼", 0, 1]]) {
          const b = document.createElement("button");
          b.className = "btn btn-small";
          b.textContent = label;
          b.title = "位置を1pxナッジ";
          b.addEventListener("click", () => {
            // §25.9-1: オフセット方式（元配置から再適用）— 端で切れたピクセルも戻せばロスレス復元
            cand.offset.dx += dx;
            cand.offset.dy += dy;
            applyOffset(cand);
            renderCell(cand);
          });
          nudge.appendChild(b);
        }
        const ov = document.createElement("button");
        ov.className = "btn btn-small" + (cand.overlayBase ? " btn-accent" : "");
        ov.textContent = "重ね";
        ov.title = "ベースフレームを半透明で重ねて整列を確認";
        ov.addEventListener("click", () => {
          cand.overlayBase = !cand.overlayBase;
          renderCell(cand);
        });
        nudge.appendChild(ov);
        el.appendChild(nudge);
      }
    }
  }

  // §42.1: プール描画 — 列分けなしの1グリッド
  function renderPool() {
    if (!session) return;
    grid.innerHTML = "";
    for (const cand of session.pool) {
      const el = document.createElement("div");
      el.className = "mc-cell";
      el.dataset.cell = String(cand.id);
      fillCell(el, cand);
      grid.appendChild(el);
    }
    updateConfirmState();
  }

  // §42.1: 選択トグル — クリックで末尾番号を付与、再クリックで解除して後続を繰り上げ
  function toggleSelect(cand) {
    if (cand.status !== "ok") return;
    const i = session.selected.indexOf(cand);
    if (i >= 0) session.selected.splice(i, 1);
    else session.selected.push(cand);
    renderPool(); // 番号が全体で繰り上がるため全再描画
    if (inflight === 0) setIdleProgress();
  }

  function updateConfirmState() {
    const n = session ? session.selected.length : 0;
    confirmBtn.disabled = !(session && !session.confirmed && n >= 1);
    if (selCount) selCount.textContent = `選択 ${n}件`;
  }

  // ---------------------------------------------------------------------
  // ミニプレビュー（§42: 選択順のセットを連続再生・プロジェクトfps）
  // ---------------------------------------------------------------------
  function startPreview() {
    stopPreview();
    previewTimer = setInterval(() => {
      if (!session) return;
      const p = project();
      const frames = session.selected;
      const ctx = previewCanvas.getContext("2d");
      const sc = Math.max(1, Math.floor(64 / Math.max(p.width, p.height)));
      previewCanvas.width = p.width * sc;
      previewCanvas.height = p.height * sc;
      if (!frames.length) {
        ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        return;
      }
      // §25.9-4: ピンポンは往復シーケンス（端重複なし: 0,1,2,3,2,1,…）
      if ((p.playMode || "loop") === "pingpong" && frames.length > 1) {
        const cycle = frames.length * 2 - 2;
        previewIdx = (previewIdx + 1) % cycle;
        const k = previewIdx < frames.length ? previewIdx : cycle - previewIdx;
        const tmp = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels: frames[k].pixels }] };
        drawFrameToContext(ctx, tmp, 0, sc);
      } else {
        previewIdx = (previewIdx + 1) % frames.length;
        const tmp = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels: frames[previewIdx].pixels }] };
        drawFrameToContext(ctx, tmp, 0, sc);
      }
    }, 1000 / Math.max(1, project().fps));
  }
  function stopPreview() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
  }

  // ---------------------------------------------------------------------
  // 確定（§42: 選択順にフレーム化してタイムライン末尾へ・タグ範囲=選択数）
  // ---------------------------------------------------------------------
  confirmBtn.addEventListener("click", () => {
    if (!session || session.confirmed || session.selected.length === 0) return;
    const p = project();
    const n = session.selected.length;
    store.pushUndo();
    const start = p.frames.length;
    for (const cand of session.selected) p.frames.push({ pixels: Uint8Array.from(cand.pixels) });
    const tag = addGeneratedTag(p, session.preset, start, start + n - 1);
    tag.fps = p.fps;
    store.state.activeTagIndex = p.tags.indexOf(tag);
    session.confirmed = true;
    store.clampAfterProjectChange();
    store.state.currentFrame = start;
    store.notify();
    toast(`選択${n}件を選択順にフレーム化し、タグ「${tag.name}」として追加しました`);
    // §25.2: 確定後の各フレームに「エディタで開く」
    confirmedBar.hidden = false;
    confirmedBar.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = `確定しました（フレーム${start}〜${start + n - 1}・タグ「${tag.name}」）: `;
    confirmedBar.appendChild(label);
    for (let i = 0; i < n; i++) {
      const b = document.createElement("button");
      b.className = "btn btn-small";
      b.textContent = `フレーム${start + i}をエディタで開く`;
      b.addEventListener("click", () => {
        store.state.currentFrame = start + i;
        closeModal();
        store.notify();
      });
      confirmedBar.appendChild(b);
    }
    updateConfirmState();
    progress.textContent = "確定済み。仕上げは矩形選択+指示（修正タブ）やペン+部分仕上げで";
  });

  // ---------------------------------------------------------------------
  // 開閉・中断
  // ---------------------------------------------------------------------
  function closeModal() {
    merge = null;
    mergePanel.hidden = true;
    adjust = null;
    adjustPanel.hidden = true;
    if (importPreviewAbort) importPreviewAbort(); // §39-4: 保留中の取り込みプレビューはキャンセル扱い
    if (abortController) abortController.abort();
    abortController = null;
    inflight = 0;
    stopPreview();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    modal.hidden = true;
  }
  closeBtn.addEventListener("click", closeModal);
  imageBtn.addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    imageInput.value = "";
    if (file) await addImageCandidates(file);
  });
  mirrorBtn.addEventListener("click", mirrorComplete);
  kitBtn.addEventListener("click", exportKit);
  abortBtn.addEventListener("click", () => {
    if (abortController) abortController.abort();
  });

  // 検証用フック（§25.7-6 の「スナップなし候補では適用不可」等をテストから注入するため）
  modal.__mcTest = {
    getSession: () => session,
    addCandidate(cand) {
      if (!session) return null;
      const c = { id: session.nextId++, status: "ok", source: "image", ...cand };
      session.pool.push(c);
      renderPool();
      return c.id;
    },
    // §41 検証用: 開いている調整パネルの現在の下書き（未適用のライブプレビュー）を覗く
    getAdjustDraft: () => (adjust ? {
      candId: adjust.cand.id,
      params: { ...adjust.params },
      preview: adjust.preview ? {
        pixels: Array.from(adjust.preview.pixels),
        offset: { ...adjust.preview.offset },
        autoOffset: { ...adjust.preview.autoOffset },
      } : null,
    } : null),
  };

  // §42: 新しい空セッション（プールモデル）
  function newSession() {
    const preset = motionPreset.value;
    const customText = motionCustomText.value.trim();
    return {
      preset,
      presetLabel: PRESET_LABELS[preset] || preset,
      customText,
      genTotal: Math.max(2, Math.min(12, Number(motionFrames.value) || 4)),
      k: Math.max(1, Math.min(4, Number(candCount.value) || 3)),
      nextId: 1,
      pool: [],
      selected: [],
      confirmed: false,
    };
  }

  generateBtn.addEventListener("click", () => {
    const p = project();
    if (!p.baseFrame) {
      toast("ベースフレームがありません。「画像を開く」でドット絵を読み込んでください", "error");
      return;
    }
    const preset = motionPreset.value;
    const customText = motionCustomText.value.trim();
    if (preset === "custom" && !customText) {
      toast("カスタムプリセットでは自由入力が必要です", "error");
      return;
    }
    const total = Math.max(2, Math.min(12, Number(motionFrames.value) || 4));
    const k = Math.max(1, Math.min(4, Number(candCount.value) || 3));
    if (!session || session.confirmed) {
      session = newSession();
      confirmedBar.hidden = true;
      confirmedBar.innerHTML = "";
    }
    // §42: 生成パラメータを更新し、結果は既存プールへ未選択で追加（phaseHint は生成パラメータとして維持）
    session.preset = preset;
    session.presetLabel = PRESET_LABELS[preset] || preset;
    session.customText = customText;
    session.genTotal = total;
    session.k = k;
    modal.hidden = false;
    const newCands = [];
    for (let i = 0; i < total; i++) {
      for (let kk = 0; kk < k; kk++) {
        const cand = { id: session.nextId++, status: "pending", variant: kk, source: "grid", phase: i, phaseTotal: total };
        session.pool.push(cand);
        newCands.push(cand);
      }
    }
    renderPool();
    startPreview();
    // N×K を発行（サーバー側キューの並列2に乗る）
    for (const cand of newCands) runOne(cand);
  });

  // ---------------------------------------------------------------------
  // §39: ギャラリーを生成なしで開く（画像取り込みの入口）
  // AI生成を一切走らせず、空のプールでモーダルを開く。
  // 既にセッションがあれば（確定済み含む）プール・選択状態を保持して再表示。
  // ---------------------------------------------------------------------
  function openGalleryWithoutGeneration() {
    if (!session) {
      session = newSession();
      confirmedBar.hidden = true;
      confirmedBar.innerHTML = "";
    }
    renderPool();
    modal.hidden = false;
    startPreview();
    if (inflight === 0) setIdleProgress();
    pollInbox(); // §25.8: 受信箱に画像があれば即自動取り込み
  }
  document.getElementById("mcOpenGalleryBtn").addEventListener("click", openGalleryWithoutGeneration);
  // §39: 受信箱バッジのクリックでもギャラリーを開く（開けば自動取り込みが即走る）
  inboxBadge.addEventListener("click", openGalleryWithoutGeneration);
}
