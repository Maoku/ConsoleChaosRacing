# ConsoleChaosRacing 実装計画書

`Docs/PLAN.md`（要求仕様）に対する実装計画。同梱エンジン `reference/console-chaos-engine-0.2.0.tgz`（`@console-chaos/engine@0.2.0`）と `public/assets/` の既存アセットを実測したうえで作成している。

- 対象: 1 アプリで FC / SFC / PS1 / PS2 の 4 世代表現を切り替えられるサーキットレース
- 不変条件: **シミュレーションは 1 つ。世代は表示と入出力の作法だけを変える**
- 作成日: 2026-08-12
- 更新: 2026-08-12（エンジン導入完了・更新版 README を反映・`car-conversion.json` のパス修正を反映・§9 の決定事項 6 項目を反映）
- 更新: 2026-08-12（フェーズ 0・1 の実装完了を反映。**エンジン 0.2.0 への更新を反映** — スプライトのシーン統合・`HardwareBlendCommand`・第3世代の 12 スロット ordering table）
- 更新: 2026-08-12（フェーズ 3 の実装完了を反映 — 走査線 `width ≤ 1` が「路面が細くなれる限界」も決めること・`BackgroundCommand.parallax` が読まれないこと・生成アセットの色はマスターパレットに載せること）
- 更新: 2026-08-13（フェーズ 4 の実装完了を反映 — 第2世代の**半透明スプライトだけがシーンへ直接合成される**こと・`AffineSurfaceCommand` に明るさの項が無いこと・アフィン面の `wrap` と V の扱い）

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
| 音声は `createGenerationAudioService` が `profile.audio.synth` ごとに音源を登録し、`GameHost` が世代切替時に自動で差し替える。`MusicClock` により**位相は保たれる** | 曲データは 1 つ。編曲だけ `useScore` で差し替える |
| 継続音の API は無い。`playOneShot` の連続予約のみ | エンジン音は短い one-shot の連続再生で作る（実機の作り方と同じ）。§4.3 |
| `@console-chaos/engine-testkit` は同梱されていない（0.2.0 でも tarball には含まれない） | テストは自前の手動ループホストか、純ロジックのみを対象にする |

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
        hud.ts            フォントアトラスによる HUD
        minimap.ts        ミニマップ（全世代共通。世代差は variant テーブルのみ）
        camera.ts         3D 追従カメラ（Gen3/Gen4 共用）
      gen1-fc.ts
      gen2-sfc.ts
      gen3-ps1.ts
      gen4-ps2.ts
      title.ts            タイトル画面（4世代共通の組み立て・世代差は variant テーブル）
      index.ts            GenerationId → ビューの割り当て
    flow/
      screens.ts          title / countdown / racing / result の状態機械
    audio/
      score.ts            共通 Score と 4 種の編曲
      engine-sound.ts     エンジン音スケジューラ
      sfx.ts              ブレーキ・縁石・接触
    input/bindings.ts     ActionMap 定義
tools/
  build-track-mesh.mjs    コース中心線 → GLB（Gen3/Gen4 用、LOD 2 段）
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
| `build:font` | HUD フォントアトラス | 7 |
| `build:logo` | タイトルロゴ | 7 |
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
| `public/assets/gen3/models/track.glb` | `build-track-mesh.mjs` | 第3世代コース（4 m 刻み） | 2 |
| `public/assets/gen4/models/track.glb` | `build-track-mesh.mjs` | 第4世代コース（1 m 刻み） | 5 |
| `public/assets/gen{3,4}/textures/track_surface.png` | 同上 | 路面・縁石・草地を 1 枚に収めたアトラス | 2 / 5 |
| `public/assets/gen{3,4}/textures/car_paint.png` | `build-car-paint.mjs` | 無彩色の塗装テクスチャ（256² / 512²）。車体色は実行時の乗算で決まる | 2 |
| `public/assets/gen1/road/road_wide.png` | `build-road-texture.mjs` | 第1世代のラスター路面（1024×256 / 横 84 m・縦 96 m）。同梱の `road.png` では描画距離が伸びない（§3.2） | 3 |
| `public/assets/gen2/road/road_affine.png` | 同上 | 第2世代のアフィン路面（1024×512 / 横 96 m・縦 96 m）。同梱の `circuit.png` は草地のディザが遠方でちらつく（§3.3） | 4 |
| `public/assets/gen{1,2}/sprites/car_frames.png` | `build-car-sprites.mjs` | 車スプライトの整形（384×256 / 3×2）。同梱の `cars.png` は絵がセル境界をはみ出している（§3.2） | 3 |
| `public/assets/common/font.png` | `build-font-atlas.mjs` | HUD（8×8 / 16×6） | 7 |
| `public/assets/common/logo.png` | `build-title-logo.mjs` | タイトルロゴ | 7 |
| `public/assets/gen2/tiles/circuit_map.png` | `build-track-map.mjs` | 第2世代の改善案（§3.3）。必要になった場合のみ | 8 |

生成ツールは**決定論的**であること（二度実行してバイト一致）を要件とし、`build:assets` の連続 2 回実行で差分が出ないことをフェーズ 7 で確認する。

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
  - 分割: PS1 は 4 m 刻み、PS2 は 1 m 刻み。**PS1 側をあえて粗くするのではなく、細かくしすぎない**ことでアフィンテクスチャの歪みと頂点量子化の揺れが画面に出る（エンジンの `geometry.ts` が明記している性質）。あわせて路面を横方向にも分割する（PS1 は 6 分割 ＝ 1 マス 2 m）。粗すぎると揺れが「面の波打ち」ではなく「物体全体の平行移動」に見えてしまう（§6.1 第3世代基準 2）
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
- 影は `castShadow: true` + `groundY` を路面高に設定（エンジンが点光源から落ち影を落とす）。**第3世代は `dynamicLight: false` なので点光源が無く、影は落ちない**。指定は残しておき、実際に効くのは第4世代から。

**第3世代（PS1）固有**:

- `depthBuffer: false` ⇒ メッシュは 12 スロットの ordering table を 0→11 の順に走査して描かれる（既定: opaque world 1..8 / 半透明 9 / スクリーン空間スプライト 10 / debug 11）。**車とコースの前後関係はセクター分割ではなくスロットで決める** — 路面に `polygonSortRange: [1, 8]` を与えて三角形単位に分配し、車は `orderTableIndex: 9` の固定スロットへ置く。こうすれば車が路面へ埋まることが構造的に起こらない。
- `MaterialCommand.polygonSort: true`（および `RenderModelAsset.polygonSort`）を車とコースに設定し、ポリゴン単位ソートを有効化。さらに **路面には `polygonSortRange` を与え、自機は `orderTableIndex: 9` の固定スロットへ置く**（0.2.0 のリリースノートが「プレイヤーが床より奥へ描画される」問題の対処としてこの組み合わせを挙げている）。
- 半透明を使う箇所は `{ family: 'gen3-semitransparency', mode: … }` の 4 固定モードから選ぶ。任意の不透明度は出せない。
- `vertexQuantize: 2` と `affineTexture: true` はエンジンが自動適用。**頂点の揺れとテクスチャの歪みを消そうとしない**。
- `dynamicLight: false` ⇒ ライティングは `LightCommand` の ambient / directional のフォールバックのみ。`MaterialCommand.ambient` / `diffuse` を明るめに調整して焼き込み風にする。
- `BackgroundCommand.fogDensity` で遠景を切る（当時の描画距離の短さ）。遠景は `coast.png` 相当ではなく単色＋フォグ。
- 30Hz 量子化: `view/shared/display-state.ts` のラッチが、シムのティックから整数演算で表示フレーム番号を求め、その境目でだけ車の値を写し取る。ビューは `RaceState.cars` を直接読まない。

**第4世代（PS2）固有**:

- `depthBuffer: true` ⇒ 前後関係は正しい。コースは 1 メッシュでよい。
- `environmentMap: true` ⇒ 車のマテリアルに `environmentTexture: 'assets/gen4/environment/circuit.png'`、`environmentStrength: 0.35`。エンジンの正距円筒マッピング（`equirectangularUv`）で車体に景色が映り込む。**これが第4世代の署名的表現**。
- 同じ環境マップを `BackgroundCommand.texture` にも使い、空と遠景を一致させる。
- `dynamicLight: true` ⇒ `LightCommand` を積む: 太陽（directional、環境マップの太陽位置と一致させる）、ambient、自機周辺の点光源 1 つ（落ち影の生成にも使われる）。
- `textureFilter: 'linear'` と 640×448 により、同じ車モデルでも第3世代と明確に差が出る。
- `MaterialCommand.uvScrollY` を路面の陽炎表現などに使う余地を残す。
- ワールド空間スプライトが `billboard: 'cylindrical' | 'spherical'` と `depthWrite` を選べる（0.2.0）。砂埃・ブレーキ光・観客といったビルボード表現をここで足せる。半透明は `{ family: 'gen4-gs', preset: … }` で任意の不透明度を出せる — **4 世代でこの世代だけ**。

### 3.5 HUD（全世代共通の仕組み）

`OverlayCommand` は WebGL レンダラーで描画されないため、**自前のビットマップフォントで描く**。
スクリーン空間スプライトは 0.2.0 で 4 世代すべてに描かれるので、HUD は 1 つの経路で組める
（PS1 では ordering table の固定スロット 10、PS2 ではシーン末尾へ合成される）。

- `tools/build-font-atlas.mjs` が 8×8 のフォントアトラス `public/assets/common/font.png`（16 列 × 6 行 = 96 文字、ASCII 0x20–0x7F）を生成する。純粋な生成スクリプトなのでリポジトリ内で完結する。
- `manifest.atlases` に `{ url, columns: 16, rows: 6 }` で登録。
- `src/game/view/shared/hud.ts` が文字列 → `SpriteCommand[]`（`screenSpace: true`）に変換する。
- 表示: 順位 / 周回 / ラップタイム / ベストラップ / 速度 / 現在世代。
- 世代差は色数と配置で出す。FC は単色 2 段、SFC は影付き 2 色、PS1/PS2 は半透明パネル。半透明は `translucency` を持つ世代でのみ `hardwareBlend` を付ける。
- 配置は `SCREEN_SAFE_AREA`（4:3・オーバースキャン 4%）の内側に収める。

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

- **構成**: 背景（各世代の `coast.png` / 第3・第4世代は 3D のコース俯瞰）＋ ロゴ ＋ 点滅する PRESS START ＋ 世代インジケータ ＋ 操作説明。
- **ロゴ**: `tools/build-title-logo.mjs` が `public/assets/common/logo.png`（256×64、アトラスとして 1 セル）を生成する。**1 枚で 4 世代分を賄う** — FC では 54 色パレットへ、SFC では RGB555 へエンジンが自動で量子化するため、世代ごとにロゴを作り分ける必要はない。配置とスケールだけ `defineGenerationVariant` で変える。
- **デモ走行（アトラクト）**: タイトル表示中も `RaceSim` を AI 8 台で回し、その様子を背景として描く。実装コストはほぼゼロ（ビューをそのまま使う）で、世代の違いが動いている画で伝わる。プレイヤーは自機を操作せず、AI が代走する。
- **世代ごとの見せ方**:
  - FC: ロゴを 8px グリッドに載せ、PRESS START は 6Hz で明滅。半透明なし。
  - SFC: ロゴに落ち影、背景を 12Hz でスクロール。
  - PS1: 3D のコースをゆっくり周回するカメラ、フォグ、ロゴはスクリーン空間スプライト。
  - PS2: 同じカメラワークで環境マップ入りの車をアップに、鮮明なロゴ。
- **入力**: 決定でカウントダウンへ。世代切替（Q/E）はタイトル画面でも常時有効。

### 3.8 世代切替の演出

- エンジンの `GenerationController` が `transition.blend` を持ち、`createGenerationWebGlRenderer` が 2 世代を合成して切り替えを描く。ゲーム側は**両方の世代のコマンドを毎フレーム積む**必要がある。
  - `frame.meshes` などの `generations` フィールドで「この世代でだけ描く」を指定できる。`generation.renderGenerations()` が返す世代分のビューを回して積む実装にする。
- 切替中もシムは動き続ける（レースは止まらない）。タイトル画面・リザルト画面でも同様に切り替えられる。

---

## 4. サウンド設計

**要求**: 「1つの曲をそれぞれのコンソール世代のサウンドスペックで鳴らす」「速度に応じたエンジン音」「ブレーキ音」

### 4.1 楽曲

- `src/game/audio/score.ts` に **1 つの `Score`** を定義する。テンポ 152 BPM、4/4、`ticksPerBeat: 24`、32 小節ループ。
- トラックは役割（`lead` / `bass` / `perc` / `pad` / `fx`）で持つ。楽器名は持たない。
- 世代ごとの**編曲**を 4 つ用意する。`bpm` / `beatsPerBar` / 曲長は**必ず同一**に保つ（位相保存の条件）。
  - FC: lead + bass + perc の 3 パート（5 声のうち 2 声を効果音に空ける）
  - SFC: + pad、ハモリ、リバーブ前提の減衰
  - PS1: + 対旋律、fx トラック
  - PS2: 全パート + ストリング系の重ね
- 世代切替時に `audio.useScore(arrangementFor(generation))` を呼ぶ。音源の差し替えは `GameHost` が自動で行い、`MusicClock` が位相を保つ。**曲は途切れず、音色と編成だけが変わる**。

### 4.2 起動と解錠

`AudioContext` はユーザー操作後にしか動かないため、`installAudioUnlock(document, () => audio.unlock())` を使う。解錠前は `createNullAudioService()` ではなく、解錠後に `createGenerationAudioService` を差し替える方式ではなく、**最初から生成しておき `unlock()` で `resume()` する**（エンジンの実装がこの形）。

### 4.3 エンジン音

継続音の API が無いため、**短い one-shot を先読みで連続予約する**（実機と同じ作り方）。

- `src/game/audio/engine-sound.ts` に `EngineVoiceScheduler` を置く。
- 毎 `fixedUpdate` で `audio.currentTime + LOOKAHEAD` までを埋めるように、間隔 `interval`（60–110 ms、回転数が高いほど短い）で `playOneShot({ role: 'fx', frequency, durationSeconds: interval * 1.6, velocity, pan })` を予約する。
- `frequency = baseHz * (0.6 + rpmNorm * 2.4)`、`rpmNorm` は速度とギア（4 段の擬似ギア）から算出。ギアチェンジで周波数が落ちる。
- `velocity` はスロットル量に連動。
- `pan` は第3・第4世代（`positional: true`）でのみ効く。
- **声の奪い合いはそのまま活かす**: FC は 5 声しか無いため、エンジン音が鳴ると BGM のパートが一時的に消える。これは仕様であり、修正しない。ただしエンジン音の予約間隔を FC だけ長めにして BGM が壊滅しないよう調整する。

### 4.4 効果音

| 音 | 実装 |
| --- | --- |
| ブレーキ | ブレーキ入力の立ち上がりで高音の減衰 one-shot、保持中は 120 ms 間隔で短い擦過音を予約 |
| 縁石 / 路外 | `lateral` が路面幅を超えたとき、速度連動の低音ノイズを一定間隔で |
| 接触 | 相対速度に応じた 1 発 |
| 周回通過 / スタートシグナル | `lead` ロールの単音 |

すべて `playOneShot` 経由なので、世代が変われば音色も自動的に変わる。

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
});
```

- キーボード: ←→ / Z（アクセル） / X（ブレーキ） / Q・E（世代切替） / Esc
- ゲームパッド: 左スティック X / A / B / LB・RB
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
- `countdown` は 3・2・1・GO の 4 秒。この間シムは走行入力を受け付けないが、ティックは進む（フライング判定は行わない）。
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
5. スプライトのステアフレームと車体の見た目が 6Hz でしか更新されない
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

### 6.2 自動テスト

| テスト | 内容 |
| --- | --- |
| `track.spec.ts` | 中心線の閉ループ性、弧長の単調性、`toWorld ∘ toTrack` の往復誤差 < 1 mm |
| `sim-determinism.spec.ts` | 同一シード・同一入力列で 10,000 ティック回し、状態ハッシュが一致する |
| `generation-invariance.spec.ts` | 500 ティック目に世代を FC→PS2→SFC→PS1 と切り替え、切り替えない実行と**状態ハッシュが完全一致**する |
| `raster-scanline.spec.ts` | 全行の `width ∈ (0,1]`、`brightness ∈ [0,1]`、`scanlines.length === height*4` を満たす（`validateRasterSurface` は例外を投げるため、投げないことを確認） |
| `affine-surface.spec.ts` | `validateAffineSurface` が全行で通る。`affineUvAt` の CPU 参照と自前の逆算が一致 |
| `frame-contract.spec.ts` | 各ビューが積んだ全 `MeshCommand.material` に対応する `MaterialCommand` が存在する（実行時 `throw` の事前検出）。あわせて全マテリアルが `baseColorTexture` を持つ（fallback 柄で描かれる事故の検出） |
| `capability-contract.spec.ts` | §1.4 の能力契約をコマンド列に対して検査する: FC は 8px 丸め済み・`hardwareBlend` を持つコマンド 0 件・スプライト走査線制限適用済み、SFC は丸め無し。各コマンドの `hardwareBlend` が `generationSupportsHardwareBlend()` を満たし、`generations` と食い違わないこと（実行時 `throw` の事前検出）。世代 ID 直接分岐が無いことは ESLint ルールではなくレビュー項目とする |
| `palette-budget.spec.ts` | 各世代のビューが使う色定数（`defineGenerationVariant` にまとまっている）を数え、FC が 25 色以内・SFC が 256 色以内に収まる。実画面の色数は §7 フェーズ 8 でスクリーンショットから計測する |
| `score-phase.spec.ts` | 編曲差し替え前後で `phasePreserved` が真 |
| `manifest.spec.ts` | manifest の全 URL が `public/` に実在する |
| `minimap.spec.ts` | **4 世代それぞれのミニマップを組み立て、8 台のマーカーの正規化座標が世代間で完全一致する**（要求「1 つのシステムで動いていることの証明」の機械的な担保）。あわせて全マーカーが矩形内、FC は 8px 丸め済み、マーカー数が常に 8 であること。`build-minimap.mjs` が使う `trackBounds` と実行時の `trackBounds` が同値であること |
| `flow.spec.ts` | 状態機械が `title → countdown → racing → finished → result → title/countdown` を正しく遷移する。`title` のアトラクトデモがレース開始時のシード生成に影響しない |
| `check-cars.mjs` | 変換済み GLB / テクスチャの SHA-256 が `car-conversion.json` と一致する |
| `prepare-cars` 再現性 | `prepare:cars` を 2 回実行して出力がバイト一致し、かつ既存ファイルと一致する（フェーズ 2 で 1 回確認、以後は手動） |
| 生成ツール再現性 | `build:assets` を 2 回実行して `git status` に差分が出ない（フェーズ 7 で確認） |

### 6.3 性能予算

| 項目 | 予算 |
| --- | --- |
| フレーム時間 | 16.6 ms（60 fps）を全世代で維持 |
| 三角形数 | 20,000 tri/frame（エンジンの明示予算） |
| ドローコール | 第2世代の per-scanline アフィンが最大。240 コール以内。超えたら帯を 2→4 行に粗くする |
| 初回ロード | 全アセット合計 **約 3.0 MB**（フェーズ 2 時点。`public/assets` のディスク上は 3.8 MB だが、変換記録用に残している車の base color は実行時に読まない）。プリロード完了まで進行度表示を出す |

計画時の見積もりは 2.6 MB。生成アセットを足した実測はほぼ見積もりどおりに収まっている。内訳の大きいものはコースメッシュ（1.10 MB）・環境マップ（0.70 MB）・遠景とスプライト（0.30 MB）・車モデル（0.63 MB）。車体色を「無彩色 1 枚 × 実行時の乗算」にしたことで、塗装テクスチャは第3世代 57 KB・第4世代 186 KB で済んでいる（エントラントごとに焼き分けると第3世代だけで 1.02 MB、第4世代を 1024² で 8 枚焼くと 10 MB になっていた）。

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

### フェーズ 5 — 第4世代（PS2）

- `tools/build-track-mesh.mjs` の細 LOD 出力
- `view/gen4-ps2.ts`（環境マップ、動的ライト、落ち影、60Hz）
- ミニマップの PS2 variant（176²、順位色、自機の強調縁）
- **完了条件**: §6.1 の第4世代基準 1–5 を満たす。**4 世代すべてでミニマップが揃い、世代横断基準 6–7 を満たす**

### フェーズ 6 — サウンド

- `audio/score.ts`（共通 Score ＋ 4 編曲）
- `audio/engine-sound.ts` / `audio/sfx.ts`
- `score-phase.spec.ts`、`installAudioUnlock` の導線
- **完了条件**: 世代を切り替えても曲が途切れず、音色と編成だけが変わる。エンジン音が速度に追従し、ブレーキ音が鳴る

### フェーズ 7 — タイトル画面・HUD・ゲームフロー

- `tools/build-font-atlas.mjs` → `common/font.png`、`tools/build-title-logo.mjs` → `common/logo.png` を生成し manifest に登録
- `view/shared/hud.ts`、世代別の HUD 表現。ミニマップと HUD のレイアウトを `SCREEN_SAFE_AREA` 内で最終調整する（順位色・自機強調・パネルの仕上げ）
- `flow/screens.ts`（`title → countdown → racing → finished → result`）、`view/title.ts`
- タイトル画面のアトラクトデモ（AI 8 台のシムを背景として描く。§3.7）
- リトライ / タイトルへ戻る / ポーズ
- `flow.spec.ts`、`build:assets` の 2 回実行で差分が出ないことの確認
- **完了条件**: タイトルからリザルトまで通しで遊べる。§6.1 の世代横断基準 4–5 を満たす

### フェーズ 8 — 品質ゲートと改善ループ

要求「それを満たすまで改善を行なってください」に対応する反復フェーズ。

1. §6.1 の全基準をチェックリストとして実施し、結果を `Docs/QUALITY_REVIEW.md` に記録する
2. 各世代のスクリーンショットを `Docs/screenshots/` に保存し、世代間の差が一目で分かるか確認する
3. 満たさない項目について原因を切り分け、以下の順で手を打つ
   - パラメータ調整（`focal` / `camY` / `yH` / フォグ / 色）
   - ビュー実装の作り直し
   - **アセットの追加生成**（第2世代のコースマップ PNG、第1世代の横に広い road テクスチャ、追加の遠景レイヤーなど）
4. 全項目が通るまで 1–3 を繰り返す

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
    { url: 'assets/gen4/environment/circuit.png',     wrap: 'repeat' },
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
    { url: 'assets/gen3/models/track.glb', polygonSort: true },  // 生成物
    { url: 'assets/gen4/models/track.glb' },                     // 生成物
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
> `font.png` / `logo.png` / `markers.png` / `minimap.png` / `track.glb` / `track_*.png` は生成物のため、フェーズ 0 の manifest には含めず、生成したフェーズで追加する（`manifest.spec.ts` が実在チェックを行うため）。
