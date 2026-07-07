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

---

## 13. 【コア要件・最優先】元画像ベースのモーション生成とテイスト保持

**このセクションは §1〜12 に追加される要件であり、優先度は最上位。** ユースケースの中心は「手持ちのドット絵キャラ画像をアップロードし、そのテイストを一切崩さずに歩き・走り・攻撃などのモーションを生成し、おかしい部分（足の左右など）を範囲指定で高速に直す」こと。

### 13.1 PNG画像インポート（必須機能）

ヘッダメニューに「画像を開く」を追加。PNG/GIF(1枚目)/WebP を受け付け:

1. canvasに描画してピクセルを読む。
2. **拡大率の自動検出**: 元画像が例えば 320×320 でも実体が 32×32 のドット絵である場合が多い。各行・各列の同色ラン長のGCDからドット1個のブロックサイズを推定し、最近傍で実寸グリッドにダウンサンプルする（検出結果はダイアログで「32×32として読み込みます」と確認、手動上書き可）。
3. **パレット抽出**: 出現色を頻度順に列挙。33色以上なら頻度上位31色+透明に量子化（各ピクセルは最近色へ。RGB距離）。抽出結果が実寸≦96×96・パレット≦32色に収まらない場合は縮小を促すメッセージ。
4. 読み込んだ画像は **frame 0 = ベースフレーム** としてセットし、`project.baseFrame`（Uint8Arrayのコピー）としても保持する。ベースフレームはタイムライン上で「基準」バッジ表示。

### 13.2 テイスト保持の5つの機構（このツールの存在理由）

1. **パレットロック（構造的保証）**: AI出力はパレットindexのグリッドのみ。色は定義上1色も変わらない。モーション生成モードでは `paletteChanges` をサーバー側で**破棄**する。
2. **ベースフレーム・アンカリング**: すべてのAIリクエストにベースフレームのグリッドを「唯一の正」として含める。システムプロンプトに追記: 「新規フレームは白紙から描くのではなく、ベースフレームのコピーから始めて、動きに必要なピクセルだけを移動・変更する。輪郭の太さ、シェーディングの段数、ドットの打ち方の癖を厳密に踏襲する」。
3. **ロック領域（変更禁止マスク）**: 矩形選択ツールに「この範囲をロック」ボタンを追加。ロック領域（複数可、半透明赤で表示、解除可）は `project.lockedRects` に保持し、リクエストに含める。サーバーはロック領域内セルへの edits / newFrames の該当セルを**ベースの値で強制上書き**して適用する（例: 顔はロックして体だけ動かす）。
4. **逸脱メーター**: 各フレームサムネイルの下に「ベースフレームとの差分率 %」を常時表示。モーションとして妥当な差分（手足周辺）か、テイスト崩れ（全面書き換え）かを一目で判別できる。40%超は警告色。
5. **差分ビュー**: トグルで「現在フレーム − ベースフレーム」の変更セルだけをハイライト表示（変更 = マゼンタ枠）。どこをAIが触ったかを即確認できる。

### 13.3 モーション生成モード（AIパネルに追加）

AIパネルを2タブにする: 「修正」（既存の §4 のパッチ編集）と「モーション生成」。

モーション生成タブ:

- **プリセット**: 歩き / 走り / 攻撃 / 待機 / ジャンプ + 自由入力欄
- **つまみ**（すべてプロンプトに文章として織り込む）:
  - フレーム数: 2〜12（既定: 歩き4、走り6、攻撃3、待機2、ジャンプ4）
  - 動きの大きさ: 小 / 中 / 大
  - 上下バウンス: あり / なし
  - 向き: そのまま / 横（右向き）/ 横（左向き）
- 実行するとベースフレームを基に `newFrames` で全フレームを生成し、既存フレーム（frame 0 のベース以外）を置き換えるか追記するかを選べる。
- 生成後は既存の「修正」タブ + 手描きツールで逐次修正するワークフロー。

**歩きモーション用のプロンプト知識をシステムプロンプトに埋め込む**（ユーザーが毎回指示しなくて済むように）: 4フレーム歩行 = コンタクト→ダウン→パッシング→アップ、左右の足は前後が入れ替わること、接地フレームで体が最も低いこと、腕は足と逆位相、など定石を明記。走り・攻撃・待機・ジャンプも同様に1〜2行の定石を書く。

### 13.4 リクエスト形式の変更

`POST /api/edit` のボディに追加:

```js
{
  mode: "patch" | "motion",
  baseFrameGrid: "....\n...",       // ベースフレームのグリッド（常に送る）
  lockedRects: [{x,y,w,h}, ...],
  motion: {                          // mode="motion" のとき
    preset: "walk" | "run" | "attack" | "idle" | "jump" | "custom",
    customText: "",
    frames: 4, magnitude: "medium", bounce: true, facing: "keep"
  },
  // 既存: project, scope, frameIndex, selection, instruction, images
}
```

画像ブロックは mode="motion" のときベースフレームのPNG（8倍拡大）を必ず含める。

### 13.5 期待値の明示（READMEに書く）

一発でプロ品質のモーションは出ない前提のツール設計であること。価値は「テイストが構造的に崩れない土台の上で、生成 → 逸脱メーターで確認 → 範囲指定して修正指示 → 手描き微調整、のループを数秒単位で回せる」ことにある、と README に明記する。
