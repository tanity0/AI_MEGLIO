// help.js — §21 設定ヘルプ（？アイコン + ポップオーバー）
// data-help="キー" を持つ要素の横に ? を自動挿入。ホバー+クリック/タップで表示、
// 同時に開くのは1つ、画面端で位置反転。ヘルプ文はこの辞書1箇所に集約。

// ---------------------------------------------------------------------------
// ヘルプ辞書（§21.2 対象を漏れなく。文体: 何が変わるか+どういう時に使うか）
// ---------------------------------------------------------------------------
export const HELP = {
  // 変換スタジオ（§18.2）
  "studio.targetH": "出力ドット絵の高さ（ピクセル数）を指定します。小さいほどドットが大きく単純に、大きいほど元の細部が残ります。まず64前後で試すのがおすすめです。",
  "studio.oneToOne": "グリッド推定で見つかった「描かれた時のドット」1個を出力1ピクセルにします。元がドット絵風の画像なら最も忠実ですが、出力が128pxを超える素材では使えません。",
  "studio.colors": "減色後の色数です。少ないほどドット絵らしく、多いほどグラデーションが残ります。肌や差し色が潰れるときは増やすか「彩度保護」を上げてください。",
  "studio.cellSize": "推定されたセルサイズ（ドット1個の元画像上の大きさ）を±0.25pxずつ調整します。出力が周期的に滲む・線が二重になるときに合わせ込んでください。",
  "studio.offset": "グリッドの位相（開始位置）を±1pxずつ動かします。ドットの境界とグリッドがずれてエッジが甘いときに調整します。「再推定」で自動推定からやり直せます。",
  "studio.domBlend": "セルの代表色を「最頻色（0=カリカリ）」と「平均色（1=なめらか）」のどちら寄りにするかです。ノイズの多い素材は少し上げると安定し、上げすぎると色が濁ります。",
  "studio.centerWeight": "セル中心付近のピクセルをどれだけ重視するかです。隣のドットの色が混入する（にじむ）ときに上げてください。",
  "studio.edgeProtect": "セル内に暗い輪郭色が含まれるとき、代表色より輪郭色を優先します。線が途切れる・細部が消えるときに上げてください。0でオフです。",
  "studio.satProtect": "使用面積は小さいが色相が独立した色（肌・差し色など）を減色時に消えにくくします。大事なワンポイント色が失われるときに上げてください。",
  "studio.bgThreshold": "背景とみなす色の許容幅です。背景が消え残るときは上げ、キャラの一部まで消えるときは下げてください。外周から繋がった領域だけが除去されます。",
  "studio.glowWidth": "背景との境目にある光彩・フチ（例: 紫のグロー）を、透明との境界から指定px幅で除去します。シルエット周りに背景色の粒が残るときに1〜3にしてください。",
  // 分割インポート（§20）
  "studio.split.single": "検出された複数のポーズを無視して、画像全体を1枚のドット絵として変換します。ポーズ分割が誤検出のときに選んでください。",
  "studio.split.components": "検出された各ポーズを1体ずつ切り出し、アニメーションのフレームとして読み込みます。共通パレット・共通キャンバスで足元（下端中央）を揃えます。",
  "studio.split.grid": "自動検出がうまくいかないシート向けに、画像を横N×縦Mの等間隔で機械的に分割してフレーム化します。各区画内の絵の周囲は自動で詰められます。",
  "studio.split.align": "各ポーズの配置を「下端中央（接地・歩きなどの足元が揃う）」から「中央（飛行・浮遊キャラ向け）」に変えます。",
  // トンマナ（§17）
  "style.image": "トンマナの基準となる参考画像を読み込みます（最大256×256に縮小して保存）。ゲームの既存スプライトを入れると世界観を揃えられます。",
  "style.analyze": "参考画像から頭身・輪郭・シェーディング・代表色などのスタイルガイド（テキスト）をAIで抽出します。CLIバックエンドでは小さなドット絵のみ解析できます。",
  "style.guide": "AIに渡されるスタイルの説明文です。このテキストが「正」なので、自由に編集して意図を追い込めます。",
  "style.enabled": "オンにすると、修正・モーション生成・リグ・配色などすべてのAIリクエストにこのガイドが「厳守すべきトンマナ基準」として添付されます。",
  // 修正タブ
  "patch.scope": "AIに編集させる範囲です。「選択範囲のみ」が最速・最安全。「全フレーム」は大きな素材では時間がかかります（CLIバックエンドではフレームごとに分割実行されます）。",
  "patch.refine": "選択範囲のラフな描き込みを、形はそのままに綺麗なドットの打ち方へ清書します。ペンで大雑把に直した後の仕上げに使ってください。指示欄が空でも実行できます。",
  "patch.paletteSwap": "ドットの形を変えずにパレットの色だけをAIが変更します。色違いの敵バリエーション作りに使い、結果は適用かバリエーション保存を選べます。",
  "patch.outlineRefine": "透明との境界±2pxだけをAIが清書します。変換直後に輪郭がガタつく・欠けるときに使ってください。",
  "tools.lock": "選択中の矩形を変更禁止のロック領域にします。AIが何を返してもロック内はベースの値に強制的に戻るので、顔などを守って体だけ編集させたいときに使います。",
  // モーション生成タブ
  "motion.preset": "生成するモーションの種類です。歩き・走りなどの定石（足の逆位相、接地で体が沈む等）が自動で適用されます。カスタムでは自由入力欄の指示が使われます。",
  "motion.frames": "生成するフレーム数（2〜12）です。多いほど滑らかですが生成時間が伸びます。プリセットを選ぶと推奨値が入ります。",
  "motion.magnitude": "手足の振りや移動量の大きさです。動きが地味なら「大」、暴れるなら「小」にしてください。",
  "motion.bounce": "歩行などに伴う体の上下動を付けるかどうかです。オフにすると胴体の高さが一定になります。",
  "motion.facing": "キャラの向きの扱いです。「そのまま」はベースの向きを維持、「横」は指定方向へ向き直して生成します。",
  "motion.candidates": "モーション作成の主経路（§25）です。フレームごとにK個の候補を並列生成し、ギャラリーで見比べて採用→全フレーム採用で確定するとタグ付きでタイムラインに追加されます。気に入らない候補は「描き直し」（追記指示+採用済み前後フレームを文脈に同梱）や「追加生成」で増やせます。1枚ずつの生成は重め（フルサイズ出力）なので、放置できるバッチとして codex バックエンドが推奨です。ChatGPT の画像生成を使う往復も推奨: 「GPT用依頼キットを書き出し」（依頼文はポーズ最優先・ドットの粒や質感は参照と違ってよい構成。画風はツール側の変換で合わせます）→ChatGPTに参照PNGと依頼文を貼る→出てきたシートを「画像から候補追加」（または gpt-exchange/in/ に保存で自動取り込み）→リテイクは差分採用マージで部位だけ取り込み。確定後の仕上げは、矩形選択+指示（修正タブ）やペンでラフ→部分仕上げが推奨ルートです。",
  "motion.apply": "生成結果の入れ方です。「置き換え」はフレーム0（ベース）以外を捨てて差し替え、「追記」は既存フレームの後ろに追加します。どちらも新しいタグが付きます。",
  // リグタブ
  "rig.register": "矩形選択した範囲をベースフレームから切り出し、リグのパーツ（腕・脚など）として登録します。",
  "rig.pivot": "パーツの回転の支点です。腕なら肩、脚なら股関節をプレビュー上でクリックして指定してください。ここがずれると回転が不自然になります。登録後もキャンバス上で十字マークをドラッグして動かせます。",
  "rig.partEdit": "リグタブ表示中は、キャンバス上のパーツ枠（±4px）をクリックしてパーツを選択できます。選択中は枠内ドラッグで矩形の移動、四隅・四辺の8ハンドルでリサイズ、pivot の十字ドラッグで支点移動ができます（1セル単位・キャンバス内にクランプ・Ctrl+Zで戻せます）。Esc または何もない場所のクリックで選択解除。矩形を変えるとベースフレームから切り出し直され、次のフレーム生成から反映されます。",
  "rig.z": "パーツの描画順です。小さいほど奥に描かれます。奥の腕を胴体の後ろにしたいときなどに調整します。",
  "rig.parent": "親パーツを設定すると、親の移動・回転に子が追従します（例: 胴を親にした頭）。",
  "rig.segment": "ベースフレームをAIが頭・胴・腕・脚などのパーツ矩形に自動分割します。大きな素材でも縮小グリッドで送るため高速です。結果は下書きなので、一覧で名前やpivotを調整してください。",
  "rig.heuristic": "AIを使わず、人型の定石（頭=上25%・胴=中央・腕=左右のはみ出し・脚=下35%）で即時にパーツ下書きを作ります。オフラインでも使え、AI分割がタイムアウトするときの代替にもなります。",
  "rig.preset": "キーフレームテーブルによるモーションの種類です。歩き4f・走り6fなどの定石値（左右脚の逆位相・接地で胴体最低）がそのまま入ります。",
  "rig.magnitude": "キーフレームの回転・移動量を0.5×〜1.5×にスケールします。",
  "rig.bounce": "胴体の上下動（キーフレームのdy成分）をオン/オフします。",
  "rig.frames": "生成フレーム数です。テーブルを線形補間して増減します（2〜12）。",
  "rig.apply": "生成結果の入れ方です。「置き換え」はフレーム0以外を差し替え、「追記」は末尾に追加します。",
  "rig.cleanup": "回転で生じたジャギーやパーツの継ぎ目を、合成で変化したセルの周囲2pxだけAIが軽く清書します。描き込みの少ないキャラや、描き直し後の最終仕上げに使ってください（推奨ルート: 描き直し→清書）。",
  "rig.redraw": "リグ合成の結果を「ポーズの設計図」として、線・シェーディング・ディテールをベースフレームに合わせてAIが描き直します。描き込みの多いキャラで機械回転が破綻するときの本命です。仕上げにAI清書を掛けるのが推奨ルートです。所要時間は対象領域のサイズにほぼ比例するので、時間がかかるときはパーツの「固定」で回転パーツを減らすか「回転した部位のみ」で領域を絞ってください。CLI系バックエンドは応答がまとめて届くため、進捗の数字が動かなくても（経過 …）が増えていれば実行中です。",
  "rig.redrawRotated": "回転（rot≠0）したパーツの移動前後の矩形と、親パーツとの継ぎ目±2pxだけを描き直します。平行移動はドット絵を劣化させないため対象外で、最小・最速の既定です。パーツの「固定」で回転パーツを減らすとさらに速くなります。",
  "rig.redrawMoved": "ベースから変化したセルの周囲5px+移動したパーツの矩形を描き直します。バウンスで全身が平行移動すると領域が全身に広がり時間がかかります。回転した部位が無いフレームでは自動的にこの方式になります。",
  "rig.redrawFull": "キャラの非透明範囲全体を描き直します。ポーズ変化が大きく他の2つでは継ぎ目が残るときに使ってください（最も時間がかかります）。",
  "rig.redrawAllFrames": "ONにすると生成タグの全フレームをまとめて描き直します。既定はOFF（現在のフレームのみ）です。時間と結果を見ながら1フレームずつ進め、まとめてやりたいときだけONにしてください。",
  "rig.redrawPromptExtra": "描き直しプロンプトの末尾に「## 追加の指示（ユーザー）」としてそのまま付加される実験用の欄です（空なら何も付加されません）。内容はブラウザに保存され、プロジェクトをまたいで維持されます。うまくいった文言は 👍/👎 のフィードバックや報告で共有してもらえれば、標準プロンプトに取り込みます。",
  "rig.adjust": "選択パーツの位置(±1px)と回転(±15°)をフレーム単位で微調整します。「キャンバスでドラッグ移動」をオンにするとキャンバス上でつかんで動かせます。",
  // タグ
  "play.mode": "プレビュー再生の順序です。「通常」は最後まで行くと先頭へ戻るループ、「ピンポン」は端で折り返す往復再生（端フレームは重複しません。4フレームなら 1,2,3,4,3,2,…）。設定はプロジェクトJSONに保存され、ギャラリーのミニプレビューにも効きます。GIF書き出しは隣の「ピンポン」チェックで往復展開されます（フレーム数は 2N-2）。",
  "tag.fps": "このタグ（モーション）だけの再生速度です。プロジェクト全体のfpsとは独立で、書き出しJSONのフレーム時間にも使われます。",
  "tag.loop": "タグ再生をループさせるかどうかです（書き出しメタにも記録されます）。",
  // 書き出しパネル
  "export.format": "sheet+json はエンジン取り込み向け（Aseprite互換メタ付き）、strip-per-tag はタグごとの横並びPNG、frames は連番PNGです。迷ったら sheet+json を選んでください。",
  "export.scale": "書き出し時の整数拡大率です。ゲーム側で拡大しない運用なら2〜4を指定します（最近傍でくっきり拡大）。",
  "export.mirror": "プロファイルが mirror:\"export\" のとき、左右反転版タグ（walk_left など）も書き出します。非対称なキャラはタグごとにオフにできます。",
  "export.variants": "保存した配色バリエーションぶんのファイルも一括で書き出されます。不要なものはここで削除できます。",
  "export.dest": "ブラウザダウンロードか、EXPORT_ROOT で指定したゲームリポジトリへの直接書き込みかを選びます（サーバー起動時に EXPORT_ROOT=パス が必要）。",
  // プロファイル
  "profile.select": "ゲームごとの書き出し規約（出力先・形式・命名・必要モーション）をまとめたプロファイルを選びます。public/profiles/ にJSONを置くと追加できます。",
  "profile.checklist": "プロファイルが要求するモーションタグの充足状況です。✗をクリックすると、そのモーションの生成設定に直行します。",
  // 表示系
  "view.onion": "前のフレームを半透明で重ねて表示します。アニメの動き幅を確認しながら描くときにオンにしてください。",
  "view.diff": "ベースフレームから変わったセルだけをマゼンタ枠で表示します。AIがどこを触ったかを即確認できます。",
  "rig.partVisible": "このパーツをフレーム生成の合成に含めるかどうかです。外すと次の「フレーム生成」からそのパーツ抜きで組み立てられます（パーツ自体は削除されません。削除は右の「削除」ボタン）。",
  "rig.partFixed": "ONにすると、このパーツにプリセットの動き（腕振りなど）を適用せず、胴と同じ変換だけ（上下バウンスへの追従）にします。「腕は動かさないで歩かせたい」ときに使ってください。左のチェック（合成に含める＝外すと消える）とは別物で、固定してもパーツは表示されたままです。次のフレーム生成から反映されます。",
  "rig.partRole": "プリセットモーションでこのパーツがどう動くかの対応付けです。右脚/左脚=前後スイング（左右で逆位相）、右腕/左腕=脚と逆位相の振り、武器=腕に追従して振る、頭/胴/その他=バウンス（上下動）のみ。未選択時は名前から自動推定しますが、ここで選んだ役割が推定より常に優先されます（「固定」がONのときは固定が最優先）。次のフレーム生成から反映されます。",
  "edit.undo": "直前の操作を取り消します（Ctrl+Z）。ペンの1ストローク、AI編集、フレーム操作などが1回分です。履歴は50回まで。",
  "preview.smooth": "プレビューの拡大方法を切り替えます。OFF=補間なし（ドットがカクカク立つ、ゲーム側でnearest指定した時の見え方）、ON=バイリニア補間（多少滲む、Pixi等のデフォルトの見え方）。実機の描画設定に合わせて確認できます。",
  "meter.deviation": "ベースフレームと異なるセルの割合です。手足が動く程度なら小さく、全面書き換え（テイスト崩れ）だと大きくなります。40%超は警告色になります。",
};

// data-help を自動付与するセレクタ → キーの対応（辞書と同じファイルに集約）
const SELECTOR_MAP = [
  ['#undoBtn', "edit.undo"],
  ['label:has(#previewSmoothToggle)', "preview.smooth"],
  // 変換スタジオ
  ['label:has(#studioTargetH)', "studio.targetH"],
  ['label:has(#studioOneToOne)', "studio.oneToOne"],
  ['label:has(#studioColors)', "studio.colors"],
  ['#studioSizeMinus', "studio.cellSize"],
  ['#studioRegridBtn', "studio.offset"],
  ['label:has(#studioDomBlend)', "studio.domBlend"],
  ['label:has(#studioCenterWeight)', "studio.centerWeight"],
  ['label:has(#studioEdgeProtect)', "studio.edgeProtect"],
  ['label:has(#studioSatProtect)', "studio.satProtect"],
  ['label:has(#studioBgThreshold)', "studio.bgThreshold"],
  ['label:has(#studioGlowWidth)', "studio.glowWidth"],
  // トンマナ
  ['label[for="styleUploadInput"]', "style.image"],
  ['#styleAnalyzeBtn', "style.analyze"],
  ['#styleGuideText', "style.guide"],
  ['label:has(#styleEnabledToggle)', "style.enabled"],
  // 修正タブ
  ['#patchTab .scope-fieldset legend', "patch.scope"],
  ['#refineBtn', "patch.refine"],
  ['#paletteSwapBtn', "patch.paletteSwap"],
  ['#outlineRefineBtn', "patch.outlineRefine"],
  ['#lockSelectionBtn', "tools.lock"],
  // モーション生成タブ
  ['label:has(#motionPreset)', "motion.preset"],
  ['label:has(#motionFrames)', "motion.frames"],
  ['label:has(#motionMagnitude)', "motion.magnitude"],
  ['label:has(#motionBounce)', "motion.bounce"],
  ['label:has(#motionFacing)', "motion.facing"],
  ['#motionTab .scope-fieldset legend', "motion.apply"],
  // リグタブ
  ['#registerPartBtn', "rig.register"],
  ['#pivotLabel', "rig.pivot"],
  ['label:has(#partZInput)', "rig.z"],
  ['label:has(#partParentSelect)', "rig.parent"],
  ['#partList', "rig.partEdit"],
  ['#segmentBtn', "rig.segment"],
  ['#heuristicSegmentBtn', "rig.heuristic"],
  ['label:has(#rigPreset)', "rig.preset"],
  ['label:has(#rigMagnitude)', "rig.magnitude"],
  ['label:has(#rigBounce)', "rig.bounce"],
  ['label:has(#rigFrames)', "rig.frames"],
  ['#rigTab .scope-fieldset legend', "rig.apply"],
  ['#rigCleanupBtn', "rig.cleanup"],
  ['#rigRedrawBtn', "rig.redraw"],
  ['.rig-adjust > .hint:first-child', "rig.adjust"],
  // タグフォーム
  ['#tagForm label:has(#tagFpsInput)', "tag.fps"],
  ['#tagForm label:has(#tagLoopInput)', "tag.loop"],
  // 書き出しパネル
  ['label:has(#exportFormatSelect)', "export.format"],
  ['label:has(#exportScaleInput)', "export.scale"],
  ['#exportMirrorList', "export.mirror"],
  ['#exportVariantList', "export.variants"],
  ['#exportPanel .scope-fieldset legend', "export.dest"],
  // プロファイル
  ['.profile-row', "profile.select"],
  ['#tagChecklist', "profile.checklist"],
  // 表示系
  ['label:has(#onionSkinToggle)', "view.onion"],
  ['label:has(#diffViewToggle)', "view.diff"],
];

// ---------------------------------------------------------------------------
// ポップオーバー（単一・排他・画面端反転）
// ---------------------------------------------------------------------------
let popover = null;
let currentAnchor = null;
let sticky = false;

function ensurePopover() {
  if (popover) return popover;
  popover = document.createElement("div");
  popover.className = "help-popover";
  popover.hidden = true;
  document.body.appendChild(popover);
  return popover;
}

function showHelp(anchor, key) {
  const text = HELP[key];
  if (!text) return;
  const pop = ensurePopover();
  pop.textContent = text;
  pop.hidden = false;
  currentAnchor = anchor;
  const r = anchor.getBoundingClientRect();
  pop.style.left = "0px";
  pop.style.top = "0px";
  const pw = Math.min(300, window.innerWidth - 20);
  pop.style.maxWidth = pw + "px";
  // 一旦表示して実サイズを測る
  const rect = pop.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 6;
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8; // 右端反転
  if (top + rect.height > window.innerHeight - 8) top = r.top - rect.height - 6; // 下端反転
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hideHelp(force = false) {
  if (sticky && !force) return;
  if (popover) popover.hidden = true;
  currentAnchor = null;
  if (force) sticky = false;
}

function attachHandlers(anchor, key) {
  anchor.addEventListener("mouseenter", () => {
    if (!sticky) showHelp(anchor, key);
  });
  anchor.addEventListener("mouseleave", () => hideHelp());
  // チェックボックス等の操作可能な要素は、クリックを奪うと本来の機能が死ぬため
  // ホバー表示のみとする（ヘルプの固定表示は?アイコンと非操作要素だけ）
  if (anchor.matches("input, select, textarea") && !anchor.classList.contains("help-icon")) return;
  anchor.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (sticky && currentAnchor === anchor) {
      hideHelp(true); // もう一度タップで閉じる
    } else {
      sticky = true; // クリック/タップで固定表示（排他）
      showHelp(anchor, key);
    }
  });
}

// ---------------------------------------------------------------------------
// data-help 要素の処理: ? アイコン挿入（動的要素は MutationObserver で追従）
// ---------------------------------------------------------------------------
function processElement(el) {
  if (el.dataset.helpDone) return;
  el.dataset.helpDone = "1";
  const key = el.dataset.help;
  if (!HELP[key]) {
    console.warn(`help.js: 辞書に無いキーです: ${key}`);
    return;
  }
  const icon = document.createElement("button");
  icon.type = "button";
  icon.className = "help-icon";
  icon.textContent = "?";
  icon.setAttribute("aria-label", "ヘルプ");
  icon.tabIndex = 0;
  attachHandlers(icon, key);
  const tag = el.tagName;
  if (tag === "LABEL" || tag === "LEGEND" || tag === "SPAN") {
    el.appendChild(icon); // ラベル類はテキストの直後に内包
  } else {
    // ボタン等（誤クリック防止）と、innerHTMLが再描画されるコンテナは隣に置く
    el.insertAdjacentElement("afterend", icon);
  }
}

function processHoverElement(el) {
  if (el.dataset.helpDone) return;
  el.dataset.helpDone = "1";
  const key = el.dataset.helpHover;
  if (!HELP[key]) return;
  attachHandlers(el, key);
}

function scan(root) {
  if (root.matches?.("[data-help]")) processElement(root);
  if (root.matches?.("[data-help-hover]")) processHoverElement(root);
  root.querySelectorAll?.("[data-help]").forEach(processElement);
  root.querySelectorAll?.("[data-help-hover]").forEach(processHoverElement);
  // 逸脱メーター（動的生成）にはホバーヘルプを自動付与（§21.2）
  root.querySelectorAll?.(".deviation:not([data-help-hover])").forEach((el) => {
    if (!el.textContent) return;
    el.dataset.helpHover = "meter.deviation";
    processHoverElement(el);
  });
}

export function initHelp() {
  // 静的セレクタへ data-help を付与（辞書と同じファイルで一元管理）
  for (const [selector, key] of SELECTOR_MAP) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        if (!el.dataset.help) el.dataset.help = key;
      });
    } catch {}
  }
  scan(document.body);

  // 動的に増える要素（タグフォーム・逸脱メーター等）に追従
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 外側クリック / Escape で閉じる
  document.addEventListener("click", (ev) => {
    if (popover && !popover.hidden && !popover.contains(ev.target)) hideHelp(true);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideHelp(true);
  });

  // E2E/網羅チェック用
  window.aiMeglioHelp = { HELP, SELECTOR_MAP };
}
