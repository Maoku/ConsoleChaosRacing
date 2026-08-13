import {
  FIXED_DT_SECONDS,
  type GameContext,
  type GameInstance,
  type GameModule,
  type RenderFrame,
} from '@console-chaos/engine';

import { createEngineVoiceScheduler } from './audio/engine-sound.js';
import { arrangementFor } from './audio/score.js';
import { createRaceSfx } from './audio/sfx.js';
import { acceptsDriving, createFlow, stepFlow } from './flow/screens.js';
import { createRacingActionMap } from './input/bindings.js';
import { VEHICLE, type VehicleControl } from './sim/vehicle.js';
import { buildGenerationView } from './view/index.js';
import { createDisplayLatch } from './view/shared/display-state.js';
import { PLAYER_ENTRANT, profileOf } from './view/shared/variants.js';

/**
 * ゲームモジュール（実装計画 §2.4）。
 *
 * ここがやるのは 3 つだけ — 入力を取り、状態機械を 1 ティック進め、
 * 描画する世代のぶんだけビューを呼ぶ。世代ごとの表現は `view/index.ts` の
 * 割り当てテーブルの向こう側にあり、画面ごとの進行は `flow/screens.ts` にある。
 */
export const racingModule: GameModule = {
  id: 'console-chaos-racing',
  async create(context: GameContext): Promise<GameInstance> {
    const actions = createRacingActionMap();
    const flow = createFlow();
    const display = createDisplayLatch();
    let seconds = 0;

    if (import.meta.env.DEV) {
      // 開発時の手動検証用。カウントダウンやリザルトの画面は 3 周走らないと出ないので、
      // コンソールから `racingFlow.screen = 'result'` のように飛べるようにしておく
      // （フェーズ 8 のスクリーンショット採取でも使う）
      (globalThis as unknown as { racingFlow?: unknown }).racingFlow = flow;
    }

    // ── 音（実装計画 §4）。曲は 1 つで、世代が変わっても位相は保たれる。
    // 音源の差し替えは `GameHost` が `onSwitch` で自動的に行うので、
    // ゲーム側がやるのは**編曲の差し替えだけ**である
    const engineSound = createEngineVoiceScheduler();
    const sfx = createRaceSfx();
    context.audio.playScore(arrangementFor(context.generation.generation));
    const unsubscribeSwitch = context.generation.onSwitch((event) => {
      context.audio.useScore(arrangementFor(event.to));
    });

    return {
      fixedUpdate() {
        seconds += FIXED_DT_SECONDS;

        const input = actions.sample(
          context.input.snapshot,
          context.generation.profile,
          FIXED_DT_SECONDS * 1000,
        );
        // 世代切替はどの画面でも効く。状態機械は世代を知らない（§6.1 世代横断 4）
        if (input.genNext.pressed) context.generation.cycle(1);
        if (input.genPrev.pressed) context.generation.cycle(-1);

        const control: VehicleControl = {
          steer: input.steer,
          throttle: input.throttle.value,
          brake: input.brake.value,
        };
        const transition = stepFlow(flow, {
          control,
          confirm: input.confirm.pressed,
          back: input.back.pressed,
          pause: input.pause.pressed,
        });
        // レースを作り直したら、立ち上がりで鳴らす音の記憶も畳む
        if (transition?.raceRestarted) sfx.reset();

        // 音はシムの後。エンジン音は自機の状態から、効果音は立ち上がりから決まる。
        // どちらも `AudioContext` の時計で先読みするので、描画が落ちても乱れない。
        // ポーズ中とリザルト中はスロットルを 0 として扱い、エンジン音を落ち着かせる
        const player = flow.race.cars[PLAYER_ENTRANT]!;
        const driving = acceptsDriving(flow.screen) && !flow.paused;
        engineSound.update(context.audio, context.generation.profile, {
          speed: player.speed,
          maxSpeed: VEHICLE.MAX_SPEED,
          throttle: driving ? player.throttleInput : 0,
          offTrack: player.offTrack,
        });
        sfx.update(context.audio, context.generation.profile, flow.race);
      },

      buildRenderFrame(frame: RenderFrame) {
        frame.timeSeconds = seconds;

        // 切替中は 2 世代ぶんのコマンドを積む。シムは 1 つのまま。
        // ラッチも世代ごとに持つので、それぞれが自分の更新レートで止まって見える
        const generations = context.generation.renderGenerations();
        for (const generation of generations) {
          const profile = profileOf(generation);
          buildGenerationView(frame, {
            generation,
            profile,
            state: flow.race,
            display: display.sample(generation, profile, flow.race),
            seconds,
            renderedGenerations: generations.length,
            screen: flow.screen,
            screenTicks: flow.screenTicks,
            paused: flow.paused,
          });
        }
      },

      dispose() {
        unsubscribeSwitch();
      },
    };
  },
};
