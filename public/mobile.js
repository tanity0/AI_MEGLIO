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
  const timelineBar = document.getElementById("timelineBar");
  const timelineCollapseBtn = document.getElementById("timelineCollapseBtn");

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

  initGestureGuard();
  initTimelineCollapse(timelineBar, timelineCollapseBtn);
}

// §50.4: タイムライン折りたたみ（モバイルのみ。つまみボタン自体はCSSでデスクトップ非表示のため
// リスナーは常時登録して問題ない）。折りたたむと#tagBar/#frameList/操作列(再生ボタン以外)を
// CSS側（.is-collapsed）で隠し、高さを最小にする。状態はlocalStorageに保持。
const TIMELINE_COLLAPSE_KEY = "aiMeglio.timelineCollapsed";
function initTimelineCollapse(timelineBar, timelineCollapseBtn) {
  if (!timelineBar || !timelineCollapseBtn) return;
  function applyCollapsed(collapsed) {
    timelineBar.classList.toggle("is-collapsed", collapsed);
    timelineCollapseBtn.textContent = collapsed ? "∧" : "∨";
    const label = collapsed ? "タイムラインを開く" : "タイムラインを折りたたむ";
    timelineCollapseBtn.title = label;
    timelineCollapseBtn.setAttribute("aria-label", label);
  }
  let collapsed = false;
  try { collapsed = localStorage.getItem(TIMELINE_COLLAPSE_KEY) === "1"; } catch {}
  applyCollapsed(collapsed);
  timelineCollapseBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    applyCollapsed(collapsed);
    try { localStorage.setItem(TIMELINE_COLLAPSE_KEY, collapsed ? "1" : "0"); } catch {}
    // タイムラインの高さが変わりキャンバス領域(#appMainがflex:1で自動追従)が変化するため、
    // zoomAuto中は既存のresizeリスナー（editor.js）を再利用してフィットズームを再計算させる。
    window.dispatchEvent(new Event("resize"));
  });
}

// §49.9: iOS Safari はページの2本指ピンチズームを user-scalable=no でも無視することがあるため、
// 非標準の gesturestart/gesturechange/gestureend（Safari独自イベント）を preventDefault してアプリ
// 全域でページズームを止める。これは PointerEvents で自前実装しているキャンバス（editor.js）・
// 変換スタジオ（studio.js）のピンチとは完全に独立したイベント系統なので、そちらの挙動には影響しない。
// モバイル/デスクトップを問わず常時張っておいてよい（デスクトップ・Safari以外では発火しないため無害）。
function initGestureGuard() {
  const preventGesture = (e) => e.preventDefault();
  document.addEventListener("gesturestart", preventGesture, { passive: false });
  document.addEventListener("gesturechange", preventGesture, { passive: false });
  document.addEventListener("gestureend", preventGesture, { passive: false });
}
