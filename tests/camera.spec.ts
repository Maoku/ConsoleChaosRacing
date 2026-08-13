import { GENERATION_IDS, type GenerationId } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { hashRaceState } from '../src/game/sim/state.js';
import {
  CAMERA_VIEWS,
  cameraViewsFor,
  cycleCameraView,
  hidesPlayerCar,
  resolveCameraView,
  type CameraViewId,
} from '../src/game/view/shared/camera.js';
import { COCKPIT_ATLAS, WHEEL_ATLAS, cockpitAvailable } from '../src/game/view/shared/cockpit.js';
import { PLAYER_ENTRANT } from '../src/game/view/shared/variants.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 視点の切り替え（実装計画 8-5）。
 *
 * 視点は**「見た目のためだけの状態」**（§2.1）であり、シムへは一切渡らない。
 * ここで固定するのは 4 つ。
 *
 * 1. 世代ごとの視点リストが表のとおり（内装は第4世代だけ）
 * 2. 車内からの視点では**自機のメッシュも、その影も** 1 つも積まれない
 * 3. 目線が常に路面より上にある（路面へ潜らない）
 * 4. 視点を変えてもレースの状態が 1 ビットも変わらない
 */

const VIEW_LIST: Record<GenerationId, readonly CameraViewId[]> = {
  FC: ['chase'],
  SFC: ['chase'],
  PS1: ['chase', 'windshield'],
  PS2: ['chase', 'windshield', 'cockpit'],
};

describe('視点', () => {
  it('世代ごとの視点リストが定義どおり', () => {
    for (const generation of GENERATION_IDS) {
      expect(cameraViewsFor(generation), generation).toEqual(VIEW_LIST[generation]);
      expect(CAMERA_VIEWS[generation]![0]).toBe('chase');
    }
  });

  it('その世代に無い視点は追走視点へ落ちる', () => {
    // 世代を切り替えたときの受け皿。切替演出中の 2 世代でも、
    // 各ビューは自分の世代のリストだけを見る
    expect(resolveCameraView('PS1', 'cockpit')).toBe('chase');
    expect(resolveCameraView('FC', 'windshield')).toBe('chase');
    expect(resolveCameraView('PS2', 'cockpit')).toBe('cockpit');
  });

  it('視点は世代のリストの中を巡回する', () => {
    expect(cycleCameraView('PS2', 'chase')).toBe('windshield');
    expect(cycleCameraView('PS2', 'windshield')).toBe('cockpit');
    expect(cycleCameraView('PS2', 'cockpit')).toBe('chase');
    expect(cycleCameraView('PS1', 'windshield')).toBe('chase');
    // 視点が 1 つしか無い世代では押しても何も起きない
    expect(cycleCameraView('FC', 'chase')).toBe('chase');
    // 無い視点を持ったまま移ってきても、巡回はその世代のリストの中で閉じる
    expect(cycleCameraView('PS1', 'cockpit')).toBe('windshield');
  });

  it('内装があるのは第4世代だけ', () => {
    expect(GENERATION_IDS.filter((generation) => cockpitAvailable(generation))).toEqual(['PS2']);
    // 内装は画面と同じ縦横比で焼く（全面へ 1 枚で貼るため）
    expect(COCKPIT_ATLAS.width / COCKPIT_ATLAS.height).toBeCloseTo(640 / 448, 6);
    // ステアリングは正方形。回転がスプライトの中心に掛かるので軸がずれない
    expect(WHEEL_ATLAS.columns * WHEEL_ATLAS.rows).toBe(1);
  });

  for (const generation of ['PS1', 'PS2'] as const) {
    describe(generation, () => {
      const state = raceAfter(900);

      for (const view of VIEW_LIST[generation]) {
        it(`${view}: 目線が路面より上にある`, () => {
          const frame = buildFrame(generation, state, 10, 1, 'racing', view);
          const player = state.cars[PLAYER_ENTRANT]!;
          const road = state.track.toWorld(player.s, player.lateral)[1];
          expect(frame.camera!.position[1]).toBeGreaterThan(road);
          expect(frame.camera!.projection).toBe('perspective');
        });

        it(`${view}: 自機のメッシュと影の有無が視点と一致する`, () => {
          const frame = buildFrame(generation, state, 10, 1, 'racing', view);
          const ids = frame.meshes.map((mesh) => mesh.id);
          const hidden = hidesPlayerCar(view);
          expect(ids.includes(`car-${generation}-${PLAYER_ENTRANT}`)).toBe(!hidden);
          expect(ids.includes(`car-shadow-${generation}-${PLAYER_ENTRANT}`)).toBe(
            !hidden && generation === 'PS2',
          );
          // ライバルは視点によらず描かれる
          expect(ids.some((id) => /^car-(PS1|PS2)-[1-7]$/.test(id))).toBe(true);
        });
      }

      it('内装のスプライトは cockpit のときだけ積まれる', () => {
        for (const view of VIEW_LIST[generation]) {
          const frame = buildFrame(generation, state, 10, 1, 'racing', view);
          const cockpit = frame.sprites.filter((sprite) => sprite.id.startsWith('cockpit-'));
          expect(cockpit.length, `${generation}/${view}`).toBe(view === 'cockpit' ? 2 : 0);
        }
      });
    });
  }

  it('視点を切り替えてもレースの状態は 1 ビットも変わらない', () => {
    // ビューは `RaceState` を読むだけ（§2.1）。視点はシムへ渡らない
    const state = raceAfter(900);
    const before = hashRaceState(state);
    for (const generation of GENERATION_IDS) {
      for (const view of cameraViewsFor(generation)) {
        buildFrame(generation, state, 10, 1, 'racing', view);
      }
    }
    expect(hashRaceState(state)).toBe(before);
  });
});
