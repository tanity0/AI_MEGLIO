// rig.js — §14 2Dパーツリグモード
// パーツ切り出し・AI自動分割(mode:segment)・キーフレームテーブルによるモーション生成・
// z順/pivot回転合成・AI清書(mode:cleanup)・フレーム単位の微調整
import { streamEdit } from "./api.js";
import {
  frameToGridString,
  frameToPngDataUrl,
  pixelsToGridString,
  pixelsToPngDataUrl,
  drawFrameToContext,
  indexForToken,
  splitTokens,
  cellChars,
  adjustTagsOnInsert,
  adjustTagsOnDelete,
  addGeneratedTag,
  styleRequestFields,
} from "./app.js";

// ---------------------------------------------------------------------------
// ロール判定（キーフレームテーブルとパーツの対応付け。名前/idで判定）
// ---------------------------------------------------------------------------
const ROLE_PATTERNS = [
  ["arm_r", /右腕|右手|arm_r|r_arm/i],
  ["arm_l", /左腕|左手|arm_l|l_arm/i],
  ["leg_r", /右脚|右足|leg_r|r_leg|legs?_?r/i],
  ["leg_l", /左脚|左足|leg_l|l_leg|legs?_?l/i],
  ["weapon", /武器|剣|weapon|sword/i],
  ["head", /頭|head/i],
  ["torso", /胴|体|torso|body|legs|脚|足/i],
];
function roleOf(part) {
  for (const [role, re] of ROLE_PATTERNS) {
    if (re.test(part.id) || re.test(part.name)) return role;
  }
  return "torso"; // 未分類は胴と同じ動き（バウンスのみ）
}

// ---------------------------------------------------------------------------
// モーションプリセットのキーフレームテーブル（§14.3・ハードコード）
// 値: ロール → {dx, dy, rot}（rotは度、正=時計回り）。
// 歩きの定石: 左右脚は逆位相、接地フレームで胴体が最低（dy正=下）、腕は脚と逆位相。
// ---------------------------------------------------------------------------
const RIG_TABLES = {
  walk: [
    // コンタクト（右脚前・体最低）
    { torso: { dy: 1 }, head: { dy: 1 }, arm_r: { rot: -30 }, arm_l: { rot: 30 }, leg_r: { dx: 1, rot: 30 }, leg_l: { dx: -1, rot: -30 }, weapon: { rot: -30 } },
    // パッシング（体最高）
    {},
    // コンタクト（左脚前・体最低）
    { torso: { dy: 1 }, head: { dy: 1 }, arm_r: { rot: 30 }, arm_l: { rot: -30 }, leg_r: { dx: -1, rot: -30 }, leg_l: { dx: 1, rot: 30 }, weapon: { rot: 30 } },
    // パッシング
    {},
  ],
  run: [
    { torso: { dy: 1, rot: 15 }, head: { dy: 1 }, arm_r: { rot: -45 }, arm_l: { rot: 45 }, leg_r: { dx: 2, rot: 45 }, leg_l: { dx: -2, rot: -45 }, weapon: { rot: -45 } },
    { torso: { rot: 15 }, arm_r: { rot: -15 }, arm_l: { rot: 15 }, leg_r: { dx: 1, rot: 15 }, leg_l: { dx: -1, rot: -15 } },
    // 滞空
    { torso: { dy: -1, rot: 15 }, head: { dy: -1 }, arm_r: { rot: 15 }, arm_l: { rot: -15 }, leg_r: { rot: -15 }, leg_l: { rot: 15 } },
    { torso: { dy: 1, rot: 15 }, head: { dy: 1 }, arm_r: { rot: 45 }, arm_l: { rot: -45 }, leg_r: { dx: -2, rot: -45 }, leg_l: { dx: 2, rot: 45 }, weapon: { rot: 45 } },
    { torso: { rot: 15 }, arm_r: { rot: 15 }, arm_l: { rot: -15 }, leg_r: { dx: -1, rot: -15 }, leg_l: { dx: 1, rot: 15 } },
    // 滞空
    { torso: { dy: -1, rot: 15 }, head: { dy: -1 }, arm_r: { rot: -15 }, arm_l: { rot: 15 }, leg_r: { rot: 15 }, leg_l: { rot: -15 } },
  ],
  attack: [
    // 予備動作（振りかぶり）
    { torso: { rot: -15 }, arm_r: { dx: -1, rot: -60 }, weapon: { dx: -1, rot: -75 }, head: { rot: -15 } },
    // ヒット（最大リーチ）
    { torso: { dx: 1, rot: 15 }, arm_r: { dx: 2, rot: 60 }, weapon: { dx: 3, rot: 90 }, head: { rot: 15 }, leg_r: { rot: 15 }, leg_l: { rot: -15 } },
    // フォロースルー
    { torso: { rot: 15 }, arm_r: { dx: 1, rot: 30 }, weapon: { dx: 1, rot: 45 } },
  ],
  idle: [
    {},
    { torso: { dy: 1 }, head: { dy: 1 }, arm_r: { dy: 1 }, arm_l: { dy: 1 } },
  ],
  jump: [
    // しゃがみ込み
    { torso: { dy: 2 }, head: { dy: 2 }, leg_r: { rot: -15 }, leg_l: { rot: 15 }, arm_r: { rot: -30 }, arm_l: { rot: 30 } },
    // 蹴り出し
    { torso: { dy: -2 }, head: { dy: -2 }, arm_r: { rot: 30 }, arm_l: { rot: -30 } },
    // 滞空（最高点）
    { torso: { dy: -4 }, head: { dy: -4 }, leg_r: { rot: 15 }, leg_l: { rot: -15 }, arm_r: { rot: 45 }, arm_l: { rot: -45 } },
    // 着地
    { torso: { dy: 1 }, head: { dy: 1 }, leg_r: { rot: -15 }, leg_l: { rot: 15 } },
  ],
};
const RIG_PRESET_FRAMES = { walk: 4, run: 6, attack: 3, idle: 2, jump: 4 };

const ZERO = { dx: 0, dy: 0, rot: 0 };
function entryOf(tableFrame, role) {
  const e = tableFrame[role] || {};
  return { dx: e.dx || 0, dy: e.dy || 0, rot: e.rot || 0 };
}
function roundRot(deg) {
  return Math.round(deg / 15) * 15; // 15°刻み（§14.1）
}

// テーブルを nFrames に線形補間（循環）し、振り幅・バウンスを適用してキーフレーム化
export function buildKeyframes(preset, nFrames, magnitude, bounce, parts) {
  const table = RIG_TABLES[preset];
  const L = table.length;
  const keyframes = [];
  for (let i = 0; i < nFrames; i++) {
    const t = (i * L) / nFrames;
    const a = Math.floor(t) % L;
    const b = (a + 1) % L;
    const f = t - Math.floor(t);
    const kf = {};
    for (const part of parts) {
      const role = roleOf(part);
      const ea = entryOf(table[a], role);
      const eb = entryOf(table[b], role);
      let dx = (ea.dx + (eb.dx - ea.dx) * f) * magnitude;
      let dy = (ea.dy + (eb.dy - ea.dy) * f) * magnitude;
      let rot = (ea.rot + (eb.rot - ea.rot) * f) * magnitude;
      if (!bounce && (role === "torso" || role === "head")) dy = 0; // バウンス: 胴体のdy成分の有効/無効
      kf[part.id] = { dx: Math.round(dx), dy: Math.round(dy), rot: roundRot(rot) };
    }
    keyframes.push(kf);
  }
  return keyframes;
}

// ---------------------------------------------------------------------------
// 剛体変換（回転+平行移動）: {c, s, tx, ty} — T(p) = R·p + t
// ---------------------------------------------------------------------------
const IDENTITY = { c: 1, s: 0, tx: 0, ty: 0 };
function composeT(A, B) {
  // A ∘ B
  return {
    c: A.c * B.c - A.s * B.s,
    s: A.s * B.c + A.c * B.s,
    tx: A.c * B.tx - A.s * B.ty + A.tx,
    ty: A.s * B.tx + A.c * B.ty + A.ty,
  };
}
function invertT(M) {
  return {
    c: M.c,
    s: -M.s,
    tx: -(M.c * M.tx + M.s * M.ty),
    ty: -(-M.s * M.tx + M.c * M.ty),
  };
}
function applyT(M, x, y) {
  return [M.c * x - M.s * y + M.tx, M.s * x + M.c * y + M.ty];
}

function localTransform(part, k) {
  const rad = ((k.rot || 0) * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const vx = part.patch.x + part.pivot.x + 0.5; // pivot（キャンバス座標）
  const vy = part.patch.y + part.pivot.y + 0.5;
  // T(q) = R(q − v) + v + d
  return { c, s, tx: vx - (c * vx - s * vy) + (k.dx || 0), ty: vy - (s * vx + c * vy) + (k.dy || 0) };
}

function worldTransforms(parts, kf) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const memo = new Map();
  function world(p, stack) {
    if (memo.has(p.id)) return memo.get(p.id);
    if (stack.has(p.id)) return IDENTITY; // 循環ガード
    stack.add(p.id);
    const local = localTransform(p, kf[p.id] || ZERO);
    let M = local;
    if (p.parent && byId.has(p.parent)) {
      M = composeT(world(byId.get(p.parent), stack), local); // 親変換の継承
    }
    memo.set(p.id, M);
    return M;
  }
  for (const p of parts) world(p, new Set());
  return memo;
}

// リグを合成して通常のフレームピクセルを生成（§14.4-1）
export function composeRigFrame(project, kf) {
  const { width, height } = project;
  const base = project.baseFrame || project.frames[0].pixels;
  const out = Uint8Array.from(base);
  const parts = (project.rig?.parts || []).filter((p) => p.visible !== false);
  if (!parts.length) return out;

  // パーツの切り出し元セルを消去（非透明セルのみ）
  for (const p of parts) {
    const { x, y, w, h, pixels } = p.patch;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (pixels[j * w + i] !== 0) out[(y + j) * width + (x + i)] = 0;
      }
    }
  }

  // z昇順に、pivot周り回転（最近傍）+平行移動で合成
  const worlds = worldTransforms(parts, kf);
  const sorted = [...parts].sort((a, b) => a.z - b.z);
  for (const p of sorted) {
    const M = worlds.get(p.id) || IDENTITY;
    const Minv = invertT(M);
    const { x, y, w, h, pixels } = p.patch;
    // 変換後のバウンディングボックス
    const corners = [
      applyT(M, x, y), applyT(M, x + w, y), applyT(M, x, y + h), applyT(M, x + w, y + h),
    ];
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 1);
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1);
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 1);
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const [sx, sy] = applyT(Minv, tx + 0.5, ty + 0.5); // 逆変換の最近傍サンプリング
        const si = Math.floor(sx) - x;
        const sj = Math.floor(sy) - y;
        if (si < 0 || sj < 0 || si >= w || sj >= h) continue;
        const v = pixels[sj * w + si];
        if (v !== 0) out[ty * width + tx] = v;
      }
    }
  }
  return out;
}

// 「合成時に変化したセルの周囲2px」の許可マスク（§14.4-2）
export function buildAllowedMask(project, framePixels) {
  const { width, height } = project;
  const base = project.baseFrame || project.frames[0].pixels;
  const changed = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (framePixels[i] !== base[i]) changed[i] = 1;
  }
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      let ok = 0;
      for (let dy = -2; dy <= 2 && !ok; dy++) {
        for (let dx = -2; dx <= 2 && !ok; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && changed[ny * width + nx]) ok = 1;
        }
      }
      row += ok ? "1" : "0";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
export function initRig(store, toast) {
  const registerPartBtn = document.getElementById("registerPartBtn");
  const segmentBtn = document.getElementById("segmentBtn");
  const partForm = document.getElementById("partForm");
  const partNameInput = document.getElementById("partNameInput");
  const partZInput = document.getElementById("partZInput");
  const partParentSelect = document.getElementById("partParentSelect");
  const partPreviewCanvas = document.getElementById("partPreviewCanvas");
  const pivotLabel = document.getElementById("pivotLabel");
  const partConfirmBtn = document.getElementById("partConfirmBtn");
  const partCancelBtn = document.getElementById("partCancelBtn");
  const partList = document.getElementById("partList");
  const rigPreset = document.getElementById("rigPreset");
  const rigMagnitude = document.getElementById("rigMagnitude");
  const rigBounce = document.getElementById("rigBounce");
  const rigFrames = document.getElementById("rigFrames");
  const rigGenerateBtn = document.getElementById("rigGenerateBtn");
  const rigCleanupBtn = document.getElementById("rigCleanupBtn");
  const rigAbortBtn = document.getElementById("rigAbortBtn");
  const rigProgress = document.getElementById("rigProgress");
  const rigAdjustModeToggle = document.getElementById("rigAdjustMode");
  const adjInfo = document.getElementById("adjInfo");
  const mainCanvas = document.getElementById("mainCanvas");

  let abortController = null;
  let formState = null; // { rect, pivot }

  function project() { return store.state.project; }
  function ensureRig(p) {
    if (!p.rig) p.rig = { parts: [], keyframes: [], generatedAt: null };
    return p.rig;
  }
  function basePixels(p) { return p.baseFrame || p.frames[0].pixels; }
  function uniquePartId(rig) {
    let n = rig.parts.length + 1;
    while (rig.parts.some((pt) => pt.id === `part${n}`)) n++;
    return `part${n}`;
  }

  rigPreset.addEventListener("change", () => {
    rigFrames.value = String(RIG_PRESET_FRAMES[rigPreset.value] || 4);
  });

  // -------------------------------------------------------------------
  // パーツ登録ミニダイアログ（§14.2）
  // -------------------------------------------------------------------
  function drawPartPreview() {
    if (!formState) return;
    const p = project();
    const { rect, pivot } = formState;
    const scale = Math.max(2, Math.min(10, Math.floor(140 / Math.max(rect.w, rect.h))));
    partPreviewCanvas.width = rect.w * scale;
    partPreviewCanvas.height = rect.h * scale;
    const ctx = partPreviewCanvas.getContext("2d");
    const base = basePixels(p);
    const tmp = {
      width: rect.w, height: rect.h, palette: p.palette,
      frames: [{ pixels: cutPatch(base, p.width, rect) }],
    };
    drawFrameToContext(ctx, tmp, 0, scale);
    // pivotマーカー
    ctx.strokeStyle = "#6ee7c8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc((pivot.x + 0.5) * scale, (pivot.y + 0.5) * scale, scale * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    pivotLabel.textContent = `pivot: (${pivot.x}, ${pivot.y})（プレビューをクリックで変更）`;
    formState.scale = scale;
  }

  function cutPatch(base, W, rect) {
    const pixels = new Uint8Array(rect.w * rect.h);
    for (let j = 0; j < rect.h; j++) {
      for (let i = 0; i < rect.w; i++) {
        pixels[j * rect.w + i] = base[(rect.y + j) * W + (rect.x + i)];
      }
    }
    return pixels;
  }

  registerPartBtn.addEventListener("click", () => {
    const sel = store.state.selection;
    if (!sel) {
      toast("先に矩形選択ツールでパーツにする範囲を選択してください", "error");
      return;
    }
    const p = project();
    const rig = ensureRig(p);
    formState = {
      rect: { x: sel.x, y: sel.y, w: sel.w, h: sel.h },
      pivot: { x: Math.floor(sel.w / 2), y: Math.floor(sel.h / 2) },
    };
    partNameInput.value = `パーツ${rig.parts.length + 1}`;
    partZInput.value = String(rig.parts.length);
    partParentSelect.innerHTML = '<option value="">なし</option>' +
      rig.parts.map((pt) => `<option value="${pt.id}">${pt.name}</option>`).join("");
    partForm.hidden = false;
    drawPartPreview();
  });

  partPreviewCanvas.addEventListener("click", (ev) => {
    if (!formState) return;
    const r = partPreviewCanvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left) / formState.scale);
    const y = Math.floor((ev.clientY - r.top) / formState.scale);
    formState.pivot = {
      x: Math.max(0, Math.min(formState.rect.w - 1, x)),
      y: Math.max(0, Math.min(formState.rect.h - 1, y)),
    };
    drawPartPreview();
  });

  partConfirmBtn.addEventListener("click", () => {
    if (!formState) return;
    const p = project();
    const rig = ensureRig(p);
    const name = partNameInput.value.trim() || `パーツ${rig.parts.length + 1}`;
    store.pushUndo();
    rig.parts.push({
      id: uniquePartId(rig),
      name,
      patch: { ...formState.rect, pixels: cutPatch(basePixels(p), p.width, formState.rect) },
      pivot: { ...formState.pivot },
      z: Number(partZInput.value) || 0,
      parent: partParentSelect.value || "",
      visible: true,
    });
    partForm.hidden = true;
    formState = null;
    store.state.selection = null;
    store.notify();
    toast(`パーツ「${name}」を登録しました`);
  });
  partCancelBtn.addEventListener("click", () => {
    partForm.hidden = true;
    formState = null;
  });

  // -------------------------------------------------------------------
  // パーツ一覧
  // -------------------------------------------------------------------
  function renderPartList() {
    const p = project();
    const rig = p.rig;
    partList.innerHTML = "";
    if (!rig || !rig.parts.length) {
      const li = document.createElement("li");
      li.className = "part-empty";
      li.textContent = "パーツ未登録（矩形選択→登録、またはAI自動分割）";
      partList.appendChild(li);
      return;
    }
    for (const part of rig.parts) {
      const li = document.createElement("li");
      li.className = "part-item" + (store.state.rigSelectedPart === part.id ? " is-selected" : "");

      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = part.visible !== false;
      vis.title = "表示（合成に含める）";
      vis.addEventListener("change", () => { part.visible = vis.checked; store.notify(); });
      li.appendChild(vis);

      const name = document.createElement("button");
      name.className = "part-name";
      name.textContent = part.name;
      name.title = `id: ${part.id} / patch: (${part.patch.x},${part.patch.y}) ${part.patch.w}x${part.patch.h} / pivot: (${part.pivot.x},${part.pivot.y})`;
      name.addEventListener("click", () => {
        store.state.rigSelectedPart = store.state.rigSelectedPart === part.id ? null : part.id;
        store.notify();
      });
      li.appendChild(name);

      const z = document.createElement("input");
      z.type = "number";
      z.className = "part-z";
      z.value = String(part.z);
      z.title = "z順（小さいほど奥）";
      z.addEventListener("change", () => { part.z = Number(z.value) || 0; store.notify(); });
      li.appendChild(z);

      const parent = document.createElement("select");
      parent.className = "part-parent";
      parent.title = "親パーツ";
      parent.innerHTML = '<option value="">親なし</option>' +
        rig.parts.filter((o) => o.id !== part.id)
          .map((o) => `<option value="${o.id}"${o.id === part.parent ? " selected" : ""}>${o.name}</option>`).join("");
      parent.addEventListener("change", () => { part.parent = parent.value; store.notify(); });
      li.appendChild(parent);

      const del = document.createElement("button");
      del.className = "btn btn-small";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        store.pushUndo();
        rig.parts = rig.parts.filter((o) => o !== part);
        for (const o of rig.parts) if (o.parent === part.id) o.parent = "";
        if (store.state.rigSelectedPart === part.id) store.state.rigSelectedPart = null;
        store.notify();
      });
      li.appendChild(del);

      partList.appendChild(li);
    }
  }

  // -------------------------------------------------------------------
  // 共通リクエストフィールド
  // -------------------------------------------------------------------
  function baseRequestFields() {
    const p = project();
    return {
      project: {
        width: p.width,
        height: p.height,
        fps: p.fps,
        palette: p.palette,
        framesGrid: p.frames.map((_, i) => frameToGridString(p, i)),
      },
      baseFrameGrid: pixelsToGridString(basePixels(p), p.width, p.height, p.palette.length),
      lockedRects: (p.lockedRects || []).map((r) => ({ ...r })),
      ...styleRequestFields(p, store.state.serverConfig), // §17.3
    };
  }

  function setBusy(busy, label) {
    rigGenerateBtn.disabled = busy;
    rigCleanupBtn.disabled = busy;
    segmentBtn.disabled = busy;
    rigAbortBtn.disabled = !busy;
    rigProgress.classList.toggle("is-busy", busy);
    if (label !== undefined) rigProgress.textContent = label;
  }
  rigAbortBtn.addEventListener("click", () => { if (abortController) abortController.abort(); });

  // -------------------------------------------------------------------
  // AI自動分割（mode:"segment"・§14.2）
  // -------------------------------------------------------------------
  segmentBtn.addEventListener("click", async () => {
    const p = project();
    abortController = new AbortController();
    setBusy(true, "AI自動分割中…");
    try {
      const body = {
        ...baseRequestFields(),
        mode: "segment",
        scope: "all",
        instruction: "ベースフレームのキャラクターをパーツ（頭/胴/右腕/左腕/右脚/左脚/武器など）に分割してください",
        images: [{ frame: 0, dataUrl: pixelsToPngDataUrl(basePixels(p), p.width, p.height, p.palette, 8) }],
      };
      const evt = await streamEdit(body, { signal: abortController.signal });
      const seg = evt.segment;
      if (!seg || !seg.parts.length) throw new Error("パーツが返されませんでした");
      store.pushUndo();
      const rig = ensureRig(p);
      const base = basePixels(p);
      rig.parts = seg.parts.map((sp) => ({
        id: sp.id,
        name: sp.name,
        patch: { x: sp.x, y: sp.y, w: sp.w, h: sp.h, pixels: cutPatch(base, p.width, sp) },
        pivot: { x: sp.pivotX, y: sp.pivotY },
        z: sp.z,
        parent: sp.parent || "",
        visible: true,
      }));
      store.state.rigSelectedPart = null;
      store.notify();
      const warn = seg.warnings?.length ? `（警告: ${seg.warnings.join(" / ")}）` : "";
      setBusy(false, `分割完了: ${rig.parts.length}パーツ ${warn}`);
      toast(`${seg.note}（下書き。一覧で調整できます）`);
    } catch (err) {
      setBusy(false, err.name === "AbortError" ? "中断しました" : `エラー: ${err.message}`);
      if (err.name !== "AbortError") toast(err.message, "error");
    } finally {
      abortController = null;
    }
  });

  // -------------------------------------------------------------------
  // フレーム生成（§14.3-4）
  // -------------------------------------------------------------------
  rigGenerateBtn.addEventListener("click", () => {
    const p = project();
    const rig = ensureRig(p);
    if (!rig.parts.length) {
      toast("パーツがありません。矩形選択から登録するか、AI自動分割を実行してください", "error");
      return;
    }
    const nFrames = Math.max(2, Math.min(12, Number(rigFrames.value) || 4));
    const magnitude = Number(rigMagnitude.value) || 1;
    const keyframes = buildKeyframes(rigPreset.value, nFrames, magnitude, rigBounce.checked, rig.parts);
    const composed = keyframes.map((kf) => ({ pixels: composeRigFrame(p, kf) }));

    store.pushUndo();
    const applyMode = document.querySelector('input[name="rigApply"]:checked')?.value || "replace";
    if (applyMode === "replace") {
      const removed = p.frames.length - 1;
      p.frames = [p.frames[0], ...composed];
      for (let i = 0; i < removed; i++) adjustTagsOnDelete(p, 1); // §16.1: タグ範囲の自動補正
      adjustTagsOnInsert(p, 1, composed.length);
      rig.generatedAt = 1;
    } else {
      rig.generatedAt = p.frames.length;
      p.frames.push(...composed);
    }
    // §16.1: 生成結果を新しいタグとして追加（プリセット名から自動命名）
    const genTag = addGeneratedTag(p, rigPreset.value, rig.generatedAt, rig.generatedAt + composed.length - 1);
    genTag.fps = p.fps;
    store.state.activeTagIndex = p.tags.indexOf(genTag);
    rig.keyframes = keyframes;
    store.clampAfterProjectChange();
    store.state.currentFrame = rig.generatedAt;
    store.notify();
    setBusy(false, `${nFrames}フレームを生成しました（フレーム${rig.generatedAt}〜）。AI清書で継ぎ目を修正できます`);
    toast(`リグから${nFrames}フレームを生成しました`);
  });

  // -------------------------------------------------------------------
  // AI清書（mode:"cleanup"・§14.4-2。フレームごとに並列リクエスト）
  // -------------------------------------------------------------------
  rigCleanupBtn.addEventListener("click", async () => {
    const p = project();
    const rig = p.rig;
    if (!rig || rig.generatedAt === null || !rig.keyframes.length) {
      toast("先に「フレーム生成」を実行してください", "error");
      return;
    }
    const frameIndexes = [];
    for (let i = 0; i < rig.keyframes.length; i++) {
      const fi = rig.generatedAt + i;
      if (fi < p.frames.length) frameIndexes.push(fi);
    }
    if (!frameIndexes.length) {
      toast("清書対象のフレームがありません", "error");
      return;
    }

    abortController = new AbortController();
    let doneCount = 0;
    setBusy(true, `清書中… 0/${frameIndexes.length}`);

    const common = baseRequestFields();
    const tasks = frameIndexes.map((fi) => {
      const body = {
        ...common,
        mode: "cleanup",
        scope: "frame",
        frameIndex: fi,
        allowedMask: buildAllowedMask(p, p.frames[fi].pixels),
        instruction: "リグ合成による回転ジャギーとパーツ継ぎ目の隙間を、パレット内の色・最小差分で清書してください",
        images: [{ frame: fi, dataUrl: frameToPngDataUrl(p, fi, 8) }],
      };
      return streamEdit(body, { signal: abortController.signal }).then((evt) => {
        doneCount++;
        rigProgress.textContent = `清書中… ${doneCount}/${frameIndexes.length}`;
        return evt;
      });
    });

    const results = await Promise.allSettled(tasks);
    abortController = null;

    const okResults = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message || String(r.reason));

    if (okResults.length) {
      store.pushUndo();
      let cells = 0;
      const warnings = [];
      for (const evt of okResults) {
        cells += applyEditsToFrames(p, evt.patch.edits);
        if (evt.patch.warnings?.length) warnings.push(...evt.patch.warnings);
      }
      store.notify();
      const warnText = warnings.length ? ` / 警告: ${[...new Set(warnings)].join(" / ")}` : "";
      setBusy(false, `清書完了: ${okResults.length}/${frameIndexes.length}フレーム、適用セル数 ${cells}${warnText}`);
      toast(`AI清書を適用しました（${okResults.length}フレーム）`);
    } else {
      const aborted = errors.some((e) => /abort/i.test(e));
      setBusy(false, aborted ? "中断しました" : `エラー: ${errors[0] || "清書に失敗しました"}`);
      if (!aborted && errors[0]) toast(errors[0], "error");
    }
    if (okResults.length && errors.length) {
      toast(`一部のフレームの清書に失敗しました: ${errors[0]}`, "error");
    }
  });

  function applyEditsToFrames(p, edits) {
    let cells = 0;
    const cw = cellChars(p.palette.length);
    const wide = cw === 2;
    for (const e of edits) {
      const frame = p.frames[e.frame];
      if (!frame) continue;
      for (let ry = 0; ry < e.rows.length; ry++) {
        const tokens = splitTokens(e.rows[ry], cw);
        const py = e.y + ry;
        if (py < 0 || py >= p.height) continue;
        for (let rx = 0; rx < tokens.length; rx++) {
          const idx = indexForToken(tokens[rx], wide);
          if (idx < 0 || idx >= p.palette.length) continue;
          const px = e.x + rx;
          if (px < 0 || px >= p.width) continue;
          frame.pixels[py * p.width + px] = idx;
          cells++;
        }
      }
    }
    return cells;
  }

  // -------------------------------------------------------------------
  // フレーム単位の微調整（§14.5: パーツのドラッグ移動 / 回転）
  // -------------------------------------------------------------------
  function currentKeyframeIndex() {
    const p = project();
    const rig = p.rig;
    if (!rig || rig.generatedAt === null) return -1;
    const idx = store.state.currentFrame - rig.generatedAt;
    if (idx < 0 || idx >= rig.keyframes.length || store.state.currentFrame >= p.frames.length) return -1;
    return idx;
  }

  function adjustSelected(ddx, ddy, drot, pushUndo = true) {
    const p = project();
    const rig = p.rig;
    const kfIdx = currentKeyframeIndex();
    const partId = store.state.rigSelectedPart;
    if (kfIdx === -1 || !partId) {
      toast("生成済みフレームを選び、パーツ一覧から調整するパーツを選択してください", "error");
      return;
    }
    if (pushUndo) store.pushUndo();
    const kf = rig.keyframes[kfIdx];
    const cur = kf[partId] || { dx: 0, dy: 0, rot: 0 };
    kf[partId] = { dx: cur.dx + ddx, dy: cur.dy + ddy, rot: roundRot(cur.rot + drot) };
    p.frames[store.state.currentFrame].pixels = composeRigFrame(p, kf);
    store.notify();
  }

  document.getElementById("adjLeft").addEventListener("click", () => adjustSelected(-1, 0, 0));
  document.getElementById("adjRight").addEventListener("click", () => adjustSelected(1, 0, 0));
  document.getElementById("adjUp").addEventListener("click", () => adjustSelected(0, -1, 0));
  document.getElementById("adjDown").addEventListener("click", () => adjustSelected(0, 1, 0));
  document.getElementById("adjRotL").addEventListener("click", () => adjustSelected(0, 0, -15));
  document.getElementById("adjRotR").addEventListener("click", () => adjustSelected(0, 0, 15));

  rigAdjustModeToggle.addEventListener("change", () => {
    store.state.rigAdjustMode = rigAdjustModeToggle.checked;
    store.notify();
  });

  // キャンバスドラッグでパーツ移動（調整モードON時のみ。editor.jsは調整モード中は無視する）
  let dragState = null;
  mainCanvas.addEventListener("mousedown", (ev) => {
    if (!store.state.rigAdjustMode) return;
    const kfIdx = currentKeyframeIndex();
    const partId = store.state.rigSelectedPart;
    if (kfIdx === -1 || !partId) return;
    const rect = mainCanvas.getBoundingClientRect();
    const cellSize = store.state.zoom;
    store.pushUndo();
    const cur = project().rig.keyframes[kfIdx][partId] || { dx: 0, dy: 0, rot: 0 };
    dragState = {
      startX: Math.floor((ev.clientX - rect.left) / cellSize),
      startY: Math.floor((ev.clientY - rect.top) / cellSize),
      origDx: cur.dx, origDy: cur.dy, rot: cur.rot,
      kfIdx, partId, cellSize,
    };
  });
  window.addEventListener("mousemove", (ev) => {
    if (!dragState) return;
    const rect = mainCanvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / dragState.cellSize);
    const y = Math.floor((ev.clientY - rect.top) / dragState.cellSize);
    const p = project();
    const kf = p.rig.keyframes[dragState.kfIdx];
    kf[dragState.partId] = {
      dx: dragState.origDx + (x - dragState.startX),
      dy: dragState.origDy + (y - dragState.startY),
      rot: dragState.rot,
    };
    p.frames[p.rig.generatedAt + dragState.kfIdx].pixels = composeRigFrame(p, kf);
    store.notify();
  });
  window.addEventListener("mouseup", () => { dragState = null; });

  // -------------------------------------------------------------------
  // 表示更新
  // -------------------------------------------------------------------
  function renderAdjustInfo() {
    const kfIdx = currentKeyframeIndex();
    const partId = store.state.rigSelectedPart;
    if (kfIdx === -1 || !partId) {
      adjInfo.textContent = partId
        ? "現在のフレームはリグ生成フレームではありません"
        : "パーツ一覧からパーツを選択してください";
      return;
    }
    const kf = project().rig.keyframes[kfIdx][partId] || { dx: 0, dy: 0, rot: 0 };
    adjInfo.textContent = `フレーム${store.state.currentFrame} / ${partId}: dx=${kf.dx}, dy=${kf.dy}, rot=${kf.rot}°`;
  }

  store.subscribe(() => {
    renderPartList();
    renderAdjustInfo();
    rigAdjustModeToggle.checked = !!store.state.rigAdjustMode;
  });
  renderPartList();
  renderAdjustInfo();
}
