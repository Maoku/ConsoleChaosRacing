import {
  applyScanlineLimit,
  type Entity,
  type HardwareGenerationProfile,
  type RenderFrame,
  type SpriteCommand,
} from '@console-chaos/engine';

/**
 * スプライト面の組み立て（実装計画 §1.4 / §3.2 / §3.6）。擬似3D世代が共用する。
 *
 * 実機のスプライトには 2 つの決まりがあり、どちらも**エンジンは自動で守らない**。
 *
 * 1. **走査線あたりの上限**（FC は 8・SFC は 32）。超えた分は消える。
 *    `applyScanlineLimit` は登録順に受け付けるので、**消えてほしくないものを先に登録する**。
 * 2. **番号が若いほど優先度が高く、かつ手前に出る**。エンジンは後に積んだものを
 *    手前に描くので、**登録順とは逆に積む**。
 *
 * 枠や HUD の文字は実機では BG タイル面に描かれ、スプライト枠を消費しなかった。
 * `background` / `foreground` はその扱い — どちらも制限の対象外で、
 * 前者は最背面、後者は最前面に積む。実機の BG 面もスプライトの前後どちらにも置けた
 * （優先度ビット）ので、ミニマップの枠は背面・HUD の文字は前面、という分け方になる。
 */

export interface SpriteEntry {
  /** 走査線制限で落ちたときに記録される識別子。当たり判定を持たないものは `NO_ENTITY` */
  readonly entity: Entity;
  /** 絵のある範囲の上端 [px] */
  readonly y: number;
  /** 絵のある範囲の高さ [px] */
  readonly height: number;
  /** この 1 件を構成するスプライト（影・縁を含む）。落ちるときはまとめて落ちる */
  readonly sprites: readonly SpriteCommand[];
}

export interface SpritePlaneOptions {
  readonly profile: HardwareGenerationProfile;
  /** 登録順＝優先度。自機を必ず先頭に置く */
  readonly entries: readonly SpriteEntry[];
  /** BG 相当。制限の対象外で最背面に積む */
  readonly background?: readonly SpriteCommand[];
  /** BG 相当（優先度つき）。制限の対象外で最前面に積む。HUD の文字がこれ */
  readonly foreground?: readonly SpriteCommand[];
}

/** 走査線制限を適用してフレームへ積む。戻り値は制限で落ちたエントラント */
export function pushSpritePlane(
  frame: RenderFrame,
  options: SpritePlaneOptions,
): readonly Entity[] {
  const { profile, entries } = options;
  const limited = applyScanlineLimit(
    entries,
    profile.video.spritesPerScanline,
    profile.video.internalHeight,
  );

  for (const sprite of options.background ?? []) frame.sprites.push(sprite);
  for (let index = limited.visible.length - 1; index >= 0; index--) {
    for (const sprite of limited.visible[index]!.sprites) frame.sprites.push(sprite);
  }
  for (const sprite of options.foreground ?? []) frame.sprites.push(sprite);

  return limited.culled;
}
