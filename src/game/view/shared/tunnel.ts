import type { Track } from '../../sim/track.js';
import type { TrackMeshLod } from './track-mesh.js';

/**
 * トンネル区間（実装計画 8-9）。
 *
 * **背景オブジェクトと同じ方針で、1 つの表から 4 世代ぶんを出す。**
 * 位置も寸法もここにしか書かれておらず、生成ツール（`tools/build-tunnel-mesh.mjs`）と
 * 実行時の 4 つのビューが同じ定数を読む。`scenery.ts` の配置表と同じ性質で、
 * 乱数も状態も持たないので生成側と描画側が必ず一致する。
 *
 * 世代ごとの出し方は違う。
 *
 * | 世代 | 出し方 |
 * | --- | --- |
 * | 第1世代 | 走査線の `brightness` を落とす ＋ 坑口を BG 相当の矩形で抜く |
 * | 第2世代 | color math の subtract 帯で路面を落とす ＋ 同じ坑口 |
 * | 第3世代 | 焼いたトンネルメッシュ（ordering table の路面と同じ範囲へ分配） |
 * | 第4世代 | 同じメッシュ ＋ 照明の入れ替え（環境光・太陽・ナトリウム灯）|
 *
 * **擬似3D の 2 世代に「トンネルのメッシュ」は無い。** 実機の擬似3D racer が
 * トンネルをどう出していたか（路面のパレットを落とし、坑口を BG のタイルで描く）
 * そのままであり、同じ世界を 4 通りに描くというこの作品の主張の一部になる。
 */

/**
 * 区間 [from, to)（弧長 [m]）。
 *
 * 戻りのストレート（s ≒ 2384–2795）の中に採る。**この 220 m はコース中で最も
 * 直線に近く（半径 548 m）・バンクが 0°・標高差 0.4 m** なので、
 * 焼いたトンネルの断面が路面に沿う。コーナーやバンク区間に置くと、
 * 内壁が路面から離れたり食い込んだりするのが目に見えて分かる。
 */
export const TUNNEL = {
  from: 2440,
  to: 2660,

  /** 内壁を路面の縁からどれだけ外へ立てるか [m]。縁石 1.2 m ＋ 退避 2 m */
  wallMargin: 3.2,
  /** 側壁が立ち上がっている高さ（アーチの起拱点）[m] */
  springHeight: 4,
  /** 天井の頂点の高さ [m] */
  crownHeight: 6.4,
  /** アーチの分割数。半楕円を折れ線で近似する */
  archFacets: 8,

  /** 側壁の足元の歩廊。幅 [m] と高さ [m] */
  ledgeWidth: 0.8,
  ledgeHeight: 0.3,
  /**
   * 壁の下端を路面からどれだけ下げるか [m]。
   *
   * 草地は路面から最大 0.45 m 下がる（`build-track-mesh.mjs` の `GRASS_DROP`）。
   * それより深くまで壁を伸ばして地面へ埋め、隙間から外が見えないようにする。
   */
  buried: 0.8,

  /** 坑口のリムの拡大率と、拡大の中心高さ [m] */
  portalScale: 1.42,
  portalCenter: 1.6,
  /** 坑口のリムの厚み [m]（進行方向）。真横から見たときに面積を持つ */
  portalDepth: 1.4,

  /** 天井の照明。中心に沿った帯 */
  lamp: {
    /** 帯の幅 [m] */
    width: 0.7,
    /** 天井からどれだけ下げるか [m]。0 だと z-fighting になる */
    drop: 0.1,
    /** 灯具の間隔 [m] と 1 つの長さ [m] */
    spacing: 9,
    length: 3,
  },
} as const;

/**
 * 坑口の前後で照明を混ぜる距離 [m]。
 *
 * 天井が太陽を遮る計算はしていない（レンダラーに影のボリュームは無い）ので、
 * 坑口を跨いだ瞬間に画面全体の明るさが切り替わることになる。それを
 * この距離で線形に混ぜて「目が慣れる」ように見せる。60 m/s で 0.4 秒ぶん。
 */
export const TUNNEL_BLEND = 24;

/** 区間の長さ [m] */
export function tunnelLength(): number {
  return TUNNEL.to - TUNNEL.from;
}

/**
 * その弧長がトンネルの中へどれだけ入っているか [m]。外なら負（＝最寄りの坑口までの距離）。
 *
 * 入口からの距離と出口までの距離の小さいほうを返すので、
 * 入口手前でも出口の先でも「坑口までどれだけか」がそのまま符号付きで出る。
 */
export function tunnelDepthAt(track: Track, s: number): number {
  return Math.min(track.deltaS(s, TUNNEL.from), track.deltaS(TUNNEL.to, s));
}

/** その弧長がトンネルの中か */
export function insideTunnel(track: Track, s: number): boolean {
  return tunnelDepthAt(track, s) > 0;
}

/**
 * トンネルらしさ 0..1。坑口の ±`TUNNEL_BLEND` m で線形に切り替わる。
 * 照明・フォグ・映り込みの強さは、すべてこの 1 つの値から混ぜる。
 */
export function tunnelBlendAt(track: Track, s: number): number {
  const depth = tunnelDepthAt(track, s);
  return Math.min(1, Math.max(0, (depth + TUNNEL_BLEND) / (2 * TUNNEL_BLEND)));
}

/**
 * 視点から前方に見えるトンネル区間の距離 [m]。
 *
 * `near` が 0 なら視点自身が中に居る。擬似3D の 2 世代は、この範囲に落ちる
 * 走査線だけを暗くし、**手前側の境界に坑口の矩形を置く** —
 * 外から見れば入口の妻壁、中から見れば出口の明かり取りで、どちらも同じ 1 つの式になる。
 */
export function tunnelSpanAhead(track: Track, originS: number): { near: number; far: number } {
  const near = track.wrapS(TUNNEL.from - originS);
  const far = track.wrapS(TUNNEL.to - originS);
  // 中に居るときは入口が「ほぼ 1 周先」に出るので、前方の区間は 0 から出口までになる
  return far < near ? { near: 0, far } : { near, far };
}

/**
 * 坑口の内側の半幅 [m]。路面半幅はコース定義から引くので、
 * 拡幅されている区間ではトンネルも広がる。
 */
export function tunnelHalfWidth(track: Track, s: number): number {
  return track.sampleAt(s).halfWidth + TUNNEL.wallMargin;
}

// ─────────────────────────────────────────────────────────────
// 3D 世代の生成物。刻みもディレクトリもコースメッシュの LOD へ相乗りする
// ─────────────────────────────────────────────────────────────

/** 躯体（側壁・歩廊・アーチ・坑口のリム）の GLB */
export function tunnelAsset(lod: TrackMeshLod): string {
  return `assets/${lod.directory}/models/tunnel.glb`;
}

/**
 * 天井の照明の GLB。**躯体と分けるのはマテリアルを分けるため**である。
 * メッシュ 1 つにつきマテリアルは 1 つしか指定できず、灯具だけは
 * 環境光が落ちても明るいままでなければならない（`gen4-ps2.ts` の `TUNNEL_LAMP`）。
 */
export function tunnelLampAsset(lod: TrackMeshLod): string {
  return `assets/${lod.directory}/models/tunnel-lamp.glb`;
}

/** 躯体と灯具が共有するアトラス。u 帯で壁・歩廊・アーチ・リム・灯具を分ける */
export function tunnelTexture(lod: TrackMeshLod): string {
  return `assets/${lod.directory}/textures/tunnel.png`;
}

/**
 * トンネルを描き始める距離 [m]。
 *
 * 躯体は 1 つのメッシュなので、セクターのような細かいカリングはしない。
 * 区間の**どちらかの端**がこの距離の内側に来たら積む、という粒度で足りる
 * （躯体は第4世代で 5,000 tri ほど・第3世代で 1,300 tri ほど）。
 */
export function tunnelVisible(track: Track, s: number, drawDistance: number): boolean {
  const depth = tunnelDepthAt(track, s);
  return depth > -drawDistance;
}
