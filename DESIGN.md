# AI Meglio — ドット絵アニメーション AI編集スタジオ 設計書

## 1. コンセプト

ブラウザで動くドット絵アニメーションエディタ。ユーザーはキャンバス上で「細かい部分」（矩形範囲・フレーム）を指定し、日本語で修正指示を出す。Claude API がその範囲のドットをピンポイントで書き換え、ループ再生中のプレビューに即座に反映される。手描き編集とAI編集を行き来しながら仕上げるツール。

**ドット絵がAI精密編集に向く理由**: 小さいグリッド × 限定パレットなので、画像を「パレット番号のテキストグリッド」として完全に表現できる。Claudeには理解用のPNG画像と編集用のテキストグリッドの両方を渡し、出力は構造化JSON（差分パッチ）で受け取る。再生成ではなく確定的な差分編集になる。

## 2. 技術構成

- **サーバー**: Node.js 18+ / ESM / `node:http`（Expressなし）。依存は `@anthropic-ai/sdk` のみ。
- **フロント**: ビルドステップなしの vanilla JS + Canvas API。`public/` 配下に配置。
- **CDN・外部リソース禁止**（フォント・ライブラリすべてローカル/自前実装）。

### ファイル構成

```
package.json          # type: module, dep: @anthropic-ai/sdk, scripts.start: node server.js
server.js             # 静的配信 + /api/edit (SSE) + /api/config
public/
  index.html
  style.css
  app.js              # エントリ・状態管理・Undo/Redo
  editor.js           # キャンバス描画・ツール・選択
  timeline.js         # フレーム一覧・再生プレビュー
  ai.js               # AIパネル・SSE受信・パッチ適用
  gif.js              # GIFエンコーダ（自前実装、依存なし）
README.md             # セットアップ・使い方（日本語）
DESIGN.md             # 本書
```

（ファイル分割は目安。合理的な範囲で統合・分割してよいが、1ファイル2000行を超えない）

## 3. データモデル

```js
project = {
  width: 32, height: 32,        // 8〜96。デフォルト 32×32
  fps: 8,                        // 1〜24
  palette: ["#00000000", "#1a1c2c", ...],  // 最大32色。index 0 は常に透明
  frames: [
    { pixels: Uint8Array(width*height) },  // 値 = パレットindex
    ...
  ]
}
```

- Undo/Redo はプロジェクト全体のスナップショットスタック（JSON化して保持、上限50件）。
- 保存/読込: プロジェクトをJSONでダウンロード / ファイル選択で復元。

### テキストグリッド表現（プロンプト用）

1ピクセル1文字。透明(index 0) = `.`、index 1〜31 = `1`〜`9`, `a`〜`v`（base36的割当て、大文字不使用）。1行 = グリッド1行。フレームごとに行ブロック。この表現はプロンプトとレスポンスの両方で共通に使う。

## 4. UI レイアウト

```
┌──────────┬──────────────────────────┬──────────────┐
│ ツール      │  キャンバス（ズーム表示・       │ AIパネル       │
│ ・ペン      │  グリッド線・オニオンスキン）    │ ・対象表示      │
│ ・消しゴム   │                          │ ・指示入力      │
│ ・塗りつぶし │                          │ ・実行ボタン     │
│ ・矩形選択   │                          │ ・履歴ログ      │
│ ・スポイト   │                          │ ・再生プレビュー  │
│ パレット     │                          │  (実寸+ループ)   │
├──────────┴──────────────────────────┴──────────────┤
│ タイムライン: フレームサムネイル列 [+追加][複製][削除][←→並替] fps▸ 再生/停止 │
└─────────────────────────────────────────────────────┘
```

### エディタ要件

- ズーム: セルサイズ自動（キャンバス領域にフィット）+ ホイールで調整。グリッド線はズーム時のみ。
- ツール: ペン / 消しゴム / 塗りつぶし(flood fill) / 矩形選択 / スポイト。ドラッグ描画対応。
- 矩形選択: 点線でハイライト。選択中はAIパネルに「対象: フレームN の (x,y)〜(x2,y2)」と表示。選択なし = フレーム全体が対象。
- オニオンスキン: 前フレームを半透明表示（トグル）。
- 市松模様の透明背景。
- パレット: 色クリックで選択、ダブルクリックで `<input type="color">` により変更、[+]で追加（32色まで）。
- 再生プレビュー: AIパネル下部に実寸〜2倍表示で常時ループ再生（トグル可）。**編集が適用された瞬間に反映される**こと（フレームデータ共有で自然に実現）。

### AIパネル要件

- 対象スコープ選択: 「選択範囲のみ」「現在のフレーム」「全フレーム」ラジオ。
- 指示テキストエリア（Cmd/Ctrl+Enter で実行）。
- 実行中: ストリーミング進捗（受信文字数 or スピナー）+ 中断ボタン（fetch abort）。
- 適用時: 変更されたセルを1秒程度フラッシュハイライト。
- 履歴ログ: 指示文と結果（適用セル数 / 追加フレーム数 / エラー）を時系列表示。
- 適用は自動。気に入らなければ Undo (Cmd/Ctrl+Z)。

### 指示例（プレースホルダに記載）

「腕の振りをもっと大きく」「輪郭のジャギーを滑らかに」「フレーム1と2の間に中割りを追加」「全体を夕暮れの色調に」「この範囲の剣を炎の剣にして」

## 5. サーバー API

### `GET /api/config`
`{ model, effort, mock }` を返す。

### `POST /api/edit` → SSE

リクエストJSON:

```js
{
  project: { width, height, fps, palette, framesGrid: ["....\n1122\n...", ...] },  // テキストグリッド
  scope: "selection" | "frame" | "all",
  frameIndex: 0,                       // scope=selection/frame のとき対象フレーム
  selection: { x, y, w, h } | null,    // scope=selection のとき
  instruction: "腕の振りをもっと大きく"
}
```

SSEイベント（`data: {...}\n\n`）:

- `{ type: "delta", text: "..." }` — 進捗表示用（JSONの断片。クライアントは表示のみに使い、蓄積して最後にパースはサーバー側で行うため使わない）
- `{ type: "result", patch: {...}, usage: {...} }` — パース・検証済みパッチ
- `{ type: "error", message: "..." }`

サイズ上限 5MB。バリデーション（範囲・型）必須。

### パッチ形式（Claudeの構造化出力スキーマ）

```json
{
  "type": "object",
  "properties": {
    "edits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "frame": { "type": "integer" },
          "x": { "type": "integer" }, "y": { "type": "integer" },
          "rows": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["frame", "x", "y", "rows"],
        "additionalProperties": false
      }
    },
    "newFrames": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "insertAfter": { "type": "integer" },
          "rows": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["insertAfter", "rows"],
        "additionalProperties": false
      }
    },
    "paletteChanges": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": { "type": "integer" },
          "color": { "type": "string" }
        },
        "required": ["index", "color"],
        "additionalProperties": false
      }
    },
    "note": { "type": "string" }
  },
  "required": ["edits", "newFrames", "paletteChanges", "note"],
  "additionalProperties": false
}
```

- `edits[].rows`: パッチ矩形の行テキスト（グリッド表現と同じ文字割当て。`?` = そのセルは変更しない）。
- `newFrames[].rows`: フルサイズのフレーム。
- サーバー側で検証: frame範囲、座標がキャンバス内、rows の文字が正当、scope=selection のときは選択矩形外への edits を**切り捨てて**適用（警告をresultに含める）。ただし `newFrames` と `paletteChanges` は scope に関係なく許可。
- `note`: 何をしたかの一言（履歴ログに表示）。

## 6. Claude API 呼び出し（server.js 内・重要）

SDK は `@anthropic-ai/sdk` 最新（0.110系で動作確認済みのAPI形状）。**以下の形を正とし、古い記憶で書き換えないこと**:

```js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から解決

const stream = client.messages.stream({
  model: MODEL,                              // 既定 "claude-opus-4-8"（env MODEL で上書き可）
  max_tokens: 64000,
  thinking: { type: "adaptive" },            // budget_tokens は使わない（400になる）
  output_config: {
    effort: EFFORT,                          // 既定 "medium"（env EFFORT）
    format: { type: "json_schema", schema: PATCH_SCHEMA },  // 構造化出力
  },
  system: [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: userContent }],
});

stream.on("text", (delta) => /* SSE delta 転送 */);
const final = await stream.finalMessage();
// final.stop_reason === "refusal" / "max_tokens" はエラーとしてSSEで返す
// 正常時: content の text ブロックを JSON.parse → 検証 → { type:"result", patch } を送出
```

- `temperature` / `top_p` / `top_k` は**送らない**（対象モデルでは400）。
- アシスタントprefillは**使わない**（400）。
- クライアント切断時 `stream.abort()`。
- エラーは SDK の型付き例外で分岐（`Anthropic.AuthenticationError` → 「ANTHROPIC_API_KEY を設定してください」等の日本語メッセージ）。

### userContent の構成

`content` は配列で、**画像ブロック + テキストブロック**:

1. 対象フレーム（scope=all なら全フレーム、それ以外は対象フレームと前後1フレーム）を**8倍最近傍拡大したPNG**の base64 画像ブロック。サーバー側で生成する必要はない — **クライアントがcanvasで生成して data URL をリクエストに含め、サーバーはそれを** `{ type: "image", source: { type: "base64", media_type: "image/png", data } }` **に変換**する（サーバーに画像ライブラリを入れないため）。リクエストJSONに `images: [{ frame: n, dataUrl } ]` を追加。
2. テキストブロック: パレット一覧（index: hex）、全フレームのテキストグリッド、キャンバスサイズ、fps、対象スコープと選択矩形、編集指示。

### SYSTEM_PROMPT の要点（日本語で書く）

- 役割: ドット絵アニメーションの精密編集エンジン。
- グリッド文字割当ての説明（`.` = 透明、`1`-`9a-v` = パレット index、`?` = 変更しない）。
- 最小差分の原則: 指示に必要なセルだけを edits に含める。無関係なセルは `?`。
- アニメーションの一貫性: 複数フレームにまたがる編集では動きの連続性を保つ。中割り指示では前後フレームを補間。
- 画像はプレビュー参考、**正はテキストグリッド**。
- 出力はスキーマに従うJSONのみ。

## 7. MOCKモード

`MOCK=1` で起動するとAPIを呼ばず、選択範囲（なければフレーム全体の中央8×8）をパレット最後の色で塗るパッチを2秒かけて疑似ストリーミングで返す。UI・SSE・パッチ適用の動作確認用。READMEに記載。

## 8. GIFエクスポート

- `gif.js` に GIF89a エンコーダを自前実装（LZW圧縮含む。数百行で書ける定番実装）。パレット≤32色・256色以下なのでグローバルカラーテーブルで単純に実装可。透明は disposal method 2 + transparent color flag。
- 「GIF書き出し」「スプライトシートPNG書き出し」（横並び1枚、canvas.toBlobで生成）「プロジェクトJSON保存/読込」をヘッダのメニューに置く。

## 9. 見た目

- ダークテーマ（エディタ系ツールの定番）。アクセント1色。システムフォントでよいが等幅数字。
- 素朴でよいが、ボタン・パネルの余白と階層は整えること。日本語UI。

## 10. 初期データ

起動時に 32×32・8色・2フレームのサンプル（簡単なキャラが上下にバウンドする程度。ハードコードした配列でよい）を読み込み、すぐ再生・AI編集を試せる状態にする。

## 11. 検証（実装後に必ず行う）

1. `npm install && MOCK=1 npm start` でサーバー起動。
2. `curl` で `/api/config` と `/api/edit`（MOCK）のSSE応答を確認。
3. Playwright（`/opt/pw-browsers/chromium`、`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`。`playwright install` は実行しない）でページを開き、コンソールエラーがないこと、キャンバス・タイムライン・AIパネルが描画されること、MOCK編集を実行してパッチが適用されることをスクリーンショットで確認。
4. GIF書き出しが有効なGIFヘッダ（`GIF89a`）を持つBlobを生成すること（ページ内で検証）。

## 12. スコープ外（今回は作らない）

- レイヤー機能、Asepriteファイル入出力、APNG、タイルマップ、共同編集
- 128×128超のキャンバス（UIの上限で96に制限）
