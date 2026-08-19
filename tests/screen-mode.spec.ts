import {
  HARDWARE_GENERATION_PROFILES,
  createDeviceSnapshot,
  createRenderFrame,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { createRacingActionMap } from '../src/game/input/bindings.js';
import { buildGenerationView } from '../src/game/view/index.js';
import { createDisplayLatch } from '../src/game/view/shared/display-state.js';
import {
  DEFAULT_SCREEN_MODE,
  createScreenMode,
  screenModeLabel,
  screenModeOverride,
} from '../src/game/view/shared/screen-mode.js';
import { raceAfter } from './support/frame.js';

/**
 * 画面モード（実装計画 11-7 / R-7）。
 *
 * CRT は 1 本のシェーダ ＋ 7 つの uniform で、ここで作るのはその**上書きだけ**である。
 * 固定するのは 3 つ。
 *
 * 1. **既定の上書きが空**（初回起動の絵が今までと 1 画素も変わらない）
 * 2. フラット ON は樽型歪みだけを、モアレ OFF は画素周期の模様だけを消す。
 *    **他の項目には触れない** — 両方切っても にじみ・ブルーム・ビネット・ざらつきは素のまま
 * 3. 切り替えのキーがどの画面でも効く（世代切替と同じ扱い）
 */

const OTHERS = ['bleed', 'bloom', 'vignette', 'noise'] as const;

describe('画面モード', () => {
  it('既定は「いまの見え方」で、上書きは空', () => {
    expect(DEFAULT_SCREEN_MODE).toEqual({ flatDisplay: false, moire: true });
    expect(screenModeOverride(DEFAULT_SCREEN_MODE)).toEqual({});
    expect(createScreenMode().crtOverride()).toEqual({});
  });

  it('フラット ON は樽型歪みだけを 0 にする（D-14）', () => {
    expect(screenModeOverride({ flatDisplay: true, moire: true })).toEqual({ curvature: 0 });
  });

  it('モアレ OFF は蛍光体マスクと走査線を 0 にする（D-13）', () => {
    expect(screenModeOverride({ flatDisplay: false, moire: false })).toEqual({
      mask: 0,
      scanline: 0,
    });
  });

  it('4 通りのどれでも、触らない項目は上書きしない', () => {
    for (const flatDisplay of [false, true]) {
      for (const moire of [false, true]) {
        const override = screenModeOverride({ flatDisplay, moire }) as Record<string, number>;
        for (const key of OTHERS) {
          expect(override[key], `${key} を上書きしている`).toBeUndefined();
        }
        // 2 つは独立しているので、鍵の数は倒した設定の数から決まる
        const expected = (flatDisplay ? 1 : 0) + (moire ? 0 : 2);
        expect(Object.keys(override)).toHaveLength(expected);
      }
    }
  });

  it('倒すと値が変わり、もう一度倒すと戻る', () => {
    const mode = createScreenMode();
    mode.toggleFlatDisplay();
    expect(mode.flatDisplay).toBe(true);
    expect(mode.crtOverride()).toEqual({ curvature: 0 });

    mode.toggleMoire();
    expect(mode.moire).toBe(false);
    expect(mode.crtOverride()).toEqual({ curvature: 0, mask: 0, scanline: 0 });

    mode.toggleFlatDisplay();
    mode.toggleMoire();
    expect(mode.crtOverride()).toEqual({});
  });

  it('crtOverride は参照で渡しても動く（レンダラーが毎フレーム呼ぶ）', () => {
    const mode = createScreenMode();
    const read = mode.crtOverride;
    mode.toggleFlatDisplay();
    expect(read()).toEqual({ curvature: 0 });
  });

  describe('操作', () => {
    it('F / M が押せて、立ち上がりだけ真になる', () => {
      const actions = createRacingActionMap();
      const profile = HARDWARE_GENERATION_PROFILES.PS2;
      // 立ち上がりを見るので、押していない状態を 1 度通してから押す
      actions.sample(createDeviceSnapshot(), profile, 16);
      const pressed = actions.sample(createDeviceSnapshot(['KeyF', 'KeyM']), profile, 16);
      expect(pressed.toggleFlat.pressed).toBe(true);
      expect(pressed.toggleMoire.pressed).toBe(true);

      // 押しっぱなしでは 2 度目は立たない（連射にならない）
      const held = actions.sample(createDeviceSnapshot(['KeyF', 'KeyM']), profile, 16);
      expect(held.toggleFlat.pressed).toBe(false);
      expect(held.toggleMoire.pressed).toBe(false);
    });

    it('どの世代でも同じキーで効く（世代切替と同じ扱い）', () => {
      for (const generation of ['FC', 'SFC', 'PS1', 'PS2'] as const) {
        const actions = createRacingActionMap();
        const profile = HARDWARE_GENERATION_PROFILES[generation];
        actions.sample(createDeviceSnapshot(), profile, 16);
        const pressed = actions.sample(createDeviceSnapshot(['KeyF']), profile, 16);
        expect(pressed.toggleFlat.pressed, generation).toBe(true);
      }
    });
  });

  describe('現在値の表示', () => {
    it('文字にすると押せるキーと状態の両方が読める', () => {
      expect(screenModeLabel({ flatDisplay: false, moire: true })).toBe(
        'F FLAT OFF  M MOIRE ON',
      );
      expect(screenModeLabel({ flatDisplay: true, moire: false })).toBe(
        'F FLAT ON  M MOIRE OFF',
      );
    });

    it('ポーズ画面が画面モードの現在値を映す', () => {
      // ポーズ画面の 3 行目。設定画面は作らず（D-15）、押せるキーと状態をここに出す
      const rendered = (screenMode: { flatDisplay: boolean; moire: boolean }) => {
        const state = raceAfter(600);
        const profile = HARDWARE_GENERATION_PROFILES.PS2;
        const frame = createRenderFrame();
        buildGenerationView(frame, {
          generation: 'PS2',
          profile,
          state,
          display: createDisplayLatch().sample('PS2', profile, state),
          seconds: 10,
          renderedGenerations: 1,
          screen: 'racing',
          screenTicks: state.tick,
          paused: true,
          screenMode,
        });
        return frame.sprites.filter((sprite) => sprite.id.startsWith('screen-PS2-paused-'));
      };

      const off = rendered({ flatDisplay: false, moire: true });
      const on = rendered({ flatDisplay: true, moire: false });
      expect(off.length).toBeGreaterThan(0);
      // 文字が変わるので、字の数（＝スプライトの数）も変わる
      expect(on.map((sprite) => sprite.cell)).not.toEqual(off.map((sprite) => sprite.cell));
    });
  });
});
