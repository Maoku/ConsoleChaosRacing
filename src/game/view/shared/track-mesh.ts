import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
} from '@console-chaos/engine';

/**
 * コースメッシュの LOD とセクター分割（実装計画 §2.6 / §3.4）。
 *
 * **`tools/build-track-mesh.mjs` と第3・第4世代のビューが共有する。**
 * 生成側と描画側でセクターの切り方がずれると、描かない区間ができたり
 * 継ぎ目が割れたりするので、定義は必ずここ 1 か所に置く。
 */

export interface TrackMeshLod {
  /** `public/assets/<directory>/models/` 以下に出力する */
  readonly directory: string;
  /** 周回をいくつのセクターに割るか */
  readonly sectorCount: number;
  /** 1 セクターあたりの輪の数。実際の刻みは trackLength /(sectorCount * segments) */
  readonly segmentsPerSector: number;
  /** 路面を横方向に何分割するか。粗すぎると頂点量子化が「面の波打ち」に見えない */
  readonly roadSpans: number;
  /** 路面アトラスの一辺 [px]。線形フィルタの世代は解像度を上げる */
  readonly textureSize: number;
  /** 自機のセクターから前後いくつ描くか。ここがそのまま描画距離の下限になる */
  readonly visibleRadius: number;
}

/**
 * 第3世代は 4 m 刻み。**あえて粗くするのではなく、細かくしすぎない**ことで
 * アフィンテクスチャの歪みと頂点量子化の揺れが画面に出る。
 *
 * 第4世代は 1 m 刻み。頂点量子化もアフィン歪みも無いので、細かさは
 * **標高とバンクの滑らかさ**にそのまま効く。横分割は第3世代と同じ 6 のままにして、
 * 差が「縦の刻み・解像度・フィルタ・ライティング」だけから出るようにしてある。
 *
 * セクターを 50 に割ってあるのは描画距離のカリングのため。1 セクター 62 m なので
 * 前後 5 つ（＝ 682 m の窓）でも 13,640 tri に収まり、前方は最低 310 m 保証される。
 * フォグ（`gen4-ps2.ts` の `FOG_DENSITY`）はその内側で閉じる。
 */
export const TRACK_MESH_LODS: GenerationVariant<TrackMeshLod | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: {
    directory: 'gen3',
    sectorCount: 8,
    segmentsPerSector: 97,
    roadSpans: 6,
    textureSize: 256,
    visibleRadius: 1,
  },
  PS2: {
    directory: 'gen4',
    sectorCount: 50,
    segmentsPerSector: 62,
    roadSpans: 6,
    textureSize: 512,
    visibleRadius: 5,
  },
});

export function trackMeshLodFor(generation: GenerationId): TrackMeshLod | null {
  return generationValue(TRACK_MESH_LODS, generation);
}

/** セクター GLB の URL。生成ツールもこの関数でファイル名を決める */
export function trackSectorAsset(lod: TrackMeshLod, sector: number): string {
  return `assets/${lod.directory}/models/track-${String(sector).padStart(2, '0')}.glb`;
}

/** 路面アトラスの URL。路面・縁石・草地を 1 枚に収めてある */
export function trackSurfaceTexture(lod: TrackMeshLod): string {
  return `assets/${lod.directory}/textures/track_surface.png`;
}

/** そのセクターが受け持つ弧長の範囲 [開始, 終了]。終了は次セクターの開始に一致する */
export function sectorRange(
  lod: TrackMeshLod,
  sector: number,
  trackLength: number,
): [number, number] {
  const span = trackLength / lod.sectorCount;
  return [sector * span, (sector + 1) * span];
}

/** 弧長 s を含むセクター番号 */
export function sectorAt(lod: TrackMeshLod, s: number, trackLength: number): number {
  const span = trackLength / lod.sectorCount;
  const index = Math.floor(s / span) % lod.sectorCount;
  return index < 0 ? index + lod.sectorCount : index;
}

/**
 * 描画するセクターの番号。自機のセクターとその前後 `visibleRadius` 個を描く。
 *
 * 自機はセクターのどこに居るか分からないので、**前方に保証される距離は
 * `visibleRadius × セクター長`** になる。フォグはその内側で閉じるよう決める
 * （第3世代は 1 × 387 m、第4世代は 5 × 62 m ＝ 310 m）。
 */
export function visibleSectors(lod: TrackMeshLod, s: number, trackLength: number): number[] {
  const center = sectorAt(lod, s, trackLength);
  const sectors: number[] = [];
  for (let offset = -lod.visibleRadius; offset <= lod.visibleRadius; offset++) {
    sectors.push((center + offset + lod.sectorCount) % lod.sectorCount);
  }
  return sectors;
}
