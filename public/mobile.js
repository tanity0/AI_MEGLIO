// §49: スマホレイアウト（サイドパネルのドロワー化＋キャンバスズームUI）
// モバイル判定は CSS メディアクエリ (max-width: 820px) と同一のクエリを matchMedia で
// 判定する（§49.1・単一の閾値）。ここではドロワーの開閉状態（body class）だけを扱う。
// キャンバスズームUI（＋/−/⤢全体）は zoom の実装を握っている editor.js 側に配線する。
const MOBILE_QUERY = "(max-width: 820px)";

export function initMobile() {
  const mq = window.matchMedia(MOBILE_QUERY);
  const toolHandle = document.getElementById("toolDrawerHandle");
  const aiHandle = document.getElementById("aiDrawerHandle");
  const backdrop = document.getElementById("drawerBackdrop");
  const body = document.body;

  function isMobile() {
    return mq.matches;
  }

  function closeDrawers() {
    body.classList.remove("drawer-left-open", "drawer-right-open");
  }
  // §49.2: 同時に開くのは片側のみ（片方を開いたらもう片方は閉じる）
  function openLeft() {
    body.classList.add("drawer-left-open");
    body.classList.remove("drawer-right-open");
  }
  function openRight() {
    body.classList.add("drawer-right-open");
    body.classList.remove("drawer-left-open");
  }
  function toggleLeft() {
    if (body.classList.contains("drawer-left-open")) closeDrawers();
    else openLeft();
  }
  function toggleRight() {
    if (body.classList.contains("drawer-right-open")) closeDrawers();
    else openRight();
  }

  toolHandle?.addEventListener("click", toggleLeft);
  aiHandle?.addEventListener("click", toggleRight);
  // §49.2: バックドロップのタップ（=キャンバス外タップ）で自動的に閉じる
  backdrop?.addEventListener("click", closeDrawers);

  // デスクトップ幅に戻った（リサイズ/回転）ときはドロワー状態を破棄しておく。
  // モバイル幅のCSSでしかドロワーの transform は効かないため実害はないが、
  // 幅を戻して再びモバイルに戻したときに毎回「開いた状態」から始まらないようにする。
  function syncMediaState() {
    if (!isMobile()) closeDrawers();
  }
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", syncMediaState);
  else if (typeof mq.addListener === "function") mq.addListener(syncMediaState); // 古いSafari互換
  syncMediaState();
}
