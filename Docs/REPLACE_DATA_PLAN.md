# 車モデル入れ替え計画書 — 第3・第4世代

`Docs/REPLACE_DATA.md`（入れ替え要求）に対する実装計画。実装計画書
（`Docs/IMPLEMENTATION_PLAN.md`）の**フェーズ 12** として追加することを想定する。

- 作成日: 2026-09-09
- 更新: 2026-09-09（**未決事項 1〜4 に回答を得て確定** — 第3世代は低ポリで再エクスポートされ
  2,094 → **964 tri** になり三角形予算の問題が消えた・`PAINT_TARGET` は下げる（§3 D-9）・
  第1／第2世代のスプライトは対象外・変換元は `data/gen{3,4}_car_tripo.glb` へ改名済み。
  再エクスポート版は**ヨーが 32.40° 付いている**ため、第3世代も回転の焼き込みが要るようになった）
- 前提: `4d27080`（GitHub Pages 公開まで実装済み）
- 対象: `data/gen3_car_tripo.glb` / `data/gen4_car_tripo.glb`（Tripo3D 生成・未加工）
- 不変条件:
  - **変換元 GLB は絶対に上書きしない。** 既存の `data/gen{3,4}_car.glb` も残す
  - **シミュレーションは 1 つ。** `src/game/sim/` には一切触らない。車の実寸を決めるのは
    `VEHICLE.CAR_LENGTH = 4.2` / `CAR_WIDTH = 1.95` の側であって、モデルの側ではない（D-7）
  - **色替えの仕組みは変えない。** 無彩色テクスチャ 1 枚 × `MeshCommand.color` の乗算（§3.4）。
    変えるのは明度の正規化目標という**数値 1 つ**だけ（D-9）
  - 実行時コード（`car-model.ts` の定数以外）とビュー（`gen3-ps1.ts` / `gen4-ps2.ts`）は変更しない
- 本書の数値はすべて**現物の GLB / テクスチャを読んで実測した値**（測定方法は §2 に記す）

---

## 1. 要求

`Docs/REPLACE_DATA.md` は 4 行しかない。実装可能な粒度へ分解する。

| # | 要求（原文） | 分解 |
| --- | --- | --- |
| R-1 | 新しい GLB を現在使っている車モデルと入れ替える | 変換元を差し替え、`public/assets/gen{3,4}/models/car.glb` と `.../textures/car_base_color.png` を焼き直す。変換記録（`car-conversion.json`）も更新する |
| R-2 | サイズを現在使用しているモデルに合わせる | 変換後の bounds が現行と同じ寸法クラスに収まり、**実寸が 4.2 m × 1.95 m へ載る**こと（`car-size.spec.ts` が固定している不変条件） |
| R-3 | 軸を現在使用しているモデルに合わせる | 変換後の**前方が `-X`**・左右が Z・上下が Y、原点は前後左右上下の中心。`CAR_YAW_OFFSET = π` / `CAR_YAW_SIGN = -1` を変えずに済むこと |
| R-4 | 自車・敵車双方が差し替わる | 第3・第4世代は 8 台とも同じ 1 つの GLB を引くので、モデルを差し替えれば自動的に両方に効く。**確認は実画面で行う**（§6.3） |
| R-5 | 色変えは現在の仕様に合わせる | `tools/build-car-paint.mjs` で塗装テクスチャを焼き直し、8 台がエントラント色で描き分けられること（`car-paint.spec.ts`） |

R-4 について: 第1・第2世代の車は同梱 `public/assets/gen{1,2}/sprites/cars.png` 由来の
2D スプライトで、**GLB とは無関係**。本作業では変わらない（D-10）。

---

## 2. 現状の実測

### 2.1 現在のパイプライン

```
data/gen3_car.glb ─┐
data/gen4_car.glb ─┴→ tools/prepare-cars.mjs ─→ public/assets/gen{3,4}/models/car.glb
                                                 （material / image / 未使用属性を除去）
public/assets/gen{3,4}/textures/car_base_color.png   ← 初期コミット同梱。再生成していない
        └→ tools/build-car-paint.mjs → .../car_paint.png（無彩色・実行時に読むのはこちら）

public/assets/car-conversion.json … 変換記録（SHA-256・三角形数・bounds・前方軸）
tools/check-cars.mjs … 記録と現物の SHA-256 照合
src/game/view/shared/car-model.ts … CAR_MODELS.bounds は記録の bounds を写したもの
```

実行時の効き方（`car-model.ts`）:

- `carModelScale(gen) = VEHICLE.CAR_WIDTH / bounds.width` — **車幅で合わせた 1 つの倍率**を 3 軸へ掛ける
- `carGroundOffset(gen) = bounds.bottom × scale` — 原点から最下点までの持ち上げ
- 前方 `-X` を `rotationY = π − H` で進行方向へ向ける

### 2.2 新しいモデルの実測

`tools/lib` と同じ読み方（GLB のチャンクを直接読む）で計測した。第3世代は低ポリ再エクスポート版。

| 項目 | gen3_car_tripo.glb | gen4_car_tripo.glb |
| --- | --- | --- |
| バイト数 | 137,928 | 768,872 |
| SHA-256 | `2748483e13ea15abaf23ca1a131e0627ac5ed47133d4605f28e634c417008661` | `34840cb145c72d2abc13443b44e7bbb2afa039f57bcbeae5ced483339051fe10` |
| generator | Tripo | Tripo |
| メッシュ / プリミティブ | 1 / 1（TRIANGLES） | 1 / 1（TRIANGLES） |
| 頂点属性 | POSITION / NORMAL / TEXCOORD_0 | POSITION / NORMAL / TEXCOORD_0 |
| 三角形 / 頂点 | **964 tri** / 1,101 vtx | **7,997 tri** / 9,977 vtx |
| インデックス | `UNSIGNED_SHORT` | `UNSIGNED_SHORT` |
| node | `matrix` 無し・TRS 無し | 同左 |
| bounds（素） | X ±0.4187 / Y 0〜0.2935 / Z ±0.4998 | X ±0.4192 / Y 0〜0.2817 / Z ±0.4998 |
| 対称面の法線 | **X から 32.40°** | **X から 34.40°** |
| 整列後の寸法（前後 × 上下 × 左右） | 1.0569 × 0.2935 × 0.5408 | 1.0608 × 0.2817 × 0.5454 |
| 長さ / 幅 | 1.954 | 1.945 |
| 前方 | **+Z**（整列後・車高の低い側） | **+Z**（同左） |
| 原点 | 底面が Y = 0（接地基準）・XZ は中心 | 同左 |
| base color | JPEG **512²**（baseline・95 KB 埋め込み） | JPEG **1024²**（baseline・400 KB 埋め込み） |
| normal / metallicRoughness | **無し**（除去済みの状態で届いている） | 無し |

対称面は 2 通りで測って一致を確認した。(a) 頂点を面で鏡映し最近傍が 6 mm 以内に来る割合の
最大化、(b) 三角形上に決定論的にサンプル点を撒いた鏡映誤差の最小化。第3世代は 32.30° と
32.40°、第4世代は 34.40° で一致する。整列後の上面図・側面図でも軸並行と鼻先 `−X` を目視確認した。

### 2.3 現行モデルとの差分

| 観点 | 現行（旧） | 新 | 影響 |
| --- | --- | --- | --- |
| 前方軸 | `-X` | `+Z` かつ **Y 回りに 32.40° / 34.40° のヨー** | **回転を焼き込む必要**（§4.2）。両世代とも要る |
| 原点 | 上下の中央 | 底面（Y = 0） | 中心合わせを焼き込む必要。放置すると `carGroundOffset = 0` になり `car-orientation.spec.ts` の「路面の上に載る」が落ちる |
| 全長 / 車幅の比 | 2.172（gen3）/ 2.164（gen4） | **1.954 / 1.945** | 車幅で合わせると全長が 3.81 m / 3.79 m になり、衝突判定の 4.2 m と食い違う（§3 D-4） |
| 三角形数（gen3） | 978 | **964** | ほぼ同数。**予算の問題は再エクスポートで解消**（D-6） |
| 三角形数（gen4） | 13,618 | 7,997 | 減る。第4世代は元から予算の対象外（実装計画 §6.3 の但し書き） |
| base color の形式 | PNG（gen3）/ JPEG（gen4）、**変換せず同梱**の PNG を使用 | JPEG のみ | **JPEG デコーダが要る**（§3 D-5・§4.1） |
| 塗装の色 | 赤（塗装部の平均 V 0.52 / 0.55） | 黄（同 **0.72 / 0.66**） | 仕組みは同じだが、素が明るいぶん正規化で白飛びする。`PAINT_TARGET` を下げる（D-9） |

### 2.4 塗装テクスチャ（色替え）の実測と `PAINT_TARGET`

`build-car-paint.mjs` の変換（彩度 0.22 以上を「塗装」とみなし、V の平均を `PAINT_TARGET` へ
正規化）を、新しい base color（JPEG を PNG へ起こし、gen3 は 256² へ縮小したもの）に対して
机上で流し、`PAINT_TARGET` を振った結果:

| `PAINT_TARGET` | gen3 白飛び | gen3 上位 25 % | gen4 白飛び | gen4 上位 25 % |
| --- | --- | --- | --- | --- |
| 0.82（現行） | 60.0 % | 222 | 60.3 % | 255 |
| 0.78 | 53.6 % | 211 | 57.4 % | 244 |
| 0.75 | 16.6 % | 203 | 52.5 % | 235 |
| 0.72 | 4.6 % | 195 | 33.8 % | 226 |
| **0.70** | **0.0 %** | **190** | **6.3 %** | **219** |
| 0.66 | 0.0 % | 179 | 0.0 % | 208 |

参考: 現行（赤）の白飛びは gen3 42.1 % / gen4 46.2 %、上位 25 % は 203 / 255。

`car-paint.spec.ts` の要件は「上位 25 % > 150」「中央値 < 230」。**0.70 なら両世代とも
白飛びが現行より少なく、明るさは現行と同等**に収まる（D-9）。中央値は新しい UV 島の
黒地が広いぶん 43〜47 まで下がるが、要件は満たす。

---

## 3. 要求の解釈と決定

| # | 決定 | 理由 |
| --- | --- | --- |
| D-1 | 新しい GLB は `data/gen{3,4}_car_tripo.glb` として扱い、`data/gen{3,4}_car.glb` は残す（**改名済み**） | `data/README.md` の「入力は絶対に上書きしない」を守る。`data/` は `.gitignore` 済みなので公開物は増えない |
| D-2 | 軸・原点・寸法の正規化は**変換器（`prepare-cars.mjs`）に焼き込む** | 実行時の `TransformCommand` は `rotationY` と等方 scale しか持たない（エンジン制約）。node TRS へ逃がすと accessor の min/max が実際の姿勢と食い違い、`CAR_MODELS.bounds` の意味が壊れる |
| D-3 | 変換後の**前方は `-X` のまま**にする | `CAR_YAW_OFFSET` / `CAR_YAW_SIGN` と `car-orientation.spec.ts` を変えずに済む。記録の `frontAxis` も `-X` を維持 |
| D-4 | 寸法は**左右・上下を 1 つの倍率、前後だけ別の倍率**で正規化し、実行時に全長 4.2 m・車幅 1.95 m へ載るようにする | 「サイズを現在のモデルに合わせる」の実体は不変条件「4 世代で車の実寸が一致する」（実装計画 D-7）。相似に縮めると全長が 3.81 m / 3.79 m になり、**見た目より先に当たる**車になる。前後の引き伸ばしは第3世代 1.102 倍・第4世代 1.107 倍で、側面図で確認したかぎり車輪の楕円化は目視できない範囲（代案は §7 リスク 2） |
| D-5 | JPEG デコーダ（baseline 限定）を `tools/lib/jpeg.mjs` として自前で持つ | 新しい base color は JPEG しか無く、現行 PNG は初期コミット同梱で再生成手段が無い。`tools/lib/png.mjs` が zlib だけで PNG コーデックを自前実装している方針（「本作が実際に扱う範囲だけ・汎用にはしない」）にそのまま倣う。これで**テクスチャまで含めて `prepare:cars` が変換元から再現できる**ようになる |
| D-6 | 第3世代の三角形数は**現状のまま通す**（対処不要） | 低ポリ再エクスポートで 964 tri になり、現行の 978 tri をわずかに下回った。走行中 1 フレームは路面 8,148 tri ＋ 車 8 台 7,712 tri ＝ **約 15,860 tri**（現行 約 16,000 tri）で、20,000 tri/frame の予算の内側 |
| D-7 | テクスチャの解像度は現行のまま（gen3 256² / gen4 1024²） | PS1 の 256² は世代らしさの一部。gen3 は 512² → 256² の 2 倍ボックス縮小（整数倍・既存 `downscaleBox`）で足りる |
| D-8 | `geometry.fingerprint` は記録から**落とす** | 「レンダラー正規形の指紋」の定義が成果物から復元できず、現行も更新せず据え置いていた値。新しい形状に旧い指紋を残すほうが有害。`bytes` と `sha256` で十分に固定できる |
| D-9 | `PAINT_TARGET` を **0.82 → 0.70** へ下げる | 黄の塗装は素の V が高く（平均 0.72 / 0.66）、現行の 0.82 では塗装面の 60 % が白飛びして陰影が消える。0.70 なら白飛び 0 % / 6.3 %、明るさ（上位 25 %）は 190 / 219 で現行と同等。**色替えの仕組みそのものは変えない** |
| D-10 | 第1・第2世代のスプライトは**対象外** | 同梱 `cars.png` 由来で 3D モデルとは別のデザイン。合わせるなら「新モデルを 3 方向からレンダリングしてアトラスを焼く」新しいツールが要り、本作業とは独立した規模になる |

---

## 4. 設計

### 4.1 `tools/lib/jpeg.mjs`（新規）

```js
/** baseline JPEG（SOF0/SOF1）だけを読む最小デコーダ。範囲外は明示的に失敗させる */
export function decodeJpeg(buffer): { width, height, pixels /* RGBA */ }
```

- 対応: baseline sequential・8 bit・3 成分（YCbCr）・4:4:4 / 4:2:0 / 4:2:2・restart marker
- **非対応**（例外を投げる）: progressive（SOF2）・算術符号・12 bit・CMYK・階層符号化
- 実装単位: マーカー走査 → 量子化表 / ハフマン表 → MCU 復号 → 逆量子化 → IDCT →
  クロマアップサンプリング → YCbCr→RGB（整数丸めを明示）
- 出力は `png.mjs` の `{ width, height, pixels }` と同じ形にして、`downscaleBox` /
  `encodePng` へそのまま渡せるようにする
- 開発中の照合: `sips -s format png` の出力と画素差の最大値・平均を比べる（**リポジトリには
  入れない一時確認**。macOS の decoder と完全一致はしないので、平均差 1 未満を目安にする）

### 4.2 `tools/prepare-cars.mjs` の正規化ステップ（変更）

現在の変換規則「POSITION / NORMAL / TEXCOORD_0 / indices / 三角形数 / **bounds** を保存する」を
「**正規化を焼き込む**」へ改める。`data/README.md` の変換規則もあわせて書き替える。

処理順（記録に書いた定数を使う。実行時に探索はしない — 「1 回だけ実測して定数化」の作法）:

1. **ヨーを戻す**: `yawDegrees`（gen3 = 32.40、gen4 = 34.40）だけ Y 回りに回し、対称面の法線を X 軸へ合わせる
2. **前方を `-X` へ**: さらに Y 回りに −90° 回す。`(x, z) → (−z, x)` の写像で、鼻先 `+Z` が `−X` へ来る
3. **中心合わせ**: 変換後の bounds の中心を原点へ平行移動する（3 軸とも）
4. **寸法合わせ**: 左右（Z）と上下（Y）へ `kLat = targetWidth / size.z`、前後（X）へ
   `kLon = targetWidth × (CAR_LENGTH / CAR_WIDTH) / size.x` を掛ける。
   `targetWidth` は現行の車幅（gen3 `0.86497` / gen4 `0.880626`）＝ **`carModelScale` の値が現行と同じになる**
5. **法線**: 回転はそのまま掛け、異方倍率には逆転置 `diag(1/kLon, 1/kLat, 1/kLat)` を掛けて正規化し直す
6. **min / max の再計算**: accessor の `min` / `max` を変換後の値で書き直す（現在はコピーしているだけ）。
   `measureGeometry` はここを読むので、忘れると記録と現物が食い違う
7. 以降は現行どおり — 属性を `POSITION / NORMAL / TEXCOORD_0 / indices` の順へ詰め、
   buffer を隙間なく並べ、`asset.generator` を固定して GLB を書く
8. `--write` のとき、`decodeJpeg` した base color を `downscaleBox`（gen3 のみ 2 倍）→ `encodePng` で
   `public/assets/gen{3,4}/textures/car_base_color.png` へ書き、記録の `texture` を更新する

浮動小数は Float32 へ落ちる前にすべて Float64 で計算し、**同じ入力から二度同じ出力**になること
（既存の「2 回目の変換が 1 回目と一致する」検査がそのまま効く）。

正規化後の見込み値（プロトタイプでの実測。実装後はツールの出力を正とする）:

| | 前後 length | 上下 height | 左右 width | bottom | 実行時倍率 | 全長 / 全高 / 車幅 |
| --- | --- | --- | --- | --- | --- | --- |
| PS1 | 1.863012 | 0.469346 | 0.864970 | 0.234673 | 2.2544 | 4.200 m / 1.058 m / 1.950 m |
| PS2 | 1.896733 | 0.454939 | 0.880626 | 0.227470 | 2.2143 | 4.200 m / 1.007 m / 1.950 m |

現行の全高は 1.085 m / 1.100 m なので、新しい車は 3〜9 % 低い。`car-size.spec.ts` の
「30 m 先の路面が屋根より上に残る」はより通りやすくなる方向。

runtime GLB のバイト数の見込み: 第3世代 63.5 KB → **約 42 KB**、第4世代 593 KB → **約 368 KB**。
初回ロード合計は 4.95 MB → **約 4.70 MB** になる見込み（実測して実装計画 §6.3 を更新する）。

### 4.3 `public/assets/car-conversion.json`（スキーマ拡張）

```jsonc
{
  "version": 2,
  "records": [
    {
      "generation": "PS1",
      "source": { "path": "data/gen3_car_tripo.glb", "sha256": "2748483e…", "bytes": 137928 },
      "normalize": {              // ← 新設。変換器が読む定数
        "yawDegrees": 32.4,       //    対称面の法線を X 軸へ戻す回転
        "frontAxisFrom": "+Z",    //    素のモデルの前方
        "targetWidth": 0.86497,   //    左右の目標寸法（＝現行と同じ）
        "lengthPerWidth": 2.153846153846154  // CAR_LENGTH / CAR_WIDTH
      },
      "runtime": { "model": {…}, "texture": { …, "dimensions": [256, 256] } },
      "geometry": { "triangles": 964, "vertices": 1101, "bounds": {…} },  // fingerprint は削除
      "frontAxis": "-X"
    }
  ]
}
```

`version` を 2 へ上げ、`fingerprint` を落とす（D-8）。`check-cars.mjs` は
`source` / `runtime.model` / `runtime.texture` の 3 つを見るだけなので**変更不要**。

### 4.4 `src/game/view/shared/car-model.ts`（定数の写し替え）

`CAR_MODELS.PS1.bounds` / `PS2.bounds` を、`prepare:cars` の出力（＝記録の `geometry.bounds`）から
写し直す。**手で書かない**という既存のコメントの約束を守り、値はツールの出力から採る。
`CAR_PAINT` / `CAR_YAW_OFFSET` / `CAR_YAW_SIGN` / 関数群は**変更なし**。

### 4.5 `tools/build-car-paint.mjs`（定数 1 つ）

`PAINT_TARGET` を 0.82 → 0.70（D-9）。定数のコメントに「素の塗装が明るい（V の平均が 0.7 前後）
素材では 0.82 だと 6 割が白飛びする」という実測の根拠を書き足す。**アルゴリズムは変えない。**

実装後、ツールが出した base color で §2.4 の表を測り直し、0.70 を基準に必要なら 0.02 刻みで
調整する（`sips` 経由の値と本実装のデコード結果は完全一致しないため）。

---

## 5. 変更するファイル

| ファイル | 変更 |
| --- | --- |
| `tools/lib/jpeg.mjs` | **新規**。baseline JPEG デコーダ |
| `tools/prepare-cars.mjs` | 正規化ステップ（回転・中心合わせ・寸法合わせ・法線・min/max 再計算）と、base color の書き出しを追加 |
| `tools/build-car-paint.mjs` | `PAINT_TARGET` 0.82 → 0.70（D-9） |
| `public/assets/car-conversion.json` | `version` 2・`normalize` 追加・`fingerprint` 削除・全数値の更新 |
| `public/assets/gen3/models/car.glb` | 焼き直し（63.5 KB → 約 42 KB） |
| `public/assets/gen4/models/car.glb` | 焼き直し（593 KB → 約 368 KB） |
| `public/assets/gen{3,4}/textures/car_base_color.png` | JPEG から焼き直し（256² / 1024²） |
| `public/assets/gen{3,4}/textures/car_paint.png` | `npm run build:paint` で焼き直し |
| `src/game/view/shared/car-model.ts` | `CAR_MODELS.*.bounds` の 8 個の数値のみ |
| `tests/car-conversion.spec.ts` | **新規**（§6.2） |
| `data/README.md` | 変換元の表・変換規則（正規化を焼き込む・テクスチャも再生成する）を更新 |
| `Docs/IMPLEMENTATION_PLAN.md` | §1.1 の表（三角形数）・§6.3（三角形と初回ロードの実測値）・フェーズ 12 の追記 |
| `README.md` | `prepare:cars` がテクスチャも焼くようになった旨（表の 1 行） |

**触らないもの**: `src/game/sim/`・`src/game/view/gen3-ps1.ts`・`gen4-ps2.ts`・
`src/assets/manifest.ts`・第1・第2世代のスプライト一式（D-10）。

---

## 6. 検証

### 6.1 既存テストへの影響

| テスト | 影響 | 対応 |
| --- | --- | --- |
| `car-orientation.spec.ts` | `frontAxis` は `-X` のまま・`bottom > 0` を維持するので**そのまま通る** | 変更なし（＝ D-2 / D-3 が正しいことの証明になる） |
| `car-size.spec.ts` | 車幅は厳密一致、全長は 4.200 m で `toBeCloseTo(4.2, 1)` を満たす。画面占有率は車幅由来なので不変 | 変更なし |
| `car-paint.spec.ts` | 塗装テクスチャを焼き直せば §2.4 の実測どおり通る（`PAINT_TARGET` 0.70 で上位 25 % が 190・中央値 43） | 変更なし |
| `gen4-environment.spec.ts` | 影の一辺 ＝ `carModelScale('PS2')` ＝ 2.2143 で現行と同値（1.95 < 2.21 < 4.2） | 変更なし |
| `frame-contract.spec.ts` | 路面メッシュ 3 つ以内。三角形の総数も 15,860 で予算の内側 | 変更なし |
| `manifest.spec.ts` | URL は変わらない | 変更なし |
| `npm run check:cars` | 記録を書き直せば通る（変換元がある環境で） | 記録更新 |

**既存テストを 1 つも書き換えずに通ることが、この設計の受け入れ条件**である。
書き換えが必要になったら、それは §3 の決定のどれかが破れているということ。

### 6.2 新規 `tests/car-conversion.spec.ts`

変換記録と runtime GLB を直接読み、正規化が効いていることを固定する。

1. runtime GLB が material / image / skin / animation を持たない（現行の規約の再確認）
2. POSITION の min/max が記録の bounds と一致する（§4.2 手順 6 の再発防止）
3. **左右対称**: 頂点を `x → x`, `z → −z` で鏡映したとき、6 mm 以内に相手が見つかる割合が
   75 % 以上（ヨーが残っていたら落ちる）。低ポリの第3世代でも通るよう、比較は三角形上に
   撒いたサンプル点で行う
4. **前方が `-X`**: 車高の最も低い側が `x < 0` にある（鼻先の判定）
5. `bounds.length / bounds.width` が `CAR_LENGTH / CAR_WIDTH` と 1 % 以内で一致する（D-4）
6. `bounds` の中心が原点から 1 mm 以内（中心合わせ）

### 6.3 実画面での確認（`Docs/screenshots/`）

`npm run dev` で内蔵ブラウザを開き、`window.racing` / `globalThis.racingFlow` を手で回す
（rAF が止まるため。`racing.host.frame(Math.max(合成時刻, performance.now()))` で時計を同期する）。

撮る絵は 792×594 へ縮めて `POST /__screenshot?name=...` へ投げる。

| 名前 | 内容 | 見るもの |
| --- | --- | --- |
| `newcar-gen3-race.png` | 第3世代・走行中（Digit3） | 自機の向き（進行方向を向いているか）・接地・大きさ |
| `newcar-gen4-race.png` | 第4世代・走行中（Digit4） | 同上＋環境マップの映り込み |
| `newcar-gen4-pack.png` | 敵車が前方に固まる位置（`racingFlow.race.cars` を編集して寄せる） | **8 台が別々の色で描き分けられている**（R-5）・敵車も差し替わっている（R-4） |
| `newcar-gen3-contact.png` | 接触の瞬間 | 全長 4.2 m と見た目が食い違わない（D-4 の確認） |

塗装の白飛び（D-9）はこの絵で最終判断する。曲面の陰影が残り、8 色が見分けられていれば良い。

### 6.4 再現性

```sh
npm run prepare:cars            # 記録と現物が一致することの確認（書き込まない）
npm run prepare:cars -- --write # 焼き直し
npm run prepare:cars -- --write # 2 回目。git status に差分が出ないこと
npm run build:paint             # 塗装テクスチャ。これも 2 回でバイト一致
npm run check:cars
npm test && npm run typecheck && npm run build
```

---

## 7. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| 1. ヨーの符号を取り違え、車が斜めのまま焼ける | 車が横滑りしているように見える。**両世代ともヨーが付いているので今回は必ず通る道** | §6.2 の対称性テストが検出する。加えて §6.3 で上面の分かる絵を 1 枚撮る |
| 2. 前後の引き伸ばし（1.10 / 1.11 倍）が車輪の楕円化として見える | 見た目の劣化 | 実画面で確認する。目立つなら**相似（等方）縮小へ切り替え、`car-size.spec.ts` の全長の主張を「衝突判定より短い」へ緩める**。切り替えは記録の `lengthPerWidth` を消すだけで済むように実装する |
| 3. 自前 JPEG デコーダの誤り | 迷彩柄のテクスチャになるが例外は出ない | 開発中に `sips` の出力と画素差を測る。焼いた PNG を目視し、`car-paint.spec.ts` の明度分布でも間接的に検出される |
| 4. `PAINT_TARGET` を下げすぎて車体が沈む | 8 色の見分けが付きにくくなる | `car-paint.spec.ts` の「上位 25 % > 150」が下限を守る。実画面（§6.3）で最終判断 |
| 5. 変換規則の変更で「bounds を保存する」という旧い約束と矛盾する | ドキュメントの嘘 | `data/README.md` と実装計画書 §2.6 の記述を同じコミットで更新する |
| 6. 新しい UV 島の配置が旧テクスチャと違うのに、テクスチャだけ焼き忘れる | 車体が迷彩柄になる | `check:cars` が SHA-256 で検出する。`frame-contract.spec.ts` の `baseColorTexture` 検査も残る |

---

## 8. 作業手順（フェーズ 12）

| 段 | 内容 | 完了条件 |
| --- | --- | --- |
| 12-1 | `tools/lib/jpeg.mjs` を書く | 2 枚の埋め込み JPEG を復号し、`sips` 出力との平均画素差が 1 未満 |
| 12-2 | `prepare-cars.mjs` に正規化とテクスチャ書き出しを実装。記録を v2 へ | `npm run prepare:cars -- --write` が通り、2 回目でバイト一致 |
| 12-3 | `car-model.ts` の bounds を記録から写す。`PAINT_TARGET` を 0.70 にして `build:paint` を流す | `npm test` が**既存テストを書き換えずに**全通過 |
| 12-4 | `tests/car-conversion.spec.ts` を追加 | 6 項目すべて通過 |
| 12-5 | 実画面で確認し、証拠写真を撮る | §6.3 の 4 枚。R-4 / R-5 が絵で確認でき、白飛びが許容範囲 |
| 12-6 | ドキュメント更新（`data/README.md`・実装計画書 §1.1 / §6.3・`README.md`） | 三角形数（15,860）・初回ロード（約 4.70 MB）・変換規則が現物と一致 |

12-1 と 12-2 は独立して進められる（12-2 のうちテクスチャ書き出しだけが 12-1 に依存する）。

---

## 9. 決定の履歴

| 日付 | 決定 |
| --- | --- |
| 2026-09-09 | 初版。未決事項として (1) 第3世代の三角形予算超過 (2) `PAINT_TARGET` の調整 (3) 第1・第2世代スプライトの追随 (4) 変換元の改名 を提示 |
| 2026-09-09 | (1) **第3世代を低ポリで再エクスポート**して差し替え（2,094 → 964 tri）。予算の問題は消えた（D-6）。ただし再エクスポート版はヨーが 32.40° 付いており、第3世代も回転の焼き込みが必要になった |
| 2026-09-09 | (2) `PAINT_TARGET` を 0.82 → **0.70** へ下げる（D-9）。実測の根拠は §2.4 |
| 2026-09-09 | (3) 第1・第2世代のスプライトは**本計画に含めない**（D-10） |
| 2026-09-09 | (4) 変換元を `data/gen3_car_tripo.glb` / `data/gen4_car_tripo.glb` へ**改名済み**（D-1） |
