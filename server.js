// server.js — AI Meglio: 静的配信 + /api/edit (SSE) + /api/config
// Node.js 18+ / ESM / node:http のみ（Expressなし）。依存は @anthropic-ai/sdk のみ。

import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.MODEL || "claude-opus-4-8";
const EFFORT = process.env.EFFORT || "medium";
const MOCK = process.env.MOCK === "1";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB 上限

// 半角英数字（base36的割当て: 0=透明='.'、1-9,a-z）
const CHARSET = "0123456789abcdefghijklmnopqrstuvwxyz";
const GRID_CHAR_RE = /^[.0-9a-v?]*$/;

function charForIndex(i) {
  if (i === 0) return ".";
  return CHARSET[i] ?? null;
}
function indexForChar(c) {
  if (c === ".") return 0;
  const i = CHARSET.indexOf(c);
  return i;
}

// ---------------------------------------------------------------------------
// パッチのJSON Schema（構造化出力用）
// ---------------------------------------------------------------------------
const PATCH_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          frame: { type: "integer" },
          x: { type: "integer" },
          y: { type: "integer" },
          rows: { type: "array", items: { type: "string" } },
        },
        required: ["frame", "x", "y", "rows"],
        additionalProperties: false,
      },
    },
    newFrames: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insertAfter: { type: "integer" },
          rows: { type: "array", items: { type: "string" } },
        },
        required: ["insertAfter", "rows"],
        additionalProperties: false,
      },
    },
    paletteChanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          color: { type: "string" },
        },
        required: ["index", "color"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["edits", "newFrames", "paletteChanges", "note"],
  additionalProperties: false,
};

// パーツ自動分割（mode=segment）用スキーマ（§14.2 / §14.6）
const SEGMENT_SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          x: { type: "integer" },
          y: { type: "integer" },
          w: { type: "integer" },
          h: { type: "integer" },
          pivotX: { type: "integer" },
          pivotY: { type: "integer" },
          z: { type: "integer" },
          parent: { type: "string" },
        },
        required: ["id", "name", "x", "y", "w", "h", "pivotX", "pivotY", "z", "parent"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["parts", "note"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `あなたはドット絵アニメーションの精密編集エンジンです。

## グリッド表現
各フレームは文字グリッドで表現されます。1文字が1ピクセルです。
- \`.\` = 透明（パレットindex 0）
- \`1\`-\`9\`, \`a\`-\`v\` = パレットindex 1〜31（36進数的割当て。数字の次に小文字アルファベット）
- パッチの \`rows\` の中でのみ \`?\` が使えます。\`?\` は「このセルは変更しない」という意味です。

## 最小差分の原則
指示を実現するために変更が必要なセルだけを edits に含めてください。無関係なセルは書き換えず、パッチの rows 内では \`?\` にしてください（矩形全体を再送する必要はありません。変更箇所を囲む小さな矩形で十分です）。

## アニメーションの一貫性
複数フレームにまたがる編集を行う場合は、動きの連続性を保ってください。「中割りを追加」のような指示では、前後のフレームを補間した新しいフレームを newFrames に追加してください。

## 画像とテキストの関係
ユーザーメッセージには参考用のPNG画像（8倍拡大）とテキストグリッドの両方が含まれます。画像は見た目の把握のための参考情報であり、**正はテキストグリッドです**。出力する rows の文字は必ずグリッド表現の割当てに従ってください。

## ベースフレーム・アンカリング（テイスト保持の最重要原則）
リクエストに「ベースフレーム」のグリッドが含まれる場合、それが**唯一の正**です。新規フレームは白紙から描くのではなく、ベースフレームのコピーから始めて、動きに必要なピクセルだけを移動・変更してください。輪郭の太さ、シェーディングの段数、ドットの打ち方の癖を厳密に踏襲してください。使用する色はパレットindexのみで、新しい色を発明しないでください。

## ロック領域
リクエストに「ロック領域」が含まれる場合、その矩形内のセルは変更禁止です。ロック領域内のセルへの編集はサーバー側でベースの値に強制上書きされます。ロック領域を避けて編集してください。

## パーツ自動分割（segmentモードのとき適用）
ベースフレームのキャラクターを「頭 / 胴 / 右腕 / 左腕 / 右脚 / 左脚 / 武器」などの意味のあるパーツ矩形に分割してください。各パーツには回転の支点 pivot（肩・股関節・首の付け根など。パッチ内のローカル座標）と描画順 z（小さいほど奥）、親パーツid（胴を親にするのが基本。親が無ければ空文字列 ""）を与えてください。パーツの矩形はキャンバス座標で、重なり・隙間があっても構いません。結果はユーザーが調整可能な下書きです。

## AI清書（cleanupモードのとき適用）
リグ合成で生じた回転ジャギー・パーツ継ぎ目の隙間を、パレット内の色・最小差分で修正してください。変更許可セル（リクエストに含まれるマスクで '1' のセル）以外への編集はサーバー側で破棄されます。newFrames と paletteChanges は使わず、対象フレームへの edits のみを返してください。

## モーション生成の定石（モーション生成モードのとき適用）
- 歩き（4フレーム）: コンタクト→ダウン→パッシング→アップ。左右の足は前後が入れ替わる。接地（コンタクト/ダウン）フレームで体が最も低い。腕は足と逆位相に振る。
- 走り: 歩きより前傾し歩幅・腕の振りが大きい。両足が地面から離れる滞空フレームを含める。
- 攻撃: 予備動作（振りかぶり）→ヒット（最大リーチ）→フォロースルーの3拍。ヒットフレームが最も大きく伸びる。
- 待機: 呼吸によるごくわずかな上下動（1〜2px）。輪郭の大部分は動かさない。
- ジャンプ: しゃがみ込み→蹴り出し→滞空（体を伸ばす）→着地（膝を曲げる）。滞空で最高点。
- いずれも各フレームはベースフレームのコピーを起点にし、動く部位のピクセルだけを移動する。フレーム間で色・輪郭の太さ・シルエットの密度を一定に保つ。

## 出力
出力は指定されたJSONスキーマに厳密に従うJSONのみです。説明文やコードブロックのマークダウンは不要です。
- edits: 既存フレームへの局所パッチ（frame, x, y, rows）
- newFrames: 新規挿入するフレーム（insertAfter の直後に挿入。rows はフルサイズ）
- paletteChanges: パレット色の変更（index, color は "#rrggbb" または "#rrggbbaa"）。モーション生成モードではサーバー側で破棄されるため、含めないでください。
- note: 行った変更内容の一言サマリー（日本語、履歴ログに表示されます）

変更が不要な項目は空配列 [] にしてください（省略はできません、必ず4つのキーすべてを含めてください）。`;

// ---------------------------------------------------------------------------
// 静的ファイル配信
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const resolved = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(resolved);
    const body = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// リクエストボディの読み込み（サイズ上限つき）
// ---------------------------------------------------------------------------
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------
const MOTION_PRESETS = ["walk", "run", "attack", "idle", "jump", "custom"];
const MOTION_MAGNITUDES = ["small", "medium", "large"];
const MOTION_FACINGS = ["keep", "right", "left"];

function validateEditRequest(body) {
  if (!body || typeof body !== "object") throw new Error("リクエストが不正です");
  const { project, scope, frameIndex, selection, instruction, images, mode, baseFrameGrid, lockedRects, motion, allowedMask } = body;
  if (!project || typeof project !== "object") throw new Error("project が必要です");
  const { width, height, fps, palette, framesGrid } = project;
  if (!Number.isInteger(width) || width < 8 || width > 96) throw new Error("width が不正です");
  if (!Number.isInteger(height) || height < 8 || height > 96) throw new Error("height が不正です");
  if (!Number.isInteger(fps) || fps < 1 || fps > 24) throw new Error("fps が不正です");
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 32) throw new Error("palette が不正です");
  if (!Array.isArray(framesGrid) || framesGrid.length < 1) throw new Error("framesGrid が不正です");
  if (!["selection", "frame", "all"].includes(scope)) throw new Error("scope が不正です");
  if (scope !== "all") {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= framesGrid.length) {
      throw new Error("frameIndex が不正です");
    }
  }
  if (scope === "selection") {
    if (!selection || typeof selection !== "object") throw new Error("selection が必要です");
    const { x, y, w, h } = selection;
    if (![x, y, w, h].every((n) => Number.isInteger(n))) throw new Error("selection の値が不正です");
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) {
      throw new Error("selection がキャンバス範囲外です");
    }
  }
  if (typeof instruction !== "string" || !instruction.trim()) throw new Error("instruction が必要です");
  if (instruction.length > 2000) throw new Error("instruction が長すぎます");

  // --- §13.4 / §14.6 追加フィールド ---
  if (mode !== undefined && !["patch", "motion", "segment", "cleanup"].includes(mode)) throw new Error("mode が不正です");
  if (baseFrameGrid !== undefined && baseFrameGrid !== null) {
    if (typeof baseFrameGrid !== "string") throw new Error("baseFrameGrid が不正です");
    const rows = baseFrameGrid.split("\n");
    if (rows.length !== height || !rows.every((r) => r.length === width && /^[.0-9a-v]*$/.test(r))) {
      throw new Error("baseFrameGrid のサイズまたは文字が不正です");
    }
  }
  if (lockedRects !== undefined && lockedRects !== null) {
    if (!Array.isArray(lockedRects) || lockedRects.length > 64) throw new Error("lockedRects が不正です");
    for (const r of lockedRects) {
      if (!r || typeof r !== "object") throw new Error("lockedRects の要素が不正です");
      const { x, y, w, h } = r;
      if (![x, y, w, h].every((n) => Number.isInteger(n))) throw new Error("lockedRects の値が不正です");
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) {
        throw new Error("lockedRects がキャンバス範囲外です");
      }
    }
  }
  if (mode === "segment") {
    if (!baseFrameGrid) throw new Error("mode=segment では baseFrameGrid が必要です");
  }
  if (mode === "cleanup") {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= framesGrid.length) {
      throw new Error("mode=cleanup では対象の frameIndex が必要です");
    }
    if (typeof allowedMask !== "string") throw new Error("mode=cleanup では allowedMask が必要です");
    const maskRows = allowedMask.split("\n");
    if (maskRows.length !== height || !maskRows.every((r) => r.length === width && /^[01]*$/.test(r))) {
      throw new Error("allowedMask のサイズまたは文字が不正です");
    }
  }
  if (mode === "motion") {
    if (!baseFrameGrid) throw new Error("mode=motion では baseFrameGrid が必要です");
    if (!motion || typeof motion !== "object") throw new Error("mode=motion では motion が必要です");
    if (!MOTION_PRESETS.includes(motion.preset)) throw new Error("motion.preset が不正です");
    if (motion.customText !== undefined && (typeof motion.customText !== "string" || motion.customText.length > 500)) {
      throw new Error("motion.customText が不正です");
    }
    if (!Number.isInteger(motion.frames) || motion.frames < 2 || motion.frames > 12) throw new Error("motion.frames は2〜12です");
    if (!MOTION_MAGNITUDES.includes(motion.magnitude)) throw new Error("motion.magnitude が不正です");
    if (typeof motion.bounce !== "boolean") throw new Error("motion.bounce が不正です");
    if (!MOTION_FACINGS.includes(motion.facing)) throw new Error("motion.facing が不正です");
  }

  if (images !== undefined) {
    if (!Array.isArray(images)) throw new Error("images が不正です");
    for (const im of images) {
      if (typeof im !== "object" || !Number.isInteger(im.frame) || typeof im.dataUrl !== "string") {
        throw new Error("images の形式が不正です");
      }
      if (!im.dataUrl.startsWith("data:image/png;base64,")) throw new Error("images は PNG data URL である必要があります");
    }
  }
  return body;
}

function extractBase64FromDataUrl(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx === -1 ? "" : dataUrl.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// プロンプト構築
// ---------------------------------------------------------------------------
const PRESET_LABELS = { walk: "歩き", run: "走り", attack: "攻撃", idle: "待機", jump: "ジャンプ", custom: "カスタム" };
const MAGNITUDE_LABELS = { small: "小", medium: "中", large: "大" };
const FACING_LABELS = { keep: "そのまま", right: "横（右向き）", left: "横（左向き）" };

function buildUserContent(body) {
  const { project, scope, frameIndex, selection, instruction, images, mode, baseFrameGrid, lockedRects, motion, allowedMask } = body;
  const { width, height, fps, palette, framesGrid } = project;

  const content = [];

  if (Array.isArray(images)) {
    for (const im of images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: extractBase64FromDataUrl(im.dataUrl),
        },
      });
      content.push({ type: "text", text: `↑ フレーム${im.frame} の参考画像（8倍拡大PNG）` });
    }
  }

  const paletteText = palette
    .map((color, i) => `${charForIndex(i)}: ${color}`)
    .join(", ");

  const framesText = framesGrid
    .map((grid, i) => `--- フレーム${i} ---\n${grid}`)
    .join("\n");

  let scopeText;
  if (scope === "all") {
    scopeText = "対象スコープ: 全フレーム";
  } else if (scope === "frame") {
    scopeText = `対象スコープ: フレーム${frameIndex} 全体`;
  } else {
    scopeText = `対象スコープ: フレーム${frameIndex} の矩形 (${selection.x}, ${selection.y}) 〜 (${selection.x + selection.w}, ${selection.y + selection.h})`;
  }

  let baseSection = "";
  if (baseFrameGrid) {
    baseSection = `\n## ベースフレーム（テイストの唯一の正。新規フレームはこれのコピーを起点にする）\n${baseFrameGrid}\n`;
  }

  let lockedSection = "";
  if (Array.isArray(lockedRects) && lockedRects.length > 0) {
    const rects = lockedRects
      .map((r) => `(${r.x}, ${r.y}) 〜 (${r.x + r.w}, ${r.y + r.h})`)
      .join(", ");
    lockedSection = `\n## ロック領域（変更禁止。編集してもベースの値に強制上書きされる）\n${rects}\n`;
  }

  let segmentSection = "";
  if (mode === "segment") {
    segmentSection = `\n## パーツ自動分割モード\nベースフレームのキャラクターを意味のあるパーツ矩形（頭/胴/右腕/左腕/右脚/左脚/武器 など、存在するものだけ）に分割し、スキーマに従って parts を返してください。id は英数字の短い識別子（例: head, torso, arm_r）、pivot はパッチ内ローカル座標の回転支点、z は描画順（小さいほど奥）、parent は親パーツの id（無ければ ""）です。\n`;
  }

  let cleanupSection = "";
  if (mode === "cleanup" && typeof allowedMask === "string") {
    cleanupSection = `\n## AI清書モード（対象: フレーム${frameIndex}）\nリグ合成による回転ジャギー・継ぎ目の隙間を最小差分で清書してください。以下のマスクで '1' のセルだけ変更が許可されています（'0' のセルへの edits はサーバー側で破棄されます）。\n${allowedMask}\n`;
  }

  let motionSection = "";
  if (mode === "motion" && motion) {
    const lines = [
      `プリセット: ${PRESET_LABELS[motion.preset] || motion.preset}`,
      `フレーム数: ${motion.frames}（newFrames にちょうど${motion.frames}枚のフルサイズフレームを生成する）`,
      `動きの大きさ: ${MAGNITUDE_LABELS[motion.magnitude] || motion.magnitude}`,
      `上下バウンス: ${motion.bounce ? "あり" : "なし"}`,
      `向き: ${FACING_LABELS[motion.facing] || motion.facing}`,
    ];
    if (motion.preset === "custom" && motion.customText) lines.push(`自由指示: ${motion.customText}`);
    motionSection = `\n## モーション生成モード\nベースフレームを基に、以下の設定でモーションの全フレームを newFrames として生成してください。edits と paletteChanges は空配列にしてください。\n${lines.join("\n")}\n`;
  }

  const text = `## キャンバス
サイズ: ${width}x${height}, fps: ${fps}

## パレット（index: 色）
${paletteText}
${baseSection}
## 現在のフレーム（テキストグリッド）
${framesText}
${lockedSection}${segmentSection}${cleanupSection}${motionSection}
## ${scopeText}

## 編集指示
${instruction}`;

  content.push({ type: "text", text });
  return content;
}

// ---------------------------------------------------------------------------
// パッチ検証（サーバー側）
// ---------------------------------------------------------------------------
function cellLocked(x, y, lockedRects) {
  for (const r of lockedRects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

function validateAndClampPatch(rawPatch, body) {
  const warnings = [];
  const { project, scope, frameIndex, selection, mode, baseFrameGrid } = body;
  const { width, height, palette, framesGrid } = project;
  const frameCount = framesGrid.length;
  const lockedRects = Array.isArray(body.lockedRects) ? body.lockedRects : [];
  const baseRows = typeof baseFrameGrid === "string" ? baseFrameGrid.split("\n") : null;

  if (!rawPatch || typeof rawPatch !== "object") throw new Error("パッチの形式が不正です");
  const edits = Array.isArray(rawPatch.edits) ? rawPatch.edits : [];
  const newFrames = Array.isArray(rawPatch.newFrames) ? rawPatch.newFrames : [];
  const paletteChanges = Array.isArray(rawPatch.paletteChanges) ? rawPatch.paletteChanges : [];
  const note = typeof rawPatch.note === "string" ? rawPatch.note : "";

  const cleanEdits = [];
  for (const e of edits) {
    if (!e || typeof e !== "object") continue;
    const { frame, x, y, rows } = e;
    if (!Number.isInteger(frame) || frame < 0 || frame >= frameCount) {
      warnings.push(`frame ${frame} は範囲外のため無視しました`);
      continue;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Array.isArray(rows)) {
      warnings.push("edits の座標/rows が不正なため無視しました");
      continue;
    }
    if (!rows.every((r) => typeof r === "string" && GRID_CHAR_RE.test(r))) {
      warnings.push("edits に不正な文字が含まれるため無視しました");
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      warnings.push("edits の座標がキャンバス範囲外のため無視しました");
      continue;
    }
    // scope=selection のときは選択矩形外への edits を切り捨てる
    let ex = x, ey = y, erows = rows;
    if (scope === "selection" && selection) {
      if (frame !== frameIndex) {
        warnings.push(`フレーム${frame}への編集は選択範囲外（対象フレーム外）のため無視しました`);
        continue;
      }
      const sel = selection;
      const clipped = clipRowsToRect(x, y, rows, sel.x, sel.y, sel.w, sel.h);
      if (!clipped) {
        warnings.push("選択範囲外の edits を切り捨てました");
        continue;
      }
      if (clipped.clipped) warnings.push("選択範囲外の一部セルを切り捨てました");
      ex = clipped.x; ey = clipped.y; erows = clipped.rows;
    }
    if (scope === "frame" && frame !== frameIndex) {
      warnings.push(`フレーム${frame}への編集は対象外のため無視しました`);
      continue;
    }
    // 行の幅がキャンバスをはみ出す場合は切り詰め
    const maxW = width - ex;
    const trimmedRows = erows.map((r) => r.slice(0, Math.max(0, maxW)));
    const trimmedRowCount = Math.min(trimmedRows.length, height - ey);
    cleanEdits.push({ frame, x: ex, y: ey, rows: trimmedRows.slice(0, trimmedRowCount) });
  }

  const cleanNewFrames = [];
  for (const nf of newFrames) {
    if (!nf || typeof nf !== "object") continue;
    const { insertAfter, rows } = nf;
    if (!Number.isInteger(insertAfter) || insertAfter < -1 || insertAfter >= frameCount) {
      warnings.push("newFrames の insertAfter が不正なため無視しました");
      continue;
    }
    if (!Array.isArray(rows) || rows.length !== height || !rows.every((r) => typeof r === "string" && r.length === width && GRID_CHAR_RE.test(r) && !r.includes("?"))) {
      warnings.push("newFrames の rows がフレームサイズと一致しないため無視しました（?は使用不可）");
      continue;
    }
    cleanNewFrames.push({ insertAfter, rows });
  }

  // --- ロック領域の強制上書き（§13.2-3）---
  // ロック領域内のセルへの edits / newFrames はベースの値で強制上書きする。
  if (lockedRects.length > 0) {
    let overriddenCells = 0;
    for (const e of cleanEdits) {
      e.rows = e.rows.map((row, ry) => {
        let out = "";
        for (let rx = 0; rx < row.length; rx++) {
          const ax = e.x + rx, ay = e.y + ry;
          if (row[rx] !== "?" && cellLocked(ax, ay, lockedRects)) {
            overriddenCells++;
            out += baseRows ? baseRows[ay][ax] : "?";
          } else {
            out += row[rx];
          }
        }
        return out;
      });
    }
    for (const nf of cleanNewFrames) {
      nf.rows = nf.rows.map((row, y) => {
        let out = "";
        for (let x = 0; x < row.length; x++) {
          if (cellLocked(x, y, lockedRects) && baseRows) {
            if (row[x] !== baseRows[y][x]) overriddenCells++;
            out += baseRows[y][x];
          } else {
            out += row[x];
          }
        }
        return out;
      });
    }
    if (overriddenCells > 0) {
      warnings.push(`ロック領域内の ${overriddenCells} セルをベースの値で強制上書きしました`);
    }
  }

  const cleanPaletteChanges = [];
  const hexRe = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  for (const pc of paletteChanges) {
    if (!pc || typeof pc !== "object") continue;
    const { index, color } = pc;
    if (!Number.isInteger(index) || index < 0 || index >= 32) {
      warnings.push("paletteChanges の index が不正なため無視しました");
      continue;
    }
    if (typeof color !== "string" || !hexRe.test(color)) {
      warnings.push("paletteChanges の color が不正なため無視しました");
      continue;
    }
    cleanPaletteChanges.push({ index, color });
  }

  // --- パレットロック（§13.2-1）: モーション生成モードでは paletteChanges を破棄 ---
  if (mode === "motion" && cleanPaletteChanges.length > 0) {
    warnings.push(`モーション生成モードのため paletteChanges（${cleanPaletteChanges.length}件）を破棄しました`);
    cleanPaletteChanges.length = 0;
  }

  // --- AI清書（§14.4-2）: 許可セル（allowedMask='1'）外の edits を破棄 ---
  if (mode === "cleanup" && typeof body.allowedMask === "string") {
    const maskRows = body.allowedMask.split("\n");
    let discarded = 0;
    for (const e of cleanEdits) {
      e.rows = e.rows.map((row, ry) => {
        let out = "";
        for (let rx = 0; rx < row.length; rx++) {
          const ax = e.x + rx, ay = e.y + ry;
          if (row[rx] !== "?" && maskRows[ay][ax] !== "1") {
            discarded++;
            out += "?";
          } else {
            out += row[rx];
          }
        }
        return out;
      });
    }
    if (discarded > 0) warnings.push(`許可セル外の ${discarded} セルの編集を破棄しました`);
    if (cleanNewFrames.length > 0) {
      warnings.push(`清書モードのため newFrames（${cleanNewFrames.length}件）を破棄しました`);
      cleanNewFrames.length = 0;
    }
    if (cleanPaletteChanges.length > 0) {
      warnings.push(`清書モードのため paletteChanges（${cleanPaletteChanges.length}件）を破棄しました`);
      cleanPaletteChanges.length = 0;
    }
  }

  return {
    edits: cleanEdits,
    newFrames: cleanNewFrames,
    paletteChanges: cleanPaletteChanges,
    note,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// segment レスポンスの検証（§14.2）
// ---------------------------------------------------------------------------
function validateSegment(rawSegment, body) {
  const warnings = [];
  const { width, height } = body.project;
  if (!rawSegment || typeof rawSegment !== "object") throw new Error("segment結果の形式が不正です");
  const rawParts = Array.isArray(rawSegment.parts) ? rawSegment.parts : [];
  const note = typeof rawSegment.note === "string" ? rawSegment.note : "";

  const parts = [];
  const seenIds = new Set();
  for (const p of rawParts) {
    if (!p || typeof p !== "object") continue;
    const { id, name, x, y, w, h, pivotX, pivotY, z, parent } = p;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(id) || seenIds.has(id)) {
      warnings.push("id が不正または重複するパーツを無視しました");
      continue;
    }
    if (typeof name !== "string" || !name.trim()) {
      warnings.push(`パーツ ${id} の name が不正なため無視しました`);
      continue;
    }
    if (![x, y, w, h, pivotX, pivotY, z].every(Number.isInteger)) {
      warnings.push(`パーツ ${id} の数値が不正なため無視しました`);
      continue;
    }
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) {
      warnings.push(`パーツ ${id} の矩形がキャンバス範囲外のため無視しました`);
      continue;
    }
    const px = Math.max(0, Math.min(w - 1, pivotX));
    const py = Math.max(0, Math.min(h - 1, pivotY));
    if (px !== pivotX || py !== pivotY) warnings.push(`パーツ ${id} の pivot をパッチ内に丸めました`);
    parts.push({ id, name: name.trim().slice(0, 32), x, y, w, h, pivotX: px, pivotY: py, z, parent: typeof parent === "string" ? parent : "" });
    seenIds.add(id);
  }
  // 親の存在チェック（無ければ "" に）
  for (const p of parts) {
    if (p.parent && !seenIds.has(p.parent)) {
      warnings.push(`パーツ ${p.id} の親 ${p.parent} が存在しないため解除しました`);
      p.parent = "";
    }
    if (p.parent === p.id) p.parent = "";
  }
  return { parts, note, warnings };
}

// 矩形(sx,sy,sw,sh)にrows(x,yから始まる)をクリップする
function clipRowsToRect(x, y, rows, sx, sy, sw, sh) {
  const sxEnd = sx + sw;
  const syEnd = sy + sh;
  let clipped = false;
  const outRows = [];
  let outY = null;
  for (let ry = 0; ry < rows.length; ry++) {
    const absY = y + ry;
    if (absY < sy || absY >= syEnd) { clipped = true; continue; }
    if (outY === null) outY = absY;
    const row = rows[ry];
    let outRow = "";
    let outX = null;
    for (let rx = 0; rx < row.length; rx++) {
      const absX = x + rx;
      if (absX < sx || absX >= sxEnd) { clipped = true; continue; }
      if (outX === null) outX = absX;
      outRow += row[rx];
    }
    if (outRow.length > 0) {
      outRows.push({ x: outX, row: outRow });
    }
  }
  if (outRows.length === 0 || outY === null) return null;
  // 全行が同じxオフセットになるよう正規化（矩形選択なので通常は揃う）
  const minX = Math.min(...outRows.map((r) => r.x));
  const normalized = outRows.map((r) => "?".repeat(r.x - minX) + r.row);
  const maxLen = Math.max(...normalized.map((r) => r.length));
  const padded = normalized.map((r) => r.padEnd(maxLen, "?"));
  return { x: minX, y: outY, rows: padded, clipped };
}

// ---------------------------------------------------------------------------
// SSE ヘルパー
// ---------------------------------------------------------------------------
function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---------------------------------------------------------------------------
// MOCKモード: 選択範囲（なければフレーム全体の中央8x8）をパレット最後の色で塗る
// ---------------------------------------------------------------------------
async function runMock(body, res, aborted) {
  const { project, scope, frameIndex, selection, mode, baseFrameGrid, motion, allowedMask } = body;
  const { width, height, palette } = project;
  const lastIdx = palette.length - 1;
  const ch = charForIndex(lastIdx) || "1";

  let fakePatch;
  if (mode === "segment") {
    // 固定の3パーツ（頭・胴・脚）を比率で返す
    const tw = Math.max(2, Math.floor(width * 0.4));
    const tx = Math.floor((width - tw) / 2);
    const headH = Math.max(2, Math.floor(height * 0.25));
    const torsoH = Math.max(2, Math.floor(height * 0.3));
    const legsH = Math.max(2, Math.floor(height * 0.2));
    const headY = Math.max(0, Math.floor(height * 0.1));
    const torsoY = Math.min(height - torsoH, headY + headH);
    const legsY = Math.min(height - legsH, torsoY + torsoH);
    fakePatch = {
      parts: [
        { id: "torso", name: "胴", x: tx, y: torsoY, w: tw, h: torsoH, pivotX: Math.floor(tw / 2), pivotY: Math.floor(torsoH / 2), z: 1, parent: "" },
        { id: "head", name: "頭", x: tx, y: headY, w: tw, h: headH, pivotX: Math.floor(tw / 2), pivotY: headH - 1, z: 2, parent: "torso" },
        { id: "legs", name: "脚", x: tx, y: legsY, w: tw, h: legsH, pivotX: Math.floor(tw / 2), pivotY: 0, z: 0, parent: "torso" },
      ],
      note: "MOCK: 頭・胴・脚の3パーツに分割しました（下書き）",
    };
  } else if (mode === "cleanup" && typeof allowedMask === "string") {
    // 許可セルの先頭1セル + 許可外の先頭1セルへの edits を返す
    // （許可外セルはサーバー側の破棄処理の確認用）
    const maskRows = allowedMask.split("\n");
    let allowed = null, denied = null;
    for (let y = 0; y < height && (!allowed || !denied); y++) {
      for (let x = 0; x < width && (!allowed || !denied); x++) {
        if (maskRows[y][x] === "1" && !allowed) allowed = { x, y };
        if (maskRows[y][x] === "0" && !denied) denied = { x, y };
      }
    }
    const edits = [];
    if (allowed) edits.push({ frame: frameIndex, x: allowed.x, y: allowed.y, rows: [ch] });
    if (denied) edits.push({ frame: frameIndex, x: denied.x, y: denied.y, rows: [ch] });
    fakePatch = {
      edits,
      newFrames: [],
      paletteChanges: [],
      note: "MOCK: 許可セル1点を清書（許可外1点はサーバーで破棄されるはず）",
    };
  } else if (mode === "motion" && motion && baseFrameGrid) {
    // ベースフレームのコピーを上下にシフトした newFrames を motion.frames 枚生成
    const baseRows = baseFrameGrid.split("\n");
    const blankRow = ".".repeat(width);
    const newFrames = [];
    for (let i = 0; i < motion.frames; i++) {
      let rows;
      if (i % 2 === 1) {
        rows = baseRows.slice(1).concat([blankRow]); // 1px 上へ
      } else {
        rows = baseRows.slice();
      }
      newFrames.push({ insertAfter: project.framesGrid.length - 1, rows });
    }
    fakePatch = {
      edits: [],
      newFrames,
      paletteChanges: [{ index: 1, color: "#ff00ff" }], // モーション生成モードでの破棄を確認するためのダミー
      note: `MOCK: ベースフレームを基に${motion.frames}枚のモーションフレームを生成しました（${motion.preset}）`,
    };
  } else {
    let rx, ry, rw, rh;
    if (scope === "selection" && selection) {
      rx = selection.x; ry = selection.y; rw = selection.w; rh = selection.h;
    } else {
      rw = Math.min(8, width);
      rh = Math.min(8, height);
      rx = Math.floor((width - rw) / 2);
      ry = Math.floor((height - rh) / 2);
    }
    const targetFrame = scope === "all" ? 0 : frameIndex;
    const rows = Array.from({ length: rh }, () => ch.repeat(rw));
    fakePatch = {
      edits: [{ frame: targetFrame, x: rx, y: ry, rows }],
      newFrames: [],
      paletteChanges: [],
      note: "MOCK: 選択範囲（または中央8x8）を最終パレット色で塗りました",
    };
  }

  const fakeText = JSON.stringify(fakePatch);

  // 疑似ストリーミング（2秒かけて分割送出）
  const chunkCount = 8;
  const chunkSize = Math.ceil(fakeText.length / chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    if (aborted.value) return;
    const chunk = fakeText.slice(i * chunkSize, (i + 1) * chunkSize);
    sseSend(res, { type: "delta", text: chunk });
    await new Promise((r) => setTimeout(r, 2000 / chunkCount));
  }
  if (aborted.value) return;

  try {
    if (mode === "segment") {
      const segment = validateSegment(JSON.parse(fakeText), body);
      sseSend(res, { type: "result", segment, usage: { mock: true } });
    } else {
      const patch = validateAndClampPatch(JSON.parse(fakeText), body);
      sseSend(res, { type: "result", patch, usage: { mock: true } });
    }
  } catch (err) {
    sseSend(res, { type: "error", message: `MOCK結果の検証に失敗しました: ${err.message}` });
  }
  res.end();
}

// ---------------------------------------------------------------------------
// 実API呼び出し
// ---------------------------------------------------------------------------
async function runReal(body, res, aborted) {
  const client = new Anthropic();
  const userContent = buildUserContent(body);

  let stream;
  try {
    stream = client.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: body.mode === "segment" ? SEGMENT_SCHEMA : PATCH_SCHEMA },
      },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
    });
  } catch (err) {
    sseSend(res, { type: "error", message: describeAnthropicError(err) });
    res.end();
    return;
  }

  const onClose = () => {
    aborted.value = true;
    try { stream.abort(); } catch {}
  };
  res.req.on("close", onClose);

  stream.on("text", (delta) => {
    if (aborted.value) return;
    sseSend(res, { type: "delta", text: delta });
  });

  stream.on("error", (err) => {
    // finalMessage() 側の catch でも処理するが、念のためログ
  });

  try {
    const final = await stream.finalMessage();
    res.req.off("close", onClose);
    if (aborted.value) { res.end(); return; }

    if (final.stop_reason === "refusal") {
      sseSend(res, { type: "error", message: "モデルがこの指示への応答を拒否しました。指示内容を変えて再試行してください。" });
      res.end();
      return;
    }
    if (final.stop_reason === "max_tokens") {
      sseSend(res, { type: "error", message: "出力がトークン上限に達しました。指示の範囲を狭めて再試行してください。" });
      res.end();
      return;
    }

    const textBlock = final.content.find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) {
      sseSend(res, { type: "error", message: "モデルからの応答にテキストが含まれていませんでした。" });
      res.end();
      return;
    }

    let raw;
    try {
      raw = JSON.parse(textBlock.text);
    } catch (err) {
      sseSend(res, { type: "error", message: "モデル出力のJSON解析に失敗しました。" });
      res.end();
      return;
    }

    try {
      if (body.mode === "segment") {
        const segment = validateSegment(raw, body);
        sseSend(res, { type: "result", segment, usage: final.usage || {} });
      } else {
        const patch = validateAndClampPatch(raw, body);
        sseSend(res, { type: "result", patch, usage: final.usage || {} });
      }
    } catch (err) {
      sseSend(res, { type: "error", message: `結果の検証に失敗しました: ${err.message}` });
      res.end();
      return;
    }
    res.end();
  } catch (err) {
    res.req.off("close", onClose);
    if (aborted.value) { try { res.end(); } catch {} return; }
    sseSend(res, { type: "error", message: describeAnthropicError(err) });
    try { res.end(); } catch {}
  }
}

function describeAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "ANTHROPIC_API_KEY を設定してください。";
  }
  if (err && typeof err.message === "string" && err.message.includes("Could not resolve authentication method")) {
    return "ANTHROPIC_API_KEY を設定してください。";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "APIキーにこのモデルへのアクセス権限がありません。";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "レート制限に達しました。しばらく待って再試行してください。";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Anthropic APIへの接続に失敗しました。ネットワークを確認してください。";
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `リクエストが不正です: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic APIエラー: ${err.message}`;
  }
  if (err && err.name === "AbortError") {
    return "リクエストが中断されました。";
  }
  return `予期しないエラーが発生しました: ${err?.message || err}`;
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
async function handleApiConfig(req, res) {
  const body = JSON.stringify({ model: MODEL, effort: EFFORT, mock: MOCK });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleApiEdit(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "リクエストサイズが上限（5MB）を超えています" }));
    return;
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
    validateEditRequest(body);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err.message || "リクエストが不正です" }));
    return;
  }

  sseInit(res);
  const aborted = { value: false };
  res.req.on("close", () => { aborted.value = true; });

  try {
    if (MOCK) {
      await runMock(body, res, aborted);
    } else {
      await runReal(body, res, aborted);
    }
  } catch (err) {
    try {
      sseSend(res, { type: "error", message: `内部エラー: ${err.message}` });
      res.end();
    } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = req.url.split("?")[0];
    if (req.method === "GET" && urlPath === "/api/config") {
      await handleApiConfig(req, res);
    } else if (req.method === "POST" && urlPath === "/api/edit") {
      await handleApiEdit(req, res);
    } else if (req.method === "GET") {
      await serveStatic(req, res);
    } else {
      res.writeHead(405);
      res.end("Method Not Allowed");
    }
  } catch (err) {
    try {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `サーバーエラー: ${err.message}` }));
    } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`AI Meglio server listening on http://localhost:${PORT} (MOCK=${MOCK ? "1" : "0"}, MODEL=${MODEL}, EFFORT=${EFFORT})`);
});
