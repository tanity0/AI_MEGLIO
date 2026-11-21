// sw.js — §50.2 PWA化: Service Worker（§50.7 でページ側の呼び出し漏れを修正・追補）
// サブパス配信（/AI_MEGLIO/ 等）前提のため、資産パスは self.registration.scope からの
// 相対URLとして解決する（絶対パス "/..." は書かない）。
// §50.7: このファイル自体のバイト変更は、既存ユーザーの古いSWインストールを
// registration.update() で検知させ再インストールを起こすためのもの（swupdate.js 参照）。
//
// 戦略:
//   - 静的資産: cache-first（無ければネットワーク取得→キャッシュへ追加）
//   - /api/ を含むURLは絶対にキャッシュしない・fetch イベントにも介入しない（素通し）
//     ＝ サーバー版の SSE（/api/edit 等）やポーリング（/api/live-project 等）を壊さない
//   - キャッシュ名は version.json の値から決定（ai-meglio-static-v<version>）。
//     version.json が変わればキャッシュも切り替わり、旧キャッシュは削除される。
const CACHE_PREFIX = "ai-meglio-static-";

// 事前キャッシュする静的資産（すべて相対パス）。"" は配信ルート（"/AI_MEGLIO/" 等）自体を指し、
// index.html とは別URLとしてブラウザに要求されるため両方を precache する。
const ASSET_PATHS = [
  "", "index.html", "style.css",
  "app.js", "editor.js", "ai.js", "api.js", "convert.js",
  // §114: 変換ワーカー一式（worker 本体もオフラインで必要）
  "convertops.js", "convertclient.js", "convert.worker.js",
  "backdrop.js", "canvasresize.js", "gameexport.js", "gif.js",
  "help.js", "import.js", "livesync.js", "mobile.js", "motionstudio.js",
  "rig.js", "sendgpt.js", "studio.js", "styleref.js", "timeline.js", "autosave.js",
  "taptoggle.js", // §117: 再生/停止トグルの共通処理
  "saveblob.js", // §127: 保存（画像は保存方法を選ばせる）
  "swupdate.js", // §50.7: SW更新チェック（ページ側が AI_MEGLIO_CHECK_VERSION を呼ぶようになった）
  "autosprite.html", "autosprite.js", // §52: クイック生成ウィザード
  "version.json", "manifest.webmanifest", "icon-192.png", "icon-512.png",
];

let currentCacheName = null; // 現在有効なキャッシュ名（version.json の値から決定）
// §124: 用意はできたが「まだ切り替えていない」新しい版。使用中のページの足元で
// 入れ替えると、走っているJSは古いまま以降のファイルだけ新しくなって混在する。
// 切り替えるのは次のページ読み込み（navigate）のときだけにする。
let pendingCacheName = null;
let precachedUrls = null; // プリキャッシュ対象のURL集合（ついでキャッシュの除外用）

async function resolveCacheName() {
  try {
    const url = new URL("version.json", self.registration.scope).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`version.json HTTP ${res.status}`);
    const data = await res.json();
    const v = typeof data.version === "string" && data.version ? data.version : "unknown";
    return CACHE_PREFIX + v;
  } catch {
    // §50.7-4: version.json が一時的に取れない場合（オフライン/瞬断）は、直前に確定済みの
    // キャッシュ名があればそれを維持する（"unknown" 固定にして毎回キャッシュを無意味に
    // 切替えない）。まだ何も確定していない初回インストール時のみ "unknown" にフォールバックする。
    return currentCacheName || (CACHE_PREFIX + "unknown");
  }
}

// §124: 全部そろって初めて書き込む（原子的）。
// 以前は1ファイルずつ失敗を握りつぶしていたため、一部だけ取得できた中途半端な
// キャッシュがそのまま有効になり、新旧のファイルが混ざった状態で配信されていた。
// 1つでも取れなければ例外にして、このキャッシュへは切り替えない（＝今の版を保つ）。
async function precache(name) {
  const urls = ASSET_PATHS.map((p) => new URL(p, self.registration.scope).href);
  const responses = await Promise.all(urls.map(async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res || !res.ok) throw new Error(`precache failed: ${url}`);
    return res;
  }));
  const cache = await caches.open(name);
  await Promise.all(responses.map((res, i) => cache.put(urls[i], res)));
  precachedUrls = new Set(urls);
}

async function purgeOtherCaches(keepName) {
  const names = await caches.keys();
  await Promise.all(
    names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== keepName).map((n) => caches.delete(n))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const name = await resolveCacheName();
    await precache(name); // §124: 失敗したらインストールも失敗させる（古いSWが残る＝一貫した状態）
    currentCacheName = name;
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (!currentCacheName) currentCacheName = await resolveCacheName();
    await purgeOtherCaches(currentCacheName);
    await self.clients.claim();
  })());
});

// ページ側（app.js）から「version.json を確認してキャッシュを切り替えて」と明示要求できる。
// SW スクリプト自体は変わらなくても version.json の値が変わればここで新キャッシュへ切替わる。
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "AI_MEGLIO_CHECK_VERSION") return;
  event.waitUntil((async () => {
    try {
      const name = await resolveCacheName();
      if (!currentCacheName) {
        // まだ何も確定していない（SW再起動直後など）。ここで確定させる。
        await precache(name);
        currentCacheName = name;
        await purgeOtherCaches(name);
      } else if (name !== currentCacheName && name !== pendingCacheName) {
        // §124: 用意だけして切り替えない。走っているページは最後まで今の版で動かす。
        await precache(name);
        pendingCacheName = name;
      }
    } catch {
      // 取得に失敗したら今の版のまま（中途半端なキャッシュを作らない）
    }
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ cacheName: currentCacheName, updateReady: !!pendingCacheName });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // §50.2: /api/ を含むURLは絶対にキャッシュしない・介入しない（fetch イベントを無視 = 素通し）。
  if (url.pathname.includes("/api/")) return;
  if (url.origin !== self.location.origin) return; // 他オリジンは素通し

  // §55.7: クイック生成ページは network-first（swupdate.js を読まないページのため、
  // cache-first だと修正が恒久的に届かない）。オフライン時のみキャッシュへフォールバック。
  const isQuickGen = /\/autosprite\.(html|js)$/.test(url.pathname);

  event.respondWith((async () => {
    // §124: 新しいページ読み込みのときだけ、用意済みの新しい版へ切り替える。
    // ここで初めて古いキャッシュを消すので、走っているページが混ざることがない。
    if (req.mode === "navigate" && pendingCacheName) {
      currentCacheName = pendingCacheName;
      pendingCacheName = null;
      precachedUrls = new Set(ASSET_PATHS.map((p) => new URL(p, self.registration.scope).href));
      await purgeOtherCaches(currentCacheName);
    }
    const cache = currentCacheName ? await caches.open(currentCacheName) : null;
    if (!isQuickGen && cache) {
      const cached = await cache.match(req);
      if (cached) return cached; // cache-first
    }
    try {
      const res = await fetch(req, isQuickGen ? { cache: "no-store" } : undefined);
      // §124: プリキャッシュ対象は書き戻さない。別の版のファイルが紛れ込む経路になるため。
      const isAsset = precachedUrls ? precachedUrls.has(url.href) : false;
      if (res && res.ok && cache && !isAsset) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (cache) {
        const cached = await cache.match(req);
        if (cached) return cached;
      }
      throw err;
    }
  })());
});
