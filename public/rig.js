// rig.js — §14 2Dパーツリグモード
// パーツ切り出し・AI自動分割(mode:segment)・キーフレームテーブルによるモーション生成・
// z順/pivot回転合成・AI清書(mode:cleanup)・フレーム単位の微調整
import { streamEdit } from "./api.js";
import { extractMainPalette } from "./convert.js";
import {
  frameToGridString,
  charForIndex,
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

// §22.7: パーツの「役割」— 明示的な part.role が名前推定より常に優先。
// "other" は胴と同じ扱い（バウンスのみ）だが、名前推定に戻らない明示的な選択。
export const PART_ROLES = ["head", "torso", "arm_r", "arm_l", "leg_r", "leg_l", "weapon", "other"];
export const PART_ROLE_LABELS = {
  head: "頭", torso: "胴", arm_r: "右腕", arm_l: "左腕",
  leg_r: "右脚", leg_l: "左脚", weapon: "武器", other: "その他",
};
export function effectiveRole(part) {
  // 未知の値は無視して名前推定へフォールバック（§22.7-4）
  return part.role && PART_ROLES.includes(part.role) ? part.role : roleOf(part);
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
      // 優先順位: §22.2 固定（最優先・胴と同じ変換のみ）> §22.7 明示 role > 名前推定。
      // "other" はテーブル参照上は胴と同じ（バウンスのみ）。
      const eff = part.fixed ? "torso" : effectiveRole(part);
      const role = eff === "other" ? "torso" : eff;
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

// §22.1/§22.6: 描き直しの対象領域マスク（純関数・検証しやすいよう module レベルで export）
// area:
//   rotated: rot≠0 のパーツの移動前後矩形の和+2px ∪ 回転パーツ×親パーツの継ぎ目帯±2px（§22.6・既定）
//   moved  : ベースとの差分セルの5px膨張 ∪ 移動パーツの矩形（移動前後+2px）
//   full   : 現フレームの非透明bbox+1px
// 戻り値: { mask, fellBack } — rotated 指定で rot≠0 のパーツが無いときは moved に自動フォールバック（fellBack=true）
export function computeRedrawMask(p, frameIndex, kfIdx, area) {
  const { width, height } = p;
  const cur = p.frames[frameIndex].pixels;
  const base = p.baseFrame || p.frames[0].pixels;
  const rows = Array.from({ length: height }, () => new Uint8Array(width));
  const markRect = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) rows[y][x] = 1;
  };
  const kf = p.rig?.keyframes?.[kfIdx];
  let fellBack = false;

  if (area === "full") {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (cur[y * width + x] !== 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 >= 0) markRect(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    return { mask: rows.map((r) => Array.from(r).join("")).join("\n"), fellBack };
  }

  if (area === "rotated") {
    // §22.6-1: 平行移動はドット絵を劣化させない。崩れるのは回転パーツとその継ぎ目だけ。
    const parts = (p.rig?.parts || []).filter((pt) => pt.visible !== false);
    const rotated = kf ? parts.filter((pt) => ((kf[pt.id] || ZERO).rot || 0) !== 0) : [];
    if (!rotated.length) {
      area = "moved"; // rot≠0 のパーツが無い → 旧 moved 方式へ自動フォールバック
      fellBack = true;
    } else {
      const worlds = worldTransforms(parts, kf);
      const byId = new Map(parts.map((pt) => [pt.id, pt]));
      for (const pt of rotated) {
        const r = pt.patch;
        // 移動前の矩形 +2px
        markRect(r.x - 2, r.y - 2, r.x + r.w + 1, r.y + r.h + 1);
        // 移動後（親変換込みのワールド変換で回転した）矩形のbbox +2px
        const M = worlds.get(pt.id) || IDENTITY;
        const corners = [
          applyT(M, r.x, r.y), applyT(M, r.x + r.w, r.y), applyT(M, r.x, r.y + r.h), applyT(M, r.x + r.w, r.y + r.h),
        ];
        markRect(
          Math.floor(Math.min(...corners.map((c) => c[0]))) - 2,
          Math.floor(Math.min(...corners.map((c) => c[1]))) - 2,
          Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1,
          Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1,
        );
        // 回転パーツ×親パーツ矩形の重なり帯（継ぎ目）±2px
        const parent = pt.parent ? byId.get(pt.parent) : null;
        if (parent) {
          const q = parent.patch;
          const ix0 = Math.max(r.x, q.x) - 2, iy0 = Math.max(r.y, q.y) - 2;
          const ix1 = Math.min(r.x + r.w, q.x + q.w) + 1, iy1 = Math.min(r.y + r.h, q.y + q.h) + 1;
          if (ix0 <= ix1 && iy0 <= iy1) markRect(ix0, iy0, ix1, iy1);
        }
      }
      return { mask: rows.map((r) => Array.from(r).join("")).join("\n"), fellBack };
    }
  }

  // moved: 差分セル（対ベース）を5px膨張 + 移動したパーツの矩形（移動前後+2px）
  const diff = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (cur[y * width + x] !== base[y * width + x]) diff.push([x, y]);
  }
  for (const [x, y] of diff) markRect(x - 5, y - 5, x + 5, y + 5);
  if (kf) {
    for (const part of p.rig.parts) {
      const t = kf[part.id];
      if (!t || (t.dx === 0 && t.dy === 0 && t.rot === 0)) continue;
      const r = part.patch;
      markRect(r.x - 2, r.y - 2, r.x + r.w + 1, r.y + r.h + 1);
      markRect(r.x + t.dx - 2, r.y + t.dy - 2, r.x + t.dx + r.w + 1, r.y + t.dy + r.h + 1);
    }
  }
  return { mask: rows.map((r) => Array.from(r).join("")).join("\n"), fellBack };
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
      li.className = "part-item"
        + (store.state.rigSelectedPart === part.id ? " is-selected" : "")
        + (part.visible === false ? " is-hidden-part" : "");

      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = part.visible !== false;
      vis.title = "合成に含める（外すと次のフレーム生成からこのパーツが除外されます）";
      vis.dataset.helpHover = "rig.partVisible";
      vis.addEventListener("change", () => {
        part.visible = vis.checked;
        if (!vis.checked) toast(`「${part.name}」を合成から除外しました（次のフレーム生成から反映）`);
        store.notify();
      });
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

      // §22.2 固定トグル: ロール変換なし・胴と同じ変換のみ（visibleとは別物）
      const fixLabel = document.createElement("label");
      fixLabel.className = "part-fixed";
      const fix = document.createElement("input");
      fix.type = "checkbox";
      fix.checked = part.fixed === true;
      fix.addEventListener("change", () => {
        part.fixed = fix.checked;
        if (fix.checked) toast(`「${part.name}」を固定しました（次のフレーム生成から胴と同じ動きだけになります）`);
        store.notify();
      });
      fix.dataset.helpHover = "rig.partFixed"; // input直付け（labelに付けるとクリックがヘルプに奪われる）
      fixLabel.appendChild(fix);
      fixLabel.appendChild(document.createTextNode("固定"));
      li.appendChild(fixLabel);

      // §22.7 役割セレクト: 初期値は role ?? 名前推定。変更で role として保存（以降は選択が正）
      const roleSel = document.createElement("select");
      roleSel.className = "part-role";
      roleSel.title = "役割（プリセットモーションでの動き方）";
      roleSel.dataset.helpHover = "rig.partRole";
      const curRole = effectiveRole(part);
      roleSel.innerHTML = PART_ROLES
        .map((r) => `<option value="${r}"${r === curRole ? " selected" : ""}>${PART_ROLE_LABELS[r]}</option>`).join("");
      roleSel.addEventListener("change", () => {
        part.role = roleSel.value;
        store.notify();
        toast(`「${part.name}」の役割を「${PART_ROLE_LABELS[part.role]}」にしました（次のフレーム生成から反映されます）`);
      });
      li.appendChild(roleSel);

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

  // §22.10: 実行中の経過時間ティッカー。「進捗が動かない=固まった」に見える誤解対策
  // （CLI系バックエンドは応答がまとめて届くため、実行中は数字が動かないのが正常）。
  // setBusy(true) で開始・setBusy(false) で必ず停止し、タイマーは残留しない。
  let busyTimer = null;
  let busyStartedAt = 0;
  let busyLabel = "";
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function renderBusyLabel() {
    rigProgress.textContent = `${busyLabel}（経過 ${fmtElapsed(Date.now() - busyStartedAt)}）`;
  }
  // 実行中の進捗文言の更新はここを通す（経過表示を維持したまま差し替え）
  function setBusyLabel(text) {
    busyLabel = text;
    renderBusyLabel();
  }
  function setBusy(busy, label) {
    rigGenerateBtn.disabled = busy;
    rigCleanupBtn.disabled = busy;
    document.getElementById("rigRedrawBtn").disabled = busy; // §22.9-3: 実行中の多重クリック防止
    segmentBtn.disabled = busy;
    rigAbortBtn.disabled = !busy;
    rigProgress.classList.toggle("is-busy", busy);
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    if (busy) {
      busyStartedAt = Date.now();
      setBusyLabel(label ?? "");
      busyTimer = setInterval(renderBusyLabel, 1000);
    } else if (label !== undefined) {
      rigProgress.textContent = label;
    }
  }
  rigAbortBtn.addEventListener("click", () => { if (abortController) abortController.abort(); });

  // -------------------------------------------------------------------
  // AI自動分割（mode:"segment"・§14.2）
  // -------------------------------------------------------------------
  // §14.5.5: 分割専用の軽量グリッド（高さ≤48・最大8色・1文字表現）を生成
  function buildSegmentGrid(p) {
    const base = basePixels(p);
    const scale = Math.max(1, p.height / 48); // 元解像度 / 縮小解像度
    const segH = Math.max(8, Math.round(p.height / scale));
    const segW = Math.max(4, Math.round(p.width / scale));
    // 使用色を集計 → 最大8色に量子化（extractMainPaletteの重み付きk-meansを再利用）
    const counts = new Uint32Array(p.palette.length);
    for (const v of base) counts[v]++;
    let groups = null;
    let segPalette;
    const usedColors = [];
    for (let i = 1; i < p.palette.length; i++) if (counts[i] > 0) usedColors.push(i);
    if (usedColors.length <= 8) {
      // 8色以下: そのまま詰めて割当て
      groups = new Array(p.palette.length).fill(-1);
      usedColors.forEach((full, gi) => { groups[full] = gi; });
      segPalette = ["#00000000", ...usedColors.map((i) => p.palette[i])];
    } else {
      const mp = extractMainPalette(p.palette, counts, 8);
      groups = mp.groups;
      segPalette = ["#00000000", ...mp.colors];
    }
    const rows = [];
    for (let y = 0; y < segH; y++) {
      const sy = Math.min(p.height - 1, Math.floor((y + 0.5) * scale));
      let row = "";
      for (let x = 0; x < segW; x++) {
        const sx = Math.min(p.width - 1, Math.floor((x + 0.5) * scale));
        const idx = base[sy * p.width + sx];
        row += idx === 0 || groups[idx] < 0 ? "." : charForIndex(groups[idx] + 1);
      }
      rows.push(row);
    }
    return { grid: rows.join("\n"), scale, palette: segPalette, segW, segH };
  }

  segmentBtn.addEventListener("click", async () => {
    const p = project();
    abortController = new AbortController();
    setBusy(true, "AI自動分割中…");
    try {
      const seg = buildSegmentGrid(p);
      const body = {
        ...baseRequestFields(),
        mode: "segment",
        scope: "all",
        segmentGrid: seg.grid,
        segmentScale: seg.scale,
        segmentPalette: seg.palette,
        instruction: "ベースフレームのキャラクターをパーツ（頭/胴/右腕/左腕/右脚/左脚/武器など）に分割してください",
        images: [{ frame: 0, dataUrl: pixelsToPngDataUrl(basePixels(p), p.width, p.height, p.palette, 8) }],
      };
      const evt = await streamEdit(body, { signal: abortController.signal });
      const result = evt.segment;
      if (!result || !result.parts.length) throw new Error("パーツが返されませんでした");
      store.pushUndo();
      const rig = ensureRig(p);
      const hadParts = rig.parts.length > 0;
      const base = basePixels(p);
      // §14.5.5: 縮小グリッド座標 → 元解像度へスケール（矩形は外接方向へ丸め、pivotは比率維持）
      const sc = seg.scale;
      rig.parts = result.parts.map((sp) => {
        const x0 = Math.max(0, Math.floor(sp.x * sc));
        const y0 = Math.max(0, Math.floor(sp.y * sc));
        const x1 = Math.min(p.width, Math.ceil((sp.x + sp.w) * sc));
        const y1 = Math.min(p.height, Math.ceil((sp.y + sp.h) * sc));
        const w = Math.max(1, x1 - x0);
        const h = Math.max(1, y1 - y0);
        const rect = { x: x0, y: y0, w, h };
        return {
          id: sp.id,
          name: sp.name,
          patch: { ...rect, pixels: cutPatch(base, p.width, rect) },
          pivot: {
            x: Math.max(0, Math.min(w - 1, Math.round(((sp.pivotX + 0.5) / sp.w) * w))),
            y: Math.max(0, Math.min(h - 1, Math.round(((sp.pivotY + 0.5) / sp.h) * h))),
          },
          z: sp.z,
          parent: sp.parent || "",
          visible: true,
        };
      });
      store.state.rigSelectedPart = null;
      store.notify();
      const warn = result.warnings?.length ? `（警告: ${result.warnings.join(" / ")}）` : "";
      setBusy(false, `分割完了: ${rig.parts.length}パーツ ${warn}`);
      toast(hadParts ? `${result.note}（既存パーツを置き換えました。Ctrl+Zで戻せます）` : `${result.note}（下書き。一覧で調整できます）`);
    } catch (err) {
      // §14.5.5-3: 失敗時は簡易分割を案内
      const hint = "。簡易分割（AIなし）をお試しください";
      setBusy(false, err.name === "AbortError" ? "中断しました" : `エラー: ${err.message}${hint}`);
      if (err.name !== "AbortError") toast(`${err.message}${hint}`, "error");
    } finally {
      abortController = null;
    }
  });

  // -------------------------------------------------------------------
  // §14.5.5-2: 簡易分割（AIなし）— 人型ヒューリスティックで即時下書き
  // -------------------------------------------------------------------
  function heuristicSegment(p) {
    const base = basePixels(p);
    // 非透明bbox
    let x0 = p.width, y0 = p.height, x1 = -1, y1 = -1;
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
      if (base[y * p.width + x] !== 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) throw new Error("ベースフレームに不透明ピクセルがありません");
    const W = x1 - x0 + 1, H = y1 - y0 + 1;
    const yHead = y0 + Math.round(H * 0.25);   // 頭=上25%
    const yTorso = y0 + Math.round(H * 0.65);  // 胴=中央40%（25〜65%）、脚=下35%
    const xTorsoL = x0 + Math.round(W * 0.25); // 胴の中央帯（幅50%）
    const xTorsoR = x0 + Math.round(W * 0.75);
    const xMid = x0 + Math.round(W / 2);
    const defs = [
      // 定石: 脚z0 → 腕z0 → 胴z1 → 頭z2。pivot=首元/肩/股関節
      { id: "torso", name: "胴", x: xTorsoL, y: yHead, x2: xTorsoR, y2: yTorso, z: 1, parent: "", pivot: "center" },
      { id: "head", name: "頭", x: x0, y: y0, x2: x1 + 1, y2: yHead, z: 2, parent: "torso", pivot: "bottom-center" },
      { id: "arm_r", name: "右腕", x: x0, y: yHead, x2: xTorsoL, y2: yTorso, z: 0, parent: "torso", pivot: "top-right" },
      { id: "arm_l", name: "左腕", x: xTorsoR, y: yHead, x2: x1 + 1, y2: yTorso, z: 0, parent: "torso", pivot: "top-left" },
      { id: "leg_r", name: "右脚", x: x0, y: yTorso, x2: xMid, y2: y1 + 1, z: 0, parent: "torso", pivot: "top-center" },
      { id: "leg_l", name: "左脚", x: xMid, y: yTorso, x2: x1 + 1, y2: y1 + 1, z: 0, parent: "torso", pivot: "top-center" },
    ];
    const parts = [];
    for (const d of defs) {
      const w = d.x2 - d.x, h = d.y2 - d.y;
      if (w < 1 || h < 1) continue;
      const rect = { x: d.x, y: d.y, w, h };
      const pixels = cutPatch(base, p.width, rect);
      if (!pixels.some((v) => v !== 0)) continue; // 空パーツはスキップ
      let pivot;
      if (d.pivot === "bottom-center") pivot = { x: Math.floor(w / 2), y: h - 1 };
      else if (d.pivot === "top-center") pivot = { x: Math.floor(w / 2), y: 0 };
      else if (d.pivot === "top-left") pivot = { x: 0, y: 0 };
      else if (d.pivot === "top-right") pivot = { x: w - 1, y: 0 };
      else pivot = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
      parts.push({ id: d.id, name: d.name, patch: { ...rect, pixels }, pivot, z: d.z, parent: d.parent, visible: true });
    }
    // torso が無ければ parent を解除
    if (!parts.some((pt) => pt.id === "torso")) for (const pt of parts) pt.parent = "";
    return parts;
  }

  const heuristicSegmentBtn = document.getElementById("heuristicSegmentBtn");
  heuristicSegmentBtn.addEventListener("click", () => {
    const p = project();
    try {
      const parts = heuristicSegment(p);
      if (!parts.length) throw new Error("パーツを生成できませんでした");
      store.pushUndo();
      const rig = ensureRig(p);
      const hadParts = rig.parts.length > 0;
      rig.parts = parts;
      store.state.rigSelectedPart = null;
      store.notify();
      setBusy(false, `簡易分割完了: ${parts.length}パーツ（人型ヒューリスティック・下書き）`);
      toast(hadParts ? "簡易分割で置き換えました（Ctrl+Zで戻せます）" : "簡易分割で下書きを生成しました。一覧で調整できます");
    } catch (err) {
      toast(err.message, "error");
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
  // §22.9-3: どんな例外でも必ず setBusy(false) で終わらせる共通ラッパ（実機報告
  // 「フォールバック後に描き直し中…のまま止まる」= setBusy(true) 以降の同期例外で
  // ハンドラが死に busy 表示が残るパターンへの恒久対策。清書側も同構造のため同様に包む）
  const guardBusy = (label, fn) => async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[${label}] 予期しないエラー:`, err);
      abortController = null;
      setBusy(false, `エラー: ${err.message}`);
      toast(`${label}に失敗しました: ${err.message}`, "error");
    }
  };

  rigCleanupBtn.addEventListener("click", guardBusy("AI清書", async () => {
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
        setBusyLabel(`清書中… ${doneCount}/${frameIndexes.length}`);
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
  }));

  // -------------------------------------------------------------------
  // §22.1: AI描き直し（ポーズガイド）— リグ出力を設計図にAIがベースのテイストで描き直す
  // -------------------------------------------------------------------
  const rigRedrawBtn = document.getElementById("rigRedrawBtn");
  const redrawAreaMode = () => document.querySelector('input[name="redrawArea"]:checked')?.value || "rotated";
  const redrawAllFrames = document.getElementById("redrawAllFrames");

  // §22.10-1: プロンプト補足（実験用ノブ）。localStorage でプロジェクト非依存に永続化
  const redrawPromptExtra = document.getElementById("redrawPromptExtra");
  const PROMPT_EXTRA_KEY = "aiMeglio.redrawPromptExtra";
  try { redrawPromptExtra.value = localStorage.getItem(PROMPT_EXTRA_KEY) || ""; } catch {}
  redrawPromptExtra.addEventListener("input", () => {
    try { localStorage.setItem(PROMPT_EXTRA_KEY, redrawPromptExtra.value); } catch {}
  });

  // §22.10-2: 評価用 — 直近の描き直しセッションのクロップグリッドを組み立てる
  function cropGridRows(pixels, p, rect) {
    const wide = p.palette.length > 32;
    const rows = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      let row = "";
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const v = pixels[y * p.width + x];
        row += wide ? (v === 0 ? ".." : v.toString(16).padStart(2, "0")) : charForIndex(v);
      }
      rows.push(row);
    }
    return rows;
  }
  function cropMaskRows(mask, rect) {
    const lines = mask.split("\n");
    const rows = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) rows.push(lines[y].slice(rect.x, rect.x + rect.w));
    return rows;
  }

  // §22.10-2: 完了ステータス行に「👍うまくいった / 👎ダメだった」を表示（次の操作まで）
  function showRedrawFeedbackUi(session) {
    const wrap = document.createElement("span");
    wrap.className = "redraw-feedback";
    const mk = (label, verdict) => {
      const b = document.createElement("button");
      b.className = "btn btn-small";
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", async () => {
        let comment = "";
        if (verdict === "bad") comment = window.prompt("何がダメでしたか？（任意・ローカルにのみ保存されます）") || "";
        try {
          const res = await fetch("/api/redraw-feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...session, verdict, comment }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          wrap.textContent = ` フィードバックを保存しました（redraw-feedback/${data.file}）`;
          toast("フィードバックを保存しました。プロンプト改善に使われます");
        } catch (err) {
          toast(`フィードバックの保存に失敗しました: ${err.message}`, "error");
        }
      });
      return b;
    };
    wrap.appendChild(document.createTextNode(" 評価:"));
    wrap.appendChild(mk("👍うまくいった", "good"));
    wrap.appendChild(mk("👎ダメだった", "bad"));
    rigProgress.appendChild(wrap);
  }

  // §22.5-3: マスクを連結成分（8近傍）に分割し、成分ごとに
  // { mask(フルサイズ・その成分の'1'のみ), cropRect(bbox+2pxマージン) } を返す
  function splitMaskComponents(p, mask) {
    const { width, height } = p;
    const rows = mask.split("\n");
    const seen = Array.from({ length: height }, () => new Uint8Array(width));
    const comps = [];
    for (let sy = 0; sy < height; sy++) for (let sx = 0; sx < width; sx++) {
      if (rows[sy][sx] !== "1" || seen[sy][sx]) continue;
      // BFS（8近傍）
      const cells = [];
      const queue = [[sx, sy]];
      seen[sy][sx] = 1;
      let x0 = sx, y0 = sy, x1 = sx, y1 = sy;
      while (queue.length) {
        const [cx, cy] = queue.pop();
        cells.push([cx, cy]);
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (rows[ny][nx] !== "1" || seen[ny][nx]) continue;
          seen[ny][nx] = 1;
          queue.push([nx, ny]);
        }
      }
      const grid = Array.from({ length: height }, () => new Uint8Array(width));
      for (const [cx, cy] of cells) grid[cy][cx] = 1;
      const rx = Math.max(0, x0 - 2), ry = Math.max(0, y0 - 2);
      comps.push({
        mask: grid.map((r) => Array.from(r).join("")).join("\n"),
        cropRect: { x: rx, y: ry, w: Math.min(width - 1, x1 + 2) - rx + 1, h: Math.min(height - 1, y1 + 2) - ry + 1 },
        cells: cells.length,
      });
    }
    return comps;
  }

  // 前後フレームの対象領域切り出し（cropRect と同じ矩形を切り出す）
  function redrawNeighborContext(p, frameIndex, cropRect) {
    const cw = cellChars(p.palette.length);
    const { x, y, w, h } = cropRect;
    const out = [];
    for (const nf of [frameIndex - 1, frameIndex + 1]) {
      if (nf < 0 || nf >= p.frames.length) continue;
      const gridRows = frameToGridString(p, nf).split("\n");
      const rows = [];
      for (let ry = y; ry < y + h; ry++) rows.push(gridRows[ry].slice(x * cw, (x + w) * cw));
      out.push({ frame: nf, rows });
    }
    return out.slice(0, 2);
  }

  rigRedrawBtn.addEventListener("click", guardBusy("描き直し", async () => {
    const p = project();
    const rig = p.rig;
    if (!rig || rig.generatedAt === null || !rig.keyframes.length) {
      toast("先に「フレーム生成」を実行してください", "error");
      return;
    }
    let frameIndexes = [];
    if (redrawAllFrames.checked) {
      for (let i = 0; i < rig.keyframes.length; i++) {
        const fi = rig.generatedAt + i;
        if (fi < p.frames.length) frameIndexes.push(fi);
      }
    } else {
      const fi = store.state.currentFrame;
      const kfIdx = fi - rig.generatedAt;
      if (kfIdx < 0 || kfIdx >= rig.keyframes.length) {
        toast("現在のフレームはリグ生成フレームではありません（または「タグ全フレーム」をオンに）", "error");
        return;
      }
      frameIndexes = [fi];
    }

    // §22.5-3: フレームごとのマスクを連結成分に分割し、成分（領域）ごとに
    // bboxクロップ付きの独立リクエストを発行（サーバー側キューの並列2に乗る）
    let jobs = [];
    const fallbackFrames = [];
    for (const fi of frameIndexes) {
      const { mask, fellBack } = computeRedrawMask(p, fi, fi - rig.generatedAt, redrawAreaMode());
      if (fellBack) fallbackFrames.push(fi);
      for (const comp of splitMaskComponents(p, mask)) {
        jobs.push({ fi, mask: comp.mask, cropRect: comp.cropRect, cells: comp.cells });
      }
    }
    // §22.6-1: rot≠0 のパーツが無いキーフレームは moved 方式へ自動フォールバック（トーストで通知）
    if (fallbackFrames.length) {
      toast(`回転した部位が無いため「動いた部位すべて」で領域を作成しました（フレーム${fallbackFrames.join(", ")}）`);
    }
    if (!jobs.length) {
      toast("描き直す領域がありません（ラフがベースと同一です）", "error");
      return;
    }
    // §22.6-3: 大領域ガード — CLI系バックエンドで1リクエストのマスクセル数が閾値超のとき確認。
    // キャンセルで超過リクエストのみ除外（他の領域は続行）。
    const cfg = store.state.serverConfig || {};
    if (cfg.backend === "cli" || cfg.backend === "codex") {
      const maxCells = Number(cfg.redrawMaxCells) > 0 ? Number(cfg.redrawMaxCells) : 1800;
      const big = jobs.filter((j) => j.cells > maxCells);
      if (big.length) {
        const ok = window.confirm(
          `対象領域が大きく（最大 ${Math.max(...big.map((j) => j.cells))}セル > 閾値 ${maxCells}）、タイムアウトの可能性が高いです。` +
          `パーツの「固定」や対象領域「回転した部位のみ」で領域を絞るのがおすすめです。このまま続行しますか？` +
          `（キャンセルで大きい${big.length}領域だけ除外します）`,
        );
        if (!ok) {
          jobs = jobs.filter((j) => j.cells <= maxCells);
          if (!jobs.length) {
            toast("大きい領域を除外した結果、送信する領域がありません", "error");
            return;
          }
          toast(`${big.length}領域を除外して続行します`);
        }
      }
    }

    abortController = new AbortController();
    let doneCount = 0;
    setBusy(true, `描き直し中… 0/${jobs.length}領域`);
    const common = baseRequestFields();
    const tasks = jobs.map((job) => {
      const body = {
        ...common,
        mode: "redraw",
        scope: "frame",
        frameIndex: job.fi,
        allowedMask: job.mask,
        cropRect: job.cropRect,
        neighborContext: redrawNeighborContext(p, job.fi, job.cropRect),
        // §22.10-1: 補足が入力されているときだけ付加（空なら付けない）
        ...(redrawPromptExtra.value.trim() ? { promptExtra: redrawPromptExtra.value.trim() } : {}),
        instruction: "ラフのポーズに合わせて、ベースフレームのテイストで対象領域を描き直してください",
        images: [{ frame: job.fi, dataUrl: frameToPngDataUrl(p, job.fi, p.width > 64 ? 4 : 8) }],
      };
      return streamEdit(body, { signal: abortController.signal }).then((evt) => {
        doneCount++;
        setBusyLabel(`描き直し中… ${doneCount}/${jobs.length}領域`);
        return evt;
      });
    });

    const results = await Promise.allSettled(tasks);
    abortController = null;
    const okResults = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const errs = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message || String(r.reason));
    if (okResults.length) {
      store.pushUndo();
      // §22.9-2: 事後チェック用に、適用前のフレーム（=ラフ）を退避
      const roughByFrame = new Map();
      for (const job of jobs) {
        if (!roughByFrame.has(job.fi)) roughByFrame.set(job.fi, Uint8Array.from(p.frames[job.fi].pixels));
      }
      let cells = 0;
      const warnings = [];
      for (const evt of okResults) {
        cells += applyEditsToFrames(p, evt.patch.edits);
        if (evt.patch.warnings?.length) warnings.push(...evt.patch.warnings);
      }
      store.notify();
      // §22.9-2: ポーズ逆戻りの事後チェック（警告のみ・AI追加呼び出しなし）。
      // マスク領域のうち「ラフとベースが異なるセル」だけで一致率を比較し、
      // 結果がラフよりベースに近い かつ 差が有意（REVERT_MIN_DIFF セル超）なら警告する。
      const REVERT_MIN_DIFF = 30;
      {
        const base = basePixels(p);
        let diffCells = 0, matchBase = 0, matchRough = 0;
        for (const job of jobs) {
          const rough = roughByFrame.get(job.fi);
          const cur = p.frames[job.fi]?.pixels;
          if (!rough || !cur) continue;
          const maskRows = job.mask.split("\n");
          const { x, y, w, h } = job.cropRect;
          for (let yy = y; yy < y + h && yy < p.height; yy++) {
            for (let xx = x; xx < x + w && xx < p.width; xx++) {
              if (maskRows[yy][xx] !== "1") continue;
              const i = yy * p.width + xx;
              if (rough[i] === base[i]) continue; // ラフ=ベースのセルは判別に使えない
              diffCells++;
              if (cur[i] === base[i]) matchBase++;
              else if (cur[i] === rough[i]) matchRough++;
            }
          }
        }
        if (cells > 0 && diffCells > REVERT_MIN_DIFF && matchBase > matchRough) {
          warnings.push("ポーズがベースに戻された可能性があります。指示欄に補足を書いて再実行してください");
        }
      }
      if (errs.length) warnings.push(`${errs.length}領域の描き直しに失敗: ${errs[0]}`);
      const warnText = warnings.length ? ` / 警告: ${[...new Set(warnings)].join(" / ")}` : "";
      if (cells === 0) {
        // §22.5-4: ゼロ適用ガード — 成功トーンではなく警告として表示
        setBusy(false, `AIが変更を返しませんでした（ラフのまま・${okResults.length}/${jobs.length}領域完了）。もう一度実行するか、対象領域を「全身」に切り替えてお試しください${warnText}`);
        toast("AIが変更を返しませんでした（適用セル数 0）", "error");
      } else {
        setBusy(false, `描き直し完了: ${okResults.length}/${jobs.length}領域、適用セル数 ${cells}${warnText}。仕上げにAI清書がおすすめです`);
        toast(`AI描き直しを適用しました（${okResults.length}領域）`);
      }
      // §22.10-2: ワンクリック評価（直近ジョブに紐づく完全なスナップショットを保持して表示）
      {
        const cfg = store.state.serverConfig || {};
        const base = basePixels(p);
        showRedrawFeedbackUi({
          backend: cfg.backend || "api",
          model: cfg.backend === "cli" ? cfg.cliModel : cfg.backend === "codex" ? cfg.codexModel : cfg.model,
          promptExtra: redrawPromptExtra.value.trim(),
          width: p.width,
          height: p.height,
          palette: [...p.palette],
          appliedCells: cells,
          warnings: [...new Set(warnings)],
          jobs: jobs.map((job) => ({
            frameIndex: job.fi,
            cropRect: { ...job.cropRect },
            maskRows: cropMaskRows(job.mask, job.cropRect),
            baseRows: cropGridRows(base, p, job.cropRect),
            roughRows: cropGridRows(roughByFrame.get(job.fi), p, job.cropRect),
            resultRows: cropGridRows(p.frames[job.fi].pixels, p, job.cropRect),
          })),
        });
      }
    } else {
      const aborted = errs.some((e) => /abort/i.test(e));
      setBusy(false, aborted ? "中断しました" : `エラー: ${errs[0] || "描き直しに失敗しました"}`);
      if (!aborted && errs[0]) toast(errs[0], "error");
    }
  }));

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
  // §22.8: パーツ矩形・pivot のドラッグ編集（リグタブ表示中・フロントのみ）
  // 枠線±4pxクリック=選択 / 選択中: 枠内ドラッグ=移動・8ハンドル=リサイズ・
  // pivot十字=支点移動（すべてセルスナップ+クランプ+アンドゥ対象）。
  // 既存のパン/ペン/矩形選択より優先するため canvasWrap の pointerdown を
  // キャプチャ段階で奪い、preventDefault で互換 mousedown を抑止する。
  // -------------------------------------------------------------------
  const canvasWrap = document.getElementById("canvasWrap");
  const rigTabEl = document.getElementById("rigTab");
  const EDIT_TOL = 4; // ±4px ヒット判定
  let editDrag = null; // { kind, part, hx, hy, startCell, orig, undoPushed }
  let reflectNoteShown = false; // §22.8-4: 「次のフレーム生成から反映」はステータスに一度だけ

  const rigTabVisible = () => rigTabEl && !rigTabEl.hidden;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function editCellFromEvent(ev) {
    const rect = mainCanvas.getBoundingClientRect();
    const cs = store.state.zoom;
    return { x: Math.floor((ev.clientX - rect.left) / cs), y: Math.floor((ev.clientY - rect.top) / cs) };
  }

  // キャンバスピクセル座標でのヒット判定。優先順: 選択中パーツの pivot > ハンドル >
  // 枠内(移動) > 他パーツの枠線±4px(選択)
  function partEditHit(ev) {
    const p = project();
    if (!p.rig?.parts?.length) return null;
    const rect = mainCanvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const cs = store.state.zoom;
    const selId = store.state.rigSelectedPart;
    const sel = p.rig.parts.find((pt) => pt.id === selId);
    if (sel) {
      const r = sel.patch;
      const x0 = r.x * cs, y0 = r.y * cs, x1 = (r.x + r.w) * cs, y1 = (r.y + r.h) * cs;
      // ハンドルを pivot より先に判定する（pivot が枠の辺中央にあるパーツ=脚などで
      // リサイズハンドルが掴めなくなるのを防ぐ。pivot はセル中央側から掴める）
      const xs = [x0, (x0 + x1) / 2, x1];
      const ys = [y0, (y0 + y1) / 2, y1];
      for (let hy = -1; hy <= 1; hy++) for (let hx = -1; hx <= 1; hx++) {
        if (!hx && !hy) continue;
        if (Math.abs(px - xs[hx + 1]) <= EDIT_TOL && Math.abs(py - ys[hy + 1]) <= EDIT_TOL) {
          return { kind: "resize", part: sel, hx, hy };
        }
      }
      const pvx = (r.x + sel.pivot.x + 0.5) * cs, pvy = (r.y + sel.pivot.y + 0.5) * cs;
      if (Math.abs(px - pvx) <= EDIT_TOL + 2 && Math.abs(py - pvy) <= EDIT_TOL + 2) return { kind: "pivot", part: sel };
      if (px >= x0 - EDIT_TOL && px <= x1 + EDIT_TOL && py >= y0 - EDIT_TOL && py <= y1 + EDIT_TOL) {
        return { kind: "move", part: sel };
      }
    }
    // 他パーツの枠線（±4px）→ 選択（重なりは手前=リスト後方を優先）
    for (let i = p.rig.parts.length - 1; i >= 0; i--) {
      const pt = p.rig.parts[i];
      if (pt.id === selId) continue;
      const r = pt.patch;
      const x0 = r.x * cs, y0 = r.y * cs, x1 = (r.x + r.w) * cs, y1 = (r.y + r.h) * cs;
      const inX = px >= x0 - EDIT_TOL && px <= x1 + EDIT_TOL;
      const inY = py >= y0 - EDIT_TOL && py <= y1 + EDIT_TOL;
      const nearTB = inX && (Math.abs(py - y0) <= EDIT_TOL || Math.abs(py - y1) <= EDIT_TOL);
      const nearLR = inY && (Math.abs(px - x0) <= EDIT_TOL || Math.abs(px - x1) <= EDIT_TOL);
      if (nearTB || nearLR) return { kind: "select", part: pt };
    }
    return null;
  }

  function editStatus(part) {
    const r = part.patch;
    rigProgress.textContent = `パーツ「${part.name}」: (${r.x}, ${r.y}) ${r.w}×${r.h} / pivot(${part.pivot.x}, ${part.pivot.y})`;
  }
  function lazyPushUndo(d) {
    if (d.undoPushed) return;
    store.pushUndo();
    d.undoPushed = true;
  }
  // 矩形変更の反映: patch.pixels をベースフレームから切り出し直す
  function applyPartRect(part, nextRect) {
    part.patch = { ...nextRect, pixels: cutPatch(basePixels(project()), project().width, nextRect) };
  }

  canvasWrap.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !rigTabVisible() || ev.target !== mainCanvas) return;
    if (store.state.rigAdjustMode) return; // §14.5 のキーフレーム調整ドラッグを優先
    const hit = partEditHit(ev);
    if (!hit) {
      // 空クリック: 選択解除（ペン等の通常ツールはそのまま動く）
      if (store.state.rigSelectedPart) {
        store.state.rigSelectedPart = null;
        store.notify();
      }
      return;
    }
    ev.preventDefault(); // 互換 mousedown を抑止（editor.js のペン/選択に渡さない）
    ev.stopPropagation(); // canvasWrap のパンにも渡さない
    if (hit.kind === "select" || store.state.rigSelectedPart !== hit.part.id) {
      store.state.rigSelectedPart = hit.part.id;
      store.notify();
    }
    const part = hit.part;
    editDrag = {
      kind: hit.kind === "select" ? "move" : hit.kind, // 枠線クリックは選択+そのまま移動開始
      part,
      hx: hit.hx || 0,
      hy: hit.hy || 0,
      startCell: editCellFromEvent(ev),
      orig: { x: part.patch.x, y: part.patch.y, w: part.patch.w, h: part.patch.h, pivot: { ...part.pivot } },
      undoPushed: false,
    };
    editStatus(part);
  }, true);

  window.addEventListener("pointermove", (ev) => {
    if (!editDrag) return;
    const d = editDrag;
    const p = project();
    const { x: cx, y: cy } = editCellFromEvent(ev);
    const part = d.part;
    if (d.kind === "move") {
      const nx = clampInt(d.orig.x + (cx - d.startCell.x), 0, p.width - d.orig.w);
      const ny = clampInt(d.orig.y + (cy - d.startCell.y), 0, p.height - d.orig.h);
      if (nx !== part.patch.x || ny !== part.patch.y) {
        lazyPushUndo(d);
        applyPartRect(part, { x: nx, y: ny, w: d.orig.w, h: d.orig.h }); // pivot はローカル維持（矩形と一緒に動く）
        store.notify();
      }
    } else if (d.kind === "resize") {
      let x0 = d.orig.x, y0 = d.orig.y;
      let x1 = d.orig.x + d.orig.w - 1, y1 = d.orig.y + d.orig.h - 1;
      if (d.hx < 0) x0 = clampInt(cx, 0, x1);
      if (d.hx > 0) x1 = clampInt(cx, x0, p.width - 1);
      if (d.hy < 0) y0 = clampInt(cy, 0, y1);
      if (d.hy > 0) y1 = clampInt(cy, y0, p.height - 1);
      const next = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; // 最小1×1はクランプで保証
      if (next.x !== part.patch.x || next.y !== part.patch.y || next.w !== part.patch.w || next.h !== part.patch.h) {
        lazyPushUndo(d);
        applyPartRect(part, next);
        // pivot はキャンバス上の同じセルを指し続け、矩形外に出るなら矩形内へクランプ
        part.pivot = {
          x: clampInt(d.orig.x + d.orig.pivot.x - next.x, 0, next.w - 1),
          y: clampInt(d.orig.y + d.orig.pivot.y - next.y, 0, next.h - 1),
        };
        store.notify();
      }
    } else if (d.kind === "pivot") {
      const nx = clampInt(cx - part.patch.x, 0, part.patch.w - 1);
      const ny = clampInt(cy - part.patch.y, 0, part.patch.h - 1);
      if (nx !== part.pivot.x || ny !== part.pivot.y) {
        lazyPushUndo(d);
        part.pivot = { x: nx, y: ny };
        store.notify();
      }
    }
    editStatus(part); // ドラッグ中のライブ表示 (x,y) w×h / pivot(x,y)
  });

  window.addEventListener("pointerup", () => {
    if (!editDrag) return;
    const changed = editDrag.undoPushed;
    const part = editDrag.part;
    editDrag = null;
    if (changed) {
      editStatus(part);
      if (!reflectNoteShown) {
        reflectNoteShown = true;
        rigProgress.textContent += "（次のフレーム生成から反映されます）";
      }
    }
  });

  // Esc で選択解除（リグタブ表示中のみ）
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !rigTabVisible()) return;
    if (store.state.rigSelectedPart) {
      store.state.rigSelectedPart = null;
      store.notify();
    }
  });

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
