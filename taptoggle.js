// §117: 再生/停止トグルを「押した瞬間」に効かせる共通処理。
//
// 背景（§116 で計測）: ボタンには touch-action:manipulation が付いており、これは
// パン（スクロール）を許可する指定。押してから離すまでに指が十数px動くと、
// ブラウザが「スクロール開始」と解釈して click を発火させない。
// 実測では 14px 以上のズレで停止ボタンが効かなかった。親指でのタップは
// 十数px動くことが珍しくないので、指の置き方次第で効いたり効かなかったりする。
//
// pointerdown は指が動く前に発火するので、その後スクロールと判定されても効く。
// pointerdown で処理したら、対になって飛んでくる click は必ず捨てる
// （「○ms以内の click を捨てる」という時間での判定は、混んでいるときに
//  click がそれより遅れて届いて二度切り替わるため使わない — §116.5）。
//
// 再生/停止のように「押し直しが容易で副作用が無い」操作にだけ使うこと。
// 削除のような取り返しのつかない操作には使わない。

// 「待ちきれず2度押ししたときに元へ戻らない」ための猶予は、再生を『始める』ときだけに
// 効かせたいので、ここではなく呼び出し側に置く（止めるのは常に即座に効くべきなので）。
export function onPressToggle(el, handler) {
  if (!el) return () => {};
  let swallowClick = false;

  const fire = () => handler();

  // 印の解除に時間（タイマー）は使わない。
  // 「○ms経ったら捨てる」にすると、混んでいるときに click がそれより遅れて届き、
  // 印が消えた後に二度目の切り替えが起きる。§116 では1秒、その次は pointerup から
  // 300ms で試したが、CPU 6倍スロットル下ではどちらも再発した。
  // 解除するのは「click が実際に来たとき」と「スクロールと判定されたとき
  // （pointercancel。この場合 click は発火しない）」だけにする。
  // どちらも来ないまま終わっても、次の pointerdown が印を立て直すので害は無い。
  const onDown = () => {
    swallowClick = true;
    fire();
  };
  const onCancel = () => { swallowClick = false; };
  const onClick = () => {
    if (swallowClick) { // pointerdown で処理済み
      swallowClick = false;
      return;
    }
    fire(); // pointerdown が来ない経路（キーボード操作・プログラムからの click）
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("click", onClick);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("click", onClick);
  };
}

// §118: 横スクロールする一覧（コマ一覧）の中の項目を、指が多少ズレてもタップとして拾う。
//
// 再生ボタン（onPressToggle）のように pointerdown で処理する手は使えない。
// スクロールしようとするたびに項目が選ばれてしまうため。
//
// 実測した落ち方（サムネイルの上で指を動かしたとき）:
//   ズレなし/8px : pointerdown → pointerup → click     （効く）
//   横20px以上   : pointerdown → pointercancel         （pointerup すら来ない）
//   縦20px以上   : pointerdown → pointerup（click 無し）
// どの場合も touchend は来ているので、指を離した時点で判定する。
//
// タップの条件（閾値を使わないので端末や指の大きさに依存しない）:
//   1. 一覧が実際にはスクロールしていない（scrollLeft/scrollTop が押した時のまま）
//   2. 指を離した位置が一覧の中にある
// 選ぶのは「指を置いた項目」。狙いを定めるのは押した瞬間なので、
// そこから多少ズレて離しても、押した項目が選ばれるほうが意図どおりになる。
// 1 があるので、スクロールするつもりの操作は項目を選ばない。
//
// container へ委譲で1組だけ登録する（項目は再描画で作り直されるため）。
export function onItemTap(container, selector, handler) {
  if (!container) return () => {};
  let start = null;       // { el, sl, st }
  let swallowClick = false;

  const onDown = (ev) => {
    // 前の操作で click が来ないまま終わった場合の取りこぼしをここで捨てる
    swallowClick = false;
    const el = ev.target.closest(selector);
    start = (el && container.contains(el))
      ? { el, sl: container.scrollLeft, st: container.scrollTop }
      : null;
  };

  const settle = (x, y) => {
    const s = start;
    start = null;
    if (!s) return;
    if (container.scrollLeft !== s.sl || container.scrollTop !== s.st) return; // 実際にスクロールした
    if (!s.el.isConnected) return;
    const r = container.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return; // 一覧の外で離した
    swallowClick = true; // 続けて click が来ても二重に処理しない
    handler(s.el, s);
  };

  const onPointerUp = (ev) => settle(ev.clientX, ev.clientY);
  const onTouchEnd = (ev) => {
    const t = ev.changedTouches && ev.changedTouches[0];
    if (t) settle(t.clientX, t.clientY);
  };
  // pointercancel（横に動いてパンと判定された）では pointerup が来ないので、
  // そのあとに来る touchend で判定する。start はまだ残してある。
  const onClick = (ev) => {
    if (swallowClick) { swallowClick = false; ev.stopPropagation(); return; }
    const el = ev.target.closest(selector);
    if (el && container.contains(el)) handler(el, null); // マウス等、通常の click 経路
  };

  container.addEventListener("pointerdown", onDown, true);
  container.addEventListener("pointerup", onPointerUp, true);
  container.addEventListener("touchend", onTouchEnd, true);
  container.addEventListener("click", onClick, true);
  return () => {
    container.removeEventListener("pointerdown", onDown, true);
    container.removeEventListener("pointerup", onPointerUp, true);
    container.removeEventListener("touchend", onTouchEnd, true);
    container.removeEventListener("click", onClick, true);
  };
}
