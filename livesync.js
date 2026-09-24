// livesync.js — §29 ライブプロジェクト同期（Codex ⇄ GUI 往復編集）
// 共有ファイル EXCHANGE_DIR/live_project.json をサーバー経由で読み書きする。
// トグルON: 即ロード + meta ポーリングで外部変更を自動反映。
// 書き戻しは明示ボタン「ライブ保存」（v1は debounce 自動保存を入れない）。
import { projectToPlain, projectFromPlain } from "./app.js";

const POLL_INTERVAL_MS = 2500; // §29.3: 2〜3秒ごと

export function initLiveSync(store, toast) {
  const toggle = document.getElementById("liveSyncToggle");
  const saveBtn = document.getElementById("liveSaveBtn");
  const statusEl = document.getElementById("liveSyncStatus");

  let enabled = false;
  let pollTimer = null;
  let polling = false; // ポール多重防止
  // 自分がロード/保存した版の mtime。これ以下の mtime のポール結果はリロードしない（エコー抑制）。
  let lastSyncedMtime = 0;
  // 最後に同期した時点のプロジェクト内容スナップショット（未保存編集の判定用）
  let syncedSnapshot = null;

  function serializeProject() {
    return JSON.stringify(projectToPlain(store.state.project));
  }
  function isDirty() {
    if (syncedSnapshot === null) return false;
    return serializeProject() !== syncedSnapshot;
  }
  function markSynced(mtime) {
    if (Number.isFinite(mtime) && mtime > lastSyncedMtime) lastSyncedMtime = mtime;
    syncedSnapshot = serializeProject();
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const ss = String(t.getSeconds()).padStart(2, "0");
    statusEl.textContent = `最終同期 ${hh}:${mm}:${ss}`;
  }

  // live ファイルをフルGETしてストアへ反映。成功なら true。
  async function loadFromLive() {
    const res = await fetch("/api/live-project", { cache: "no-store" });
    if (!res.ok) throw new Error(`GET失敗 (${res.status})`);
    const data = await res.json();
    if (!data.exists || data.project === null) return false; // 未作成 or 書き込み途中
    let project;
    try {
      project = projectFromPlain(data.project);
    } catch (err) {
      // 妥当でないプロジェクト: この版は諦めて既読扱い（プロンプトループ回避）
      lastSyncedMtime = Math.max(lastSyncedMtime, data.mtime || 0);
      throw new Error(`ライブプロジェクトが不正です: ${err.message}`);
    }
    store.resetProject(project); // pushUndo するので自動リロードも Ctrl+Z で戻せる
    markSynced(data.mtime || 0);
    return true;
  }

  async function poll() {
    if (!enabled || polling) return;
    polling = true;
    try {
      const res = await fetch("/api/live-project?meta=1", { cache: "no-store" });
      if (!res.ok) return;
      const meta = await res.json();
      if (!enabled) return;
      if (!meta.exists) return;
      const mtime = meta.mtime || 0;
      if (mtime <= lastSyncedMtime) return; // エコー抑制 / 既読
      // 外部で更新された
      if (isDirty()) {
        const ok = window.confirm("外部で変更されました。読み込み直しますか？（未保存の編集は失われます）");
        if (!ok) {
          // 無視 = ローカル維持。この版は既読扱いにして再プロンプトを防ぐ。
          lastSyncedMtime = mtime;
          return;
        }
      }
      try {
        const loaded = await loadFromLive();
        if (loaded) toast("ライブ同期: 外部の変更を読み込みました");
      } catch (err) {
        toast(err.message, "error");
      }
    } catch {
      // ネットワーク一時失敗は無視（次のポールで回復）
    } finally {
      polling = false;
    }
  }

  async function enable() {
    enabled = true;
    store.state.liveSyncEnabled = true; // §50.1: 自動保存を停止させる
    store.notify();
    lastSyncedMtime = 0;
    syncedSnapshot = serializeProject();
    saveBtn.hidden = false;
    statusEl.hidden = false;
    statusEl.textContent = "ライブ同期: 待機中…";
    // 即ロード
    try {
      const loaded = await loadFromLive();
      if (loaded) toast("ライブ同期を開始しました（共有ファイルを読み込みました）");
      else {
        // ファイル未作成: 現在のプロジェクトを基準にする（保存で作られる）
        markSynced(0);
        toast("ライブ同期を開始しました（共有ファイルは未作成。「ライブ保存」で作成できます）");
      }
    } catch (err) {
      markSynced(0);
      toast(err.message, "error");
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function disable() {
    enabled = false;
    store.state.liveSyncEnabled = false; // §50.1: 自動保存を再開させる
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    saveBtn.hidden = true;
    statusEl.hidden = true;
    statusEl.textContent = "";
    syncedSnapshot = null;
    store.notify();
  }

  async function saveToLive() {
    if (!enabled) return;
    const body = serializeProject();
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/live-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `保存失敗 (${res.status})`);
      // 自分の書き込み mtime を記録（次のポールで無視 = エコー抑制）
      markSynced(data.mtime || 0);
      toast("ライブ保存しました（Codexが読み込めます）");
    } catch (err) {
      toast(`ライブ保存に失敗しました: ${err.message}`, "error");
    } finally {
      saveBtn.disabled = false;
    }
  }

  toggle.addEventListener("change", () => {
    if (toggle.checked) enable();
    else disable();
  });
  saveBtn.addEventListener("click", saveToLive);

  // E2E テスト用フック（UIには影響しない）
  window.aiMeglioLiveSync = {
    isEnabled: () => enabled,
    isDirty,
    getLastSyncedMtime: () => lastSyncedMtime,
    pollNow: poll,
  };
}
