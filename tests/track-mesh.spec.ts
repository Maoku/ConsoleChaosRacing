import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  parseGlb,
  parseGltf,
  type GltfPrimitive,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { TRACK } from '../src/game/sim/track.js';
import {
  TRACK_MESH_LODS,
  sectorAt,
  sectorRange,
  trackSectorAsset,
  visibleSectors,
  type TrackMeshLod,
} from '../src/game/view/shared/track-mesh.js';

/**
 * 生成したコースメッシュが、コース定義どおりの起伏とバンクを持っているかを検査する
 * （実装計画 §6.1 第3世代基準 1 / 第4世代基準 3）。`TransformCommand` の回転が
 * `rotationY` しか無いため、標高もバンクもメッシュに焼き込むしかない。
 * 焼けているかはここでしか確かめられない。
 *
 * 検査は **LOD ごとに同じ内容を回す**。第3世代（4 m 刻み）と第4世代（1 m 刻み）で
 * 違うのは刻みとセクター数だけで、満たすべき性質は同一である。
 */

/** LOD を持つ世代だけ。第1・第2世代はスプライトなのでメッシュを持たない */
const MESH_GENERATIONS = GENERATION_IDS.filter((generation) => TRACK_MESH_LODS[generation]);

function loadSector(lod: TrackMeshLod, sector: number): GltfPrimitive {
  const bytes = readFileSync(join(process.cwd(), 'public', trackSectorAsset(lod, sector)));
  const { json, binary } = parseGlb(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const model = parseGltf(json, binary ? [binary] : []);
  expect(model.meshes).toHaveLength(1);
  expect(model.meshes[0]!.primitives).toHaveLength(1);
  return model.meshes[0]!.primitives[0]!;
}

/** 断面 1 輪ぶんの頂点数。草地 2 ＋ 縁石 2 ＋ 路面 (spans+1) ＋ 縁石 2 ＋ 草地 2 */
function ringWidth(lod: TrackMeshLod): number {
  return 4 + (lod.roadSpans + 1) + 4;
}

describe('コースメッシュ', () => {
  for (const generation of MESH_GENERATIONS) {
    const LOD = TRACK_MESH_LODS[generation]!;
    const RING_WIDTH = ringWidth(LOD);

    describe(generation, () => {
      it('セクターが周回を隙間なく覆う', () => {
        const span = TRACK.length / LOD.sectorCount;
        for (let sector = 0; sector < LOD.sectorCount; sector++) {
          const [from, to] = sectorRange(LOD, sector, TRACK.length);
          expect(to - from).toBeCloseTo(span, 9);
          const [nextFrom] = sectorRange(LOD, (sector + 1) % LOD.sectorCount, TRACK.length);
          // 末尾のセクターは 0 へ折り返す
          expect(sector === LOD.sectorCount - 1 ? 0 : nextFrom).toBeCloseTo(
            sector === LOD.sectorCount - 1 ? 0 : to,
            9,
          );
        }
        expect(sectorAt(LOD, 0, TRACK.length)).toBe(0);
        expect(sectorAt(LOD, TRACK.length - 1, TRACK.length)).toBe(LOD.sectorCount - 1);
      });

      it('描画するセクターが前方 300 m 以上を保証する', () => {
        // 自機はセクターのどこに居るか分からないので、保証されるのは
        // visibleRadius × セクター長。フォグはこの内側で閉じる
        const span = TRACK.length / LOD.sectorCount;
        expect(LOD.visibleRadius * span).toBeGreaterThan(300);
        const expected = LOD.visibleRadius * 2 + 1;
        for (const s of [0, 100, 1500, TRACK.length - 5]) {
          const sectors = visibleSectors(LOD, s, TRACK.length);
          expect(sectors).toHaveLength(expected);
          expect(new Set(sectors).size).toBe(expected);
          expect(sectors).toContain(sectorAt(LOD, s, TRACK.length));
        }
      });

      it('各セクターが期待どおりの頂点数と三角形数を持つ', () => {
        for (let sector = 0; sector < LOD.sectorCount; sector++) {
          const primitive = loadSector(LOD, sector);
          expect(primitive.positions.length / 3).toBe((LOD.segmentsPerSector + 1) * RING_WIDTH);
          // 1 区間あたり 8 つの四角形（草地・縁石・路面 spans・縁石・草地）
          const quadsPerSegment = 1 + 1 + LOD.roadSpans + 1 + 1;
          expect(primitive.indices.length / 3).toBe(LOD.segmentsPerSector * quadsPerSegment * 2);
          expect(primitive.uvs).not.toBeNull();
          expect(primitive.normals).not.toBeNull();
        }
      });

      it('同時に描くセクターが三角形予算に収まる', () => {
        // §6.3 の 20,000 tri/frame。路面だけで使い切らないこと
        const quadsPerSegment = 1 + 1 + LOD.roadSpans + 1 + 1;
        const perSector = LOD.segmentsPerSector * quadsPerSegment * 2;
        const drawn = Math.min(LOD.sectorCount, LOD.visibleRadius * 2 + 1);
        expect(perSector * drawn).toBeLessThan(20_000);
      });

      it('面がすべて上を向いている（裏面カリングに落ちない）', () => {
        for (let sector = 0; sector < LOD.sectorCount; sector++) {
          const primitive = loadSector(LOD, sector);
          const normals = primitive.normals!;
          for (let index = 0; index < normals.length; index += 3) {
            expect(normals[index + 1]).toBeGreaterThan(0);
          }
        }
      });

      it('セクターの継ぎ目が完全に一致する（割れない）', () => {
        for (let sector = 0; sector < LOD.sectorCount; sector++) {
          const current = loadSector(LOD, sector);
          const next = loadSector(LOD, (sector + 1) % LOD.sectorCount);
          const lastRing = current.positions.subarray(
            LOD.segmentsPerSector * RING_WIDTH * 3,
            (LOD.segmentsPerSector + 1) * RING_WIDTH * 3,
          );
          const firstRing = next.positions.subarray(0, RING_WIDTH * 3);
          for (let index = 0; index < lastRing.length; index++) {
            expect(lastRing[index]).toBe(firstRing[index]);
          }
        }
      });

      it('標高がコース定義どおり最大 8 m の起伏を持つ', () => {
        let minY = Infinity;
        let maxY = -Infinity;
        for (let sector = 0; sector < LOD.sectorCount; sector++) {
          const positions = loadSector(LOD, sector).positions;
          for (let index = 1; index < positions.length; index += 3) {
            minY = Math.min(minY, positions[index]!);
            maxY = Math.max(maxY, positions[index]!);
          }
        }
        // 草地が路面より 0.45 m 下がるぶんを含む
        expect(maxY - minY).toBeGreaterThan(7.5);
        expect(maxY - minY).toBeLessThan(9.5);
      });

      it('高速コーナーにバンクが焼き込まれている', () => {
        // バンク 4° の区間（制御点 (690, 280) 付近、s ≒ 900）
        const banked = TRACK.toTrack(690, 280);
        const sample = TRACK.sampleAt(banked.s);
        expect(Math.abs(sample.bank)).toBeGreaterThan((3 * Math.PI) / 180);

        // 路面の左右端の標高差が、バンク角から期待される値と一致する
        const left = TRACK.toWorld(banked.s, -sample.halfWidth);
        const right = TRACK.toWorld(banked.s, sample.halfWidth);
        const expected = 2 * sample.halfWidth * Math.sin(sample.bank);
        expect(right[1] - left[1]).toBeCloseTo(expected, 6);

        // 右コーナーなのでバンクは負 ＝ 外側（左）が高い
        expect(sample.curvature).toBeLessThan(0);
        expect(left[1]).toBeGreaterThan(right[1]);

        // メッシュにも同じ傾きが乗っている
        const sector = sectorAt(LOD, banked.s, TRACK.length);
        const positions = loadSector(LOD, sector).positions;
        const [from] = sectorRange(LOD, sector, TRACK.length);
        const step = TRACK.length / (LOD.sectorCount * LOD.segmentsPerSector);
        const ring = Math.round((banked.s - from) / step);
        const roadStart = 4;
        const meshLeft = positions[(ring * RING_WIDTH + roadStart) * 3 + 1]!;
        const meshRight = positions[(ring * RING_WIDTH + roadStart + LOD.roadSpans) * 3 + 1]!;
        expect(meshLeft - meshRight).toBeCloseTo(left[1] - right[1], 3);
      });

      it('UV が路面・縁石・草地の帯に収まっている', () => {
        const primitive = loadSector(LOD, 0);
        const uvs = primitive.uvs!;
        const roadStart = 4;
        for (let ring = 0; ring <= LOD.segmentsPerSector; ring++) {
          for (let column = 0; column < RING_WIDTH; column++) {
            const u = uvs[(ring * RING_WIDTH + column) * 2]!;
            expect(u).toBeGreaterThan(0);
            expect(u).toBeLessThan(1);
            if (column >= roadStart && column <= roadStart + LOD.roadSpans) {
              expect(u).toBeLessThan(0.5); // 路面の帯
            }
          }
        }
      });

      it('路面の横分割が頂点量子化の揺れを面の波打ちに見せる細かさである', () => {
        // 1 マスが大きすぎると、揺れが「面の波打ち」ではなく「物体の平行移動」に見える
        const primitive = loadSector(LOD, 0);
        const positions = primitive.positions;
        const roadStart = 4;
        const a = roadStart * 3;
        const b = (roadStart + 1) * 3;
        const lateralStep = Math.hypot(
          positions[a]! - positions[b]!,
          positions[a + 2]! - positions[b + 2]!,
        );
        const longitudinalStep = TRACK.length / (LOD.sectorCount * LOD.segmentsPerSector);
        expect(lateralStep).toBeLessThan(2.5);
        expect(longitudinalStep).toBeLessThan(4.5);
      });
    });
  }

  it('線形フィルタの世代ほど路面アトラスを大きく焼く', () => {
    // 640×448 / linear では 256² が明確に眠くなる。解像度は能力に合わせて決める
    for (const generation of MESH_GENERATIONS) {
      const lod = TRACK_MESH_LODS[generation]!;
      const profile = HARDWARE_GENERATION_PROFILES[generation];
      const expected = profile.video.textureFilter === 'linear' ? 512 : 256;
      expect(lod.textureSize, `${generation} の路面アトラス`).toBe(expected);
    }
  });

  it('深度バッファを持たない世代ほど縦の刻みを粗く採る', () => {
    // 第3世代はアフィン歪みと頂点量子化を**見せる**ために細かくしすぎない。
    // 第4世代はどちらも無いので、細かさが標高とバンクの滑らかさに直結する
    const ps1 = TRACK_MESH_LODS.PS1!;
    const ps2 = TRACK_MESH_LODS.PS2!;
    const stepOf = (lod: TrackMeshLod) => TRACK.length / (lod.sectorCount * lod.segmentsPerSector);
    expect(stepOf(ps1) / stepOf(ps2)).toBeCloseTo(4, 1);
    expect(stepOf(ps2)).toBeCloseTo(1, 2);
    // 横分割は同じ。差が「縦の刻み・解像度・フィルタ・ライティング」だけから出るように
    expect(ps2.roadSpans).toBe(ps1.roadSpans);
  });
});
