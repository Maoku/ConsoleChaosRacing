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
  TRACK_ATLAS,
  TRACK_ATLAS_SLOTS,
  TRACK_MESH_LODS,
  roadColumns,
  sectorAt,
  sectorRange,
  trackSectorAsset,
  trackSurfaceTexture,
  visibleSectors,
  type TrackMeshLod,
} from '../src/game/view/shared/track-mesh.js';
import { decodePng } from '../tools/lib/png.mjs';

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

/**
 * 断面 1 輪ぶんの頂点数。
 * 土手 2 ＋［金網 2］＋ 壁 2 ＋ 草地 2 ＋ 縁石 2 ＋ 路面の列 ＋ その鏡像。
 * 壁と土手は 8-6 で足したもので、`TransformCommand` に X/Z 回転が無い以上、
 * バンクのついた路面に沿う壁はメッシュへ焼き込むしかない。土手は**木を植える地面**で、
 * 無いと壁の外に置いた木が空の中に浮く。
 * 金網は 8-10 で足した**第4世代だけ**の面で、`fenceHeight` を持つ LOD にしか無い。
 */
function sideColumns(lod: TrackMeshLod): number {
  return lod.fenceHeight === null ? 8 : 10;
}

/** 路面の列数。等分 (`roadSpans` + 1) ＋ 中央の破線の両縁（8-11） */
function roadColumnCount(lod: TrackMeshLod): number {
  return roadColumns(lod).length;
}

function ringWidth(lod: TrackMeshLod): number {
  return sideColumns(lod) * 2 + roadColumnCount(lod);
}

/** 1 区間あたりの四角形。片側の面の数 × 2 ＋ 路面の分割数 */
function quadsPerSegment(lod: TrackMeshLod): number {
  return sideColumns(lod) + roadColumnCount(lod) - 1;
}

/** 路面の最初の点の列番号 */
function roadStart(lod: TrackMeshLod): number {
  return sideColumns(lod);
}

/**
 * その列が垂直な面（壁・金網）か。
 * 列の並びは 土手・［金網］・壁・草地・縁石・路面 … の鏡像。
 */
function isVertical(lod: TrackMeshLod, column: number): boolean {
  const width = ringWidth(lod);
  const from = 2;
  const to = lod.fenceHeight === null ? 4 : 6;
  return (
    (column >= from && column < to) || (column >= width - to && column < width - from)
  );
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
          expect(primitive.indices.length / 3).toBe(
            LOD.segmentsPerSector * quadsPerSegment(LOD) * 2,
          );
          expect(primitive.uvs).not.toBeNull();
          expect(primitive.normals).not.toBeNull();
        }
      });

      it('同時に描くセクターが三角形予算に収まる', () => {
        const perSector = LOD.segmentsPerSector * quadsPerSegment(LOD) * 2;
        const drawn = Math.min(LOD.sectorCount, LOD.visibleRadius * 2 + 1);
        const road = perSector * drawn;
        // §6.3 の 20,000 tri/frame は **ordering table の CPU 側分割性能**から出た値で、
        // 深度バッファがあってソートを一切しない世代には掛からない（§6.3 に実測の記録）。
        // 掛かる世代では「路面だけで使い切らないこと」がそのまま LOD の制約になる
        const budget = HARDWARE_GENERATION_PROFILES[generation].video.depthBuffer
          ? 40_000
          : 20_000;
        expect(road).toBeLessThan(budget);
      });

      it('地面は上を向き、壁と金網はコース中心を向いている（裏面カリングに落ちない）', () => {
        for (let sector = 0; sector < LOD.sectorCount; sector++) {
          const primitive = loadSector(LOD, sector);
          const normals = primitive.normals!;
          const positions = primitive.positions;
          for (let vertex = 0; vertex < normals.length / 3; vertex++) {
            const column = vertex % RING_WIDTH;
            const ny = normals[vertex * 3 + 1]!;
            if (isVertical(LOD, column)) {
              // 垂直な面なので上は向かない
              expect(Math.abs(ny)).toBeLessThan(0.3);
              // 法線がコース中心のほうを向いていること（外を向くと壁の裏側が見える）
              const ring = Math.floor(vertex / RING_WIDTH);
              const centerColumn =
                ring * RING_WIDTH + roadStart(LOD) + Math.floor(roadColumnCount(LOD) / 2);
              const toCenterX = positions[centerColumn * 3]! - positions[vertex * 3]!;
              const toCenterZ = positions[centerColumn * 3 + 2]! - positions[vertex * 3 + 2]!;
              const dot = normals[vertex * 3]! * toCenterX + normals[vertex * 3 + 2]! * toCenterZ;
              expect(dot).toBeGreaterThan(0);
              continue;
            }
            expect(ny).toBeGreaterThan(0);
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
        // 草地が路面より 0.45 m 下がるぶんと、壁 ＋ 土手の高さ 1.0 m（8-6）、
        // 金網を載せる世代（第4世代）はさらにその高さ（8-10）を含む
        expect(maxY - minY).toBeGreaterThan(7.5);
        expect(maxY - minY).toBeLessThan(10.5 + (LOD.fenceHeight ?? 0));
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
        const meshLeft = positions[(ring * RING_WIDTH + roadStart(LOD)) * 3 + 1]!;
        const meshRight =
          positions[(ring * RING_WIDTH + roadStart(LOD) + roadColumnCount(LOD) - 1) * 3 + 1]!;
        expect(meshLeft - meshRight).toBeCloseTo(left[1] - right[1], 3);
      });

      it('UV が路面・縁石・草地・壁・金網の帯に収まっている', () => {
        // 帯の定義は `track-mesh.ts` の 1 か所にあり、生成ツールと共有している。
        // ここで確かめるのは「どの列がどの帯を引くか」の対応のほう
        const primitive = loadSector(LOD, 0);
        const uvs = primitive.uvs!;
        const inside = (u: number, slot: readonly [number, number]) =>
          u > slot[0] && u < slot[1];

        for (let ring = 0; ring <= LOD.segmentsPerSector; ring++) {
          for (let column = 0; column < RING_WIDTH; column++) {
            const u = uvs[(ring * RING_WIDTH + column) * 2]!;
            expect(u).toBeGreaterThan(0);
            expect(u).toBeLessThan(1);
            if (column >= roadStart(LOD) && column < roadStart(LOD) + roadColumnCount(LOD)) {
              expect(inside(u, TRACK_ATLAS_SLOTS.road), `列 ${column}`).toBe(true);
            }
            // 土手は草地の帯を引く（8-6）。木を植える地面なので草でよい
            if (column < 2 || column >= RING_WIDTH - 2) {
              expect(inside(u, TRACK_ATLAS_SLOTS.grass), `列 ${column}`).toBe(true);
            }
            if (isVertical(LOD, column)) {
              const wall = inside(u, TRACK_ATLAS_SLOTS.wall);
              const fence = LOD.fenceHeight !== null && inside(u, TRACK_ATLAS_SLOTS.fence);
              expect(wall || fence, `列 ${column} の u = ${u}`).toBe(true);
            }
          }
        }
      });

      it('金網は第4世代にだけ載り、壁の上端から立ち上がる', () => {
        const primitive = loadSector(LOD, 0);
        const uvs = primitive.uvs!;
        const positions = primitive.positions;
        const fenceColumns = [];
        for (let column = 0; column < RING_WIDTH; column++) {
          if (uvs[column * 2]! > TRACK_ATLAS_SLOTS.fence[0]) fenceColumns.push(column);
        }
        if (LOD.fenceHeight === null) {
          expect(fenceColumns, '金網を載せない世代に金網の UV がある').toEqual([]);
          return;
        }
        // 左右に 2 列ずつ（上端と下端）
        expect(fenceColumns).toHaveLength(4);
        // 下端は壁の上端と同じ高さ、上端はそこから `fenceHeight` だけ上
        const [topLeft, bottomLeft] = fenceColumns;
        const rise = positions[topLeft! * 3 + 1]! - positions[bottomLeft! * 3 + 1]!;
        expect(rise).toBeCloseTo(LOD.fenceHeight, 6);
      });

      it('中央の破線の両縁が頂点の列に乗っている（アフィン歪みで線が折れない）', () => {
        // 等分だけで割ると破線は四角形の境目（roadSpans が偶数なら t = 0.5）を跨ぎ、
        // 左右の半分が別々の傾きで補間されて食い違う。帯の縁を頂点にしておけば、
        // 線の横幅は頂点の投影そのものになり、u がどう歪んでも縁は折れない（8-11）
        const uvs = loadSector(LOD, 0).uvs!;
        const columns = Array.from({ length: RING_WIDTH }, (_, column) => uvs[column * 2]!);
        const at = (u: number) => columns.some((value) => Math.abs(value - u) < 1e-6);

        expect(at(TRACK_ATLAS.centerLine.from), '破線の左縁に列が無い').toBe(true);
        expect(at(TRACK_ATLAS.centerLine.to), '破線の右縁に列が無い').toBe(true);
        // 帯の内側に列は無い ＝ 幅 0 の四角形を作っていない
        expect(
          columns.filter(
            (u) =>
              u > TRACK_ATLAS.centerLine.from + 1e-6 && u < TRACK_ATLAS.centerLine.to - 1e-6,
          ),
        ).toEqual([]);
        // 帯は路面の中に収まり、路面の中心に乗っている（幅の 1 % 以内）
        const road = TRACK_ATLAS.road;
        expect(TRACK_ATLAS.centerLine.from).toBeGreaterThan(road.from);
        expect(TRACK_ATLAS.centerLine.to).toBeLessThan(road.to);
        const middle = (TRACK_ATLAS.centerLine.from + TRACK_ATLAS.centerLine.to) / 2;
        expect(Math.abs(middle - (road.from + road.to) / 2)).toBeLessThan(
          (road.to - road.from) * 0.01,
        );
      });

      it('破線の帯だけが白く塗られ、外側へ 1 texel も溢れていない', () => {
        // メッシュの列とテクスチャの塗りが同じ帯から出ていることの確認。
        // ずれていると、線の縁に沿ってアスファルトか白が 1 本残る
        const image = decodePng(
          readFileSync(join(process.cwd(), 'public', trackSurfaceTexture(LOD))),
        );
        const texel = (u: number) => Math.round(u * image.width);
        const from = texel(TRACK_ATLAS.centerLine.from);
        const to = texel(TRACK_ATLAS.centerLine.to);
        // texel の境界にちょうど乗る帯であること（nearest の第3世代で滲まない条件）
        expect(TRACK_ATLAS.centerLine.from * image.width).toBeCloseTo(from, 9);
        expect(TRACK_ATLAS.centerLine.to * image.width).toBeCloseTo(to, 9);
        expect(to - from).toBeGreaterThanOrEqual(3);

        // 破線が引かれている行（タイルの前半）で調べる
        const y = Math.floor(image.height / 4);
        const red = (x: number) => image.pixels[(y * image.width + x) * 4]!;
        for (let x = from; x < to; x++) {
          expect(red(x), `帯の内側 ${x} が白くない`).toBeGreaterThan(180);
        }
        expect(red(from - 1), '帯の左外が白い').toBeLessThan(120);
        expect(red(to), '帯の右外が白い').toBeLessThan(120);

        // タイルの後半は破線が切れている ＝ 流れて見える
        const gap = Math.floor((image.height * 3) / 4);
        expect(image.pixels[(gap * image.width + from) * 4]!).toBeLessThan(120);
      });

      it('路面の横分割が頂点量子化の揺れを面の波打ちに見せる細かさである', () => {
        // 1 マスが大きすぎると、揺れが「面の波打ち」ではなく「物体の平行移動」に見える
        const primitive = loadSector(LOD, 0);
        const positions = primitive.positions;
        const a = roadStart(LOD) * 3;
        const b = (roadStart(LOD) + 1) * 3;
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
