import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HARDWARE_GENERATION_PROFILES, type LightCommand } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { MANIFEST } from '../src/assets/manifest.js';
import { ENTRANT_COUNT } from '../src/game/sim/state.js';
import { cameraAngles, skylineBackgrounds } from '../src/game/view/gen4-ps2.js';
import { followCamera } from '../src/game/view/shared/camera.js';
import {
  ENVIRONMENT_MAP,
  SKY_SAMPLE,
  SKYLINE,
  SUN_DIRECTION,
  equirectElevation,
  equirectU,
  equirectV,
  skylineRows,
} from '../src/game/view/shared/environment.js';
import { SKY_COLORS } from '../src/game/view/shared/variants.js';
import { decodePng, type RasterImage } from '../tools/lib/png.mjs';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 第4世代の環境まわりを固定する（実装計画 §6.1 第4世代基準 1–4）。
 *
 * 「空と映り込みが同じ環境マップで一致している」は、**目で見ても気付きにくい**
 * 種類の要求である。flipY を 1 つ間違えれば空が地面として映り込むし、色の定数を
 * 手で写した瞬間から少しずつずれていく。どちらも例外にならないので、
 * 環境マップの画素とコマンド列を突き合わせて機械的に確かめる。
 */

const PROFILE = HARDWARE_GENERATION_PROFILES.PS2;
const [SUN_X, SUN_Y, SUN_Z] = SUN_DIRECTION;

function load(url: string): RasterImage {
  return decodePng(readFileSync(join(process.cwd(), 'public', url)));
}

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** 仰角の範囲にある行の平均色。`tools/build-skyline.mjs` と同じ式 */
function meanColor(image: RasterImage, fromElevation: number, toElevation: number) {
  const from = Math.round(equirectV(fromElevation) * image.height);
  const to = Math.round(equirectV(toElevation) * image.height);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * 4;
      r += image.pixels[index]!;
      g += image.pixels[index + 1]!;
      b += image.pixels[index + 2]!;
      count += 1;
    }
  }
  return [r / count, g / count, b / count] as const;
}

describe('第4世代の環境', () => {
  const environment = load(ENVIRONMENT_MAP.url);

  describe('環境マップと定数の対応', () => {
    it('実寸が ENVIRONMENT_MAP のとおり（2:1 の正距円筒）', () => {
      expect([environment.width, environment.height]).toEqual([
        ENVIRONMENT_MAP.width,
        ENVIRONMENT_MAP.height,
      ]);
      expect(environment.width).toBe(environment.height * 2);
    });

    it('空の階調とフォグ色が環境マップから外れていない', () => {
      // 手で写した色が古びると、地平線で背景と 3D の境目が見える
      const cases = [
        { name: '天頂', measured: meanColor(environment, SKY_SAMPLE.zenith.from, SKY_SAMPLE.zenith.to), constant: SKY_COLORS.PS2.top },
        { name: '地平の霞', measured: meanColor(environment, SKY_SAMPLE.haze.from, SKY_SAMPLE.haze.to), constant: SKY_COLORS.PS2.bottom },
      ];
      for (const { name, measured, constant } of cases) {
        const expected = parseHex(constant);
        for (let channel = 0; channel < 3; channel++) {
          expect(Math.abs(measured[channel]! - expected[channel]!), `${name} の第 ${channel} 成分`).toBeLessThan(3);
        }
      }
    });

    it('SUN_DIRECTION が環境マップの最輝点と一致する', () => {
      let best = -1;
      let sunX = 0;
      let sunY = 0;
      // 地平線より上だけを見る。路面の照り返しを太陽と取り違えない
      const limit = Math.round(equirectV(0) * environment.height);
      for (let y = 0; y < limit; y++) {
        for (let x = 0; x < environment.width; x++) {
          const index = (y * environment.width + x) * 4;
          const sum = environment.pixels[index]! + environment.pixels[index + 1]! + environment.pixels[index + 2]!;
          if (sum > best) {
            best = sum;
            sunX = x;
            sunY = y;
          }
        }
      }

      const elevation = equirectElevation(sunY / environment.height);
      // equirectU の逆。u = fract(0.5 + azimuth / 2π)
      const azimuth = (sunX / environment.width - 0.5) * 2 * Math.PI;
      const horizontal = Math.cos(elevation);
      const expected = [
        horizontal * Math.cos(azimuth),
        Math.sin(elevation),
        horizontal * Math.sin(azimuth),
      ];

      // 実測は最輝点 1 画素なので、方向の一致は 3° 以内で見る
      const dot = expected[0]! * SUN_X + expected[1]! * SUN_Y + expected[2]! * SUN_Z;
      expect(Math.acos(Math.min(1, dot)) * (180 / Math.PI)).toBeLessThan(3);
    });
  });

  describe('遠景の帯', () => {
    const skyline = load(SKYLINE.url);

    it('環境マップから切り出した行の範囲そのものになっている', () => {
      const [from, to] = skylineRows(environment.height);
      expect(skyline.width).toBe(environment.width);
      expect(skyline.height).toBe(to - from);
    });

    it('地平線より上は元の絵、下は一様な霞になっている', () => {
      const [from] = skylineRows(environment.height);
      const rowAt = (elevation: number) =>
        Math.round(equirectV(elevation) * environment.height) - from;

      // 地平線のすぐ上は元の絵と 1 画素も違わない
      const sky = rowAt(4 * (Math.PI / 180));
      for (let x = 0; x < skyline.width; x += 97) {
        const source = ((from + sky) * environment.width + x) * 4;
        const strip = (sky * skyline.width + x) * 4;
        expect(skyline.pixels[strip]).toBe(environment.pixels[source]);
        expect(skyline.pixels[strip + 1]).toBe(environment.pixels[source + 1]);
      }

      // `groundFadeTo` より下は行の中でも列の間でも一様 ＝ 撮影地の路面が消えている
      const flat = rowAt(SKYLINE.groundFadeTo - 0.05);
      const index = (flat * skyline.width) * 4;
      const reference = [skyline.pixels[index], skyline.pixels[index + 1], skyline.pixels[index + 2]];
      for (let x = 0; x < skyline.width; x += 13) {
        const at = (flat * skyline.width + x) * 4;
        expect([skyline.pixels[at], skyline.pixels[at + 1], skyline.pixels[at + 2]]).toEqual(reference);
      }
    });

    it('層は不透明（縁が横線として見えない）', () => {
      for (let index = 3; index < skyline.pixels.length; index += 4 * 997) {
        expect(skyline.pixels[index]).toBe(255);
      }
    });
  });

  describe('flipY の向き', () => {
    const byUrl = new Map(MANIFEST.textures.map((texture) => [texture.url, texture]));

    it('環境マップは flipY: false（v = 0 が真上）', () => {
      // 反転すると空が地面として映り込む。例外にならないので気付きにくい
      expect(byUrl.get(ENVIRONMENT_MAP.url)?.flipY).toBe(false);
    });

    it('遠景の帯は既定のまま（層のシェーダが反転済みを前提にしている）', () => {
      expect(byUrl.get(SKYLINE.url)).toBeDefined();
      expect(byUrl.get(SKYLINE.url)?.flipY).toBeUndefined();
    });
  });

  describe('空と映り込みの一致', () => {
    it('帯の U が映り込みと同じ式でカメラの方位から決まる', () => {
      const state = raceAfter(1500);
      const camera = followCamera({ track: state.track, car: state.cars[0]! });
      const [, layer] = skylineBackgrounds('PS2', PROFILE, camera);
      const { azimuth } = cameraAngles(camera);

      const repeat = layer!.repeat![0]!;
      // 画面中央が覗く U ＝ その向きを `equirectangularUv` へ入れたときの U
      const center = layer!.offset![0]! + repeat / 2;
      expect(center).toBeCloseTo(equirectU(azimuth), 9);

      // 覗く幅は実際の水平画角ぶん。縦画角と内部解像度の縦横比から出る
      const halfTan = Math.tan((((camera.fovDegrees ?? 55) * Math.PI) / 180) / 2);
      const horizontalFov =
        2 * Math.atan((halfTan * PROFILE.video.internalWidth) / PROFILE.video.internalHeight);
      expect(repeat).toBeCloseTo(horizontalFov / (2 * Math.PI), 9);
    });

    it('視線が回れば帯も同じだけ流れる', () => {
      const state = raceAfter(1500);
      const before = skylineBackgrounds(
        'PS2',
        PROFILE,
        followCamera({ track: state.track, car: state.cars[0]! }),
      )[1]!;
      for (let tick = 0; tick < 240; tick++) state.cars[0]!.s = state.track.wrapS(state.cars[0]!.s + 1);
      const after = skylineBackgrounds(
        'PS2',
        PROFILE,
        followCamera({ track: state.track, car: state.cars[0]! }),
      )[1]!;
      expect(after.offset![0]).not.toBeCloseTo(before.offset![0]!, 3);
    });

    it('帯がどの画角でも画面を覆いきる（空の階調が縁として見えない）', () => {
      const state = raceAfter(1500);
      for (const speed of [0, 40, 80]) {
        const car = { ...state.cars[0]!, speed };
        const camera = followCamera({ track: state.track, car });
        const [, layer] = skylineBackgrounds('PS2', PROFILE, camera);
        const bottom = layer!.placement!.bottom;
        const top = bottom + layer!.placement!.height;
        expect(bottom, `画角 ${camera.fovDegrees}° で下端が届かない`).toBeLessThan(0);
        expect(top, `画角 ${camera.fovDegrees}° で上端が届かない`).toBeGreaterThan(1);
      }
    });
  });

  describe('積まれるコマンド', () => {
    const frame = buildFrame('PS2', raceAfter(1500));

    it('ambient / directional / 落ち影用の点光源が 1 つずつ積まれる', () => {
      const kinds = frame.lights.map((light: LightCommand) => light.kind);
      expect(kinds.filter((kind) => kind === 'ambient')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'directional')).toHaveLength(1);
      // 点光源はエンジンが「最も強い 1 つ」しか使わない。増やしても意味が無い
      expect(kinds.filter((kind) => kind === 'point')).toHaveLength(1);

      const sun = frame.lights.find((light: LightCommand) => light.kind === 'directional')!;
      expect(sun.direction).toEqual([SUN_X, SUN_Y, SUN_Z]);
      // 影は点光源が車より上にあって初めて落ちる
      const point = frame.lights.find((light: LightCommand) => light.kind === 'point')!;
      expect(point.radius).toBeGreaterThan(0);
      const car = frame.meshes.find((mesh) => mesh.id.startsWith('car-shadow-'))!;
      expect(point.position[1]).toBeGreaterThan(car.transform.position[1] + 10);
    });

    it('車のマテリアルだけが環境マップを持つ', () => {
      const withEnvironment = frame.materials.filter((material) => material.environmentTexture);
      expect(withEnvironment.map((material) => material.id)).toEqual(['car-PS2']);
      expect(withEnvironment[0]!.environmentTexture).toBe(ENVIRONMENT_MAP.url);
      expect(withEnvironment[0]!.environmentStrength).toBeGreaterThan(0);
      // 上げすぎると塗装の色が飛び、8 台を色で見分けられなくなる
      expect(withEnvironment[0]!.environmentStrength).toBeLessThanOrEqual(0.5);
    });

    it('影は専用のメッシュが落とす（車体を歪めない）', () => {
      const cars = frame.meshes.filter((mesh) => /^car-PS2-\d+$/.test(mesh.id));
      const shadows = frame.meshes.filter((mesh) => mesh.id.startsWith('car-shadow-PS2-'));
      expect(cars).toHaveLength(ENTRANT_COUNT);
      expect(shadows).toHaveLength(ENTRANT_COUNT);

      for (const car of cars) {
        // 車体に scale が入るとモデルが歪む。影の大きさは影用メッシュが持つ
        expect(car.transform.scale, `${car.id} に scale がある`).toBeUndefined();
        expect(car.castShadow).toBeFalsy();
      }
      for (const shadow of shadows) {
        expect(shadow.castShadow).toBe(true);
        expect(shadow.groundY).toBeDefined();
        expect(shadow.asset).toBeUndefined();
        // 影の四角形は回転しないので正方形。車の footprint（1.9 × 0.88 m）と同じ桁で、
        // 全長より小さい ＝ どの向きでも車体の下からはみ出しすぎない
        const scale = shadow.transform.scale!;
        expect(scale[0]).toBe(scale[2]);
        const span = scale[0]! * 2;
        expect(span).toBeGreaterThan(0.6);
        expect(span).toBeLessThan(1.2);
      }
    });

    it('影用メッシュは 1 画素も描かれない', () => {
      const material = frame.materials.find((entry) => entry.id === 'car-shadow-PS2')!;
      expect(material.colorFactor?.[3]).toBe(0);
      // base.a < alphaCutoff で discard される。0 < 1 なので全画素
      expect(material.alphaCutoff).toBe(1);
    });

    it('深度バッファがあるので描画順の指定を 1 つも持たない', () => {
      // 第3世代との差はここに出る。スロット指定が要らないこと自体が世代の差
      for (const mesh of frame.meshes) {
        expect(mesh.orderTableIndex, `${mesh.id}`).toBeUndefined();
        expect(mesh.polygonSortRange, `${mesh.id}`).toBeUndefined();
      }
      for (const material of frame.materials) {
        expect(material.polygonSort, `${material.id}`).toBeFalsy();
      }
    });

    it('ドローコールと三角形が予算に収まる', () => {
      // §6.3: 240 コール / 20,000 tri。路面は 11 セクター ＝ 13,640 tri
      const draws = frame.meshes.length + frame.sprites.length + frame.backgrounds.length;
      expect(draws).toBeLessThan(240);
      const sectors = frame.meshes.filter((mesh) => mesh.id.startsWith('track-PS2-'));
      expect(sectors).toHaveLength(11);
    });
  });
});
