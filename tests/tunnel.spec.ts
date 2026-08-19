import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GENERATION_IDS,
  parseGlb,
  parseGltf,
  type GenerationId,
  type GltfPrimitive,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { TRACK } from '../src/game/sim/track.js';
import { sceneryFor } from '../src/game/sim/scenery.js';
import { TRACK_MESH_LODS } from '../src/game/view/shared/track-mesh.js';
import {
  TUNNEL,
  insideTunnel,
  tunnelAsset,
  tunnelBlendAt,
  tunnelDepthAt,
  tunnelHalfWidth,
  tunnelLampAsset,
  tunnelSpanAhead,
} from '../src/game/view/shared/tunnel.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * トンネル区間（実装計画 8-9）。
 *
 * 背景オブジェクトと同じ主張の続きで、**4 世代が同じ 1 つの表を読む**。
 * 出し方は世代ごとに違う（走査線の明るさ／color math ／焼いたメッシュ／照明の入れ替え）
 * が、区間の位置と長さは完全に一致する。
 */

const state = raceAfter(900);

/** 自機をトンネルの中／手前へ置いたフレーム。`s` はシムの状態そのもの */
function frameAt(generation: GenerationId, s: number) {
  const moved = raceAfter(900);
  const player = moved.cars[0]!;
  player.s = moved.track.wrapS(s);
  return buildFrame(generation, moved);
}

function loadTunnel(url: string): GltfPrimitive {
  const bytes = readFileSync(join(process.cwd(), 'public', url));
  const { json, binary } = parseGlb(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const model = parseGltf(json, binary ? [binary] : []);
  expect(model.meshes).toHaveLength(1);
  return model.meshes[0]!.primitives[0]!;
}

describe('トンネル区間', () => {
  describe('区間の表', () => {
    it('弧長の範囲と、その中／外の判定が噛み合う', () => {
      expect(TUNNEL.to).toBeGreaterThan(TUNNEL.from);
      expect(insideTunnel(TRACK, TUNNEL.from + 1)).toBe(true);
      expect(insideTunnel(TRACK, TUNNEL.to - 1)).toBe(true);
      expect(insideTunnel(TRACK, TUNNEL.from - 1)).toBe(false);
      expect(insideTunnel(TRACK, TUNNEL.to + 1)).toBe(false);
      // 深さは「最寄りの坑口までの符号付き距離」。中央がいちばん深い
      const middle = (TUNNEL.from + TUNNEL.to) / 2;
      expect(tunnelDepthAt(TRACK, middle)).toBeCloseTo((TUNNEL.to - TUNNEL.from) / 2, 6);
      expect(tunnelDepthAt(TRACK, TUNNEL.from - 30)).toBeCloseTo(-30, 6);
    });

    it('坑口の前後で照明の混ぜ具合が滑らかに 0 → 1 へ渡る', () => {
      expect(tunnelBlendAt(TRACK, TUNNEL.from - 100)).toBe(0);
      expect(tunnelBlendAt(TRACK, TUNNEL.from)).toBeCloseTo(0.5, 6);
      expect(tunnelBlendAt(TRACK, (TUNNEL.from + TUNNEL.to) / 2)).toBe(1);
      expect(tunnelBlendAt(TRACK, TUNNEL.to + 100)).toBe(0);
      // 単調に増えること（途中で戻ると「目が慣れる」演出が跳ねる）
      let previous = -1;
      for (let s = TUNNEL.from - 40; s <= TUNNEL.from + 40; s += 4) {
        const blend = tunnelBlendAt(TRACK, s);
        expect(blend).toBeGreaterThanOrEqual(previous);
        previous = blend;
      }
    });

    it('前方の区間は、中に居るとき 0 から始まる', () => {
      const outside = tunnelSpanAhead(TRACK, TUNNEL.from - 50);
      expect(outside.near).toBeCloseTo(50, 6);
      expect(outside.far).toBeCloseTo(50 + (TUNNEL.to - TUNNEL.from), 6);
      const inside = tunnelSpanAhead(TRACK, TUNNEL.from + 20);
      expect(inside.near).toBe(0);
      expect(inside.far).toBeCloseTo(TUNNEL.to - TUNNEL.from - 20, 6);
    });

    it('直線で平坦な区間に置いてある（焼いた断面が路面から浮かない）', () => {
      let maxCurvature = 0;
      let maxBank = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let s = TUNNEL.from; s <= TUNNEL.to; s += 2) {
        const sample = TRACK.sampleAt(s);
        maxCurvature = Math.max(maxCurvature, Math.abs(sample.curvature));
        maxBank = Math.max(maxBank, Math.abs(sample.bank));
        minY = Math.min(minY, sample.position[1]);
        maxY = Math.max(maxY, sample.position[1]);
      }
      // 半径 400 m 以上・バンク 0°・標高差 1 m 以内
      expect(1 / maxCurvature).toBeGreaterThan(400);
      expect(maxBank).toBe(0);
      expect(maxY - minY).toBeLessThan(1);
    });

    it('中には背景オブジェクトを 1 つも置かない（4 世代とも同じ表を読む）', () => {
      for (const object of sceneryFor(TRACK)) {
        expect(insideTunnel(TRACK, object.s), `id ${object.id}`).toBe(false);
      }
    });
  });

  describe('焼いたメッシュ（第3・第4世代）', () => {
    for (const generation of GENERATION_IDS) {
      const lod = TRACK_MESH_LODS[generation];
      if (!lod) continue;

      it(`${generation}: 内空が表の寸法どおりで、路面の上に柱が 1 本も無い`, () => {
        const positions = loadTunnel(tunnelAsset(lod)).positions;
        let maxY = -Infinity;
        for (let index = 1; index < positions.length; index += 3) {
          maxY = Math.max(maxY, positions[index]!);
        }
        // 天井の頂点 ＋ 外殻のぶん。標高（最大 1 m）を足しても外殻の高さを超えない
        const shellCrown =
          TUNNEL.portalCenter + (TUNNEL.crownHeight - TUNNEL.portalCenter) * TUNNEL.portalScale;
        expect(maxY).toBeGreaterThan(TUNNEL.crownHeight);
        expect(maxY).toBeLessThan(shellCrown + 2);

        // 路面の真上（|lateral| < halfWidth）には、天井の高さより下の点が 1 つも無い
        for (let vertex = 0; vertex < positions.length / 3; vertex++) {
          const world: [number, number, number] = [
            positions[vertex * 3]!,
            positions[vertex * 3 + 1]!,
            positions[vertex * 3 + 2]!,
          ];
          const at = TRACK.toTrack(world[0], world[2]);
          if (!insideTunnel(TRACK, at.s)) continue;
          const road = TRACK.toWorld(at.s, at.lateral)[1];
          if (Math.abs(at.lateral) > TRACK.sampleAt(at.s).halfWidth) continue;
          // 路面の上にあるのは天井（起拱点より上）だけ
          expect(world[1] - road, `頂点 ${vertex}`).toBeGreaterThan(TUNNEL.springHeight - 0.01);
        }
      });

      it(`${generation}: 灯具は天井の直下を 1 本の帯で走る`, () => {
        const primitive = loadTunnel(tunnelLampAsset(lod));
        const positions = primitive.positions;
        const normals = primitive.normals!;
        for (let vertex = 0; vertex < positions.length / 3; vertex++) {
          // 灯具はすべて下を向く（真上に貼り付いた面）
          expect(normals[vertex * 3 + 1]!).toBeLessThan(-0.9);
        }
        // 帯の幅は表のとおり
        const at = TRACK.toTrack(positions[0]!, positions[2]!);
        expect(Math.abs(at.lateral)).toBeCloseTo(TUNNEL.lamp.width / 2, 3);
      });

      it(`${generation}: 内壁が路面の縁より外にある（走行線を塞がない）`, () => {
        const half = tunnelHalfWidth(TRACK, TUNNEL.from);
        expect(half).toBeGreaterThan(TRACK.sampleAt(TUNNEL.from).halfWidth + 3);
      });
    }
  });

  describe('世代ごとの出し方', () => {
    it('第3・第4世代は躯体と灯具を別マテリアルで積む', () => {
      for (const generation of ['PS1', 'PS2'] as const) {
        const frame = frameAt(generation, TUNNEL.from + 60);
        const meshes = frame.meshes.filter((mesh) => mesh.id.startsWith('tunnel-'));
        expect(meshes).toHaveLength(2);
        const materials = new Set(meshes.map((mesh) => mesh.material));
        expect(materials.size).toBe(2);
        // 灯具は環境光が落ちても明るいまま（ambient > 1）
        const lamp = frame.materials.find((material) => material.id === `tunnel-lamp-${generation}`);
        expect(lamp!.ambient).toBeGreaterThan(1);
        const structure = frame.materials.find((material) => material.id === `tunnel-${generation}`);
        expect(structure!.ambient).toBeLessThan(0.75);
      }
    });

    it('区間から遠いところではトンネルを 1 つも積まない', () => {
      for (const generation of ['PS1', 'PS2'] as const) {
        const frame = frameAt(generation, TUNNEL.from - 900);
        expect(frame.meshes.filter((mesh) => mesh.id.startsWith('tunnel-'))).toEqual([]);
      }
    });

    it('第4世代だけが照明そのものを入れ替える', () => {
      const outside = frameAt('PS2', TUNNEL.from - 400);
      const inside = frameAt('PS2', TUNNEL.from + 110);
      const light = (frame: typeof outside, id: string) =>
        frame.lights.find((command) => command.id === id)!;

      // 環境光と太陽が暗くなり、点光源は強く・低く・暖色になる
      expect(light(inside, 'ambient-PS2').color).not.toBe(light(outside, 'ambient-PS2').color);
      expect(light(inside, 'sun-PS2').color).not.toBe(light(outside, 'sun-PS2').color);
      expect(light(inside, 'key-PS2').intensity).toBeGreaterThan(
        light(outside, 'key-PS2').intensity,
      );
      expect(light(inside, 'key-PS2').position[1]).toBeLessThan(
        light(outside, 'key-PS2').position[1],
      );

      // 映り込みが弱まり、フォグが薄くなる
      const environment = (frame: typeof outside) =>
        frame.materials.find((material) => material.id === 'car-PS2')!.environmentStrength!;
      expect(environment(inside)).toBeLessThan(environment(outside) / 2);
      expect(inside.backgrounds[0]!.fogDensity!).toBeLessThan(
        outside.backgrounds[0]!.fogDensity!,
      );

      // 第3世代の照明は 1 つも変わらない（そもそも動的ライトを積まない）
      expect(frameAt('PS1', TUNNEL.from + 110).lights).toEqual([]);
    });

    it('擬似3D の 2 世代は坑口をスプライトで抜き、メッシュを 1 つも積まない', () => {
      for (const generation of ['FC', 'SFC'] as const) {
        const frame = frameAt(generation, TUNNEL.from - 40);
        const panels = frame.sprites.filter((sprite) => sprite.id.startsWith('tunnel-'));
        expect(panels.length).toBeGreaterThan(0);
        expect(frame.meshes).toEqual([]);
        for (const panel of panels) {
          expect(panel.screenSpace).toBe(true);
          // 坑口は不透明の板。第1世代の translucency: none をここでも守る
          expect(panel.hardwareBlend).toBeUndefined();
        }
      }
    });

    it('第1世代は走査線の明るさでトンネルの中を落とす', () => {
      const inside = frameAt('FC', TUNNEL.from + 60);
      const outside = frameAt('FC', TUNNEL.from - 400);
      const brightest = (frame: typeof inside) => {
        const scanlines = frame.rasterSurfaces[0]!.scanlines;
        let value = 0;
        for (let row = 0; row * 4 + 3 < scanlines.length; row++) {
          value = Math.max(value, scanlines[row * 4 + 3]!);
        }
        return value;
      };
      expect(brightest(inside)).toBeLessThan(brightest(outside) * 0.75);
    });

    it('第2世代は color math の帯で路面を落とす', () => {
      const frame = frameAt('SFC', TUNNEL.from + 60);
      const band = frame.sprites.find((sprite) => sprite.id === 'road-tunnel-SFC');
      expect(band).toBeDefined();
      expect(band!.hardwareBlend).toMatchObject({
        family: 'gen2-color-math',
        operation: 'subtract',
        half: true,
      });
    });
  });

  it('4 世代とも同じ区間を見ている', () => {
    // 出し方は違うが、**トンネルが始まる弧長は 1 つ**。ビューは表を読むだけで、
    // 世代ごとの定数をどこにも持たない
    for (const generation of GENERATION_IDS) {
      const before = frameAt(generation, TUNNEL.from - 400);
      const at = frameAt(generation, TUNNEL.from + 60);
      const marks = (frame: typeof before) =>
        [...frame.meshes, ...frame.sprites].filter((command) => command.id.startsWith('tunnel-'))
          .length;
      expect(marks(before), `${generation} は区間の外でトンネルを出している`).toBe(0);
      expect(marks(at), `${generation} は区間の中でトンネルを出していない`).toBeGreaterThan(0);
    }
    expect(state.track.length).toBeGreaterThan(TUNNEL.to);
  });
});
