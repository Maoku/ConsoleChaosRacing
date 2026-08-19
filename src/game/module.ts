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
import { anyInputIn, createAttract, stepAttract } from './flow/attract.js';
import { acceptsDriving, createFlow, stepFlow } from './flow/screens.js';
import { createRacingActionMap, requestedGeneration } from './input/bindings.js';
import { topSpeedOf, type VehicleControl } from './sim/vehicle.js';
import { buildGenerationView } from './view/index.js';
import { cycleCameraView, type CameraViewId } from './view/shared/camera.js';
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
    /**
     * タイトルのアトラクト（11-6）。無操作 5 秒で世代の巡回が始まり、
     * 以後 5 秒ごとに次の世代へ移る。状態は 2 つの数だけで、
     * 「そろそろ次へ」と言うのが `stepAttract()` の役目である
     */
    const attract = createAttract();
    const display = createDisplayLatch();
    let seconds = 0;
    /**
     * 視点（8-5）。**「見た目のためだけの状態」**（§2.1）なのでここが持ち、
     * シムへは一切渡さない。世代を切り替えたとき、移った先に無い視点なら
     * 各ビューが `resolveCameraView()` で追走視点へ落とす
     */
    let cameraView: CameraViewId = 'chase';

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
        // 世代切替はどの画面でも効く。状態機械は世代を知らない（§6.1 世代横断 4）。
        // 順送り（Q / E）と、チャンネルを選ぶように跳ぶ直接指定（1〜4）の 2 通り。
        // どちらも同じ経路を通るので、切替演出も BGM の位相保存も追加のコストが無い
        if (input.genNext.pressed) context.generation.cycle(1);
        if (input.genPrev.pressed) context.generation.cycle(-1);

        // タイトルの放置で世代を巡回する（11-6）。**手動の Q / E と同じ経路**を通るので、
        // 切替演出も BGM の位相保存も追加のコストが無い。操作があれば即座に抜ける
        if (
          stepAttract(attract, {
            screen: flow.screen,
            anyInput: anyInputIn(context.input.snapshot),
          })
        ) {
          context.generation.cycle(1);
        }
        const requested = requestedGeneration(input);
        // 表示中の世代を要求しても `request()` が偽を返すだけで演出は起きない
        if (requested) context.generation.request(requested);

        // 視点の切り替え（8-5）。視点が 1 つしか無い世代では押しても変わらない
        if (input.viewCycle.pressed) {
          cameraView = cycleCameraView(context.generation.generation, cameraView);
        }

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
          maxSpeed: topSpeedOf(player),
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
            cameraView,
          });
        }
      },

      dispose() {
        unsubscribeSwitch();
      },
    };
  },
};
