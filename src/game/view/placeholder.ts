import type { RenderFrame } from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import { fullScreenMinimapRect, pushMinimap } from './shared/minimap.js';
import { SKY_COLORS, generationValue } from './shared/variants.js';

/**
 * まだ専用ビューを持たない世代の暫定表示（フェーズ 1 の可視化そのもの）。
 *
 * 空とミニマップだけを画面いっぱいに出す。専用のデバッグ描画は作らず、
 * 本番のミニマップを大きな矩形で呼ぶだけにしてある。各世代のフェーズで
 * `view/index.ts` の割り当てを差し替えると、ミニマップは右下へ縮小配置される。
 */
export function buildPlaceholderView(frame: RenderFrame, context: ViewContext): void {
  const { generation, profile, state, display } = context;
  const sky = generationValue(SKY_COLORS, generation);

  frame.backgrounds.push({
    color: sky.bottom,
    secondaryColor: sky.top,
    generations: [generation],
  });

  pushMinimap(frame, {
    generation,
    profile,
    track: state.track,
    cars: display.cars,
    rect: fullScreenMinimapRect(profile),
    frameIndex: display.frameIndex,
  });
}
