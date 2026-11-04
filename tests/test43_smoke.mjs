// tests/test43_smoke.mjs — §43/§44 ギャラリー自動調整経路（motionstudio.js）の最小回帰
// 共通エンジン化（§52.2）後も autoTuneRegion が動き、評価回数 ≤60・スコア改善・整列軸を返すことを確認する。
import { launch, makeSheet, check, summary } from "./lib.mjs";

const { browser, page } = await launch({ autoTune: false });
const sh = await makeSheet(page, { cell: 6, sprites: [{ cols: 20, rows: 32, speckTop: 2, speckLeft: 1, seed: 5 }] });
// ギャラリー（モーション候補スタジオ）を開く
await page.evaluate(() => { document.querySelector('[data-tab="motion"]')?.click(); });
await page.click("#mcOpenGalleryBtn");
await page.waitForFunction(() => { const m = document.getElementById("mcModal"); return m && !m.hidden && m.__mcTest && m.__mcTest.getSession(); }, null, { timeout: 15000 });
const r = await page.evaluate(async (url) => {
  const t = document.getElementById("mcModal").__mcTest;
  const a = await t.autoTuneRegion(url, {});
  const b = await t.autoTuneRegion(url, {}); // キャッシュ再利用
  return { a, b };
}, sh.url);
console.log(`  evals=${r.a.evals} score ${r.a.defaultScore.toFixed(3)} -> ${r.a.score.toFixed(3)} params=${JSON.stringify(r.a.params)}`);
check("43 autoTuneRegion が結果を返す（有限スコア）", Number.isFinite(r.a.score));
check("43/52.2 1コマ総変換回数 ≤ 60", r.a.evals <= 60 && r.a.evals > 0, String(r.a.evals));
check("43 スコアは既定値以下（悪化しない）", r.a.score <= r.a.defaultScore + 1e-9);
check("52.2 結果に整列軸（offsetDX/DY・sizeDelta）を含む", ["offsetDX", "offsetDY", "sizeDelta", "cellDelta"].every((k) => typeof r.a.params[k] === "number"));
check("43.2 同一リージョン再実行はキャッシュで再計算しない（evals=0・同一結果）", r.b.evals === 0 && r.b.score === r.a.score);
await browser.close();
process.exit(summary("test43_smoke"));
