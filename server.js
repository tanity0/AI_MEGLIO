// server.js — AI Meglio: 静的配信 + /api/edit (SSE) + /api/config
// Node.js 18+ / ESM / node:http のみ（Expressなし）。依存は @anthropic-ai/sdk のみ。

import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// ツールバージョン（package.json）と起動時点のコミットID（フッター表示用。git不在なら省略）
const APP_VERSION = (() => {
  try { return JSON.parse(fssync.readFileSync(path.join(__dirname, "package.json"), "utf-8")).version || ""; }
  catch { return ""; }
})();
const APP_COMMIT = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
  } catch { return ""; }
})();

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.MODEL || "claude-opus-4-8";
const EFFORT = process.env.EFFORT || "medium";
const MOCK = process.env.MOCK === "1";
const BACKEND = process.env.BACKEND === "cli" ? "cli" : process.env.BACKEND === "codex" ? "codex" : "api"; // §15.1/§23: api（既定）| cli | codex
const CLI_MODEL = process.env.CLI_MODEL || "sonnet";
const CLI_CMD = process.env.CLI_PATH || "claude"; // Windowsで解決先が紛らわしい場合にフルパス指定可
const CODEX_CMD = process.env.CODEX_PATH || "codex"; // §23.1: Codex CLI の実体パス（CLI_PATH と同じ動機）
const CODEX_MODEL = process.env.CODEX_MODEL || ""; // §23.1: 空 = codex 側の既定モデル
const CLI_TIMEOUT_SEC = Number(process.env.CLI_TIMEOUT) > 0 ? Number(process.env.CLI_TIMEOUT) : 900; // §15.5-1改: 既定900秒（実測: AI分割160秒超・描き直し数分でブレが大きいため）。CLI_TIMEOUT（秒）で上書き
const CLI_TIMEOUT_MS = CLI_TIMEOUT_SEC * 1000;
const CLI_CONCURRENCY = Number(process.env.CLI_CONCURRENCY) > 0 ? Number(process.env.CLI_CONCURRENCY) : 2; // §15.2: 同時実行キュー（cli/codex共用。環境変数 CLI_CONCURRENCY で上書き可）
const CLI_DEBUG = process.env.CLI_DEBUG === "1"; // §22.5-5: プロンプト+生出力を ./cli-logs/ に保存
const REDRAW_MAX_CELLS = Number(process.env.REDRAW_MAX_CELLS) > 0 ? Number(process.env.REDRAW_MAX_CELLS) : 1800; // §22.6-3: 描き直し1リクエストの大領域ガード閾値（CLI系のみクライアントが確認ダイアログに使用）
const EXPORT_ROOT = process.env.EXPORT_ROOT || ""; // §16.4: 未設定なら /api/export は無効

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
// §18.1: グリッド表現の両対応
// 32色以下 = 1文字（'.'=透明、1-9a-v、'?'=変更しない）
// 33色以上 = 2文字hex（'..'=透明、'01'〜'ff'、'??'=変更しない）
// ---------------------------------------------------------------------------
function isWidePalette(paletteLen) { return paletteLen > 32; }
function cellChars(paletteLen) { return isWidePalette(paletteLen) ? 2 : 1; }
function tokenForIndex(i, wide) {
  if (wide) return i === 0 ? ".." : i.toString(16).padStart(2, "0");
  return charForIndex(i);
}
// 戻り値: 0..255 = index、-1 = 変更しない('?'/'??')、-2 = 不正
function indexForToken(tok, wide) {
  if (wide) {
    if (tok === "..") return 0;
    if (tok === "??") return -1;
    if (/^[0-9a-f]{2}$/.test(tok)) return parseInt(tok, 16);
    return -2;
  }
  if (tok === ".") return 0;
  if (tok === "?") return -1;
  if (!/^[0-9a-v]$/.test(tok)) return -2;
  return CHARSET.indexOf(tok);
}
// 行文字列をトークン配列に分割（wide時に奇数長なら null）
function splitTokens(row, cw) {
  if (cw === 1) return row.split("");
  if (row.length % 2 !== 0) return null;
  const out = [];
  for (let i = 0; i < row.length; i += 2) out.push(row.slice(i, i + 2));
  return out;
}
function tokensValid(tokens, wide, allowKeep) {
  for (const t of tokens) {
    const v = indexForToken(t, wide);
    if (v === -2) return false;
    if (v === -1 && !allowKeep) return false;
  }
  return true;
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

// パレットスワップ（mode=palette）用スキーマ（§16.2）: paletteChanges のみ
const PALETTE_SCHEMA = {
  type: "object",
  properties: {
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
    groupChanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          mainIndex: { type: "integer" },
          color: { type: "string" },
        },
        required: ["mainIndex", "color"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["paletteChanges", "groupChanges", "note"],
  additionalProperties: false,
};

// トンマナ解析（mode=style）用スキーマ（§17.2）
const STYLE_SCHEMA = {
  type: "object",
  properties: {
    guide: { type: "string" },
    note: { type: "string" },
  },
  required: ["guide", "note"],
  additionalProperties: false,
};

const GRID_SECTION_NARROW = `## グリッド表現
各フレームは文字グリッドで表現されます。1文字が1ピクセルです。
- \`.\` = 透明（パレットindex 0）
- \`1\`-\`9\`, \`a\`-\`v\` = パレットindex 1〜31（36進数的割当て。数字の次に小文字アルファベット）
- パッチの \`rows\` の中でのみ \`?\` が使えます。\`?\` は「このセルは変更しない」という意味です。`;

// §18.1: 33色以上のプロジェクト用（1ピクセル=2文字の16進表現）
const GRID_SECTION_WIDE = `## グリッド表現（16進2桁モード）
各フレームは文字グリッドで表現されます。**2文字で1ピクセル**です（このプロジェクトはパレットが33色以上のため）。
- \`..\` = 透明（パレットindex 0）
- \`01\`〜\`ff\` = パレットindex 1〜255（16進数2桁・小文字）
- パッチの \`rows\` の中でのみ \`??\` が使えます。\`??\` は「このセルは変更しない」という意味です。
- 行の文字数は必ず偶数（セル数×2）にしてください。`;

const SYSTEM_PROMPT = `あなたはドット絵アニメーションの精密編集エンジンです。

{{GRID_SECTION}}

## 最小差分の原則
指示を実現するために変更が必要なセルだけを edits に含めてください。無関係なセルは書き換えず、パッチの rows 内では \`?\` にしてください（矩形全体を再送する必要はありません。変更箇所を囲む小さな矩形で十分です）。
ただし、変更が対象領域の大部分に及ぶ場合は、\`?\` による差分化に固執せず、対象矩形全体（またはフレーム全体）を書き直した rows を返して構いません。差分の厳密さより応答の速さを優先してください。

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

## トンマナ解析（styleモードのとき適用）
与えられた参考画像（またはテキストグリッド）のスタイルを分析し、guide に以下の観点を1行ずつ日本語で記述してください: 頭身・デフォルメ度 / 輪郭線の有無・太さ・色 / シェーディング段数とディザの有無 / ハイライトの入れ方 / 彩度・明度の傾向 / 代表色 / ピクセルの打ち方の癖（角の丸め方、1pxディテールの密度）。guide は後続のすべての編集の基準として使われるため、具体的かつ簡潔に書いてください。

## トンマナ基準（与えられた場合）
リクエストに「トンマナ基準」が含まれる場合、それを厳守してください。ベースフレームのテイストとトンマナ基準が矛盾するときは、編集対象の絵を**トンマナ基準へ寄せる方向**で修正します。ただし指示が明示的に求めない限り、一度の編集で全面的に描き直さず、指示された範囲内でのみ寄せてください。

## パレットスワップ（paletteモードのとき適用）
指示に従ってパレットの色だけを変更してください。ドットの形状には一切触れません。出力は paletteChanges と note のみです。index 0（透明）は変更しないでください。元のパレットの明暗関係（輪郭が最も暗い等）を保ったまま色相・彩度を変えると、キャラの読みやすさが維持されます。

## 部分仕上げ（refineモードのとき適用・最重要の意味論）
**ユーザーのラフ編集が「意図」であり、正です。ベースフレームに引き戻してはなりません。** 現在のフレームの選択範囲内のシルエット・形の意図を保ったまま、打ち方（輪郭の連続性、シェーディング段数、ハイライト、ジャギー）だけをトンマナと周囲に合わせて清書してください。前後フレームの同じ矩形が与えられた場合は、アニメーションの流れ（動きの方向・量）と矛盾しないようにしてください。変更許可セル（マスクで '1'）以外への edits はサーバーで破棄されます。newFrames と paletteChanges は使わないでください。

## ポーズガイド再描画（redrawモードのとき適用・refineとの違いに注意）
このモードでは、アニメーションの1コマとして**キャラクターの新しいポーズを描き起こします**（§22.9）。現フレームはリグ合成による**ラフ（ポーズのあたり）**で、傾き・パーツ位置・シルエット・関節の曲がりの正です。ベースフレームは**絵柄の見本**（線の太さ・シェーディング段数・ディテール密度）であって、**ポーズをベースから取ってはなりません**——ベースと同じ姿勢に戻すのは失敗です（ベースとラフの姿勢差は意図的なもの）。ラフで欠損・崩壊している部分（千切れたパーツ・つぶれた模様・直線のままの脚）は、ベースの該当部位を参照して**ラフの向き・位置に合わせて描き起こして**ください。ラフをそのまま残すのも失敗です。パレットは厳守し、変更許可セル（マスクで '1'）以外への edits はサーバーで破棄されます。newFrames と paletteChanges は使わないでください。

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

// §18.1: パレット色数に応じてグリッド表現の説明を差し替える
function systemPromptFor(paletteLen) {
  return SYSTEM_PROMPT.replace("{{GRID_SECTION}}", isWidePalette(paletteLen) ? GRID_SECTION_WIDE : GRID_SECTION_NARROW);
}

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
  if (!Number.isInteger(width) || width < 8 || width > 128) throw new Error("width が不正です");
  if (!Number.isInteger(height) || height < 8 || height > 128) throw new Error("height が不正です");
  if (!Number.isInteger(fps) || fps < 1 || fps > 24) throw new Error("fps が不正です");
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 256) throw new Error("palette が不正です");
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
  if (mode !== undefined && !["patch", "motion", "segment", "cleanup", "palette", "style", "refine", "redraw"].includes(mode)) throw new Error("mode が不正です");
  if (baseFrameGrid !== undefined && baseFrameGrid !== null) {
    if (typeof baseFrameGrid !== "string") throw new Error("baseFrameGrid が不正です");
    const bw = isWidePalette(palette.length);
    const bcw = cellChars(palette.length);
    const rows = baseFrameGrid.split("\n");
    const ok = rows.length === height && rows.every((r) => {
      const toks = splitTokens(r, bcw);
      return toks && toks.length === width && tokensValid(toks, bw, false);
    });
    if (!ok) throw new Error("baseFrameGrid のサイズまたは文字が不正です");
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
    if (!baseFrameGrid && !body.segmentGrid) throw new Error("mode=segment では baseFrameGrid または segmentGrid が必要です");
  }
  // §14.5.5: 分割専用の軽量グリッド（高さ≤48・最大8色の1文字表現）
  if (body.segmentGrid !== undefined && body.segmentGrid !== null) {
    if (typeof body.segmentGrid !== "string") throw new Error("segmentGrid が不正です");
    const rows = body.segmentGrid.split("\n");
    if (rows.length < 1 || rows.length > 64 ||
        !rows.every((r) => r.length >= 1 && r.length <= 128 && r.length === rows[0].length && /^[.0-9a-v]*$/.test(r))) {
      throw new Error("segmentGrid のサイズまたは文字が不正です");
    }
  }
  if (body.segmentScale !== undefined && body.segmentScale !== null) {
    if (typeof body.segmentScale !== "number" || !(body.segmentScale >= 1) || body.segmentScale > 32) {
      throw new Error("segmentScale が不正です");
    }
  }
  if (body.segmentPalette !== undefined && body.segmentPalette !== null) {
    if (!Array.isArray(body.segmentPalette) || body.segmentPalette.length < 1 || body.segmentPalette.length > 9 ||
        !body.segmentPalette.every((c) => typeof c === "string")) {
      throw new Error("segmentPalette が不正です");
    }
  }
  if (mode === "palette") {
    if (!baseFrameGrid) throw new Error("mode=palette では baseFrameGrid が必要です");
  }
  if (body.mainPalette !== undefined && body.mainPalette !== null) {
    const mp = body.mainPalette;
    const ok = mp && typeof mp === "object" &&
      Array.isArray(mp.colors) && mp.colors.length >= 1 && mp.colors.length <= 64 &&
      mp.colors.every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) &&
      Array.isArray(mp.groups) && mp.groups.length === palette.length &&
      mp.groups.every((g) => Number.isInteger(g) && g >= -1 && g < mp.colors.length);
    if (!ok) throw new Error("mainPalette が不正です");
  }
  // --- §17 追加フィールド ---
  if (body.styleGuide !== undefined && body.styleGuide !== null) {
    if (typeof body.styleGuide !== "string" || body.styleGuide.length > 4000) throw new Error("styleGuide が不正です");
  }
  if (body.styleImage !== undefined && body.styleImage !== null) {
    if (typeof body.styleImage !== "string" || !body.styleImage.startsWith("data:image/png;base64,")) {
      throw new Error("styleImage は PNG data URL である必要があります");
    }
  }
  if (body.styleGrid !== undefined && body.styleGrid !== null) {
    if (typeof body.styleGrid !== "string") throw new Error("styleGrid が不正です");
    const rows = body.styleGrid.split("\n");
    if (rows.length < 1 || rows.length > 96 || !rows.every((r) => r.length >= 1 && r.length <= 96 && r.length === rows[0].length && /^[.0-9a-v]*$/.test(r))) {
      throw new Error("styleGrid のサイズまたは文字が不正です");
    }
  }
  if (body.stylePalette !== undefined && body.stylePalette !== null) {
    if (!Array.isArray(body.stylePalette) || body.stylePalette.length < 1 || body.stylePalette.length > 32 ||
        !body.stylePalette.every((c) => typeof c === "string")) {
      throw new Error("stylePalette が不正です");
    }
  }
  if (mode === "style") {
    const hasImage = Array.isArray(images) && images.length > 0;
    const hasGrid = typeof body.styleGrid === "string" && Array.isArray(body.stylePalette);
    if (!hasImage && !hasGrid) {
      throw new Error("mode=style では参考画像（images）またはテキストグリッド（styleGrid + stylePalette）が必要です");
    }
  }
  if (mode === "cleanup" || mode === "refine" || mode === "redraw") {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= framesGrid.length) {
      throw new Error(`mode=${mode} では対象の frameIndex が必要です`);
    }
    if (typeof allowedMask !== "string") throw new Error(`mode=${mode} では allowedMask が必要です`);
    const maskRows = allowedMask.split("\n");
    if (maskRows.length !== height || !maskRows.every((r) => r.length === width && /^[01]*$/.test(r))) {
      throw new Error("allowedMask のサイズまたは文字が不正です");
    }
  }
  // §22.5-2: redraw のマスクbboxクロップ（モデルはクロップローカル座標で edits を返す）
  if (body.cropRect !== undefined && body.cropRect !== null) {
    if (mode !== "redraw") throw new Error("cropRect は mode=redraw でのみ指定できます");
    const cr = body.cropRect;
    if (!cr || typeof cr !== "object" || ![cr.x, cr.y, cr.w, cr.h].every(Number.isInteger) ||
        cr.x < 0 || cr.y < 0 || cr.w < 1 || cr.h < 1 || cr.x + cr.w > width || cr.y + cr.h > height) {
      throw new Error("cropRect が不正です");
    }
  }
  // §19.3: 前後フレームの矩形切り出し（0〜2件）
  if (body.neighborContext !== undefined && body.neighborContext !== null) {
    if (!Array.isArray(body.neighborContext) || body.neighborContext.length > 2) throw new Error("neighborContext が不正です");
    for (const nc of body.neighborContext) {
      if (!nc || !Number.isInteger(nc.frame) || !Array.isArray(nc.rows) ||
          nc.rows.length > height || !nc.rows.every((r) => typeof r === "string" && r.length <= width * cellChars(palette.length))) {
        throw new Error("neighborContext の形式が不正です");
      }
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

// §22.5-2: グリッド文字列（1セル=cw文字）から cropRect の矩形を切り出す
function cropGridString(grid, cr, cw) {
  return grid.split("\n").slice(cr.y, cr.y + cr.h)
    .map((r) => r.slice(cr.x * cw, (cr.x + cr.w) * cw))
    .join("\n");
}

// ユーザープロンプトのテキスト部（全バックエンド共通）
function buildUserText(body) {
  const { project, scope, frameIndex, selection, instruction, mode, baseFrameGrid, lockedRects, motion, allowedMask } = body;
  const { width, height, fps, palette, framesGrid } = project;

  // §17: トンマナ基準（style モード以外の全モードに追記）
  const styleSection = mode !== "style" && typeof body.styleGuide === "string" && body.styleGuide.trim()
    ? `## トンマナ基準（厳守）\n${body.styleGuide.trim()}\n\n`
    : "";

  // §17.2: styleモードは参考画像（またはグリッド）の解析のみ
  if (mode === "style") {
    let gridSection = "";
    if (typeof body.styleGrid === "string" && Array.isArray(body.stylePalette)) {
      const palText = body.stylePalette.map((color, i) => `${charForIndex(i)}: ${color}`).join(", ");
      gridSection = `\n## 参考画像のテキストグリッド\nパレット: ${palText}\n${body.styleGrid}\n`;
    }
    return `## トンマナ解析モード
添付の参考画像（またはテキストグリッド）のドット絵スタイルを分析し、スキーマに従って guide と note を返してください。
${gridSection}
## 指示
${instruction}`;
  }

  // §14.5.5: segmentモードで軽量グリッドがあれば、それだけの縮小プロンプト
  if (mode === "segment" && typeof body.segmentGrid === "string") {
    const segRows = body.segmentGrid.split("\n");
    const segW = segRows[0].length, segH = segRows.length;
    const scale = typeof body.segmentScale === "number" ? body.segmentScale : 1;
    const palText = Array.isArray(body.segmentPalette)
      ? `\n## 縮小グリッドのパレット（index: 色）\n${body.segmentPalette.map((c, i) => `${charForIndex(i)}: ${c}`).join(", ")}\n`
      : "";
    return `## パーツ自動分割モード（縮小グリッド）
以下はベースフレームを元解像度の1/${scale.toFixed(2)}に間引き・最大8色に量子化した ${segW}x${segH} のグリッドです。**座標はこの縮小グリッドの座標系で返してください**（クライアント側で元解像度へ拡大されます）。
${palText}
## 縮小グリッド
${body.segmentGrid}

## 指示
${instruction}
キャラクターを意味のあるパーツ矩形（頭/胴/右腕/左腕/右脚/左脚/武器 など、存在するものだけ）に分割し、スキーマに従って parts を返してください。id は英数字の短い識別子（例: head, torso, arm_r）、pivot はパッチ内ローカル座標の回転支点、z は描画順（小さいほど奥）、parent は親パーツの id（無ければ ""）です。`;
  }

  // §16.2: paletteモードはパレット+ベースフレーム1枚のみの軽量プロンプト
  if (mode === "palette") {
    const palText = palette.map((color, i) => `${tokenForIndex(i, isWidePalette(palette.length))}: ${color}`).join(", ");
    const groupNote = body.mainPalette
      ? `\n\n## メイングループ（推奨: groupChanges で階調ごと変更）\n${body.mainPalette.colors.map((c, i) => `mainIndex ${i}: ${c}`).join(", ")}\nメイングループ単位の変更は groupChanges: [{mainIndex, color}] で返してください。グループ内の全色にHSL相対シフトで展開されます。個別の色変更は従来どおり paletteChanges で指定できます。`
      : "";
    return `${styleSection}## パレットスワップモード${groupNote ? groupNote : ""}
サイズ: ${width}x${height}

## 現在のパレット（index: 色）
${palText}

## ベースフレーム（参考。ドットは変更しない）
${baseFrameGrid}

## 配色指示
${instruction}`;
  }

  const wide = isWidePalette(palette.length);
  let paletteText;
  if (wide && body.mainPalette && Array.isArray(body.mainPalette.colors)) {
    // §18.3: 33色以上はメインパレット要約でトークンを節約
    const mains = body.mainPalette.colors.map((c, i) => `M${i}: ${c}`).join(", ");
    paletteText = `総色数: ${palette.length}（グリッドは16進2桁表現）\nメインパレット（トンマナの主役色。各フルカラーはいずれかのメイングループに属する）:\n${mains}`;
  } else {
    paletteText = palette.map((color, i) => `${tokenForIndex(i, wide)}: ${color}`).join(", ");
  }

  // §22.5-2: redraw はマスクbboxクロップ（cropRect）があればグリッドを切り出しで送る
  const crop = mode === "redraw" && body.cropRect ? body.cropRect : null;
  const cw = cellChars(palette.length);
  const framesText = mode === "redraw"
    ? (crop
        ? `--- フレーム${frameIndex}（リグ合成のラフ = ポーズの正。切り出し ${crop.w}x${crop.h}） ---\n${cropGridString(framesGrid[frameIndex], crop, cw)}`
        : `--- フレーム${frameIndex}（リグ合成のラフ = ポーズの正） ---\n${framesGrid[frameIndex]}`)
    : framesGrid.map((grid, i) => `--- フレーム${i} ---\n${grid}`).join("\n");

  let scopeText;
  if (scope === "all") {
    scopeText = "対象スコープ: 全フレーム";
  } else if (scope === "frame") {
    scopeText = `対象スコープ: フレーム${frameIndex} 全体`;
  } else {
    scopeText = `対象スコープ: フレーム${frameIndex} の矩形 (${selection.x}, ${selection.y}) 〜 (${selection.x + selection.w}, ${selection.y + selection.h})`;
  }

  let baseSection = "";
  if (baseFrameGrid && mode !== "refine") {
    // §19.1: refine ではベースフレーム・アンカリングを適用しない
    baseSection = crop
      ? `\n## ベースフレーム（テイストの唯一の正。切り出し ${crop.w}x${crop.h}）\n${cropGridString(baseFrameGrid, crop, cw)}\n`
      : `\n## ベースフレーム（テイストの唯一の正。新規フレームはこれのコピーを起点にする）\n${baseFrameGrid}\n`;
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

  let refineSection = "";
  if (mode === "refine" && typeof allowedMask === "string") {
    let neighborText = "";
    if (Array.isArray(body.neighborContext) && body.neighborContext.length) {
      neighborText = "\n## 前後フレームの同じ矩形（アニメーションの流れの参考）\n" +
        body.neighborContext.map((nc) => `--- フレーム${nc.frame} ---\n${nc.rows.join("\n")}`).join("\n") + "\n";
    }
    refineSection = `\n## 部分仕上げモード（対象: フレーム${frameIndex}）\n選択範囲のラフな描き込みはユーザーの意図です。シルエット・形を保ったまま、打ち方だけをトンマナと周囲に合わせて清書してください。以下のマスクで '1' のセルだけ変更が許可されています（選択矩形+外周1px。'0' への edits はサーバー側で破棄されます）。\n${allowedMask}\n${neighborText}`;
  }

  let redrawSection = "";
  if (mode === "redraw" && typeof allowedMask === "string") {
    let neighborText = "";
    if (Array.isArray(body.neighborContext) && body.neighborContext.length) {
      neighborText = "\n## 前後フレームの対象領域（動きの連続性の参考）\n" +
        body.neighborContext.map((nc) => `--- フレーム${nc.frame} ---\n${nc.rows.join("\n")}`).join("\n") + "\n";
    }
    const keepTok = isWidePalette(palette.length) ? "'??'" : "'?'";
    // §22.9: 生成的リフレーミング — 「修正」ではなく「新しいポーズを1枚描き起こす」仕事として依頼する。
    // ベース丸写し（ポーズ逆戻り）とラフ放置（空応答）の両方を明示的に「失敗」と定義する（§22.5-1/§22.6-2 を統合）。
    const areaWord = crop ? "クロップ全域" : "対象領域全体";
    const mandate = `あなたはこのキャラクターを担当するドット絵師です。今回の仕事は、アニメーションの1コマとして**キャラクターの新しいポーズを1枚描き起こす**ことです。
- フレーム${frameIndex}のグリッド（リグ合成のラフ）は**ポーズのあたり（下書き）**です。体の傾き・各パーツの位置・シルエット・関節の曲がりは、必ずこのラフに従ってください。
- 「ベースフレーム」は**絵柄の見本**です。線の太さ・シェーディングの段数・色使い・ディテールの密度はベースに合わせてください。ただし**ポーズをベースから取るのは失敗です** — ベースと同じ姿勢に戻さないでください。ベースとラフで姿勢が違うのは意図的（アニメーションの1コマ）です。
- ラフで欠損・崩壊している部分（回転で千切れた/分離したパーツ、つぶれた模様、マント・髪・体の一部の欠け）は、ベースの該当部位を参照して、**ラフの向き・位置に合わせて描き起こして**ください。
- ラフをそのまま残すのも失敗です（機械的な回転合成によるドラフト品質。ジャギー・パーツの分離を含みます）。
- ${areaWord}の rows を**丸ごと**返してください。${keepTok}（変更なし）による差分の最小化に推論時間を使わないでください。この指示は「最小差分の原則」より優先します。パレットは厳守してください。`;
    const cropNote = crop
      ? `\nこのプロンプトの全グリッド（ベース・ラフ・マスク・前後フレーム）はキャンバス座標 (${crop.x}, ${crop.y}) 起点の ${crop.w}x${crop.h} 切り出しです。edits の x, y は**切り出しローカル座標**（(0,0)〜(${crop.w - 1},${crop.h - 1})）で返してください。サーバー側でキャンバス座標へ変換されます。frame は ${frameIndex} のままです。`
      : "";
    const maskText = crop ? cropGridString(allowedMask, crop, 1) : allowedMask;
    // §22.10-1: プロンプト補足（実験用ノブ）— 入力があるときだけ末尾に付加
    const extra = typeof body.promptExtra === "string" ? body.promptExtra.trim().slice(0, 4000) : "";
    const extraSection = extra ? `\n## 追加の指示（ユーザー）\n${extra}\n` : "";
    redrawSection = `\n## ポーズガイド再描画モード（対象: フレーム${frameIndex}）\n${mandate}${cropNote}\nマスク（'1' のセルだけ変更可。'0' への edits はサーバー側で破棄されます）:\n${maskText}\n${neighborText}${extraSection}`;
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

  return `${styleSection}## キャンバス
サイズ: ${width}x${height}, fps: ${fps}

## パレット（index: 色）
${paletteText}
${baseSection}
## 現在のフレーム（テキストグリッド）
${framesText}
${lockedSection}${segmentSection}${cleanupSection}${refineSection}${redrawSection}${motionSection}
## ${scopeText}

## 編集指示
${instruction}`;
}

// リクエストから画像（base64）を正規化して取り出す
function buildImages(body) {
  const out = [];
  // §17.3: トンマナ参考画像（APIバックエンドのみ。CLIでは includeImages=false で落ちる）
  if (typeof body.styleImage === "string" && body.mode !== "style") {
    out.push({ frame: "style", data: extractBase64FromDataUrl(body.styleImage), caption: "↑ トンマナ基準の参考画像" });
  }
  if (Array.isArray(body.images)) {
    for (const im of body.images) out.push({ frame: im.frame, data: extractBase64FromDataUrl(im.dataUrl) });
  }
  return out;
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

// §22.5-2: redraw+cropRect のとき、モデルはクロップローカル座標で edits を返す。
// 受信直後にキャンバス座標へオフセット加算してから既存のマスク検証に流す。
function offsetCropEdits(rawPatch, body) {
  if (body.mode !== "redraw" || !body.cropRect || !rawPatch || !Array.isArray(rawPatch.edits)) return rawPatch;
  const { x, y } = body.cropRect;
  for (const e of rawPatch.edits) {
    if (e && Number.isInteger(e.x) && Number.isInteger(e.y)) {
      e.x += x;
      e.y += y;
    }
  }
  return rawPatch;
}

function validateAndClampPatch(rawPatch, body) {
  const warnings = [];
  const { project, scope, frameIndex, selection, mode, baseFrameGrid } = body;
  const { width, height, palette, framesGrid } = project;
  const frameCount = framesGrid.length;
  const lockedRects = Array.isArray(body.lockedRects) ? body.lockedRects : [];
  const wide = isWidePalette(palette.length);
  const cw = cellChars(palette.length);
  const KEEP = wide ? "??" : "?";
  const baseTokRows = typeof baseFrameGrid === "string"
    ? baseFrameGrid.split("\n").map((r) => splitTokens(r, cw))
    : null;

  if (!rawPatch || typeof rawPatch !== "object") throw new Error("パッチの形式が不正です");
  const edits = Array.isArray(rawPatch.edits) ? rawPatch.edits : [];
  const newFrames = Array.isArray(rawPatch.newFrames) ? rawPatch.newFrames : [];
  const paletteChanges = Array.isArray(rawPatch.paletteChanges) ? rawPatch.paletteChanges : [];
  const note = typeof rawPatch.note === "string" ? rawPatch.note : "";

  // 内部ではトークン配列（1セル=1要素）で処理し、最後に文字列へ戻す
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
    const tokRows = rows.map((r) => (typeof r === "string" ? splitTokens(r, cw) : null));
    if (tokRows.some((tr) => !tr || !tokensValid(tr, wide, true))) {
      warnings.push("edits に不正な文字が含まれるため無視しました");
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      warnings.push("edits の座標がキャンバス範囲外のため無視しました");
      continue;
    }
    // scope=selection のときは選択矩形外への edits を切り捨てる
    let ex = x, ey = y, erows = tokRows;
    if (scope === "selection" && selection) {
      if (frame !== frameIndex) {
        warnings.push(`フレーム${frame}への編集は選択範囲外（対象フレーム外）のため無視しました`);
        continue;
      }
      const clipped = clipTokRowsToRect(x, y, tokRows, selection.x, selection.y, selection.w, selection.h, KEEP);
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
    // 行の幅がキャンバスをはみ出す場合は切り詰め（セル単位）
    const maxW = width - ex;
    const trimmedRows = erows.map((tr) => tr.slice(0, Math.max(0, maxW)));
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
    const tokRows = Array.isArray(rows) ? rows.map((r) => (typeof r === "string" ? splitTokens(r, cw) : null)) : null;
    if (!tokRows || tokRows.length !== height ||
        tokRows.some((tr) => !tr || tr.length !== width || !tokensValid(tr, wide, false))) {
      warnings.push("newFrames の rows がフレームサイズと一致しないため無視しました（?は使用不可）");
      continue;
    }
    cleanNewFrames.push({ insertAfter, rows: tokRows });
  }

  // --- ロック領域の強制上書き（§13.2-3）---
  if (lockedRects.length > 0) {
    let overriddenCells = 0;
    for (const e of cleanEdits) {
      e.rows = e.rows.map((tr, ry) => tr.map((tok, rx) => {
        const ax = e.x + rx, ay = e.y + ry;
        if (tok !== KEEP && cellLocked(ax, ay, lockedRects)) {
          overriddenCells++;
          return baseTokRows ? baseTokRows[ay][ax] : KEEP;
        }
        return tok;
      }));
    }
    for (const nf of cleanNewFrames) {
      nf.rows = nf.rows.map((tr, y) => tr.map((tok, x) => {
        if (cellLocked(x, y, lockedRects) && baseTokRows) {
          if (tok !== baseTokRows[y][x]) overriddenCells++;
          return baseTokRows[y][x];
        }
        return tok;
      }));
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
    if (!Number.isInteger(index) || index < 0 || index >= 256) {
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

  // --- AI清書/部分仕上げ（§14.4-2/§19）: 許可セル（allowedMask='1'）外の edits を破棄 ---
  if ((mode === "cleanup" || mode === "refine" || mode === "redraw") && typeof body.allowedMask === "string") {
    const maskRows = body.allowedMask.split("\n");
    let discarded = 0;
    for (const e of cleanEdits) {
      e.rows = e.rows.map((tr, ry) => tr.map((tok, rx) => {
        const ax = e.x + rx, ay = e.y + ry;
        if (tok !== KEEP && maskRows[ay][ax] !== "1") {
          discarded++;
          return KEEP;
        }
        return tok;
      }));
    }
    if (discarded > 0) warnings.push(`許可セル外の ${discarded} セルの編集を破棄しました`);
    const modeName = mode === "refine" ? "部分仕上げ" : mode === "redraw" ? "描き直し" : "清書";
    if (cleanNewFrames.length > 0) {
      warnings.push(`${modeName}モードのため newFrames（${cleanNewFrames.length}件）を破棄しました`);
      cleanNewFrames.length = 0;
    }
    if (cleanPaletteChanges.length > 0) {
      warnings.push(`${modeName}モードのため paletteChanges（${cleanPaletteChanges.length}件）を破棄しました`);
      cleanPaletteChanges.length = 0;
    }
  }

  return {
    edits: cleanEdits.map((e) => ({ ...e, rows: e.rows.map((tr) => tr.join("")) })),
    newFrames: cleanNewFrames.map((nf) => ({ ...nf, rows: nf.rows.map((tr) => tr.join("")) })),
    paletteChanges: cleanPaletteChanges,
    note,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// style レスポンスの検証（§17.2）
// ---------------------------------------------------------------------------
function validateStyleResult(raw) {
  if (!raw || typeof raw !== "object") throw new Error("style結果の形式が不正です");
  const guide = typeof raw.guide === "string" ? raw.guide.trim().slice(0, 4000) : "";
  if (!guide) throw new Error("guide が空です");
  return { guide, note: typeof raw.note === "string" ? raw.note : "", warnings: [] };
}

// ---------------------------------------------------------------------------
// palette レスポンスの検証（§16.2 / §18.3: groupChanges のHSL相対シフト展開）
// ---------------------------------------------------------------------------
function hexToRgbArr(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHslArr(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToHexStr(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return "#" + rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

function validatePaletteResult(raw, body) {
  const warnings = [];
  if (!raw || typeof raw !== "object") throw new Error("palette結果の形式が不正です");
  const paletteLen = body.project.palette.length;
  const hexRe = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  const paletteChanges = [];
  const seen = new Set();
  const push = (index, color) => {
    if (seen.has(index)) {
      // 後勝ち（個別指定がグループ展開を上書き）
      const i = paletteChanges.findIndex((p) => p.index === index);
      paletteChanges[i] = { index, color };
    } else {
      paletteChanges.push({ index, color });
      seen.add(index);
    }
  };

  // §18.3: groupChanges → メイングループ全色へHSL相対シフト展開
  const mp = body.mainPalette;
  const rawGroups = Array.isArray(raw.groupChanges) ? raw.groupChanges : [];
  if (rawGroups.length > 0) {
    if (!mp) {
      warnings.push("mainPalette が無いため groupChanges を無視しました");
    } else {
      for (const gc of rawGroups) {
        if (!gc || !Number.isInteger(gc.mainIndex) || gc.mainIndex < 0 || gc.mainIndex >= mp.colors.length ||
            typeof gc.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(gc.color)) {
          warnings.push("不正な groupChanges を無視しました");
          continue;
        }
        const from = rgbToHslArr(...hexToRgbArr(mp.colors[gc.mainIndex]));
        const to = rgbToHslArr(...hexToRgbArr(gc.color));
        const dH = to[0] - from[0];
        const dS = to[1] - from[1];
        const dL = to[2] - from[2];
        for (let i = 1; i < paletteLen; i++) {
          if (mp.groups[i] !== gc.mainIndex) continue;
          const cur = body.project.palette[i];
          if (typeof cur !== "string" || !hexRe.test(cur)) continue;
          const hsl = rgbToHslArr(...hexToRgbArr(cur));
          push(i, hslToHexStr(hsl[0] + dH, hsl[1] + dS, hsl[2] + dL));
        }
      }
    }
  }

  const rawChanges = Array.isArray(raw.paletteChanges) ? raw.paletteChanges : [];
  for (const pc of rawChanges) {
    if (!pc || !Number.isInteger(pc.index) || typeof pc.color !== "string" || !hexRe.test(pc.color)) {
      warnings.push("不正な paletteChanges を無視しました");
      continue;
    }
    if (pc.index === 0) {
      warnings.push("index 0（透明）への変更を無視しました");
      continue;
    }
    if (pc.index < 0 || pc.index >= paletteLen) {
      warnings.push(`index ${pc.index} はパレット範囲外のため無視しました`);
      continue;
    }
    push(pc.index, pc.color);
  }
  return { paletteChanges, note: typeof raw.note === "string" ? raw.note : "", warnings };
}

// ---------------------------------------------------------------------------
// segment レスポンスの検証（§14.2）
// ---------------------------------------------------------------------------
function validateSegment(rawSegment, body) {
  const warnings = [];
  // §14.5.5: 縮小グリッド使用時は、その座標系の寸法で検証する
  let { width, height } = body.project;
  if (typeof body.segmentGrid === "string") {
    const rows = body.segmentGrid.split("\n");
    width = rows[0].length;
    height = rows.length;
  }
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

// 矩形(sx,sy,sw,sh)にトークン行列(x,yから始まる)をクリップする（§18.1: セル単位）
function clipTokRowsToRect(x, y, tokRows, sx, sy, sw, sh, KEEP) {
  const sxEnd = sx + sw;
  const syEnd = sy + sh;
  let clipped = false;
  const outRows = [];
  let outY = null;
  for (let ry = 0; ry < tokRows.length; ry++) {
    const absY = y + ry;
    if (absY < sy || absY >= syEnd) { clipped = true; continue; }
    if (outY === null) outY = absY;
    const tr = tokRows[ry];
    const outRow = [];
    let outX = null;
    for (let rx = 0; rx < tr.length; rx++) {
      const absX = x + rx;
      if (absX < sx || absX >= sxEnd) { clipped = true; continue; }
      if (outX === null) outX = absX;
      outRow.push(tr[rx]);
    }
    if (outRow.length > 0) outRows.push({ x: outX, row: outRow });
  }
  if (outRows.length === 0 || outY === null) return null;
  const minX = Math.min(...outRows.map((r) => r.x));
  const maxLen = Math.max(...outRows.map((r) => r.x - minX + r.row.length));
  const normalized = outRows.map((r) => {
    const pad = new Array(r.x - minX).fill(KEEP);
    const out = pad.concat(r.row);
    while (out.length < maxLen) out.push(KEEP);
    return out;
  });
  return { x: minX, y: outY, rows: normalized, clipped };
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
  const wide = isWidePalette(palette.length);
  const ch = tokenForIndex(lastIdx, wide) || (wide ? "01" : "1");

  let fakePatch;
  if (mode === "segment" && typeof body.segmentGrid === "string") {
    // §14.5.5: 縮小グリッドの座標系で固定3パーツを返す（クライアントが拡大）
    const segRows = body.segmentGrid.split("\n");
    const sw = segRows[0].length, sh = segRows.length;
    const tw = Math.max(2, Math.floor(sw * 0.4));
    const tx = Math.floor((sw - tw) / 2);
    const headH = Math.max(2, Math.floor(sh * 0.25));
    const torsoH = Math.max(2, Math.floor(sh * 0.3));
    const legsH = Math.max(2, Math.floor(sh * 0.2));
    const headY = Math.max(0, Math.floor(sh * 0.1));
    const torsoY = Math.min(sh - torsoH, headY + headH);
    const legsY = Math.min(sh - legsH, torsoY + torsoH);
    fakePatch = {
      parts: [
        { id: "torso", name: "胴", x: tx, y: torsoY, w: tw, h: torsoH, pivotX: Math.floor(tw / 2), pivotY: Math.floor(torsoH / 2), z: 1, parent: "" },
        { id: "head", name: "頭", x: tx, y: headY, w: tw, h: headH, pivotX: Math.floor(tw / 2), pivotY: headH - 1, z: 2, parent: "torso" },
        { id: "legs", name: "脚", x: tx, y: legsY, w: tw, h: legsH, pivotX: Math.floor(tw / 2), pivotY: 0, z: 0, parent: "torso" },
      ],
      note: "MOCK: 縮小グリッドで頭・胴・脚に分割しました（下書き）",
    };
  } else if (mode === "style") {
    fakePatch = {
      guide: "頭身: 2頭身デフォルメ\n輪郭: 黒(#1a1c2c)1pxを常時使用\nシェーディング: 2段・ディザなし\nハイライト: 左上光源で上端に1px\n彩度・明度: 中彩度・やや暗め\n代表色: #1a1c2c, #5d275d, #b13e53\n打ち方: 角は1px面取り、1pxディテールは控えめ",
      note: "MOCK: 固定のスタイルガイドを返しました",
    };
  } else if (mode === "palette") {
    if (body.mainPalette) {
      // §18.3: グループ単位スワップ（mainIndex 0 を緑へ相対シフト）
      fakePatch = {
        paletteChanges: [],
        groupChanges: [{ mainIndex: 0, color: "#2e7d32" }],
        note: "MOCK: メイングループ0を緑系へ相対シフト",
      };
    } else {
      // 固定の paletteChanges（緑基調・§16.7）
      const greens = ["#1a3d1a", "#2e7d32", "#57a05a", "#7fc383", "#a5d6a7"];
      const paletteChanges = [];
      for (let i = 1; i < Math.min(palette.length, greens.length + 1); i++) {
        paletteChanges.push({ index: i, color: greens[i - 1] });
      }
      fakePatch = { paletteChanges, groupChanges: [], note: "MOCK: 緑基調の配色に変更しました" };
    }
  } else if (mode === "segment") {
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
  } else if ((mode === "refine" || mode === "redraw") && typeof allowedMask === "string") {
    // 許可セルの現在値をそのままエコー（配管確認用・§19.3）
    const cw2 = cellChars(palette.length);
    const KEEP2 = wide ? "??" : "?";
    const maskRows = allowedMask.split("\n");
    const gridRows = project.framesGrid[frameIndex].split("\n").map((r) => splitTokens(r, cw2));
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (maskRows[y][x] === "1") {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    const rows = [];
    if (maxX >= 0) {
      for (let y = minY; y <= maxY; y++) {
        let row = "";
        for (let x = minX; x <= maxX; x++) {
          row += maskRows[y][x] === "1" ? gridRows[y][x] : KEEP2;
        }
        rows.push(row);
      }
    }
    fakePatch = {
      edits: maxX >= 0 ? [{ frame: frameIndex, x: minX, y: minY, rows }] : [],
      newFrames: [],
      paletteChanges: [],
      note: mode === "redraw" ? "MOCK: redraw（ラフのエコー）" : "MOCK: refine（選択範囲をそのままエコー）",
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
    const blankRow = (wide ? ".." : ".").repeat(width);
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
    } else if (mode === "palette") {
      const palette = validatePaletteResult(JSON.parse(fakeText), body);
      sseSend(res, { type: "result", palette, usage: { mock: true } });
    } else if (mode === "style") {
      const style = validateStyleResult(JSON.parse(fakeText));
      sseSend(res, { type: "result", style, usage: { mock: true } });
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
// バックエンド抽象化（§15.3）: callBackend({ systemText, userText, images, schema, onDelta })
// api / cli の2実装（mock は runMock が最優先で処理）。
// 戻り値: { text, usage } — text はモデルのJSONテキスト（cliはフェンス除去済み）
// ---------------------------------------------------------------------------
function userError(msg) {
  const e = new Error(msg);
  e.userFacing = true; // describeAnthropicError でそのまま表示する
  return e;
}

async function callBackend(opts) {
  if (BACKEND === "cli") return callBackendCli(opts);
  if (BACKEND === "codex") return callBackendCodex(opts); // §23
  return callBackendApi(opts);
}

// §22.5-5: CLI_DEBUG=1 のとき、CLI呼び出しごとにプロンプトと生の stdout/stderr を保存
let cliDebugSeq = 0;
function cliDebugLog(backend, mode, prompt, stdout, stderr) {
  if (!CLI_DEBUG) return;
  try {
    const dir = path.join(process.cwd(), "cli-logs");
    fssync.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${ts}-${String(++cliDebugSeq).padStart(3, "0")}-${mode || "patch"}.txt`);
    fssync.writeFileSync(file, `# backend: ${backend}\n# prompt (${prompt.length}B)\n${prompt}\n\n# stdout (${stdout.length}B)\n${stdout}\n\n# stderr (${stderr.length}B)\n${stderr}\n`);
    console.log(`[cli-debug] ${file}`);
  } catch (err) {
    console.error(`[cli-debug] 保存に失敗しました: ${err.message}`);
  }
}

// --- BACKEND=api: @anthropic-ai/sdk（現行どおり・§6の形状） ---
async function callBackendApi({ systemText, userText, images, schema, onDelta, registerCancel }) {
  const client = new Anthropic();
  const content = [];
  for (const im of images) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: im.data } });
    content.push({ type: "text", text: im.caption || `↑ フレーム${im.frame} の参考画像（8倍拡大PNG）` });
  }
  content.push({ type: "text", text: userText });

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema },
    },
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });

  registerCancel(() => { try { stream.abort(); } catch {} });
  stream.on("text", (delta) => onDelta(delta));
  stream.on("error", () => { /* finalMessage() 側で処理 */ });

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw userError("モデルがこの指示への応答を拒否しました。指示内容を変えて再試行してください。");
  }
  if (final.stop_reason === "max_tokens") {
    throw userError("出力がトークン上限に達しました。指示の範囲を狭めて再試行してください。");
  }
  const textBlock = final.content.find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) {
    throw userError("モデルからの応答にテキストが含まれていませんでした。");
  }
  return { text: textBlock.text, usage: final.usage || {} };
}

// --- BACKEND=cli: claude CLI を spawn（§15.2） ---
let cliActive = 0;
const cliWaiters = [];
function acquireCliSlot() {
  return new Promise((resolve) => {
    if (cliActive < CLI_CONCURRENCY) {
      cliActive++;
      resolve();
    } else {
      cliWaiters.push(resolve);
    }
  });
}
function releaseCliSlot() {
  const next = cliWaiters.shift();
  if (next) {
    next(); // スロットを引き継ぐ（cliActive は据え置き）
  } else {
    cliActive--;
  }
}

function stripCodeFence(text) {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

// ---------------------------------------------------------------------------
// §23.4-1: Windows の .cmd/.bat シム対応
// npm グローバルインストールの codex/claude の実体は .cmd（バッチシム）で、Node の
// spawn は .cmd/.bat を直接起動できない（セキュリティ修正以降 EINVAL/EPERM）。
// 起動コマンドが .cmd/.bat で終わる場合、Windows では
//   cmd.exe /d /s /c ""<path>" <args...>"
// 形式に組み替える（スペースを含む引数のみ二重引用符で囲む。プロンプトは stdin 渡し）。
// platform はユニットテストのため引数で上書き可能（既定 process.platform）。
// ---------------------------------------------------------------------------
export function buildSpawnCommand(cmd, args, platform = process.platform) {
  // .cmd/.bat シム、または拡張子なしのコマンド名（例: 素の "codex"。npm シムは
  // CreateProcess から直接起動できず spawn EPERM/EINVAL になる）は cmd.exe 経由で起動する。
  // cmd.exe は PATHEXT 解決を行うため、PATH 上の codex.cmd も見つけられる。
  const base = cmd.split(/[\\/]/).pop();
  const needsShell = /\.(cmd|bat)$/i.test(cmd) || !base.includes(".");
  if (platform === "win32" && needsShell) {
    const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
    const inner = [`"${cmd}"`, ...args.map(quote)].join(" ");
    return {
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", `"${inner}"`],
      // cmd.exe に渡す1本の文字列を Node に再クォートさせない
      options: { windowsVerbatimArguments: true },
    };
  }
  return { cmd, args, options: {} };
}

// §23.4-2: spawn 起動失敗の分類（EPERM/EINVAL は .cmd シム起因のガイダンス付き）。
// テストのため export（メッセージ文字列の単体検証用）。
export function spawnStartError(err, { label, envVar, pkg, enoentMsg }) {
  if (err?.code === "ENOENT") return userError(enoentMsg);
  if (err?.code === "EPERM" || err?.code === "EINVAL") {
    return userError(
      `${label} の起動に失敗しました（spawn ${err.code}）。Windows では npm 版 codex/claude の実体が .cmd シム（バッチファイル）のため直接起動できないことが原因の可能性が高いです。` +
      `環境変数 ${envVar} に .cmd のフルパス（PowerShell で (Get-Command ${envVar === "CODEX_PATH" ? "codex" : "claude"}).Source の値）を設定するか、` +
      `実体の .exe（\`npm root -g\` 配下の ${pkg} 内の *.exe）を直接指定してください。ウイルス対策ソフトが起動をブロックしている可能性もあります。`
    );
  }
  return userError(`${label} の起動に失敗しました: ${err.message}`);
}
const CLAUDE_SPAWN_ERR = {
  label: "Claude Code CLI",
  envVar: "CLI_PATH",
  pkg: "@anthropic-ai/claude-code",
  enoentMsg: "Claude Code CLI が見つかりません。`npm install -g @anthropic-ai/claude-code` の上 `claude` にログインしてください。",
};
const CODEX_SPAWN_ERR = {
  label: "Codex CLI",
  envVar: "CODEX_PATH",
  pkg: "@openai/codex",
  enoentMsg: "codex が見つかりません。`npm i -g @openai/codex` でインストールし、`codex login` でログインしてください。パスが解決できない場合は環境変数 CODEX_PATH に実体のフルパスを設定してください。",
};

function spawnClaudeCli(prompt, { registerCancel, mode }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // §23.4-1: CLI_PATH が .cmd/.bat のとき Windows では cmd.exe 経由で起動
      const sc = buildSpawnCommand(CLI_CMD, ["-p", "--output-format", "json", "--model", CLI_MODEL]);
      child = spawn(sc.cmd, sc.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...sc.options });
    } catch (err) {
      // Node は .cmd 直接指定などで同期的に EINVAL を投げることがある（§23.4-2）
      reject(spawnStartError(err, CLAUDE_SPAWN_ERR));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cliDebugLog("cli", mode, prompt, stdout, stderr); // §22.5-5
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      // 診断用: CLIが黙って固まる原因（レート制限・認証切れ等）はstdout/stderrに出ていることが多い
      const peek = `${stderr}\n${stdout}`.trim().replace(/\s+/g, " ").slice(0, 300);
      const diag = peek ? `\nCLIの出力（診断用）: ${peek}` : `\nCLIからの出力はありませんでした。起動された「${CLI_CMD}」が別の実体（例: Claudeデスクトップアプリ）に解決されている可能性があります。PowerShellで Get-Command claude のSourceを確認し、そのフルパスを環境変数 CLI_PATH に設定して起動してください。`;
      console.error(`[cli-timeout] ${CLI_TIMEOUT_SEC}s, stdout=${stdout.length}B stderr=${stderr.length}B: ${peek}`);
      settle(reject, userError(`Claude Code CLI がタイムアウトしました（${CLI_TIMEOUT_SEC}秒）。対処: (1) 矩形選択で範囲を狭めて指示する、(2) 環境変数 CLI_TIMEOUT でタイムアウト秒数を延ばす、(3) CLI_MODEL=haiku など高速なモデルを試す。${diag}`));
    }, CLI_TIMEOUT_MS);

    registerCancel(() => {
      try { child.kill("SIGKILL"); } catch {}
      const e = new Error("リクエストが中断されました。");
      e.name = "AbortError";
      settle(reject, e);
    });

    child.on("error", (err) => {
      settle(reject, spawnStartError(err, CLAUDE_SPAWN_ERR)); // §23.4-2: EPERM/EINVAL はシムガイダンス
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code !== 0) {
        settle(reject, userError(`Claude Code CLI がエラー終了しました (code ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      settle(resolve, stdout);
    });

    console.log(`[cli] spawn ${CLI_CMD} (model=${CLI_MODEL}) prompt=${prompt.length}B`);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 構造化出力APIは使えないため、スキーマをプロンプト末尾に埋め込む（§15.2。cli/codex共通）
function buildCliPrompt(systemText, userText, schema) {
  return `${systemText}

${userText}

## 出力形式（厳守）
出力は次のJSON Schemaに厳密に従うJSONのみを返すこと。コードフェンス（\`\`\`）や説明文は一切禁止。
${JSON.stringify(schema)}`;
}

// cli / codex 共通のランナー: キュー・ハートビート・フェンス除去・パース失敗時1回リトライ（§15.2/§23.1）
async function runCliLikeBackend({ label, fetchText, usage }, { systemText, userText, schema, onDelta }) {
  const basePrompt = buildCliPrompt(systemText, userText, schema);
  await acquireCliSlot();
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    onDelta(`（${sec}秒経過）`);
  }, 10 * 1000); // 進捗ハートビート: 10秒間隔+経過秒数（§15.5-4）
  try {
    const runOnce = async (prompt) => stripCodeFence(await fetchText(prompt));
    let text = await runOnce(basePrompt);
    try {
      JSON.parse(text);
    } catch {
      // パース失敗時は1回だけリトライ（§15.2）
      onDelta("…");
      text = await runOnce(`${basePrompt}

前回の出力はJSONとして解析できませんでした。今度こそ、JSONのみで再出力してください。`);
      try {
        JSON.parse(text);
      } catch {
        throw userError(`${label} の出力をJSONとして解析できませんでした（リトライ後も失敗）。`);
      }
    }
    return { text, usage };
  } finally {
    clearInterval(heartbeat);
    releaseCliSlot();
  }
}

async function callBackendCli({ systemText, userText, schema, onDelta, registerCancel, mode }) {
  const fetchText = async (prompt) => {
    const stdout = await spawnClaudeCli(prompt, { registerCancel, mode });
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw userError("Claude Code CLI の応答エンベロープの解析に失敗しました。");
    }
    if (typeof envelope.result !== "string") {
      throw userError("Claude Code CLI の応答に result フィールドがありません。");
    }
    return envelope.result;
  };
  return runCliLikeBackend(
    { label: "Claude Code CLI", fetchText, usage: { backend: "cli", model: CLI_MODEL } },
    { systemText, userText, schema, onDelta }
  );
}

// --- BACKEND=codex: OpenAI Codex CLI を spawn（§23.1）---
// `codex exec --sandbox read-only --skip-git-repo-check --output-last-message <tmp> -`
// stdin からプロンプトを読み、最終メッセージを一時ファイル経由で受け取る。
function spawnCodexCli(prompt, { registerCancel, mode }) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `ai-meglio-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--output-last-message", outFile];
    if (CODEX_MODEL) args.push("-m", CODEX_MODEL);
    args.push("-"); // stdin からプロンプトを読む
    let child;
    try {
      // §23.4-1: CODEX_PATH が .cmd/.bat のとき Windows では cmd.exe 経由で起動
      const sc = buildSpawnCommand(CODEX_CMD, args);
      child = spawn(sc.cmd, sc.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...sc.options });
    } catch (err) {
      // Node は .cmd 直接指定などで同期的に EINVAL を投げることがある（§23.4-2）
      reject(spawnStartError(err, CODEX_SPAWN_ERR));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cliDebugLog("codex", mode, prompt, stdout, stderr); // §22.5-5/§23.1
      try { fssync.unlinkSync(outFile); } catch {}
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      const peek = `${stderr}\n${stdout}`.trim().replace(/\s+/g, " ").slice(0, 300);
      const diag = peek ? `\nCLIの出力（診断用）: ${peek}` : "";
      console.error(`[codex-timeout] ${CLI_TIMEOUT_SEC}s, stdout=${stdout.length}B stderr=${stderr.length}B: ${peek}`);
      settle(reject, userError(`Codex CLI がタイムアウトしました（${CLI_TIMEOUT_SEC}秒）。対処: (1) 矩形選択で範囲を狭めて指示する、(2) 環境変数 CLI_TIMEOUT でタイムアウト秒数を延ばす、(3) CODEX_MODEL で軽いモデルを試す。${diag}`));
    }, CLI_TIMEOUT_MS);

    registerCancel(() => {
      try { child.kill("SIGKILL"); } catch {}
      const e = new Error("リクエストが中断されました。");
      e.name = "AbortError";
      settle(reject, e);
    });

    child.on("error", (err) => {
      settle(reject, spawnStartError(err, CODEX_SPAWN_ERR)); // §23.4-2: EPERM/EINVAL はシムガイダンス
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code !== 0) {
        settle(reject, userError(`Codex CLI がエラー終了しました (code ${code}): ${(stderr || stdout).slice(0, 200)}`));
        return;
      }
      let last = "";
      try { last = fssync.readFileSync(outFile, "utf8"); } catch {}
      if (!last.trim()) {
        settle(reject, userError("Codex CLI の応答が空でした（--output-last-message のファイルにメッセージがありません）。"));
        return;
      }
      settle(resolve, last);
    });

    console.log(`[codex] spawn ${CODEX_CMD} exec (model=${CODEX_MODEL || "default"}) prompt=${prompt.length}B`);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callBackendCodex({ systemText, userText, schema, onDelta, registerCancel, mode }) {
  const fetchText = (prompt) => spawnCodexCli(prompt, { registerCancel, mode });
  return runCliLikeBackend(
    { label: "Codex CLI", fetchText, usage: { backend: "codex", model: CODEX_MODEL || "default" } },
    { systemText, userText, schema, onDelta }
  );
}

// ---------------------------------------------------------------------------
// 実AI呼び出し（バックエンド共通のSSE整形・検証。§15.3: この層は backend に依存しない）
// ---------------------------------------------------------------------------
async function runReal(body, res, aborted) {
  // §15.5-3: CLIバックエンドで scope=all の編集（mode=patch）は
  // フレームごとの個別呼び出しに分割する（1呼び出しの出力量・推論時間を分割）
  const effectiveMode = body.mode || "patch";
  if (
    BACKEND !== "api" &&
    effectiveMode === "patch" &&
    body.scope === "all" &&
    body.project.framesGrid.length > 1
  ) {
    return runRealSplitAllFrames(body, res, aborted);
  }
  const schema = body.mode === "segment" ? SEGMENT_SCHEMA : body.mode === "palette" ? PALETTE_SCHEMA : body.mode === "style" ? STYLE_SCHEMA : PATCH_SCHEMA;
  const includeImages = BACKEND === "api"; // §15.2: CLI系バックエンドは画像を渡さない
  const images = includeImages ? buildImages(body) : [];
  const userText = buildUserText(body);

  const cancelFns = [];
  const onClose = () => {
    aborted.value = true;
    for (const fn of cancelFns) { try { fn(); } catch {} }
  };
  res.req.on("close", onClose);

  try {
    const { text, usage } = await callBackend({
      systemText: systemPromptFor(body.project.palette.length),
      userText,
      images,
      schema,
      mode: body.mode || "patch",
      onDelta: (delta) => { if (!aborted.value) sseSend(res, { type: "delta", text: delta }); },
      registerCancel: (fn) => cancelFns.push(fn),
    });
    res.req.off("close", onClose);
    if (aborted.value) { res.end(); return; }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      sseSend(res, { type: "error", message: "モデル出力のJSON解析に失敗しました。" });
      res.end();
      return;
    }

    try {
      if (body.mode === "segment") {
        const segment = validateSegment(raw, body);
        sseSend(res, { type: "result", segment, usage });
      } else if (body.mode === "palette") {
        const palette = validatePaletteResult(raw, body);
        sseSend(res, { type: "result", palette, usage });
      } else if (body.mode === "style") {
        const style = validateStyleResult(raw);
        sseSend(res, { type: "result", style, usage });
      } else {
        const patch = validateAndClampPatch(offsetCropEdits(raw, body), body);
        sseSend(res, { type: "result", patch, usage });
      }
    } catch (err) {
      sseSend(res, { type: "error", message: `結果の検証に失敗しました: ${err.message}` });
    }
    res.end();
  } catch (err) {
    res.req.off("close", onClose);
    if (aborted.value) { try { res.end(); } catch {} return; }
    sseSend(res, { type: "error", message: describeAnthropicError(err) });
    try { res.end(); } catch {}
  }
}

// §15.5-3: scope=all の編集をフレームごとのバックエンド呼び出しに分割し、
// edits を統合して1つのSSE resultで返す（CLI キューにより並列2で実行される）
async function runRealSplitAllFrames(body, res, aborted) {
  const frameCount = body.project.framesGrid.length;

  const cancelFns = [];
  const onClose = () => {
    aborted.value = true;
    for (const fn of cancelFns) { try { fn(); } catch {} }
  };
  res.req.on("close", onClose);

  let doneCount = 0;
  const tasks = [];
  for (let i = 0; i < frameCount; i++) {
    const subBody = {
      ...body,
      scope: "frame",
      frameIndex: i,
      selection: null,
      instruction: `${body.instruction}\n（この指示は全フレーム共通です。全フレーム共通の指示を、このフレーム${i}に適用してください。他フレームとの一貫性を保ってください）`,
    };
    const userText = buildUserText(subBody);
    tasks.push(
      callBackend({
        systemText: systemPromptFor(body.project.palette.length),
        userText,
        images: [], // 分割はCLI系モードのみ = 画像なし
        schema: PATCH_SCHEMA,
        mode: "patch",
        onDelta: (delta) => { if (!aborted.value) sseSend(res, { type: "delta", text: delta }); },
        registerCancel: (fn) => cancelFns.push(fn),
      }).then(({ text }) => {
        const raw = JSON.parse(text); // runCliLikeBackend がパース可能性を保証（リトライ込み）
        doneCount++;
        if (!aborted.value) sseSend(res, { type: "delta", text: `フレーム ${doneCount}/${frameCount} 完了` });
        return { frame: i, raw };
      })
    );
  }

  const results = await Promise.allSettled(tasks);
  res.req.off("close", onClose);
  if (aborted.value) { try { res.end(); } catch {} return; }

  const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const rejected = results
    .map((r, i) => (r.status === "rejected" ? { frame: i, reason: r.reason } : null))
    .filter(Boolean);

  if (fulfilled.length === 0) {
    sseSend(res, { type: "error", message: describeAnthropicError(rejected[0]?.reason) });
    try { res.end(); } catch {}
    return;
  }

  // edits をフレーム番号を差し替えて統合。newFrames は分割モードでは破棄して警告。
  const splitWarnings = [];
  const mergedRaw = { edits: [], newFrames: [], paletteChanges: [], note: "" };
  let discardedNewFrames = 0;
  const notes = [];
  for (const { frame, raw } of fulfilled) {
    if (Array.isArray(raw.edits)) {
      for (const e of raw.edits) {
        if (e && typeof e === "object") mergedRaw.edits.push({ ...e, frame });
      }
    }
    if (Array.isArray(raw.newFrames) && raw.newFrames.length > 0) {
      discardedNewFrames += raw.newFrames.length;
    }
    if (Array.isArray(raw.paletteChanges)) mergedRaw.paletteChanges.push(...raw.paletteChanges);
    if (typeof raw.note === "string" && raw.note) notes.push(raw.note);
  }
  if (discardedNewFrames > 0) {
    splitWarnings.push(`フレーム分割モードのため newFrames（${discardedNewFrames}件）を破棄しました（中割りは「現在のフレーム」スコープで指示してください）`);
  }
  for (const rj of rejected) {
    splitWarnings.push(`フレーム${rj.frame}の処理に失敗しました: ${describeAnthropicError(rj.reason)}`);
  }
  mergedRaw.note = notes.length ? `全${frameCount}フレームに個別適用: ${notes[0]}` : `全${frameCount}フレームに個別適用しました`;

  try {
    const patch = validateAndClampPatch(mergedRaw, body);
    patch.warnings.push(...splitWarnings);
    sseSend(res, { type: "result", patch, usage: { backend: BACKEND, model: BACKEND === "codex" ? (CODEX_MODEL || "default") : CLI_MODEL, split: frameCount } });
  } catch (err) {
    sseSend(res, { type: "error", message: `結果の検証に失敗しました: ${err.message}` });
  }
  try { res.end(); } catch {}
}

function describeAnthropicError(err) {
  if (err && err.userFacing) {
    return err.message;
  }
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
  const body = JSON.stringify({
    model: MODEL,
    effort: EFFORT,
    mock: MOCK,
    backend: BACKEND,
    cliModel: CLI_MODEL,
    codexModel: CODEX_MODEL || "default", // §23.2
    redrawMaxCells: REDRAW_MAX_CELLS, // §22.6-3
    exportEnabled: !!EXPORT_ROOT,
    exportRoot: EXPORT_ROOT || null,
    version: APP_VERSION, // §24: フッター表示用
    commit: APP_COMMIT || null,
  });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// ---------------------------------------------------------------------------
// GET /api/profiles — public/profiles/*.json を列挙（§16.3）
// ---------------------------------------------------------------------------
async function handleApiProfiles(req, res) {
  const dir = path.join(PUBLIC_DIR, "profiles");
  const profiles = [];
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
        if (raw && typeof raw === "object" && typeof raw.name === "string") profiles.push(raw);
      } catch {}
    }
  } catch {}
  const body = JSON.stringify(profiles);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// ---------------------------------------------------------------------------
// POST /api/export — EXPORT_ROOT 配下へのゲームアセット直接書き出し（§16.4）
// ---------------------------------------------------------------------------
const MAX_EXPORT_BYTES = 50 * 1024 * 1024; // 書き出しは大きくなり得るため50MB
const MAX_EXPORT_FILES = 200;

function jsonError(res, code, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  return m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
}

// ---------------------------------------------------------------------------
// §22.10-2: POST /api/redraw-feedback — 描き直しのワンクリック評価をローカル保存
// ./redraw-feedback/<timestamp>-<verdict>.json（.gitignore 対象・EXPORT_ROOT 不要）
// 保存内容はプロンプト改善のための疑似リプレイに足る完全性（palette・キャンバスサイズ・
// ジョブごとの base/rough/result クロップグリッド+mask+cropRect）で受け取る。
// ---------------------------------------------------------------------------
async function handleRedrawFeedback(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch {
    jsonError(res, 413, "フィードバックのサイズが上限（5MB）を超えています");
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    jsonError(res, 400, "リクエストが不正です");
    return;
  }
  const verdict = body?.verdict === "good" ? "good" : body?.verdict === "bad" ? "bad" : null;
  if (!verdict || !Array.isArray(body.jobs) || body.jobs.length === 0) {
    jsonError(res, 400, "verdict（good/bad）と jobs が必要です");
    return;
  }
  const record = {
    timestamp: new Date().toISOString(),
    verdict,
    backend: String(body.backend || ""),
    model: String(body.model || ""),
    promptExtra: String(body.promptExtra || ""),
    comment: String(body.comment || ""),
    width: Number(body.width) || 0,
    height: Number(body.height) || 0,
    writtenCells: Number(body.writtenCells) || 0, // §22.11-3
    changedCells: Number(body.changedCells) || 0, // §22.11-3
    palette: Array.isArray(body.palette) ? body.palette.map(String) : [],
    warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
    jobs: body.jobs,
  };
  try {
    const dir = path.join(process.cwd(), "redraw-feedback");
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${ts}-${verdict}.json`;
    await fs.writeFile(path.join(dir, file), JSON.stringify(record, null, 1));
    const out = JSON.stringify({ ok: true, file });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(out) });
    res.end(out);
    console.log(`[redraw-feedback] ${file} (${verdict}, jobs=${record.jobs.length})`);
  } catch (err) {
    jsonError(res, 500, `フィードバックの保存に失敗しました: ${err.message}`);
  }
}

async function handleApiExport(req, res) {
  if (!EXPORT_ROOT) {
    jsonError(res, 403, "EXPORT_ROOT が設定されていないため、書き出しAPIは無効です。EXPORT_ROOT=<ゲームリポジトリのパス> で起動してください");
    return;
  }
  let raw;
  try {
    raw = await readBody(req, MAX_EXPORT_BYTES);
  } catch {
    jsonError(res, 413, "書き出しサイズが上限（50MB）を超えています");
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    jsonError(res, 400, "リクエストが不正です");
    return;
  }
  if (!body || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > MAX_EXPORT_FILES) {
    jsonError(res, 400, `files は 1〜${MAX_EXPORT_FILES} 件の配列で指定してください`);
    return;
  }

  const rootResolved = path.resolve(EXPORT_ROOT);
  const written = [];
  for (const f of body.files) {
    if (!f || typeof f.path !== "string" || typeof f.dataUrl !== "string") {
      jsonError(res, 400, "files の要素は {path, dataUrl} である必要があります");
      return;
    }
    const rel = f.path.replace(/\\/g, "/");
    // パストラバーサル・絶対パスの拒否
    if (
      rel.length === 0 || rel.length > 300 || rel.includes("\0") ||
      path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) ||
      rel.split("/").some((seg) => seg === "..")
    ) {
      jsonError(res, 400, `不正なパスです: ${f.path}（EXPORT_ROOT 配下の相対パスのみ許可）`);
      return;
    }
    const target = path.resolve(rootResolved, rel);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      jsonError(res, 400, `EXPORT_ROOT の外への書き込みは許可されていません: ${f.path}`);
      return;
    }
    const buf = decodeDataUrl(f.dataUrl);
    if (!buf) {
      jsonError(res, 400, `dataUrl の形式が不正です: ${f.path}`);
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buf);
    written.push(rel);
  }
  const out = JSON.stringify({ written, root: rootResolved });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(out) });
  res.end(out);
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
    } else if (req.method === "GET" && urlPath === "/api/profiles") {
      await handleApiProfiles(req, res);
    } else if (req.method === "POST" && urlPath === "/api/edit") {
      await handleApiEdit(req, res);
    } else if (req.method === "POST" && urlPath === "/api/export") {
      await handleApiExport(req, res);
    } else if (req.method === "POST" && urlPath === "/api/redraw-feedback") {
      await handleRedrawFeedback(req, res); // §22.10-2
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
  console.log(`AI Meglio server listening on http://localhost:${PORT} (MOCK=${MOCK ? "1" : "0"}, BACKEND=${BACKEND}, MODEL=${BACKEND === "cli" ? CLI_MODEL : MODEL}, EFFORT=${EFFORT})`);
});
