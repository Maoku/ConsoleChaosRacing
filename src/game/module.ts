import {
  FIXED_DT_SECONDS,
  type GameContext,
  type GameInstance,
  type GameModule,
  type RenderFrame,
} from '@console-chaos/engine';

import { createRacingActionMap } from './input/bindings.js';
import { stepRace } from './sim/race.js';
import { createRaceState } from './sim/state.js';
import type { VehicleControl } from './sim/vehicle.js';
import { fullScreenMinimapRect, pushMinimap } from './view/shared/minimap.js';
import { quantizedFrame } from './view/shared/quantize.js';
import { SKY_COLORS, generationValue, profileOf } from './view/shared/variants.js';

/**
 * ゲームモジュール（実装計画 §2.4）。
 *
 * フェーズ 1 の時点では、シムの可視化はミニマップだけ。専用のデバッグ描画は作らず、
 * 本番のミニマップを画面いっぱいに出して 8 台の走りを確認する。
 * 以降のフェーズで各世代のビューを足し、ミニマップは右下へ縮小配置する。
 */
export const racingModule: GameModule = {
  id: 'console-chaos-racing',
  async create(context: GameContext): Promise<GameInstance> {
    const actions = createRacingActionMap();
    // タイトル画面が入るまでは、起動直後から AI 8 台のレースを回す
    const race = createRaceState({ autoPilot: true });
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

        // 自機の操作。autoPilot が真の間は無視される
        const control: VehicleControl = {
          steer: input.steer,
          throttle: input.throttle.value,
          brake: input.brake.value,
        };
        if (race.autoPilot && (input.throttle.pressed || input.brake.pressed)) {
          race.autoPilot = false;
        }

        stepRace(race, control);
      },

      buildRenderFrame(frame: RenderFrame) {
        frame.timeSeconds = seconds;

        // フェーズ 1 のカメラは仮。世代別ビューが入るまでは何も映さない
        frame.camera = {
          projection: 'perspective',
          position: [0, 2, 8],
          target: [0, 2, 0],
          zoom: 8,
          fovDegrees: 60,
        };

        // 切替中は 2 世代ぶんのコマンドを積む。シムは 1 つのまま
        for (const generation of context.generation.renderGenerations()) {
          const profile = profileOf(generation);
          const sky = generationValue(SKY_COLORS, generation);

          frame.backgrounds.push({
            color: sky.bottom,
            secondaryColor: sky.top,
            generations: [generation],
          });

          pushMinimap(frame, {
            generation,
            profile,
            state: race,
            rect: fullScreenMinimapRect(profile),
            frameIndex: quantizedFrame(seconds, profile),
          });
        }
      },

      dispose() {},
    };
  },
};
