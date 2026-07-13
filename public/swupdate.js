// swupdate.js — §50.7: Web版が更新されない問題の修正（SW更新チェックの実装漏れ・追補）
// 根因: sw.js には AI_MEGLIO_CHECK_VERSION メッセージフック（version.json を再確認して
// キャッシュを切り替える）が実装済みだったが、ページ側から一度も呼んでいなかった。
// そのため SW インストール時点のキャッシュが恒久的に配信され続けていた。
// このモジュールはページロード毎・可視性復帰時に新バージョンの有無を確認し、あれば
// 「新しいバージョンがあります」バナー（§50.1 再開バナーと同系の控えめなUI）で案内する。
// 自動リロードはしない（編集中データ保護。自動保存(§50.1)があるとはいえ安全側に倒す）。
//
// サーバー版/静的版どちらでも動作する（version.json はどちらの配信でも同じ相対パスで存在する）。

// 可視性復帰時の再チェックの間隔（数分に1回で十分。頻繁なポーリングは不要）。
const RECHECK_THROTTLE_MS = 3 * 60 * 1000;

// SW のキャッシュ命名規則（sw.js の CACHE_PREFIX と同じ値。sw.js側の定数は SW スコープに
// 閉じているためここでは文字列として複製する）。
const CACHE_PREFIX = "ai-meglio-static-";

// 「現在ロード中のバージョン」を取得する。SW が制御中のページでは fetch("version.json") は
// SW の cache-first 戦略を経由するため、ネットワーク越しの最新値ではなく「このページを構成する
// 資産一式がインストールされた時点のバージョン」を返す（＝比較の基準として正しい）。
// SW未制御（初回インストール直後の一瞬・非対応環境）ではネットワーク直取得になるが、その場合は
// 直後の資産もその時点の最新版なので誤検知はしない。
async function getLoadedVersion() {
  try {
    const res = await fetch("version.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return typeof data.version === "string" && data.version ? data.version : null;
  } catch {
    return null;
  }
}

// AI_MEGLIO_CHECK_VERSION を送信し、SW側の現在有効なキャッシュ名を尋ねる。
// SW はこの要求を受けて version.json を（no-storeで）再確認し、変わっていれば新キャッシュへ
// 切替えてから応答する（sw.js 側の既存フック）。
function askServiceWorkerVersion(controller) {
  return new Promise((resolve) => {
    try {
      const mc = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 8000);
      mc.port1.onmessage = (ev) => {
        clearTimeout(timer);
        resolve((ev.data && ev.data.cacheName) || null);
      };
      controller.postMessage({ type: "AI_MEGLIO_CHECK_VERSION" }, [mc.port2]);
    } catch {
      resolve(null);
    }
  });
}

function showUpdateBanner() {
  const banner = document.getElementById("updateBanner");
  if (!banner) return;
  banner.hidden = false;
}

export function initSwUpdate() {
  if (!("serviceWorker" in navigator)) return; // 非対応ブラウザ・file:// 等は何もしない

  const reloadBtn = document.getElementById("updateBannerReloadBtn");
  if (reloadBtn) reloadBtn.addEventListener("click", () => location.reload());

  let checking = false;
  let lastCheckAt = 0;

  async function runCheck() {
    if (checking) return;
    checking = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      // §50.7-2: SW本体（sw.jsのバイト内容）の更新チェックもロード毎に行う。
      // sw.js が変わっていればブラウザが新しい install/activate サイクルを開始する。
      reg.update().catch(() => {});

      const controller = navigator.serviceWorker.controller;
      if (!controller) return; // 初回インストール直後などまだこのページを制御していない

      // 順序が重要: 先に「現在ロード中のバージョン」を確定してから AI_MEGLIO_CHECK_VERSION を
      // 送る。逆順にすると、その要求がSW側でキャッシュを切替える副作用を起こした後に
      // version.json を取得してしまい、切替わった後の新バージョンを「現在ロード中」と
      // 誤認して更新を見逃す（レース）。
      const loadedVersion = await getLoadedVersion();
      const cacheName = await askServiceWorkerVersion(controller);
      if (!loadedVersion || !cacheName) return;

      const expected = CACHE_PREFIX + loadedVersion;
      if (cacheName !== expected) showUpdateBanner();
    } finally {
      checking = false;
      lastCheckAt = Date.now();
    }
  }

  // §50.7-1: ページロード毎（SW ready 後）にチェック。
  runCheck();

  // §50.7-3: 可視性復帰時（非表示→表示）にも再チェック。頻度は数分に1回のスロットル。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheckAt < RECHECK_THROTTLE_MS) return;
    runCheck();
  });

  // E2Eテスト用フック（UIには影響しない）。
  window.aiMeglioSwUpdate = {
    checkNow: runCheck, // スロットルを無視して即チェック
    resetThrottleForTest: () => { lastCheckAt = 0; }, // 可視性復帰チェックのスロットルを解除
  };
}
