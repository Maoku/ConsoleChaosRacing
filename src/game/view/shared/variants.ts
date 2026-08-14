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

/**
 * 空と地平の色。世代が進むほど階調を増やす。
 *
 * 第4世代だけは**環境マップから実測した値**を置く（`tools/build-skyline.mjs` が
 * 表示する）。空・遠景の帯・車への映り込みが 1 枚の絵から出ていることが
 * §6.1 第4世代基準 2 の要求であり、色が食い違うと地平線で境目が見える。
 * `gen4-environment.spec.ts` が環境マップと突き合わせて固定する。
 */
export const SKY_COLORS: GenerationVariant<{ top: string; bottom: string }> =
  defineGenerationVariant({
    FC: { top: '#5878f8', bottom: '#a4e4fc' },
    SFC: { top: '#3860c8', bottom: '#b8e8f8' },
    PS1: { top: '#20406c', bottom: '#88b4cc' },
    PS2: { top: '#2c69cd', bottom: '#8abdcf' },
  });

/**
 * 8 台のエントラント色。**色相を均等に散らしてある。**
 *
 * ミニマップのマーカーと 3D の車体リバリー（`tools/build-car-liveries.mjs`）が
 * この 1 つの表を共有するので、マップ上の色と実車の色が必ず一致する。
 * 近い色相を 2 つ置くと 320×240 では見分けが付かなくなるため、
 * ここを触るときは色相の間隔を保つこと。
 */
export const ENTRANT_COLORS: readonly string[] = [
  '#f8d800', // 0: 自機（黄・色相 52°）
  '#e83820', // 1: 赤 8°
  '#fc9838', // 2: 橙 30°
  '#58d854', // 3: 緑 118°
  '#20c0a0', // 4: 青緑 168°
  '#3cbcfc', // 5: 空 200°
  '#6060f0', // 6: 青 240°
  '#f878f8', // 7: 桃 300°
];

/** 自機のエントラント番号。シムとビューで共有する唯一の「特別扱い」。 */
export const PLAYER_ENTRANT = 0;

/**
 * `'#rrggbb'` → 0..1 の三つ組。
 *
 * コマンドの色は文字列で書けるが、`HardwareBlendCommand` の `fixedColor`
 * （第2世代の固定色 color math）だけは 0..1 の数値で渡す決まりになっている。
 */
export function rgb01(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** 数値の線形補間。トンネルの出入りで照明を混ぜるのに使う（8-9） */
export function mixNumber(from: number, to: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return from + (to - from) * k;
}

/**
 * `'#rrggbb'` どうしの線形補間。
 *
 * **色を混ぜるのはコマンドを積む前だけ**にする。レンダラーへ渡す時点では
 * いつもどおりの 1 つの色であり、「混ぜている最中」という状態はどこにも残らない。
 */
export function mixColor(from: string, to: string, t: number): string {
  const channel = (offset: number) => {
    const a = Number.parseInt(from.slice(offset, offset + 2), 16);
    const b = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(mixNumber(a, b, t))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

export function profileOf(generation: GenerationId): HardwareGenerationProfile {
  return HARDWARE_GENERATION_PROFILES[generation];
}

/**
 * 半透明合成が使えるか（能力契約 `translucency`）。
 *
 * エンジン 0.2.0 で `profile.video.translucency` が入り、世代ごとに
 * 「どういう半透明か」まで表現できるようになった。FC は `kind: 'none'` なので、
 * 半透明のコマンドを積まないこと自体がゲーム側の責務になる。
 * `alphaBlend` は互換用の真偽値であり、新しいコードはこちらを見る。
 */
export function supportsTranslucency(profile: HardwareGenerationProfile): boolean {
  return profile.video.translucency.kind !== 'none';
}

/**
 * スプライトがシーンへ統合されるか（`separate-plane` か `scene` か）。
 *
 * 0.2.0 で PS1 / PS2 のスプライトが ordering table 経由でシーンへ入り、
 * **4 世代すべてで `SpriteCommand` が描かれる**ようになった。この関数は分岐のためではなく、
 * 「スプライト面がメッシュと同じ順序表に乗るか」を知りたい場所（走査線制限・重ね順）で使う。
 */
export function spritesComposeIntoScene(profile: HardwareGenerationProfile): boolean {
  return profile.video.spriteComposition === 'scene';
}

export { defineGenerationVariant, generationValue };
export type { GenerationVariant };
