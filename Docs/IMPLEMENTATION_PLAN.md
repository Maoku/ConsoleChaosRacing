# ConsoleChaosRacing 実装計画書

`Docs/PLAN.md`（要求仕様）に対する実装計画。同梱エンジン `reference/console-chaos-engine-0.2.0.tgz`（`@console-chaos/engine@0.2.0`）と `public/assets/` の既存アセットを実測したうえで作成している。

- 対象: 1 アプリで FC / SFC / PS1 / PS2 の 4 世代表現を切り替えられるサーキットレース
- 不変条件: **シミュレーションは 1 つ。世代は表示と入出力の作法だけを変える**
- 作成日: 2026-08-12
- 更新: 2026-08-12（エンジン導入完了・更新版 README を反映・`car-conversion.json` のパス修正を反映・§9 の決定事項 6 項目を反映）
- 更新: 2026-08-12（フェーズ 0・1 の実装完了を反映。**エンジン 0.2.0 への更新を反映** — スプライトのシーン統合・`HardwareBlendCommand`・第3世代の 12 スロット ordering table）
- 更新: 2026-08-12（フェーズ 3 の実装完了を反映 — 走査線 `width ≤ 1` が「路面が細くなれる限界」も決めること・`BackgroundCommand.parallax` が読まれないこと・生成アセットの色はマスターパレットに載せること）
- 更新: 2026-08-13（フェーズ 4 の実装完了を反映 — 第2世代の**半透明スプライトだけがシーンへ直接合成される**こと・`AffineSurfaceCommand` に明るさの項が無いこと・アフィン面の `wrap` と V の扱い）
- 更新: 2026-08-13（フェーズ 5 の実装完了を反映 — **遠景の層と環境マップで flipY の要求が逆**なこと・落ち影の形が `transform.scale` に縛られること・ordering table が第3世代専用パスであること・初回ロードの実測）
- 更新: 2026-08-13（フェーズ 6 の実装完了を反映 — 役割がチャンネルへ 1 対 1 で割り当たること・編曲ごとの同時発音数の実測・エンジン音の予約に上限が要ること）
- 更新: 2026-08-13（フェーズ 7 の実装完了を反映 — **矩形に使うアトラスのセルは全面を埋める**必要があること・字送りが `tileSnap` から導けること・画面の文字の配置を割合ではなくミニマップの矩形から決めること）
- 更新: 2026-08-13（実画面を見たうえでの改良項目 8-1〜8-8 を**フェーズ 8 に追加** — 直線でのステアフレーム・アフィン面の BG スペック準拠・タコメーター・カメラ距離・視点切り替え・背景オブジェクト・数字キーでの世代選択・チャンネル表記の世代表示）
- 更新: 2026-08-14（**改良項目 8-11 中央の破線がアフィン歪みで折れるのを直す、を追加し実装完了を反映** — テクスチャの模様が四角形の境目に跨がると、アフィン補間の u が三角形ごとに別々の傾きを持つため線が割れること・**歪みを消さずに縁だけを頂点にする**のが第3世代での正解であること・帯の定義をテクスチャ生成とメッシュ分割で共有すること）
- 更新: 2026-08-14（**改良項目 8-9 トンネル区間・8-10 第4世代の背景オブジェクトの高品質化を追加し、実装完了を反映** — 坑口は「穴の開いた壁」1 本の式で外からも中からも出ること・擬似3D の坑口は BG タイル面の扱いにすること・第1世代のマスターパレットに暗い無彩色が無いこと・金網は独立した帯でないと網目が読めないこと・路面アトラスの帯を `TRACK_ATLAS` へ集約したこと）
- 更新: 2026-08-13（**フェーズ 8 の実装完了を反映** — 8-1〜8-8 をすべて実施し、§6.1 の全基準を実画面で計測して `Docs/QUALITY_REVIEW.md` に記録した。確定した事実: **同時色数の実測は 4 世代で 20 / 207 / 2,877 / 32,825 色**・スロット 0..9 の中身はレンダラーが view depth で安定ソートすること・スクリーン空間スプライトにも `rotation` が効くこと・遠景も BG のタイル制約に載せられること）

---

## 1. 現状と前提

### 1.1 すでにある物

| 物 | 場所 | 状態 |
| --- | --- | --- |
| 要求仕様 | `Docs/PLAN.md` | 確定 |
| エンジン | `@console-chaos/engine@0.2.0`（`reference/*.tgz` から導入済み） | ESM / ES2022 / WebGL2 必須。`package.json` / `package-lock.json` あり。0.1.0 からの変更は `RELEASE_NOTES.md` |
| 車ソース GLB | `data/gen3_car.glb`, `data/gen4_car.glb` | 変更禁止 |
| 変換済み車モデル | `public/assets/gen{3,4}/models/car.glb` | 978 tri / 13,618 tri、前方 `-X`。**skin・animation・material・image をすべて持たない**（変換で除去済み） |
| 車テクスチャ | `public/assets/gen{3,4}/textures/car_base_color.png` | 256² / 1024² |
| 車スプライト | `public/assets/gen{1,2}/sprites/cars.png` | 384×256 = **3 列 × 2 行 / 1 セル 128²**、黄=自機・赤=ライバル、左傾き/正面/右傾きの 3 フレーム |
| 路面テクスチャ | `public/assets/gen1/road/road.png` (256²), `public/assets/gen2/tiles/circuit.png` (256²) | 縦方向にタイルする直線路（草・赤白縁石・破線センターライン） |
| 遠景 | `public/assets/gen{1,2}/backgrounds/coast.png` | 512×192、横タイル可（空・雲・山・海） |
| 環境マップ | `public/assets/gen4/environment/circuit.png` | 1024×512 の 2:1 正距円筒。サーキット＋海岸＋ピット |
| フォールバック | `public/assets/common/fallback.png` | 128² |
| 変換記録 | `public/assets/car-conversion.json` | SHA-256 / 三角形数 / bounds を保持。**パスはリポジトリルート相対に修正済み**（`data/...`, `public/assets/...`） |

### 1.2 まだ無い物

- ビルド設定（`tsconfig.json` / `vite.config.ts` / `index.html`）とソースコード
- ルート `README.md`（セットアップ手順。§2.5 の決定により必須）
- HUD 用ビットマップフォントアトラス・タイトルロゴ・ミニマップ関連アセット（§2.6 で新規生成する）
- 第3・第4世代のコースメッシュ GLB とその路面テクスチャ（§2.6）
- サーキットのコース定義データ
- BGM の Score データ

### 1.3 エンジン実測で確定した制約（重要）

配布物の `dist/` を読んで確認した事実。設計はこれを前提に組む。

> 0.1.0 時点の実測に、フェーズ 0・1 の実装で確かめた事実と、**0.2.0 で変わった点**を反映している。
> 「（0.2.0）」と書いた行は 0.2.0 で挙動が変わった、または新しく使えるようになったもの。
> 0.2.0 の追加フィールドはすべて省略可能で、旧 `blendMode` も互換入力として残るため、
> 0.1.0 向けに書いたコマンドはそのまま動く。

| 事実 | 影響 |
| --- | --- |
| `RasterSurfaceCommand` は `profile.video.rasterScroll` が真の世代（**FC のみ**）でしか描かれない | 第1世代のラスタースクロールは FC 専用パス |
| `AffineSurfaceCommand` は `profile.video.affinePlane` が真の世代（**SFC のみ**）でしか描かれない | 第2世代のアフィン変換は SFC 専用パス |
| `OverlayCommand`（text/rect）は **Canvas 2D レンダラーでしか描画されない**。`createGenerationWebGlRenderer` は overlays を無視する | **HUD をテキストコマンドで作れない**。スクリーン空間スプライト＋自前フォントアトラスで作る（§3.5） |
| `SpriteCommand` は **4 世代すべてで描かれる**（0.2.0）。`profile.video.spriteComposition` が `separate-plane`（FC / SFC）か `scene`（PS1 / PS2）かで合成の経路だけが変わる | HUD もミニマップも 1 つのスプライト経路で書ける。分岐が要る場所（走査線制限・重ね順）は世代 ID ではなく `spriteComposition` を見る |
| 半透明は `HardwareBlendCommand` で世代ごとの作法を明示する（0.2.0）。`profile.video.translucency` が `none`（FC）/ `color-math`（SFC）/ `fixed-rate`（PS1・4 固定モード）/ `gs-alpha`（PS2）| 「半透明パネル」は各世代の実機の作法で出す。`generations` と blend の family が食い違うと `assertHardwareBlendGenerations` が **throw** するので、コマンドの `generations` は必ずその世代に絞る |
| 第3世代の描画順は **12 スロットの ordering table**（0.2.0）。既定は opaque world が 1..8、半透明が 9、スクリーン空間スプライトが 10、debug が 11。同じスロット内では登録順が安定して保たれる | HUD は積んだ順がそのまま重ね順になる。`orderTableIndex` で固定スロット、`polygonSortRange` で三角形単位の安定 partition 範囲を指定できる |
| 旧 `blendMode` は互換入力として維持され、内部で portable blend へ変換される（0.2.0） | 既存コードは動くが、世代表現を出したい箇所は `hardwareBlend` へ移す |
| `MeshCommand.material` は必須。フレームに同 id の `MaterialCommand` が無いと `throw` する | すべてのメッシュに material を必ず積む |
| `SpriteCommand.texture` は**アトラス URL**として解決される（`manifest.atlases` に登録が必要）。単体テクスチャは不可 | `cars.png` と HUD フォントはアトラス登録する |
| アトラスのセル UV は `columns` / `rows` で機械的に等分される（`cell = row * columns + col`）。**セルの中の透明な余りもそのまま引き伸ばされる**（フェーズ 7 で確定） | スプライトを**矩形として使う**セル（HUD やタイトルのパネル）は、絵をセルいっぱいに焼かないと指定した寸法まで広がらない。フォントの塗りつぶしセルを字形と同じ 5×7 で焼いたとき、パネルが 5/8 × 7/8 にしか出なかった（§3.5） |
| 非スキンメッシュのテクスチャは GLB からは引かれない。`MaterialCommand.baseColorTexture`（URL）で指定する | 車の base color は manifest とマテリアルの両方に書く。runtime GLB は material も image も持たないので**指定を忘れると fallback 柄になる** |
| `profile.video.animationHz` をレンダラーが適用するのは **`SkinnedMeshCommand.animationTime` の量子化のみ**（`floor(t*hz)/hz`）。実測した車 GLB は skin も animation も持たない | 6/12/30/60Hz の「見た目の更新レート」は**ゲーム側で量子化する**（§3 冒頭） |
| `MeshCommand.asset` に `manifest.models` の URL を指定するとその GLB の全プリミティブを描く | コースメッシュも GLB として供給できる |
| `TransformCommand` の回転は `rotationY` のみ。X/Z 軸の傾きは表現できない | バンク角つきコースは**メッシュを事前生成**するしかない（`tools/build-track-mesh.mjs`） |
| `quadMesh` は XZ 平面・上向き・`[-1,1]`。`geometry.kind:'quad'` は `halfSize` で XZ にスケールされる | 平坦な路面の暫定表現には使えるが、傾けられない |
| PS1 は `depthBuffer:false`。0.2.0 では距離順のソートに代えて **view-space depth に基づく 12 スロットの安定 ordering table** を走査する。`MaterialCommand.polygonSort` / `RenderModelAsset.polygonSort` に加えて `polygonSortRange` で三角形単位の安定 partition 範囲を指定できる | 第3世代は面のちらつきが出る前提で組む（当時の表現そのもの）。前後関係を確実にしたい要素は `orderTableIndex` で固定スロットへ置く |
| `rasterSurfaces` / `affineSurfaces` は**背景の後・メッシュの前**に描かれる | 路面サーフェス上に車スプライトを重ねられる |
| ラスタールックアップは **8bit に量子化**されて GPU に渡る（`createRasterLookupEncoder`）。center / width / sourceV / brightness の各値が 1/255 刻み | 近距離行の路面幅が段付きになる。当時の HDMA テーブルと同じ性質なので**そのまま採用する** |
| `RasterSurfaceCommand` の scanline `width` は **(0, 1] に制限**され、範囲外は `throw` | 第1世代の描画距離に上限が生まれる（§3.2 で数式化）。**さらに `roadPx = roadFraction × 画面幅 / width` なので、路面が細くなれる限界も同じ制限が決める** — 路面テクスチャの `roadFraction` を小さく作る以外に手が無い |
| ラスターの `center` / `sourceV` は 8bit へ書き出すとき `fract` される（`createRasterLookupEncoder`） | [0, 1) を出た `center` は路面を反対側から巻き戻して出す。CPU 側で丸める |
| `BackgroundCommand.parallax` は **WebGL レンダラーが読まない**。効くのは `repeat[0]` / `offset[0]` / `placement.bottom + offset[1]` / `placement.height` の 4 つだけ。層は**遠景・近景の 2 枚まで**で、テクスチャを持たない背景 1 つが空の階調（`color` が下端・`secondaryColor` が上端）と `brightness` を決める | 視差はゲーム側で `offset` へ畳み込む（§3.2） |
| `SpriteCommand` は **後に積んだものが手前**に描かれる | 実機の OAM は「番号が若いほど優先度が高く、かつ手前」なので、走査線制限の登録順とは**逆順に積む**（§3.2） |
| FC の 54 色マスターパレットへの丸めは**最近傍**（`nearestMasterIndex`） | 生成アセットの色はパレットの値そのものを置く。外れた色は隣へ落ち、塗り分けが消える（§3.2） |
| `AffineSurfaceCommand` には幅の制限が無い | 第2世代は描画距離を伸ばせる |
| `AffineSurfaceCommand` は `uvOrigin + uvStepX·x + uvStepY·y` を引くだけで、**明るさもフォグも持たない**（ラスターの `brightness` に当たる項が無い） | 第2世代の遠方の霞は路面の上に重ねて作るしかない（§3.3） |
| 第2世代の**`hardwareBlend` を持つスプライトだけはシーンへ直接描かれる**。不透明スプライトは独立面へ描かれ、`sprite.a ≥ 0.5` のしきい値で上書き合成される（実測） | 落ち影とフォグは路面と本当に混ざる。半透明スプライトは必ず不透明スプライトより奥になる |
| 走査線ごとのアフィン面は**全画面三角形＋discard**で描かれる（1 帯 = 1 ドローコール） | 135 本でも GPU 側は軽いが、コマンド数は帯の粒度でそのまま増える |
| `BackgroundCommand.texture`（遠景の層）と `MaterialCommand.environmentTexture`（映り込み）で **`flipY` の要求が逆**（フェーズ 5 で確定）。層のシェーダは「絵は反転済み」を前提に v をそのまま渡し、`equirectangularUv()` は `v = 0` を真上とみなす | **同じ 1 枚を空と映り込みの両方には使えない**。地平線の帯を別ファイルへ焼き出す（§3.4） |
| 落ち影は `castShadow` + `groundY` + **点光源 1 つ**（`dynamicLight` の世代のみ）で出る。四角形の大きさは `transform.scale` から作られ、それはメッシュ本体と共有。倍率は `高さ /(高さ − メッシュの高さ)` で、濃さにはその逆数（上限は 0.72）が掛かる | 影の形はメッシュと独立に選べない。**影を落とすためだけの、描かれないメッシュ**を積んで回避する（§3.4） |
| 12 スロットの ordering table を走査するのは **`id === 'PS1'` のときだけ**（実測）。他の世代は不透明を非ソート、半透明を距離ソートで描く | `orderTableIndex` / `polygonSortRange` / `polygonSort` は第3世代でしか効かない。第4世代では**指定しない**ことがそのまま世代差になる |
| `MaterialCommand.uvMode` / `filter` は WebGL レンダラーが読まない。UV 補正は `profile.video.affineTexture`、フィルタは `textureFilter` から決まる | 書いても害は無いが、効くと思って調整しない。書くなら意図の記録として |
| `createBrowserLoopHost` は **`document.hidden` の間ティックを止める**（`isHidden()` で早期 return） | ヘッドレスなブラウザ越しに動作確認するときは `document.hidden` を偽装しないと真っ黒のままになる。不具合ではない |
| 音声は `createGenerationAudioService` が `profile.audio.synth` ごとに音源を登録し、`GameHost` が世代切替時に自動で差し替える。`MusicClock` により**位相は保たれる** | 曲データは 1 つ。編曲だけ `useScore` で差し替える |
| 継続音の API は無い。`playOneShot` の連続予約のみ | エンジン音は短い one-shot の連続再生で作る（実機の作り方と同じ）。§4.3。**先読みの予約には 1 更新あたりの上限が要る** — タブが裏に回ると `AudioContext.currentTime` が大きく飛び、追いつこうとして何千発も予約してしまう |
| 第1世代の音源は**役割をチャンネルへ 1 対 1 で割り当てる**（lead → 矩形波 1 / pad → 矩形波 2 / bass → 三角波 / perc → ノイズ / fx → PCM） | 第1世代では**同じ役割の 2 本目のトラックが鳴らせない**。ハモリは第2世代から足す（§4.1） |
| `playOneShot` は BGM より低い優先度（0）で声を取り、足りなければ**効果音どうしが先に食い合う** | それでも編曲が声数を埋め尽くしていると BGM のパートが消える。編曲側で 1 声以上空けておく（§4.1） |
| `@console-chaos/engine-testkit` は同梱されていない（0.2.0 でも tarball には含まれない） | テストは自前の手動ループホストか、純ロジックのみを対象にする |
| **ordering table のスロット 0..9 は、中身をレンダラーが view depth で安定ソートする**（不透明が先・遠い順）。フェーズ 8 で実測 | 第3世代で「木と車を同じスロットへ距離順に積む」のはゲーム側で並べ替える必要が無い。**同じスロットへ入れるだけでよい**（§3.4 / 8-6） |
| `SpriteCommand.rotation` は **スクリーン空間スプライトにも効く**（`writeSpriteModelMatrix` は基底を単位行列にしたうえで回す。θ が増えるほど画面では時計回り）。フェーズ 8 で実測 | 針・ステアリングは角度ごとのセルを焼かず 1 枚を回すだけでよい（8-3 / 8-5） |
| 第1・第2世代のスプライト面（`separate-plane`）は **`frame.sprites` を積んだ順に描く**（`layer` も view depth も見ない）。フェーズ 8 で実測 | HUD と画面の文字が最前面に出るのは「最後に積んでいる」からで、`layer` の値はそのための記録でしかない |

### 1.4 更新版 README から確定した責任分界

更新された README の「4世代のコンソール表現」章により、**どこまでエンジンが自動でやり、どこからゲームが守るのか**が明文化された。これは実測結果と矛盾せず、設計判断の根拠として採用する。

**レンダラーが自動適用する（ゲームは何もしない）**

内部解像度 / palette・RGB555 量子化 / CRT / surface pass（raster・affine）/ depth / texture 補間 / 頂点量子化 / lighting / skinned animation の sample rate。

**ゲーム側が守る「能力契約」（自動では強制されない）**

| プロファイル値 | FC | SFC | PS1 | PS2 | ゲーム側の責務 |
| --- | --- | --- | --- | --- | --- |
| `maxSimultaneousColors` | 25 | 256 | 制限なし | 制限なし | アセット制作と画面構成で守る。検証は §6.2 の色数カウント |
| `paletteBlockSize` | 16px | 8px | – | – | 背景・スプライトの色分けをこのブロック境界に合わせる |
| `spritesPerScanline` | 8 | 32 | 制限なし | 制限なし | `applyScanlineLimit()` を呼び、結果を**描画と当たり判定の両方**に反映する |
| `tileSnap` | 8px | 1px | – | – | FC は背景・スプライトの配置座標を 8px に丸める |
| `alphaBlend` | 不可 | 可 | 可 | 可 | 互換用の真偽値。新しいコードは `translucency` を見る |
| `translucency` | `none` | `color-math`（RGB555 加算・減算・half・固定色） | `fixed-rate`（average / add / subtract / quarter-add・OT 12 スロット） | `gs-alpha`（source/destination/固定 alpha） | 半透明は `HardwareBlendCommand` で世代の作法どおりに書く。FC には一切積まない。検証は §6.2 の `capability-contract.spec.ts` |
| `spriteComposition` | `separate-plane` | `separate-plane` | `scene` | `scene` | スプライトが独立面か ordering table 経由かの違い。積み方は同じでよいが、重ね順の根拠が変わる |

**世代差の書き方の指針（README の推奨）**

ゲーム固有の世代差は `defineGenerationVariant()` に集約し、レンダラーの能力差は `HardwareGenerationProfile` に任せる。**コード中で `if (generation === 'FC')` のような世代 ID 直接分岐を書かない**。本計画のビュー層はこの規約に従う（§2.1 の 4 ビュー分割は「世代 ID 分岐」ではなく「表現手法ごとのモジュール分割」であり、割り当ては `view/index.ts` の 1 か所のテーブルで行う）。

**CRT プリセット（README 記載の基準値。full 品質時）**

| | scanline | 色にじみ | curvature | noise |
| --- | --- | --- | --- | --- |
| FC (RF) | 0.32 | 0.85 | 1.00 | 0.055 |
| SFC (composite) | 0.28 | 0.55 | 0.85 | 0.025 |
| PS1 (S-Video) | 0.22 | 0.25 | 0.60 | 0.012 |
| PS2 (component) | 0.14 | 0.08 | 0.35 | 0.004 |

「世代が進むほど信号が良くなる」差はこの 1 テーブルが担う。`createGenerationWebGlRenderer` の `crtOverride` で上書きできるが、**既定値をそのまま使う**方針とする（上書きは §7 フェーズ 8 の調整余地としてのみ残す）。

> README の「実運用例は `apps/racing/src/bootstrap.ts` にあります」はエンジン側リポジトリの参照であり、配布物には含まれない。本計画の `bootstrap.ts`（§2.4）は README の最小構成と実測した API から起こす。

---

## 2. 全体アーキテクチャ

### 2.1 中心の考え方

```
                 ┌──────────────────────────────┐
   入力 ────────>│  RaceSim（世代非依存・60Hz固定）│
                 │  コース / 車両 / AI / 周回     │
                 └──────────────┬───────────────┘
                                │ RaceState（読み取り専用）
        ┌───────────────┬───────┴───────┬───────────────┐
        ▼               ▼               ▼               ▼
   view/gen1-fc    view/gen2-sfc   view/gen3-ps1   view/gen4-ps2
   ラスター路面     アフィン路面      3D(深度無)      3D(環境マップ)
        └───────────────┴───────┬───────┴───────────────┘
                                │
                    view/shared/minimap ＋ hud
                    （4世代とも同じ実装・同じ toWorld()。
                      違うのは矩形とマーカー寸法だけ）
                                ▼
                          RenderFrame → createGenerationWebGlRenderer
```

ミニマップは「4 つのビューの下に共通して敷かれる 5 番目のビュー」として置く。世代ごとの表現がどれだけ違って見えても、**その隣に常に同じ 8 台の同じ位置が出ている**という構図そのものが、1 つのシミュレーションで動いていることの主張になる（§3.6）。

- `RaceSim` は描画も音も知らない。純粋な状態遷移関数の集合にする。
- 各 `view/*` は **`RaceState` → `RenderFrame` へのコマンド積み込みのみ**を行う純関数。状態を持たない（持つ場合は「見た目のためだけの状態」に限定し、切替で捨てても破綻しない設計にする）。
- 世代切替でシムには一切触れない。これを自動テストで守る（§6.2）。

### 2.2 全世代が共有する唯一の真実 — トラック空間

サーキットの中心線を等間隔にリサンプリングした配列を唯一の座標系の橋渡しにする。

```ts
interface TrackSample {
  s: number;                     // 始点からの弧長 [m]
  position: [number, number, number]; // ワールド座標（y は標高）
  tangent: [number, number];     // XZ 平面の進行方向（単位）
  right:   [number, number];     // XZ 平面の右方向（単位）
  heading: number;               // atan2 による向き [rad]
  curvature: number;             // 1/半径 [1/m]。左正
  halfWidth: number;             // 路面半幅 [m]
  bank: number;                  // バンク角 [rad]
}
```

- `toWorld(s, lateral) → vec3` / `toTrack(worldXZ) → {s, lateral}` を提供。
- `trackBounds`（XZ 平面の AABB）と全長 `trackLength` も同じモジュールが持つ。ミニマップの俯瞰図（§3.6）とその生成ツールは**この 1 つの値**を共有する。
- 第1・第2世代の擬似3D投影は「s から前方の `TrackSample` を引いて横ずれを積む」だけで済む。
- 第3・第4世代はそのままワールド座標として使う。
- ミニマップは `toWorld()` の結果を `trackBounds` で正規化するだけで得られる。**5 番目のビューが同じ関数の上に乗る**ことが、この設計が 1 つのシステムであることの可視的な証拠になる。
- **同じコース定義から 4 つの見え方が出る**ことがこの設計の要点。

### 2.3 コース仕様（確定）

| 項目 | 値 |
| --- | --- |
| 形状 | 閉ループのサーキット（ホームストレート / 高速コーナー / ヘアピン / シケイン / 複合コーナー） |
| 全長 | 約 3,000 m |
| 路面幅 | 12 m（半幅 6 m）、コーナー進入で 14 m まで拡幅 |
| 標高差 | 最大 8 m（緩い起伏。第1・第2世代では地平線の上下として表現） |
| バンク | 高速コーナーのみ最大 4°（第3・第4世代のみ視覚化） |
| 周回数 | **3 周**（確定） |
| 出走 | **8 台**（自機 1 + AI 7）（確定） |

制御点は `src/game/sim/track-data.ts` に手書きの Catmull-Rom 制御点として持ち、起動時に 1 m 間隔でリサンプリングする（約 3,000 サンプル ≒ 数百 KB。実行時生成で十分）。

### 2.4 リポジトリ構成

`public/assets/car-conversion.json` のパスはリポジトリルート相対（`data/gen3_car.glb` / `public/assets/gen3/models/car.glb` …）に修正済み。**リポジトリルートをアプリルートとして扱う**ことが確定したので、検証スクリプトは記録されたパスをそのまま読めばよい。

> `data/README.md` にはまだ `apps/racing/public/assets` / `npm run prepare:cars -w @console-chaos/racing` というモノレポ時代の記述が残っている。フェーズ 0 で本リポジトリの構成に合わせて更新する（内容そのもの — 変換規則と不変条件 — は有効なので保持する）。

```
README.md               セットアップ手順（tarball の入手 → npm install）※新規
package.json            name: @console-chaos/racing
tsconfig.json
vite.config.ts
index.html
src/
  main.ts                 エントリ（起動・アンロック・破棄）
  bootstrap.ts            AssetManager / Renderer / AudioService / GameHost の配線
  assets/manifest.ts      RenderAssetManifest（textures / atlases / models / geometries / fallback）
  game/
    module.ts             GameModule 実装（fixedUpdate / buildRenderFrame）
    sim/
      track-data.ts       サーキット制御点
      track.ts            リサンプリング・TrackSample・toWorld/toTrack
      vehicle.ts          車両モデル（アーケード寄り）
      ai.ts               AI ドライバ
      race.ts             周回・順位・タイム・スタートシーケンス
      state.ts            RaceState 型と生成
    view/
      shared/
        projection.ts     擬似3D投影（Gen1/Gen2 共用）
        backdrop.ts       遠景パララックス
        car-sprite.ts     スプライト選択・スケール・並べ替え
        font.ts           フォント／ロゴアトラスの寸法（生成ツールと共有）
        text.ts           文字列 → スクリーン空間スプライト・単色矩形
        centered-text.ts  中央寄せの塊（タイトル・カウントダウン・ポーズ・リザルト共用）
        hud.ts            走行中の HUD ＋ 文字の世代差テーブル `TEXT_STYLES`
        minimap.ts        ミニマップ（全世代共通。世代差は variant テーブルのみ）
        camera.ts         3D 追従カメラ（Gen3/Gen4 共用）
      gen1-fc.ts
      gen2-sfc.ts
      gen3-ps1.ts
      gen4-ps2.ts
      title.ts            タイトル画面（4世代共通の組み立て・世代差は variant テーブル）
      overlay.ts          画面の文字の振り分け（title / countdown / GO / FINISH / paused / result）
      index.ts            GenerationId → ビューの割り当て ＋ overlay の積み込み
    flow/
      screens.ts          title / countdown / racing / finished / result の状態機械
    audio/
      score.ts            共通 Score と 4 種の編曲
      engine-sound.ts     エンジン音スケジューラ
      sfx.ts              ブレーキ・縁石・接触
    input/bindings.ts     ActionMap 定義
tools/
  lib/glyphs.mjs          5×7 の字形（HUD フォントとロゴが共有）
  build-track-mesh.mjs    コース中心線 → GLB（Gen3/Gen4 用、LOD 2 段）
  build-skyline.mjs       環境マップ → 第4世代の遠景の帯（地平線まわりの切り出し）
  build-minimap.mjs       track.ts を import してミニマップ俯瞰図 PNG を世代ごとに生成
  build-font-atlas.mjs    HUD フォントアトラス PNG 生成
  build-title-logo.mjs    タイトルロゴ PNG 生成
  prepare-cars.mjs        data/*.glb → runtime GLB + テクスチャの決定論的再変換
  check-cars.mjs          car-conversion.json の記録パスをそのまま読んで SHA-256 照合
tests/
Docs/
  PLAN.md                 要求（変更しない）
  IMPLEMENTATION_PLAN.md  本書
```

### 2.5 技術スタック

- TypeScript 5.x（`strict: true`、`target: ES2022`、`moduleResolution: bundler`）
- Vite（dev サーバ / build）
- Vitest（純ロジックのテスト。DOM 依存部分は手書きのフェイクで代替）
- 追加ランタイム依存は `@console-chaos/engine`（と推移依存の `gl-matrix`）のみ

エンジンは導入済み。`package.json` は現在この状態:

```json
{ "dependencies": { "@console-chaos/engine": "file:reference/console-chaos-engine-0.2.0.tgz" } }
```

フェーズ 0 で `name` / `type: "module"` / `scripts` / devDependencies（typescript・vite・vitest）を追記する。`file:` 参照のため、tarball を差し替えたときは `npm install` の再実行が必要になる点だけ運用として押さえておく。

**npm scripts**

| script | 内容 | 追加フェーズ |
| --- | --- | --- |
| `dev` / `build` / `preview` | Vite | 0 |
| `test` | Vitest | 0 |
| `check:cars` | 変換記録との SHA-256 照合 | 0 |
| `build:minimap` | コース中心線 → 世代別ミニマップ PNG | 1 |
| `prepare:cars` | `data/*.glb` → runtime GLB・テクスチャの再変換 | 2 |
| `build:track` | コース中心線 → `gen{3,4}/models/track.glb` | 2 / 5 |
| `build:road` | 第1世代のラスター路面テクスチャ | 3 |
| `build:sprites` | 車スプライトのアトラス整形 | 3 |
| `build:skyline` | 環境マップ → 第4世代の遠景の帯 | 5 |
| `build:font` | HUD フォントアトラス | 7 |
| `build:logo` | タイトルロゴ | 7 |
| `build:backdrop` | 遠景を BG スペックへ寄せる | 8-2 |
| `build:gauge` | タコメーターの盤・針 | 8-3 |
| `build:cockpit` | 内装とステアリング | 8-5 |
| `build:scenery` / `build:scenery-mesh` | 背景オブジェクトのスプライトとタイヤフェンス | 8-6 |
| `build:tunnel` | トンネルの躯体・灯具・アトラス | 8-9 |
| `build:assets` | 上記の生成系をまとめて実行 | 7 |

**エンジン配布物の扱い（決定: §9-5 の (c)）**

`.gitignore` の `reference/` はそのままにし、tarball はリポジトリに含めない。代わりにルート `README.md` を新規作成し、tarball の入手先と配置場所、`npm install` の手順を記載する。

- CI を構築する場合、tarball を secrets / アーティファクトとして注入する手順が別途必要になる（この構成では `npm ci` が単体では通らない）。この制約は既知のものとして受け入れる。
- `package-lock.json` は `file:` 参照を記録するだけで中身を持たないため、**tarball の同一性は `README.md` に記載する SHA-256 で担保する**。フェーズ 0 で現物のハッシュを記録する。

### 2.6 生成アセットと変換ツール

アセットの追加生成は可（決定事項 §9-1）。生成物は**リポジトリにコミットする**（実行時に生成しない）。理由は、実行時生成だとアセットの見た目がコードの副作用になり、品質ゲート（§6.1）の再現性が落ちるため。

| 生成物 | ツール | 用途 | フェーズ |
| --- | --- | --- | --- |
| `public/assets/gen{1,2,3,4}/hud/minimap.png` | `build-minimap.mjs` | ミニマップの俯瞰図（56² / 72² / 88² / 176²） | 1 |
| `public/assets/common/markers.png` | `build-minimap.mjs` | 車マーカーと共通の形（8×8 の丸・四角・塗りつぶしの 3 セル）。**スプライトはアトラス経由でしか描けない**ので、単色の帯もここを通る | 1 / 4 |
| `public/assets/gen3/models/track-NN.glb` | `build-track-mesh.mjs` | 第3世代コース（4 m 刻み・8 セクター） | 2 |
| `public/assets/gen4/models/track-NN.glb` | `build-track-mesh.mjs` | 第4世代コース（1 m 刻み・50 セクター） | 5 |
| `public/assets/gen{3,4}/textures/track_surface.png` | 同上 | 路面・縁石・草地・壁・金網・タイヤを 1 枚に収めたアトラス（256² / 512²）。帯の定義は `track-mesh.ts` の `TRACK_ATLAS` にあり、生成ツール・背景メッシュ・テストが共有する | 2 / 5 / 8-10 |
| `public/assets/gen4/backgrounds/skyline.png` | `build-skyline.mjs` | 環境マップから切り出した地平線の帯（1024×284）。**空と映り込みを同じ絵から出すのに要る**（§3.4） | 5 |
| `public/assets/gen{3,4}/textures/car_paint.png` | `build-car-paint.mjs` | 無彩色の塗装テクスチャ（256² / 512²）。車体色は実行時の乗算で決まる | 2 |
| `public/assets/gen1/road/road_wide.png` | `build-road-texture.mjs` | 第1世代のラスター路面（1024×256 / 横 84 m・縦 96 m）。同梱の `road.png` では描画距離が伸びない（§3.2） | 3 |
| `public/assets/gen2/road/road_affine.png` | 同上 | 第2世代のアフィン路面（1024×512 / 横 96 m・縦 96 m）。同梱の `circuit.png` は草地のディザが遠方でちらつく（§3.3） | 4 |
| `public/assets/gen{1,2}/sprites/car_frames.png` | `build-car-sprites.mjs` | 車スプライトの整形（384×256 / 3×2）。同梱の `cars.png` は絵がセル境界をはみ出している（§3.2） | 3 |
| `public/assets/common/font.png` | `build-font-atlas.mjs` | HUD とタイトルの文字（128×48 / 16×6 セル・1 セル 8²・字形 5×7）。0x7F だけは**セルいっぱいの塗りつぶし**で、パネルの矩形をここから出す（§3.5） | 7 |
| `public/assets/common/logo.png` | `build-title-logo.mjs` | タイトルロゴ（256×64 / 1 セル・6 色）。字形はフォントと同じ `tools/lib/glyphs.mjs` を整数倍に拡大して使う | 7 |
| `public/assets/gen2/backgrounds/coast_bg.png` | `build-backdrop.mjs` | 遠景を BG スペックへ（8×8 タイル・タイルあたり 16 色・RGB555 の格子）。同梱の `coast.png` は入力として残す | 8-2 |
| `public/assets/gen{3,4}/hud/tacho.png` | `build-gauge.mjs` | タコメーターの盤・針・中央の丸（128² / 256² の 2×2 セル） | 8-3 |
| `public/assets/gen4/hud/cockpit.png` / `wheel.png` | `build-cockpit.mjs` | 内装（640×448）とステアリング（256²）。回す軸が違うので 2 枚に分ける | 8-5 |
| `public/assets/gen{1,2,3}/sprites/scenery.png` | `build-scenery-sprites.mjs` | 看板・木・タイヤフェンス（3 セル・128²）。擬似3D 世代はスクリーン空間、3D 世代はビルボード | 8-6 |
| `public/assets/gen4/sprites/scenery.png` | 同上 | **第4世代だけ 3×2 の 6 セル（256²）** — 木 3 種・看板 2 種。並木が同じ絵の反復に見えないようにする | 8-10 |
| `public/assets/gen4/models/tyre-wall.glb` | `build-scenery-mesh.mjs` | タイヤフェンス（第4世代のみ）。段ごとの円柱 3 段で、UV は路面アトラスのタイヤの帯を引く | 8-6 / 8-10 |
| `public/assets/gen{3,4}/models/tunnel.glb` | `build-tunnel-mesh.mjs` | トンネルの躯体（側壁・歩廊・アーチ・外殻・坑口のリム） | 8-9 |
| `public/assets/gen{3,4}/models/tunnel-lamp.glb` | 同上 | 天井の照明。**マテリアルを分けるためだけ**に躯体と別メッシュにしてある | 8-9 |
| `public/assets/gen{3,4}/textures/tunnel.png` | 同上 | 壁・歩廊・アーチ・外殻・リム・灯具を 1 枚に収めたアトラス（256² / 512²） | 8-9 |
| `public/assets/gen2/tiles/circuit_map.png` | `build-track-map.mjs` | 第2世代の改善案（§3.3）。必要になった場合のみ | 8 |

生成ツールは**決定論的**であること（二度実行してバイト一致）を要件とし、`build:assets` の連続 2 回実行で差分が出ないことをフェーズ 7 で確認する（**確認済み**）。

文字を焼く 2 つのツール（フォント・ロゴ）は `src/game/view/shared/font.ts` からセルの寸法と字送りを引く。ミニマップと同じ考え方で、焼いた絵と実行時の配置がずれる余地を構造的に無くしている。

コース由来の生成物（ミニマップ・コースメッシュ）は `tsx` 経由で `src/game/sim/track.ts` を**直接 import** する。コース形状の実装をツール側に複製しないことが、ミニマップとゲーム本体がずれない構造的な保証になる（§3.6）。`tsx` は devDependency として追加する。

**車モデルの再変換**（決定事項 §9-3）

`tools/prepare-cars.mjs` を実装し、`data/README.md` の変換規則をそのまま実行できるようにする。

- 入力の `data/gen{3,4}_car.glb` は**絶対に上書きしない**
- POSITION / NORMAL / TEXCOORD_0 / indices / 三角形数 / bounds / ジオメトリ fingerprint を保存する
- 未使用の normal・metallic/roughness 画像を除去、base color を外部テクスチャとして書き出す
- Gen4 の単位行列 `node.matrix` を暗黙の TRS へ正規化する
- 実行後に `public/assets/car-conversion.json` を書き直し、`check:cars` が通ることを確認する
- **二度連続実行してバイト一致**すること（現行ファイルはこの性質を満たしている）

現行の変換済みファイルは既に正しいため `prepare:cars` は再現性の担保が目的であり、クリティカルパスには乗せない。フェーズ 2 で車を実際に描くタイミングで実装し、**まず現行ファイルを再生成して SHA-256 が一致することを確認する**（＝ツールの正しさの検証になる）。

---

## 3. 世代別グラフィックス設計

各世代のハードウェアプロファイル（エンジン実測値）:

| | FC | SFC | PS1 | PS2 |
| --- | --- | --- | --- | --- |
| 内部解像度 | 256×224 | 256×224 | 320×240 | 640×448 |
| 投影 | ortho2d | ortho2d | perspective3d | perspective3d |
| 信号 / CRT | rf（最も滲む） | composite | svideo | component |
| 色 | 固定 54 色 / 同時 25 | rgb555 / 同時 256 | truecolor | truecolor |
| スプライト/走査線 | **8** | 32 | 無制限 | 無制限 |
| スプライト合成 | 独立面 | 独立面 | シーン統合（OT） | シーン統合（depth） |
| 半透明 | 不可 | RGB555 color math | 4 固定係数モード | GS alpha |
| ラスタースクロール | **可** | 不可 | 不可 | 不可 |
| アフィン面 | 不可 | **可** | 不可 | 不可 |
| 深度バッファ | 無 | 無 | **無** | **有** |
| アフィンテクスチャ歪み | – | – | **有** | 無 |
| 頂点量子化 | 0 | 0 | **2** | 0 |
| 動的ライト / 環境マップ | 無 / 無 | 無 / 無 | 無 / 無 | **有 / 有** |
| テクスチャフィルタ | nearest | nearest | nearest | linear |
| 見た目の更新レート | 6 Hz | 12 Hz | 30 Hz | 60 Hz |
| 音声 | 5ch PSG | 8ch BRR + reverb | 24ch ADPCM | 48ch streaming |
| 入力 | 4 方向 | 8 方向 | アナログ | アナログ |

`animationHz` は**見た目の更新レートの量子化**に使う。シムは常に 60Hz で回し、ビュー側で `floor(t * animationHz) / animationHz` に丸めた時刻でスプライトのフレーム・車体姿勢・路面スクロール・カメラを決める。第1世代のカクつきはこれで出す。

> レンダラーが `animationHz` を自動適用するのは `SkinnedMeshCommand.animationTime` のみで、本作の車は skin を持たない非スキンメッシュとスプライトである（§1.3 で実測確認済み）。したがって**この量子化はゲーム側の責務**であり、`view/shared/` に `quantizeTime(t, profile)` を 1 つ置いて全ビューが必ず経由する形にする。「6Hz と 12Hz が見分けられること」は §6.1 の受け入れ基準に含まれる。

### 3.1 共通の擬似3D投影（Gen1 / Gen2）

`src/game/view/shared/projection.ts`。カメラは自機の後方・高さ `camY`、焦点距離 `focal`（画素）。地平線行を `yH` とする。

```
画面行 y (yH < y < H) が見ている前方距離:   z(y) = camY * focal / (y - yH)
その距離での路面の画面上の半幅:              halfPx(z) = trackHalfWidth * focal / z
中心線の横ずれ（自機基準）:                  off(z) = dot( P(s0 + z) - P(s0), right(s0) ) - lateral0
中心の画面 X:                                cx(z) = W/2 + off(z) * focal / z
```

`off(z)` は `TrackSample` から直接引く。曲率を積分する近似ではなく実座標なので、コースとの一致が保証される。標高差は `yH` を `+ (P(s0+z).y - P(s0).y) * focal / z` で行ごとに補正して地平線のうねりとして出す。

### 3.2 第1世代（FC）— ラスタースクロール

**要求**: 「ラスタースクロールを用いて、車体の背後視点で奥に進むような見え方にする」

`RasterSurfaceCommand` を 1 枚だけ積む。`screenRect = [0, yTop, 256, hRoad]`（`hRoad` は整数、`scanlines.length === hRoad * 4` が必須）。

行 `i`（画面行 `y = yTop + i`）ごとに 4 値を書き込む。`road.png` が表す世界の横幅を `TEX_W`（m）、縦の 1 周期を `TEX_L`（m）とする。

```
z      = camY * focal / (y - yH)
widthU = W * z / (TEX_W * focal)                        // scanline[4i+1]
centerU= 0.5 + (W/2 - cx(z)) / (TEX_W * focal / z)      // scanline[4i+0]
sourceV= fract( (s0 + z) / TEX_L )                      // scanline[4i+2]
bright = fog(z) * stripe(i)                             // scanline[4i+3]
```

**制約と調整**: エンジンは `widthU ∈ (0, 1]` を強制する。`widthU` は `z` に比例するので描画距離に上限がある。

```
zMax = WIDTH_MAX * TEX_W * focal / W        （WIDTH_MAX は安全マージン込みで 0.85 を採る）
```

**この制限は描画距離だけでなく「路面が細くなれる限界」も決める**（フェーズ 3 の実装で確定）。距離 `z` の路面が画面に占める幅は

```
roadPx(z) = roadFraction * W / widthU(z)      roadFraction = 路面がテクスチャ幅に占める割合
```

なので、`widthU ≤ 1` である以上 **路面は `roadFraction * W` より細くならない**。同梱の `road.png` は路面が 44.5% を占めるため下限が 114 px（画面の 45%）になり、要求の「奥に進む見え方」が成立しない。したがって §8 のリスク表が挙げている対処（横に広い路面テクスチャの再生成）を**フェーズ 3 の必須作業として実施する**。

- `TEX_W = 84 m`・`roadFraction = 1/7`（`tools/build-road-texture.mjs` が生成する `road_wide.png`）
- `TEX_L = 96 m`（センターラインの周期 24 m × 4）。**6Hz 表示では 1 フレームに最大 13 m 進む**ので、これより短い周期にすると速度が読めなくなる
- `focal = 300`（横画角 ≒ 46°）・`camY = 4.0 m`・`yH = 88`・`yTop = 101`・カメラは自機の後方 9.5 m
- ⇒ `zMax ≒ 98 m`、`z_near ≒ 8.9 m`、最遠の路面は 37 px（画面の 14%）

`camY` が 4 m と高いのは意図的で、これが「路面が奥で細くなる」量を決めている。目線を下げると路面が太いまま地平線に届く。なお `camY` は独立に選べる値ではなく、`camY = widthU下限 × TEX_W × (画面下端 − yH) / W` で決まる。

近距離行では `widthU` が小さく 8bit 量子化の刻みが相対的に粗くなり、路面の縁が段付きになる。**これは HDMA テーブルと同じ性質なので修正しない**。ただし `widthU` の最小値が 0.09 を下回ると `center` の量子化誤差（`0.5 / widthU` 画素）が目立つため、`camY` と `yTop` はその範囲で決める。

`center` は 8bit へ書き出すときに `fract` される。コーナーの先で路面が画面外へ流れると素の値が [0, 1) を出て、**路面が反対側から巻き戻って現れる**。CPU 側で [0, 1) に丸める。路面はテクスチャ中央の狭い帯なので、端で止めれば「画面外へ流れる」見え方はそのまま残る。

テクスチャの `wrap` は **`clamp`** にする（`sourceV` を CPU 側で `fract` 済みにするため縦の repeat は不要）。これにより路面が画面外へ流れるコーナーでも横は草地が伸び、二重の道路が現れない。

- **速度感**: `sourceV` の進み（＝ `s0` の増加）が唯一の速度表現。破線センターラインの流れが速度に直結する。
- **縞**: `bright` を偶奇行で 0.94 / 1.00 に振り、遠方ほど差を詰める。走査線の存在を色で見せる。明るさは 1/16 段に丸める（連続に振ると量子化後の色数が増える）。
- **遠景**: `BackgroundCommand` に `coast.png`。ただし **`parallax` は WebGL レンダラーが読まない**（実装で確定）。効くのは `repeat[0]` / `offset[0]` / `placement.bottom + offset[1]` / `placement.height` の 4 つだけなので、視差は視線の回転量から `offset` へ畳み込む。層は遠景・近景の 2 枚まで、テクスチャを持たない背景 1 つが空の階調を決める。
- **車**: `SpriteCommand` を `screenSpace: true` で積む。**自機もライバルも同じ 1 本の式で置く** — カメラを自機の後方 9.5 m に引いてあるので、自機は「距離 9.5 m の車」として素直に扱え、隣に並んだ 2 台が同じ大きさで描かれる。`cell` は**横加速度**で 0/1/2（黄）を選び、値は `DisplayLatch` が 6Hz へ量子化済み。ライバルは `cell` 3/4/5（赤）。
  - **列と向きの対応は「左傾き / 正面 / 右傾き」の字面どおりに読まない**（実装で確定）。列 0 の絵はノーズが右奥を向き、見えている側面が車の右側になっている — 追走カメラから右側面が見えるのは車が右へ向きを変えたときなので、**列 0 が右コーナー・列 2 が左コーナー**である。「左傾き」は車体のロール方向のことで、右コーナーでは車体は外側（左）へ傾く。
  - 判定に使うのは**横加速度**（`speed × ヨー角速度`）にする（実装で確定）。コース接線に対するヨー角では、曲がれている間は車体が接線に沿うので値がほぼ 0 になり、コーナーの最中に絵が正面へ戻ってしまう。`CarState.lateralAccel` を「車体ロールの元」として持たせてあるのがそのまま使える。
  - 同梱の `cars.png` は**絵がセルの境界を 2 px はみ出している**ため、正面のセルを描くと両端に隣の車の破片が出る。`tools/build-car-sprites.mjs` がセル中央へ・接地線を揃えて焼き直す（実装で確定）。接地線は帯（行）単位ではなく**絵 1 つずつ**に揃える — 元絵は車ごとに 1 px ずれていることがある。
  - **アトラスは上下を反転して焼く**（実装で確定）。レンダラーはアトラスを `flipY: false` で取り込み、スクリーン空間スプライトのクアッドは画像の上端をスプライトの下端へ割り当てるため。ミニマップの俯瞰図が `flipVertical()` しているのと同じ理由。
- **ちらつき**: `applyScanlineLimit(sprites, 8, 224)` を使い、走査線あたり 8 スプライトを超えた分を消す。数えるのは**絵のある行だけ**にする（セルの透明部分は実機ではタイルを置かない）。登録順（＝優先度）は **自機 → ミニマップの車マーカー → ライバル車**。自機は必ず先頭に登録して消えないようにする。ミニマップの枠と HUD 文字は BG 相当として制限の対象外、マーカーは対象内で毎フレーム順序を巡回させる（§3.6 に根拠）。
  - **積む順は登録順の逆にする**（実装で確定）。実機の OAM は番号が若いほど優先度が高く、かつ手前に出るが、エンジンは後に積んだスプライトを手前に描くため。
  - `createFlickerState` に落ちた車を記録するが、**シムへは戻さない**（実装で確定）。戻すと世代によってシムの状態が変わり、§6.1 世代横断 1 と `generation-invariance.spec.ts` が壊れる。当たり判定へ効かせるかどうかは、判定を持つ側（フェーズ 8 以降）の判断に委ねる。
- **能力契約（§1.4）の遵守**:
  - `maxSimultaneousColors: 25` — 54 色への量子化はエンジンが行うが**同時 25 色は自動では守られない**。半透明・グラデーション・色数の多い合成を積まない。検証は §6.2 の色数カウント。**生成アセットの色は 54 色マスターパレットの値そのものを置く**（実装で確定）。外れた色は最近傍で隣へ落ち、塗り分けがそのまま消える。
  - `paletteBlockSize: 16` — 遠景と路面の色の切り替わりを 16px ブロック境界に合わせる。
  - `tileSnap: 8` — 遠景のスクロール量と車スプライトの配置座標を **8px に丸める**。`Math.round(x / 8) * 8`。丸めるのは車の中心ではなく**接地点**にする（実装で確定）。中心を丸めると、大きさが変わるちょうどその瞬間に車が路面から浮く。ラスターサーフェスの scanline 値と**ミニマップのマーカー**はこの対象外（前者は走査線単位のスクロールが第1世代の売りであるため、後者は §3.6 の根拠による）。
  - `translucency: { kind: 'none' }` — 落ち影・半透明を一切積まない（`hardwareBlend` を付けたコマンドを 1 つも作らない）。影は単色のスプライトかドット抜きで表現する。

> README も「疑似3Dや曲面道路は `RasterSurfaceCommand` の scanline table で表現する。各走査線の source 位置・幅・明るさを変え、`rasterScroll` pass で水平スクロールや遠近を作る」と明記しており、本節の設計と一致する。

### 3.3 第2世代（SFC）— アフィン変換による擬似3D

**要求**: 「背景のアフィン変換技術を用いて、擬似3Dのコースを走行」

アフィン変換は 1 枚では透視にならないため、**走査線ごとに `AffineSurfaceCommand` を 1 枚ずつ積む**（実機の HDMA によるパラメータ書き換えと同じ構造）。

行 `y` について `screenRect = [0, y, 256, 1]`。**投影は第1世代とまったく同じ `RoadView`** から引く（`projection.ts`）。違うのは、ラスターが 4 つのスカラーを書くのに対し、アフィンは 2 次元のステップを書くことだけである。

```
z       = camY * focal / (y - yH)
φ       = 前方 z の路面の向きと視線の符号付き角度（clamp 済み）
mpp     = z / focal                             // 画面 1px あたりの横移動 [m]
uvStepX = [ cos φ * mpp / TEX_W , sin φ * mpp / TEX_L ]
uvOrigin= [ uCenter(z) - (W/2) * uvStepX[0] , vPhase(z) - (W/2) * uvStepX[1] ]
uvStepY = [ 0, 0 ]                              // 帯の中は 1 つの z で通す
wrap    = 'clamp'
```

画面を右へ 1 px 進むのは路面上を `z/focal` メートル横へ動くこと。前方の路面が視線から φ 回っていれば、その横移動は路面の座標系で `cos φ`（横）と `sin φ`（進行方向）に分解される — **`uvStepX` の V 成分がそのままコーナーでの視界の傾き**になる（実装で確定）。φ はヘッディングの引き算ではなく接線どうしの内積・外積から `atan2` で求める（引き算だと ±π を跨ぐ 1 か所だけ視界が跳ねる）。効きは 0.7 倍・上限 0.3 rad に抑える。素の角度を使うとヘアピンで 90° 近く回り、遠方の行が路面のはるか先を引く。

**`wrap` は `clamp`**（実装で確定）。`repeat` にすると、コーナーの先で U が範囲を出たときに**二本目の道路**が画面の端に現れる。ただし clamp は V にも掛かるので、傾けた行の V が端を越えると模様が潰れる。路面テクスチャの V 方向の模様（破線・縁石の縞）は 24 m 周期で 1 枚に 4 周期入れてあり、**V を 1 周期単位でずらしても絵が変わらない**。この性質で行の V 範囲をテクスチャ中央へ寄せ、端に当たらないようにする（`affine-surface.ts`）。

- **投影パラメータ**: `focal = 300`・`camY = 3.4 m`・`yH = 84`・`yTop = 89`・カメラは自機の後方 9.0 m。幅の制限から解放されたぶん**カメラを下げ（4.0 → 3.4 m）、描画距離を伸ばす（98 → 220 m）**。この 2 つが第1世代との見た目の差の大半を作る。
- **帯の粒度**: 1 行 = 1 サーフェス（路面帯 135 行 ⇒ 135 ドローコール。予算 240 の内側）。切替演出中は 2 世代ぶんを積むので 2 行へ落とす（`affineBandRows(renderedGenerations)`）。粒度は定数 1 つ。
- **路面テクスチャ**: 同梱の `circuit.png` は使わず `tools/build-road-texture.mjs` で焼く（実装で確定）。理由は路面が幅の 51% を占めることと、**草地の高周波ディザが遠方でちらつく**こと。`TEX_W = 96 m`・`TEX_L = 96 m`・1024×512。96 m は最遠の行（220 m）で画面が覆う 188 m を上回るので、clamp の端が必ず草地になる。色は RGB555 の格子（各チャンネル 8 の倍数）に載せる。
- **遠方の霞**: `AffineSurfaceCommand` には明るさの項が無いので、**上から重ねて作る**（実装で確定）。color math の half は「半分だけ混ぜる」しか出せないため、距離ごとに帯（スクリーン空間スプライト）を重ねて `1 - 0.5^k` の段階を作る。手前の帯ほど路面に近い固定色にしておかないと、40 m 先が一段で白む。第2世代の半透明スプライトはシーンへ直接描かれるので、これは路面と本当に混ざる。
- **遠景**: 第1世代と同じ `backdrop.ts` を通す（`coast.png` の SFC 版）。`parallax` が読まれないのも同じなので、視差は `offset` へ畳み込む。
- **車**: 32 スプライト/走査線なので制限は実質かからないが、経路は第1世代と同じ `sprite-plane.ts` を通す。**落ち影**は color math の `subtract` + `half`（背面を半分に落として影の色を引く ＝ 実機の作法）。ステアフレームは 12Hz 量子化。フォグが 8 割を超える 150 m より奥のライバルは描かない（霞の向こうに点が残る）。
- **能力契約**: `tileSnap: 1` は「丸めない」ではなく**「1 px 単位」**（実装で確定。実機の OAM も整数画素だった）。第1世代との差は 8 px のタイル境界から自由になることにある。`paletteBlockSize: 8`、`maxSimultaneousColors: 256`、`translucency: color-math`。

> README も「地面・道路・床は `AffineSurfaceCommand` の UV origin と X/Y step で 1 枚の texture を変形する `affinePlane` pass が中心。これは 3D mesh ではなく screen-space の疑似3D」と述べており、本節の走査線単位アフィンはその延長にある。

> **品質ゲートで不足した場合の改善案**: 現在の `circuit.png` は直線路タイルであり、真の Mode 7 的な「コース全体マップの回転」は表現できない。品質基準（§6.1）を満たさない場合、`tools/` にコース中心線からトップダウンのコースマップ PNG を生成する手順を追加し、アフィン面をマップ参照に切り替える。この場合 `uvOrigin`/`uvStepX` はワールド XZ → マップ UV の直接変換になり、per-scanline のスケールだけで透視が付く。

### 3.4 第3世代（PS1）/ 第4世代（PS2）— 3D

共通部分（`view/shared/camera.ts`）:

- `CameraCommand.projection = 'perspective'`、自機の後方 6.5 m / 高さ 2.2 m、注視点は自機の 12 m 前方。速度に応じて FOV を 60°→72°、カメラ距離を微増。
- コースは `tools/build-track-mesh.mjs` が中心線から生成した GLB を `MeshCommand.asset` で描く。`TransformCommand` に X/Z 回転が無いため、バンクと標高はメッシュに焼き込むしかない。
  - 出力: `public/assets/gen3/models/track-NN.glb`（粗・PS1 用）と `public/assets/gen4/models/track-NN.glb`（細・PS2 用）。**セクターごとに 1 ファイル**にする（下の「セクター分割の役割」を参照）
  - 分割: PS1 は 4 m 刻み（8 セクター × 97 輪）、PS2 は 1 m 刻み（50 セクター × 62 輪）。**PS1 側をあえて粗くするのではなく、細かくしすぎない**ことでアフィンテクスチャの歪みと頂点量子化の揺れが画面に出る（エンジンの `geometry.ts` が明記している性質）。あわせて路面を横方向にも分割する（6 分割 ＝ 1 マス 2 m）。粗すぎると揺れが「面の波打ち」ではなく「物体全体の平行移動」に見えてしまう（§6.1 第3世代基準 2）
  - **横分割は 2 世代で同じ 6 のままにする**（実装で確定）。第4世代には頂点量子化もアフィン歪みも無いので、横に割る理由がそもそも無い。縦の刻みだけを 4 倍細かくすることで、差が「標高とバンクの滑らかさ・解像度・フィルタ・ライティング」からだけ出る
  - 描画は自機のセクターの前後 `visibleRadius` 個。**前方に保証される距離は `visibleRadius × セクター長`** で、フォグはその内側で閉じるよう決める（PS1 は 1 × 387 m、PS2 は 5 × 62 m ＝ 310 m）。第4世代を細かいセクターに割ってあるのはこのカリングのためで、深度バッファがある以上ほかに分ける理由は無い
  - **路面 / 縁石 / 草地は 1 枚のアトラスの別々の u 帯へ写す**（実装で確定）。`MeshCommand` は `asset` の全プリミティブを 1 つの `MaterialCommand` で描くため、面ごとにマテリアルを分けるにはメッシュ自体を分けるしかない。当時のテクスチャページと同じ作りにするほうが素直で、三角形単位のソートも 1 回で済む
  - セクター分割の役割は**描画距離のカリング**であって前後関係ではない。前後関係は ordering table が受け持つ（下記）。セクターの継ぎ目は同じ弧長から同じ式で生成するので頂点が完全一致し、割れない
  - 三角形の巻き順は**上から見て反時計回り**（法線が +Y）。逆にすると裏面カリングで路面がまるごと消える
- 車は `MeshCommand.asset = 'assets/genN/models/car.glb'`。**前方が `-X`** なので `transform.rotationY` で補正する。`rotationY(θ)` は局所 (x, 0, z) を (x·cosθ + z·sinθ, 0, −x·sinθ + z·cosθ) へ写すので、局所前方 (−1, 0, 0) をワールドの進行方向 (cos H, 0, sin H) に合わせると **θ = π − H**（実装で確定・`car-orientation.spec.ts` が固定）。
- runtime GLB は material も image も持たない（変換で除去済み・実測確認済み）。したがって `MaterialCommand`（`baseColorTexture`）を**必ず**積む。積み忘れると fallback 柄で描かれ、例外にならないので気付きにくい。§6.2 の `frame-contract.spec.ts` で検出する。
- **メッシュが参照するテクスチャは `flipY: false` で登録する。** glTF の UV は v = 0 が画像の上端だが、レンダラーは `manifest.textures` を既定 `flipY: true` で取り込む（アトラスだけは false を強制）。指定を忘れると上下逆に貼られ、UV アイランドの位置がずれて車体が迷彩柄になる。これも例外にならないので `frame-contract.spec.ts` で検出する。
- **車体色は無彩色テクスチャ × `MeshCommand.color` で作る。** base color には赤いリバリーが焼き込まれているので、そのまま乗算しても 8 台を見分けられない（黄を掛けても青が落ちて赤が残るだけ）。`tools/build-car-paint.mjs` が塗装部を無彩色に落としたテクスチャを**世代あたり 1 枚**焼き、色は実行時のパラメータにする。テクスチャもマテリアルも全車で 1 つを共有でき、色を変えるのに焼き直しが要らない。
  - 明度の作り方が肝。塗装部（彩度あり）は **V（HSV の明度）** を使って平均を 0.82 へ正規化する。輝度をそのまま使うと赤の輝度が低いため、色を掛けたとき暗く沈む。無彩色部（タイヤ・窓）は輝度をそのまま使い、境目は彩度でなだらかに混ぜる
  - 引き換えに**タイヤ・窓も車体色に染まる**。シェーダの合成は `texture * uBaseColorFactor` の素直な乗算で、部位ごとにマスクを掛ける口が無い（`topColorTexture` は法線が上向きかで切り替わる地形用の仕組み）。元が暗いので「影のかかったホイール」として読める範囲に収まっており、8 枚焼き分けるより得だと判断した
  - 第4世代の runtime `car_base_color.png` は変換記録の成果物としてディスクに残すが、実行時に読むのは `car_paint.png`（512²）のほうになる
- 影は `castShadow: true` + `groundY` を路面高に設定（エンジンが点光源から落ち影を落とす）。**第3世代は `dynamicLight: false` なので点光源が無く、影は落ちない**。実際に効くのは第4世代からで、そちらは**影専用のメッシュ**が受け持つ（下記）。

**第3世代（PS1）固有**:

- `depthBuffer: false` ⇒ メッシュは 12 スロットの ordering table を 0→11 の順に走査して描かれる（既定: opaque world 1..8 / 半透明 9 / スクリーン空間スプライト 10 / debug 11）。**車とコースの前後関係はセクター分割ではなくスロットで決める** — 路面に `polygonSortRange: [1, 8]` を与えて三角形単位に分配し、車は `orderTableIndex: 9` の固定スロットへ置く。こうすれば車が路面へ埋まることが構造的に起こらない。
- `MaterialCommand.polygonSort: true`（および `RenderModelAsset.polygonSort`）を車とコースに設定し、ポリゴン単位ソートを有効化。さらに **路面には `polygonSortRange` を与え、自機は `orderTableIndex: 9` の固定スロットへ置く**（0.2.0 のリリースノートが「プレイヤーが床より奥へ描画される」問題の対処としてこの組み合わせを挙げている）。
- 半透明を使う箇所は `{ family: 'gen3-semitransparency', mode: … }` の 4 固定モードから選ぶ。任意の不透明度は出せない。
- `vertexQuantize: 2` と `affineTexture: true` はエンジンが自動適用。**頂点の揺れとテクスチャの歪みを消そうとしない**。
- `dynamicLight: false` ⇒ ライティングは `LightCommand` の ambient / directional のフォールバックのみ。`MaterialCommand.ambient` / `diffuse` を明るめに調整して焼き込み風にする。
- `BackgroundCommand.fogDensity` で遠景を切る（当時の描画距離の短さ）。遠景は `coast.png` 相当ではなく単色＋フォグ。
- 30Hz 量子化: `view/shared/display-state.ts` のラッチが、シムのティックから整数演算で表示フレーム番号を求め、その境目でだけ車の値を写し取る。ビューは `RaceState.cars` を直接読まない。

**第4世代（PS2）固有**:

- `depthBuffer: true` ⇒ 前後関係は正しい。**12 スロットの ordering table を走査するのは第3世代だけ**（実装で確定）なので、`orderTableIndex` / `polygonSortRange` / `polygonSort` をこの世代では**1 つも指定しない**。指定が要らないこと自体がそのままハードウェアの差になる。`manifest.models` の `polygonSort` も `profile.video.depthBuffer` から導き、第4世代ではソート用の作業配列を確保しない。
- `environmentMap: true` ⇒ 車のマテリアルに `environmentTexture: 'assets/gen4/environment/circuit.png'`、`environmentStrength: 0.35`。エンジンの正距円筒マッピング（`equirectangularUv`）で車体に景色が映り込む。**これが第4世代の署名的表現**。
  - **環境マップは `flipY: false` で登録する**（実装で確定）。`equirectangularUv()` は `v = acos(d.y)/π` すなわち `v = 0` を真上とみなすが、レンダラーの `textures` は既定で上下を反転して取り込む。間違えると**空が地面として映り込む** — 例外にならないので `frame-contract.spec.ts` と `gen4-environment.spec.ts` が検出する。
  - 強さの上限は 0.35 前後（実装で確定）。合成は `color·(1−k) + k·min(color·0.55 + env·0.65, 1)` なので、0.5 を越えると空の青が塗装を飲み、**8 台をエントラント色で見分けられなくなる**。ミニマップのマーカーと車体色が対応しているという §3.6 の主張が崩れるため、ここは上げない。
- **空と遠景**: 同じ環境マップを `BackgroundCommand.texture` にそのまま渡すことは**できない**（実装で確定）。遠景の層のシェーダは「絵は反転済み」を前提に v をそのまま渡すので、映り込みと `flipY` の要求が逆になる。そこで `tools/build-skyline.mjs` が地平線まわり ±50° を切り出した帯 `gen4/backgrounds/skyline.png` を焼き、層にはそちらを渡す。元が同じ画像なので §6.1 基準 2 は満たされる。
  - 帯の置き方は**実際のカメラから決まる**。方位は映り込みが引くのと同じ `equirectU()` を通し、`repeat` は内部解像度の縦横比から出した水平画角ぶん、水平線の行はカメラのピッチと `(画面高/2)/tan(縦画角/2)` から出す。`parallax` はレンダラーが読まないので `offset` へ畳み込む点は第1・第2世代と同じだが、こちらは**視差の量が推測ではなく決まっている**。
  - 帯を ±50° と広く採ってあるのは、**どの画角・どの見下ろし角でも画面を覆いきる**ため。層は平らに貼られるので仰角と行の対応は本来 tan で曲がるが、水平線だけを合わせて縁のずれは絵の無い空へ逃がす。狭く採ると帯の縁で色が跳ねて横線に見える。
  - 地平線のすぐ下（−2°〜−9°）から一様な霞へ溶かす。環境マップには**撮影地のコースそのもの**が写っており、残すと自分たちの 3D コースの左右に二本目の道路が現れる。潰した先の色・空の階調・フォグ色はすべて生成ツールが環境マップから実測するので、手で写す定数が無い。
- `dynamicLight: true` ⇒ `LightCommand` を 3 つ積む: ambient（空の色）、directional（太陽。**環境マップの最輝点から実測した向き** `SUN_DIRECTION` を使い、映り込みに写っている太陽と陰影を一致させる）、そして落ち影を生む点光源。
  - **落ち影は「影を落とすためだけの、描かれないメッシュ」が受け持つ**（実装で確定）。エンジンは影の四角形の大きさを `transform.scale` から作るが、それはメッシュ本体と共有なので、車に直接 `castShadow` を付けると**2 m 角の影しか出せない**（車は 1.9 × 0.88 m）。`colorFactor` を透明にし `alphaCutoff: 1` で全画素を捨てるマテリアルを与えた quad を 1 台につき 1 つ積み、1.0 m 角に収める。費用はドローコール 1 つぶん（2 三角形・全画素 discard）。
  - 点光源は**自機の 40 m 上**に置く。影の倍率は `高さ /(高さ − 車の高さ)`、濃さはその逆数なので、低いと影が巨大化して薄まり、しかも遠くの車ほど影が横へ流れる（影は光源からの投影）。高く置くと倍率が 1.006 に収まる。半径は高さより少しだけ大きい程度にする — 点光源は照明でもあり、広げると自機のまわりだけが明るく浮く。
- `textureFilter: 'linear'` と 640×448 により、同じ車モデルでも第3世代と明確に差が出る。路面アトラスも 256² → 512² に上げる（`textureSize` を LOD テーブルが持つ）。
- フォグ密度は 0.011（100 m で 67%・300 m で 96%）。第3世代の 0.014 より薄く、描画距離の伸びがそのまま世代の差になる。
- `MaterialCommand.uvScrollY` を路面の陽炎表現などに使う余地を残す。
- ワールド空間スプライトが `billboard: 'cylindrical' | 'spherical'` と `depthWrite` を選べる（0.2.0）。砂埃・ブレーキ光・観客といったビルボード表現をここで足せる。半透明は `{ family: 'gen4-gs', preset: … }` で任意の不透明度を出せる — **4 世代でこの世代だけ**。

### 3.5 HUD（全世代共通の仕組み）

`OverlayCommand` は WebGL レンダラーで描画されないため、**自前のビットマップフォントで描く**。
スクリーン空間スプライトは 0.2.0 で 4 世代すべてに描かれるので、HUD は 1 つの経路で組める
（PS1 では ordering table の固定スロット 10、PS2 ではシーン末尾へ合成される）。

- `tools/build-font-atlas.mjs` が 8×8 のフォントアトラス `public/assets/common/font.png`（16 列 × 6 行 = 96 文字、ASCII 0x20–0x7F）を生成する。純粋な生成スクリプトなのでリポジトリ内で完結する。字形は 5×7 で**セルの左上**へ置き、余りは透明のままにする。字送りをセルの一辺より狭く採れるのはこのためで、隣のセルの透明画素は `alphaCutoff` に捨てられる。
- **字形はセルの中で上下反転して焼く**（実装で確定）。理由は車スプライトと同じで、レンダラーがアトラスを `flipY: false` で取り込み、スクリーン空間スプライトのクアッドが画像の上端をスプライトの下端へ割り当てるため。反転するのは**セルの中だけ**で、セルの並び（＝文字コードの順）は保つ。
- **0x7F（DEL）のセルだけはセルいっぱいの塗りつぶしにする**（実装で確定）。単色の矩形（HUD とタイトルのパネル）はスプライトでしか出せず、スプライトはアトラス経由でしか描けないので、フォントの空きセルを 1 つ使う。ここを字形と同じ 5×7 で焼くと、**引き伸ばした矩形が指定した寸法の 5/8 × 7/8 にしか広がらない** — 実画面でパネルの右と下が欠けた。§1.3 の「セルの中の透明な余りもそのまま引き伸ばされる」の帰結であり、`font-atlas.spec.ts` がこのセルだけを例外として固定する。
- 焼く色は**白 1 色**。世代ごとの色は実行時の `SpriteCommand.color` が掛けるので、4 世代・順位色・影のすべてが 1 枚で足りる（ミニマップのマーカーと同じ考え方）。
- **半端な α を 1 画素も作らない**（実装で確定）。FC は `translucency: none` で、スプライト面が `a ≥ 0.5` のしきい値で合成されるため、中間の α は世代によって縁の出方が変わる。ロゴも同じ規約で焼き、色数を FC の同時 25 色の予算に収める。
- `manifest.atlases` に `{ url, columns: 16, rows: 6 }` で登録。
- `src/game/view/shared/text.ts` が文字列 → `SpriteCommand[]`（`screenSpace: true`）に変換し、`hud.ts` がその配置を決める。
- 表示: 順位 / 周回 / ラップタイム / ベストラップ / 速度 / 現在世代。
- 世代差は色数と配置で出す。FC は単色 2 段、SFC は影付き 2 色、PS1/PS2 は半透明パネル。半透明は `translucency` を持つ世代でのみ `hardwareBlend` を付ける。この表（`TEXT_STYLES`）は**タイトル・カウントダウン・リザルトも共有する**ので、画面を移っても世代の性格が変わらない。
- **字送りは `tileSnap` から導く**（実装で確定）。FC は 8 px、以降は 5×7 の字形どおり 6 px。実機の HUD 文字は BG タイル面に描かれ 1 文字が 1 タイルを占めていたので、字間がタイルの一辺そのものだった。世代 ID を見ずに 1 行で導けるうえ、FC と SFC の HUD の見た目の差がそのままここから出る。
- **3 つの塊はすべて左揃えにする**（実装で確定）。字送りがタイルの一辺なので、塊の左端さえ境界へ載れば全部の文字がタイルへ載る。右揃えにすると字形の幅（5 px）とタイルの差だけ格子から外れる。ラップタイムの 2 行を `TIME` / `BEST` と同じ字数にしてあるのは、左揃えのままで桁を縦に揃えるためで、`formatLapTime` の未計測を `-:--.---`（8 文字・計測済みと同じ長さ）に縮めたのもこの理由。
- **ラップタイムは `DisplaySnapshot.tick` から作る**（実装で確定）。`RaceState.tick` を直接読むと**時計だけが 60Hz でなめらかに回り**、第1世代で車が 6Hz なのに数字がぬるぬる動く食い違いが出る。`DisplayCar` にラップ関連の値を足し、スナップショットが tick ごと一貫するようにしてある。
- 文字とパネルは実機では BG タイル面に描かれ、スプライト枠を消費しなかった。**`applyScanlineLimit` の対象外**として扱い、`sprite-plane.ts` の `foreground`（制限の外・最前面）へ積む。ミニマップの枠が `background`（制限の外・最背面）なのと対になる — 実機の BG 面も優先度ビットでスプライトの前後どちらにも置けた。
- **PS1 のパネル色は空より十分暗くする**（実装で確定）。`average` は「背景と半分ずつ」しか出せないので、明るい色だと空の上でパネルが消える（実画面で消えた）。不透明度で濃さを決められるのは第4世代だけで、第3世代は色でしか作れない。
- 配置は `SCREEN_SAFE_AREA`（4:3・オーバースキャン 4%）の内側に収める。縁へ寄せる丸めは**内側向き**（`floorToTile` / `ceilToTile`）にする — 四捨五入だと安全領域からはみ出す。

### 3.6 ミニマップ（全世代必須）

**目的**: プレイヤーへの情報提供に加えて、**4 世代が 1 つのシミュレーションで動いていることを画面上で証明する**。同じコース・同じ 8 台・同じ順位が、4 通りの表現で同時に成立していることを一目で示す装置として扱う。この意図があるため、ミニマップは「あれば良い HUD 要素」ではなく**全世代の必須要素**として受け入れ基準に入れる。

**構造**

コース輪郭は事前生成テクスチャ、車マーカーは実行時のスクリーン空間スプライトに分ける。

- **コース輪郭**: `tools/build-minimap.mjs` が `src/game/sim/track.ts` を直接 import し、`TrackSample[]` から俯瞰図 PNG を世代ごとに 1 枚ずつ生成する。実行時に毎フレーム線を引かないのは、エンジンのスクリーン空間プリミティブが `SpriteCommand` しか無く（メッシュはワールド空間のみ）、輪郭を点スプライトで描くと第1世代の 8 スプライト/走査線を即座に食い潰すため。パネルと輪郭は**不透明で焼き**、半透明にするのは実行時の `hardwareBlend` の役目にする（世代ごとの半透明の作法をそのまま使うため）。
- **車マーカー**: `common/markers.png`（8×8 の白い丸と白い四角の 2 セル）を `SpriteCommand.color` で色付けして置く。サイズはコマンド側で指定するので、1 枚のアトラスで 4 世代・8 台すべてを賄える。
- **向き**: コース固定（回転しない）。全体が常に見えていることが「同じコースを 4 通りに描いている」という主張の根拠になるため、自機基準の回転はしない。

**位置の求め方 — ここが「1 つのシステム」の証明の実体**

マーカーの位置は、4 世代とも**まったく同じ 1 本の関数呼び出し**で決まる。

```ts
// view/shared/minimap.ts — 世代分岐は矩形とマーカー寸法だけ
const world = track.toWorld(car.s, car.lateral);   // 4世代とも同じ toWorld()
const u = (world[0] - bounds.min[0]) / bounds.size[0];
const v = (world[2] - bounds.min[2]) / bounds.size[2];
const px = rect.left + margin + u * (rect.width  - margin * 2);
const py = rect.top  + margin + v * (rect.height - margin * 2);
```

`bounds` は `track.ts` が中心線から算出する `trackBounds`（§2.2）。**生成ツールも同じ `track.ts` の `trackBounds` を使って PNG を描く**ため、テクスチャとマーカーの座標系がずれる余地が構造的に無い。ツールは `tsx` で TypeScript を直接実行し、実装を二重に持たない。

**世代ごとの差（`defineGenerationVariant` に集約）**

| | FC | SFC | PS1 | PS2 |
| --- | --- | --- | --- | --- |
| テクスチャ | `gen1/hud/minimap.png` 56² | `gen2/hud/minimap.png` 72² | `gen3/hud/minimap.png` 88² | `gen4/hud/minimap.png` 176² |
| 配置 | 右下・**8px グリッド上** | 右下 | 右下 | 右下 |
| 背景パネル | なし（輪郭線のみ。`translucency: none`） | 半透明パネル（color math add・half ＝ 50%） | 半透明パネル（固定係数 average） | 半透明パネル＋縁のぼかし（GS source-over・不透明度 0.62） |
| マーカー | 2×2 px・自機/他車の 2 色 | 3×3 px・影付き | 4×4 px・順位色 | 6×6 px・順位色＋自機に強調縁 |
| 更新レート | 6 Hz | 12 Hz | 30 Hz | 60 Hz |

同じ 8 台の同じ位置が、解像度・色数・更新レートの制約を通してどう変わるかがそのまま見える。**マーカーの論理座標（正規化 u,v）は 4 世代で完全に一致する**ことを自動テストで固定する（§6.2 `minimap.spec.ts`）。

**第1世代のスプライト制限との関係**

実機では HUD やマップ枠は BG タイル面で描かれ、スプライト枠を消費しなかった。本エンジンにはタイル面の API が無いためスプライトで代用するが、**扱いは実機に合わせて次のように分ける**。

- ミニマップの**枠（テクスチャ）と HUD 文字**は `applyScanlineLimit` の対象外にする（BG 相当）
- ミニマップの**車マーカー**は対象に含める（実機でもマーカーはスプライトだった）。登録順は 自機 → マーカー → 走行中のライバル車 とし、**マーカーの登録順を毎フレーム巡回させる**。これにより 8 台がスタートライン付近で密集しても、マーカーは消えっぱなしにならず**ちらつく**（実機の OAM ローテーションと同じ手法）。全 8 台が見えるという証明の要件と、8 スプライト/走査線という制約を両立させる
- `createFlickerState` による「消えたスプライトは当たり判定も消える」は**ワールドの車エンティティにのみ適用する**。マーカーは `NO_ENTITY` で登録し、当たり判定には影響させない

**表示内容**

順位に応じたマーカー色、自機の強調、周回済み区間の明暗差（第2世代以降）。第1世代は色数の制約から自機（明色）と他車（暗色）の 2 色のみ。

### 3.7 タイトル画面

タイトル画面も**現在の世代で描かれる**。ここが本作の掴みになる — プレイヤーは走り出す前に、タイトル画面を切り替えるだけで 4 世代の違いを体験できる。

- **構成**: 背景（アトラクトデモ ＝ その世代のビューそのもの）＋ ロゴ ＋ 点滅する PRESS START ＋ 世代インジケータ ＋ 操作説明。
- **ロゴ**: `tools/build-title-logo.mjs` が `public/assets/common/logo.png`（256×64、アトラスとして 1 セル）を生成する。**1 枚で 4 世代分を賄う** — FC では 54 色パレットへ、SFC では RGB555 へエンジンが自動で量子化するため、世代ごとにロゴを作り分ける必要はない。拡大率だけ `defineGenerationVariant` で変える（第4世代のみ 2 倍）。字形は HUD と同じ `tools/lib/glyphs.mjs` を整数倍に拡大して使う — タイトルと HUD の書体が揃っているほうが 1 つの作品として見えるからで、当時のタイトルも多くがそうしていた。
- **デモ走行（アトラクト）**: タイトル表示中も `RaceSim` を AI 8 台で回し、その様子を背景として描く。実装コストはゼロ（ビューをそのまま使い、専用の描画を 1 つも持たない）で、世代の違いが動いている画で伝わる。プレイヤーは自機を操作せず、AI が代走する。
- **配置は画面高の割合ではなく、ミニマップの矩形から決める**（実装で確定）。世代ごとに内部解像度もミニマップの寸法も違うので（第4世代は 176² が画面の 4 割を占める）、割合で置くとどこかの世代で必ず重なる。PRESS START の塊は**ミニマップの上端のすぐ上**へ底を合わせ、ロゴはその上に残った空間の中央へ置く。操作説明は**左下に左揃え**で、ミニマップの左端までの幅に収める。ミニマップの寸法を変えても追従し、`screen-layout.spec.ts` が 4 世代 × 5 画面で重なりを固定する。
- **文字の下にはパネルを敷く**（実装で確定）。背後でアトラクトデモが動いているので、文字だけを置くと路面や雲の上で読めない（実画面で読めなかった）。`translucency` を持たない世代では**不透明の帯**になる — 半透明ではないので能力契約に反しないし、実機の FC のタイトルも文字の下に単色の帯を置いていた。パネルは明滅させないので、PRESS START が消えている間も居場所が分かる。
- **世代ごとの見せ方**:
  - FC: ロゴを 8px グリッドに載せ、PRESS START は 6Hz で明滅（量子化済みの時刻で明滅させるので、切り替わりが更新レートの境目にしか来ない）。パネルは不透明。
  - SFC: 同じロゴが RGB555 で出る。文字に落ち影、パネルは不透明のまま。
  - PS1: 3D のアトラクトデモが背景。フォグ、ロゴはスクリーン空間スプライト、パネルは固定係数の average。
  - PS2: 環境マップ入りの車が走る背景に、2 倍に拡大した鮮明なロゴ。パネルは GS の任意不透明度。
  - 当初案の「PS1 はコースをゆっくり周回する専用カメラ」は**採らない**（実装で確定）。アトラクトデモの追走カメラがそのままカメラワークになっており、専用のカメラを足すとタイトルとレースで見え方が変わって「同じビューで描いている」ことが伝わらなくなる。
- **入力**: 決定（Enter / Space / Z）でカウントダウンへ。世代切替（Q/E）はタイトル画面でも常時有効。

### 3.8 世代切替の演出

- エンジンの `GenerationController` が `transition.blend` を持ち、`createGenerationWebGlRenderer` が 2 世代を合成して切り替えを描く。ゲーム側は**両方の世代のコマンドを毎フレーム積む**必要がある。
  - `frame.meshes` などの `generations` フィールドで「この世代でだけ描く」を指定できる。`generation.renderGenerations()` が返す世代分のビューを回して積む実装にする。
- 切替中もシムは動き続ける（レースは止まらない）。タイトル画面・リザルト画面でも同様に切り替えられる。

---

## 4. サウンド設計

**要求**: 「1つの曲をそれぞれのコンソール世代のサウンドスペックで鳴らす」「速度に応じたエンジン音」「ブレーキ音」

### 4.1 楽曲

- `src/game/audio/score.ts` に **1 つの曲**を定義する。イ短調・152 BPM・4/4・`ticksPerBeat: 24`・**32 小節**（8 小節の楽節を A / A' / B / A'' と 4 回）。
- トラックは役割（`lead` / `bass` / `perc` / `pad` / `fx`）で持つ。楽器名は持たない。
- **和声進行・主旋律・ベース・ドラムはファイルの上半分に 1 度だけ書かれる**（実装で確定）。下半分の編曲テーブルは「その世代で鳴らすパートはどれか」を選ぶだけで、音の高さも長さも持たない。曲が途切れないのは `MusicClock` が位相を保つからだけでなく、**4 編曲が同じ長さの同じ進行**でできているからでもある。
- 世代ごとの**編曲**を 4 つ用意する。`bpm` / `beatsPerBar` / 曲長は**必ず同一**に保つ（位相保存の条件）。
  - FC: lead + bass + perc の 3 パート（5 声のうち 2 声を効果音に空ける）
  - SFC: + パッド（2 声）、ハモリ、ハイハット
  - PS1: + 対旋律、楽節頭の一撃（fx トラック）
  - PS2: 全パート + パッドのオクターブ重ねとベースの倍音下げ
- **同時発音数の実測**（フェーズ 6）: FC 3 / 5・SFC 7 / 8・PS1 10 / 24・PS2 14 / 48。**どの世代も 1 声以上を空ける**のが編曲の制約になる。`playOneShot` は BGM より低い優先度で声を取るが、埋め尽くされていれば BGM のパートが消えるため。第2世代のパッドを三和音ではなく 2 声にしてあるのはこの理由（三和音だと 8 / 8 になる）。
- **ハモリは第2世代から**（実装で確定）。第1世代の音源は役割をチャンネルへ 1 対 1 で割り当てるので、`lead` の 2 本目は同じ矩形波 1 を奪い合って片方が消える。
- 世代切替時に `audio.useScore(arrangementFor(generation))` を呼ぶ。音源の差し替えは `GameHost` が `onSwitch` で自動的に行うので、**ゲーム側がやるのは編曲の差し替えだけ**である。`MusicClock` が位相を保ち、曲は途切れず音色と編成だけが変わる。

### 4.2 起動と解錠

`AudioContext` はユーザー操作後にしか動かないため、`installAudioUnlock(document, () => audio.unlock())` を使う。解錠前は `createNullAudioService()` ではなく、解錠後に `createGenerationAudioService` を差し替える方式ではなく、**最初から生成しておき `unlock()` で `resume()` する**（エンジンの実装がこの形）。

### 4.3 エンジン音

継続音の API が無いため、**短い one-shot を先読みで連続予約する**（実機と同じ作り方）。

- `src/game/audio/engine-sound.ts` に `EngineVoiceScheduler` を置く。
- 毎 `fixedUpdate` で `audio.currentTime + 0.2 s` までを埋めるように、間隔 `interval`（60–110 ms、回転数が高いほど短い）で `playOneShot({ role: 'fx', frequency, durationSeconds: interval * 1.6, velocity, pan })` を予約する。
- `frequency = 46 Hz * (0.6 + rpm * 2.4)`。`rpm` は 4 段の擬似ギアの中で 0 → 1 へ上がり、シフトアップで落ちる**鋸歯**にする（実装で確定）。速度をそのまま周波数へ写すと「ただ高くなるだけ」の音になり、ギアの存在が聞こえない。
- `velocity` はスロットル量に連動。`pan` は第3・第4世代（`positional: true`）でのみ渡す。
- **1 更新あたりの予約数に上限を置く**（実装で確定）。タブが裏に回ると `AudioContext.currentTime` が数十秒飛び、追いつこうとして何千発も予約してしまう。上限に当たったら追いつくのを諦め、予約位置を現在時刻へ引き戻す。
- **声の奪い合いはそのまま活かす**: FC は 5 声しか無いため、エンジン音が鳴ると BGM のパートが一時的に消える。これは仕様であり、修正しない。ただし予約間隔を長めにして BGM が壊滅しないよう調整する — 倍率は `profile.audio.channels` から導く（`min(2.2, max(1, 12 / channels))`）ので、**世代 ID の分岐は 1 か所も要らない**。

### 4.4 効果音

| 音 | 実装 |
| --- | --- |
| ブレーキ | ブレーキ入力の立ち上がりで高音の減衰 one-shot、保持中は 120 ms 間隔で短い擦過音を予約 |
| 縁石 / 路外 | `lateral` が路面幅を超えたとき、速度連動の低音ノイズを一定間隔で |
| 接触 | 相対速度に応じた 1 発 |
| 周回通過 / スタートシグナル | `lead` ロールの単音 |

すべて `playOneShot` 経由なので、世代が変われば音色も自動的に変わる。**このファイルには「いつ鳴らすか」しか書かない。**

立ち上がり（前ティックとの差）で 1 発だけ鳴らす音（ブレーキの一撃・接触・周回通過・シグナル）と、押している間ずっと一定間隔で鳴らし続ける音（擦過音・路外）を分けて持つ。後者はエンジン音と同じく `AudioContext` の時計で予約するが、**先読みは 1 発ぶんだけ**にする — 長く採ると、離した後にも予約が残って鳴り続ける。

---

## 5. 入力・ゲーム進行

### 5.1 アクション定義

```ts
const ACTIONS = defineActions({
  steer:      'axis1d',   // 左右
  throttle:   'button',   // holdRampMs でデジタル世代でもアナログ値を作る
  brake:      'button',
  glance:     'button',   // 後方確認（任意）
  genPrev:    'button',
  genNext:    'button',
  pause:      'button',
  confirm:    'button',   // 決定（フェーズ 7 で追加）
  back:       'button',   // 戻る（フェーズ 7 で追加）
});
```

- キーボード: ←→ / Z（アクセル） / X（ブレーキ） / Q・E（世代切替） / Esc（ポーズ） / Enter・Space・Z（決定） / Backspace（戻る）
- ゲームパッド: 左スティック X / A / B / LB・RB / Start
- **決定はアクセルと同じキーで受ける**（実装で確定）。走り出すのと走らせ続けるのが同じ操作になり、タイトルで押したキーをそのまま踏み続けられる。`back` を Esc と分けてあるのは、走行中の Esc をポーズに使うため。`Backspace` はブラウザの既定動作（履歴を戻る）に食われるので `main.ts` で止める。
- `ActionMap.sample(snapshot, profile, dtMs)` に**現在の世代プロファイルを渡す**。`dpad4` の世代では斜め入力が落ち、`holdRampMs` によりキー押下時間からアナログ量が作られる。`analogAxes: 2` の世代ではスティックがそのまま効く。
- **注意**: 入力の解釈が世代で変わると同じ操作でも挙動が変わる。要求「ゲームの進行は同期し」は「**世代を切り替えてもレース状態が引き継がれる**」の意味と解釈し、入力の作法の差は世代表現の一部として許容する。`holdRampMs` を短め（180 ms）にして差を最小化する。

### 5.2 レース進行

- 状態機械（`src/game/flow/screens.ts`）:

```
title ──決定──> countdown ──> racing ──> finished ──> result ──┬─ リトライ ─> countdown
  ▲                                                            └─ タイトルへ ─┐
  └────────────────────────────────────────────────────────────────────────────┘
```

- `title` 中も `RaceSim` を AI 8 台で回す（アトラクトデモ、§3.7）。決定へ進む際にシムを**シードから作り直す**ので、デモの内容がレース結果に影響しない。
  - **シードは「何度目のレースか」だけで決まる**（実装で確定）。デモを何 tick 眺めたかが混ざらないので、「タイトル画面を眺めていた時間でレース内容が変わる」ことが構造的に起きない。それでいてリトライは別のシードになり、同じレースの繰り返しにならない。`flow.spec.ts` が状態ハッシュで固定する。
  - デモ中のレースが完走したら、次のデモを新しく起こす（タイトルで放置しても止まらない）。
- `countdown` は 3・2・1・GO の 4 秒。この間シムは走行入力を受け付けないが、ティックは進む（フライング判定は行わない）。画面には残り秒を切り上げた数字を出し、最後の 1 秒と `racing` の頭 1 秒が「GO!」になる — `sfx.ts` のシグナル音と同じ境目なので音と絵がずれない。
- `racing → finished` は**自機がゴールした時点**（実装で確定）。全 8 台の完走を待つと、後続を眺めるだけの時間が長く続く。`finished` の間もシムは回り続け、ライバルが順にゴールしていく。180 tick（3 秒）置いて `result` へ移る。
- `result` 中もシムを回す。後続がゴールして順位が入れ替わる画が背景で続き、リザルト表もその世代の更新レートで書き換わる。
- **ポーズ**（Esc）はシムのティックを止めるが、`screenTicks` は進める（「PAUSED」の明滅が固まらないように）。世代切替は止めない。
- **世代切替はすべての状態で有効**。状態機械は世代を知らない。
- 周回判定は `s` のラップ跨ぎで行う（ワールド座標のライン交差ではなくトラック空間で判定 ⇒ 決定論的）
- 順位 = `lap * trackLength + s` の降順
- ラップタイムはティック数で保持し、表示時のみ秒に変換する（浮動小数の累積誤差を避ける）

### 5.3 車両モデル（アーケード寄り）

```
throttle/brake → 目標速度 → 速度（一次遅れ）
steer → ヨー角速度（速度依存。低速では効きが弱い）
遠心力: lateral += curvature * speed² * k * dt      （コーナー外側へ押される）
グリップ: |lateral| > halfWidth で減速・砂埃・操作性低下
車体ロール / ピッチはビュー専用の派生値（シムには影響しない）
```

AI は「理想ライン（`lateral` の目標値をコーナー曲率から生成）＋個体差ノイズ（決定論的 RNG）＋前方車回避」で走らせる。`context.rng` を使い、同一シードで完全再現できるようにする。

---

## 6. 品質基準と検証

要求に「そのコンソール世代で可能な表現を用いた象徴的なタイトル品質を要求、それを満たすまで改善を行なってください」とあるため、**合否を判定できる基準**を先に決め、満たすまで §7 のフェーズ 8 を回す。

### 6.1 世代ごとの受け入れ基準

**第1世代（FC）**

1. 画面から色を抽出して**同時 25 色以内**に収まっている
2. 路面が走査線単位で曲率に追従し、コーナーで中心が画面横方向に流れる
3. センターラインの流れる速さが速度と単調に対応している
4. 走査線あたり 9 台以上が重なったときにスプライトが消え、当たり判定も消える
5. スプライトのステアフレームと車体の見た目が 6Hz でしか更新されない。**直線ではステアフレームが正面のまま**（8-1）
6. 半透明が画面上に一切現れない
7. 遠景が自機の向きに応じてパララックスする
8. 遠景スクロール量とスプライト配置座標が 8px に丸められている（`tileSnap`）
9. ミニマップが表示され、8 台のマーカーが動いている。密集時はマーカーが**ちらつく**（消えっぱなしにならない）

**第2世代（SFC）**

1. 路面が走査線ごとのアフィン変換で描かれ、コーナーで**視界が傾く**
2. 描画距離が第1世代より明確に長く、遠方がフォグで海に溶ける
3. 落ち影・半透明が RGB555 color math（加算・half）で使われている
4. 同時色数が第1世代より明確に多い（256 色モード）
5. 12Hz の更新レートが第1世代（6Hz）と見分けられる
6. 路面テクスチャが 8×8 タイル 256 種以内で構成され、遠方の走査線がちらつかない（8-2）

**第3世代（PS1）**

1. 車が 3D メッシュとして描かれ、コースが 3D の起伏とバンクを持つ
2. 頂点の揺れ（`vertexQuantize`）が**面の波打ちとして**見える（物体全体の平行移動に見えてはいけない ⇒ 分割が粗すぎない）
3. テクスチャのアフィン歪みが路面と車体に見える
4. 深度バッファが無いことによる前後関係の乱れが**破綻ではなく味**の範囲に収まっている（車がコースに埋まらない）
5. フォグで描画距離が切られている
6. 30Hz の更新レート

**第4世代（PS2）**

1. 車体に環境マップの映り込みがあり、車の向きに応じて流れる
2. 空と映り込みが同じ環境マップで一致している
3. 動的ライトによる落ち影が路面の起伏に沿う
4. 640×448 / linear フィルタで、同じ車モデルでも第3世代と一目で区別できる
5. 60Hz の更新レート

**世代横断**

1. 4 世代のどこで切り替えても**順位・周回・ラップタイム・車の位置が完全に保存される**
2. 切替中も BGM が途切れず、**曲の位置（小節・拍）が保存される**
3. 切替演出中の 2 世代合成が破綻しない
4. タイトル画面・カウントダウン・リザルトのすべてで世代切替が効き、各世代らしく描かれる
5. タイトル画面のアトラクトデモが 4 世代とも動いており、**画面を見ただけで世代の違いが分かる**
6. **ミニマップが 4 世代すべてに表示され、8 台のマーカーが同じコース上の同じ位置を指す**。世代を切り替えてもマーカーは動き続け、位置が飛ばない（＝1 つのシミュレーションが動いていることが画面で分かる）
7. ミニマップの見た目（解像度・色数・更新レート）は世代ごとに違うが、**マーカーの正規化座標は 4 世代で一致する**（自動テストで固定）
8. **背景オブジェクトが 4 世代とも同じ場所に立っている**（8-6。出す物は世代で違うが、出す場所は 1 つの表から出る）
9. **トンネル区間が 4 世代とも同じ弧長にあり、それぞれの道具で出ている**（8-9。走査線の明るさ／color math ／焼いたメッシュ／照明の入れ替え）

### 6.2 自動テスト

| テスト | 内容 |
| --- | --- |
| `track.spec.ts` | 中心線の閉ループ性、弧長の単調性、`toWorld ∘ toTrack` の往復誤差 < 1 mm |
| `sim-determinism.spec.ts` | 同一シード・同一入力列で 10,000 ティック回し、状態ハッシュが一致する |
| `generation-invariance.spec.ts` | 500 ティック目に世代を FC→PS2→SFC→PS1 と切り替え、切り替えない実行と**状態ハッシュが完全一致**する |
| `raster-scanline.spec.ts` | 全行の `width ∈ (0,1]`、`brightness ∈ [0,1]`、`scanlines.length === height*4` を満たす（`validateRasterSurface` は例外を投げるため、投げないことを確認） |
| `affine-surface.spec.ts` | `validateAffineSurface` が全行で通る。`affineUvAt` の CPU 参照と自前の逆算が一致 |
| `frame-contract.spec.ts` | 各ビューが積んだ全 `MeshCommand.material` に対応する `MaterialCommand` が存在する（実行時 `throw` の事前検出）。あわせて全マテリアルが `baseColorTexture` を持ち（fallback 柄で描かれる事故の検出）、`baseColorTexture` と `environmentTexture` が `flipY: false` で登録されている（上下逆に貼られる事故の検出） |
| `gen4-environment.spec.ts` | 環境マップの画素と定数の突き合わせ: 空の階調とフォグ色が実測値から外れていない・`SUN_DIRECTION` が最輝点と 3° 以内で一致・遠景の帯が切り出しの行そのもので地平線より下が一様に潰れている・帯の U が映り込みと同じ式でカメラの方位から決まりどの画角でも画面を覆いきる・影が専用メッシュで落ち車体に `scale` が入らない・描画順の指定を 1 つも持たない |
| `capability-contract.spec.ts` | §1.4 の能力契約をコマンド列に対して検査する: FC は 8px 丸め済み・`hardwareBlend` を持つコマンド 0 件・スプライト走査線制限適用済み、SFC は丸め無し。各コマンドの `hardwareBlend` が `generationSupportsHardwareBlend()` を満たし、`generations` と食い違わないこと（実行時 `throw` の事前検出）。世代 ID 直接分岐が無いことは ESLint ルールではなくレビュー項目とする |
| `palette-budget.spec.ts` | 各世代のビューが使う色定数（`defineGenerationVariant` にまとまっている）を数え、FC が 25 色以内・SFC が 256 色以内に収まる。実画面の色数は §7 フェーズ 8 でスクリーンショットから計測する |
| `score-phase.spec.ts` | 4 × 4 の全ての切替で `phasePreserved` が真。あわせて 4 編曲のテンポ・拍子・曲長が一致し、**同じ和声進行・同じ主旋律**の上に立っていること、同時発音数が声数の契約を守り効果音のぶんを 1 声以上空けていること |
| `race-audio.spec.ts` | エンジン音の予約が現在時刻より先で先読みの内側に収まる・時計が飛んでも溜まらない・回転が鋸歯になる・声数の少ない世代ほど間隔が空く。効果音は立ち上がりで 1 発・保持中は繰り返し・離すと止まる。定位を持たない世代へ `pan` を渡さない |
| `manifest.spec.ts` | manifest の全 URL が `public/` に実在する |
| `minimap.spec.ts` | **4 世代それぞれのミニマップを組み立て、8 台のマーカーの正規化座標が世代間で完全一致する**（要求「1 つのシステムで動いていることの証明」の機械的な担保）。あわせて全マーカーが矩形内、FC は 8px 丸め済み、マーカー数が常に 8 であること。`build-minimap.mjs` が使う `trackBounds` と実行時の `trackBounds` が同値であること |
| `flow.spec.ts` | 状態機械が `title → countdown → racing → finished → result → title/countdown` を正しく遷移する。**`title` のアトラクトデモを何 tick 眺めてもレースの状態ハッシュが変わらない**（デモの分離）。ポーズでシムが止まり `screenTicks` は進む。リトライは前のレースと別のシードになる |
| `font-atlas.spec.ts` | 焼いたフォントとロゴの向きと形: 字形がセルの左上 5×7 に収まる・上下がセルの中で反転している・小文字に大文字の字形が入っている・**塗りつぶしセルだけがセルいっぱい**・画素が完全な透明か不透明な白しかない。ロゴは半端な α を持たず FC の 25 色に収まる |
| `hud.spec.ts` | **4 世代の HUD が同じ数字を出す**（世代で変わるのは名札だけ）。全ての塊が安全領域の内側で互いに重ならない。FC は `hardwareBlend` 0 件で字がタイル境界に載る。ラップタイムが表示の更新レートで止まる（FC の 10 ティックで表示が 1 種類） |
| `screen-layout.spec.ts` | タイトル・カウントダウン・GO・FINISH・ポーズ・リザルトを 4 世代 × 5 画面で組み立て、**画面からはみ出さない・ミニマップの矩形と重ならない・互いに重ならない**ことを固定する。画面の文字が必ず最前面に積まれること、FC がどの画面でも半透明を持たないことも見る |
| `car-sprite.spec.ts` | 直線区間では最大舵・最大横加速度でもステアフレームが正面のまま。曲率の高い区間では符号が正しい側を返す（8-1） |
| `road-texture.spec.ts` | 焼いた路面のユニーク 8×8 タイルが 256 種以内・全画素が RGB555 の格子上・V 方向の模様の境目がタイル境界に載る。遠景がタイルあたり 16 色に収まる（8-2） |
| `camera.spec.ts` | 世代ごとの視点リストが定義どおり・車内視点では自機のメッシュとその影が 1 つも積まれない・目線が常に路面より上・視点を変えても状態ハッシュが変わらない（8-5） |
| `scenery.spec.ts` | 4 世代が同じ `sceneryObjects()` を読み、看板の `s` が世代間で完全一致する。FC は 8px 丸め済み・`hardwareBlend` 0 件・看板 1 種だけ。第3世代の木は車と同じスロット 9、第4世代は描画順の指定を持たない（8-6）。焼いた木のセルが世代ごとに正しい向き（第4世代は 3 種とも）・木の背丈が 4 種類以上ある（8-10） |
| `tunnel.spec.ts` | 4 世代が同じ区間を読む。区間の中に背景オブジェクトが 1 つも無い。焼いたメッシュが内空の寸法どおりで、路面の真上には天井しか無い。灯具は下向きの帯 1 本。第3・第4世代は躯体と灯具を別マテリアルで積み、灯具の `ambient` が 1 を超える。**第4世代だけが照明・映り込み・フォグを入れ替える**。擬似3D の 2 世代は坑口をスプライトで抜き、メッシュを 1 つも積まず、FC は半透明を持たない（8-9） |
| `check-cars.mjs` | 変換済み GLB / テクスチャの SHA-256 が `car-conversion.json` と一致する |
| `prepare-cars` 再現性 | `prepare:cars` を 2 回実行して出力がバイト一致し、かつ既存ファイルと一致する（フェーズ 2 で 1 回確認、以後は手動） |
| 生成ツール再現性 | `build:assets` を 2 回実行して `git status` に差分が出ない（**フェーズ 7 で確認済み** — ミニマップ・コースメッシュ・塗装・路面・スプライト・遠景の帯・フォント・ロゴのすべてがバイト一致） |

### 6.3 性能予算

| 項目 | 予算 |
| --- | --- |
| フレーム時間 | 16.6 ms（60 fps）を全世代で維持 |
| 三角形数 | 20,000 tri/frame（エンジンの明示予算）。**路面だけで使い切らないこと**を LOD の制約として持つ |
| ドローコール | 第2世代の per-scanline アフィンが最大。240 コール以内。超えたら帯を 2→4 行に粗くする |
| 初回ロード | manifest が読む全アセット合計 **4.95 MB**（フェーズ 8 実測・90 ファイル）。プリロード完了まで進行度表示を出す |

内訳の大きいものは第4世代のコースメッシュ（1.89 MB）・環境マップ（0.70 MB）・第4世代の車モデル（0.58 MB）・第3世代のコースメッシュ（0.47 MB）・遠景の帯（0.35 MB）。`public/assets` のディスク上は 6.3 MB だが、変換記録用に残している車の base color は実行時に読まない。

計画時の見積もりは 2.6 MB で、第4世代のコースメッシュ（1 m 刻み × 3,100 輪）が想定より重い。1 m 刻みは標高とバンクの滑らかさに直結する要求（§6.1 第4世代基準 3）なので刻みは落とさず、**初回ロードの予算のほうを実測値へ改める**。減らすなら横分割（現在 6）を先に削る余地がある。

車体色を「無彩色 1 枚 × 実行時の乗算」にしたことで、塗装テクスチャは第3世代 57 KB・第4世代 186 KB で済んでいる（エントラントごとに焼き分けると第3世代だけで 1.02 MB、第4世代を 1024² で 8 枚焼くと 10 MB になっていた）。

**三角形の実測**（走行中の 1 フレーム・8-6 の壁を焼き込んだ後）: 第3世代は路面 3 セクター 6,984 tri ＋ 車 8 台 7,824 tri ＝ 約 14,800 tri。第4世代は路面 11 セクター 16,368 tri ＋ 車 8 台 108,944 tri で、**予算を大きく超える**。20,000 tri はリリースノートが第3世代の ordering table の partition 性能（CPU 側の安定分割）を測った値であり、深度バッファがあってソートを一切しない第4世代には掛からない。

**フレーム時間の実測**（フェーズ 8・1920×1440 のバックバッファ・`gl.finish()` まで待った中央値 / 最大 [ms]）: FC 0.3 / 6.3・SFC **4.3 / 6.1**・PS1 0.8 / 1.1・PS2 1.0 / 4.1・切替演出中 2.1 / 4.3。**予算 16.6 ms に対して最悪でも 6.3 ms** なので、第4世代の車の LOD は入れない（入れる根拠が無い）。いちばん重いのは予想どおり第2世代の走査線ごとのアフィン面である。

**コマンド数の実測**（走行中の 1 フレーム）: FC 66・SFC 278（うちアフィン面 135）・PS1 103・PS2 208。第2世代の 278 は 240 を超えて見えるが、内訳の 141 はスクリーン空間スプライト（HUD の 1 文字 1 枚が大半）で同じアトラスを引く。予算が想定していた per-scanline のドローコールは 135 本で内側に収まっており、実測のフレーム時間も 6.1 ms なので超過としては扱わない。詳細は `Docs/QUALITY_REVIEW.md`。

---

## 7. フェーズ計画

各フェーズの終わりに動く物ができる形で並べている。

### フェーズ 0 — 基盤

- `package.json` の拡充（`name` / `type: "module"` / `scripts` / devDependencies）、`tsconfig.json` / `vite.config.ts` / `index.html` を作成（エンジンは導入済み）
- ルート `README.md` を新規作成し、**エンジン tarball の入手先・配置場所・SHA-256・`npm install` 手順**を記載する（決定事項 §9-5 の (c)）。`.gitignore` の `reference/` はそのまま
- `data/README.md` のモノレポ時代の記述（`apps/racing/...` / `-w @console-chaos/racing`）を本リポジトリの構成に合わせて更新する
- `bootstrap.ts`: `createAssetManager` → `createGenerationWebGlRenderer`（manifest 付き）→ `createGenerationAudioService` → `createGameHost` の配線
- `assets/manifest.ts`: 既存アセットを全登録（`fallbackTextures` は 4 世代とも `common/fallback.png`）
- `view/shared/quantize.ts`（`quantizeTime`）と `defineGenerationVariant` を使った世代差テーブルの置き場所を先に用意する
- 空の `GameModule` で 4 世代とも背景色と 1 個の箱が出る。Q/E で世代が切り替わり CRT の質感が変わる
- **完了条件**: 4 世代の切替が目で確認でき、フレーム落ちが無い。CRT の差（RF の強いにじみ → component の鮮明さ）が §1.4 のプリセット表どおりに見える

### フェーズ 1 — 共通シミュレーション

- `track-data.ts` / `track.ts`（Catmull-Rom → 1 m リサンプリング → `TrackSample[]` / `trackBounds` / `trackLength`）
- `vehicle.ts` / `ai.ts` / `race.ts` / `state.ts`
- `tools/build-minimap.mjs` → 世代別ミニマップ PNG と `common/markers.png` を生成
- `view/shared/minimap.ts` — **ここで作るミニマップがフェーズ 1 の可視化そのものになる**。専用のデバッグ描画は作らず、最初から本番のミニマップを画面いっぱいに出して 8 台の走りを確認する。以降のフェーズではこれを右下へ縮小配置するだけ
- `track.spec.ts` / `sim-determinism.spec.ts` / `generation-invariance.spec.ts` / `minimap.spec.ts`
- **完了条件**: 8 台が 3 周を完走し、順位とラップタイムが出る。決定論テストが通る。**4 世代のどれで見てもミニマップ上の 8 台が同じ位置を走る**（この時点で「1 つのシステム」が画面で確認できる状態にする）

### フェーズ 2 — 第3世代（PS1）

- `tools/build-track-mesh.mjs`（粗 LOD）でコース GLB を生成
- `tools/prepare-cars.mjs` を実装し、**まず現行の runtime ファイルを再生成して SHA-256 が一致することを確認する**（ツール自体の検証。§2.6）
- `view/shared/camera.ts` / `view/gen3-ps1.ts`
- 車モデルの前方軸補正、`polygonSort` / `polygonSortRange` / `orderTableIndex`、フォグ、セクター分割
- ミニマップを右下へ縮小配置（PS1 の variant 設定）
- **完了条件**: 3D で走れる。§6.1 の第3世代基準 1–6 を満たす。`prepare:cars` → `check:cars` が通る。**ミニマップのマーカーと 3D 空間の車の位置が一致する**（世界モデルの目視検証としてここで効く）
- **なぜ先か**: 最も素直な 3D で世界モデルの妥当性を目視検証でき、以降のフェーズの土台になる

### フェーズ 3 — 第1世代（FC）

- `tools/build-road-texture.mjs`（広い路面テクスチャ）と `tools/build-car-sprites.mjs`（スプライトの整形）
- `view/shared/projection.ts` / `backdrop.ts` / `car-sprite.ts` / `road-surface.ts`
- `view/gen1-fc.ts`（ラスターサーフェス、`applyScanlineLimit`、6Hz 量子化）
- ミニマップの FC variant（8px グリッド配置、2 色マーカー、走査線制限への参加と順序巡回）
- `raster-scanline.spec.ts` / `capability-contract.spec.ts`
- **完了条件**: §6.1 の第1世代基準 1–9 を満たす
- **残件**（フェーズ 8 で扱う）:
  - 基準 1・4 の実測 — 実画面の色数カウントと、9 台が重なる場面のスクリーンショット確認。自機が先頭を走るあいだライバルは常に後方にいるため、密集の場面は自機を操作するか AI の速度差を付ける必要がある
  - ミニマップのマーカー（2×2 px・白/灰）が白い輪郭線に紛れる。FC の 2 色制約の中で読ませる方法は要検討
- **なぜここか**: 4 世代で最も調整量が多く、リスクが高い。早く着手して改善の時間を確保する

### フェーズ 4 — 第2世代（SFC）✅ 実装済み

- `tools/build-road-texture.mjs` を世代テーブル化し、アフィン用の路面テクスチャを追加生成
- `view/shared/affine-surface.ts`（走査線ごとのアフィン、傾き、帯粒度）
- `view/gen2-sfc.ts`（フォグの帯、落ち影、12Hz 量子化）
- `view/shared/sprite-plane.ts` — 走査線制限・重ね順・BG 相当の扱いを第1世代と共通化
- ミニマップの SFC variant（半透明パネル、影付きマーカー）はフェーズ 1 の実装がそのまま効く
- `affine-surface.spec.ts`、帯粒度のフォールバック（切替演出中は 2 行）
- **完了条件**: §6.1 の第2世代基準 1–5 を満たす
- フェーズ 3 の `projection.ts` をそのまま使うため実装量は小さい
- **残件**（フェーズ 8 で扱う）:
  - 基準 4 の実測 — 実画面の色数カウント（第1世代との差が数値で出るか）
  - フォグの帯は 50% の段階しか作れないため、最も手前の段の境目が横線として見える可能性がある。実画面で確認し、必要なら段を増やすか距離を調整する

### フェーズ 5 — 第4世代（PS2）✅ 実装済み

- `tools/build-track-mesh.mjs` の細 LOD 出力（50 セクター × 62 輪 / 刻み 1.000 m / 路面アトラス 512²）
- `tools/build-skyline.mjs` — 環境マップから地平線の帯を焼く（flipY の要求が逆で 1 枚を共用できないため）
- `view/gen4-ps2.ts`（環境マップ、遠景の帯、動的ライト、影専用メッシュによる落ち影、60Hz）
- ミニマップの PS2 variant（176²、順位色、自機の強調縁）はフェーズ 1 の実装がそのまま効く
- `gen4-environment.spec.ts`、`frame-contract.spec.ts` に `environmentTexture` の flipY 規約
- 4 世代とも専用ビューが揃ったので暫定表示 `view/placeholder.ts` を削除
- **完了条件**: §6.1 の第4世代基準 1–5 を満たす。**4 世代すべてでミニマップが揃い、世代横断基準 6–7 を満たす**
- **残件**（フェーズ 8 で扱う）:
  - 三角形の実測が予算を超えている（§6.3）。実フレーム時間を測り、必要なら遠方の車を第3世代のモデルへ落とす LOD を入れる
  - 初回ロードが 4.41 MB。第4世代のコースメッシュが 1.89 MB を占める（§6.3）
  - 遠景の帯は仰角を線形に画面へ写しているため、水平線から離れるほど本来の tan とずれる。空しか無い範囲なので見えないが、雲の位置は厳密には正しくない

### フェーズ 6 — サウンド ✅ 実装済み

- `audio/score.ts`（1 つの曲 ＋ 4 編曲。イ短調 152 BPM・32 小節）
- `audio/engine-sound.ts`（4 段の擬似ギア・先読み予約・声数から決まる間隔）/ `audio/sfx.ts`
- `module.ts` の配線（起動時の `playScore`、`onSwitch` での `useScore`、毎ティックの更新）
- `score-phase.spec.ts` / `race-audio.spec.ts`、手書きの `AudioService`（`tests/support/audio.ts`）
- **完了条件**: 世代を切り替えても曲が途切れず、音色と編成だけが変わる。エンジン音が速度に追従し、ブレーキ音が鳴る
- **残件**（フェーズ 8 で扱う）:
  - 実際に耳で聴いた調整。音量バランス（BGM と効果音の比）と、第1世代でエンジン音が BGM をどれだけ食うかは実機の音で確かめるしかない
  - `installAudioUnlock` はフェーズ 0 から入っているが、解錠を促す画面表示はフェーズ 7 のタイトル画面で足す

### フェーズ 7 — タイトル画面・HUD・ゲームフロー ✅ 実装済み

- `tools/build-font-atlas.mjs` → `common/font.png`（16×6 セル・128×48）、`tools/build-title-logo.mjs` → `common/logo.png`（256×64）を生成し manifest に登録。字形は `tools/lib/glyphs.mjs` の 5×7 を両者で共有する
- `view/shared/text.ts` / `centered-text.ts` / `hud.ts`、世代別の HUD 表現。文字の世代差は `TEXT_STYLES` の 1 つの表にまとめ、**タイトルとリザルトも同じ表を通す**
- `flow/screens.ts`（`title → countdown → racing → finished → result`）、`view/title.ts` / `view/overlay.ts`
- タイトル画面のアトラクトデモ（AI 8 台のシムを背景として描く。§3.7）
- リトライ / タイトルへ戻る / ポーズ
- `flow.spec.ts` / `font-atlas.spec.ts` / `hud.spec.ts` / `screen-layout.spec.ts`、`build:assets` の 2 回実行で差分が出ないことの確認（**確認済み**）
- **完了条件**: タイトルからリザルトまで通しで遊べる。§6.1 の世代横断基準 4–5 を満たす
- **残件**（フェーズ 8 で扱う）:
  - 第1世代の HUD は `translucency: none` の契約どおり単色でパネルを持たないため、遠景の雲の上に来る右上のラップタイムの読みにくさが残る。タイトルとリザルトは不透明の帯を敷いて解決したが、走行中の HUD に帯を敷くと画面が狭くなる。実画面での色数計測（基準 1）とあわせて判断する
  - タイトルの操作説明は 2 行に収めるため `Z ACCEL / X BRAKE / Q E` だけを出しており、ブレーキ以外の操作（ポーズ・戻る）は HTML 側のヒントにしか無い
  - リザルトの表は 8 台ぶんの順位とベストラップのみ。総合タイムや自機のラップ内訳は出していない

### フェーズ 8 — 品質ゲートと改善ループ ✅ 実装済み

要求「それを満たすまで改善を行なってください」に対応する反復フェーズ。**2 種類の作業がある** — (A) §6.1 の基準の実測と、フェーズ 3–7 が残した残件の解消。(B) 実画面を見たうえで追加された改良項目（下の 8-1〜8-8）。

**結果**: §6.1 の全基準を実画面で計測し、`Docs/QUALITY_REVIEW.md` に記録した。8-1〜8-11 はすべて実施済み。実測の要点は次のとおり。

- **同時色数**（CRT を切って計測）: FC 20 色 / SFC 207 色 / PS1 2,877 色 / PS2 32,825 色。FC は同時 25 色の契約の内側
- **フレーム時間**（1920×1440・`gl.finish()` まで待った実測）: 最悪でも 6.3 ms（第2世代の走査線アフィンが最も重い）。予算 16.6 ms の内側
- **初回ロード**: 95 ファイル 6.35 MB（フェーズ 5 の 4.41 MB から、タコメーター・内装・背景アトラス・壁と金網を焼き込んだコースメッシュ・トンネルのぶん増えた）
- 計測のために足した口は 2 つだけで、どちらも**開発時にしか存在しない** — `vite.config.ts` の `POST /__screenshot`（`apply: 'serve'`）と `bootstrap.ts` の `?crt=off`（`import.meta.env.DEV` の内側）

**残件**（`Docs/QUALITY_REVIEW.md` §9）: 音を耳で確認していないこと・第1世代の遠景が BG の 2bpp（タイルあたり 4 色）に収まらないこと・第1世代の走行 HUD が雲の上で読みにくいこと・第3世代のトンネルで路面が暗くならないこと・金網が遠方でちらつくこと・リザルトの表が順位とベストラップのみであること。

1. §6.1 の全基準をチェックリストとして実施し、結果を `Docs/QUALITY_REVIEW.md` に記録する
2. 各世代のスクリーンショットを `Docs/screenshots/` に保存し、世代間の差が一目で分かるか確認する
3. 満たさない項目について原因を切り分け、以下の順で手を打つ
   - パラメータ調整（`focal` / `camY` / `yH` / フォグ / 色）
   - ビュー実装の作り直し
   - **アセットの追加生成**（第2世代のコースマップ PNG、第1世代の横に広い road テクスチャ、追加の遠景レイヤーなど）
4. 全項目が通るまで 1–3 を繰り返す
5. 下の改良項目 8-1〜8-11 を実施し、それぞれの検証を通す。**着手順は 8-8 → 8-7 → 8-1 → 8-4 → 8-3 → 8-5 → 8-2 → 8-6 → 8-10 → 8-9 → 8-11**（表示と入力のように小さく閉じる物を先に、アセットの再生成を伴う物を後に置く）

#### 改良項目の一覧

| # | 項目 | 対象世代 | 主に触るファイル | アセット再生成 | 状態 |
| --- | --- | --- | --- | --- | --- |
| 8-1 | 直線でステアフレームを出さない | 1・2 | `view/shared/car-sprite.ts` | 無 | ✅ |
| 8-2 | アフィン面の解像度を SFC の BG スペックへ落とす | 2 | `road-surface.ts` / `tools/build-road-texture.mjs` / `tools/build-backdrop.mjs` | **有** | ✅ |
| 8-3 | タコメーターを左下に追加 | 3・4 | `view/shared/tachometer.ts` / `tools/build-gauge.mjs` / `hud.ts` | **有** | ✅ |
| 8-4 | カメラを車体へ近づける | 3・4 | `view/shared/camera.ts` | 無 | ✅ |
| 8-5 | 視点切り替え（フロントガラス／内装） | 3・4 | `camera.ts` / `cockpit.ts` / `gen3-ps1.ts` / `gen4-ps2.ts` / `bindings.ts` | **有**（内装のみ） | ✅ |
| 8-6 | 背景オブジェクト | 全 | `view/shared/scenery*.ts` / `tools/build-track-mesh.mjs` / `tools/build-scenery-*.mjs` | **有** | ✅ |
| 8-7 | 1・2・3・4 キーで世代を直接選ぶ | 全 | `input/bindings.ts` / `module.ts` | 無 | ✅ |
| 8-8 | 世代表示を左上へ・`CH n : NTH GEN` | 全 | `view/shared/hud.ts` | 無 | ✅ |
| 8-9 | トンネル区間 | 全 | `view/shared/tunnel*.ts` / `tools/build-tunnel-mesh.mjs` / 4 つのビュー | **有** | ✅ |
| 8-10 | 第4世代の背景オブジェクトを高品質化 | 4 | `track-mesh.ts` / `scenery-mesh.ts` / `scenery-sprite.ts` / `tools/build-{track,scenery}-*.mjs` | **有** | ✅ |
| 8-11 | 中央線がアフィン歪みで折れるのを直す | 3（4 は同伴） | `track-mesh.ts` / `tools/build-track-mesh.mjs` | **有** | ✅ |

---

#### 8-1 直線ではカーブのスプライトを出さない（第1・第2世代）

**現象**: 直線を走っているのに車の絵が左右の傾きセルへ切り替わる。`steerCellOffset()` は横加速度の絶対値が 3.5 m/s² を超えたら傾きへ移るが、直線でも自機の小さな修正舵と AI の車線取りでこの値を跨ぐ。6Hz / 12Hz の量子化と重なって「パタパタ切り替わる」見え方になる。

**決定**:

- 判定を**横加速度 ∧ コース曲率**の AND にする。曲率は `TrackSample.curvature` を車の `s` で引き、`|κ| ≥ 1/240 m⁻¹`（半径 240 m 未満）を「カーブ」とみなす。直線区間（κ ≒ 0）ではどれだけ舵を当てても正面のセル（1 / 4）のままになる
- 横加速度側の閾値も上げる（3.5 → 5.0 m/s²）。2 つの閾値は `STEER_FRAME: GenerationVariant<…>` の 1 表へ出し、6Hz と 12Hz で切り替わりの見え方が違うぶんだけ別々に調整できるようにする
- **ヒステリシスは入れない**。「ビューは状態を持たない純関数」（§2.1）を崩さないため、二重閾値ではなく AND ゲートで解決する
- 列と向きの対応（列 0 が右コーナー・§3.2）は変えない。変えるのは「いつ正面へ戻すか」だけ

**検証**: `car-sprite.spec.ts`（新規）— 直線区間の `s` で最大舵・最大横加速度を与えても `steerCellOffset()` が正面を返す。曲率の高い区間では符号が正しい側を返す。§6.1 第1世代基準 5 の隣に「直線ではステアフレームが正面のまま」を足す。

---

#### 8-2 第2世代のアフィン面の解像度を SFC の BG スペックへ落とす

**現象**: アフィン面（Mode 7 相当）の路面が細かすぎる。実機の Mode 7 面は **128×128 タイル ＝ 1024×1024 px** だが、タイルの実体は **256 種**しか置けない（8bpp・面あたり 256 タイル）。現在の `road_affine.png` は 1024×512 の**全画素ユニーク**で、実機には焼けない情報量を持っている。それが遠方のちらつきとして出る — 最遠 220 m の行は画面 1 px が 0.73 m にあたり、10.7 texel/m のテクスチャを 14 倍に縮小して nearest で引いている。

**決定**（`road-surface.ts` の `SFC_ROAD` と `tools/build-road-texture.mjs`）:

- 生成を **8×8 タイル格子**に載せる。破線・縁石の縞・草地の帯の境目をタイル境界へ丸め、**ユニークな 8×8 タイルが 256 種以内**に収まるようにする。ツールがタイル数を数え、超えたら生成を失敗させる（実機に無い絵を焼かないための門）
- テクセル密度を落とす: **1024×512（10.7 × 5.3 texel/m）→ 512×256（5.3 × 2.7 texel/m）**。`spanMeters` / `periodMeters` は 96 m のまま変えない — 投影も V の 1 周期ずらしの性質（§3.3）も触らず、密度だけを落とす
- 密度に合わせて模様の寸法を格子へ載せ直す: `lineWidth` 0.36 m → 0.375 m（2 texel）、`kerbWidth` 0.9 m → 0.9375 m（5 texel）。近景はそのぶん粗く（ブロックに）見えるが、**それが Mode 7 の見え方そのもの**である
- 色は RGB555 の格子・同時 256 色のまま（既に守っている）
- 遠景 `coast.png`（512×192）も同じ規約で見直す。BG は 8×8 タイル・タイルあたり 16 色のパレット割りなので、§1.4 の `paletteBlockSize: 8` が意味を持つ形にする
- ちらつきの有無とタイル数の実測値を `Docs/QUALITY_REVIEW.md` に記録する

**検証**: `road-texture.spec.ts`（新規）— 焼いた PNG のユニーク 8×8 タイル数 ≤ 256・全画素が RGB555 の格子上・模様の境界がタイル境界に載っていること。§6.1 第2世代基準に「6. 路面テクスチャが 8×8 タイル 256 種以内で構成され、遠方の走査線がちらつかない」を足す。

---

#### 8-3 タコメーターを左下に追加（第3・第4世代）

**決定**: 新規 `view/shared/tachometer.ts`。

- 針の角度は `audio/engine-sound.ts` の `gearFor()` / `rpmFor()` を**そのまま呼ぶ**。メーターの針とエンジン音が同じ 1 つの式から出るので、シフトのたびに針が落ち、音とぴったり合う（擬似 4 段・§4.3）。読む速度は `DisplayLatch` を通した表示用の値にする — 30Hz / 60Hz で針も止まる
- 盤面と針は `tools/build-gauge.mjs` が焼く（`assets/gen3/hud/tacho.png` 128²・`assets/gen4/hud/tacho.png` 256²。目盛り・レッドゾーン・針・中央の丸を 1 枚のアトラスに置く）。針は `SpriteCommand.rotation` で回す — **実測: `writeSpriteModelMatrix` はスクリーン空間スプライトにも `rotation` を適用する**ので、針のセルを何枚も焼く必要は無い
- 位置は安全領域の左下。ギア段（`gearFor()` + 1）を盤の中央に、速度の数字はタコメーターの右隣へ寄せる（8-8 で `speed` の塊が 1 行に減るので収まる）。ミニマップは右下のままなので衝突しない
- **第1・第2世代には出さない。** アナログのメーターは 3D 世代の HUD の作法であり、FC / SFC では `translucency` と色数の制約にも触れる。世代差は `TACHOMETERS: GenerationVariant<TachometerLayout | null>` の 1 表に置き、FC / SFC は `null` — ビューに世代 ID 分岐を書かない（§1.4）
- 半透明の作法は `TEXT_STYLES` と揃える（PS1 は `gen3-semitransparency` の average、PS2 は `gen4-gs` の source-over）

**検証**: `hud.spec.ts` を拡張 — 盤・針・数字が安全領域の内側でミニマップ矩形と重ならない。針の角度が `rpmFor()` と単調に対応し、表示の更新レートで止まる。FC / SFC では 1 コマンドも積まれない。

---

#### 8-4 第3・第4世代のカメラを車体へ近づける

**現象**: 追走カメラが後方 6.5 m・高さ 2.2 m と引きすぎており、車が画面の 1/6 ほどしか占めない。第4世代の署名的表現である映り込み（§6.1 基準 1）も、第3世代の頂点の揺れ（基準 2）も読み取りにくい。

**決定**（`view/shared/camera.ts` の `CAMERA` を差し替える。3・4 世代の共用のまま）:

| 値 | 当初 | 変更後 | 理由 |
| --- | --- | --- | --- |
| `BEHIND` | 6.5 m | **3.2 m** | 車体を画面の主役にする |
| `HEIGHT` | 2.2 m | **1.25 m** | 見下ろしを浅くして速度感を出す |
| `LOOK_AHEAD` | 12 m | **7 m** | 近づけたぶん注視点も引き寄せる（遠いままだと車が画面下端へ落ちる） |
| `TARGET_HEIGHT` | 0.9 m | **0.7 m** | 同上 |
| `BEHIND_STRETCH` | 1.6 m | **0.9 m** | 最高速でも 4.1 m に収める |
| `LATERAL_LAG_MAX` | （無し） | **1.2 m** | 下記「コースアウトしても自機を画面に残す」 |
| `TARGET_LAG_MAX` | （無し） | **0.6 m** | 同上 |

**コースアウトしても自機を画面に残す**（実画面で確認して追加）。カメラの横位置は
自機の横位置に追従率 0.55 を掛けて作っていたので、**遅れ（`lateral × 0.45`）が
横位置に比例して伸びる**。路面の縁（6 m）でさえ自機が画面の外へ流れており、
路外へ 15 m 出ると 6.8 m も遅れて完全に見えなくなっていた。

`followLateral()` が遅れを上限で切る。どれだけ外へ出ても自機はカメラの正面から
1.2 m 以内に留まり、画面の横 31 % の位置で止まる。上限に当たり始めるのは
|lateral| > 2.7 m からで、走行ラインの振れ幅の中ではコーナーの内側へ膨らむ
見え方がそのまま残る。`camera.spec.ts` が**実際にカメラ行列で投影して**固定する。

- FOV（60°→72°）は据え置く。近づけたうえに広げると樽型に見える
- フォグ密度・遠景の帯・セクターのカリング半径は変えない。第4世代の水平線の行はカメラのピッチから毎フレーム求めているので自動で追従する（§3.4）
- 近づけると路面の起伏でカメラが潜りやすくなる。`HEIGHT` は路面高（`track.toWorld` の y）からの相対のまま扱う（現状の実装がそうなっている）

**検証**: `Docs/screenshots/` の前後比較。第4世代で映り込みが車の向きに応じて流れることが**静止画 2 枚で読み取れる**ことを合格条件にする。あわせて `camera.spec.ts` が、路面の外 15 m まで自機が画面の内側（NDC 0.6 以内）に留まることを 3D の 2 世代で固定する（`gen{3,4}-offtrack.png`）。

---

#### 8-5 視点切り替えを追加（第3・第4世代）

**決定**: `view/shared/camera.ts` に視点の表を置く。

```ts
CAMERA_VIEWS: GenerationVariant<readonly CameraViewId[]>
  FC / SFC : ['chase']                              // 擬似3D の投影は追走視点前提
  PS1      : ['chase', 'windshield']
  PS2      : ['chase', 'windshield', 'cockpit']
```

- **`windshield`（第3・第4世代）** — 目線は自機の `s + 0.6 m`・路面から 1.05 m、注視点は 30 m 前方。**自機のメッシュを積まない**（`hidePlayerCar`）。第4世代では自機ぶんの影専用メッシュも積まない。ミニマップとの対応が切れないよう、HUD・ミニマップ・タコメーターの位置はどの視点でも同じにする
- **`cockpit`（第4世代のみ）** — 目線は `windshield` と同じで、内装を**スクリーン空間スプライト 1 枚**で被せる（`tools/build-cockpit.mjs` → `assets/gen4/hud/cockpit.png`）。ダッシュボード・A ピラー・ステアリングを焼き、窓は `alphaCutoff` で抜く。ステアリングは `SpriteCommand.rotation` で舵角ぶん回す。**第4世代だけ**なのは、640×448・linear フィルタ・GS alpha が揃って初めて内装が絵として成立するため（320×240 では帯にしか見えない）— これ自体が世代差の表現になる
- 入力は §5.1 に `viewCycle: 'button'` を足す。キーは `KeyC`、ゲームパッドは 3。**未使用のまま残っている `glance`（後方確認・ArrowUp）はこれに置き換える** — 実装しない機能の枠を残さない
- 視点は「見た目のためだけの状態」（§2.1）。`module.ts` が持ち、シムへは一切渡さない。世代を切り替えたとき、その世代に無い視点なら `chase` へ落とす。切替演出中に 2 世代を積むフレームでも、各ビューは自分の世代の視点リストだけを見る
- 第1・第2世代でキーを押しても何も起きない（視点が 1 つしかない）。押した感触が無いのが気になる場合でも、擬似3D の投影を車内視点へ組み替えることはしない — `RoadView` は追走カメラの幾何そのものだから（§3.1）

**検証**: `camera.spec.ts`（新規）— 各世代の視点リストが定義どおり・`windshield` / `cockpit` で自機のメッシュとその影が 1 つも積まれない・目線が常に路面より上にある。`generation-invariance.spec.ts` に「視点を切り替えても状態ハッシュが変わらない」を足す。

---

#### 8-6 背景オブジェクトを全世代へ追加

**配置は 1 つの表から出す。** `view/shared/scenery.ts` に `sceneryObjects(track)` を置き、コース中心線から決定論的に生成する（コーナー入口に看板、高曲率区間の外側にタイヤフェンス、それ以外の外側に木を等間隔）。乱数は使わず `s` と `curvature` だけから決めるので、生成ツールと実行時で必ず一致する。**4 世代が同じ表を読む** — ミニマップと同じ主張（1 つの世界を 4 通りに描く）の背景版になる。

| 世代 | 出す物 | 表現手法 |
| --- | --- | --- |
| 第1世代 | 看板 | スプライト |
| 第2世代 | 看板・木・タイヤフェンス | スプライト |
| 第3世代 | コースの壁・木々 | 壁はメッシュ（コースへ焼き込み）／木はビルボード |
| 第4世代 | コースの壁・フェンス・タイヤフェンス・木々 | 壁とフェンスとタイヤフェンスはメッシュ／木はビルボード |

**第1・第2世代**（`view/shared/scenery-sprite.ts`）:

- `projection.ts` の `RoadView` で置く — **車とまったく同じ 1 本の式**を通す。接地線・`tileSnap` の丸め・大きさの決め方は `car-sprite.ts` の作法をそのまま使う
- スプライト面へ積む順（＝走査線制限の優先度）は **自機 → ミニマップのマーカー → ライバル車 → 背景オブジェクト**。§3.2 の順序に 1 段足す形で、**混雑時に最初に消えるのが背景**になる。FC は 8 スプライト/走査線なので看板 1 種に絞る（ユーザー指定どおり）
- アトラスは `tools/build-scenery-sprites.mjs` が焼く（`assets/gen1/sprites/scenery.png` / `gen2/sprites/scenery.png`。セルは車と同じ 128²・接地線を揃える・上下反転して焼く）。FC 版は 54 色マスターパレットの値だけを置き、同時 25 色の枠内に収める。半透明は一切付けない
- 第2世代は 32 スプライト/走査線なので木とタイヤフェンスまで置ける。落ち影は付けない（color math の帯が増えるだけで、遠方はフォグで見えない）

**第3・第4世代**:

- **壁はコースメッシュへ焼き込む**（`tools/build-track-mesh.mjs` を拡張）。路面の外側（`roadHalfWidth + runoff`）に高さ 1.0 m の帯を立て、同じセクター GLB へ入れる。`TransformCommand` に X/Z 回転が無い以上、バンクのついた路面に沿う壁は別メッシュでは置けない（§1.3）。壁面は路面アトラスの別の u 帯へ写す（既存の作法と同じ）。三角形は 1 セクターあたり第3世代 +388 tri・第4世代 +248 tri で、どちらも予算の内側
- 第4世代のフェンス（金網）は壁の上端に載せる半透明の帯（`gen4-gs` の source-over ＋ `alphaCutoff`）、タイヤフェンスは高曲率区間だけに置く小さなメッシュ（`tools/build-scenery-mesh.mjs` → `assets/gen4/models/tyre-wall.glb`）。第3世代には置かない — ユーザー指定どおりであり、ordering table のスロットとドローコールを増やさない狙いにも合う
- 木々は**ワールド空間スプライトのビルボード**（`billboard: 'cylindrical'`）。実測: `writeSpriteModelMatrix` は `screenSpace` でないスプライトへ既定で cylindrical を適用する
  - 第3世代は深度バッファが無いので、**木と車を同じスロット `orderTableIndex: 9` へ距離順（遠い順）にまとめて積む**。スロット内の登録順は安定して保たれる（§1.3）ので、これで木と車の前後が破綻しない
  - 第4世代は深度バッファに任せる。不透明扱い（`depthWrite: true` ＋ `alphaCutoff`）で積み、順序の指定は 1 つも書かない（§3.4 の「指定が要らないこと自体が世代差」）
  - 描画距離は第3世代 100 m・第4世代 280 m（それぞれフォグが閉じる範囲・`CAR_DRAW_DISTANCE` と同じ）

**検証**: `scenery.spec.ts`（新規）— 4 世代が同じ `sceneryObjects()` を読み、看板の `s` 座標が世代間で完全一致する。FC は 8px 丸め済み・`hardwareBlend` 0 件・走査線制限を掛けた後も自機とライバルが残る（背景から先に落ちる）。§6.1 の世代横断基準に「8. 背景オブジェクトが 4 世代とも同じ場所に立っている」を足す。

---

#### 8-7 1・2・3・4 キーで世代を直接選ぶ

**決定**:

- §5.1 のアクション表に `genSelect1`〜`genSelect4`（button）を足し、`Digit1`〜`Digit4` と `Numpad1`〜`Numpad4` に割り当てる。ゲームパッドには割り当てない（4 ボタンを世代へ潰すと運転の操作が足りなくなる）
- `module.ts` は押下で `context.generation.request(id)` を呼ぶ。すでに表示中の世代を要求しても `request()` が偽を返すだけで演出は起きない（`controller.d.ts` の戻り値）
- **Q / E の `cycle` は残す。** 順送りと直接指定は用途が違う（アトラクトデモを眺めるのと、見たい世代へ跳ぶの）
- 切替演出・BGM の位相保存・2 世代合成はすべて `cycle` と同じ経路なので、追加のコストは無い。タイトル・カウントダウン・ポーズ・リザルトでも効く（§5.2「世代切替はすべての状態で有効」のまま）
- HTML 側の操作ヒントと、タイトルの操作説明（フェーズ 7 の残件で 2 行に切り詰めてある箇所）にも足す

**検証**: `flow.spec.ts` を拡張 — 4 つのキーそれぞれで対応する世代が要求され、同じ世代のキーを押しても切替が起きないこと。世代を跨いでもレース状態のハッシュが変わらないこと（`generation-invariance.spec.ts` の既存の検査で守られる）。

---

#### 8-8 世代表示を左上へ移し、チャンネル表記にする

**決定**（`view/shared/hud.ts`）:

- `GENERATION_LABELS` を **`CH 1 : 1ST GEN` / `CH 2 : 2ND GEN` / `CH 3 : 3RD GEN` / `CH 4 : 4TH GEN`** に変える。ハードウェア名（FC / SFC / PS1 / PS2）は落とす — チャンネル番号が 8-7 の 1・2・3・4 キーとそのまま対応し、**テレビのチャンネルを回すと世代が変わる**という見立てが表示と操作で揃う
- 位置は**左上の塊の 1 行目**へ移す。`standing` の塊が 3 行になる:

```
CH 1 : 1ST GEN          TIME  0'42"31
POS 3/8                 BEST  0'41"08
LAP 2/3

［タコメーター］ 180 KM/H              ［ミニマップ］
```

- 左下の `speed` の塊は 1 行（速度）へ減り、その左にタコメーター（8-3・第3/第4世代のみ）が入る。第1・第2世代の左下は速度 1 行だけになる
- 字数は 14 文字。FC は字送りが 8 px なので 112 px で、安全領域（230 px）の内側に収まる。SFC 以降は 6 px 送りなのでさらに余る
- 塊はこれまでどおり全て左揃えで、左端をタイル境界へ丸める（§3.5 の根拠は変わらない）
- 切替演出中は 2 世代ぶんの HUD が重なり、**チャンネル番号が 2 つ同時に見える**。これは §3.5 が意図している見え方のままで、「チャンネルを回している最中」として読める

**検証**: `hud.spec.ts` / `screen-layout.spec.ts` の期待値を更新する。検査項目そのものは変えない — 4 世代で同じ数字が出る・全ての塊が安全領域の内側で互いに重ならない・ミニマップの矩形と重ならない・FC は `hardwareBlend` 0 件でタイル境界に載る。

---

#### 8-9 トンネル区間

**区間は 1 つの表から出す。** `view/shared/tunnel.ts` の `TUNNEL` に弧長の範囲と断面の寸法だけを書き、生成ツール（`tools/build-tunnel-mesh.mjs`）と 4 つのビューが同じ定数を読む。8-6 の背景オブジェクトと同じ構造で、乱数も状態も持たないので生成側と実行時が必ず一致する。

**置き場所**: `s = 2440–2660`（220 m）。戻りのストレートの中で、コース中**最も直線に近く**（半径 548 m）・バンク 0°・標高差 0.4 m の区間である。コーナーやバンク区間に置くと、焼いた断面が路面から離れたり食い込んだりするのが目に見えて分かる。

**断面**: 内空は「路面半幅 ＋ 3.2 m」×高さ 6.4 m の半楕円ヴォールト。側壁が 4 m まで立ち上がり、そこから天井の頂点まで 8 面のアーチで繋ぐ。足元に歩廊（幅 0.8 m・高さ 0.3 m）。外側には殻を張る — **丘が無いので、坑口だけでは宙に浮いた穴に見える**。殻と坑口のリムは内空の輪郭を 1.42 倍したもので、1 本の輪郭線から両方が出る。

| 世代 | 出し方 |
| --- | --- |
| 第1世代 | 走査線の `brightness` を 0.5 倍 ＋ 坑口を BG 相当の不透明矩形で抜く |
| 第2世代 | color math の `subtract half` 帯で路面を落とす ＋ 同じ坑口 |
| 第3世代 | 焼いたトンネルメッシュ（路面と同じ `polygonSortRange: [1,8]` へ分配）。暗さは**マテリアルの `ambient`** だけで作る |
| 第4世代 | 同じ形のメッシュ ＋ **照明そのものの入れ替え**（環境光・太陽・ナトリウム灯・映り込み・フォグ） |

- **擬似3D の 2 世代にメッシュは 1 つも無い。** 坑口は「穴の開いた壁」を不透明の矩形 3 枚で作る。外から見た入口の妻壁と、中から見た出口手前の内壁は**同じ 1 本の式**で出る — 違うのは壁までの距離（外なら入口・中なら出口）と色だけ。くぐった瞬間に前者から後者へ入れ替わり、出口の穴が遠くに小さく開く
- 壁の外周は**外に居るときだけ坑口の躯体の大きさ**にする（3D 世代の外殻と同じ 1.42 倍）。画面の端まで伸ばすと「世界を横切る壁」になり、40 m 手前でも空が 1 画素も見えない
- **メッシュを別 GLB にするのはマテリアルを分けるため**である。壁（8-6）はセクター GLB へ焼き込んだが、トンネルは「路面より暗い躯体」と「環境光が落ちても明るい灯具」の 2 つが要る。メッシュ 1 つにマテリアルは 1 つしか指定できない
- 灯具は `ambient` を 1 より大きく採る。シェーダは `uAmbient = material.ambient × 環境光` を 1 で頭打ちにするので、環境光が落ちるトンネルの中でも灯具だけ白く残る
- 第4世代の点光源は**影を落とす光源でもある**（§3.4）。中では高さ 40 m の白色灯から 6 m のナトリウム灯へ移すので、車の影が天井の灯具から落ちる影に変わる
- 映り込みの強さを 1/4 に落とす。**塗装が艶を失って出口でまた戻る**のは、環境マップを持つこの世代でしか出せない
- フォグは**色を変えず密度だけ**下げる（0.011 → 0.004）。フォグ色は空の色と 1 つの値を共有しているので、暗くすると坑口の外の空まで暗くなり出口の明かりが消える
- 背景オブジェクトは区間の中に置かない（`scenery.ts` が間引く）。擬似3D の 2 世代では、坑口の壁より遠い木も描かない — 壁は BG 相当のスプライトなので、そのまま積むと**壁の上に木が生える**。車は切らない（路面の上＝内空の中に居るので穴を通して見える）

**検証**: `tunnel.spec.ts`（新規）— 4 世代が同じ区間を見る・区間の中に背景オブジェクトが 1 つも無い・焼いたメッシュが内空の寸法どおり・第4世代だけが照明を入れ替える・FC は坑口に半透明を 1 つも使わない。

---

#### 8-10 第4世代の背景オブジェクトを高品質化

実画面（`gen4-race.png`）で見て粗かった 3 点を、**第4世代だけ**直す。他の 3 世代の生成物はバイト単位で変わらない。

1. **金網フェンス**（8-6 の表にあって見送っていた項目）。壁の上に 2.2 m の面を 1 枚ずつ足し、抜きのあるテクスチャを引く。`TrackMeshLod.fenceHeight` を持つ LOD だけが足すので、第3世代のメッシュは 1 バイトも変わらない。三角形は 1 セクター +248・同時描画で +2,728
   - **壁の帯へ押し込まず、独立した帯と面にする。** 金網は 46 texel/m 無いと網目が読めないが、壁の帯（41 texel/m を 1 m に配る）へ相乗りさせると 20 texel/m しか取れない
   - 形を読ませるのは**支柱（4 m ごと）と上下の胴縁**で、菱形の網はトーンとして乗せる。網目だけを細かく描くと、ミップマップの無い linear フィルタでは遠方が単なるちらつきになる
   - マテリアルに `alphaCutoff: 0.5` が要る。路面・縁石・草地・壁の帯は全画素不透明なので、同じマテリアルで路面を描いても 1 画素も落ちない。**深度バッファの無い第3世代で同じことをすると、抜けた画素の向こうの順序が破綻する** — 載せないこと自体が世代差になる
2. **タイヤフェンスを箱から円柱へ**。初版は 4 × 1.1 × 0.9 m の箱に壁のテクスチャを貼っただけで、実画面では**タイヤに見えず低いコンクリートの塊**だった。タイヤの見えを作るのは色ではなく丸い輪郭なので、段ごとに 10 面の円柱を通す形にした（20 → 60 tri／基）。左右対称なのでコースのどちら側でも同じ 1 つの GLB で足りる。アトラスにはタイヤの帯を足し、1 タイル 2.8 m にタイヤ 4 本・4 本に 1 本を白くする
3. **木と看板の絵**。第4世代だけ 3 × 2 の 6 セル（256²）を持ち、**木 3 種・看板 2 種**になる。並木が「同じ絵の反復」に見えていたのがいちばん目立つ粗さだった。あわせて `scenery.ts` の表に木の背丈を 4 周期で持たせ、絵 3 種と合わせて見かけの周期を 12 本ぶんに伸ばす（**背丈は 1 つの表から出る**ので、4 世代で同じ木が同じ背丈に描かれる）
   - 葉の陰は `SUN_DIRECTION` から向きを取る。**木の陰・車体の陰影・映り込みの太陽が 3 つとも同じ向き**になる
   - 看板を第4世代でも出す（`kinds: ['sign', 'tree']`）。「4 世代で同じ場所に同じ看板が立つ」という 8-6 の主張は、出していない世代があるうちは絵として確かめられない

路面アトラスの u 帯は `track-mesh.ts` の `TRACK_ATLAS` へ移し、生成ツール・背景メッシュ・テストが 1 つの定義を読むようにした（それまで `build-scenery-mesh.mjs` が「合わせる」コメント付きで値を写していた）。帯の幅は必要な密度から配り直してある（第4世代 512² での texel/m は 路面 15.8・縁石 26・草地 6.8・壁 41・金網 46・タイヤ 65）。

**検証**: `track-mesh.spec.ts` を拡張 — 金網は第4世代にだけ載る・壁の上端から `fenceHeight` だけ立ち上がる・UV が帯の内側にある・法線がコース中心を向く。`scenery.spec.ts` を拡張 — 第4世代の木のセルが 3 つあり**3 つとも上下正しく焼けている**・木の背丈が 4 種類以上ある。

---

#### 8-11 中央の破線がアフィン歪みで折れるのを直す（第3世代）

**現象**: 実画面（`gen3-race.png`）で、中央の破線が手前ほど太い楔に崩れ、輪の境目で左右に食い違う。**アフィンテクスチャそのものは第3世代の見せ場**なので消してはならないが、これは歪みではなく**線が割れている**見え方になっていた。

**原因**: 路面を `roadSpans` の等分（6 分割）で割っていたため、破線の帯（u = 0.1953〜0.2070、路面の中央）が四角形の境目 t = 0.5 に**ちょうど跨がっていた**。アフィン補間の u は三角形ごとに別々の傾きを持つので、

- 線の左半分と右半分が**別の三角形**で解かれ、境目で繋がらない
- 四角形の内側では u がスクリーン空間で線形になり、線の幅が奥行きに応じて細らない（＝手前で楔に広がる）

第3世代のカメラ諸元（320×240 / 画角 60° / 車体から 3.2 m）で計算すると、いちばん手前の輪（走査線 140〜170）で線の**正しい幅は 10.7 → 16.9 px** と変化するのに、アフィンでは 14.7 px で固定され、**縁の位置は最大 4.5 px ずれる**。線幅の 4 割にあたるずれが左右の縁で逆向きに出るので、線が折れて見える。

**決定**: **破線の帯の両縁を頂点の列にする**（`roadColumns()`）。等分の列に加えて帯の縁 2 本を挿し、帯の内側に落ちる等分点は捨てる（第3・第4世代とも 7 列 → 8 列）。

- 線の横幅が**頂点の投影そのもの**になるので、四角形の内側で u がどう歪んでも帯の内側は白・外側はアスファルトのままになる。ずれは 0
- **縦（v）方向の歪みは残す。** 破線が奥行きに応じて伸び縮みするのは第3世代の味そのもので、消す理由が無い
- 帯は `TRACK_ATLAS.centerLine` として 8-10 の帯の表へ足し、**テクスチャを塗る側とメッシュを割る側が同じ 1 つの定義**を読む。256² で 50〜53 texel・512² で 100〜106 texel と、どちらも texel の境界にちょうど乗るので nearest でも滲まない
- 第4世代はパースペクティブ補正が効くので元から折れないが、**同じ断面から焼く**以上こちらも 8 列になる。三角形は 1 セクター +124（同時描画 23,188 tri、予算 40,000 の内側）。第3世代は +194（同時描画 8,730 tri、予算 20,000 の内側）

**いちばん崩れるのは near 面を跨ぐ輪**（実測）。エンジンのアフィン UV は `vUvW = uv * clip.w` と `vW = clip.w` を varying で渡し、フラグメントで `vUvW / vW` に戻す仕掛けで（`ps1_vertex.glsl`）、`CameraCommand` に `near` の口は無く 0.1 m 固定。カメラは自機の 3.2 m 後方にあるので、**輪 1 つぶんは必ずカメラの後ろにある**（4 m 刻みなので手前の 2 頂点は w = −0.2 〜 −4）。この四角形は奥行きの幅が無限大に近く、アフィンと遠近の差が最大になる。

GPU と同じ手順（頂点量子化 → クリップ空間で 6 面クリップ → 遠近補正つき補間 → `vUvW / vW`）を再現して、near 面を跨ぐ輪で白く塗られる帯の幅を走査線ごとに measure した結果：

| 走査線 | 旧（等分 6 列） | 新（縁が列） |
| --- | --- | --- |
| 189 | 25 px | 24 px |
| 205 | 51 px | 24 px |
| 221 | 76 px | 24 px |
| 237 | **102 px** | 24 px |

旧は画面の下へ向かって **4 倍に広がる楔**になり、実画面で見えていた崩れとそのまま一致する。新は頂点の投影どおり一定幅を保つ。

**縁を列にするだけでは足りなかった**（実画面に楔が残った）。クリップで作られる頂点は `uv·w` を線形補間して得るが、`uv·w` は辺に沿って二次なので誤差 `t(1−t)·Δu·Δw / w` が乗る。**この誤差は四角形の Δu に比例する**ので、破線に隣り合う**アスファルトの四角形**（幅 0.058）が自分の u 範囲から **0.00695 ＝ 1.8 texel** はみ出し、破線の texel を引いて楔を作っていた。四角形の対角線は Δu も Δw も 0 でないため、必ずこの経路が残る。

実物の GLB とカメラで 1 フレームを焼いて出どころを数えた結果（`tools/debug-gen3-frame.mjs`）:

| | 破線の四角形（本物） | 破線の左隣の四角形 | はみ出し |
| --- | --- | --- | --- |
| 縁を列にしただけ | 2,170 px | **1,933 px** | 0.00695（1.8 texel） |
| 緩衝帯あり | 2,170 px | 391 px | 0.00131（0.34 texel） |

**対策は緩衝帯**（`CENTER_LINE_GUARD`）。帯の外側へ帯と同じ幅の列を 1 つずつ挟む。広い四角形は帯から離れるので届かなくなり、緩衝帯自身は Δu が帯と同じなので、はみ出しも帯と同じ 0.34 texel まで落ちる。走査線ごとの線幅はアフィンと遠近補正で一致するようになった（対策前 89 px 対 37 px → 対策後 37 px 対 37 px）。

三角形は 1 輪あたり四角形 3 つ（三角形 6 つ）増えて、同時描画は第3世代 9,894 tri（予算 20,000）・第4世代 25,916 tri（予算 40,000）。

**残る誤差**（消せない）: 上記の 0.34 texel。**帯の縁 1 画素がまれに 1 texel ぶんぎざつく**だけで、線が破れることはない。`CameraCommand` に `near` の口があれば減らせるが、エンジンが出していない。v（破線の位相）のずれは跨ぐ輪で 1.7 m・跨がない輪で 0.8 m と 2 倍になるが、これは**残すべきアフィン歪みそのもの**。

**検証**: `track-mesh.spec.ts` を拡張 — 破線の両縁が路面の列に乗っている・帯の内側に列が無い（幅 0 の四角形を作らない）・両側に緩衝帯の列がある・帯に隣り合う四角形が緩衝帯ぶんの幅しか持たない・帯が路面の中心に乗っている・アトラスで帯の内側だけが白く帯の外へ 1 texel も溢れていない・タイルの後半では破線が切れている。

`tools/debug-gen3-frame.mjs` は実物の GLB とカメラで 1 フレームを焼く調査用の口で、GPU と同じ手順（頂点量子化 → クリップ空間 6 面クリップ → 遠近補正つき補間 → `vUvW / vW`）を通す。アフィン版・遠近補正版・帯の当たり判定版の 3 枚を出すので、**「歪みなのか壊れているのか」をブラウザを開かずに切り分けられる**。`EXACT_CLIP=1` を付けるとクリップ頂点の `uv·w` を正しく作るので、原因が近クリップかどうかを 1 回で確定できる（この項目の切り分けはこれで付いた）。

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| ~~第1世代の描画距離が短く「奥に進む」感が出ない~~ | ~~要求未達~~ | **フェーズ 3 で発生し、対処済み。** `widthU ≤ 1` は描画距離だけでなく「路面が細くなれる限界」（`roadFraction × 画面幅`）も決めるため、`road.png` のままでは `focal` をいくら動かしても路面が画面の 45% より細くならない。`tools/build-road-texture.mjs` で `TEX_W = 84 m`・`roadFraction = 1/7` の版を生成し、最遠 37 px まで収束させた（§3.2） |
| 第2世代の per-scanline アフィンが 120 ドローコールで重い | フレーム落ち | **フェーズ 4 で 135 本になった**（予算 240 の内側）。帯粒度は定数 1 つで、切替演出中は 2 行へ落とす。GPU 側は全画面三角形 1 枚なので帯化の効果は大きい |
| ~~`circuit.png` が直線路タイルのため Mode 7 らしい「マップの回転」が出ない~~ | ~~第2世代の説得力不足~~ | **フェーズ 4 で対処済み。** `circuit.png` は使わず、路面テクスチャを `TEX_W = 96 m` で焼き直した（草地のディザが遠方でちらつくのが直接の理由）。視界の傾きは `uvStepX` の V 成分で出している。なおコースマップ全体の回転（真の Mode 7）はこの構成では出ない — 必要になればマップ参照へ切り替える（§3.3 の改善案は残す） |
| PS1 に深度バッファが無く車がコースに埋まる | 破綻 | コースをセクター分割し、`polygonSort` と `polygonSortRange` を設定。自機は `orderTableIndex: 9` の固定スロットへ置き、路面の partition 範囲より常に後で描く（0.2.0 の修正で推奨された組み合わせ） |
| `OverlayCommand` が WebGL で描かれない | HUD が出ない | フォントアトラス方式で解決済み（§3.5）。スクリーン空間スプライトは 0.2.0 で 4 世代すべてに描かれる。フェーズ 7 の前提として `build-font-atlas.mjs` を先に用意する |
| `MeshCommand.material` 欠落で実行時例外 | クラッシュ | `frame-contract.spec.ts` で全コマンドを走査して事前検出 |
| ラスタールックアップの 8bit 量子化で近距離の路面がガタつく | 品質 | 当時の性質として許容。ただし `widthU` の下限 0.05 を守るよう `camY` / `yTop` を決める |
| FC の 5 声でエンジン音が BGM を潰す | 音がスカスカ | 世代ごとにエンジン音の予約間隔と `velocity` を変える。FC は間隔を長く、`perc` を間引く編曲にする |
| `engine-testkit` が無くホストのテストが書けない | テスト不足 | 手書きの `LoopHost`（`now()` を手動で進める）と記録レンダラーを `tests/support/` に自作する |
| エンジン tarball を Git 管理下に置かない方針（決定事項 §9-5 (c)）のため、新規クローンで `npm install` が失敗する | セットアップの手間・CI が組めない | ルート `README.md` に入手手順と SHA-256 を記載（フェーズ 0）。**受け入れ済みの制約**であり回避策は取らない。CI が必要になった時点で tarball の注入方法を別途決める |
| tarball を差し替えても `package-lock.json` の見た目が変わらず、古い `node_modules` のまま動く | 原因不明の不具合 | `README.md` に記録した SHA-256 と現物を突き合わせる手順を書く。エンジン更新時は `rm -rf node_modules && npm install` を徹底。0.1.0 → 0.2.0 ではファイル名が変わるので lockfile にも差分が出た |
| `maxSimultaneousColors` / `tileSnap` などは自動強制されない能力契約 | 「らしさ」が出ない | §1.4 の表を実装規約として明文化し、`capability-contract.spec.ts` と `palette-budget.spec.ts` で継続的に検査する |
| 第1世代でミニマップのマーカーが 8 スプライト/走査線を食い、ライバル車が消えすぎる | ゲームが成立しない | マーカーは 2×2 px でミニマップ矩形（56²・約 56 走査線）内に限定されるため、影響は画面右下の帯だけに閉じる。それでも足りない場合はマーカーを縦方向に 1px ずらして走査線を分散させる |
| ミニマップの俯瞰図テクスチャとマーカー座標がずれる | 証明が成立せず、むしろ逆効果 | 生成ツールが `src/game/sim/track.ts` を直接 import し、`trackBounds` を共有する（実装を複製しない）。`minimap.spec.ts` でツール側と実行時の `trackBounds` の同値性を固定する |
| 車 GLB の前方軸 `-X` の符号を取り違える | 車が横向き | フェーズ 2 の最初に 1 回だけ実測し、`FRONT_AXIS_YAW_OFFSET` として定数化。テストで固定 |
| 環境マップの `flipY` を取り違えると**空が地面として映り込む** | 第4世代の署名的表現が壊れるのに例外が出ない | フェーズ 5 で発生条件を実測。`environmentTexture` は `flipY: false`・遠景の層は既定（反転済み前提）と用途で逆になるので、**同じ 1 枚を共用せず**帯を焼き分ける。`frame-contract.spec.ts` と `gen4-environment.spec.ts` が規約を検査する |
| 落ち影の形が `transform.scale` に縛られ、車に付けると 2 m 角になる | 第4世代基準 3 が「四角い黒い板」になる | **フェーズ 5 で発生し、対処済み。** 影を落とすためだけの、全画素を捨てるメッシュを 1 台につき 1 つ積み、1.0 m 角に収めた（§3.4） |
| 第4世代の三角形数が予算（20,000 tri）を大きく超える | フレーム落ち | フェーズ 5 で実測（車 8 台で 108,944 tri）。予算値は第3世代の CPU 側ソート性能に由来し、深度バッファのある第4世代には掛からない。フェーズ 8 で実フレーム時間を測り、必要なら遠方の車を第3世代のモデルへ落とす |
| 世代切替が 2 世代分のコマンド生成を要求しフレーム負荷が倍 | 切替中のみフレーム落ち | 切替は 350–600 ms。`generation.renderGenerations()` が 2 を返すときだけ両方積む。第2世代が絡む切替は帯粒度を一時的に粗くする |

---

## 9. 決定事項

計画時点で確認した項目の回答。すべて本文へ反映済み。

| # | 項目 | 決定 | 反映先 |
| --- | --- | --- | --- |
| 1 | アセットの追加生成 | **可**。生成物はリポジトリにコミットする | §2.6 生成アセット表、`tools/` 一式 |
| 2 | 周回数と出走台数 | **3 周 / 8 台**（初期案どおり確定） | §2.3 |
| 3 | 車モデルの再変換 | **可**。`tools/prepare-cars.mjs` と `npm run prepare:cars` を実装する | §2.6、フェーズ 2 |
| 4 | タイトル画面 | **追加する**。世代切替を含むアトラクトデモ付き | §3.7、§5.2、フェーズ 7 |
| 5 | エンジン tarball の扱い | **(c) 現状維持**。`.gitignore` の `reference/` はそのままにし、入手手順をルート `README.md` に記載する | §2.5、フェーズ 0、§8 リスク表 |
| 6 | ミニマップ | **全世代必須**。コース輪郭＋8 台の位置。プレイヤーへの情報提供に加え、**1 つのシステムで動いている証明**として扱う | §2.2、§3.6、§6.1 世代横断 6–7、フェーズ 1–5 |

決定 5 の帰結として、**このリポジトリはクローンしただけでは `npm install` が通らない**。これは受け入れ済みの制約であり、ルート `README.md` に tarball の入手先・配置場所・SHA-256 を記載して運用でカバーする。CI を組む段階で改めて注入方法を決める。

**前版からの解決済み事項**

- ~~リポジトリ構成~~ → `car-conversion.json` のパス修正により、**リポジトリルート＝アプリルート**で確定。`data/README.md` の記述更新のみフェーズ 0 の作業として残る。
- ~~エンジン導入~~ → 導入済み。`dist/` は tarball とバイト一致で、更新は README のみ。

---

## 付録 A — エンジン API 対応表

| やりたいこと | 使う API |
| --- | --- |
| 起動 | `createGameHost` / `createBrowserLoopHost` / `observeCanvasResize` |
| 描画 | `createGenerationWebGlRenderer(canvas, { assets, manifest, quality, glitchAmount, motionAmount, crtOverride, transitionColors })` |
| フレーム組み立て | `RenderFrame`（`meshes` / `sprites` / `backgrounds` / `materials` / `lights` / `rasterSurfaces` / `affineSurfaces`） |
| 世代切替 | `context.generation`（`cycle` / `request` / `transition` / `renderGenerations`） |
| 世代ごとの値 | `defineGenerationVariant` / `generationValue` / `HARDWARE_GENERATION_PROFILES` |
| 入力 | `createKeyboardGamepadSource` / `defineActions` / `createActionMap` |
| 決定論乱数 | `context.rng` / `createRng` / `hash32` |
| アセット | `context.assets`（`loadImage` / `loadGltf` / `loadJson`） |
| 音声 | `createGenerationAudioService` / `playScore` / `useScore` / `playOneShot` / `installAudioUnlock` |
| FC のちらつき | `applyScanlineLimit` / `createFlickerState` |
| サーフェス検証 | `validateRasterSurface` / `validateAffineSurface` / `affineUvAt` |
| 当たり判定補助 | `overlaps` / `sweepAabb` / `nearestPointOnSegment` |
| CRT 調整 | `presetFor` / `SIGNAL_PRESETS` / `QUALITY_VARIANTS` / `SCREEN_SAFE_AREA` |

## 付録 B — RenderAssetManifest 初期案

```ts
export const MANIFEST: RenderAssetManifest = {
  textures: [
    { url: 'assets/common/fallback.png',              wrap: 'clamp' },
    { url: 'assets/gen1/road/road.png',               wrap: 'clamp' },   // V は CPU 側で fract 済み
    { url: 'assets/gen1/backgrounds/coast.png',       wrap: 'repeat' },
    { url: 'assets/gen2/tiles/circuit.png',           wrap: 'clamp' },
    { url: 'assets/gen2/backgrounds/coast.png',       wrap: 'repeat' },
    { url: 'assets/gen3/textures/car_base_color.png', wrap: 'clamp' },
    { url: 'assets/gen4/textures/car_base_color.png', wrap: 'clamp' },
    // 映り込みは v = 0 を真上とみなす。既定（flipY: true）だと空が地面として映り込む
    { url: 'assets/gen4/environment/circuit.png',     wrap: 'repeat', flipY: false },
    // 遠景の層は逆に「絵は反転済み」を前提にしているので既定のまま（§3.4）
    { url: 'assets/gen4/backgrounds/skyline.png',     wrap: 'repeat' },
    // フェーズ2/5で生成するコースのテクスチャ
  ],
  atlases: [
    { url: 'assets/gen1/sprites/cars.png', columns: 3, rows: 2 },
    { url: 'assets/gen2/sprites/cars.png', columns: 3, rows: 2 },
    { url: 'assets/common/font.png',       columns: 16, rows: 6 },
    { url: 'assets/common/logo.png',       columns: 1,  rows: 1 },  // スプライトはアトラス経由でしか描けない
    { url: 'assets/common/markers.png',    columns: 2,  rows: 1 },  // 丸 / 四角。色は SpriteCommand.color で付ける
    { url: 'assets/gen1/hud/minimap.png',  columns: 1,  rows: 1 },  // ミニマップ枠もスプライトなのでアトラス登録が要る
    { url: 'assets/gen2/hud/minimap.png',  columns: 1,  rows: 1 },
    { url: 'assets/gen3/hud/minimap.png',  columns: 1,  rows: 1 },
    { url: 'assets/gen4/hud/minimap.png',  columns: 1,  rows: 1 },
  ],
  models: [
    { url: 'assets/gen3/models/car.glb',   polygonSort: true },
    { url: 'assets/gen4/models/car.glb' },
    // 生成物。実際にはセクターごとに 1 ファイル（第3世代 8 個・第4世代 50 個）を
    // LOD テーブルから導く。polygonSort も profile.video.depthBuffer から決める
    { url: 'assets/gen3/models/track-00.glb', polygonSort: true },
    { url: 'assets/gen4/models/track-00.glb' },
  ],
  geometries: [
    { kind: 'quad', halfSize: [1, 1] },
    { kind: 'polyline', points: [], width: 1 },   // デバッグ表示用
  ],
  fallbackTextures: {
    FC:  'assets/common/fallback.png',
    SFC: 'assets/common/fallback.png',
    PS1: 'assets/common/fallback.png',
    PS2: 'assets/common/fallback.png',
  },
};
```

> **スプライトとして描くものは `atlases` にだけ登録する。** レンダラーは `atlases` の URL も画像として読み込み、`flipY: false` / `wrap: 'clamp'` を強制するので、`textures` への二重登録は不要（`textures` 側の指定は無視される）。`textures` に載せるのは背景・マテリアル・サーフェスが参照するものだけ。
>
> `font.png` / `logo.png` / `markers.png` / `minimap.png` / `track-NN.glb` / `track_*.png` / `skyline.png` は生成物のため、フェーズ 0 の manifest には含めず、生成したフェーズで追加する（`manifest.spec.ts` が実在チェックを行うため）。
