// motionstudio.js — §25 モーション候補スタジオ（生成→選別→確定）
// N×K 個の独立した単フレーム生成（mode:"motionframe"）を並列発行し、
// ギャラリーで採用/削除/描き直し/追加生成 → 全フレーム採用で確定（タグ付きで末尾に追加）。
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
  setFramePixels,
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
  const totalInput = document.getElementById("mcTotalInput");
  const mergePanel = document.getElementById("mcMergePanel");
  const mergeTitle = document.getElementById("mcMergeTitle");
  const mergeChips = document.getElementById("mcMergeChips");
  const mergeCanvas = document.getElementById("mcMergeCanvas");
  const mergeParts = document.getElementById("mcMergeParts");
  const mergeApplyBtn = document.getElementById("mcMergeApply");
  const mergeCancelBtn = document.getElementById("mcMergeCancel");
  const motionPreset = document.getElementById("motionPreset");
  const motionCustomText = document.getElementById("motionCustomText");
  const motionFrames = document.getElementById("motionFrames");

  function project() { return store.state.project; }

  // セッション状態（モーダルを閉じるまで保持）
  // cands[i] = [{ id, status: "pending"|"ok"|"error", pixels?, error?, variant,
  //               source: "grid"|"image"（§25.6）, snapped?/aligned?（§25.6 で使用） }...]
  // adopted[i] = 採用中の候補オブジェクト | null（オブジェクト参照で保持 — 削除に強い）
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
    const adopted = session ? session.adopted.filter(Boolean).length : 0;
    progress.textContent = session ? `候補を選別してください（採用 ${adopted}/${session.total}）` : "";
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
  // 生成（1スロット）
  // ---------------------------------------------------------------------
  async function runOne(i, cand, opts = {}) {
    const p = project();
    const s = session;
    cand.status = "pending";
    cand.error = null;
    renderCell(i, cand);
    const mf = {
      preset: s.preset,
      index: i,
      total: s.total,
      variant: cand.variant,
    };
    if (s.customText) mf.customText = s.customText;
    if (opts.instruction) mf.instruction = opts.instruction;
    // §25.2: 描き直し時は採用済みの前後フレームを連続性の文脈として同梱
    if (opts.withNeighbors) {
      const prev = i > 0 ? s.adopted[i - 1] : null;
      const next = i < s.total - 1 ? s.adopted[i + 1] : null;
      if (prev) mf.prevFrameGrid = pixelsToGridString(prev.pixels, p.width, p.height, p.palette.length);
      if (next) mf.nextFrameGrid = pixelsToGridString(next.pixels, p.width, p.height, p.palette.length);
    }
    const body = {
      ...baseRequestFields(),
      mode: "motionframe",
      scope: "all",
      motionframe: mf,
      instruction: `「${s.presetLabel}」モーションの第${i + 1}/${s.total}フレーム候補を生成`,
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
      renderCell(i, cand);
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

  async function addImageCandidates(file, opts = {}) {
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
    let startFrame;
    // §25.9-3: シートのコマ数が N と不一致なら「フレーム数を合わせますか？」を自動提案
    if (!session.confirmed && comps.length !== session.total && comps.length >= 1 && comps.length <= 12) {
      if (window.confirm(`シートは${comps.length}コマです。ギャラリーのフレーム数を${comps.length}に合わせますか？`)) {
        setTotal(comps.length, { force: true });
      }
    }
    if (Number.isInteger(opts.startFrame)) {
      startFrame = opts.startFrame; // §25.8: 自動取り込みはフレーム1から順に割り当て
    } else {
      const ans = window.prompt(`何フレーム目の候補にしますか？（1〜${session.total}。${comps.length}コマ検出 — シートは順に割り当て）`, "1");
      if (ans === null) return 0;
      startFrame = Math.max(1, Math.min(session.total, Number(ans) || 1)) - 1;
    }
    let added = 0;
    for (let k = 0; k < comps.length; k++) {
      const fi = startFrame + k;
      if (fi >= session.total) break;
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
      const cand = {
        id: session.nextId++, status: "ok", variant: session.cands[fi].length,
        source: "image", snapped: true, aligned: true, srcPixels, offset,
      };
      applyOffset(cand); // §25.9-1: pixels = srcPixels + offset（ナッジで再適用）
      session.cands[fi].push(cand);
      added++;
    }
    renderGrid();
    if (!opts.quiet) {
      toast(added ? `画像から${added}個の候補を追加しました（パレットスナップ+足元/重心整列済み）` : "候補を追加できませんでした", added ? "info" : "error");
    }
    return added;
  }

  // ---------------------------------------------------------------------
  // §25.7: 差分採用マージ — 候補の変化を塊ごとに選んで取り込む
  // ---------------------------------------------------------------------
  const MERGE_HUES = [200, 30, 300, 120, 0, 60, 260, 170];
  let merge = null; // { i, cand, ref, refKind, blobs, adopted:Set, mask:Uint8Array }

  function basePixels() {
    const p = project();
    return p.baseFrame || p.frames[0].pixels;
  }

  function openMerge(i, cand) {
    const p = project();
    // §25.7-6: スナップなし候補では適用不可（パレット整合が前提）
    if (cand.snapped === false) {
      toast("この候補はパレットスナップされていないため差分採用マージは使えません", "error");
      return;
    }
    // 比較先 = そのフレームの現在値: 確定済みなら確定フレーム、選別中は採用中候補、無ければベース
    let ref, refKind;
    if (session.confirmed && session.insertedAt !== null && p.frames[session.insertedAt + i]) {
      ref = p.frames[session.insertedAt + i].pixels;
      refKind = "frame";
    } else if (session.adopted[i] && session.adopted[i] !== cand) {
      ref = session.adopted[i].pixels;
      refKind = "adopted";
    } else {
      ref = basePixels();
      refKind = "base";
    }
    const blobs = diffBlobs(ref, cand.pixels, p.width, p.height);
    if (!blobs.length) {
      toast("この候補と比較先に差分がありません", "error");
      return;
    }
    // §25.10: 矩形・パーツチップ用の差分マップ（ref≠cand のセル）
    const diffMap = new Uint8Array(p.width * p.height);
    for (let k = 0; k < diffMap.length; k++) if (ref[k] !== cand.pixels[k]) diffMap[k] = 1;
    merge = {
      i, cand, refKind,
      ref: Uint8Array.from(ref),
      blobs,
      diffMap,
      adopted: new Set(),
      mask: new Uint8Array(p.width * p.height),
      rectDrag: null,
    };
    const refLabel = refKind === "adopted" ? "採用中の候補" : refKind === "frame" ? `確定済みフレーム${session.insertedAt + i}` : "ベースフレーム";
    mergeTitle.textContent = `部位取り込み — フレーム${i + 1}の候補 vs ${refLabel}（${blobs.length}塊）`;
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
    const p = project();
    const adoptedCells = merge.mask.reduce((a, v) => a + v, 0);
    if (adoptedCells === 0) {
      toast("採用中の塊（またはブラシ加算）がありません", "error");
      return;
    }
    const composite = mergeComposite();
    if (merge.refKind === "frame") {
      // 確定済みフレームへ直接適用（アンドゥ対象）
      store.pushUndo();
      setFramePixels(p.frames[session.insertedAt + merge.i], composite); // §35: フラットな取り込み結果で置換
      store.notify();
      toast(`確定済みフレーム${session.insertedAt + merge.i}へ採用塊（${adoptedCells}セル）を取り込みました（Ctrl+Zで戻せます）`);
    } else {
      // 選別中: 取り込み結果を新しい候補として作成し採用
      const cand = {
        id: session.nextId++, status: "ok", variant: session.cands[merge.i].length,
        source: "merge", snapped: true, pixels: composite,
      };
      session.cands[merge.i].push(cand);
      session.adopted[merge.i] = cand;
      renderGrid();
      toast(`採用塊（${adoptedCells}セル）だけ取り込んだ候補を作成し採用しました`);
    }
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
          total: session.total,
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
            total += await addImageCandidates(new File([blob], f.name, { type: blob.type }), { startFrame: 0, quiet: true });
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

  // §25.6-4: ミラー補完 — 採用済みフレーム i の左右反転を i+N/2 の候補に（歩き4f: 3=flip(1), 4=flip(2)）
  function mirrorComplete() {
    if (!session) return;
    if (session.total % 2 !== 0) {
      toast("反転補完はフレーム数が偶数のときに使えます（前半↔後半の対応）", "error");
      return;
    }
    const half = session.total / 2;
    let added = 0;
    for (let i = 0; i < half; i++) {
      const src = session.adopted[i];
      if (!src) continue;
      const j = i + half;
      const cand = {
        id: session.nextId++, status: "ok", variant: session.cands[j].length,
        source: "mirror", snapped: true, pixels: flipPixelsH(src.pixels),
      };
      session.cands[j].push(cand);
      added++;
    }
    renderGrid();
    toast(added
      ? `${added}個の反転候補を追加しました（フレーム${half + 1}〜。武器などの非対称部は確定後に部位修正で直してください）`
      : "反転元がありません（前半のフレームを採用してから実行してください）", added ? "info" : "error");
  }

  function renderCell(i, cand) {
    const el = grid.querySelector(`[data-cell="${i}:${cand.id}"]`);
    if (!el) return renderGrid();
    fillCell(el, i, cand);
    updateConfirmState();
  }

  function fillCell(el, i, cand) {
    el.innerHTML = "";
    el.classList.toggle("is-adopted", session.adopted[i] === cand);
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
      retry.addEventListener("click", () => runOne(i, cand));
      el.appendChild(retry);
    } else {
      const cv = document.createElement("canvas");
      const srcLabel = cand.source === "image" ? "画像" : cand.source === "mirror" ? "反転" : `候補${cand.variant + 1}`;
      cv.title = cand.warn || srcLabel;
      drawCand(cv, cand.pixels, cand);
      cv.addEventListener("click", () => adopt(i, cand));
      el.appendChild(cv);
      if (cand.source !== "grid") {
        const badge = document.createElement("div");
        badge.className = "mc-badge";
        badge.textContent = cand.source === "image" ? "画像（スナップ+整列済み）" : "反転補完";
        el.appendChild(badge);
      }
      const row = document.createElement("div");
      row.className = "mc-cell-actions";
      const adoptBtn = document.createElement("button");
      adoptBtn.className = "btn btn-small" + (session.adopted[i] === cand ? " btn-accent" : "");
      adoptBtn.textContent = session.adopted[i] === cand ? "採用中" : "採用";
      adoptBtn.addEventListener("click", () => adopt(i, cand));
      row.appendChild(adoptBtn);
      // §25.9-2: フレーム列移動
      const mvL = document.createElement("button");
      mvL.className = "btn btn-small";
      mvL.textContent = "◀列";
      mvL.title = "前のフレーム列へ移動";
      mvL.disabled = i === 0;
      mvL.addEventListener("click", () => moveCand(i, cand, i - 1));
      row.appendChild(mvL);
      const mvR = document.createElement("button");
      mvR.className = "btn btn-small";
      mvR.textContent = "列▶";
      mvR.title = "次のフレーム列へ移動";
      mvR.disabled = i === session.total - 1;
      mvR.addEventListener("click", () => moveCand(i, cand, i + 1));
      row.appendChild(mvR);
      if (cand.source === "grid") {
        const redo = document.createElement("button");
        redo.className = "btn btn-small";
        redo.textContent = "描き直し";
        redo.title = "追記指示を添えて単発再生成（採用済みの前後フレームを文脈として同梱）";
        redo.addEventListener("click", () => {
          const inst = window.prompt("描き直しの追記指示（例: 腕をもっと大きく振って）", "");
          if (inst === null) return;
          runOne(i, cand, { instruction: inst.trim() || undefined, withNeighbors: true });
        });
        row.appendChild(redo);
      }
      const mg = document.createElement("button");
      mg.className = "btn btn-small";
      mg.textContent = "部位取り込み";
      mg.title = "この候補から部位ごとに選んで取り込む（矩形/パーツチップ/塊/ブラシ・§25.7/§25.10）";
      mg.addEventListener("click", () => openMerge(i, cand));
      row.appendChild(mg);
      const del = document.createElement("button");
      del.className = "btn btn-small";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        session.cands[i] = session.cands[i].filter((c) => c !== cand);
        if (session.adopted[i] === cand) session.adopted[i] = null;
        renderGrid();
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
            renderCell(i, cand);
          });
          nudge.appendChild(b);
        }
        const ov = document.createElement("button");
        ov.className = "btn btn-small" + (cand.overlayBase ? " btn-accent" : "");
        ov.textContent = "重ね";
        ov.title = "ベースフレームを半透明で重ねて整列を確認";
        ov.addEventListener("click", () => {
          cand.overlayBase = !cand.overlayBase;
          renderCell(i, cand);
        });
        nudge.appendChild(ov);
        el.appendChild(nudge);
      }
    }
  }

  function renderGrid() {
    if (!session) return;
    grid.innerHTML = "";
    for (let i = 0; i < session.total; i++) {
      const col = document.createElement("div");
      col.className = "mc-col";
      const head = document.createElement("div");
      head.className = "mc-col-head";
      head.textContent = `フレーム${i + 1}`;
      const add = document.createElement("button");
      add.className = "btn btn-small";
      add.textContent = "追加生成";
      add.title = "この列にK+1個目の候補を追加";
      add.addEventListener("click", () => {
        const cand = { id: session.nextId++, status: "pending", variant: session.cands[i].length, source: "grid" };
        session.cands[i].push(cand);
        renderGrid();
        runOne(i, cand);
      });
      head.appendChild(add);
      col.appendChild(head);
      for (const cand of session.cands[i]) {
        const el = document.createElement("div");
        el.className = "mc-cell";
        el.dataset.cell = `${i}:${cand.id}`;
        fillCell(el, i, cand);
        col.appendChild(el);
      }
      grid.appendChild(col);
    }
    updateConfirmState();
  }

  // §25.9-3: ギャラリーでフレーム数 N を直接変更（増=空列追加 / 減=末尾を畳む・候補あり列は確認）
  function setTotal(n, opts = {}) {
    if (!session || session.confirmed) return false;
    n = Math.max(1, Math.min(12, Math.round(n)));
    if (n === session.total) {
      totalInput.value = String(n);
      return true;
    }
    if (n < session.total) {
      const hasCands = session.cands.slice(n).some((list) => list.length > 0);
      if (hasCands && !opts.force
        && !window.confirm(`フレーム${n + 1}〜${session.total}の候補は削除されます。フレーム数を${n}にしますか？`)) {
        totalInput.value = String(session.total);
        return false;
      }
      session.cands.length = n;
      session.adopted.length = n;
    } else {
      while (session.cands.length < n) {
        session.cands.push([]);
        session.adopted.push(null);
      }
    }
    session.total = n;
    totalInput.value = String(n);
    renderGrid();
    if (inflight === 0) setIdleProgress();
    return true;
  }

  // §25.9-2: 候補のフレーム列移動（採用は列ごとに1つの原則のまま・移動元の採用は解除）
  function moveCand(i, cand, j) {
    if (!session || j < 0 || j >= session.total || j === i) return;
    session.cands[i] = session.cands[i].filter((c) => c !== cand);
    if (session.adopted[i] === cand) session.adopted[i] = null;
    cand.variant = session.cands[j].length;
    session.cands[j].push(cand);
    renderGrid();
    if (inflight === 0) setIdleProgress();
  }

  function adopt(i, cand) {
    if (cand.status !== "ok") return;
    session.adopted[i] = session.adopted[i] === cand ? null : cand; // 再クリックで解除
    renderGrid();
    if (inflight === 0) setIdleProgress();
  }

  function updateConfirmState() {
    const ready = session && !session.confirmed && session.adopted.every(Boolean);
    confirmBtn.disabled = !ready;
  }

  // ---------------------------------------------------------------------
  // ミニプレビュー（採用中セットの連続再生・プロジェクトfps）
  // ---------------------------------------------------------------------
  function startPreview() {
    stopPreview();
    previewTimer = setInterval(() => {
      if (!session) return;
      const p = project();
      const frames = session.adopted.filter(Boolean);
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
  // 確定（§25.2: タイムライン末尾に追加+プリセット名のタグ付与）
  // ---------------------------------------------------------------------
  confirmBtn.addEventListener("click", () => {
    if (!session || session.confirmed || !session.adopted.every(Boolean)) return;
    const p = project();
    store.pushUndo();
    const start = p.frames.length;
    for (const cand of session.adopted) p.frames.push({ pixels: Uint8Array.from(cand.pixels) });
    const tag = addGeneratedTag(p, session.preset, start, start + session.total - 1);
    tag.fps = p.fps;
    store.state.activeTagIndex = p.tags.indexOf(tag);
    session.confirmed = true;
    session.insertedAt = start;
    totalInput.disabled = true; // §25.9-3: 確定後の N 変更は不可
    store.clampAfterProjectChange();
    store.state.currentFrame = start;
    store.notify();
    toast(`${session.total}フレームをタグ「${tag.name}」として追加しました`);
    // §25.2: 確定後の各フレームに「エディタで開く」
    confirmedBar.hidden = false;
    confirmedBar.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = `確定しました（フレーム${start}〜${start + session.total - 1}・タグ「${tag.name}」）: `;
    confirmedBar.appendChild(label);
    for (let i = 0; i < session.total; i++) {
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
  totalInput.addEventListener("change", () => setTotal(Number(totalInput.value)));
  abortBtn.addEventListener("click", () => {
    if (abortController) abortController.abort();
  });

  // 検証用フック（§25.7-6 の「スナップなし候補では適用不可」等をテストから注入するため）
  modal.__mcTest = {
    getSession: () => session,
    addCandidate(i, cand) {
      if (!session) return null;
      const c = { id: session.nextId++, status: "ok", variant: session.cands[i].length, source: "image", ...cand };
      session.cands[i].push(c);
      renderGrid();
      return c.id;
    },
  };

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
    session = {
      preset,
      presetLabel: PRESET_LABELS[preset] || preset,
      customText,
      total,
      k,
      nextId: 1,
      cands: Array.from({ length: total }, () => []),
      adopted: Array.from({ length: total }, () => null),
      confirmed: false,
      insertedAt: null,
    };
    confirmedBar.hidden = true;
    confirmedBar.innerHTML = "";
    totalInput.value = String(total);
    totalInput.disabled = false;
    modal.hidden = false;
    abortController = new AbortController();
    for (let i = 0; i < total; i++) {
      for (let kk = 0; kk < k; kk++) {
        session.cands[i].push({ id: session.nextId++, status: "pending", variant: kk, source: "grid" });
      }
    }
    renderGrid();
    startPreview();
    // N×K を発行（サーバー側キューの並列2に乗る）
    for (let i = 0; i < total; i++) {
      for (const cand of session.cands[i]) runOne(i, cand);
    }
  });
}
