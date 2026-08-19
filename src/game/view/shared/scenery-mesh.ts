import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type MeshCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import type { SceneryObject } from '../../sim/scenery.js';

/**
 * 第4世代のタイヤフェンス（実装計画 8-6 / 8-10）。
 *
 * **第4世代だけ**に置く。第3世代へ足さないのは ordering table のスロットと
 * ドローコールを増やさないためで、「置かないこと」がそのまま世代差になる。
 *
 * 壁（コースメッシュへ焼き込み）と違って、タイヤフェンスは高曲率区間の外側に
 * 点在するだけなので、独立したメッシュを `rotationY` で向けて置ける
 * — 壁が焼き込みなのは、バンクのついた路面に沿わせるには X/Z 回転が要るからである。
 *
 * ## 箱から円柱へ（8-10）
 *
 * 初版は 4 × 1.1 × 0.9 m の箱に壁のテクスチャを貼っただけで、実画面では
 * **タイヤに見えず低いコンクリートの塊にしか見えなかった**。タイヤの見えを作るのは
 * 色ではなく**丸い輪郭**なので、段ごとに円柱を通す形へ作り直した。
 * 三角形は 1 基あたり 20 → 60 に増えるが、同時に見えるのは 20 基ほどで
 * 合計 1,200 tri しかない（車 1 台が 13,600 tri であることと比べればよい）。
 *
 * 円柱は**左右対称**なので、コースのどちら側に置いても同じ 1 つの GLB で足りる。
 * 実際に積んだタイヤも両側から丸く見えるので、形の都合と実物が一致している。
 *
 * **このファイルは `tools/build-scenery-mesh.mjs` と共有する。**
 */
export const TYRE_WALL = {
  asset: 'assets/gen4/models/tyre-wall.glb',
  /** コースの接線方向の長さ [m] */
  length: 4,
  height: 1.1,
  /** 積む段数。1 段 ＝ タイヤ 1 本の直径 */
  rows: 3,
  /** 円柱の分割数。10 面あれば 640×448 で角が見えない */
  facets: 10,
} as const;

/** タイヤ 1 本の半径 [m]。段数と全高から決まる（実車の 15 インチとほぼ同じ） */
export function tyreRadius(): number {
  return TYRE_WALL.height / TYRE_WALL.rows / 2;
}

/**
 * タイヤフェンスを置く世代と、その描画距離 [m]。`null` なら置かない。
 * 世代 ID の分岐をビューへ書かないための表（§1.4）。
 */
export const TYRE_WALLS: GenerationVariant<number | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: null,
  PS2: 280,
});

/** その世代がタイヤフェンスをメッシュで置くなら描画距離、置かないなら `null` */
export function tyreWallDrawDistance(generation: GenerationId): number | null {
  return generationValue(TYRE_WALLS, generation);
}

export interface TyreWallOptions {
  readonly generation: GenerationId;
  readonly track: Track;
  readonly objects: readonly SceneryObject[];
  readonly material: string;
  readonly camera: readonly [number, number, number];
  readonly drawDistance: number;
}

/**
 * タイヤフェンスのメッシュ。コースの接線へ向けて路面の外側へ置く。
 *
 * **向きの式は車とは違う。** 車 GLB の前方は -X（変換の記録どおり）だが、
 * こちらは自分で焼いたメッシュで前方を +X に採ってある。`rotationY(θ)` は
 * (1, 0, 0) を (cos θ, 0, −sin θ) へ写すので、進行方向 (cos H, 0, sin H) に
 * 合わせると **θ = −H** になる。
 */
export function tyreWallMeshes(options: TyreWallOptions): MeshCommand[] {
  const { generation, track, camera } = options;
  const meshes: MeshCommand[] = [];

  for (const object of options.objects) {
    if (object.kind !== 'tyres') continue;
    const world = track.toWorld(object.s, object.lateral);
    const away = Math.hypot(
      world[0] - camera[0],
      world[1] - camera[1],
      world[2] - camera[2],
    );
    if (away > options.drawDistance) continue;

    meshes.push({
      id: `tyre-wall-${generation}-${object.id}`,
      geometry: { kind: 'quad', halfSize: [1, 1] },
      asset: TYRE_WALL.asset,
      transform: {
        position: [world[0], world[1], world[2]],
        rotationY: -track.sampleAt(object.s).heading,
      },
      color: '#ffffff',
      material: options.material,
      generations: [generation],
    });
  }

  return meshes;
}
