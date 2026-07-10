// sendgpt.js — §36 「GPTへ送る」ワンクリック
// 現在フレーム（レイヤー合成済み = frame.pixels キャッシュ）を 8倍拡大PNGにして
// 既存の POST /api/exchange-kit（§25.6/§25.8）へ送り、gpt-exchange/out/ に
// reference.png + prompt.txt + work_instruction.txt を書き出す。
// prompt.txt はクリップボードにもコピーし、完了時に §38 の open-folder（トグル準拠）で開く。
import {
  pixelsToPngDataUrl,
  styleRequestFields,
  maybeOpenServerFolder,
} from "./app.js";

const LS_KEY = "aiMeglio.sendGpt"; // 前回値 { preset, total, custom }
const PRESET_LABELS = { walk: "歩き", run: "走り", attack: "攻撃", idle: "待機", jump: "ジャンプ", custom: "カスタム" };

export function initSendGpt(store, toast) {
  const openBtn = document.getElementById("sendToGptBtn");
  const modal = document.getElementById("sendGptModal");
  const presetSel = document.getElementById("sgPreset");
  const totalInput = document.getElementById("sgTotal");
  const customInput = document.getElementById("sgCustom");
  const exportBtn = document.getElementById("sgExportBtn");
  const cancelBtn = document.getElementById("sgCancelBtn");
  const closeBtn = document.getElementById("sgCloseBtn");
  if (!openBtn || !modal) return;

  function loadPrev() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (!saved || typeof saved !== "object") return;
      if (typeof saved.preset === "string" && PRESET_LABELS[saved.preset]) presetSel.value = saved.preset;
      if (Number.isInteger(saved.total) && saved.total >= 2 && saved.total <= 12) totalInput.value = String(saved.total);
      if (typeof saved.custom === "string") customInput.value = saved.custom.slice(0, 500);
    } catch {}
  }
  function savePrev() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        preset: presetSel.value,
        total: Number(totalInput.value) || 4,
        custom: customInput.value,
      }));
    } catch {}
  }

  function close() { modal.hidden = true; }
  openBtn.addEventListener("click", () => {
    loadPrev();
    modal.hidden = false;
  });
  cancelBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (ev) => { if (ev.target === modal) close(); });

  // ChatGPT Work に貼る1行の作業指示。/api/config の実パスが分かれば併記する。
  function buildWorkInstruction(preset, total) {
    const label = PRESET_LABELS[preset] || preset;
    const cfg = store.state.serverConfig;
    const outDir = cfg?.exchangeOut ? `gpt-exchange/out/（実パス: ${cfg.exchangeOut}）` : "gpt-exchange/out/";
    const inDir = cfg?.exchangeIn ? `gpt-exchange/in/（実パス: ${cfg.exchangeIn}）` : "gpt-exchange/in/";
    const names = total === 1 ? `${preset}_1.png` : `${preset}_1.png 〜 ${preset}_${total}.png`;
    return `${outDir} の reference.png と prompt.txt を読み、prompt.txt の指示どおり「${label}」のスプライトシートを生成して、各コマを1枚ずつのPNGに分割し ${inDir} に ${names} という名前で保存してください。`;
  }

  exportBtn.addEventListener("click", async () => {
    const preset = presetSel.value;
    const total = Math.max(2, Math.min(12, Number(totalInput.value) || 4));
    const customText = customInput.value.trim().slice(0, 500);
    if (preset === "custom" && !customText) {
      toast("カスタムでは補足指示（動きの内容）を入力してください", "error");
      return;
    }
    savePrev();
    const p = store.state.project;
    const frame = p.frames[store.state.currentFrame];
    // §35: frame.pixels は可視レイヤーの合成キャッシュ（= レイヤー合成済み）
    const referencePng = pixelsToPngDataUrl(frame.pixels, p.width, p.height, p.palette, 8);
    const style = styleRequestFields(p, store.state.serverConfig);
    const workInstruction = buildWorkInstruction(preset, total);
    exportBtn.disabled = true;
    try {
      const res = await fetch("/api/exchange-kit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset,
          customText,
          total,
          styleGuide: style.styleGuide || "",
          referencePng,
          workInstruction, // §36: 3ファイル目として書き出される
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      let clip = "";
      try {
        await navigator.clipboard.writeText(data.promptText);
        clip = "依頼文をクリップボードにコピーしました。";
      } catch {
        clip = "（クリップボードへのコピーは失敗。prompt.txt を使ってください）";
      }
      close();
      toast(`GPTへ送る一式を書き出しました: ${data.dir}（${(data.files || []).join(" + ")}）。${clip}`);
      await maybeOpenServerFolder("exchange"); // §38: トグルONならフォルダを開く
    } catch (err) {
      toast(`書き出しに失敗しました: ${err.message}`, "error");
    } finally {
      exportBtn.disabled = false;
    }
  });

  loadPrev();
}
