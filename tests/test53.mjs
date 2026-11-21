// tests/test53.mjs — §53 背景透過の明示制御（透過済み画像の本体が勝手に抜かれない）の検証
import { launch, waitAuto, waitIdle, check, summary } from "./lib.mjs";

const dbg = (page) => page.evaluate(() => window.aiMeglioStudio.debug());

// 透過済み画像: 背景 alpha=0、本体（#e0e0e0 の縁セル＋内側に別色）が画像の下端・左右端に接する
async function makeTransparent(page) {
  return page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 160; cv.height = 200;
    const ctx = cv.getContext("2d");
    const C = ["#d03030", "#3050d0", "#30a040", "#e0b020"];
    for (let cy = 0; cy < 20; cy++) for (let cx = 0; cx < 20; cx++) {
      if (cy < 6) continue; // 上部 30% は透明
      const edge = cx === 0 || cx === 19 || cy === 19;
      ctx.fillStyle = edge ? "#e0e0e0" : C[(cx * 7 + cy * 3) % 4];
      ctx.fillRect(cx * 8, cy * 8, 8, 8);
    }
    return cv.toDataURL("image/png");
  });
}
// 不透明背景画像: 白背景＋中央キャラ（外周に接しない）
async function makeOpaque(page) {
  return page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 160; cv.height = 200;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 160, 200);
    const C = ["#d03030", "#3050d0", "#30a040", "#e0b020"];
    for (let cy = 3; cy < 22; cy++) for (let cx = 3; cx < 17; cx++) {
      ctx.fillStyle = C[(cx * 7 + cy * 3) % 4]; ctx.fillRect(cx * 8, cy * 8, 8, 8);
    }
    return cv.toDataURL("image/png");
  });
}
const srcOpaque = (page, url) => page.evaluate(async (u) => {
  const img = new Image(); await new Promise((r) => { img.onload = r; img.src = u; });
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) n++;
  return n;
}, url);

// ---------------- 1) 単一画像（autoTune OFF）: 初期判定・本体無損失・切替・disabled ----------------
{
  const { browser, page } = await launch({ autoTune: false });
  const tUrl = await makeTransparent(page);
  const total = await srcOpaque(page, tUrl);
  await page.evaluate((u) => window.aiMeglio.openStudio(u), tUrl);
  await waitIdle(page, 500);
  let d = await dbg(page);
  check("53.1 透過済み → 初期「なし」", d.knobs.bgMode === "none" && (await page.inputValue("#studioBgMode")) === "none");
  check("53.1 本体画素が1つも失われない（不透明画素数が元と一致）", d.bgOpaque === total, `${d.bgOpaque} vs ${total}`);
  check("53.1 「なし」で bg/glow つまみ disabled", await page.evaluate(() => document.getElementById("studioBgThreshold").disabled && document.getElementById("studioGlowWidth").disabled));
  await page.selectOption("#studioBgMode", "auto");
  await waitIdle(page, 500);
  d = await dbg(page);
  check("53.1 「自動」に切替で従来動作（縁の本体が除去される）", d.knobs.bgMode === "auto" && d.bgOpaque < total, `${d.bgOpaque} vs ${total}`);
  check("53.1 「自動」で bg/glow つまみ有効", await page.evaluate(() => !document.getElementById("studioBgThreshold").disabled && !document.getElementById("studioGlowWidth").disabled));
  await page.selectOption("#studioBgMode", "none");
  await waitIdle(page, 500);
  d = await dbg(page);
  check("53.1 「なし」へ戻すと再び無損失", d.bgOpaque === total);

  // 不透明背景 → 初期「自動」・従来どおり除去
  const oUrl = await makeOpaque(page);
  await page.evaluate((u) => window.aiMeglio.openStudio(u), oUrl);
  await waitIdle(page, 500);
  d = await dbg(page);
  const oTotal = await srcOpaque(page, oUrl);
  check("53.1 不透明背景 → 初期「自動」", d.knobs.bgMode === "auto" && (await page.inputValue("#studioBgMode")) === "auto");
  check("53.4 不透明背景は従来どおり背景が除去される（キャラ 14x19 セル分のみ残る）", d.bgOpaque === 14 * 19 * 64 && d.bgOpaque < oTotal, `${d.bgOpaque}`);

  // conversionParams 往復
  await page.evaluate((u) => window.aiMeglio.openStudio(u), tUrl);
  await waitIdle(page, 400);
  await page.evaluate(() => document.getElementById("studioConfirmBtn").click());
  let saved = await page.evaluate(() => window.aiMeglio.store.state.project.conversionParams);
  check("53.1 conversionParams に bgMode=none を保存", saved.bgMode === "none");
  const srcImg = await page.evaluate(() => window.aiMeglio.store.state.project.sourceImage);
  await page.evaluate(([u, p]) => window.aiMeglio.openStudio(u, p), [srcImg, saved]);
  await waitIdle(page, 400);
  d = await dbg(page);
  check("53.1 再変換で bgMode=none を復元", d.knobs.bgMode === "none" && d.bgOpaque === total);
  // ユーザーが「自動」を選んで確定 → 復元は検出値（none）ではなく保存値（auto）
  await page.selectOption("#studioBgMode", "auto");
  await waitIdle(page, 400);
  await page.evaluate(() => document.getElementById("studioConfirmBtn").click());
  saved = await page.evaluate(() => window.aiMeglio.store.state.project.conversionParams);
  check("53.1 bgMode=auto も保存される", saved.bgMode === "auto");
  await page.evaluate(([u, p]) => window.aiMeglio.openStudio(u, p), [srcImg, saved]);
  await waitIdle(page, 400);
  d = await dbg(page);
  check("53.1 保存値 auto を尊重して復元（自動判定で上書きしない）", d.knobs.bgMode === "auto" && d.bgOpaque < total);
  // 旧データ（bgMode 無し）は従来どおり auto
  const { bgMode: _omit, ...legacy } = saved;
  await page.evaluate(([u, p]) => window.aiMeglio.openStudio(u, p), [srcImg, legacy]);
  await waitIdle(page, 400);
  check("53.4 bgMode の無い旧 conversionParams は従来どおり auto", (await dbg(page)).knobs.bgMode === "auto");
  await browser.close();
}

// ---------------- 2) 自動調整（ON）が bg/glow を探索しない ----------------
{
  const { browser, page } = await launch({ autoTune: true });
  const tUrl = await makeTransparent(page);
  await page.evaluate((u) => window.aiMeglio.openStudio(u), tUrl);
  await waitAuto(page);
  let d = await dbg(page);
  const fNone = d.autoStats.frames[0];
  check("53.1 自動調整: 「なし」では bg/glow 軸を探索しない（bgThreshold=48・glowWidth=0 のまま）", d.knobs.bgMode === "none" && d.knobs.bgThreshold === 48 && d.knobs.glowWidth === 0 && fNone.params.bgThreshold === 48 && fNone.params.glowWidth === 0);
  check("53.1 自動調整: 「なし」の変換回数に bg/glow 一段目(18)が含まれない（≤ 1+9+20）", fNone.evals <= 30 && fNone.evals > 0, String(fNone.evals));
  check("53.1 自動調整後も本体が無損失", d.bgOpaque === await srcOpaque(page, tUrl));
  // 「自動」へ切替えて全フレーム再探索 → bg/glow も探索される（変換回数が増える）
  await page.selectOption("#studioBgMode", "auto");
  await waitIdle(page, 400);
  await page.click("#studioAutoTuneBtn");
  await waitAuto(page);
  d = await dbg(page);
  const fAuto = d.autoStats.frames[0];
  check("53.1 自動調整: 「自動」では従来どおり bg/glow も探索（変換回数が増える）", fAuto.evals > fNone.evals && fAuto.evals > 30, `${fAuto.evals} vs ${fNone.evals}`);
  await browser.close();
}

// ---------------- 3) ギャラリー取り込み経路 ----------------
async function gallery(page, url, autoToggle) {
  await page.evaluate((v) => localStorage.setItem("mcAutoTune", v), autoToggle ? "1" : "0");
  await page.evaluate(() => { document.querySelector('[data-tab="motion"]')?.click(); });
  await page.click("#mcOpenGalleryBtn");
  await page.waitForFunction(() => { const m = document.getElementById("mcModal"); return m && !m.hidden && m.__mcTest && m.__mcTest.getSession(); }, null, { timeout: 15000 });
  await page.evaluate((v) => { const t = document.getElementById("mcAutoTuneToggle"); t.checked = v; }, autoToggle);
  const buf = Buffer.from(url.split(",")[1], "base64");
  await page.setInputFiles("#mcImageInput", { name: "t.png", mimeType: "image/png", buffer: buf });
  await page.waitForFunction(() => !document.getElementById("mcImportPreview").hidden, null, { timeout: 15000 });
}
{
  const { browser, page } = await launch({ autoTune: false });
  const tUrl = await makeTransparent(page);
  await gallery(page, tUrl, true);
  check("53.1 ギャラリー取り込みプレビュー: 透過済み → 初期「なし」", (await page.inputValue("#mcImportBgMode")) === "none");
  check("53.1 ギャラリー取り込みプレビュー: bg/glow つまみ disabled", await page.evaluate(() => document.getElementById("mcImportBg").disabled && document.getElementById("mcImportGlow").disabled));
  const nonEmpty = (px) => px.filter((v) => v > 0).length;
  let r = await page.evaluate(() => { const s = document.getElementById("mcModal").__mcTest.getSession(); return s.pool.length; });
  await page.click("#mcImportOkBtn"); // 自動調整ON で取り込み確定
  await page.waitForFunction(() => document.getElementById("mcImportPreview").hidden, null, { timeout: 60000 });
  const cand = await page.evaluate(() => {
    const s = document.getElementById("mcModal").__mcTest.getSession();
    const c = s.pool[s.pool.length - 1];
    return { convParams: c.convParams, pixels: Array.from(c.srcPixels), n: s.pool.length };
  });
  check("53.1 候補の convParams.bgMode=none", cand.convParams.bgMode === "none");
  check("53.1 ギャラリー自動調整が bg/glow を探索しない", cand.convParams.bgThreshold === 48 && cand.convParams.glowWidth === 0);
  check("53.1 ギャラリー候補に本体が残っている", nonEmpty(cand.pixels) > 0);
  // 部位取り込み/再変換経路（reconvertFromRegion）: 保存された bgMode で再変換される
  const cmp = await page.evaluate(async () => {
    const t = document.getElementById("mcModal").__mcTest;
    const s = t.getSession(); const c = s.pool[s.pool.length - 1];
    const sc = (bgMode) => t.scoreRegionParams(c.srcRegion, { bgMode });
    return { none: await sc("none"), auto: await sc("auto") };
  });
  check("53.1 スコア関数/変換が bgMode を尊重（none と auto で結果が異なる）", Number.isFinite(cmp.none) && cmp.none !== cmp.auto, JSON.stringify(cmp));
  await browser.close();
}
{
  const { browser, page } = await launch({ autoTune: false });
  const tUrl = await makeTransparent(page);
  await gallery(page, tUrl, false);
  const before = await page.evaluate(() => Array.from(document.getElementById("mcImportGrid").querySelectorAll("img")).map((i) => i.src));
  await page.selectOption("#mcImportBgMode", "auto");
  await page.waitForFunction((b) => { const i = Array.from(document.getElementById("mcImportGrid").querySelectorAll("img")).map((x) => x.src); return i.join() !== b.join(); }, before, { timeout: 15000 });
  check("53.1 取り込みプレビューで「自動」へ切替 → 再変換（サムネイル更新）・つまみ有効", await page.evaluate(() => !document.getElementById("mcImportBg").disabled));
  await page.click("#mcImportOkBtn");
  await page.waitForFunction(() => document.getElementById("mcImportPreview").hidden, null, { timeout: 30000 });
  const bm = await page.evaluate(() => { const s = document.getElementById("mcModal").__mcTest.getSession(); return s.pool[s.pool.length - 1].convParams.bgMode; });
  check("53.1 切替後に取り込むと候補の convParams.bgMode=auto", bm === "auto");
  await browser.close();
}
{
  const { browser, page } = await launch({ autoTune: false });
  const oUrl = await makeOpaque(page);
  await gallery(page, oUrl, false);
  check("53.1 ギャラリー取り込み: 不透明背景 → 初期「自動」・つまみ有効", (await page.inputValue("#mcImportBgMode")) === "auto" && await page.evaluate(() => !document.getElementById("mcImportBg").disabled));
  await browser.close();
}
process.exit(summary("test53"));
