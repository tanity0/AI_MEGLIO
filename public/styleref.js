// styleref.js — §17 トンマナ参照（スタイルアンカー）
// 参考画像アップロード → mode:"style" でスタイルガイドを抽出 → 全AIリクエストに適用
import { frameToGridString, charForIndex } from "./app.js";
import { streamEdit } from "./api.js";
import { detectBlockSize, extractPalette } from "./import.js";

const MAX_REF_SIZE = 256; // §17.1: 最大256×256に正規化して保持

// 画像ファイルを最大256×256のPNG dataURLに正規化（縦横比維持・拡大しない）
async function normalizeRefImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_REF_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

// 参考画像をテキストグリッド化（CLIバックエンド用・§17.2）。
// ≤96×96・≤32色に量子化できなければ null。
async function gridifyRefImage(dataUrl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const block = detectBlockSize(data, canvas.width, canvas.height);
  const realW = Math.max(1, Math.round(canvas.width / block));
  const realH = Math.max(1, Math.round(canvas.height / block));
  if (realW > 96 || realH > 96) return null;

  // ダウンサンプル（ブロック中心の最近傍）
  const small = new Uint8ClampedArray(realW * realH * 4);
  for (let y = 0; y < realH; y++) {
    const sy = Math.min(canvas.height - 1, Math.floor((y + 0.5) * canvas.height / realH));
    for (let x = 0; x < realW; x++) {
      const sx = Math.min(canvas.width - 1, Math.floor((x + 0.5) * canvas.width / realW));
      const si = (sy * canvas.width + sx) * 4;
      const di = (y * realW + x) * 4;
      small[di] = data[si]; small[di + 1] = data[si + 1]; small[di + 2] = data[si + 2]; small[di + 3] = data[si + 3];
    }
  }
  const { palette, keyToIndex, totalColors } = extractPalette(small, realW * realH);
  if (totalColors > 31) return null; // 量子化なしで収まらない場合はCLI解析不可扱い

  const rows = [];
  for (let y = 0; y < realH; y++) {
    let row = "";
    for (let x = 0; x < realW; x++) {
      const o = (y * realW + x) * 4;
      if (small[o + 3] < 128) { row += "."; continue; }
      const key = (small[o] << 16) | (small[o + 1] << 8) | small[o + 2];
      row += charForIndex(keyToIndex.get(key) ?? 0) ?? ".";
    }
    rows.push(row);
  }
  return { grid: rows.join("\n"), palette };
}

export function initStyleRef(store, toast) {
  const uploadInput = document.getElementById("styleUploadInput");
  const thumb = document.getElementById("styleThumb");
  const analyzeBtn = document.getElementById("styleAnalyzeBtn");
  const guideText = document.getElementById("styleGuideText");
  const enabledToggle = document.getElementById("styleEnabledToggle");
  const badge = document.getElementById("styleActiveBadge");
  const statusEl = document.getElementById("styleStatus");

  function project() { return store.state.project; }
  function ensureStyleRef() {
    const p = project();
    if (!p.styleRef) p.styleRef = { imageDataUrl: "", guide: "", enabled: false };
    return p.styleRef;
  }

  uploadInput.addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await normalizeRefImage(file);
      store.pushUndo();
      const s = ensureStyleRef();
      s.imageDataUrl = dataUrl;
      store.notify();
      toast("参考画像を読み込みました。「AIで解析」でスタイルガイドを抽出できます");
    } catch (err) {
      toast(`参考画像の読込に失敗しました: ${err.message}`, "error");
    }
  });

  analyzeBtn.addEventListener("click", async () => {
    const p = project();
    const s = p.styleRef;
    if (!s || !s.imageDataUrl) {
      toast("先に参考画像を読み込んでください", "error");
      return;
    }
    const cfg = store.state.serverConfig || {};
    const body = {
      project: {
        width: p.width,
        height: p.height,
        fps: p.fps,
        palette: p.palette,
        framesGrid: p.frames.map((_, i) => frameToGridString(p, i)),
      },
      mode: "style",
      scope: "frame",
      frameIndex: 0,
      instruction: "この参考画像のトンマナ（スタイル）を分析してください",
    };

    if (cfg.backend === "cli" && !cfg.mock) {
      // §17.2: CLIは画像を送れないため、グリッド化できる場合のみテキストで解析
      statusEl.textContent = "参考画像をテキスト化中…";
      const gridified = await gridifyRefImage(s.imageDataUrl).catch(() => null);
      if (!gridified) {
        statusEl.textContent = "";
        toast("CLIバックエンドではこの画像を解析できません（96×96・32色以下に収まりません）。ガイドを手書きで入力してください", "error");
        return;
      }
      body.styleGrid = gridified.grid;
      body.stylePalette = gridified.palette;
    } else {
      body.images = [{ frame: 0, dataUrl: s.imageDataUrl }];
    }

    analyzeBtn.disabled = true;
    statusEl.classList.add("is-busy");
    statusEl.textContent = "スタイルを解析中…";
    try {
      const evt = await streamEdit(body, {});
      store.pushUndo();
      const sr = ensureStyleRef();
      sr.guide = evt.style.guide;
      sr.enabled = true;
      store.notify();
      statusEl.textContent = `解析完了: ${evt.style.note}`;
      toast("スタイルガイドを抽出しました（テキストは編集できます。テキストが正です）");
    } catch (err) {
      statusEl.textContent = `エラー: ${err.message}`;
      toast(err.message, "error");
    } finally {
      analyzeBtn.disabled = false;
      statusEl.classList.remove("is-busy");
    }
  });

  guideText.addEventListener("change", () => {
    store.pushUndo();
    const s = ensureStyleRef();
    s.guide = guideText.value.slice(0, 4000);
    store.notify();
  });

  enabledToggle.addEventListener("change", () => {
    const s = ensureStyleRef();
    if (enabledToggle.checked && !s.guide.trim()) {
      toast("ガイドが空です。「AIで解析」するか手書きで入力してください", "error");
      enabledToggle.checked = false;
      return;
    }
    s.enabled = enabledToggle.checked;
    store.notify();
  });

  function render() {
    const s = project().styleRef;
    if (s && s.imageDataUrl) {
      thumb.src = s.imageDataUrl;
      thumb.hidden = false;
    } else {
      thumb.hidden = true;
    }
    if (document.activeElement !== guideText) guideText.value = s ? s.guide : "";
    enabledToggle.checked = !!(s && s.enabled);
    const active = !!(s && s.enabled && s.guide.trim());
    badge.hidden = !active;
  }
  store.subscribe(render);
  render();
}
