// §127: ファイルの保存。画像のときだけ保存方法を選ばせる。
//
// 背景（§93 → §127）: iPhone では navigator.canShare({files}) が使えるため、
// 保存が OS の共有シートを通る。そこで「画像を保存」を選ぶと写真アプリへ入り、
// 写真アプリは**アルファを落とす**。透過を残すには「"ファイル"に保存」を
// 選ぶ必要がある。§93 ではそれを消えるトースト1行で案内していたが、
// 直後に共有シートが画面を覆うため見落ちて透過が失われていた。
//
// 共有シートをやめて通常ダウンロードだけにする手は採らない。端末側で
// ダウンロードが効かなかったときに「押しても何も起きない」という、より悪い
// 行き止まりになる（iOS での挙動はここで検証できないので片方に賭けない）。
// 代わりに、画像のときだけ1タップ選ばせる。
//
// autosprite.html は style.css を読んでいないので、見た目はこのモジュールが
// インラインスタイルで持つ（index.html と同じに出る）。

// 通常のダウンロード経路。写真アプリを通らないので透過は必ず残る。
function plainDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); // DOM外の <a> だと download 属性のファイル名が無視されることがある
  if ("download" in a) a.click();
  else window.open(url, "_blank"); // 最終手段（長押しで保存）
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

let dialog = null; // { overlay, text, fileBtn, shareBtn, cancelBtn }

function buildDialog() {
  const overlay = document.createElement("div");
  overlay.id = "saveRouteOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.6);padding:16px;";

  const card = document.createElement("div");
  card.style.cssText =
    "background:#1b1b22;color:#eee;border:1px solid #3a3a46;border-radius:10px;padding:16px;" +
    "max-width:420px;width:100%;font:14px/1.6 system-ui,-apple-system,sans-serif;" +
    "box-shadow:0 10px 40px rgba(0,0,0,0.5);";

  const head = document.createElement("strong");
  head.textContent = "画像の保存方法";
  head.style.cssText = "display:block;font-size:15px;margin-bottom:8px;";

  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 8px;";

  const warn = document.createElement("p");
  warn.style.cssText = "margin:0 0 14px;color:#ffd27a;";
  warn.innerHTML =
    '共有シートで<strong>「画像を保存」</strong>を選ぶと写真アプリがアルファを落とすため、' +
    '<strong>透過が失われます</strong>。透過を残したいときは下の「ファイルに保存」か、' +
    '共有シートの<strong>「"ファイル"に保存」</strong>を選んでください。';

  const btnCss =
    "display:block;width:100%;margin:0 0 8px;padding:12px;border-radius:8px;font-size:14px;" +
    "border:1px solid #3a3a46;background:#2a2a34;color:#eee;cursor:pointer;";
  const fileBtn = document.createElement("button");
  fileBtn.type = "button";
  fileBtn.textContent = "ファイルに保存（透過が残る）";
  fileBtn.style.cssText = btnCss + "background:#2f6f4f;border-color:#3d8a63;font-weight:600;";
  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.textContent = "共有シートを開く";
  shareBtn.style.cssText = btnCss;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "やめる";
  cancelBtn.style.cssText = btnCss + "margin-bottom:0;background:transparent;";

  card.append(head, text, warn, fileBtn, shareBtn, cancelBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  dialog = { overlay, text, fileBtn, shareBtn, cancelBtn };
  return dialog;
}

// "file" | "share" | "cancel" を返す。
// 押した瞬間に確定させる（pointerdown ではなく click。取り返しのつく操作ではないため）。
function askSaveRoute(filename) {
  const d = dialog || buildDialog();
  d.text.textContent = `${filename} を保存します。`;
  d.overlay.style.display = "flex";
  return new Promise((resolve) => {
    const done = (v) => {
      d.overlay.style.display = "none";
      d.fileBtn.removeEventListener("click", onFile);
      d.shareBtn.removeEventListener("click", onShare);
      d.cancelBtn.removeEventListener("click", onCancel);
      d.overlay.removeEventListener("click", onBackdrop);
      resolve(v);
    };
    const onFile = () => done("file");
    const onShare = () => done("share");
    const onCancel = () => done("cancel");
    // 枠の外を押したら「やめる」（他のモーダルと同じ作法）
    const onBackdrop = (ev) => { if (ev.target === d.overlay) done("cancel"); };
    d.fileBtn.addEventListener("click", onFile);
    d.shareBtn.addEventListener("click", onShare);
    d.cancelBtn.addEventListener("click", onCancel);
    d.overlay.addEventListener("click", onBackdrop);
  });
}

// §127.8: 同時に何件も呼ばれても1件ずつ処理する。
// ゲーム書き出しは files をループで保存するため（連番PNG等）、直列化しないと
// 共有ダイアログが重なって最後の1件しか効かない。
let queue = Promise.resolve();
export function saveBlob(blob, filename) {
  const run = queue.then(() => saveBlobOne(blob, filename), () => saveBlobOne(blob, filename));
  queue = run.catch(() => {});
  return run;
}

async function saveBlobOne(blob, filename) {
  const type = blob.type || "application/octet-stream";
  let file = null;
  let canShare = false;
  try {
    file = new File([blob], filename, { type });
    canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  } catch {
    canShare = false; // File が作れない環境
  }

  // 画像で共有シートが使える端末（= iPhone 等）のときだけ選ばせる。
  // PC は canShare が false なので、ここを通らず従来どおりダウンロードされる。
  if (canShare && /^image\//.test(type)) {
    const route = await askSaveRoute(filename);
    if (route === "cancel") return false;
    if (route === "share") {
      try {
        await navigator.share({ files: [file], title: filename });
        return true;
      } catch (err) {
        if (err && err.name === "AbortError") return false; // 利用者がキャンセル
        // 共有が失敗したらダウンロードへ落とす（行き止まりにしない）
      }
    }
    plainDownload(blob, filename);
    return true;
  }

  // 画像以外は従来どおり（共有シートが使えればそれ、だめならダウンロード）
  if (canShare) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if (err && err.name === "AbortError") return false;
    }
  }
  plainDownload(blob, filename);
  return true;
}
