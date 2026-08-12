import {
  HARDWARE_GENERATION_PROFILES,
  SCREEN_SAFE_AREA,
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
} from '@console-chaos/engine';

/**
 * ビュー層の世代差はすべてここに集める（エンジン README の推奨）。
 *
 * コード中に `if (generation === 'FC')` を書かない。ハードウェアの能力差は
 * `HardwareGenerationProfile` が、ゲーム固有の表現差はこのファイルの variant テーブルが持つ。
 */

/** 内部解像度の矩形。プロファイルから引くだけだが、ビューが毎回書くのは冗長なのでまとめる。 */
export interface ScreenRect {
  readonly width: number;
  readonly height: number;
}

export function screenOf(profile: HardwareGenerationProfile): ScreenRect {
  return { width: profile.video.internalWidth, height: profile.video.internalHeight };
}

/** オーバースキャンを避けた安全領域（内部解像度の画素）。HUD とミニマップはこの内側に置く。 */
export function safeAreaOf(profile: HardwareGenerationProfile) {
  const { width, height } = screenOf(profile);
  const inset = SCREEN_SAFE_AREA.overscan;
  return {
    left: Math.round(width * inset),
    top: Math.round(height * inset),
    width: Math.round(width * (1 - inset * 2)),
    height: Math.round(height * (1 - inset * 2)),
  };
}

/** 空と地平の色。世代が進むほど階調を増やす。 */
export const SKY_COLORS: GenerationVariant<{ top: string; bottom: string }> =
  defineGenerationVariant({
    FC: { top: '#5878f8', bottom: '#a4e4fc' },
    SFC: { top: '#3860c8', bottom: '#b8e8f8' },
    PS1: { top: '#20406c', bottom: '#88b4cc' },
    PS2: { top: '#1c3a68', bottom: '#a8cfe4' },
  });

/** 8 台の車体色。順位色ではなくエントラント固有色で、ミニマップと車体で共有する。 */
export const ENTRANT_COLORS: readonly string[] = [
  '#f8d800', // 0: 自機（黄）
  '#e83820', // 1
  '#3cbcfc', // 2
  '#58d854', // 3
  '#f878f8', // 4
  '#fc9838', // 5
  '#b8b8f8', // 6
  '#a44810', // 7
];

/** 自機のエントラント番号。シムとビューで共有する唯一の「特別扱い」。 */
export const PLAYER_ENTRANT = 0;

export function profileOf(generation: GenerationId): HardwareGenerationProfile {
  return HARDWARE_GENERATION_PROFILES[generation];
}

/**
 * `SpriteCommand` がその世代で描かれるか。
 *
 * **エンジン実測**: `createGenerationWebGlRenderer` はスプライト専用の
 * レンダーターゲットを、パレット量子化のある世代（`fixed54` / `rgb555`）にしか確保しない。
 * `truecolor` の PS1 / PS2 ではスプライトのパス自体が走らない。
 * 世代 ID ではなくこの能力で分岐する（`view/shared/billboard.ts` に代替手段）。
 */
export function supportsScreenSprites(profile: HardwareGenerationProfile): boolean {
  return profile.video.paletteMode !== 'truecolor';
}

export { defineGenerationVariant, generationValue };
export type { GenerationVariant };
