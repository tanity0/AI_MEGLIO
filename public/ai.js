// ai.js — AIパネル・SSE受信・パッチ適用・モーション生成・再生プレビュー
import {
  frameToGridString,
  frameToPngDataUrl,
  pixelsToGridString,
  pixelsToPngDataUrl,
  indexForChar,
  indexForToken,
  splitTokens,
  cellChars,
  drawFrameToContext,
  adjustTagsOnInsert,
  adjustTagsOnDelete,
  addGeneratedTag,
  styleRequestFields,
} from "./app.js";
import { streamEdit } from "./api.js";

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
  const tabRigBtn = document.getElementById("tabRigBtn");
  const patchTab = document.getElementById("patchTab");
  const motionTab = document.getElementById("motionTab");
  const rigTab = document.getElementById("rigTab");
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
  // タブ切替（§13.3 / §14.5）
  // ---------------------------------------------------------------------
  const tabs = [
    { name: "patch", btn: tabPatchBtn, body: patchTab },
    { name: "motion", btn: tabMotionBtn, body: motionTab },
    { name: "rig", btn: tabRigBtn, body: rigTab },
  ];
  function setTab(name) {
    for (const t of tabs) {
      t.btn.classList.toggle("is-active", t.name === name);
      t.body.hidden = t.name !== name;
    }
    // リグの「ドラッグ移動」モードはリグタブ以外では無効化
    if (name !== "rig" && store.state.rigAdjustMode) {
      store.state.rigAdjustMode = false;
      store.notify();
    }
  }
  for (const t of tabs) t.btn.addEventListener("click", () => setTab(t.name));

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

  // §18.4: 高解像度・多色時のヒント
  const hiResHint = document.getElementById("hiResHint");
  const rigRecommendBanner = document.getElementById("rigRecommendBanner");
  function renderHiResHints() {
    const p = store.state.project;
    const big = p.palette.length > 32 || p.width > 64 || p.height > 64;
    hiResHint.hidden = !big;
    rigRecommendBanner.hidden = !big;
  }

  // 選択が変わったら「手動選択」フラグをリセットして自動追従に戻す
  let lastSelectionKey = "";
  store.subscribe(() => {
    renderHiResHints();
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

    const cw = cellChars(project.palette.length);
    const wide = cw === 2;
    for (const e of patch.edits) {
      const frame = project.frames[e.frame];
      if (!frame) continue;
      for (let ry = 0; ry < e.rows.length; ry++) {
        const tokens = splitTokens(e.rows[ry], cw);
        const py = e.y + ry;
        if (py < 0 || py >= project.height) continue;
        for (let rx = 0; rx < tokens.length; rx++) {
          const idx = indexForToken(tokens[rx], wide);
          if (idx < 0) continue; // '?'/不正はスキップ
          const px = e.x + rx;
          if (px < 0 || px >= project.width) continue;
          if (idx >= project.palette.length) continue;
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
        const tokens = splitTokens(nf.rows[y], cw);
        for (let x = 0; x < tokens.length && x < project.width; x++) {
          const idx = indexForToken(tokens[x], wide);
          pixels[y * project.width + x] = idx >= 0 && idx < project.palette.length ? idx : 0;
        }
      }
      const insertIdx = Math.min(Math.max(nf.insertAfter + 1, 0), project.frames.length);
      project.frames.splice(insertIdx, 0, { pixels });
      adjustTagsOnInsert(project, insertIdx, 1); // §16.1: タグ範囲の自動補正
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
      fields.baseFrameGrid = pixelsToGridString(project.baseFrame, project.width, project.height, project.palette.length);
    }
    Object.assign(fields, styleRequestFields(project, store.state.serverConfig)); // §17.3
    if (project.mainPalette) fields.mainPalette = project.mainPalette; // §18.3
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
    await executeEdit(body, instruction, (patch) => applyMotionPatch(patch, applyMode, motion.preset));
  }

  // モーション生成結果の適用: newFrames を置き換え/追記で反映（結果は新タグ化・§16.1）
  function applyMotionPatch(patch, applyMode, presetName = "motion") {
    const project = store.state.project;
    const mcw = cellChars(project.palette.length);
    const mwide = mcw === 2;
    const framesPixels = patch.newFrames.map((nf) => {
      const pixels = new Uint8Array(project.width * project.height);
      for (let y = 0; y < nf.rows.length && y < project.height; y++) {
        const tokens = splitTokens(nf.rows[y], mcw);
        for (let x = 0; x < tokens.length && x < project.width; x++) {
          const idx = indexForToken(tokens[x], mwide);
          pixels[y * project.width + x] = idx >= 0 && idx < project.palette.length ? idx : 0;
        }
      }
      return { pixels };
    });

    if (framesPixels.length > 0) {
      let start;
      if (applyMode === "replace") {
        // 置き換え: フレーム1以降を削除 → 生成フレームを挿入（タグ範囲を追随補正）
        const removed = project.frames.length - 1;
        project.frames = [project.frames[0]];
        for (let i = 0; i < removed; i++) adjustTagsOnDelete(project, 1);
        start = 1;
        project.frames.push(...framesPixels);
        adjustTagsOnInsert(project, 1, framesPixels.length);
      } else {
        start = project.frames.length;
        project.frames.push(...framesPixels);
      }
      const tag = addGeneratedTag(project, presetName, start, start + framesPixels.length - 1);
      store.state.activeTagIndex = project.tags.indexOf(tag);
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
    let lastSplitProgress = "";
    const startedAt = Date.now();
    // 実行中は経過秒を常時表示（§15.5-4）
    const renderProgress = () => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      const tail = lastSplitProgress ? ` / ${lastSplitProgress}` : "";
      progressEl.textContent = `生成中… (${receivedChars}文字受信・${sec}秒経過)${tail}`;
    };
    const progressTimer = setInterval(renderProgress, 1000);
    progressEl.textContent = "送信中…";

    try {
      const evt = await streamEdit(body, {
        signal: abortController.signal,
        onDelta: (text) => {
          receivedChars += text.length;
          if (text.includes("フレーム") && text.includes("完了")) lastSplitProgress = text;
          renderProgress();
        },
      });
      store.pushUndo();
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
      clearInterval(progressTimer);
      store.state.aiBusy = false;
      runBtn.disabled = false;
      runMotionBtn.disabled = false;
      abortBtn.disabled = true;
      progressEl.classList.remove("is-busy");
      abortController = null;
    }
  }

  // ---------------------------------------------------------------------
  // 配色バリエーション（mode:"palette"・§16.2）: 候補プレビュー→適用/保存
  // ---------------------------------------------------------------------
  const paletteSwapBtn = document.getElementById("paletteSwapBtn");
  const paletteCandidate = document.getElementById("paletteCandidate");
  const paletteCandidateCanvas = document.getElementById("paletteCandidateCanvas");
  const paletteCandidateNote = document.getElementById("paletteCandidateNote");
  const paletteApplyBtn = document.getElementById("paletteApplyBtn");
  const paletteSaveVariantBtn = document.getElementById("paletteSaveVariantBtn");
  const paletteDiscardBtn = document.getElementById("paletteDiscardBtn");

  let candidatePalette = null;
  let candidateInstruction = "";

  function renderCandidatePreview() {
    const p = store.state.project;
    if (!candidatePalette) return;
    const cellSize = Math.max(1, Math.min(5, Math.floor(140 / Math.max(p.width, p.height))));
    paletteCandidateCanvas.width = p.width * cellSize;
    paletteCandidateCanvas.height = p.height * cellSize;
    const ctx = paletteCandidateCanvas.getContext("2d");
    const base = p.baseFrame || p.frames[0].pixels;
    const tmp = { width: p.width, height: p.height, palette: candidatePalette, frames: [{ pixels: base }] };
    drawFrameToContext(ctx, tmp, 0, cellSize);
  }

  async function runPaletteSwap() {
    const instruction = instructionInput.value.trim();
    if (!instruction) {
      toast("配色の指示を入力してください（例:「毒々しい緑基調に」）", "error");
      return;
    }
    const project = store.state.project;
    const base = project.baseFrame || project.frames[0].pixels;
    const body = {
      ...baseRequestFields(),
      mode: "palette",
      scope: "frame",
      frameIndex: 0,
      instruction,
      images: [],
    };
    if (!body.baseFrameGrid) {
      body.baseFrameGrid = pixelsToGridString(base, project.width, project.height, project.palette.length);
    }

    abortController = new AbortController();
    runBtn.disabled = true;
    paletteSwapBtn.disabled = true;
    abortBtn.disabled = false;
    progressEl.classList.add("is-busy");
    progressEl.textContent = "配色を生成中…";
    try {
      const evt = await streamEdit(body, { signal: abortController.signal });
      const result = evt.palette;
      if (!result || !result.paletteChanges.length) {
        throw new Error("配色の変更が返されませんでした");
      }
      candidatePalette = project.palette.slice();
      for (const pc of result.paletteChanges) {
        if (pc.index < candidatePalette.length) candidatePalette[pc.index] = pc.color;
      }
      candidateInstruction = instruction;
      paletteCandidateNote.textContent =
        `${result.note}（変更色数: ${result.paletteChanges.length}）` +
        (result.warnings?.length ? ` / 警告: ${result.warnings.join(" / ")}` : "");
      paletteCandidate.hidden = false;
      renderCandidatePreview();
      progressEl.textContent = "配色候補を生成しました";
      addHistoryEntry({ instruction: `[配色] ${instruction}`, note: result.note, editedCells: 0, warnings: result.warnings });
    } catch (err) {
      progressEl.textContent = err.name === "AbortError" ? "中断しました" : `エラー: ${err.message}`;
      if (err.name !== "AbortError") {
        toast(err.message, "error");
        addHistoryEntry({ instruction: `[配色] ${instruction}`, error: err.message });
      }
    } finally {
      runBtn.disabled = false;
      paletteSwapBtn.disabled = false;
      abortBtn.disabled = true;
      progressEl.classList.remove("is-busy");
      abortController = null;
    }
  }

  // §18.2: AI輪郭リファイン — 透明/非透明境界から2px以内だけをcleanup
  const outlineRefineBtn = document.getElementById("outlineRefineBtn");
  function buildBoundaryMask(project, frameIndex) {
    const { width, height } = project;
    const px = project.frames[frameIndex].pixels;
    const rows = [];
    for (let y = 0; y < height; y++) {
      let row = "";
      for (let x = 0; x < width; x++) {
        let boundary = false;
        const self = px[y * width + x] === 0;
        for (let dy = -2; dy <= 2 && !boundary; dy++) {
          for (let dx = -2; dx <= 2 && !boundary; dx++) {
            const nx = x + dx, ny = y + dy;
            const other = nx < 0 || ny < 0 || nx >= width || ny >= height
              ? true
              : px[ny * width + nx] === 0;
            if (other !== self) boundary = true;
          }
        }
        row += boundary ? "1" : "0";
      }
      rows.push(row);
    }
    return rows.join("\n");
  }
  outlineRefineBtn.addEventListener("click", async () => {
    const project = store.state.project;
    const fi = store.state.currentFrame;
    const body = {
      ...baseRequestFields(),
      mode: "cleanup",
      scope: "frame",
      frameIndex: fi,
      allowedMask: buildBoundaryMask(project, fi),
      instruction: "変換で甘くなった輪郭とハイライトを、透明境界付近だけ最小差分で清書してください",
      images: [{ frame: fi, dataUrl: frameToPngDataUrl(project, fi, project.width > 64 ? 4 : 8) }],
    };
    await executeEdit(body, "[輪郭リファイン]", (patch) => applyPatch(patch));
  });

  // -------------------------------------------------------------------
  // §19 部分仕上げ（mode:"refine"）: 選択範囲のラフ編集をトンマナに合わせて清書
  // -------------------------------------------------------------------
  const refineBtn = document.getElementById("refineBtn");
  const refineAllTag = document.getElementById("refineAllTag");
  const REFINE_DEFAULT_INSTRUCTION = "選択範囲の輪郭とシェーディングを整えてください（シルエット・形の意図は保持）";

  store.subscribe(() => {
    const sel = store.state.selection;
    refineBtn.disabled = !sel || store.state.aiBusy;
    refineBtn.title = sel ? "選択範囲のラフ編集を綺麗なドットに清書（§19）" : "範囲を選択してください";
  });

  // 選択矩形+外周1px の許可マスク（§19.1）
  function buildSelectionMask(project, sel) {
    const rows = [];
    for (let y = 0; y < project.height; y++) {
      let row = "";
      for (let x = 0; x < project.width; x++) {
        row += x >= sel.x - 1 && x < sel.x + sel.w + 1 && y >= sel.y - 1 && y < sel.y + sel.h + 1 ? "1" : "0";
      }
      rows.push(row);
    }
    return rows.join("\n");
  }

  // 前後フレームの同じ矩形の切り出し（存在するフレームのみ・§19.1）
  function buildNeighborContext(project, frameIndex, sel) {
    const cw = cellChars(project.palette.length);
    const out = [];
    for (const nf of [frameIndex - 1, frameIndex + 1]) {
      if (nf < 0 || nf >= project.frames.length) continue;
      const gridRows = frameToGridString(project, nf).split("\n");
      const rows = [];
      for (let y = sel.y; y < sel.y + sel.h; y++) {
        rows.push(gridRows[y].slice(sel.x * cw, (sel.x + sel.w) * cw));
      }
      out.push({ frame: nf, rows });
    }
    return out.slice(0, 2);
  }

  async function runRefine() {
    const sel = store.state.selection;
    if (!sel) {
      toast("範囲を選択してください", "error");
      return;
    }
    const project = store.state.project;
    const instruction = instructionInput.value.trim() || REFINE_DEFAULT_INSTRUCTION;
    const rect = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    const allTag = refineAllTag.checked;

    let frameIndexes = [sel.frameIndex];
    if (allTag) {
      const ti = store.state.activeTagIndex;
      const tag = ti >= 0 && project.tags[ti] ? project.tags[ti] : null;
      if (!tag) {
        toast("タグが選択されていないため、このフレームのみに適用します");
      } else {
        frameIndexes = [];
        for (let f = tag.start; f <= Math.min(tag.end, project.frames.length - 1); f++) frameIndexes.push(f);
      }
    }

    const common = baseRequestFields();
    const mask = buildSelectionMask(project, rect);
    const makeBody = (fi) => ({
      ...common,
      mode: "refine",
      scope: "frame",
      frameIndex: fi,
      allowedMask: mask,
      neighborContext: buildNeighborContext(project, fi, rect),
      instruction,
      images: [{ frame: fi, dataUrl: frameToPngDataUrl(project, fi, project.width > 64 ? 4 : 8) }],
    });

    if (frameIndexes.length === 1) {
      await executeEdit(makeBody(frameIndexes[0]), `[整える] ${instruction}`, (patch) => applyPatch(patch));
      return;
    }

    // タグ全フレーム: 並列リクエスト（部分失敗は警告・§19.2）
    abortController = new AbortController();
    store.state.aiBusy = true;
    runBtn.disabled = true;
    refineBtn.disabled = true;
    abortBtn.disabled = false;
    progressEl.classList.add("is-busy");
    let done = 0;
    progressEl.textContent = `整え中… 0/${frameIndexes.length}`;
    const results = await Promise.allSettled(
      frameIndexes.map((fi) =>
        streamEdit(makeBody(fi), { signal: abortController.signal }).then((evt) => {
          done++;
          progressEl.textContent = `整え中… ${done}/${frameIndexes.length}`;
          return { fi, evt };
        })
      )
    );
    abortController = null;
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message || String(r.reason));
    if (ok.length) {
      store.pushUndo();
      let cells = 0;
      const warnings = [];
      for (const { evt } of ok) {
        const { changedCells } = applyPatch(evt.patch);
        cells += changedCells.length;
        flashChangedCells(changedCells);
        if (evt.patch.warnings?.length) warnings.push(...evt.patch.warnings);
      }
      store.notify();
      if (failed.length) warnings.push(`${failed.length}フレームの整えに失敗: ${failed[0]}`);
      addHistoryEntry({
        instruction: `[整える×${frameIndexes.length}] ${instruction}`,
        note: ok[0].evt.patch.note,
        editedCells: cells,
        warnings: [...new Set(warnings)],
      });
      progressEl.textContent = `整え完了: ${ok.length}/${frameIndexes.length}フレーム（適用セル数 ${cells}）`;
    } else {
      const aborted = failed.some((e) => /abort/i.test(e));
      progressEl.textContent = aborted ? "中断しました" : `エラー: ${failed[0]}`;
      if (!aborted) {
        toast(failed[0], "error");
        addHistoryEntry({ instruction: `[整える] ${instruction}`, error: failed[0] });
      }
    }
    store.state.aiBusy = false;
    runBtn.disabled = false;
    refineBtn.disabled = !store.state.selection;
    abortBtn.disabled = true;
    progressEl.classList.remove("is-busy");
  }
  refineBtn.addEventListener("click", runRefine);

  paletteSwapBtn.addEventListener("click", runPaletteSwap);
  paletteApplyBtn.addEventListener("click", () => {
    if (!candidatePalette) return;
    const project = store.state.project;
    store.pushUndo();
    project.palette = candidatePalette.slice();
    store.notify();
    paletteCandidate.hidden = true;
    candidatePalette = null;
    toast("配色をこのプロジェクトに適用しました");
  });
  paletteSaveVariantBtn.addEventListener("click", () => {
    if (!candidatePalette) return;
    const project = store.state.project;
    const name = prompt("バリエーション名を入力してください", candidateInstruction.slice(0, 16)) ;
    if (name === null) return;
    const trimmed = name.trim().slice(0, 32) || `variant_${(project.variants || []).length + 1}`;
    store.pushUndo();
    if (!Array.isArray(project.variants)) project.variants = [];
    project.variants.push({ name: trimmed, palette: candidatePalette.slice() });
    store.notify();
    paletteCandidate.hidden = true;
    candidatePalette = null;
    toast(`バリエーション「${trimmed}」を保存しました（書き出しに含まれます）`);
  });
  paletteDiscardBtn.addEventListener("click", () => {
    paletteCandidate.hidden = true;
    candidatePalette = null;
  });

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
    // 選択タグがあればその範囲・そのfpsでループ（§16.1）
    const ti = store.state.activeTagIndex;
    const tag = ti >= 0 && p.tags && p.tags[ti] ? p.tags[ti] : null;
    const start = tag ? tag.start : 0;
    const end = tag ? Math.min(tag.end, p.frames.length - 1) : p.frames.length - 1;
    const fps = tag ? tag.fps : p.fps;
    const frameDuration = 1000 / Math.max(1, fps);
    while (previewAcc >= frameDuration) {
      previewAcc -= frameDuration;
      previewFrame = previewFrame + 1 > end || previewFrame + 1 < start ? start : previewFrame + 1;
    }
    if (previewFrame < start || previewFrame > end) previewFrame = start;
    const ctx = previewCanvas.getContext("2d");
    const smoothToggle = document.getElementById("previewSmoothToggle");
    if (smoothToggle && smoothToggle.checked) {
      // linear相当の見え方を再現: 実寸で描いてから補間つきで拡大
      if (!previewTick._off) previewTick._off = document.createElement("canvas");
      const off = previewTick._off;
      off.width = p.width; off.height = p.height;
      drawFrameToContext(off.getContext("2d"), p, previewFrame, 1);
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, previewCanvas.width, previewCanvas.height);
    } else {
      ctx.imageSmoothingEnabled = false;
      drawFrameToContext(ctx, p, previewFrame, previewCellSize);
    }
  }
  requestAnimationFrame(previewTick);

  renderTargetInfo();
}
