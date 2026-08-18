import type { TrackBounds } from '../../sim/track.js';
import type { RoadSurfaceLayout, RoadTileGrid } from './road-surface.js';

/**
 * 第2世代の路面を「コース全体のトップダウン図」として持つための定義（実装計画 §3.3 の改善案）。
 *
 * ## なぜ帯テクスチャから乗り換えるか
 *
 * 帯（`road_affine.png`）は直線路 1 本を V 方向へ流すもので、コーナーは
 * 走査線ごとに U をずらして**それらしく見せている**。真上から見たコースの形は
 * どこにも無いので、ヘアピンでも視界は `MAX_TILT` で頭打ちにした演出ぶんしか回らない。
 * マップを引けば、UV がワールド XZ の写像そのものになり、**回転は投影の帰結として出る**。
 *
 * ## 実機の Mode 7 面は 1024×1024 px しかない
 *
 * コースの外接矩形は 805 × 527 m ある。これを 1024² へそのまま載せると 1 texel = 1 m で、
 * 路面 12 m がわずか 12 texel — 画面最下行が横 6 texel の塊になる。使いものにならない。
 *
 * そこで**1024² を窓として扱う**。実機も大きなコースでは Mode 7 のタイルマップを
 * VBlank の DMA で書き換えながら走らせており（＝カメラが進むと端の列が入れ替わる）、
 * VRAM に載っているのは常にカメラ周辺だけだった。ここではその「VRAM の中身」を
 * **窓 `windowPixels` 四方**として定義し、テクスチャ自体はコース全体を持つ。
 * 実行時のストリーム処理は要らず、代わりに
 *
 *   1. 1 フレームで引く地面が必ず 1 つの窓に収まる
 *   2. どの窓の中のユニーク 8×8 タイルも `maxUniqueTiles` 以内
 *   3. 窓が動くとき 1 フレームに入れ替わるエントリ数が DMA 予算以内
 *
 * を**テストで担保する**（`road-map.spec.ts`）。実機に無い絵をリポジトリに入れない、
 * という `road-surface.ts` の門と同じ考え方を、面の大きさへ広げたものになる。
 *
 * ## 密度の決まり方
 *
 * 1 フレームで地面を引く範囲（フットプリント）の外接正方形を全周で測ると、
 * 遠クリップ `farClip` に対しておおよそ次のようになる。
 *
 * ```
 *   遠クリップ 220 m → 窓 234 m（4.38 texel/m）
 *              250 m → 窓 267 m（3.84 texel/m）
 *              260 m → 窓 277 m（3.69 texel/m）
 *              300 m → 窓 321 m（3.19 texel/m）
 *              クリップ無し → 窓 383 m（2.67 texel/m）
 * ```
 *
 * `SFC_DRAW_DISTANCE` は 220 m だが、**下り坂ではカメラと路面の高さの差が開き、
 * 最上行が 358 m 先まで見る**。そこまで窓に入れると密度が 2.67 texel/m まで落ちるので、
 * マップを引く距離だけ `farClip` で止める。止めた先の行は 4 枚目のフォグ帯（150 m）の
 * さらに奥＝ 94% が霞んでおり、地面の絵は 6% しか効かない。
 */
export interface RoadMapLayout {
  readonly texture: string;
  /** 1 m あたりの texel 数 */
  readonly texelsPerMeter: number;
  /** 実機の Mode 7 面（＝ VRAM に載る窓）の一辺 [px] */
  readonly windowPixels: number;
  /** 窓の中のタイル制約。実体 256 種は面あたりの上限そのもの */
  readonly tileGrid: RoadTileGrid;
  /** マップを引く距離の上限 [m]。これより奥の行は同じ距離の地面を引く */
  readonly farClip: number;
  /** コースの外接矩形の外側に取る余白 [m]。草地の帯が途切れないぶん */
  readonly marginMeters: number;
  /** VBlank 1 回で書き換えられるタイルマップのエントリ数 [byte]（実用値） */
  readonly dmaBytesPerFrame: number;
  /** タイルの語彙を作るときの幾何の刻み */
  readonly quantize: RoadMapQuantize;
}

/**
 * タイル 1 枚の中身を決める 3 つの量（実装計画 8-2）。
 *
 * 自由に描くとユニークタイルが 7000 種を超え、実機の面（実体 256 種）に載らない。
 * タイルの中身は
 *
 *   (路面の向き θ, 中心線からの距離 e, 進行方向の位相 a)
 *
 * だけで決まるので、この 3 つを刻めば語彙の大きさが決まる。刻んだうえでなお
 * 余る種類は `build-road-map.mjs` が**絵として近いタイルへ束ねて** 256 種に収める。
 *
 * ## なぜ角度を 16 段階（22.5°）で止めるか
 *
 * 8 段階（45°）まで落とせば束ねずに 256 種へ入るが、**縁石と白線が角ごとにちぎれる**。
 * 細い模様は位置の量子化に耐えられない。16 段階にして束ねるほうが、同じ 256 種でも
 * 模様が繋がる。実際に焼いて比べた結果であり、数字はそこから決めた。
 */
export interface RoadMapQuantize {
  /** 向きを 1 周で何段階に刻むか */
  readonly angles: number;
  /** 中心線からの距離の刻み [texel] */
  readonly lateralTexels: number;
  /** 破線・縁石の縞の位相の刻み [texel] */
  readonly alongTexels: number;
}

export const SFC_ROAD_MAP: RoadMapLayout = {
  texture: 'assets/gen2/road/road_map.png',
  // 窓 1024 px ＝ 288 m。遠クリップ 250 m でのフットプリント 267 m に、
  // タイル格子への吸着（±1.1 m）と余裕を足した値
  texelsPerMeter: 32 / 9,
  windowPixels: 1024,
  tileGrid: { size: 8, maxUniqueTiles: 256 },
  farClip: 250,
  marginMeters: 30,
  // 実機の VBlank で VRAM へ流せる実用量。タイルマップは 1 エントリ 1 byte
  dmaBytesPerFrame: 6144,
  quantize: { angles: 16, lateralTexels: 1, alongTexels: 4 },
};

/**
 * マップに焼く断面（`road-surface.ts` の第2世代の断面からの差分）。
 *
 * **帯テクスチャは 1 本の直線路を引き伸ばすので、模様をいくら細かくしても
 * タイルの種類は増えない。** マップは違う — 同じ模様がコース 3.1 km ぶんの
 * あらゆる角度で現れるので、**細部の 1 本 1 本がそのまま語彙を食う**。
 * 実測では、路肩線・摩耗した舗装・3 段階の草地を持ったままだと、
 * 角度を 45° 刻みまで落としても 256 種に入らなかった。
 *
 * そこで Mode 7 面に載る断面へ作り直す。考え方は当時のコースマップと同じで、
 * **残す模様は太くし、読めない模様は最初から描かない**。
 *
 *   - 草地は 1 色（帯の境目が路面と平行に 3.1 km 続き、語彙をいちばん食っていた）
 *   - 路肩の摩耗と路肩線を落とす（1〜2 texel で、どのみち読めない）
 *   - 縁石を 0.94 m → 1.69 m（6 texel）、センターラインを 0.375 m → 0.5625 m（2 texel）へ
 *     **太くする**。実寸より太いが、これは当時のコースマップがどれもやっていたこと
 */
export function roadMapSurface(layout: RoadSurfaceLayout): RoadSurfaceLayout {
  return {
    ...layout,
    kerbWidth: 1.6875,
    lineWidth: 0.5625,
    edgeLineOffset: 0,
    colors: {
      ...layout.colors,
      asphaltWorn: layout.colors.asphalt,
      grass: [{ width: Number.POSITIVE_INFINITY, color: layout.colors.grass[1]!.color }],
    },
  };
}

/** マップ 1 タイルが表す世界の広さ [m] */
export function tileMeters(layout: RoadMapLayout): number {
  return layout.tileGrid.size / layout.texelsPerMeter;
}

/** 窓（＝ VRAM に載る Mode 7 面）が表す世界の広さ [m] */
export function windowMeters(layout: RoadMapLayout): number {
  return layout.windowPixels / layout.texelsPerMeter;
}

/**
 * マップの画素とワールド XZ の対応。
 *
 * **原点はタイル格子へ吸着させる。** 窓はマップの部分矩形をタイル境界で切り出したもの
 * として数えるので、格子がワールドに対して固定されていないと「窓の中のタイル数」が
 * 切り出し位置ごとに変わってしまう。
 */
export interface RoadMapProjection {
  /** texel (0, 0) の中心が指すワールド XZ [m] */
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly height: number;
  readonly texelsPerMeter: number;
}

export function roadMapProjection(
  bounds: TrackBounds,
  layout: RoadMapLayout = SFC_ROAD_MAP,
): RoadMapProjection {
  const meters = tileMeters(layout);
  const originX = Math.floor((bounds.min[0] - layout.marginMeters) / meters) * meters;
  const originZ = Math.floor((bounds.min[1] - layout.marginMeters) / meters) * meters;
  const spanX = bounds.max[0] + layout.marginMeters - originX;
  const spanZ = bounds.max[1] + layout.marginMeters - originZ;
  return {
    originX,
    originZ,
    width: Math.ceil(spanX / meters) * layout.tileGrid.size,
    height: Math.ceil(spanZ / meters) * layout.tileGrid.size,
    texelsPerMeter: layout.texelsPerMeter,
  };
}

/** ワールド XZ → マップ UV（[0, 1] の外へも出る。外はマップ外周の色で clamp される） */
export function mapUv(
  projection: RoadMapProjection,
  x: number,
  z: number,
): readonly [number, number] {
  return [
    ((x - projection.originX) * projection.texelsPerMeter) / projection.width,
    ((z - projection.originZ) * projection.texelsPerMeter) / projection.height,
  ];
}

/** 1 フレームで地面を引く範囲。台形なので 4 隅で外接矩形が決まる */
export interface RoadMapFootprint {
  /** カメラのワールド XZ */
  readonly cameraX: number;
  readonly cameraZ: number;
  /** 視線方向と右方向（XZ の単位ベクトル） */
  readonly forwardX: number;
  readonly forwardZ: number;
  readonly rightX: number;
  readonly rightZ: number;
  /** 引く距離の手前と奥 [m]。奥は `farClip` で止めた値 */
  readonly near: number;
  readonly far: number;
  /** 画面端が距離 1 m あたりに広がる量（＝ 画面半幅 / 焦点距離） */
  readonly spread: number;
}

/**
 * このフレームで VRAM に載っている窓（＝ Mode 7 面）の左上のタイル座標。
 *
 * 窓は**フットプリントの外接矩形の中心**へ置き、タイル格子へ吸着させる。
 *
 * 「カメラの N m 前方」と決め打ちにすると足りない — 台形の外接矩形は視線が
 * ワールド軸に対してどう傾いているかで形が変わり、斜め 45° を向いたときにいちばん
 * 大きくなる。実測では固定の前方 130 m で 0.9 タイルはみ出した。4 隅から求めれば
 * 計算は同じだけ軽く、はみ出しは構造的に起きない。
 *
 * 吸着させるのは、窓が動くときに入れ替わるのが**列 1 本ぶん**になるようにするため —
 * 実機の DMA はタイルマップのエントリを列単位で流し込む。
 *
 * 実行時はこの窓を意識せずマップ全体を UV で引くが、`road-map.spec.ts` が
 * 「1 フレームで引く地面がこの窓に収まる」「窓の中のタイルが 256 種以内」
 * 「窓が動くとき 1 フレームに入れ替わるエントリ数が DMA 予算以内」を確かめる。
 */
export function roadMapWindow(
  projection: RoadMapProjection,
  layout: RoadMapLayout,
  footprint: RoadMapFootprint,
): readonly [number, number] {
  const { cameraX, cameraZ, forwardX, forwardZ, rightX, rightZ, near, far, spread } = footprint;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const distance of [near, far]) {
    const half = distance * spread;
    for (const offset of [-half, half]) {
      const x = cameraX + forwardX * distance + rightX * offset;
      const z = cameraZ + forwardZ * distance + rightZ * offset;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const meters = tileMeters(layout);
  const half = windowMeters(layout) / 2;
  return [
    Math.round(((minX + maxX) / 2 - half - projection.originX) / meters),
    Math.round(((minZ + maxZ) / 2 - half - projection.originZ) / meters),
  ];
}
