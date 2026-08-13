import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  type GenerationId,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { hashRaceState } from '../src/game/sim/state.js';
import {
  CAMERA,
  CAMERA_VIEWS,
  cameraViewsFor,
  cycleCameraView,
  followLateral,
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

  /**
   * **コースアウトしても自機が画面に残る**こと。
   *
   * 追従率だけでカメラの横位置を作ると、遅れが横位置に比例して伸びるので、
   * 路面から大きく外れたときに自機が画面の外へ流れる。`followLateral()` の
   * 遅れの上限がそれを止めている。ここでは実際に**カメラ行列で投影して**確かめる。
   */
  describe('コースアウト時の追従', () => {
    /**
     * 自機の中心が収まっていてほしい範囲（NDC。画面は [-1, 1]）。
     *
     * 画面の中にあるだけでなく、**縁から十分内側**にあることまで見る。
     * 上限に張り付いたときの中心は 0.31 前後（実測）で、車体の幅を足しても
     * 画面の内側に収まる。ミニマップ（右下）とは横に少し重なるが、
     * パネルは半透明なので車は読める — 重なりを完全に無くすには追従の遅れを
     * 0.5 m まで詰める必要があり、コーナーで膨らむ見え方が消えてしまう。
     */
    const CAR_INSIDE_NDC = 0.6;

    /** ワールド座標 → NDC。`CameraCommand` から view・projection を組んで掛ける */
    function project(
      camera: { position: readonly number[]; target: readonly number[]; fovDegrees?: number },
      point: readonly [number, number, number],
      aspect: number,
    ): [number, number] {
      const forward = [
        camera.target[0]! - camera.position[0]!,
        camera.target[1]! - camera.position[1]!,
        camera.target[2]! - camera.position[2]!,
      ];
      const length = Math.hypot(...forward);
      const f = forward.map((value) => value / length) as [number, number, number];
      // right = forward × up、up = right × forward（up は +Y）
      const right = [f[2], 0, -f[0]];
      const rightLength = Math.hypot(right[0]!, right[2]!);
      const r: [number, number, number] = [right[0]! / rightLength, 0, right[2]! / rightLength];
      const u: [number, number, number] = [
        r[1] * f[2] - r[2] * f[1],
        r[2] * f[0] - r[0] * f[2],
        r[0] * f[1] - r[1] * f[0],
      ];
      const d: [number, number, number] = [
        point[0] - camera.position[0]!,
        point[1] - camera.position[1]!,
        point[2] - camera.position[2]!,
      ];
      const viewX = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
      const viewY = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
      const viewZ = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      const halfTan = Math.tan((((camera.fovDegrees ?? 60) * Math.PI) / 180) / 2);
      // viewZ が正 ＝ カメラの前
      return [viewX / (viewZ * halfTan * aspect), viewY / (viewZ * halfTan)];
    }

    for (const generation of ['PS1', 'PS2'] as const) {
      it(`${generation}: 路面の外へ出ても自機が画面の中に残る`, () => {
        const profile = HARDWARE_GENERATION_PROFILES[generation];
        const aspect = profile.video.internalWidth / profile.video.internalHeight;
        const state = raceAfter(900);
        const player = state.cars[PLAYER_ENTRANT]!;

        // 路面（半幅 6 m）の内側から、走れる限界の外側まで
        for (const lateral of [0, 3, 6, -6, 10, -10, 15, -15]) {
          player.lateral = lateral;
          const frame = buildFrame(generation, state, 10, 1, 'racing', 'chase');
          const camera = frame.camera!;

          const car = state.track.toWorld(player.s, lateral);
          const [ndcX, ndcY] = project(camera, [car[0], car[1] + 0.5, car[2]], aspect);
          const where = `lateral ${lateral} m`;
          expect(Math.abs(ndcX), `${where} の横`).toBeLessThan(CAR_INSIDE_NDC);
          expect(Math.abs(ndcY), `${where} の縦`).toBeLessThan(CAR_INSIDE_NDC);
        }
      });
    }

    it('路面の内側では遅れの上限に当たらない（コーナーで膨らむ見え方が残る）', () => {
      // 上限に当たり始めるのは |lateral| > 2.7 m（走行ラインの振れ幅の外側）
      for (const lateral of [0, 1.5, 2.6, -2.6]) {
        expect(followLateral(lateral, CAMERA.LATERAL_FOLLOW, CAMERA.LATERAL_LAG_MAX)).toBeCloseTo(
          lateral * CAMERA.LATERAL_FOLLOW,
          9,
        );
      }
      // 大きく外れると上限で切られ、自機との差が広がらなくなる
      for (const lateral of [15, 40]) {
        const gap = lateral - followLateral(lateral, CAMERA.LATERAL_FOLLOW, CAMERA.LATERAL_LAG_MAX);
        expect(gap).toBeCloseTo(CAMERA.LATERAL_LAG_MAX, 9);
      }
    });
  });

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
