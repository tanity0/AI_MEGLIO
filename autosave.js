// autosave.js — §50.1 自動保存＆復元（IndexedDB・デバウンス2秒）
// サーバー版/静的版どちらでも同じ挙動（IndexedDB はブラウザAPIでサーバー非依存）。
// 保存対象は「保存(JSON)」と同じ直列化形式（projectToPlain）を流用する。
import { projectToPlain, projectFromPlain, createSampleProject } from "./app.js";

const DB_NAME = "ai-meglio-autosave";
const DB_VERSION = 1;
const STORE_NAME = "autosave";
const RECORD_KEY = "current";
const DEBOUNCE_MS = 2000; // §50.1: 編集操作後2秒アイドルで書き込み

let dbPromise = null;
// IndexedDB が使えない環境（プライベートブラウズ等）・初回オープン失敗時は
// 例外を投げずに以降すべての操作を静かに no-op にする。
let disabled = false;

function openDb() {
  if (disabled) return Promise.reject(new Error("autosave disabled"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
  dbPromise.catch(() => { disabled = true; });
  return dbPromise;
}

async function idbPut(record) {
  if (disabled) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("tx aborted"));
    });
  } catch {
    disabled = true;
  }
}

async function idbGet() {
  if (disabled) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    disabled = true;
    return null;
  }
}

async function idbClear() {
  if (disabled) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("tx aborted"));
    });
  } catch {
    disabled = true;
  }
}

// 現在のプロジェクトが「空プロジェクト相当」（＝起動直後のサンプルプロジェクトのまま未編集）かどうか。
function isSampleEquivalent(project) {
  try {
    return JSON.stringify(projectToPlain(project)) === JSON.stringify(projectToPlain(createSampleProject()));
  } catch {
    return false;
  }
}

function showResumeBanner(record, store, toast) {
  const banner = document.getElementById("resumeBanner");
  if (!banner) return;
  const resumeBtn = document.getElementById("resumeBannerResumeBtn");
  const discardBtn = document.getElementById("resumeBannerDiscardBtn");
  if (!resumeBtn || !discardBtn) return;
  function close() { banner.hidden = true; }
  resumeBtn.onclick = () => {
    try {
      const project = projectFromPlain(record.project);
      store.resetProject(project);
      toast("前回の続きから再開しました");
    } catch (err) {
      toast(`復元に失敗しました: ${err.message}`, "error");
    }
    close();
  };
  discardBtn.onclick = () => {
    idbClear();
    close();
  };
  banner.hidden = false;
}

export function initAutosave(store, toast) {
  if (typeof indexedDB === "undefined") {
    disabled = true;
    // 無効時もフックは公開する（QA/E2Eから静かに無効化されたことを確認できるように）。
    window.aiMeglioAutosave = {
      isDisabled: () => true,
      flushNow: async () => {},
      clear: async () => {},
      peek: async () => null,
    };
    return;
  }

  let timer = null;
  let saving = false;

  function scheduleSave() {
    if (disabled) return;
    if (store.state.liveSyncEnabled) return; // §29: ライブ同期中は自動保存を停止（二重管理防止）
    if (store.state.paletteAdjPreview) return; // §72.1: 色調整プレビュー中は未確定の色を保存しない
    if (timer) clearTimeout(timer);
    timer = setTimeout(doSave, DEBOUNCE_MS);
  }

  async function doSave() {
    timer = null;
    if (disabled || store.state.liveSyncEnabled) return;
    if (store.state.paletteAdjPreview) return; // §72.1
    if (saving) { scheduleSave(); return; }
    saving = true;
    try {
      const plain = projectToPlain(store.state.project);
      await idbPut({ project: plain, savedAt: Date.now() });
    } finally {
      saving = false;
    }
  }

  store.subscribe(scheduleSave);

  // §50.1: 新規プロジェクト作成時は自動保存もリセット（initHeader の既存ハンドラに相乗り）。
  document.getElementById("newProjectBtn")?.addEventListener("click", () => {
    if (timer) { clearTimeout(timer); timer = null; }
    idbClear();
  });

  // 起動時: 自動保存が存在し、かつ現在が空プロジェクト相当なら再開バナーを出す。
  (async () => {
    const record = await idbGet();
    if (!record || !record.project) return;
    if (!isSampleEquivalent(store.state.project)) return;
    showResumeBanner(record, store, toast);
  })();

  // E2E テスト用フック（UIには影響しない）
  window.aiMeglioAutosave = {
    isDisabled: () => disabled,
    flushNow: doSave, // デバウンス待ちを待たずに即保存（テスト高速化）
    clear: () => idbClear(),
    peek: () => idbGet(),
  };
}
