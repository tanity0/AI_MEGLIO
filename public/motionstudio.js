// motionstudio.js — §25 モーション候補スタジオ（生成→選別→確定）
// N×K 個の独立した単フレーム生成（mode:"motionframe"）を並列発行し、
// ギャラリーで採用/削除/描き直し/追加生成 → 全フレーム採用で確定（タグ付きで末尾に追加）。
import { streamEdit } from "./api.js";
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
} from "./app.js";

const PRESET_LABELS = { walk: "歩き", run: "走り", attack: "攻撃", idle: "待機", jump: "ジャンプ", custom: "カスタム" };

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
  function drawCand(canvas, pixels) {
    const p = project();
    const sc = cellScale();
    canvas.width = p.width * sc;
    canvas.height = p.height * sc;
    const tmp = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels }] };
    drawFrameToContext(canvas.getContext("2d"), tmp, 0, sc);
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
      cv.title = cand.warn || `候補${cand.variant + 1}`;
      drawCand(cv, cand.pixels);
      cv.addEventListener("click", () => adopt(i, cand));
      el.appendChild(cv);
      const row = document.createElement("div");
      row.className = "mc-cell-actions";
      const adoptBtn = document.createElement("button");
      adoptBtn.className = "btn btn-small" + (session.adopted[i] === cand ? " btn-accent" : "");
      adoptBtn.textContent = session.adopted[i] === cand ? "採用中" : "採用";
      adoptBtn.addEventListener("click", () => adopt(i, cand));
      row.appendChild(adoptBtn);
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
      previewIdx = (previewIdx + 1) % frames.length;
      const tmp = { width: p.width, height: p.height, palette: p.palette, frames: [{ pixels: frames[previewIdx].pixels }] };
      drawFrameToContext(ctx, tmp, 0, sc);
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
    if (abortController) abortController.abort();
    abortController = null;
    inflight = 0;
    stopPreview();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    modal.hidden = true;
  }
  closeBtn.addEventListener("click", closeModal);
  abortBtn.addEventListener("click", () => {
    if (abortController) abortController.abort();
  });

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
