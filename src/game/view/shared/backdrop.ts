import {
  defineGenerationVariant,
  generationValue,
  type BackgroundCommand,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
} from '@console-chaos/engine';

import type { RoadView } from './projection.js';

/**
 * 遠景のパララックス（実装計画 §3.2 / §3.3）。第1・第2世代が共用する。
 *
 * ## エンジンの実測から決まる制約
 *
 * `BackgroundCommand` には `parallax` という項があるが、**WebGL レンダラーは読まない**。
 * 実際に効くのは次の 4 つで、視差はゲーム側で `offset` に畳み込む必要がある。
 *
 * | 項 | 意味 |
 * | --- | --- |
 * | `repeat[0]`   | 画面幅が覆う U の量（0 以下なら層を描かない） |
 * | `offset[0]`   | U のずらし（＝横スクロール） |
 * | `placement.bottom + offset[1]` | 層の下端（画面下端からの比） |
 * | `placement.height` | 層の高さ（画面比） |
 *
 * 層は **2 枚まで**（遠景・近景）。テクスチャを持たない背景が 1 つだけ空の階調
 * （`color` が下端・`secondaryColor` が上端）と `brightness` を決める。
 *
 * ## 視差の量
 *
 * 遠方の物体は、視線が δ 回れば画面上を `δ · focal` 画素だけ流れる。
 * 画面 1 枚 = `repeat` ぶんの U なので、
 *
 *     ΔU = δ · focal · repeat / 画面幅
 *
 * `repeat` は画像 1 画素が画面 1 画素になる値を採る（第1世代なら 512 px の絵で 0.5）。
 * 拡大縮小が入らないぶん、量子化後の色が濁らない。
 */

/**
 * 遠景の層（実装計画 8-2）。**ビューと `tools/build-backdrop.mjs` が共有する。**
 *
 * 遠景も実機では BG 面に描かれ、8×8 タイル・**タイルあたり 16 色**のパレット割りに
 * 従っていた（§1.4 の `paletteBlockSize: 8` が意味を持つのはこの形のときだけ）。
 * 同梱の `coast.png` はタイルあたり最大 32 色・RGB555 の格子からも外れているので、
 * 第2世代では規約へ寄せた版を焼き、そちらを読む。
 *
 * 第1世代の遠景は同梱のまま使う。FC の BG は 2bpp ＝ **タイルあたり 4 色**で、
 * そこまで落とすと絵が成立しない。同時 25 色の契約（レンダラーが 54 色へ最近傍で
 * 丸める）は守れているので、タイル内の色数は `Docs/QUALITY_REVIEW.md` に
 * 実測値を記録するに留める。
 */
export interface BackdropTileGrid {
  readonly size: number;
  readonly maxColorsPerTile: number;
}

export interface BackdropLayout {
  /** 変換の入力（同梱アセット）。変換しない世代では `texture` と同じ */
  readonly source: string;
  /** 実行時に読む URL */
  readonly texture: string;
  readonly width: number;
  readonly height: number;
  /** BG 面としての制約。`null` なら同梱をそのまま使う */
  readonly tileGrid: BackdropTileGrid | null;
}

export const BACKDROPS: GenerationVariant<BackdropLayout | null> = defineGenerationVariant({
  FC: {
    source: 'assets/gen1/backgrounds/coast.png',
    texture: 'assets/gen1/backgrounds/coast.png',
    width: 512,
    height: 192,
    tileGrid: null,
  },
  SFC: {
    source: 'assets/gen2/backgrounds/coast.png',
    texture: 'assets/gen2/backgrounds/coast_bg.png',
    width: 512,
    height: 192,
    tileGrid: { size: 8, maxColorsPerTile: 16 },
  },
  // 3D の 2 世代は層ではなくフォグと環境マップの帯を使う（§3.4）
  PS1: null,
  PS2: null,
});

export function backdropFor(generation: GenerationId): BackdropLayout | null {
  return generationValue(BACKDROPS, generation);
}

export interface BackdropOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  readonly view: RoadView;
  readonly texture: string;
  /** 遠景画像の画素幅。`repeat` を 1:1 にするために要る */
  readonly textureWidth: number;
  /** 遠景画像の画素高さ */
  readonly textureHeight: number;
  /** 空の階調 */
  readonly sky: { readonly top: string; readonly bottom: string };
  /** カメラの向き [rad]。コースの接線を使う（車のヨーでは回さない） */
  readonly heading: number;
  /** 標高のうねりを見る前方距離 [m] */
  readonly elevationReference?: number;
}

/** 地平線の上下動の上限（画面比）。これ以上振ると層の下端が路面から浮く */
const MAX_ELEVATION_SHIFT = 0.03;

/**
 * 空 ＋ 遠景 1 層。積む順がそのまま `uFar` / `uNear` の割り当てになるので、
 * **テクスチャを持たない空を先に積む**。
 */
export function backdropCommands(options: BackdropOptions): BackgroundCommand[] {
  const { generation, profile, view, sky } = options;
  const screenWidth = profile.video.internalWidth;
  const screenHeight = profile.video.internalHeight;
  const snap = Math.max(1, profile.video.tileSnap);

  // 画像 1 画素 = 画面 1 画素にする
  const repeat = screenWidth / options.textureWidth;

  // 視線が回った量をそのまま横スクロールへ。tileSnap を持つ世代（FC）では
  // 画面 8 px 単位に丸める（能力契約 §1.4。背景は BG 面なのでタイル境界に載る）
  const scrollPixels = options.heading * view.camera.focal;
  const snappedPixels = Math.round(scrollPixels / snap) * snap;
  const scrolled = snappedPixels / options.textureWidth;
  const offsetX = scrolled - Math.floor(scrolled);

  // 標高。前方の路面が高ければ地平線は画面の上へ寄る
  const reference = options.elevationReference ?? Math.min(80, view.maxDistance * 0.8);
  const rise = view.rowAtDistance(reference) - view.camera.horizonRow;
  const flat = (view.camera.cameraHeight * view.camera.focal) / reference;
  const shiftRows = flat - rise;
  const offsetY = Math.max(
    -MAX_ELEVATION_SHIFT,
    Math.min(MAX_ELEVATION_SHIFT, shiftRows / screenHeight),
  );

  // 層の下端は路面帯の上端より少しだけ下に置く。標高で上下しても
  // 層の下と路面の間に空の隙間ができない
  const bottom = (screenHeight - view.camera.roadTopRow - 2) / screenHeight;

  return [
    {
      color: sky.bottom,
      secondaryColor: sky.top,
      generations: [generation],
    },
    {
      color: sky.bottom,
      texture: options.texture,
      repeat: [repeat, 1],
      offset: [offsetX, offsetY],
      placement: { bottom, height: options.textureHeight / screenHeight },
      generations: [generation],
    },
  ];
}
