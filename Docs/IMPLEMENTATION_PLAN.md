# ConsoleChaosRacing 実装計画書

`Docs/PLAN.md`（要求仕様）に対する実装計画。同梱エンジン `reference/console-chaos-engine-0.1.0.tgz`（`@console-chaos/engine@0.1.0`）と `public/assets/` の既存アセットを実測したうえで作成している。

- 対象: 1 アプリで FC / SFC / PS1 / PS2 の 4 世代表現を切り替えられるサーキットレース
- 不変条件: **シミュレーションは 1 つ。世代は表示と入出力の作法だけを変える**
- 作成日: 2026-08-12
- 更新: 2026-08-12（エンジン導入完了・更新版 README を反映・`car-conversion.json` のパス修正を反映・§9 の決定事項 6 項目を反映）

---

## 1. 現状と前提

### 1.1 すでにある物

| 物 | 場所 | 状態 |
| --- | --- | --- |
| 要求仕様 | `Docs/PLAN.md` | 確定 |
| エンジン | `@console-chaos/engine@0.1.0`（`reference/*.tgz` から導入済み） | ESM / ES2022 / WebGL2 必須。`package.json` / `package-lock.json` あり |
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

> 導入済みパッケージの `dist/` は tarball と**バイト一致**（`index.js` の SHA-256 が同一）であり、更新されたのは README のみ。したがって以下の実測結果はすべて有効。

| 事実 | 影響 |
| --- | --- |
| `RasterSurfaceCommand` は `profile.video.rasterScroll` が真の世代（**FC のみ**）でしか描かれない | 第1世代のラスタースクロールは FC 専用パス |
| `AffineSurfaceCommand` は `profile.video.affinePlane` が真の世代（**SFC のみ**）でしか描かれない | 第2世代のアフィン変換は SFC 専用パス |
| `OverlayCommand`（text/rect）は **Canvas 2D レンダラーでしか描画されない**。`createGenerationWebGlRenderer` は overlays を無視する | **HUD をテキストコマンドで作れない**。スクリーン空間スプライト＋自前フォントアトラスで作る（§3.5） |
| `MeshCommand.material` は必須。フレームに同 id の `MaterialCommand` が無いと `throw` する | すべてのメッシュに material を必ず積む |
| `SpriteCommand.texture` は**アトラス URL**として解決される（`manifest.atlases` に登録が必要）。単体テクスチャは不可 | `cars.png` と HUD フォントはアトラス登録する |
| 非スキンメッシュのテクスチャは GLB からは引かれない。`MaterialCommand.baseColorTexture`（URL）で指定する | 車の base color は manifest とマテリアルの両方に書く。runtime GLB は material も image も持たないので**指定を忘れると fallback 柄になる** |
| `profile.video.animationHz` をレンダラーが適用するのは **`SkinnedMeshCommand.animationTime` の量子化のみ**（`floor(t*hz)/hz`）。実測した車 GLB は skin も animation も持たない | 6/12/30/60Hz の「見た目の更新レート」は**ゲーム側で量子化する**（§3 冒頭） |
| `MeshCommand.asset` に `manifest.models` の URL を指定するとその GLB の全プリミティブを描く | コースメッシュも GLB として供給できる |
| `TransformCommand` の回転は `rotationY` のみ。X/Z 軸の傾きは表現できない | バンク角つきコースは**メッシュを事前生成**するしかない（`tools/build-track-mesh.mjs`） |
| `quadMesh` は XZ 平面・上向き・`[-1,1]`。`geometry.kind:'quad'` は `halfSize` で XZ にスケールされる | 平坦な路面の暫定表現には使えるが、傾けられない |
| PS1 は `depthBuffer:false`。レンダラーは深度バッファが無い世代でメッシュを距離順（奥→手前）に並べ替える。`MaterialCommand.polygonSort` / `RenderModelAsset.polygonSort` でポリゴン単位ソートも可能 | 第3世代は面のちらつきが出る前提で組む（当時の表現そのもの） |
| `rasterSurfaces` / `affineSurfaces` は**背景の後・メッシュの前**に描かれる | 路面サーフェス上に車スプライトを重ねられる |
| ラスタールックアップは **8bit に量子化**されて GPU に渡る（`createRasterLookupEncoder`）。center / width / sourceV / brightness の各値が 1/255 刻み | 近距離行の路面幅が段付きになる。当時の HDMA テーブルと同じ性質なので**そのまま採用する** |
| `RasterSurfaceCommand` の scanline `width` は **(0, 1] に制限**され、範囲外は `throw` | 第1世代の描画距離に上限が生まれる（§3.2 で数式化） |
| `AffineSurfaceCommand` には幅の制限が無い | 第2世代は描画距離を伸ばせる |
| 音声は `createGenerationAudioService` が `profile.audio.synth` ごとに音源を登録し、`GameHost` が世代切替時に自動で差し替える。`MusicClock` により**位相は保たれる** | 曲データは 1 つ。編曲だけ `useScore` で差し替える |
| 継続音の API は無い。`playOneShot` の連続予約のみ | エンジン音は短い one-shot の連続再生で作る（実機の作り方と同じ）。§4.3 |
| `@console-chaos/engine-testkit` は同梱されていない | テストは自前の手動ループホストか、純ロジックのみを対象にする |

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
| `alphaBlend` | 不可 | 可 | 可 | 可 | FC では半透明・加算を一切積まない |

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
{ "dependencies": { "@console-chaos/engine": "file:reference/console-chaos-engine-0.1.0.tgz" } }
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
| `public/assets/common/markers.png` | `build-minimap.mjs` | 車マーカー（8×8 の丸・四角の 2 セル） | 1 |
| `public/assets/gen3/models/track.glb` | `build-track-mesh.mjs` | 第3世代コース（4 m 刻み） | 2 |
| `public/assets/gen4/models/track.glb` | `build-track-mesh.mjs` | 第4世代コース（1 m 刻み） | 5 |
| `public/assets/gen{3,4}/textures/track_*.png` | 同上 | 路面・縁石・草地 | 2 / 5 |
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
| 半透明 | 不可 | 可 | 可 | 可 |
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

- `TEX_W = 26 m`（`road.png` の中央約 46% が路面 ⇒ 実効路面幅 12 m）
- `focal = 700`（縦画角 ≒ 18°。2D の路面なので実カメラと一致させる必要は無い）
- ⇒ `zMax ≒ 60 m`、`yH` を画面上 42% に置くと `z_near ≒ 8 m`

近距離行では `widthU` が小さく 8bit 量子化の刻みが相対的に粗くなり、路面の縁が段付きになる。**これは HDMA テーブルと同じ性質なので修正しない**。ただし `widthU` の最小値が 0.05 を下回ると崩れるため、`camY` と `yTop` はその範囲で決める。

テクスチャの `wrap` は **`clamp`** にする（`sourceV` を CPU 側で `fract` 済みにするため縦の repeat は不要）。これにより路面が画面外へ流れるコーナーでも横は草地が伸び、二重の道路が現れない。

- **速度感**: `sourceV` の進み（＝ `s0` の増加）が唯一の速度表現。破線センターラインの流れが速度に直結する。
- **縞**: `bright` を偶奇行で 0.94 / 1.00 に振り、遠方ほど差を詰める。走査線の存在を色で見せる。
- **遠景**: `BackgroundCommand` に `coast.png`、`parallax` を自機の向き（`heading`）に、`offset.y` を標高に連動。`placement` で地平線に合わせる。
- **車**: `SpriteCommand` を `screenSpace: true` で積む。自機は画面下部固定、`cell` はステア量で 0/1/2（黄）を選び **6Hz に量子化**。ライバルは `cell` 3/4/5（赤）、`size` を `halfPx(z)` に比例させ、`position` は `cx(z)` と行 `y(z)` に置く。
- **ちらつき**: `applyScanlineLimit(sprites, 8, 224)` を使い、走査線あたり 8 スプライトを超えた分を消す。`createFlickerState` で「消えたスプライトは次ティックの当たり判定も消える」を再現する。登録順（＝優先度）は **自機 → ミニマップの車マーカー → ライバル車**。自機は必ず先頭に登録して消えないようにする。ミニマップの枠と HUD 文字は BG 相当として制限の対象外、マーカーは対象内で毎フレーム順序を巡回させる（§3.6 に根拠）。
- **能力契約（§1.4）の遵守**:
  - `maxSimultaneousColors: 25` — 54 色への量子化はエンジンが行うが**同時 25 色は自動では守られない**。半透明・グラデーション・色数の多い合成を積まない。検証は §6.2 の色数カウント。
  - `paletteBlockSize: 16` — 遠景と路面の色の切り替わりを 16px ブロック境界に合わせる。
  - `tileSnap: 8` — 遠景のスクロール量とスプライトの配置座標を **8px に丸める**。`Math.round(x / 8) * 8`。ラスターサーフェスの scanline 値はこの対象外（走査線単位のスクロールが第1世代の売りであるため）。
  - `alphaBlend: false` — 落ち影・半透明を一切積まない。影は単色のスプライトかドット抜きで表現する。

> README も「疑似3Dや曲面道路は `RasterSurfaceCommand` の scanline table で表現する。各走査線の source 位置・幅・明るさを変え、`rasterScroll` pass で水平スクロールや遠近を作る」と明記しており、本節の設計と一致する。

### 3.3 第2世代（SFC）— アフィン変換による擬似3D

**要求**: 「背景のアフィン変換技術を用いて、擬似3Dのコースを走行」

アフィン変換は 1 枚では透視にならないため、**走査線ごとに `AffineSurfaceCommand` を 1 枚ずつ積む**（実機の HDMA によるパラメータ書き換えと同じ構造）。

行 `y` について `screenRect = [0, y, 256, 1]`:

```
z        = camY * focal / (y - yH)
scaleU   = z / (focal * TEX_W)                 // 画面 1px あたりの U 進み
uvOrigin = [ 0.5 + (off(z) - (W/2) * z / focal) / TEX_W , fract((s0 + z) / TEX_L) ]
uvStepX  = [ scaleU, 0 ]
uvStepY  = [ 0, 0 ]                            // 高さ 1px なので不要
wrap     = 'clamp'                             // V は CPU 側で fract 済み
```

車の向き（`heading`）による回転は `uvStepX` に回転成分を入れて表現する（`uvStepX = [scaleU*cos, scaleU*sin]`）。カーブでの視界の傾きが出る。

- **帯の粒度**: まずは 1 行 = 1 サーフェスで実装する（路面帯 ≒ 120 行 ⇒ 120 ドローコール）。フレーム時間が予算（§6.3）を超えたら 2 行 / 4 行の帯に落とす。粒度は定数 1 つで切り替えられるようにしておく。
- **描画距離**: 幅の制限が無いので 200 m 以上まで伸ばせる。遠方は `BackgroundCommand.fogDensity` と `brightness` で海の色へ溶かす。
- **遠景**: 第1世代と同じ `coast.png`（SFC 版）だが、色数と `parallax` の段数を増やす。
- **車**: 32 スプライト/走査線なので制限は実質かからない。半透明が使えるので**落ち影**を薄いスプライトで置く。ステアフレームは 12Hz 量子化。
- **能力契約**: `tileSnap: 1` なので座標を丸めない（FC との差がそのまま「滑らかさ」の差になる）。`paletteBlockSize: 8`、`maxSimultaneousColors: 256`、`alphaBlend: true`。

> README も「地面・道路・床は `AffineSurfaceCommand` の UV origin と X/Y step で 1 枚の texture を変形する `affinePlane` pass が中心。これは 3D mesh ではなく screen-space の疑似3D」と述べており、本節の走査線単位アフィンはその延長にある。

> **品質ゲートで不足した場合の改善案**: 現在の `circuit.png` は直線路タイルであり、真の Mode 7 的な「コース全体マップの回転」は表現できない。品質基準（§6.1）を満たさない場合、`tools/` にコース中心線からトップダウンのコースマップ PNG を生成する手順を追加し、アフィン面をマップ参照に切り替える。この場合 `uvOrigin`/`uvStepX` はワールド XZ → マップ UV の直接変換になり、per-scanline のスケールだけで透視が付く。

### 3.4 第3世代（PS1）/ 第4世代（PS2）— 3D

共通部分（`view/shared/camera.ts`）:

- `CameraCommand.projection = 'perspective'`、自機の後方 6.5 m / 高さ 2.2 m、注視点は自機の 12 m 前方。速度に応じて FOV を 60°→72°、カメラ距離を微増。
- コースは `tools/build-track-mesh.mjs` が中心線から生成した GLB を `MeshCommand.asset` で描く。`TransformCommand` に X/Z 回転が無いため、バンクと標高はメッシュに焼き込むしかない。
  - 出力: `public/assets/gen3/models/track.glb`（粗・PS1 用）と `public/assets/gen4/models/track.glb`（細・PS2 用）
  - 分割: PS1 は 4 m 刻み、PS2 は 1 m 刻み。**PS1 側をあえて粗くするのではなく、細かくしすぎない**ことでアフィンテクスチャの歪みと頂点量子化の揺れが画面に出る（エンジンの `geometry.ts` が明記している性質）
  - 路面 / 縁石 / 草地 / ガードレールを別マテリアルのプリミティブに分ける
- 車は `MeshCommand.asset = 'assets/genN/models/car.glb'`。**前方が `-X`** なので `transform.rotationY = heading + π/2` で補正する（符号は実装時に 1 回だけ実測して定数化する）。
- runtime GLB は material も image も持たない（変換で除去済み・実測確認済み）。したがって `MaterialCommand`（`baseColorTexture` に `assets/genN/textures/car_base_color.png`）を**必ず**積む。積み忘れると fallback 柄で描かれ、例外にならないので気付きにくい。§6.2 の `frame-contract.spec.ts` で検出する。
- 影は `castShadow: true` + `groundY` を路面高に設定（エンジンが点光源から落ち影を落とす）。

**第3世代（PS1）固有**:

- `depthBuffer: false` ⇒ メッシュはレンダラーが距離順に並ぶ。車とコースの前後関係が破綻しないよう、コースを大きな 1 メッシュにせず**セクター分割**（約 50 m ごと）して個別の `MeshCommand` にする。
- `MaterialCommand.polygonSort: true`（および `RenderModelAsset.polygonSort`）を車とコースに設定し、ポリゴン単位ソートを有効化。
- `vertexQuantize: 2` と `affineTexture: true` はエンジンが自動適用。**頂点の揺れとテクスチャの歪みを消そうとしない**。
- `dynamicLight: false` ⇒ ライティングは `LightCommand` の ambient / directional のフォールバックのみ。`MaterialCommand.ambient` / `diffuse` を明るめに調整して焼き込み風にする。
- `BackgroundCommand.fogDensity` で遠景を切る（当時の描画距離の短さ）。遠景は `coast.png` 相当ではなく単色＋フォグ。
- 30Hz 量子化: 車のホイール回転・車体ロールなど見た目の更新を 30Hz に丸める。

**第4世代（PS2）固有**:

- `depthBuffer: true` ⇒ 前後関係は正しい。コースは 1 メッシュでよい。
- `environmentMap: true` ⇒ 車のマテリアルに `environmentTexture: 'assets/gen4/environment/circuit.png'`、`environmentStrength: 0.35`。エンジンの正距円筒マッピング（`equirectangularUv`）で車体に景色が映り込む。**これが第4世代の署名的表現**。
- 同じ環境マップを `BackgroundCommand.texture` にも使い、空と遠景を一致させる。
- `dynamicLight: true` ⇒ `LightCommand` を積む: 太陽（directional、環境マップの太陽位置と一致させる）、ambient、自機周辺の点光源 1 つ（落ち影の生成にも使われる）。
- `textureFilter: 'linear'` と 640×448 により、同じ車モデルでも第3世代と明確に差が出る。
- `MaterialCommand.uvScrollY` を路面の陽炎表現などに使う余地を残す。

### 3.5 HUD（全世代共通の仕組み）

`OverlayCommand` は WebGL レンダラーで描画されないため、**自前のビットマップフォントで描く**。

- `tools/build-font-atlas.mjs` が 8×8 のフォントアトラス `public/assets/common/font.png`（16 列 × 6 行 = 96 文字、ASCII 0x20–0x7F）を生成する。純粋な生成スクリプトなのでリポジトリ内で完結する。
- `manifest.atlases` に `{ url, columns: 16, rows: 6 }` で登録。
- `src/game/view/shared/hud.ts` が文字列 → `SpriteCommand[]`（`screenSpace: true`）に変換する。
- 表示: 順位 / 周回 / ラップタイム / ベストラップ / 速度 / 現在世代。
- 世代差は色数と配置で出す。FC は単色 2 段、SFC は影付き 2 色、PS1/PS2 は半透明パネル（`alphaBlend` が有効な世代のみ）。
- 配置は `SCREEN_SAFE_AREA`（4:3・オーバースキャン 4%）の内側に収める。

### 3.6 ミニマップ（全世代必須）

**目的**: プレイヤーへの情報提供に加えて、**4 世代が 1 つのシミュレーションで動いていることを画面上で証明する**。同じコース・同じ 8 台・同じ順位が、4 通りの表現で同時に成立していることを一目で示す装置として扱う。この意図があるため、ミニマップは「あれば良い HUD 要素」ではなく**全世代の必須要素**として受け入れ基準に入れる。

**構造**

コース輪郭は事前生成テクスチャ、車マーカーは実行時のスクリーン空間スプライトに分ける。

- **コース輪郭**: `tools/build-minimap.mjs` が `src/game/sim/track.ts` を直接 import し、`TrackSample[]` から俯瞰図 PNG を世代ごとに 1 枚ずつ生成する。実行時に毎フレーム線を引かないのは、エンジンのスクリーン空間プリミティブが `SpriteCommand` しか無く（メッシュはワールド空間のみ）、輪郭を点スプライトで描くと第1世代の 8 スプライト/走査線を即座に食い潰すため。
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
| 背景パネル | なし（輪郭線のみ。`alphaBlend:false`） | 半透明パネル | 半透明パネル | 半透明パネル＋縁のぼかし |
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
3. 落ち影・半透明が使われている
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
| `capability-contract.spec.ts` | §1.4 の能力契約をコマンド列に対して検査する: FC は 8px 丸め済み・半透明コマンド 0 件・スプライト走査線制限適用済み、SFC は丸め無し。世代 ID 直接分岐が無いことは ESLint ルールではなくレビュー項目とする |
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
| 初回ロード | 全アセット合計 約 2.6 MB。プリロード完了まで進行度表示を出す |

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
- 車モデルの前方軸補正、`polygonSort`、フォグ、セクター分割
- ミニマップを右下へ縮小配置（PS1 の variant 設定）
- **完了条件**: 3D で走れる。§6.1 の第3世代基準 1–6 を満たす。`prepare:cars` → `check:cars` が通る。**ミニマップのマーカーと 3D 空間の車の位置が一致する**（世界モデルの目視検証としてここで効く）
- **なぜ先か**: 最も素直な 3D で世界モデルの妥当性を目視検証でき、以降のフェーズの土台になる

### フェーズ 3 — 第1世代（FC）

- `view/shared/projection.ts` / `backdrop.ts` / `car-sprite.ts`
- `view/gen1-fc.ts`（ラスターサーフェス、`applyScanlineLimit`、6Hz 量子化）
- ミニマップの FC variant（8px グリッド配置、2 色マーカー、走査線制限への参加と順序巡回）
- `raster-scanline.spec.ts`
- **完了条件**: §6.1 の第1世代基準 1–9 を満たす
- **なぜここか**: 4 世代で最も調整量が多く、リスクが高い。早く着手して改善の時間を確保する

### フェーズ 4 — 第2世代（SFC）

- `view/gen2-sfc.ts`（per-scanline アフィン、回転、フォグ、落ち影、12Hz 量子化）
- ミニマップの SFC variant（半透明パネル、影付きマーカー）
- `affine-surface.spec.ts`、帯粒度のフォールバック実装
- **完了条件**: §6.1 の第2世代基準 1–5 を満たす
- フェーズ 3 の `projection.ts` をそのまま使うため実装量は小さい

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
| 第1世代の描画距離が短く「奥に進む」感が出ない | 要求未達 | `focal` を大きく取り（§3.2 の数式）、地平線を高めに置く。それでも不足なら `road.png` を横に広い版として再生成し `TEX_W` を拡大する |
| 第2世代の per-scanline アフィンが 120 ドローコールで重い | フレーム落ち | 帯粒度を定数化し 2 行 / 4 行へ落とせるようにする。GPU 側は全画面三角形 1 枚なので帯化の効果は大きい |
| `circuit.png` が直線路タイルのため Mode 7 らしい「マップの回転」が出ない | 第2世代の説得力不足 | `uvStepX` の回転成分で視界の傾きを出す。不足ならコースマップ PNG を生成して切り替える（§3.3 の改善案） |
| PS1 に深度バッファが無く車がコースに埋まる | 破綻 | コースをセクター分割し、`polygonSort` を有効化。車は常にコースより後に積む |
| `OverlayCommand` が WebGL で描かれない | HUD が出ない | フォントアトラス方式で解決済み（§3.5）。フェーズ 7 の前提として `build-font-atlas.mjs` を先に用意する |
| `MeshCommand.material` 欠落で実行時例外 | クラッシュ | `frame-contract.spec.ts` で全コマンドを走査して事前検出 |
| ラスタールックアップの 8bit 量子化で近距離の路面がガタつく | 品質 | 当時の性質として許容。ただし `widthU` の下限 0.05 を守るよう `camY` / `yTop` を決める |
| FC の 5 声でエンジン音が BGM を潰す | 音がスカスカ | 世代ごとにエンジン音の予約間隔と `velocity` を変える。FC は間隔を長く、`perc` を間引く編曲にする |
| `engine-testkit` が無くホストのテストが書けない | テスト不足 | 手書きの `LoopHost`（`now()` を手動で進める）と記録レンダラーを `tests/support/` に自作する |
| エンジン tarball を Git 管理下に置かない方針（決定事項 §9-5 (c)）のため、新規クローンで `npm install` が失敗する | セットアップの手間・CI が組めない | ルート `README.md` に入手手順と SHA-256 を記載（フェーズ 0）。**受け入れ済みの制約**であり回避策は取らない。CI が必要になった時点で tarball の注入方法を別途決める |
| tarball を差し替えても `package-lock.json` の見た目が変わらず、古い `node_modules` のまま動く | 原因不明の不具合 | `README.md` に記録した SHA-256 と現物を突き合わせる手順を書く。エンジン更新時は `rm -rf node_modules && npm install` を徹底 |
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
