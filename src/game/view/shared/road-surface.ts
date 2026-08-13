import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
} from '@console-chaos/engine';

/**
 * 擬似3D世代（第1・第2）が引く路面テクスチャの仕様（実装計画 §3.2 / §3.3 / §8）。
 *
 * **`tools/build-road-texture.mjs` とビューが共有する。** 生成側と描画側で
 * 「テクスチャの何 % が路面か」がずれると路面幅がそのままずれるので、
 * 定義は必ずここ 1 か所に置く（`track-mesh.ts` と同じ方針）。
 *
 * ## なぜ同梱の `road.png` / `circuit.png` をそのまま使わないか
 *
 * 第1世代のエンジンは走査線の `width`（＝画面幅が覆うテクスチャの U 幅）を
 * **(0, 1] に制限**する。距離 z の行の路面が画面に占める幅は
 *
 *     roadPx(z) = roadFraction * screenWidth / width(z)
 *
 * なので、`width` が 1 を超えられない以上 **路面は `roadFraction * screenWidth` より
 * 細くならない**。`road.png` は路面がテクスチャ幅の 44.5% を占めるため、下限は
 * 256 × 0.445 ≒ 114 px — 画面の半分近い帯で止まってしまい、「奥に進む」感が出ない。
 *
 * そこで路面をテクスチャ幅の 1/7 に収めた広い路面テクスチャを生成する。
 * 実装計画 §8 のリスク表が挙げている対処（「`road.png` を横に広い版として再生成し
 * `TEX_W` を拡大する」）そのものであり、生成物はリポジトリにコミットする（§2.6）。
 *
 * 第2世代のアフィン面には幅の制限が無いので、同じ理由では縛られない。それでも
 * 同梱の `circuit.png` は使わない — 路面が幅の 51% を占めるうえ**草地に高周波の
 * ディザ**が入っており、1 行が数十メートルを跨ぐ遠方でちらつくため。第2世代ぶんも
 * 同じ生成器で焼き、色数（RGB555・同時 256 色）ぶんだけ階調を増やす。
 *
 * ## 数値の決め方（第1世代）
 *
 * `width(z) = screenWidth * z / (spanMeters * focal)` なので、1 本のサーフェスで
 * 覆える距離の比は `width` の可動域そのものになる。8bit 量子化の刻みが
 * `0.5/255 / width` の相対誤差として効くため、下限を 0.09 あたりで止める。
 *
 *   - `width ∈ [0.09, 1]` ⇒ 距離の比は 11 倍
 *   - 路面の画面幅は最遠で `roadFraction * 256 ≒ 37 px`、最近ではみ出す
 *   - カメラ高は `width下限 * spanMeters * (画面下端 - 地平線) / 画面幅` で決まる
 *
 * この 3 つが噛み合うよう `spanMeters` を 84 m に採った。詳細は `projection.ts`。
 */

/** 路面から外側へ向かって並ぶ草地の帯。最後の 1 本は `width: Infinity` で締める */
export interface GrassBand {
  /** 帯の幅 [m] */
  readonly width: number;
  readonly color: string;
}

/**
 * 路面テクスチャの色。
 *
 * **その世代のハードウェアが実際に出せる値そのものを置く。**
 * 第1世代は 54 色マスターパレットの値（レンダラーは最近傍で丸めるので、外れた色は
 * 隣の色と同じ枠に落ちて塗り分けが消える。実際、初版の砂色 `#a08050` は路面と同じ灰へ
 * 落ちていた）。第2世代は RGB555 の格子＝**各チャンネル 8 の倍数**にする。
 */
export interface RoadSurfaceColors {
  readonly asphalt: string;
  /** 路肩寄りの摩耗した舗装。`wearWidth` が 0 の世代では使われない */
  readonly asphaltWorn: string;
  readonly line: string;
  readonly kerbRed: string;
  readonly kerbPale: string;
  readonly runoff: string;
  /** 路面から外側へ向かう草地の帯 */
  readonly grass: readonly GrassBand[];
}

/**
 * 実機の BG 面としての制約（実装計画 8-2）。
 *
 * SFC の Mode 7 面は 128×128 タイル ＝ 1024×1024 px だが、**タイルの実体は 256 種**
 * しか置けない（8bpp・面あたり 256 タイル）。全画素ユニークなテクスチャは実機には
 * 焼けない情報量を持っており、それが遠方のちらつきとして出る。
 *
 * `tools/build-road-texture.mjs` が焼いた絵のユニークタイルを数え、
 * 超えたら**生成を失敗させる** — 実機に無い絵をリポジトリへ入れないための門。
 */
export interface RoadTileGrid {
  /** タイルの一辺 [px] */
  readonly size: number;
  /** 置けるユニークタイルの上限 */
  readonly maxUniqueTiles: number;
}

/** 路面テクスチャのレイアウト。単位はメートル（テクスチャ画素ではない） */
export interface RoadSurfaceLayout {
  readonly texture: string;
  /** テクスチャの画素数 */
  readonly textureWidth: number;
  readonly textureHeight: number;
  /** テクスチャ幅 1 枚が表す横方向の世界の広さ [m]（＝ TEX_W） */
  readonly spanMeters: number;
  /** テクスチャ高さ 1 枚が表す進行方向の距離 [m]（＝ TEX_L）。V はこの周期で巡る */
  readonly periodMeters: number;
  /** 舗装の半幅 [m]。コース定義の既定半幅と一致させる */
  readonly roadHalfWidth: number;
  /** 縁石の幅 [m] */
  readonly kerbWidth: number;
  /** 縁石の外側の土のランオフの幅 [m] */
  readonly runoffWidth: number;
  /** 路肩側の舗装が摩耗している幅 [m]。0 なら一様な舗装 */
  readonly wearWidth: number;
  /** センターライン／路肩線の幅 [m] */
  readonly lineWidth: number;
  /** 路肩線の位置（中心からの距離）[m] */
  readonly edgeLineOffset: number;
  /** センターラインの塗り [m] と間隔 [m] */
  readonly dashMeters: number;
  readonly dashGapMeters: number;
  /** 縁石の縞 1 本の長さ [m] */
  readonly kerbStripeMeters: number;
  /** BG 面としてのタイル制約。持たない世代（ラスター面の第1世代）は `null` */
  readonly tileGrid: RoadTileGrid | null;
  readonly colors: RoadSurfaceColors;
}

const FC_ROAD: RoadSurfaceLayout = {
  texture: 'assets/gen1/road/road_wide.png',
  textureWidth: 1024,
  textureHeight: 256,
  spanMeters: 84,
  // センターラインの周期（塗り 8 m ＋ 間隔 16 m）がちょうど 4 回入る長さ。
  // 6Hz 表示では 1 フレームに 10 m 進むので、これより短い周期は速度が読めなくなる
  periodMeters: 96,
  roadHalfWidth: 6,
  kerbWidth: 0.9,
  runoffWidth: 2,
  wearWidth: 0,
  lineWidth: 0.36,
  edgeLineOffset: 5.6,
  dashMeters: 8,
  dashGapMeters: 16,
  kerbStripeMeters: 12,
  // ラスター面はタイル面ではない（走査線ごとに U を引き直す専用パス）ので、
  // 8×8 タイル 256 種の制約は掛からない
  tileGrid: null,
  colors: {
    asphalt: '#545454',
    asphaltWorn: '#545454',
    line: '#eceeec',
    kerbRed: '#982220',
    kerbPale: '#eceeec',
    runoff: '#783c00',
    grass: [
      { width: 7, color: '#287200' },
      { width: Number.POSITIVE_INFINITY, color: '#083a00' },
    ],
  },
};

/**
 * 第2世代のアフィン面が引く路面。
 *
 * 幅の制限が無いぶん `spanMeters` は「最遠の行で画面が覆う横幅」を上回るように採る
 * （220 m 先で 256 px の画面が覆うのは 188 m）。こうしておけば `wrap: 'clamp'` で
 * 端が草地へ伸び、**コーナーの先に二本目の道路が現れることが起こらない**。
 *
 * V の模様（破線・縁石の縞）は 24 m 周期で、テクスチャ 1 枚にちょうど 4 周期入る。
 * この「4 周期ぶんの余白」が、走査線を傾けたとき V が端からはみ出さないための
 * 遊びになる（`affine-surface.ts` の `patternPeriodMeters` を参照）。
 *
 * ## 解像度を SFC の BG スペックへ落とす（実装計画 8-2）
 *
 * 初版は 1024×512（10.7 × 5.3 texel/m）の**全画素ユニーク**で、実機の Mode 7 面には
 * 焼けない情報量を持っていた。最遠 220 m の行は画面 1 px が 0.73 m にあたるので、
 * そのテクスチャを 14 倍に縮小して nearest で引くことになり、遠方がちらつく。
 *
 * そこで **512×256（5.3 × 2.7 texel/m）** に落とし、模様の寸法をテクセル格子へ
 * 載せ直した。`spanMeters` / `periodMeters` は 96 m のまま — 投影も、V を 1 周期
 * ずらせる性質（§3.3）も触らず、**密度だけ**を落とす。近景はそのぶん粗くブロックに
 * 見えるが、**それが Mode 7 の見え方そのもの**である。
 *
 * V 方向の模様の境目（破線・縁石の縞）は 8×8 タイルの境界へ載せてある
 * （2.667 texel/m なので 3 m ＝ 8 texel の倍数）。ユニークタイル数を 256 以内に
 * 収めるための条件で、`tileGrid` を持つかぎり生成ツールが数えて門を掛ける。
 */
const SFC_ROAD: RoadSurfaceLayout = {
  texture: 'assets/gen2/road/road_affine.png',
  textureWidth: 512,
  textureHeight: 256,
  spanMeters: 96,
  periodMeters: 96,
  roadHalfWidth: 6, // 32 texel ＝ 4 タイル
  kerbWidth: 0.9375, // 5 texel
  runoffWidth: 2.25, // 12 texel
  wearWidth: 0.5625, // 3 texel
  lineWidth: 0.375, // 2 texel
  edgeLineOffset: 5.625, // 30 texel
  // V は 2.667 texel/m。破線は 24 texel（3 タイル）＋ 40 texel（5 タイル）で 24 m 周期、
  // 縁石の縞は 32 texel（4 タイル）。どちらもタイル境界で切り替わる
  dashMeters: 9,
  dashGapMeters: 15,
  kerbStripeMeters: 12,
  tileGrid: { size: 8, maxUniqueTiles: 256 },
  colors: {
    asphalt: '#505860',
    asphaltWorn: '#606870',
    line: '#f0f0e8',
    kerbRed: '#c02828',
    kerbPale: '#f0f0f0',
    runoff: '#a08058',
    // 帯の幅もテクセル格子へ載せる（5.25 m ＝ 28 texel・10.5 m ＝ 56 texel）
    grass: [
      { width: 5.25, color: '#388830' },
      { width: 10.5, color: '#287028' },
      { width: Number.POSITIVE_INFINITY, color: '#185820' },
    ],
  },
};

/**
 * 世代ごとの路面テクスチャ。第3・第4世代は 3D メッシュなので持たない。
 * `null` を返す世代のビューは、そもそもこのモジュールを使わない。
 */
export const ROAD_SURFACES: GenerationVariant<RoadSurfaceLayout | null> = defineGenerationVariant({
  FC: FC_ROAD,
  SFC: SFC_ROAD,
  PS1: null,
  PS2: null,
});

export function roadSurfaceFor(generation: GenerationId): RoadSurfaceLayout | null {
  return generationValue(ROAD_SURFACES, generation);
}

/**
 * 路面（舗装）がテクスチャ幅に占める割合。
 * ここが小さいほど遠くまで路面を細く描けるが、近景の拡大率が上がる。
 */
export function roadFraction(layout: RoadSurfaceLayout): number {
  return (layout.roadHalfWidth * 2) / layout.spanMeters;
}

/**
 * V 方向の模様が繰り返す周期 [m]。
 *
 * 破線と縁石の縞がどちらも同じ周期なら、テクスチャの V は**その周期ごとに同じ絵**になる。
 * アフィン面はこの性質を使って、走査線の V 範囲をテクスチャの内側へ寄せる
 * （`clamp` でも端が潰れないようにする）。周期が揃っていない場合は 1 枚ぶんを返す。
 */
export function patternPeriodMeters(layout: RoadSurfaceLayout): number {
  const dash = layout.dashMeters + layout.dashGapMeters;
  const kerb = layout.kerbStripeMeters * 2;
  return dash === kerb ? dash : layout.periodMeters;
}
