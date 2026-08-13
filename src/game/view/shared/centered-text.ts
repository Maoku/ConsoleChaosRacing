import type { HardwareGenerationProfile, SpriteCommand } from '@console-chaos/engine';

import { FONT_ATLAS, fontAdvance, measureText } from './font.js';
import type { TextStyle } from './hud.js';
import { floorToTile } from './quantize.js';
import { panelSprite, textSprites } from './text.js';
import type { ViewContext } from '../context.js';

/**
 * 画面中央に積む文字の塊（タイトル・カウントダウン・ポーズ・リザルトが共有する）。
 *
 * HUD が「隅に貼り付く 2 行」なのに対して、こちらは「真ん中に置く複数行」。
 * 世代差は `TEXT_STYLES` の 1 つの表から来るので、
 * このファイルには世代 ID の分岐が 1 つも無い。
 */

export interface CenteredLine {
  readonly text: string;
  /** 拡大率の倍率。`TextStyle.scale` に掛かる（見出しは 2〜5 倍） */
  readonly scale: number;
  /** 真なら `value` 色。偽なら `label` 色（FC はどちらも同じ） */
  readonly emphasis?: boolean;
  /** この行の上に空ける余白 [px]（`TextStyle.scale` 前） */
  readonly gapBefore?: number;
  /** 偽なら行ごと積まない。点滅する行に使う */
  readonly visible?: boolean;
}

export interface CenteredBlockOptions {
  readonly id: string;
  readonly context: ViewContext;
  readonly style: TextStyle;
  readonly lines: readonly CenteredLine[];
  /** 塊の上端 [px]。中央寄せは横だけで、縦は呼び出し側が決める */
  readonly top: number;
  /**
   * 背景パネルを敷くか。`TextStyle.panel` を持たない世代（FC）では
   * **不透明の**パネルになる — 半透明ではないので `translucency: none` に反しない。
   * 実機の FC も、文字を読ませたい場面では BG に単色の帯を置いていた
   */
  readonly panel?: boolean;
  readonly layer?: number;
}

/** FC でだけ使う、不透明パネルの色。半透明の世代は `TextStyle.panel.color` を使う */
const OPAQUE_PANEL = '#101018';

export interface CenteredBlock {
  readonly sprites: readonly SpriteCommand[];
  /** 文字の外形 [px]。次の塊をどこから始めるかの計算に使う */
  readonly top: number;
  readonly height: number;
}

function lineHeight(line: CenteredLine, style: TextStyle): number {
  return FONT_ATLAS.glyphHeight * line.scale * style.scale;
}

/**
 * パネルが文字の外へ広がる量 [px]。
 *
 * 世代の `padding` をそのまま使うと、パネルを持たない世代（FC）で 0 になり
 * 文字が帯の縁に貼り付く。下限を置いてある。
 */
export function centeredBlockPadding(style: TextStyle): number {
  return Math.max(4, style.padding * 2) * style.scale;
}

/**
 * 塊の高さ [px]（パネルの余白は含まない）。
 *
 * 積む前に高さを知りたい場所（タイトルの配置）が使う。
 * `centeredBlock` の中の計算と同じ式で、二重に持たない。
 */
export function centeredBlockHeight(
  lines: readonly CenteredLine[],
  style: TextStyle,
): number {
  let height = 0;
  for (const line of lines) {
    height += (line.gapBefore ?? 0) * style.scale + lineHeight(line, style);
  }
  return height;
}

/** 画面の横中央（タイル境界を持つ世代では境界へ丸める） */
export function screenCenterX(profile: HardwareGenerationProfile): number {
  return profile.video.internalWidth / 2;
}

export function centeredBlock(options: CenteredBlockOptions): CenteredBlock {
  const { context, style, lines } = options;
  const { generation, profile } = context;
  const advance = fontAdvance(profile.video.tileSnap);
  const layer = options.layer ?? 60;
  const centerX = screenCenterX(profile);

  // 行ごとの位置と幅を先に決める。パネルの寸法がこれで決まる
  const placed: { line: CenteredLine; left: number; top: number; width: number }[] = [];
  let cursor = options.top;
  for (const line of lines) {
    cursor += (line.gapBefore ?? 0) * style.scale;
    const width = measureText(line.text, line.scale * style.scale, advance);
    // 中央寄せしてからタイル境界へ丸める。丸めるのは左端 1 か所でよい
    // （字送りがタイルの一辺なので、左端が載れば全部の文字が載る）
    placed.push({ line, left: floorToTile(centerX - width / 2, profile), top: cursor, width });
    cursor += lineHeight(line, style);
  }

  const sprites: SpriteCommand[] = [];
  const height = cursor - options.top;

  if (options.panel && placed.length > 0) {
    const padding = centeredBlockPadding(style);
    const width = Math.max(...placed.map((entry) => entry.width));
    sprites.push(
      panelSprite({
        id: `screen-panel-${generation}-${options.id}`,
        generation,
        rect: {
          left: centerX - width / 2 - padding,
          top: options.top - padding,
          width: width + padding * 2,
          height: height + padding * 2,
        },
        color: style.panel?.color ?? OPAQUE_PANEL,
        layer: layer - 1,
        // 半透明を持たない世代へは `hardwareBlend` を渡さない（能力契約）
        ...(style.panel ? { hardwareBlend: style.panel.blend } : {}),
      }),
    );
  }

  placed.forEach((entry, index) => {
    if (entry.line.visible === false) return;
    for (const sprite of textSprites({
      id: `screen-${generation}-${options.id}-${index}`,
      text: entry.line.text,
      generation,
      profile,
      x: entry.left,
      y: entry.top,
      color: entry.line.emphasis === false ? style.label : style.value,
      scale: entry.line.scale * style.scale,
      shadow: style.shadow,
      layer,
    })) {
      sprites.push(sprite);
    }
  });

  return { sprites, top: options.top, height };
}
