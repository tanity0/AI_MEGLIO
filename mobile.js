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
  initMobileSheet(mq); // §81
}

// §81: モバイルではヘッダーの操作群とプロファイル行をボトムシートへ移設し、
// ↩↪ を下部ツールバーへ統合する。DOMごと移動するので既存のイベント結線はそのまま生きる
// （§61 のマジックオプションと同じ流儀）。デスクトップ幅へ戻したら元の位置へ復帰。
function initMobileSheet(mq) {
  const header = document.getElementById("appHeader");
  const actions = document.querySelector(".header-actions");
  const profileBar = document.getElementById("profileBar");
  const sheet = document.getElementById("mobileMenuSheet");
  const sheetBody = document.getElementById("mobileSheetBody");
  const menuBtn = document.getElementById("mobileMenuBtn");
  const quick = document.getElementById("headerQuickLink");
  const toolbar = document.getElementById("mobileToolbar");
  const undoBtn = document.getElementById("mobileUndoBtn");
  const redoBtn = document.getElementById("mobileRedoBtn");
  if (!header || !actions || !sheet || !sheetBody || !menuBtn) return;
  const body = document.body;
  const actionsHome = actions.parentElement;
  const profileAnchor = document.getElementById("appMain");
  const quickHome = quick ? quick.parentElement : null;
  const undoHome = undoBtn ? undoBtn.parentElement : null;

  const openSheet = () => { sheet.hidden = false; };
  const closeSheet = () => { sheet.hidden = true; };
  menuBtn.addEventListener("click", () => (sheet.hidden ? openSheet() : closeSheet()));
  sheet.querySelectorAll('[data-action="close-sheet"]').forEach((el) => el.addEventListener("click", closeSheet));
  // シート内の操作（保存・書き出し等）を押したら閉じてキャンバスへ戻る
  sheetBody.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t instanceof HTMLElement && t.closest("button, a, label.btn") && !t.closest("select, input")) closeSheet();
  });

  function toMobile() {
    if (body.classList.contains("sheet-ready")) return;
    if (quick) header.insertBefore(quick, menuBtn); // ⚡はヘッダーに残す
    sheetBody.append(actions);
    if (profileBar) sheetBody.append(profileBar);
    if (toolbar && undoBtn && redoBtn) { toolbar.prepend(redoBtn); toolbar.prepend(undoBtn); }
    body.classList.add("sheet-ready");
  }
  function toDesktop() {
    if (!body.classList.contains("sheet-ready")) return;
    closeSheet();
    actionsHome.append(actions);
    if (quick && quickHome) quickHome.prepend(quick);
    if (profileBar && profileAnchor && profileAnchor.parentElement) {
      profileAnchor.parentElement.insertBefore(profileBar, profileAnchor);
    }
    if (undoHome && undoBtn && redoBtn) { undoHome.append(undoBtn); undoHome.append(redoBtn); }
    body.classList.remove("sheet-ready");
  }
  function sync() {
    if (mq.matches) toMobile();
    else toDesktop();
  }
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", sync);
  else if (typeof mq.addListener === "function") mq.addListener(sync);
  sync();
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
