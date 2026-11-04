// tests/lib.mjs — テスト共通ヘルパー（run_suite.sh から起動される各 test*.mjs が import する）
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

export const BASE = process.env.BASE_URL || `http://127.0.0.1:${process.argv[2] || 3810}`;

let pass = 0, fail = 0;
export function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
}
export function summary(label) {
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

export async function launch({ autoTune = null } = {}) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept()); // confirm() は常に承認
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  // 自動調整チェックの初期状態（localStorage）。null=未設定（既定ON）
  if (autoTune !== null) {
    await page.addInitScript((v) => { try { localStorage.setItem("studioAutoTune", v ? "1" : "0"); } catch {} }, autoTune);
  }
  await page.goto(BASE + "/");
  await page.waitForFunction(() => window.aiMeglio && window.aiMeglioStudio);
  return { browser, page };
}

// 合成ドット絵スプライト（ページ内で生成）。cell px のセルを cols×rows、楕円マスク・セルごとに疑似乱数の6色。
// 外接矩形をずらす突起（上: speckTop px 高・左: speckLeft px 幅の 4px 太さ）を付け、
// bbox 起点が真のセル格子から (speckLeft, speckTop) px ずれる＝正解オフセット (+speckLeft, +speckTop)。
// sprites=[{cols,rows,speckTop,speckLeft,seed}] を横に並べる。戻り値 { url, truth:[...] }
export async function makeSheet(page, { cell, sprites, gap = 40, margin = 20, nColors = 6 }) {
  return page.evaluate(({ cell, sprites, gap, margin, nColors }) => {
    const COLORS = ["#d03030", "#30a040", "#3050d0", "#e0b020", "#a040c0", "#20b0b0", "#802020", "#206030", "#7090f0", "#f0e080", "#f080c0", "#80f0f0", "#505050", "#f09050"];
    const maxH = Math.max(...sprites.map((s) => s.rows * cell)) + 2 * margin;
    const totalW = sprites.reduce((a, s) => a + s.cols * cell + gap, margin * 2 - gap) + 0;
    const cv = document.createElement("canvas");
    cv.width = totalW; cv.height = maxH;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
    let x0 = margin;
    const truth = [];
    for (const sp of sprites) {
      let seed = sp.seed || 1;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const y0 = maxH - margin - sp.rows * cell; // 下端揃え
      const cells = [];
      for (let cy = 0; cy < sp.rows; cy++) {
        for (let cx = 0; cx < sp.cols; cx++) {
          const nx = (cx + 0.5) / sp.cols * 2 - 1, ny = (cy + 0.5) / sp.rows * 2 - 1;
          const inside = nx * nx + ny * ny <= 1;
          const ci = inside ? Math.floor(rnd() * nColors) : -1;
          cells.push(ci);
          if (ci >= 0) { ctx.fillStyle = COLORS[ci]; ctx.fillRect(x0 + cx * cell, y0 + cy * cell, cell, cell); }
        }
      }
      ctx.fillStyle = COLORS[0]; // 作品内の色と同じ（glow 除去で消えない）
      // 突起は作品内の色・4px 幅（フチ光彩除去で消えて bbox が自動的に揃ってしまわないように）
      if (sp.speckTop) ctx.fillRect(x0 + Math.floor(sp.cols / 2) * cell + 1, y0 - sp.speckTop, 4, sp.speckTop);
      if (sp.speckLeft) ctx.fillRect(x0 - sp.speckLeft, y0 + Math.floor(sp.rows / 2) * cell + 1, sp.speckLeft, 4);
      // 下端を speckTop px だけ削る（最下段セルが欠ける）→ bbox 高さ = rows*cell となりセルサイズ推定が正確に
      // cell 通りになる。ずれは純粋に「格子位相」(speckLeft, speckTop) だけに分離される。
      if (sp.speckTop) { ctx.fillStyle = "#ffffff"; ctx.fillRect(x0 - 8, y0 + sp.rows * cell - sp.speckTop, sp.cols * cell + 16, sp.speckTop); }
      truth.push({ x0, y0, cols: sp.cols, rows: sp.rows, cells, speckTop: sp.speckTop || 0, speckLeft: sp.speckLeft || 0 });
      x0 += sp.cols * cell + gap;
    }
    return { url: cv.toDataURL("image/png"), truth, colors: COLORS, cell };
  }, { cell, sprites, gap, margin, nColors });
}

// 出力ピクセル(palette index)が真のセル色と一致する割合（セル index の ±2 シフトを許す最良値）
export function matchFraction(out, truth, colors, width, height, pixels, palette) {
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const cols = colors.map(hex2rgb);
  let best = 0;
  for (let ky = -2; ky <= 2; ky++) {
    for (let kx = -2; kx <= 2; kx++) {
      let ok = 0, n = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pi = pixels[y * width + x];
          if (!pi) continue;
          const rgb = hex2rgb(palette[pi]);
          const tx = x + kx, ty = y + ky;
          n++;
          if (tx < 0 || ty < 0 || tx >= truth.cols || ty >= truth.rows) continue;
          const ci = truth.cells[ty * truth.cols + tx];
          if (ci < 0) continue;
          const d = Math.hypot(rgb[0] - cols[ci][0], rgb[1] - cols[ci][1], rgb[2] - cols[ci][2]);
          if (d < 60) ok++;
        }
      }
      if (n && ok / n > best) best = ok / n;
    }
  }
  return best;
}

export async function waitAuto(page, timeout = 120000) {
  await page.waitForFunction(() => {
    const d = window.aiMeglioStudio.debug();
    return !d.autoTuning && d.autoStats && d.autoStats.done;
  }, null, { timeout });
}
export async function waitIdle(page, ms = 600) {
  await page.waitForTimeout(ms);
  await page.waitForFunction(() => !window.aiMeglioStudio.debug().autoTuning);
  await page.waitForTimeout(ms);
}
