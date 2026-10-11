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
