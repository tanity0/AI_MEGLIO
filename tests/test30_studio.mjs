// tests/test30_studio.mjs — §30 スタジオ経路の最小回帰
// 多フレーム分割・フレーム別つまみ・共有パレット一致・確定（conversionParams 往復）・単一画像の退行なし。
// 自動調整（§52）は OFF にして決定的に検証する。使い方: tests/run_suite.sh 経由。
import { launch, makeSheet, check, summary } from "./lib.mjs";

const dbg = (page) => page.evaluate(() => window.aiMeglioStudio.debug());
const settle = async (page) => {
  await page.waitForTimeout(500);
  await page.waitForFunction(() => /^出力:/.test(window.aiMeglioStudio.debug().status), null, { timeout: 60000 });
};
const setKnob = async (page, id, v) => {
  await page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event("input")); }, [id, v]);
  await settle(page);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { browser, page } = await launch({ autoTune: false });

// ---- 多フレーム: 2体のシートをフレームとして変換 ----
const sh = await makeSheet(page, { cell: 6, nColors: 14, sprites: [
  { cols: 20, rows: 32, speckTop: 0, speckLeft: 0, seed: 3 },
  { cols: 20, rows: 32, speckTop: 0, speckLeft: 0, seed: 9 },
] });
await page.evaluate((u) => window.aiMeglio.openStudio(u), sh.url);
await settle(page);
let d = await dbg(page);
check("30.1 2体を検出し多フレームとして変換（frameCount=2）", d.isMulti && d.frameCount === 2 && d.autoStats === null);
check("30.1 フレーム選択UI（サムネイル2枚）", (await page.locator("#studioFrameBar .studio-frame-thumb").count()) === 2);
check("30.1 フレーム別つまみ配列が全フレーム分", d.frameParams.length === 2);
check("30.2 全フレーム同一 W×H（framesPixels 長さ一致）", d.framesPixels.length === 2 && d.framesPixels[0].length === d.framesPixels[1].length && d.framesPixels[0].length === d.width * d.height);
const pal0 = d.palette.slice();
check("30.2 パレットは単一の共有配列で全フレームの index が範囲内", d.framesPixels.every((px) => px.every((v) => v < pal0.length)));

// ---- フレーム別つまみ: frame0 のオフセットだけ動かす → frame0 のみ変化 ----
// 共有パレットの再抽出で index 番号が変わり得るため、色（hex）に解決して比較する
const colorsOf = (dd, i) => dd.framesPixels[i].map((v) => dd.palette[v]);
const px1Before = colorsOf(d, 1), px0Before = colorsOf(d, 0);
await page.click("#studioOxPlus"); await settle(page);
await page.click("#studioOxPlus"); await settle(page);
d = await dbg(page);
check("30.1 フレーム0のオフセットだけ変更（frameParams 反映）", d.knobs.offsetDX !== 0 && d.frameParams[0].offsetDX === d.knobs.offsetDX && d.frameParams[1].offsetDX === 0, JSON.stringify(d.frameParams));
check("30.1 該当フレームの画素のみ更新（frame1 は不変）", !same(colorsOf(d, 0), px0Before) && same(colorsOf(d, 1), px1Before));
check("30.2 フレーム別つまみ変更後もパレット配列は単一共有", d.framesPixels.every((px) => px.every((v) => v < d.palette.length)));

// ---- フレーム切替でそのフレームの値が出る ----
await page.evaluate(() => window.aiMeglioStudio.switchFrame(1));
await settle(page);
d = await dbg(page);
check("30.1 フレーム切替でそのフレームのつまみ値を表示（offsetDX=0）", d.activeFrame === 1 && d.knobs.offsetDX === 0);
await setKnob(page, "studioEdgeProtect", 0.9);
d = await dbg(page);
check("30.1 frame1 のみ edgeProtect 変更", d.frameParams[1].edgeProtect === 0.9 && d.frameParams[0].edgeProtect !== 0.9);

// ---- 全フレームに適用 ----
await page.click("#studioApplyAllFramesBtn");
await settle(page);
d = await dbg(page);
check("30.3 「この設定を全フレームに適用」でフレーム別つまみが揃う", d.frameParams.every((pf) => pf.edgeProtect === 0.9 && pf.offsetDX === d.frameParams[1].offsetDX));

// ---- 色数変更 → 共有パレット再抽出 ----
const palLenBefore = d.palette.length;
await setKnob(page, "studioColors", 8);
d = await dbg(page);
check("30.2 colors 変更で共有パレット再抽出（色数減）", d.palette.length < palLenBefore && d.palette.length <= 9, `${palLenBefore} -> ${d.palette.length}`);
await setKnob(page, "studioColors", 64);

// ---- 確定: 全フレーム同一 W×H・単一パレット・conversionParams 往復 ----
await page.evaluate(() => window.aiMeglioStudio.switchFrame(0));
await settle(page);
await page.click("#studioConfirmBtn");
const proj = await page.evaluate(() => {
  const p = window.aiMeglio.store.state.project;
  return { w: p.width, h: p.height, n: p.frames.length, lens: p.frames.map((f) => f.pixels.length), pal: p.palette, maxIdx: p.frames.map((f) => Math.max(...f.pixels)), cp: p.conversionParams, src: !!p.sourceImage };
});
check("30.3 確定: 2フレーム・同一 W×H", proj.n === 2 && proj.lens[0] === proj.w * proj.h && proj.lens[1] === proj.w * proj.h);
check("30.3 確定: 単一パレット（全フレームの index が範囲内）", proj.maxIdx.every((m) => m < proj.pal.length));
check("30.3 conversionParams にフレーム別つまみ配列を保存", Array.isArray(proj.cp.frameParams) && proj.cp.frameParams.length === 2 && proj.cp.frameParams[1].edgeProtect === 0.9);
// 再変換で復元
await page.click("#reconvertBtn");
await settle(page);
d = await dbg(page);
check("30.3 再変換で frameParams を復元（自動調整は走らない）", d.frameParams.length === 2 && d.frameParams[1].edgeProtect === 0.9 && d.autoStats === null && d.isMulti);
await page.click("#studioCancelBtn");

// ---- 単一画像の退行なし ----
const sh1 = await makeSheet(page, { cell: 6, sprites: [{ cols: 20, rows: 32, seed: 5 }] });
await page.evaluate((u) => window.aiMeglio.openStudio(u), sh1.url);
await settle(page);
d = await dbg(page);
check("30.4 単一画像: frameCount=1・多フレームUIなし", !d.isMulti && d.frameCount === 1);
await page.click("#studioConfirmBtn");
const p1 = await page.evaluate(() => { const p = window.aiMeglio.store.state.project; return { n: p.frames.length, hasFp: !!p.conversionParams.frameParams }; });
check("30.4 単一画像: 1フレームでプロジェクト化・frameParams なし", p1.n === 1 && !p1.hasFp);

await browser.close();
process.exit(summary("test30_studio"));
