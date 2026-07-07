// gameexport.js — §16.3 ゲームプロファイル / §16.4 書き出し / §16.5 ゲームビュープレビュー
import { hexToRgba } from "./app.js";

// ---------------------------------------------------------------------------
// 描画: ピクセル配列 → canvas（整数拡大・左右反転対応）
// ---------------------------------------------------------------------------
function renderPixelsToCanvas(pixels, width, height, palette, scale, mirror) {
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = pixels[y * width + x];
      const hex = palette[idx];
      if (!hex) continue;
      const [r, g, b, a] = hexToRgba(hex);
      if (a === 0) continue;
      ctx.fillStyle = a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a / 255})`;
      const dx = mirror ? width - 1 - x : x;
      ctx.fillRect(dx * scale, y * scale, scale, scale);
    }
  }
  return canvas;
}

function jsonToDataUrl(obj) {
  const str = JSON.stringify(obj, null, 2);
  return "data:application/json;base64," + btoa(unescape(encodeURIComponent(str)));
}

function renderNaming(template, charName, variantName) {
  return (template || "{char}_{variant}")
    .replace(/\{char\}/g, charName)
    .replace(/\{variant\}/g, variantName)
    // パス・OSで問題になる文字のみ置換（日本語等はそのまま許可）
    .replace(/[\\/:*?"<>|\s\x00-\x1f]/g, "_");
}

// ---------------------------------------------------------------------------
// 書き出しファイル生成（§16.4 / §16.6）
// 戻り値: { files: [{path, dataUrl}], warnings: [string] }
// primaryExport: "first-frame-of-idle" のとき idle タグの先頭フレームを
// {base}.png として単体出力し、同時に frames と sheet+json も出力する（§16.6）
// ---------------------------------------------------------------------------
export function buildExportFiles(project, opts) {
  const { charName, format, scale, variants, mirrorTags, primaryExport } = opts;
  const { width, height } = project;
  const files = [];
  const warnings = [];
  const seenPaths = new Set();
  const pushFile = (path, dataUrl) => {
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    files.push({ path, dataUrl });
  };

  // 実効タグ列（mirror:"export" のタグは反転版 {name}_left を追加）
  const effTags = [];
  for (const t of project.tags || []) {
    effTags.push({ ...t, mirror: false });
    if (mirrorTags && mirrorTags[t.name]) {
      effTags.push({ ...t, name: `${t.name}_left`, mirror: true });
    }
  }
  if (!effTags.length) throw new Error("書き出すタグがありません");

  for (const variant of variants) {
    let base = renderNaming(opts.naming, charName, variant.name);
    // naming に {variant} が無いテンプレート（例: zombie の "{char}"）では
    // base 以外のバリエーションが衝突するため接尾辞を付ける
    if (variant.name !== "base" && !(opts.naming || "").includes("{variant}")) {
      base = `${base}_${variant.name.replace(/[\\/:*?"<>|\s\x00-\x1f]/g, "_")}`;
    }
    const palette = variant.palette;

    const emitSheetJson = (fileBase) => {
      // 行=タグ、列=フレーム
      const maxLen = Math.max(...effTags.map((t) => t.end - t.start + 1));
      const cellW = width * scale;
      const cellH = height * scale;
      const sheet = document.createElement("canvas");
      sheet.width = maxLen * cellW;
      sheet.height = effTags.length * cellH;
      const ctx = sheet.getContext("2d");
      const framesJson = [];
      const frameTags = [];
      let frameCounter = 0;
      effTags.forEach((t, row) => {
        const from = frameCounter;
        for (let i = 0; i <= t.end - t.start; i++) {
          const c = renderPixelsToCanvas(project.frames[t.start + i].pixels, width, height, palette, scale, t.mirror);
          ctx.drawImage(c, i * cellW, row * cellH);
          framesJson.push({
            filename: `${fileBase}_${t.name}_${i}`,
            frame: { x: i * cellW, y: row * cellH, w: cellW, h: cellH },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: cellW, h: cellH },
            sourceSize: { w: cellW, h: cellH },
            duration: Math.round(1000 / Math.max(1, t.fps)),
          });
          frameCounter++;
        }
        frameTags.push({ name: t.name, from, to: frameCounter - 1, direction: "forward" });
      });
      const meta = {
        app: "AI Meglio",
        version: "1.0",
        image: `${fileBase}.png`,
        format: "RGBA8888",
        size: { w: sheet.width, h: sheet.height },
        scale: String(scale),
        frameTags,
      };
      pushFile(`${fileBase}.png`, sheet.toDataURL("image/png"));
      pushFile(`${fileBase}.json`, jsonToDataUrl({ frames: framesJson, meta }));
    };

    const emitStrip = () => {
      for (const t of effTags) {
        const n = t.end - t.start + 1;
        const strip = document.createElement("canvas");
        strip.width = n * width * scale;
        strip.height = height * scale;
        const ctx = strip.getContext("2d");
        for (let i = 0; i < n; i++) {
          const c = renderPixelsToCanvas(project.frames[t.start + i].pixels, width, height, palette, scale, t.mirror);
          ctx.drawImage(c, i * width * scale, 0);
        }
        pushFile(`${base}_${t.name}.png`, strip.toDataURL("image/png"));
      }
    };

    const emitFrames = () => {
      for (const t of effTags) {
        for (let i = 0; i <= t.end - t.start; i++) {
          const c = renderPixelsToCanvas(project.frames[t.start + i].pixels, width, height, palette, scale, t.mirror);
          pushFile(`${base}_${t.name}_${i}.png`, c.toDataURL("image/png"));
        }
      }
    };

    // §16.6: primaryExport — idle タグの先頭フレームを {base}.png として単体出力
    if (primaryExport === "first-frame-of-idle") {
      const idle = (project.tags || []).find((t) => t.name.toLowerCase() === "idle");
      let frameIdx;
      if (idle) {
        frameIdx = idle.start;
      } else {
        frameIdx = 0;
        warnings.push(`idle タグが無いため、フレーム0を ${base}.png として出力しました（idle タグの作成を推奨）`);
      }
      const c = renderPixelsToCanvas(project.frames[frameIdx].pixels, width, height, palette, scale, false);
      pushFile(`${base}.png`, c.toDataURL("image/png"));
      // 将来のフレームアニメ対応用に frames と sheet+json も同時出力
      // （プライマリPNGとの衝突を避けるためシートは {base}_sheet.*）
      emitFrames();
      emitSheetJson(`${base}_sheet`);
      if (format === "strip-per-tag") emitStrip();
      continue;
    }

    if (format === "sheet+json") emitSheetJson(base);
    else if (format === "strip-per-tag") emitStrip();
    else if (format === "frames") emitFrames();
    else throw new Error(`不明な書き出し形式です: ${format}`);
  }
  return { files, warnings };
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// UI 初期化
// ---------------------------------------------------------------------------
export function initGameExport(store, toast) {
  const profileSelect = document.getElementById("profileSelect");
  const tagChecklist = document.getElementById("tagChecklist");
  const openExportBtn = document.getElementById("openExportBtn");
  const exportPanel = document.getElementById("exportPanel");
  const exportCloseBtn = document.getElementById("exportCloseBtn");
  const exportCharInput = document.getElementById("exportCharInput");
  const exportFormatSelect = document.getElementById("exportFormatSelect");
  const exportScaleInput = document.getElementById("exportScaleInput");
  const exportDirInput = document.getElementById("exportDirInput");
  const exportMirrorList = document.getElementById("exportMirrorList");
  const exportVariantList = document.getElementById("exportVariantList");
  const exportRunBtn = document.getElementById("exportRunBtn");
  const exportStatus = document.getElementById("exportStatus");
  const destRadios = () => document.querySelector('input[name="exportDest"]:checked')?.value || "download";
  const destRepoRadio = document.getElementById("exportDestRepo");
  const destRepoLabel = document.getElementById("exportDestRepoLabel");

  let profiles = [];
  let config = { exportEnabled: false, exportRoot: null };

  function project() { return store.state.project; }
  function activeProfile() {
    const name = profileSelect.value;
    if (name === "__project__") return project().profile;
    return profiles.find((p) => p.name === name) || null;
  }

  async function loadProfiles() {
    try {
      const [pRes, cRes] = await Promise.all([fetch("/api/profiles"), fetch("/api/config")]);
      profiles = await pRes.json();
      config = await cRes.json();
    } catch {
      profiles = [];
    }
    renderProfileSelect();
    renderChecklist();
    destRepoRadio.disabled = !config.exportEnabled;
    destRepoLabel.title = config.exportEnabled
      ? `書き出し先: ${config.exportRoot}`
      : "EXPORT_ROOT が未設定のため無効です（EXPORT_ROOT=<ゲームリポジトリ> で起動）";
  }

  function renderProfileSelect() {
    const current = profileSelect.value;
    profileSelect.innerHTML = '<option value="">プロファイルなし</option>' +
      profiles.map((p) => `<option value="${p.name}">${p.name}</option>`).join("") +
      (project().profile ? '<option value="__project__">プロジェクト定義</option>' : "");
    if ([...profileSelect.options].some((o) => o.value === current)) profileSelect.value = current;
  }

  // 必要タグのチェックリスト（§16.3）: ✗クリックでモーション生成タブに直行
  const PRESET_TAGS = new Set(["walk", "run", "attack", "idle", "jump"]);
  function renderChecklist() {
    const prof = activeProfile();
    tagChecklist.innerHTML = "";
    if (!prof || !Array.isArray(prof.requiredTags)) return;
    const tagNames = new Set((project().tags || []).map((t) => t.name.toLowerCase()));
    for (const req of prof.requiredTags) {
      const has = tagNames.has(String(req).toLowerCase());
      const chip = document.createElement("button");
      chip.className = "req-chip " + (has ? "is-ok" : "is-missing");
      chip.textContent = `${req}${has ? "✓" : "✗"}`;
      chip.title = has
        ? `タグ「${req}」は存在します`
        : `タグ「${req}」がありません。クリックでモーション生成へ`;
      if (!has) {
        chip.addEventListener("click", () => {
          document.getElementById("tabMotionBtn").click();
          const presetSelect = document.getElementById("motionPreset");
          if (PRESET_TAGS.has(String(req).toLowerCase())) {
            presetSelect.value = String(req).toLowerCase();
            presetSelect.dispatchEvent(new Event("change"));
          } else {
            presetSelect.value = "custom";
            presetSelect.dispatchEvent(new Event("change"));
            document.getElementById("motionCustomText").value = `${req} モーション`;
          }
          toast(`「${req}」のモーション生成を設定しました。実行してください`);
        });
      }
      tagChecklist.appendChild(chip);
    }
  }

  profileSelect.addEventListener("change", () => {
    const prof = activeProfile();
    if (prof) {
      if (prof.format) exportFormatSelect.value = prof.format;
      if (Number.isInteger(prof.scale) && prof.scale >= 1) exportScaleInput.value = String(prof.scale);
      exportDirInput.value = prof.exportDir || "";
    }
    renderChecklist();
  });

  // ---------------------------------------------------------------------
  // 書き出しパネル（§16.4）
  // ---------------------------------------------------------------------
  function renderExportPanel() {
    const p = project();
    const prof = activeProfile();

    // mirror:"export" のタグ単位ON/OFF
    const mirrorOn = prof && prof.mirror === "export";
    exportMirrorList.parentElement.hidden = !mirrorOn;
    exportMirrorList.innerHTML = "";
    if (mirrorOn) {
      for (const t of p.tags || []) {
        const label = document.createElement("label");
        label.className = "check-row inline";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.dataset.tag = t.name;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(` ${t.name}_left`));
        exportMirrorList.appendChild(label);
      }
    }

    // バリエーション一覧（§16.2）
    exportVariantList.innerHTML = "";
    const baseItem = document.createElement("li");
    baseItem.textContent = "base（現在のパレット）";
    exportVariantList.appendChild(baseItem);
    (p.variants || []).forEach((v, i) => {
      const li = document.createElement("li");
      li.textContent = v.name;
      const del = document.createElement("button");
      del.className = "btn btn-small";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        store.pushUndo();
        p.variants.splice(i, 1);
        store.notify();
        renderExportPanel();
      });
      li.appendChild(del);
      exportVariantList.appendChild(li);
    });
  }

  openExportBtn.addEventListener("click", () => {
    exportPanel.hidden = false;
    exportStatus.textContent = "";
    renderExportPanel();
  });
  exportCloseBtn.addEventListener("click", () => { exportPanel.hidden = true; });

  exportRunBtn.addEventListener("click", async () => {
    const p = project();
    const prof = activeProfile();
    const charName = (exportCharInput.value.trim() || "char").replace(/[^\w\-]/g, "_");
    const format = exportFormatSelect.value;
    const scale = Math.max(1, Math.min(8, Math.round(Number(exportScaleInput.value) || 1)));

    const mirrorTags = {};
    if (prof && prof.mirror === "export") {
      exportMirrorList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        mirrorTags[cb.dataset.tag] = cb.checked;
      });
    }

    const variants = [{ name: "base", palette: p.palette }, ...(p.variants || [])];

    let files;
    let exportWarnings = [];
    try {
      ({ files, warnings: exportWarnings } = buildExportFiles(p, {
        charName,
        format,
        scale,
        naming: prof?.naming || "{char}_{variant}",
        variants,
        mirrorTags,
        primaryExport: prof?.primaryExport || null, // §16.6
      }));
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const warnText = exportWarnings.length ? ` / 警告: ${exportWarnings.join(" / ")}` : "";
    for (const w of exportWarnings) toast(w, "error");
    // §16.6: zombie プロファイルではゲーム側の登録が必要な場合がある旨を表示
    const pixiNote = prof?.name === "zombie"
      ? "。新規キャラ名の場合、ゲーム側で pixiTextures.ts への登録が必要なことがあります"
      : "";

    if (destRadios() === "repo") {
      const dir = exportDirInput.value.trim().replace(/^\/+|\/+$/g, "");
      const payload = {
        files: files.map((f) => ({ path: dir ? `${dir}/${f.path}` : f.path, dataUrl: f.dataUrl })),
      };
      exportStatus.textContent = "書き出し中…";
      try {
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        exportStatus.textContent = `${json.written.length}ファイルを ${json.root} に書き出しました${pixiNote}${warnText}`;
        toast(`ゲームリポジトリに ${json.written.length} ファイルを書き出しました${pixiNote}`);
      } catch (err) {
        exportStatus.textContent = `エラー: ${err.message}`;
        toast(err.message, "error");
      }
    } else {
      for (const f of files) downloadDataUrl(f.dataUrl, f.path);
      exportStatus.textContent = `${files.length}ファイルをダウンロードしました${pixiNote}${warnText}`;
      toast(`${files.length}ファイルをダウンロードしました${pixiNote}`);
    }
  });

  store.subscribe(() => {
    renderChecklist();
    renderProfileSelect();
  });
  loadProfiles();
}

// ---------------------------------------------------------------------------
// ゲームビュープレビュー（§16.5）: 背景+ゲームスケールで移動ループ再生
// ---------------------------------------------------------------------------
export function initGameView(store) {
  const canvas = document.getElementById("gameViewCanvas");
  const bgInput = document.getElementById("gameViewBgInput");
  const scaleSelect = document.getElementById("gameViewScale");
  const playToggle = document.getElementById("gameViewPlay");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  let bgImage = null; // セッション限り（プロジェクトJSONに含めない・§16.5）
  let x = 0;
  let dir = 1;
  let frameIdx = 0;
  let acc = 0;
  let lastTs = null;

  bgInput.addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      bgImage = await createImageBitmap(file);
    } catch {
      bgImage = null;
    }
  });

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!playToggle.checked) { lastTs = ts; return; }
    const p = store.state.project;
    if (!p.frames.length) return;
    if (lastTs === null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;

    const ti = store.state.activeTagIndex;
    const tag = ti >= 0 && p.tags && p.tags[ti] ? p.tags[ti] : null;
    const start = tag ? tag.start : 0;
    const end = tag ? Math.min(tag.end, p.frames.length - 1) : p.frames.length - 1;
    const fps = tag ? tag.fps : p.fps;

    acc += dt;
    const dur = 1000 / Math.max(1, fps);
    while (acc >= dur) {
      acc -= dur;
      frameIdx = frameIdx + 1 > end || frameIdx + 1 < start ? start : frameIdx + 1;
    }
    if (frameIdx < start || frameIdx > end) frameIdx = start;

    const scale = Number(scaleSelect.value) || 1;
    const spriteW = p.width * scale;
    const speed = (dt / 1000) * 30 * scale; // 30px/s × scale
    x += dir * speed;
    if (x < 0) { x = 0; dir = 1; }
    if (x > canvas.width - spriteW) { x = Math.max(0, canvas.width - spriteW); dir = -1; }

    // 背景
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bgImage) {
      ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#2a2d3a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#20222e";
      ctx.fillRect(0, canvas.height - 24, canvas.width, 24);
    }
    // スプライト（左移動時は反転）
    const sprite = renderPixelsToCanvas(
      p.frames[frameIdx].pixels, p.width, p.height, p.palette, scale, dir < 0
    );
    ctx.drawImage(sprite, Math.round(x), canvas.height - sprite.height - 8);
  }
  requestAnimationFrame(tick);
}
