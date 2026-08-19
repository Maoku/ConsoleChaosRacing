import type { Track } from '../../sim/track.js';
import { TUNNEL, tunnelDepthAt } from '../../sim/tunnel.js';
import type { TrackMeshLod } from './track-mesh.js';

/**
 * トンネルの見せ方（実装計画 8-9）。
 *
 * **区間そのものの定義は `sim/tunnel.ts` にある。** ここにあるのは
 * 「その世界をどう描くか」だけで、世代ごとの出し方は違う。
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

// 区間の定義と弧長の判定は再輸出する。読み手（ビューと生成ツール）は
// トンネルの話を 1 つの import で済ませられる
export {
  TUNNEL,
  TUNNEL_BLEND,
  insideTunnel,
  tunnelBlendAt,
  tunnelDepthAt,
  tunnelLength,
} from '../../sim/tunnel.js';

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
