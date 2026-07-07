// timeline.js — フレーム一覧・再生プレビュー（タイムラインバー）
import { drawFrameToContext } from "./app.js";

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

  function project() { return store.state.project; }

  addBtn.addEventListener("click", () => {
    const p = project();
    store.pushUndo();
    const pixels = new Uint8Array(p.width * p.height);
    p.frames.splice(store.state.currentFrame + 1, 0, { pixels });
    store.state.currentFrame += 1;
    store.notify();
  });

  dupBtn.addEventListener("click", () => {
    const p = project();
    store.pushUndo();
    const src = p.frames[store.state.currentFrame];
    p.frames.splice(store.state.currentFrame + 1, 0, { pixels: Uint8Array.from(src.pixels) });
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
    p.frames.splice(store.state.currentFrame, 1);
    if (store.state.currentFrame >= p.frames.length) store.state.currentFrame = p.frames.length - 1;
    if (store.state.selection && store.state.selection.frameIndex >= p.frames.length) store.state.selection = null;
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
  // タイムライン再生（メインキャンバスのフレームを自動送り）
  // ---------------------------------------------------------------------
  let playTimer = null;
  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    store.state.timelinePlaying = false;
    playBtn.textContent = "▶ 再生";
  }
  function startPlay() {
    const p = project();
    if (p.frames.length <= 1) return;
    store.state.timelinePlaying = true;
    playBtn.textContent = "■ 停止";
    const tick = () => {
      const pp = project();
      store.state.currentFrame = (store.state.currentFrame + 1) % pp.frames.length;
      store.notify();
    };
    playTimer = setInterval(tick, Math.max(1000 / Math.max(1, project().fps), 16));
  }
  playBtn.addEventListener("click", () => {
    if (store.state.timelinePlaying) stopPlay();
    else startPlay();
  });

  // fps変更時は再生タイマーを再設定
  let lastFps = project().fps;

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

    if (p.fps !== lastFps) {
      lastFps = p.fps;
      if (store.state.timelinePlaying) { stopPlay(); startPlay(); }
    }
    fpsInput.value = String(p.fps);

    frameList.innerHTML = "";
    p.frames.forEach((frame, i) => {
      const thumb = document.createElement("div");
      thumb.className = "frame-thumb" + (i === store.state.currentFrame ? " is-active" : "");
      const canvas = document.createElement("canvas");
      renderThumb(canvas, i);
      thumb.appendChild(canvas);
      const label = document.createElement("span");
      label.className = "frame-index";
      label.textContent = String(i);
      thumb.appendChild(label);
      thumb.addEventListener("click", () => {
        store.state.currentFrame = i;
        store.notify();
      });
      frameList.appendChild(thumb);
    });

    delBtn.disabled = p.frames.length <= 1;
    moveLeftBtn.disabled = store.state.currentFrame <= 0;
    moveRightBtn.disabled = store.state.currentFrame >= p.frames.length - 1;
  }

  store.subscribe(render);
  render();
}
