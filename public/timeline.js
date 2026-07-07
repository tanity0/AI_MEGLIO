// timeline.js — フレーム一覧・タグバー（§16.1）・再生（タイムラインバー）
import { drawFrameToContext, deviationPercent, adjustTagsOnInsert, adjustTagsOnDelete, uniqueTagName } from "./app.js";

const THUMB_SIZE = 48;

export function initTimeline(store, toast) {
  const frameList = document.getElementById("frameList");
  const addBtn = document.getElementById("frameAddBtn");
  const dupBtn = document.getElementById("frameDupBtn");
  const delBtn = document.getElementById("frameDelBtn");
  const moveLeftBtn = document.getElementById("frameMoveLeftBtn");
  const moveRightBtn = document.getElementById("frameMoveRightBtn");
  const fpsInput = document.getElementById("fpsInput");
  const playBtn = document.getElementById("playBtn");
  const tagList = document.getElementById("tagList");
  const tagAddBtn = document.getElementById("tagAddBtn");
  const tagForm = document.getElementById("tagForm");
  const tagNameInput = document.getElementById("tagNameInput");
  const tagStartInput = document.getElementById("tagStartInput");
  const tagEndInput = document.getElementById("tagEndInput");
  const tagFpsInput = document.getElementById("tagFpsInput");
  const tagLoopInput = document.getElementById("tagLoopInput");
  const tagSaveBtn = document.getElementById("tagSaveBtn");
  const tagDeleteBtn = document.getElementById("tagDeleteBtn");
  const tagCancelBtn = document.getElementById("tagCancelBtn");

  let editingTagIndex = null; // null = 非表示, -1 = 新規作成, >=0 = 既存タグ編集

  function project() { return store.state.project; }
  function activeTag() {
    const p = project();
    const i = store.state.activeTagIndex;
    return i >= 0 && p.tags && p.tags[i] ? p.tags[i] : null;
  }

  // ---------------------------------------------------------------------
  // フレーム操作（タグ範囲の自動補正付き・§16.1）
  // ---------------------------------------------------------------------
  addBtn.addEventListener("click", () => {
    const p = project();
    store.pushUndo();
    const pixels = new Uint8Array(p.width * p.height);
    const at = store.state.currentFrame + 1;
    p.frames.splice(at, 0, { pixels });
    adjustTagsOnInsert(p, at, 1);
    store.state.currentFrame += 1;
    store.notify();
  });

  dupBtn.addEventListener("click", () => {
    const p = project();
    store.pushUndo();
    const src = p.frames[store.state.currentFrame];
    const at = store.state.currentFrame + 1;
    p.frames.splice(at, 0, { pixels: Uint8Array.from(src.pixels) });
    adjustTagsOnInsert(p, at, 1);
    store.state.currentFrame += 1;
    store.notify();
  });

  delBtn.addEventListener("click", () => {
    const p = project();
    if (p.frames.length <= 1) {
      toast("最後の1フレームは削除できません", "error");
      return;
    }
    store.pushUndo();
    const at = store.state.currentFrame;
    p.frames.splice(at, 1);
    adjustTagsOnDelete(p, at);
    if (store.state.currentFrame >= p.frames.length) store.state.currentFrame = p.frames.length - 1;
    if (store.state.selection && store.state.selection.frameIndex >= p.frames.length) store.state.selection = null;
    store.clampAfterProjectChange();
    store.notify();
  });

  moveLeftBtn.addEventListener("click", () => {
    const p = project();
    const i = store.state.currentFrame;
    if (i <= 0) return;
    store.pushUndo();
    [p.frames[i - 1], p.frames[i]] = [p.frames[i], p.frames[i - 1]];
    store.state.currentFrame = i - 1;
    store.notify();
  });

  moveRightBtn.addEventListener("click", () => {
    const p = project();
    const i = store.state.currentFrame;
    if (i >= p.frames.length - 1) return;
    store.pushUndo();
    [p.frames[i + 1], p.frames[i]] = [p.frames[i], p.frames[i + 1]];
    store.state.currentFrame = i + 1;
    store.notify();
  });

  fpsInput.addEventListener("change", () => {
    const p = project();
    let v = Number(fpsInput.value);
    if (!Number.isInteger(v) || v < 1) v = 1;
    if (v > 24) v = 24;
    p.fps = v;
    fpsInput.value = String(v);
    store.notify();
  });

  // ---------------------------------------------------------------------
  // タグバー（§16.1）
  // ---------------------------------------------------------------------
  function openTagForm(index) {
    const p = project();
    editingTagIndex = index;
    if (index >= 0) {
      const t = p.tags[index];
      tagNameInput.value = t.name;
      tagStartInput.value = String(t.start);
      tagEndInput.value = String(t.end);
      tagFpsInput.value = String(t.fps);
      tagLoopInput.checked = t.loop;
      tagDeleteBtn.hidden = false;
    } else {
      tagNameInput.value = uniqueTagName(p, "tag");
      tagStartInput.value = String(store.state.currentFrame);
      tagEndInput.value = String(store.state.currentFrame);
      tagFpsInput.value = String(p.fps);
      tagLoopInput.checked = true;
      tagDeleteBtn.hidden = true;
    }
    tagForm.hidden = false;
    tagNameInput.focus();
  }
  function closeTagForm() {
    editingTagIndex = null;
    tagForm.hidden = true;
  }

  tagAddBtn.addEventListener("click", () => openTagForm(-1));
  tagCancelBtn.addEventListener("click", closeTagForm);

  tagSaveBtn.addEventListener("click", () => {
    const p = project();
    const name = tagNameInput.value.trim();
    const start = Number(tagStartInput.value);
    const end = Number(tagEndInput.value);
    let fps = Number(tagFpsInput.value);
    if (!name) { toast("タグ名を入力してください", "error"); return; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= p.frames.length || start > end) {
      toast(`範囲が不正です（0〜${p.frames.length - 1}、start ≦ end）`, "error");
      return;
    }
    if (!Number.isInteger(fps) || fps < 1) fps = 1;
    if (fps > 24) fps = 24;
    const dup = p.tags.findIndex((t, i) => t.name === name && i !== editingTagIndex);
    if (dup !== -1) { toast(`タグ名「${name}」は既に存在します`, "error"); return; }

    store.pushUndo();
    const tag = { name, start, end, fps, loop: tagLoopInput.checked };
    if (editingTagIndex >= 0) {
      p.tags[editingTagIndex] = tag;
      store.state.activeTagIndex = editingTagIndex;
    } else {
      p.tags.push(tag);
      store.state.activeTagIndex = p.tags.length - 1;
    }
    closeTagForm();
    store.notify();
  });

  tagDeleteBtn.addEventListener("click", () => {
    const p = project();
    if (editingTagIndex === null || editingTagIndex < 0) return;
    store.pushUndo();
    p.tags.splice(editingTagIndex, 1); // フレームは消さない
    if (store.state.activeTagIndex === editingTagIndex) store.state.activeTagIndex = -1;
    else if (store.state.activeTagIndex > editingTagIndex) store.state.activeTagIndex--;
    closeTagForm();
    store.notify();
  });

  function renderTags() {
    const p = project();
    tagList.innerHTML = "";

    const allChip = document.createElement("button");
    allChip.className = "tag-chip" + (store.state.activeTagIndex === -1 ? " is-active" : "");
    allChip.textContent = "全体";
    allChip.title = "タグ選択を解除（全フレームを再生・書き出し対象に）";
    allChip.addEventListener("click", () => {
      store.state.activeTagIndex = -1;
      closeTagForm();
      store.notify();
    });
    tagList.appendChild(allChip);

    (p.tags || []).forEach((t, i) => {
      const chip = document.createElement("button");
      chip.className = "tag-chip" + (i === store.state.activeTagIndex ? " is-active" : "");
      chip.innerHTML = "";
      chip.textContent = `${t.name} [${t.start}-${t.end}]`;
      chip.title = `fps:${t.fps} loop:${t.loop ? "on" : "off"}（クリックで選択、ダブルクリックで編集）`;
      chip.addEventListener("click", () => {
        store.state.activeTagIndex = i;
        if (store.state.currentFrame < t.start || store.state.currentFrame > t.end) {
          store.state.currentFrame = t.start;
        }
        store.notify();
      });
      chip.addEventListener("dblclick", () => openTagForm(i));
      tagList.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------------
  // タイムライン再生（選択タグがあればその範囲・そのfpsでループ）
  // ---------------------------------------------------------------------
  let playTimer = null;
  function playFps() {
    const t = activeTag();
    return t ? t.fps : project().fps;
  }
  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    store.state.timelinePlaying = false;
    playBtn.textContent = "▶ 再生";
  }
  function startPlay() {
    const p = project();
    store.state.timelinePlaying = true;
    playBtn.textContent = "■ 停止";
    const tick = () => {
      const pp = project();
      const t = activeTag();
      const start = t ? t.start : 0;
      const end = t ? Math.min(t.end, pp.frames.length - 1) : pp.frames.length - 1;
      let next = store.state.currentFrame + 1;
      if (next > end || next < start) next = start;
      store.state.currentFrame = next;
      store.notify();
    };
    playTimer = setInterval(tick, Math.max(1000 / Math.max(1, playFps()), 16));
  }
  playBtn.addEventListener("click", () => {
    if (store.state.timelinePlaying) stopPlay();
    else startPlay();
  });

  // fps/タグ変更時は再生タイマーを再設定
  let lastPlayFps = playFps();
  let lastActiveTagIndex = store.state.activeTagIndex;

  function renderThumb(canvas, frameIndex) {
    const p = project();
    const scale = THUMB_SIZE / Math.max(p.width, p.height);
    canvas.width = Math.max(1, Math.round(p.width * scale));
    canvas.height = Math.max(1, Math.round(p.height * scale));
    const ctx = canvas.getContext("2d");
    drawFrameToContext(ctx, p, frameIndex, scale);
  }

  function render() {
    const p = project();

    if (playFps() !== lastPlayFps || store.state.activeTagIndex !== lastActiveTagIndex) {
      lastPlayFps = playFps();
      lastActiveTagIndex = store.state.activeTagIndex;
      if (store.state.timelinePlaying) { stopPlay(); startPlay(); }
    }
    fpsInput.value = String(p.fps);

    renderTags();

    const tag = activeTag();
    frameList.innerHTML = "";
    p.frames.forEach((frame, i) => {
      const cell = document.createElement("div");
      cell.className = "frame-cell";

      const thumb = document.createElement("div");
      thumb.className =
        "frame-thumb" +
        (i === store.state.currentFrame ? " is-active" : "") +
        (tag && i >= tag.start && i <= tag.end ? " in-tag" : "");
      const canvas = document.createElement("canvas");
      renderThumb(canvas, i);
      thumb.appendChild(canvas);
      const label = document.createElement("span");
      label.className = "frame-index";
      label.textContent = String(i);
      thumb.appendChild(label);
      // ベースフレームバッジ（§13.1-4）
      if (p.baseFrame && i === 0) {
        const badge = document.createElement("span");
        badge.className = "base-badge";
        badge.textContent = "基準";
        thumb.appendChild(badge);
      }
      thumb.addEventListener("click", () => {
        store.state.currentFrame = i;
        store.notify();
      });
      cell.appendChild(thumb);

      // 逸脱メーター（§13.2-4）: ベースフレームとの差分率
      const dev = document.createElement("span");
      dev.className = "deviation";
      const pct = deviationPercent(p, i);
      if (pct !== null) {
        dev.textContent = `${pct}%`;
        dev.title = "ベースフレームとの差分率";
        if (pct > 40) dev.classList.add("is-warn");
      }
      cell.appendChild(dev);

      frameList.appendChild(cell);
    });

    delBtn.disabled = p.frames.length <= 1;
    moveLeftBtn.disabled = store.state.currentFrame <= 0;
    moveRightBtn.disabled = store.state.currentFrame >= p.frames.length - 1;
  }

  store.subscribe(render);
  render();
}
