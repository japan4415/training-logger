# Atlasと種目の筋肉対応

Human Atlas / BodyParts3DのメッシュID（FJ形式）を、保存・選択・描画の基準とする。左右、筋頭、筋部を分離したIDをそのまま使用し、描画時に筋肉名の部分一致で選択しない。表示名は読みやすい筋肉群にまとめるが、保存された選択範囲を広げない。

Atlasは形状と識別子の資料であり、各運動での筋活動そのものの資料ではない。種目の一般的な動作と以下の出典をもとに、主な対象・補助/安定化へ分類した初期値を用意する。個々の筋頭への分解や補助筋の選択には関節動作に基づく推論を含む。筋活動や負荷量の実測ではない。

- カタログ: `src/domain/atlas.ts` と `public/models/human-atlas/atlas.json`。150筋肉メッシュを収録。元資料の誤ったsystem分類3対のみmuscularへ補正し、元ID・名称・形状は保持。
- 初期プロファイル: `src/domain/atlas-profiles.json`。14種目の具体的なID、明示的な別名、前提、出典を管理。
- 初期移行: `migrations/0002_atlas_muscles.sql`。旧部位メモは保持し、名前が完全一致する既存種目だけに構造化した割当を保存。
- 新しい種目: 既知名には同じ既定値を使用。未知名は推測せず従来の部位メモによる参考表示とする。MCPでカタログを確認し、割当を保存できる。
- `primary` / `secondary` が両方に含むIDはprimary優先。`unavailable`には収録されない筋肉名を保存する。空オブジェクト配列は明示的に対象なし、NULLは従来表示への復帰。
- 広背筋・腹直筋は元Atlasにも存在しない。ラットプルダウンの主対象を大円筋に、腹直筋を外腹斜筋に置き換えない。
- 透過表示は、深部・反対側を含む選択筋を位置を保ったまま前面表示する。実際の表層との前後関係を確認する場合はオフにする。

## 初期対応表

両側を対象とする一般的な動作の初期値。片側種目やフォームの違いはMCPで個別IDへ変更できる。「主な対象」は柔軟種目ではストレッチ・可動域の対象、有酸素では使用筋として読む。

| 種目 | 主な対象（収録筋） | 補助・安定化（収録筋） | 未収録 | 前提・出典 |
|---|---|---|---|---|
| トレッドミルウォーキング | 腓腹筋、ヒラメ筋、大腿直筋、中間広筋、外側広筋、内側広筋、大殿筋 | 大腿二頭筋、半膜様筋、半腱様筋、中殿筋、小殿筋、前脛骨筋、腸骨筋、大腰筋 | — | 有酸素運動としての使用筋。速度・傾斜によって寄与は変わる。 [出典](https://pmc.ncbi.nlm.nih.gov/articles/PMC4423744/) |
| ストレッチボード | 腓腹筋、ヒラメ筋 | — | — | ふくらはぎのストレッチ対象。主働筋・筋力負荷の意味ではない。 [出典](https://www.healthnz.govt.nz/health-topics/conditions-treatments/bones-and-joints/calf-stretch-exercises) |
| バンド肩回し | 三角筋（前部）、三角筋（中部）、三角筋（後部） | 大胸筋、棘下筋、肩甲下筋、棘上筋、小円筋、僧帽筋（下部）、僧帽筋（上部） | — | バンドのパススルーによる可動域運動を想定した対象筋。抵抗外旋等とは異なる。 [出典](https://orthoinfo.aaos.org/globalassets/pdfs/2022-rotator-cuff-and-shoulder-conditioning-program.pdf) |
| ベンチステップ | 大腿直筋、中間広筋、外側広筋、内側広筋、大殿筋 | 大腿二頭筋、半膜様筋、半腱様筋、腓腹筋、ヒラメ筋、中殿筋、小殿筋 | — | 台の昇降を想定。一般的な関節動作からの筋分解。 [出典](https://www.acefitness.org/resources/everyone/exercise-library/28/step-up/) |
| バランスボールスクワット | 大腿直筋、中間広筋、外側広筋、内側広筋、大殿筋 | 大腿二頭筋、半膜様筋、半腱様筋、腓腹筋、ヒラメ筋 | — | 壁と背中でボールを挟むスクワットを想定。 [出典](https://www.acefitness.org/resources/everyone/exercise-library/experience/beginner/?page=7) |
| カーフレイズ | 腓腹筋、ヒラメ筋 | — | — | 立位型を想定。座位型では対象の比重が異なる。 [出典](https://www.healthnz.govt.nz/health-topics/conditions-treatments/bones-and-joints/calf-stretch-exercises) |
| カイザーチェストプレス | 大胸筋 | 上腕三頭筋、三角筋（前部） | — | 水平プレスを想定。メーカーではなく動作に対応。 [出典](https://www.nasm.org/resource-center/exercise-library/chest-press-machine) |
| ラットプルダウン | — | 大円筋、上腕二頭筋、上腕筋、腕橈骨筋、僧帽筋（下部）、大菱形筋、小菱形筋 | 広背筋 | 主対象の広背筋はAtlas未収録。大円筋への置換はしない。 [出典](https://www.acefitness.org/resources/everyone/exercise-library/158/seated-lat-pulldown/) |
| グッドモーニング | 大腿二頭筋、半膜様筋、半腱様筋、大殿筋 | 腰腸肋筋、胸腸肋筋、胸最長筋、胸棘筋、大内転筋 | — | 股関節伸展。股関節を跨がない大腿二頭筋短頭は含めない。 [出典](https://www.nasm.org/resource-center/exercise-library/good-mornings) |
| アダクター | 大内転筋、長内転筋、短内転筋、小内転筋 | 薄筋、恥骨筋 | — | 内転動作。姿勢で各筋の寄与が変わる。 [出典](https://www.acefitness.org/continuing-education/prosource/may-2016/5893/functional-anatomy-series-the-adductors/) |
| アブダクター | 中殿筋、小殿筋 | 大腿筋膜張筋 | — | 外転動作。大殿筋上部線維を分離できないため全大殿筋を指定しない。 [出典](https://sportsmedref.amssm.org/physical-examination/hip-buttocks-pelvis/) |
| シーテッドロウ | 大菱形筋、小菱形筋、僧帽筋（中部） | 上腕二頭筋、上腕筋、腕橈骨筋、三角筋（後部）、大円筋、僧帽筋（下部） | 広背筋 | 胸の前へ引くロウを想定。主対象の広背筋はAtlas未収録。 [出典](https://www.nasm.org/resource-center/exercise-library/seated-machine-row-close-grip) |
| バタフライ | 大胸筋 | 三角筋（前部） | — | 胸のペックデックを想定。リアデルト用の逆向き動作ではない。 [出典](https://www.acefitness.org/certifiednews/images/article/pdfs/ACE_BestChestExercises.pdf) |
| レッグレイズ | 腸骨筋、大腰筋 | 外腹斜筋、大腿直筋 | 腹直筋 | 股関節屈曲と体幹安定化を区別。腹直筋を外腹斜筋で代用しない。 [出典](https://pmc.ncbi.nlm.nih.gov/articles/PMC4792997/) |

## 更新時の検証

全割当IDのカタログ実在、主要筋と補助の重複排除、未知IDでDBが変わらないこと、既存テキストを保持した移行、セッションの完了種目のみの集計、種目詳細のhtmx期間変更時にモデルが重複しないことをテストする。モデルを追加した場合は元バイナリとの一致・索引範囲・圧縮サイズも確認する。

初期migrationの生成スクリプトは `scripts/generate-atlas-migration.mjs`。適用後に再生成して既存migrationを書き換えず、将来のDB更新は新しいmigrationで行う。MCPによる個別の設定変更は全割当の置換であり、以後は名称から自動的に再解釈しない。
