import {
  FIXED_DT_SECONDS,
  type GameContext,
  type GameInstance,
  type GameModule,
  type RenderFrame,
} from '@console-chaos/engine';

import { createRacingActionMap } from './input/bindings.js';
import { quantizeTime } from './view/shared/quantize.js';
import { SKY_COLORS, generationValue } from './view/shared/variants.js';

/**
 * フェーズ 0 の最小モジュール。
 *
 * 4 世代とも背景と 1 個の箱を出し、Q/E で世代が切り替わって CRT の質感が変わることだけを
 * 確認する。シミュレーションはフェーズ 1 で入れ替える。
 */
export const racingModule: GameModule = {
  id: 'console-chaos-racing',
  async create(context: GameContext): Promise<GameInstance> {
    const actions = createRacingActionMap();
    let seconds = 0;

    return {
      fixedUpdate() {
        seconds += FIXED_DT_SECONDS;
        const input = actions.sample(
          context.input.snapshot,
          context.generation.profile,
          FIXED_DT_SECONDS * 1000,
        );
        if (input.genNext.pressed) context.generation.cycle(1);
        if (input.genPrev.pressed) context.generation.cycle(-1);
      },

      buildRenderFrame(frame: RenderFrame) {
        frame.timeSeconds = seconds;
        // 切替中は 2 世代分のコマンドが要る。積む内容は世代で変えず、
        // 見え方の差はレンダラーのプロファイルに任せる。
        for (const generation of context.generation.renderGenerations()) {
          const sky = generationValue(SKY_COLORS, generation);
          const profile = context.generation.profile;
          const shown = quantizeTime(seconds, profile);

          frame.backgrounds.push({
            color: sky.bottom,
            secondaryColor: sky.top,
            generations: [generation],
          });
          frame.materials.push({
            id: `probe-${generation}`,
            color: '#f8d800',
            generations: [generation],
          });
          frame.meshes.push({
            id: `probe-${generation}`,
            geometry: { kind: 'box', halfExtents: [0.5, 0.5, 0.5] },
            transform: {
              position: [Math.sin(shown) * 2, 0, 0],
              rotationY: shown * 0.8,
            },
            color: '#f8d800',
            material: `probe-${generation}`,
            generations: [generation],
          });
        }

        frame.camera = {
          projection: 'perspective',
          position: [0, 2.2, 6],
          target: [0, 0, 0],
          zoom: 6,
          fovDegrees: 60,
        };
      },

      dispose() {},
    };
  },
};
