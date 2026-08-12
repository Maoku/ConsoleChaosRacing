/**
 * 第4世代の環境マップとその派生（実装計画 §3.4 / §6.1 第4世代基準 1–2）。
 *
 * **このファイルは `tools/build-skyline.mjs`・manifest・`gen4-ps2.ts` が共有する。**
 * 空と映り込みが同じ絵から出ていることを、実装の構造として保証するのが目的である。
 *
 * ## 正距円筒の座標
 *
 * レンダラーの `equirectangularUv()` は方向ベクトル d をこう写す。
 *
 *     u = fract(0.5 + atan2(d.z, d.x) / 2π)
 *     v = acos(d.y) / π
 *
 * `v = 0` が真上・`v = 0.5` が水平・`v = 1` が真下になる。仰角 φ で書けば
 * `v = 0.5 − φ/π` で、**画像の上端が空**という素直な並びになる。
 *
 * ## flipY の向きが 2 つに割れる
 *
 * レンダラーは `manifest.textures` を既定 `flipY: true`（画像を上下反転して取り込む）で
 * 読む。ところが用途によって要求が逆になる。
 *
 * | 用途 | 要求 | 理由 |
 * | --- | --- | --- |
 * | `MaterialCommand.environmentTexture` | **`flipY: false`** | `v = 0` が真上。反転すると空が地面として映り込む |
 * | `BackgroundCommand.texture`（遠景の層） | `flipY: true`（既定） | 層のシェーダが「絵は反転済み」を前提に v をそのまま渡す |
 *
 * したがって**同じ 1 枚を両方には使えない**。地平線の帯を別ファイルとして焼き出し、
 * 遠景の層にはそちらを渡す（`tools/build-skyline.mjs`）。元が同じ画像なので、
 * 空と映り込みが一致するという要求は満たされる。
 */

export const ENVIRONMENT_MAP = {
  url: 'assets/gen4/environment/circuit.png',
  width: 1024,
  height: 512,
} as const;

/** 仰角 [rad] → 正距円筒の v。`0` が水平、正が上 */
export function equirectV(elevation: number): number {
  return 0.5 - elevation / Math.PI;
}

/** 正距円筒の v → 仰角 [rad] */
export function equirectElevation(v: number): number {
  return (0.5 - v) * Math.PI;
}

/** 方位 [rad]（ワールドの atan2(z, x)）→ 正距円筒の u */
export function equirectU(azimuth: number): number {
  const u = 0.5 + azimuth / (2 * Math.PI);
  return u - Math.floor(u);
}

const DEG = Math.PI / 180;

/**
 * 遠景の層として焼く帯（`public/assets/gen4/backgrounds/skyline.png`）。
 *
 * ## なぜ ±50° と広く採るか
 *
 * 層は画面に**平らに**貼られるので、仰角と画面行の対応は本来 tan で曲がる。
 * 帯を狭く採って外側を空の階調に任せると、帯の縁で色が跳ねて横線に見える。
 * そこで**どの画角・どの見下ろし角でも画面を覆いきる**広さに採り、階調が
 * 見えないようにした。水平線の位置だけを合わせ、縁のずれは絵の無い空へ逃がす
 * （`gen4-ps2.ts` の `skylineBackgrounds()`）。
 *
 * ## 地平線より下を潰す理由
 *
 * 元の環境マップには**撮影地のコースそのもの**が写っている。そのまま貼ると、
 * 自分たちの 3D コースの左右に二本目の道路が現れる。地平線のすぐ下から
 * 一様な霞へ溶かし、それより下は絵を持たせない。潰した先の色は
 * **地表の平均色を地平の霞へ寄せたもの**で、生成ツールが環境マップから求める
 * （色の定数を手で写さない ＝ ずれようが無い）。
 */
export const SKYLINE = {
  url: 'assets/gen4/backgrounds/skyline.png',
  /** 切り出す仰角の上端 */
  topAngle: 50 * DEG,
  /** 切り出す仰角の下端 */
  bottomAngle: -50 * DEG,
  /** ここから下は元の絵を捨て始める。海岸線のすぐ下 */
  groundFadeFrom: -2 * DEG,
  /** ここより下は完全に霞。撮影地の路面はこの内側で消える */
  groundFadeTo: -9 * DEG,
  /** 地表の色を地平の霞へ寄せる割合。遠くほど霞むという当たり前の性質 */
  groundHaze: 0.5,
} as const;

/** 帯が切り出す元画像の行の範囲 [開始, 終了)。生成ツールと実行時が同じ式で求める */
export function skylineRows(sourceHeight: number): [number, number] {
  return [
    Math.round(equirectV(SKYLINE.topAngle) * sourceHeight),
    Math.round(equirectV(SKYLINE.bottomAngle) * sourceHeight),
  ];
}

/**
 * 太陽の方向（環境マップの中で最も明るい点から実測した単位ベクトル）。
 *
 * `LightCommand.direction` は**光の側へ向かうベクトル**（シェーダは
 * `dot(normal, normalize(uLightDirection))` を取る）。映り込みに写っている太陽と
 * 陰影の向きを一致させるために、この 1 つの値を両方が使う。
 *
 * 実測値: 最輝点は (120, 117) / 1024×512 ⇒ 方位 −2.405 rad・仰角 48.9°。
 * `gen4-environment.spec.ts` が環境マップから求め直して固定する。
 */
export const SUN_DIRECTION: readonly [number, number, number] = [-0.486, 0.754, -0.442];

/**
 * 空の階調とフォグの色を採る範囲（仰角）。
 *
 * `SKY_COLORS.PS2` と `gen4-ps2.ts` のフォグ色はここから実測した値であり、
 * `gen4-environment.spec.ts` が環境マップと突き合わせて固定する。
 */
export const SKY_SAMPLE = {
  /** 天頂側。`secondaryColor`（画面上端）に対応する */
  zenith: { from: 90 * DEG, to: 76 * DEG },
  /** 地平のすぐ上の霞。`color`（＝フォグ色）に対応する */
  haze: { from: 6 * DEG, to: 1 * DEG },
  /** 地平のすぐ下の地表。帯の下端を潰す色の元になる */
  ground: { from: -9 * DEG, to: -20 * DEG },
} as const;
