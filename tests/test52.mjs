// tests/test52.mjs — §52 変換スタジオの全フレーム自動最適化の検証
// 合成画像（既知の格子位相でずらしたドット絵）を変換スタジオに開き、自動調整が正解近傍へ収束することを数値で確認する。
// 使い方: tests/run_suite.sh 経由（サーバー起動 → node tests/test52.mjs <port>）。
import { launch, makeSheet, matchFraction, waitAuto, waitIdle, check, summary } from "./lib.mjs";

const CELL = 6;
const phaseErr = (v, truth, s = CELL) => ((((v - truth) % s) + s * 1.5) % s) - s / 2; // 格子位相の誤差（周期 s）

const dbg = (page) => page.evaluate(() => window.aiMeglioStudio.debug());

// ---------------------------------------------------------------------------
// 1) 単一画像: 既定ON・初回変換後に自動実行 → 正解オフセット近傍に収束・スコア改善・≤60回・進捗表示
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch(); // localStorage 未設定 = 既定ON
  const sh = await makeSheet(page, { cell: CELL, sprites: [{ cols: 40, rows: 64, speckTop: 2, speckLeft: 1, seed: 7 }] });
  check("52.1 チェックは既定ON", await page.evaluate(() => document.getElementById("studioAutoTuneCheck").checked));
  await page.evaluate(() => window.aiMeglioStudio.setTuneDelay(6));
  await page.evaluate((u) => window.aiMeglio.openStudio(u), sh.url);
  // 進捗表示を収集
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const d = await dbg(page);
    const m = /自動調整中… フレーム (\d+)\/(\d+)/.exec(d.status);
    if (m) seen.add(m[0]);
    if (!d.autoTuning && d.autoStats && d.autoStats.done) break;
    await page.waitForTimeout(30);
  }
  await waitAuto(page);
  const d = await dbg(page);
  const f = d.autoStats.frames[0];
  check("52.1 進捗表示（自動調整中… フレーム 1/1）", seen.has("自動調整中… フレーム 1/1"), JSON.stringify([...seen]));
  check("52.1 自動調整が適用された", f.applied === true);
  const ex = phaseErr(d.knobs.offsetDX, 1), ey = phaseErr(d.knobs.offsetDY, 2);
  console.log(`  offset=(${d.knobs.offsetDX}, ${d.knobs.offsetDY}) size=${d.knobs.sizeDelta} 誤差=(${ex.toFixed(2)}, ${ey.toFixed(2)}) score ${f.defaultScore.toFixed(3)} -> ${f.score.toFixed(3)} evals=${f.evals}`);
  check("52.2 offsetDX が正解(+1)近傍に収束（誤差 ≤ s/8）", Math.abs(ex) <= CELL / 8 + 0.01, String(ex));
  check("52.2 offsetDY が正解(+2)近傍に収束（誤差 ≤ s/4）", Math.abs(ey) <= CELL / 4 + 0.01, String(ey));
  check("52.2 スコアが初期値より改善", f.score < f.defaultScore - 0.05, `${f.defaultScore} -> ${f.score}`);
  check("52.2 1フレーム総変換回数 ≤ 60", f.evals <= 60 && f.evals > 20, String(f.evals));
  const mf = matchFraction(null, sh.truth[0], sh.colors, d.width, d.height, d.framesPixels[0], d.palette);
  check("52.2 変換結果が真のセル色と一致（≥0.95）", mf >= 0.95, String(mf));
  check("52.1 完了後に結果が status に反映", /自動調整: 1\/1フレーム/.test(d.status), d.status);
  await browser.close();
}

// ---------------------------------------------------------------------------
// 2) 自動OFF: 従来動作（走らない・つまみは既定値のまま）+ localStorage 保持
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch({ autoTune: false });
  const sh = await makeSheet(page, { cell: CELL, sprites: [{ cols: 40, rows: 64, speckTop: 2, speckLeft: 1, seed: 7 }] });
  check("52.1 OFF 保存値でチェック外れ", await page.evaluate(() => !document.getElementById("studioAutoTuneCheck").checked));
  await page.evaluate((u) => window.aiMeglio.openStudio(u), sh.url);
  await waitIdle(page, 800);
  const d = await dbg(page);
  check("52.1 OFF: 自動調整は走らない", d.autoStats === null && d.knobs.offsetDX === 0 && d.knobs.offsetDY === 0 && d.knobs.bgThreshold === 48);
  // チェックを切り替えると localStorage に保持
  await page.evaluate(() => { const c = document.getElementById("studioAutoTuneCheck"); c.checked = true; c.dispatchEvent(new Event("change")); });
  check("52.1 チェック操作が localStorage に保存", await page.evaluate(() => localStorage.getItem("studioAutoTune")) === "1");
  // 「全フレーム再探索」ボタン（通常モード）= 明示実行
  check("52.1 ボタンは「全フレーム再探索」", (await page.textContent("#studioAutoTuneBtn")).includes("全フレーム再探索"));
  await page.click("#studioAutoTuneBtn");
  await waitAuto(page);
  const d2 = await dbg(page);
  check("52.1 ボタンで明示実行すると探索される", d2.autoStats.frames[0].applied && (d2.knobs.offsetDX !== 0 || d2.knobs.offsetDY !== 0));
  await browser.close();
}

// ---------------------------------------------------------------------------
// 3) conversionParams 復元（再変換）では自動調整を走らせない
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch({ autoTune: true });
  const sh = await makeSheet(page, { cell: CELL, sprites: [{ cols: 40, rows: 64, speckTop: 2, speckLeft: 1, seed: 7 }] });
  await page.evaluate((u) => window.aiMeglio.openStudio(u), sh.url);
  await waitAuto(page);
  const tuned = (await dbg(page)).knobs;
  await page.evaluate(() => document.getElementById("studioConfirmBtn").click());
  const saved = await page.evaluate(() => window.aiMeglio.store.state.project.conversionParams);
  check("52.1 確定後の conversionParams に自動調整値が保存", saved && saved.offsetDY === tuned.offsetDY && saved.bgThreshold === tuned.bgThreshold);
  const src = await page.evaluate(() => window.aiMeglio.store.state.project.sourceImage);
  await page.evaluate(({ src, saved }) => window.aiMeglio.openStudio(src, saved), { src, saved });
  await waitIdle(page, 1200);
  const d = await dbg(page);
  check("52.1 復元オープンでは自動調整を走らせない（保存設定を尊重）", d.autoStats === null && d.knobs.offsetDY === tuned.offsetDY && d.knobs.bgThreshold === tuned.bgThreshold, JSON.stringify(d.autoStats));
  // 再変換ボタン経由でも同様
  await page.evaluate(() => document.getElementById("studioCancelBtn").click());
  await page.click("#reconvertBtn");
  await waitIdle(page, 1200);
  const d2 = await dbg(page);
  check("52.1 再変換ボタン経由でも不実行", d2.autoStats === null && d2.knobs.offsetDY === tuned.offsetDY);
  await browser.close();
}

// ---------------------------------------------------------------------------
// 4) 多フレーム: 各フレーム収束・touched 不上書き・ボタンで touched 含め再探索
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch({ autoTune: false });
  const sh = await makeSheet(page, { cell: CELL, sprites: [
    { cols: 30, rows: 64, speckTop: 2, speckLeft: 1, seed: 11 },
    { cols: 30, rows: 64, speckTop: 2, speckLeft: 1, seed: 23 },
  ] });
  await page.evaluate((u) => window.aiMeglio.openStudio(u), sh.url);
  await waitIdle(page, 800);
  let d = await dbg(page);
  check("52 多フレーム: 2フレーム検出", d.isMulti && d.frameCount === 2);
  // フレーム2(index 1)を手動で動かす → touched
  await page.evaluate(() => window.aiMeglioStudio.switchFrame(1));
  await page.waitForTimeout(400);
  await page.click("#studioOxPlus");
  await page.waitForTimeout(400);
  d = await dbg(page);
  const before1 = { ...d.frameParams[1] };
  check("52.1 手動操作したフレームに touched フラグ", d.frameParams[1].touched === true && !d.frameParams[0].touched, JSON.stringify(d.frameParams));
  // 自動調整（touched を除く）
  await page.evaluate(() => window.aiMeglioStudio.runAutoTune({}));
  d = await dbg(page);
  const st = d.autoStats;
  check("52.1 touched フレームは不上書き（skipped=touched・値不変）",
    st.frames[1].skipped === "touched" && ["bgThreshold", "glowWidth", "edgeProtect", "satProtect", "offsetDX", "offsetDY"].every((k) => d.frameParams[1][k] === before1[k]), JSON.stringify(st.frames[1]));
  check("52.1 未touchedフレームは調整された", st.frames[0].applied === true && d.frameParams[0].touched === false);
  const f0 = st.frames[0];
  const ex = phaseErr(d.frameParams[0].offsetDX, 3.5), ey = phaseErr(d.frameParams[0].offsetDY, 2);
  console.log(`  frame0 offset=(${d.frameParams[0].offsetDX}, ${d.frameParams[0].offsetDY}) 誤差=(${ex.toFixed(2)}, ${ey.toFixed(2)}) score ${f0.defaultScore.toFixed(3)} -> ${f0.score.toFixed(3)} evals=${f0.evals}`);
  check("52.2 多フレーム: frame0 が正解格子位相に収束（誤差 ≤ s/4）", Math.abs(ex) <= CELL / 4 + 0.01 && Math.abs(ey) <= CELL / 4 + 0.01);
  check("52.2 多フレーム: スコア改善・≤60回", f0.score < f0.defaultScore - 0.03 && f0.evals <= 60, `${f0.defaultScore} -> ${f0.score} evals=${f0.evals}`);
  // 共有パレットの維持（全フレーム同一パレット = 単一 palette）
  check("52 多フレーム: 共有パレット維持", Array.isArray(d.palette) && d.frameCount === 2);
  // ボタン = touched 含め全フレーム再探索
  await page.click("#studioAutoTuneBtn");
  await waitAuto(page);
  d = await dbg(page);
  check("52.1 ボタンは touched 含め再探索（frame1 も適用され touched 解除）", d.autoStats.frames[1].applied === true && d.frameParams[1].touched === false);
  const f1 = d.autoStats.frames[1];
  check("52.2 frame1 もスコア改善・≤60回", f1.score <= f1.defaultScore && f1.evals <= 60, `${f1.defaultScore} -> ${f1.score} evals=${f1.evals}`);
  await browser.close();
}

// ---------------------------------------------------------------------------
// 5) 自動調整中の手動操作で該当フレームを中断（手動優先）・他フレームは継続
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch({ autoTune: true });
  const sh = await makeSheet(page, { cell: CELL, sprites: [
    { cols: 30, rows: 64, speckTop: 2, speckLeft: 1, seed: 11 },
    { cols: 30, rows: 64, speckTop: 2, speckLeft: 1, seed: 23 },
  ] });
  await page.evaluate(() => window.aiMeglioStudio.setTuneDelay(40));
  await page.evaluate((u) => window.aiMeglio.openStudio(u), sh.url);
  await page.waitForFunction(() => /自動調整中… フレーム 1\/2/.test(window.aiMeglioStudio.debug().status), null, { timeout: 30000 });
  check("52.1 実行中は autoTuning=true", (await dbg(page)).autoTuning === true);
  // 実行中にフレーム1（アクティブ=index0）の bgThreshold を手動操作
  await page.evaluate(() => { const el = document.getElementById("studioBgThreshold"); el.value = "77"; el.dispatchEvent(new Event("input")); });
  await page.waitForFunction(() => { const d = window.aiMeglioStudio.debug(); return !d.autoTuning && d.autoStats && d.autoStats.done; }, null, { timeout: 120000 });
  const d = await dbg(page);
  check("52.1 手動操作したフレームの自動調整は中断・手動値を維持", d.autoStats.frames[0].skipped === "aborted" && d.frameParams[0].bgThreshold === 77 && d.frameParams[0].touched === true, JSON.stringify(d.autoStats.frames[0]));
  check("52.1 他フレームは継続して調整", d.autoStats.frames[1].applied === true && d.autoStats.frames[1].evals <= 60);
  await browser.close();
}

// ---------------------------------------------------------------------------
// 6) 共通エンジン（autotune.js）の単体: 上限 ≤60・収束・中断・キャッシュ
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch({ autoTune: false });
  const r = await page.evaluate(async () => {
    const { searchTune, TUNE_MAX_TOTAL } = await import("/autotune.js");
    // 擬似スコア: 既知の最適点 (bg=64, glow=1, edge=0.3, sat=0.5, dx=3, dy=-1.5, size=0.5) までの距離
    const fn = (p) => ({ score: Math.abs(p.bgThreshold - 64) / 100 + Math.abs(p.glowWidth - 1) * 0.05 + Math.abs(p.edgeProtect - 0.3) * 0.2 + Math.abs(p.satProtect - 0.5) * 0.1 + Math.abs(p.offsetDX - 3) * 0.04 + Math.abs(p.offsetDY + 1.5) * 0.04 + Math.abs(p.sizeDelta - 0.5) * 0.1, cs: 12 });
    const cache = new Map();
    const a = await searchTune({ evalFn: fn, cache });
    const calls = [];
    const b = await searchTune({ evalFn: (p) => { calls.push(1); return fn(p); }, cache }); // 同一キャッシュ → 再計算なし
    const flag = { aborted: false };
    let n = 0;
    const c = await searchTune({ evalFn: (p) => { if (++n === 5) flag.aborted = true; return fn(p); }, flag, cacheTag: "x" });
    const e = await searchTune({ evalFn: fn, align: false, cacheTag: "y" });
    return { a, bCalls: calls.length, c, e, max: TUNE_MAX_TOTAL };
  });
  console.log(`  合成関数: evals=${r.a.evals} params=${JSON.stringify(r.a.params)} score=${r.a.score.toFixed(3)} (初期 ${r.a.defaultScore.toFixed(3)})`);
  check("52.2 エンジン: 総変換回数 ≤ 60", r.a.evals <= r.max && r.max === 60, String(r.a.evals));
  check("52.2 エンジン: 整列軸（offset/size）が最適側へ動く", r.a.params.offsetDX > 0 && r.a.params.offsetDY < 0 && r.a.score < r.a.defaultScore);
  check("52.2 エンジン: キャッシュで再計算なし", r.bCalls === 0);
  check("52.2 エンジン: 中断で打ち切り（aborted=true・5回前後）", r.c.aborted === true && r.c.evals <= 6, String(r.c.evals));
  check("52.2 エンジン: align:false は一段目のみ（≤40・整列値0）", r.e.evals <= 40 && r.e.params.offsetDX === 0 && r.e.params.sizeDelta === 0, String(r.e.evals));
  await browser.close();
}

// ---------------------------------------------------------------------------
// 7) 候補モード（§44）: 従来どおり単一「自動調整」・開いたとき自動実行しない・結果に整列軸も反映
// ---------------------------------------------------------------------------
{
  const { browser, page } = await launch({ autoTune: true });
  const sh = await makeSheet(page, { cell: CELL, sprites: [{ cols: 20, rows: 32, speckTop: 2, speckLeft: 1, seed: 5 }] });
  await page.evaluate(async (url) => {
    const m = await import("/studio.js");
    window.__applied = null;
    await m.openStudioForCandidate(url, {
      convParams: {},
      autoTune: async () => ({ params: { bgThreshold: 40, glowWidth: 0, edgeProtect: 0.3, satProtect: 0.5, offsetDX: 1.5, offsetDY: 0.75, sizeDelta: 0.25 }, score: 0.2, defaultScore: 0.5, evals: 50 }),
      onApply: (conv, params) => { window.__applied = params; },
    });
  }, sh.url);
  await waitIdle(page, 800);
  let d = await dbg(page);
  check("52.2 候補モード: 開いても自動実行しない", d.candidateMode && d.autoStats === null);
  check("52.1 候補モード: ボタンは従来の「自動調整」・チェック欄は非表示",
    (await page.textContent("#studioAutoTuneBtn")).trim() === "自動調整" && await page.evaluate(() => document.getElementById("studioAutoTuneWrap").hidden));
  await page.click("#studioAutoTuneBtn");
  await page.waitForFunction(() => window.aiMeglioStudio.debug().knobs.offsetDX === 1.5);
  d = await dbg(page);
  check("52.2 候補モード: 探索結果（整列軸含む）がつまみへ反映", d.knobs.offsetDX === 1.5 && d.knobs.offsetDY === 0.75 && d.knobs.sizeDelta === 0.25 && d.knobs.bgThreshold === 40);
  await page.evaluate(() => document.getElementById("studioConfirmBtn").click());
  const ap = await page.evaluate(() => window.__applied);
  check("52.2 候補モード: 確定で整列値を含む params が返る", ap && ap.offsetDX === 1.5 && ap.sizeDelta === 0.25);
  await browser.close();
}

process.exit(summary("test52"));
