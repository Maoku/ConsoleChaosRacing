/**
 * 第1世代のラスターサーフェスが引く路面テクスチャの仕様（実装計画 §3.2 / §8）。
 *
 * **`tools/build-road-texture.mjs` とビューが共有する。** 生成側と描画側で
 * 「テクスチャの何 % が路面か」がずれると路面幅がそのままずれるので、
 * 定義は必ずここ 1 か所に置く（`track-mesh.ts` と同じ方針）。
 *
 * ## なぜ同梱の `road.png` をそのまま使わないか
 *
 * エンジンは走査線の `width`（＝画面幅が覆うテクスチャの U 幅）を **(0, 1] に制限**する。
 * 距離 z の行の路面が画面に占める幅は
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
 * ## 数値の決め方
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
  /** 草地の明暗が切り替わる、ランオフ外側からの距離 [m] */
  readonly grassBandWidth: number;
  /** センターライン／路肩線の幅 [m] */
  readonly lineWidth: number;
  /** 路肩線の位置（中心からの距離）[m] */
  readonly edgeLineOffset: number;
  /** センターラインの塗り [m] と間隔 [m] */
  readonly dashMeters: number;
  readonly dashGapMeters: number;
  /** 縁石の縞 1 本の長さ [m] */
  readonly kerbStripeMeters: number;
}

export const ROAD_SURFACE: RoadSurfaceLayout = {
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
  grassBandWidth: 7,
  lineWidth: 0.36,
  edgeLineOffset: 5.6,
  dashMeters: 8,
  dashGapMeters: 16,
  kerbStripeMeters: 12,
};

/**
 * 路面（舗装）がテクスチャ幅に占める割合。
 * ここが小さいほど遠くまで路面を細く描けるが、近景の拡大率が上がる。
 */
export function roadFraction(layout: RoadSurfaceLayout = ROAD_SURFACE): number {
  return (layout.roadHalfWidth * 2) / layout.spanMeters;
}

/**
 * 色（能力契約 §1.4）。
 *
 * **すべて第1世代の 54 色マスターパレットの値そのもの**にしてある。
 * レンダラーは最近傍で丸めるので、外れた色を置くと隣の色と同じ枠に落ちて
 * 塗り分けが消える（実際、初版の砂色 `#a08050` は路面と同じ灰へ落ちていた）。
 * 5 色しか使わないので、同時 25 色の予算にも遠く届かない。
 */
export const ROAD_COLORS = {
  asphalt: '#545454',
  line: '#eceeec',
  kerbRed: '#982220',
  kerbPale: '#eceeec',
  runoff: '#783c00',
  grassNear: '#287200',
  grassFar: '#083a00',
} as const;
