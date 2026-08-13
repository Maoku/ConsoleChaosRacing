import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  applyScanlineLimit,
  generationSupportsHardwareBlend,
  type GenerationId,
  type RenderFrame,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 能力契約（実装計画 §1.4 / §6.2 `capability-contract.spec.ts`）。
 *
 * レンダラーが**自動では強制しない**約束を、コマンド列の段階で検査する。
 * 守らなくても例外にならず、ただ「その世代らしくない画」になるだけなので、
 * 目視では気付けない。ここが唯一の歯止めになる。
 */

const MOMENTS = [60, 900, 1500, 3600];

/** その世代のフレームに積まれた、`hardwareBlend` を持ちうるコマンドをすべて集める */
function blendableCommands(frame: RenderFrame) {
  return [...frame.sprites, ...frame.materials, ...frame.meshes];
}

/**
 * 実機で BG タイル面に描かれていたもの（ミニマップの枠・HUD の文字とパネル）。
 *
 * これらはスプライト枠を消費しなかったので、`applyScanlineLimit` の対象外に置いてある
 * （実装計画 §3.6 の決定）。本エンジンにはタイル面の API が無いためスプライトで
 * 代用しているだけで、走査線あたりの上限を数えるときは除く。
 */
function isBackgroundPlane(id: string): boolean {
  return id.startsWith('minimap-panel') || id.startsWith('hud-');
}

describe('能力契約', () => {
  describe('半透明（translucency）', () => {
    for (const generation of GENERATION_IDS) {
      it(`${generation}: hardwareBlend が世代の作法と食い違わない`, () => {
        for (const ticks of MOMENTS) {
          const frame = buildFrame(generation, raceAfter(ticks));
          for (const command of blendableCommands(frame)) {
            const blend = (command as { hardwareBlend?: unknown }).hardwareBlend;
            if (!blend) continue;
            // レンダラーは assertHardwareBlendGenerations で throw する。事前に捕まえる
            expect(
              generationSupportsHardwareBlend(
                generation,
                blend as Parameters<typeof generationSupportsHardwareBlend>[1],
              ),
              `${command.id} の hardwareBlend が ${generation} で使えない`,
            ).toBe(true);
            expect(command.generations).toEqual([generation as GenerationId]);
          }
        }
      });
    }

    it('FC には半透明のコマンドが 1 つも積まれない（translucency: none）', () => {
      expect(HARDWARE_GENERATION_PROFILES.FC.video.translucency.kind).toBe('none');
      for (const ticks of MOMENTS) {
        const frame = buildFrame('FC', raceAfter(ticks));
        const translucent = blendableCommands(frame).filter(
          (command) => (command as { hardwareBlend?: unknown }).hardwareBlend !== undefined,
        );
        expect(translucent.map((command) => command.id)).toEqual([]);
      }
    });
  });

  describe('タイル境界（tileSnap）', () => {
    it('FC は遠景のスクロール量が 8 px 単位に丸められている', () => {
      const snap = HARDWARE_GENERATION_PROFILES.FC.video.tileSnap;
      expect(snap).toBe(8);
      for (const ticks of MOMENTS) {
        const frame = buildFrame('FC', raceAfter(ticks));
        const layer = frame.backgrounds.find((background) => background.texture);
        expect(layer, '遠景の層が無い').toBeDefined();
        // offset は UV。画像 1 px = 画面 1 px に合わせてあるので、
        // 画像幅（512 px）を掛ければ画面の画素数に戻る
        const scrollPixels = layer!.offset![0] * 512;
        expect(Math.abs(scrollPixels - Math.round(scrollPixels / snap) * snap)).toBeLessThan(1e-6);
      }
    });

    it('FC は車スプライトの接地点が 8 px 単位に丸められている', () => {
      const snap = HARDWARE_GENERATION_PROFILES.FC.video.tileSnap;
      // 接地点 = 中心 + (groundFraction - 0.5) × 高さ。丸めるのは中心ではなく接地点
      const GROUND_FRACTION = 0.86;
      for (const ticks of MOMENTS) {
        const frame = buildFrame('FC', raceAfter(ticks));
        const cars = frame.sprites.filter((sprite) => sprite.id.startsWith('car-sprite-'));
        expect(cars.length).toBeGreaterThan(0);
        for (const sprite of cars) {
          const ground = sprite.position[1] + (GROUND_FRACTION - 0.5) * sprite.size[1];
          expect(sprite.position[0] % snap, `${sprite.id} の X`).toBeCloseTo(0, 6);
          expect(ground % snap, `${sprite.id} の接地点`).toBeCloseTo(0, 6);
        }
      }
    });

    it('FC でもミニマップのマーカーは丸めない（実機の OAM は 1 px 単位）', () => {
      // §3.6 の決定。丸めるのは BG 相当の枠であってマーカーではない。
      // 8 台が 8 px グリッドへ載ると、密集時に完全に重なって見分けが付かなくなる
      const positions = new Set<number>();
      for (const ticks of MOMENTS) {
        const frame = buildFrame('FC', raceAfter(ticks));
        for (const sprite of frame.sprites.filter((s) => s.id.startsWith('minimap-marker-'))) {
          positions.add(sprite.position[0]);
          positions.add(sprite.position[1]);
        }
      }
      expect([...positions].some((value) => value % 8 !== 0)).toBe(true);
    });

    it('SFC は丸めない（FC との差がそのまま滑らかさの差になる）', () => {
      expect(HARDWARE_GENERATION_PROFILES.SFC.video.tileSnap).toBe(1);
    });
  });

  describe('走査線あたりのスプライト数', () => {
    it('FC の 8 スプライト制限が適用されている', () => {
      const profile = HARDWARE_GENERATION_PROFILES.FC;
      expect(profile.video.spritesPerScanline).toBe(8);

      for (const ticks of MOMENTS) {
        const frame = buildFrame('FC', raceAfter(ticks));
        // 枠（BG 相当）を除いた、制限の対象になるスプライトを走査線ごとに数え直す。
        // 車は**絵のある範囲**だけを数える（セルの透明部分は実機ではタイルを置かない）
        const counters = new Int32Array(profile.video.internalHeight);
        for (const sprite of frame.sprites) {
          if (isBackgroundPlane(sprite.id)) continue;
          const size = sprite.size[1];
          const isCar = sprite.id.startsWith('car-sprite-');
          const ground = isCar ? sprite.position[1] + (0.86 - 0.5) * size : sprite.position[1] + size / 2;
          const height = isCar ? 0.44 * size : size;
          const top = Math.max(0, Math.floor(ground - height));
          const bottom = Math.min(profile.video.internalHeight, Math.ceil(ground));
          for (let row = top; row < bottom; row++) counters[row]! += 1;
        }
        expect(Math.max(...counters)).toBeLessThanOrEqual(profile.video.spritesPerScanline);
      }
    });

    it('9 台ぶん重ねると超過分が消え、消えた車が記録される', () => {
      const items = Array.from({ length: 9 }, (_unused, index) => ({
        entity: index,
        y: 100,
        height: 20,
      }));
      const result = applyScanlineLimit(items, 8, 224);
      expect(result.visible).toHaveLength(8);
      expect(result.culled).toEqual([8]);
      // 先に登録したものが残る ＝ 自機を先頭に置けば自機は消えない
      expect(result.visible[0]!.entity).toBe(0);
    });

    it('制限のあるのは FC だけで、他の世代は無制限', () => {
      expect(HARDWARE_GENERATION_PROFILES.SFC.video.spritesPerScanline).toBe(32);
      // 0 以下が「制限なし」。applyScanlineLimit はこの値で素通しになる
      expect(HARDWARE_GENERATION_PROFILES.PS1.video.spritesPerScanline).toBeLessThanOrEqual(0);
      expect(HARDWARE_GENERATION_PROFILES.PS2.video.spritesPerScanline).toBeLessThanOrEqual(0);
    });
  });

  describe('スプライトの重ね順', () => {
    it('FC はミニマップの枠が最背面・HUD が最前面・その間で自機が最も手前に来る', () => {
      const frame = buildFrame('FC', raceAfter(1500));
      const ids = frame.sprites.map((sprite) => sprite.id);
      expect(ids[0]).toMatch(/^minimap-panel/);
      // HUD は BG 相当（優先度つき）なので、走査線制限の外で最前面に積まれる
      expect(ids[ids.length - 1]).toMatch(/^hud-/);
      // 実機の OAM は番号が若いほど優先度が高く、かつ手前に出る。
      // 登録順は 自機 → マーカー → ライバル なので、積む順はその逆になる
      const limited = ids.filter((id) => !isBackgroundPlane(id));
      expect(limited[limited.length - 1]).toBe('car-sprite-FC-0');
    });
  });
});
