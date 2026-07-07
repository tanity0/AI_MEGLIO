// ai.js — AIパネル・SSE受信・パッチ適用・モーション生成・再生プレビュー
import {
  frameToGridString,
  frameToPngDataUrl,
  pixelsToGridString,
  pixelsToPngDataUrl,
  indexForChar,
  drawFrameToContext,
} from "./app.js";

const PRESET_DEFAULT_FRAMES = { walk: 4, run: 6, attack: 3, idle: 2, jump: 4 };
const PRESET_LABELS = { walk: "歩き", run: "走り", attack: "攻撃", idle: "待機", jump: "ジャンプ", custom: "カスタム" };
const MAGNITUDE_LABELS = { small: "小", medium: "中", large: "大" };
const FACING_LABELS = { keep: "そのまま", right: "横（右向き）", left: "横（左向き）" };

export function initAi(store, toast) {
  const targetInfo = document.getElementById("targetInfo");
  const scopeRadios = Array.from(document.querySelectorAll('input[name="scope"]'));
  const instructionInput = document.getElementById("instructionInput");
  const runBtn = document.getElementById("runAiBtn");
  const abortBtn = document.getElementById("abortAiBtn");
  const progressEl = document.getElementById("aiProgress");
  const historyLog = document.getElementById("historyLog");
  const previewCanvas = document.getElementById("previewCanvas");
  const previewPlayToggle = document.getElementById("previewPlayToggle");

  // タブ・モーション生成UI
  const tabPatchBtn = document.getElementById("tabPatchBtn");
  const tabMotionBtn = document.getElementById("tabMotionBtn");
  const patchTab = document.getElementById("patchTab");
  const motionTab = document.getElementById("motionTab");
  const runMotionBtn = document.getElementById("runMotionBtn");
  const motionPreset = document.getElementById("motionPreset");
  const motionCustomText = document.getElementById("motionCustomText");
  const motionFrames = document.getElementById("motionFrames");
  const motionMagnitude = document.getElementById("motionMagnitude");
  const motionBounce = document.getElementById("motionBounce");
  const motionFacing = document.getElementById("motionFacing");

  let abortController = null;
  let userChoseScopeManually = false;

  // ---------------------------------------------------------------------
  // タブ切替（§13.3）
  // ---------------------------------------------------------------------
  function setTab(name) {
    const isPatch = name === "patch";
    tabPatchBtn.classList.toggle("is-active", isPatch);
    tabMotionBtn.classList.toggle("is-active", !isPatch);
    patchTab.hidden = !isPatch;
    motionTab.hidden = isPatch;
  }
  tabPatchBtn.addEventListener("click", () => setTab("patch"));
  tabMotionBtn.addEventListener("click", () => setTab("motion"));

  motionPreset.addEventListener("change", () => {
    const def = PRESET_DEFAULT_FRAMES[motionPreset.value];
    if (def) motionFrames.value = String(def);
  });

  // ---------------------------------------------------------------------
  // 対象情報表示 & スコープ自動切替
  // ---------------------------------------------------------------------
  function currentScope() {
    const checked = scopeRadios.find((r) => r.checked);
    return checked ? checked.value : "frame";
  }
  function setScope(value) {
    scopeRadios.forEach((r) => { r.checked = r.value === value; });
  }
  scopeRadios.forEach((r) => r.addEventListener("change", () => { userChoseScopeManually = true; }));

  function renderTargetInfo() {
    const sel = store.state.selection;
    if (sel) {
      targetInfo.textContent = `対象: フレーム${sel.frameIndex} の (${sel.x}, ${sel.y}) 〜 (${sel.x + sel.w}, ${sel.y + sel.h})`;
      if (!userChoseScopeManually) setScope("selection");
    } else {
      targetInfo.textContent = `対象: フレーム${store.state.currentFrame} 全体`;
      if (!userChoseScopeManually && currentScope() === "selection") setScope("frame");
    }
  }

  // 選択が変わったら「手動選択」フラグをリセットして自動追従に戻す
  let lastSelectionKey = "";
  store.subscribe(() => {
    const sel = store.state.selection;
    const key = sel ? `${sel.frameIndex}:${sel.x}:${sel.y}:${sel.w}:${sel.h}` : "";
    if (key !== lastSelectionKey) {
      userChoseScopeManually = false;
      lastSelectionKey = key;
    }
    renderTargetInfo();
  });

  // ---------------------------------------------------------------------
  // 履歴ログ
  // ---------------------------------------------------------------------
  function addHistoryEntry({ instruction, note, editedCells, addedFrames, warnings, error }) {
    const li = document.createElement("li");
    if (error) li.classList.add("is-error");
    const h = document.createElement("div");
    h.className = "h-instruction";
    h.textContent = instruction;
    li.appendChild(h);
    const d = document.createElement("div");
    d.className = "h-detail";
    if (error) {
      d.textContent = `エラー: ${error}`;
    } else {
      const parts = [];
      if (note) parts.push(note);
      parts.push(`適用セル数: ${editedCells}`);
      if (addedFrames) parts.push(`追加フレーム数: ${addedFrames}`);
      if (warnings && warnings.length) parts.push(`警告: ${warnings.join(" / ")}`);
      d.textContent = parts.join(" / ");
    }
    li.appendChild(d);
    historyLog.insertBefore(li, historyLog.firstChild);
  }

  // ---------------------------------------------------------------------
  // パッチ適用
  // ---------------------------------------------------------------------
  function applyPatch(patch) {
    const project = store.state.project;
    const changedCells = [];

    for (const e of patch.edits) {
      const frame = project.frames[e.frame];
      if (!frame) continue;
      for (let ry = 0; ry < e.rows.length; ry++) {
        const row = e.rows[ry];
        const py = e.y + ry;
        if (py < 0 || py >= project.height) continue;
        for (let rx = 0; rx < row.length; rx++) {
          const ch = row[rx];
          if (ch === "?") continue;
          const px = e.x + rx;
          if (px < 0 || px >= project.width) continue;
          const idx = indexForChar(ch);
          if (idx < 0 || idx >= project.palette.length) continue;
          frame.pixels[py * project.width + px] = idx;
          changedCells.push({ frame: e.frame, x: px, y: py });
        }
      }
    }

    const sortedNewFrames = [...patch.newFrames].sort((a, b) => b.insertAfter - a.insertAfter);
    let addedFrames = 0;
    for (const nf of sortedNewFrames) {
      const pixels = new Uint8Array(project.width * project.height);
      for (let y = 0; y < nf.rows.length && y < project.height; y++) {
        const row = nf.rows[y];
        for (let x = 0; x < row.length && x < project.width; x++) {
          const idx = indexForChar(row[x]);
          pixels[y * project.width + x] = idx >= 0 ? idx : 0;
        }
      }
      const insertIdx = Math.min(Math.max(nf.insertAfter + 1, 0), project.frames.length);
      project.frames.splice(insertIdx, 0, { pixels });
      addedFrames++;
    }

    for (const pc of patch.paletteChanges) {
      if (pc.index >= 0 && pc.index < project.palette.length) {
        project.palette[pc.index] = pc.color;
      } else if (pc.index === project.palette.length && project.palette.length < 32) {
        project.palette.push(pc.color);
      }
    }

    return { changedCells, addedFrames };
  }

  function flashChangedCells(changedCells) {
    const expiry = performance.now() + 1000;
    for (const c of changedCells) {
      store.state.flashCells.set(`${c.frame}:${c.x}:${c.y}`, expiry);
    }
    store.notify();
    setTimeout(() => {
      const now = performance.now();
      for (const [key, exp] of store.state.flashCells) {
        if (exp <= now) store.state.flashCells.delete(key);
      }
      store.notify();
    }, 1050);
  }

  // ---------------------------------------------------------------------
  // 画像添付フレームの決定
  // ---------------------------------------------------------------------
  function collectImageFrameIndexes(scope, frameIndex) {
    const project = store.state.project;
    const n = project.frames.length;
    if (scope === "all") {
      return Array.from({ length: n }, (_, i) => i);
    }
    const set = new Set();
    for (const i of [frameIndex - 1, frameIndex, frameIndex + 1]) {
      if (i >= 0 && i < n) set.add(i);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------
  // リクエスト共通フィールド（§13.4: baseFrameGrid と lockedRects は常に送る）
  // ---------------------------------------------------------------------
  function baseRequestFields() {
    const project = store.state.project;
    const fields = {
      project: {
        width: project.width,
        height: project.height,
        fps: project.fps,
        palette: project.palette,
        framesGrid: project.frames.map((_, i) => frameToGridString(project, i)),
      },
      lockedRects: (project.lockedRects || []).map((r) => ({ ...r })),
    };
    if (project.baseFrame) {
      fields.baseFrameGrid = pixelsToGridString(project.baseFrame, project.width, project.height);
    }
    return fields;
  }

  // ---------------------------------------------------------------------
  // 実行（修正タブ）
  // ---------------------------------------------------------------------
  async function runAi() {
    const instruction = instructionInput.value.trim();
    if (!instruction) {
      toast("指示を入力してください", "error");
      return;
    }
    const scope = currentScope();
    const project = store.state.project;
    const frameIndex = scope === "selection" && store.state.selection ? store.state.selection.frameIndex : store.state.currentFrame;

    if (scope === "selection" && !store.state.selection) {
      toast("選択範囲がありません。矩形選択ツールで範囲を選ぶか、スコープを変更してください", "error");
      return;
    }

    const images = collectImageFrameIndexes(scope, frameIndex).map((i) => ({
      frame: i,
      dataUrl: frameToPngDataUrl(project, i, 8),
    }));

    const body = {
      ...baseRequestFields(),
      mode: "patch",
      scope,
      instruction,
      images,
    };
    if (scope !== "all") body.frameIndex = frameIndex;
    if (scope === "selection") {
      const sel = store.state.selection;
      body.selection = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    }

    await executeEdit(body, instruction, (patch) => applyPatch(patch));
  }

  // ---------------------------------------------------------------------
  // 実行（モーション生成タブ・§13.3）
  // ---------------------------------------------------------------------
  function motionApplyMode() {
    const checked = document.querySelector('input[name="motionApply"]:checked');
    return checked ? checked.value : "replace";
  }

  async function runMotion() {
    const project = store.state.project;
    if (!project.baseFrame) {
      toast("ベースフレームがありません。「画像を開く」でドット絵を読み込んでください", "error");
      return;
    }
    const motion = {
      preset: motionPreset.value,
      customText: motionCustomText.value.trim(),
      frames: Math.max(2, Math.min(12, Number(motionFrames.value) || 4)),
      magnitude: motionMagnitude.value,
      bounce: motionBounce.checked,
      facing: motionFacing.value,
    };
    if (motion.preset === "custom" && !motion.customText) {
      toast("カスタムプリセットでは自由入力が必要です", "error");
      return;
    }

    const parts = [
      `「${PRESET_LABELS[motion.preset]}」モーションを${motion.frames}フレームで生成`,
      `動きの大きさ:${MAGNITUDE_LABELS[motion.magnitude]}`,
      `上下バウンス:${motion.bounce ? "あり" : "なし"}`,
      `向き:${FACING_LABELS[motion.facing]}`,
    ];
    let instruction = parts.join("、");
    if (motion.customText) instruction += `。${motion.customText}`;

    const body = {
      ...baseRequestFields(),
      mode: "motion",
      motion,
      scope: "all",
      instruction,
      images: [
        {
          frame: 0,
          dataUrl: pixelsToPngDataUrl(project.baseFrame, project.width, project.height, project.palette, 8),
        },
      ],
    };

    const applyMode = motionApplyMode();
    await executeEdit(body, instruction, (patch) => applyMotionPatch(patch, applyMode));
  }

  // モーション生成結果の適用: newFrames を置き換え/追記で反映
  function applyMotionPatch(patch, applyMode) {
    const project = store.state.project;
    const framesPixels = patch.newFrames.map((nf) => {
      const pixels = new Uint8Array(project.width * project.height);
      for (let y = 0; y < nf.rows.length && y < project.height; y++) {
        const row = nf.rows[y];
        for (let x = 0; x < row.length && x < project.width; x++) {
          const idx = indexForChar(row[x]);
          pixels[y * project.width + x] = idx >= 0 && idx < project.palette.length ? idx : 0;
        }
      }
      return { pixels };
    });

    if (framesPixels.length > 0) {
      if (applyMode === "replace") {
        project.frames = [project.frames[0], ...framesPixels];
      } else {
        project.frames.push(...framesPixels);
      }
    }
    store.clampAfterProjectChange();

    // edits / paletteChanges は通常のパッチとして適用（newFramesは処理済み）
    const { changedCells } = applyPatch({ ...patch, newFrames: [] });
    return { changedCells, addedFrames: framesPixels.length };
  }

  // ---------------------------------------------------------------------
  // SSE共通処理
  // ---------------------------------------------------------------------
  async function executeEdit(body, instruction, applyFn) {
    abortController = new AbortController();
    store.state.aiBusy = true;
    runBtn.disabled = true;
    runMotionBtn.disabled = true;
    abortBtn.disabled = false;
    progressEl.classList.add("is-busy");
    let receivedChars = 0;
    progressEl.textContent = "送信中…";

    let pushedUndo = false;

    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) {
        let msg = `サーバーエラー (HTTP ${res.status})`;
        try {
          const errJson = await res.json();
          if (errJson.error) msg = errJson.error;
        } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIdx;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const jsonText = line.slice(5).trim();
          let evt;
          try { evt = JSON.parse(jsonText); } catch { continue; }

          if (evt.type === "delta") {
            receivedChars += evt.text.length;
            progressEl.textContent = `生成中… (${receivedChars}文字受信)`;
          } else if (evt.type === "result") {
            if (!pushedUndo) { store.pushUndo(); pushedUndo = true; }
            const { changedCells, addedFrames } = applyFn(evt.patch);
            flashChangedCells(changedCells);
            store.notify();
            addHistoryEntry({
              instruction,
              note: evt.patch.note,
              editedCells: changedCells.length,
              addedFrames,
              warnings: evt.patch.warnings,
            });
            progressEl.textContent = `完了（適用セル数: ${changedCells.length}）`;
            finished = true;
          } else if (evt.type === "error") {
            addHistoryEntry({ instruction, error: evt.message });
            toast(evt.message, "error");
            progressEl.textContent = `エラー: ${evt.message}`;
            finished = true;
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        progressEl.textContent = "中断しました";
        addHistoryEntry({ instruction, error: "ユーザーにより中断されました" });
      } else {
        progressEl.textContent = `エラー: ${err.message}`;
        addHistoryEntry({ instruction, error: err.message });
        toast(err.message, "error");
      }
    } finally {
      store.state.aiBusy = false;
      runBtn.disabled = false;
      runMotionBtn.disabled = false;
      abortBtn.disabled = true;
      progressEl.classList.remove("is-busy");
      abortController = null;
    }
  }

  runBtn.addEventListener("click", runAi);
  runMotionBtn.addEventListener("click", runMotion);
  abortBtn.addEventListener("click", () => {
    if (abortController) abortController.abort();
  });
  instructionInput.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      if (!runBtn.disabled) runAi();
    }
  });

  // ---------------------------------------------------------------------
  // 再生プレビュー（常時ループ、AIパネル下部）
  // ---------------------------------------------------------------------
  let previewFrame = 0;
  let previewAcc = 0;
  let lastTs = null;

  function sizePreviewCanvas() {
    const p = store.state.project;
    const cellSize = Math.max(1, Math.min(6, Math.floor(160 / Math.max(p.width, p.height))));
    previewCanvas.width = p.width * cellSize;
    previewCanvas.height = p.height * cellSize;
    return cellSize;
  }

  let previewCellSize = sizePreviewCanvas();
  store.subscribe(() => {
    const p = store.state.project;
    if (previewFrame >= p.frames.length) previewFrame = 0;
    previewCellSize = sizePreviewCanvas();
  });

  function previewTick(ts) {
    requestAnimationFrame(previewTick);
    if (!previewPlayToggle.checked) { lastTs = ts; return; }
    const p = store.state.project;
    if (!p.frames.length) return;
    if (lastTs === null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    previewAcc += dt;
    const frameDuration = 1000 / Math.max(1, p.fps);
    while (previewAcc >= frameDuration) {
      previewAcc -= frameDuration;
      previewFrame = (previewFrame + 1) % p.frames.length;
    }
    const ctx = previewCanvas.getContext("2d");
    drawFrameToContext(ctx, p, previewFrame, previewCellSize);
  }
  requestAnimationFrame(previewTick);

  renderTargetInfo();
}
