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
  /**
   * 壁の上に載せる金網フェンスの高さ [m]。`null` なら載せない（実装計画 8-6 / 8-10）。
   *
   * **第4世代だけが持つ。** 抜きの入ったテクスチャを引く面なので、
   * マテリアルに `alphaCutoff` が要る（`gen4-ps2.ts`）。深度バッファの無い第3世代で
   * 同じことをすると、抜けた画素の向こうにある物の順序が破綻する。
   * 「載せないこと」がそのまま世代差になる。
   */
  readonly fenceHeight: number | null;
}

/**
 * 路面アトラスの u 帯（実装計画 §2.6）。
 *
 * **`tools/build-track-mesh.mjs`・`scenery-mesh.ts`・`track-mesh.spec.ts` が共有する。**
 * 面ごとにテクスチャを分けられない（メッシュ 1 つにマテリアル 1 つ）ので、
 * 当時のテクスチャページと同じように 1 枚を帯で仕切る。
 *
 * 幅の配り方は**必要な密度**から決めてある。第4世代（512²）での texel/m は
 * 路面 15.8・縁石 26・草地 6.8・壁 41・フェンス 46・タイヤ 65。
 * 草地は粒しか無いので粗くてよく、タイヤとフェンスは形が読めなければ意味が無い。
 *
 * 各帯は境界から 0.012 だけ内側に UV を寄せてある。線形フィルタの世代で
 * 隣の帯がにじみ込まないための余白で、ミップマップは使われないので遠方でも混ざらない。
 */
export const TRACK_ATLAS = {
  /** 路面。左端 → 右端 */
  road: { from: 0.012, to: 0.388 },
  /**
   * 中央の破線が占める u 帯。**路面帯の内側に切ってある**（8-11）。
   *
   * 256² で 50〜53 texel、512² で 100〜106 texel。どちらも texel の境界にちょうど乗るので、
   * nearest の第3世代でも帯の内側は白 3 texel だけになり、外へ 1 画素も溢れない。
   * メッシュ側はこの境目を頂点の列にする（`roadColumns`）。
   */
  centerLine: { from: 50 / 256, to: 53 / 256 },
  /** 縁石。外 → 路面側 */
  curb: { outer: 0.412, inner: 0.448 },
  /** 草地と土手。外 → 内 */
  grass: { outer: 0.472, inner: 0.568 },
  /** 壁。下端 → 上端（u が縦に貼られる） */
  wall: { bottom: 0.592, top: 0.648 },
  /** 金網フェンス。下端 → 上端。第4世代だけが引く */
  fence: { bottom: 0.672, top: 0.848 },
  /** タイヤフェンス。背面 → 前面の頂点 → 背面（弧に沿って） */
  tyres: { bottom: 0.872, top: 0.988 },
} as const;

/**
 * v 方向のタイル長 [m]。テクスチャ 1 枚が進行方向に何 m を受け持つか。
 *
 * 路面は破線 1 周期・縁石は縞 1 周期・フェンスは支柱 1 本・タイヤは 4 本ぶん。
 * **タイヤだけは `scenery-mesh.ts` も読む** — 積んだタイヤの継ぎ目が
 * メッシュの分割と合わないと、タイヤの真ん中に溝が来る。
 */
export const TRACK_ATLAS_TILES = {
  road: 8,
  curb: 4,
  grass: 6,
  wall: 4,
  fence: 4,
  tyres: 2.8,
} as const;

/** アトラスを 6 つに仕切る境界。テクスチャを塗るときの区画（UV はこの内側に収まる） */
export const TRACK_ATLAS_SLOTS = {
  road: [0, 0.4],
  curb: [0.4, 0.46],
  grass: [0.46, 0.58],
  wall: [0.58, 0.66],
  fence: [0.66, 0.86],
  tyres: [0.86, 1],
} as const;

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
    fenceHeight: null,
  },
  PS2: {
    directory: 'gen4',
    sectorCount: 50,
    segmentsPerSector: 62,
    roadSpans: 6,
    textureSize: 512,
    visibleRadius: 5,
    // 壁の上に 2.2 m の金網。抜きのある面なのでマテリアルに alphaCutoff が要る
    fenceHeight: 2.2,
  },
});

export function trackMeshLodFor(generation: GenerationId): TrackMeshLod | null {
  return generationValue(TRACK_MESH_LODS, generation);
}

/**
 * 路面を横に割る列の位置 t（0 ＝ 左端 / 1 ＝ 右端）。**`roadSpans` の等分に加えて、
 * 中央の破線の両縁を必ず列にする**（8-11）。
 *
 * 等分だけで割ると、破線は四角形の境目（`roadSpans` が偶数なら t = 0.5）に跨がる。
 * アフィンテクスチャの u は三角形ごとに別々の傾きで補間されるので、跨いだ線は
 * 左半分と右半分が別々に歪み、境目で食い違って折れる — 第3世代の実画面で
 * 中央線が手前ほど太い楔に崩れていたのはこれ。
 *
 * 帯の縁を頂点にしてしまえば、線の横幅は**頂点の投影そのもの**になる。
 * 四角形の内側で u がどう歪んでも、帯の内側は白・外側はアスファルトのままで、
 * 縁が折れることは無い。縦（v）方向の歪み ＝ 破線の伸び縮みは残るので、
 * 「アフィン歪みを打ち消さない」という第3世代の設計はそのまま。
 *
 * 増えるのは 1 輪あたり四角形 1 つ（＝三角形 2 つ）だけ。第4世代は
 * パースペクティブ補正が効くので元から折れないが、**同じ断面から焼く**ため列も揃える。
 *
 * **`tools/build-track-mesh.mjs` と `tests/track-mesh.spec.ts` が共有する。**
 */
export function roadColumns(lod: TrackMeshLod): number[] {
  const width = TRACK_ATLAS.road.to - TRACK_ATLAS.road.from;
  const from = (TRACK_ATLAS.centerLine.from - TRACK_ATLAS.road.from) / width;
  const to = (TRACK_ATLAS.centerLine.to - TRACK_ATLAS.road.from) / width;
  const columns: number[] = [];
  for (let span = 0; span <= lod.roadSpans; span++) {
    const t = span / lod.roadSpans;
    // 帯の中（と縁そのもの）に落ちる等分点は捨てる。幅 0 の四角形を作らないため
    if (t >= from && t <= to) continue;
    columns.push(t);
  }
  columns.push(from, to);
  columns.sort((left, right) => left - right);
  return columns;
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
