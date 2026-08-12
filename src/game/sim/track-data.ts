/**
 * サーキットの制御点（実装計画 §2.3）。
 *
 * ここに書いてあるのは**このゲームの唯一のコース形状**であり、4 世代すべての見え方は
 * この配列から派生する。起動時に `track.ts` が 1 m 間隔へリサンプリングする。
 *
 * 座標系: X 東 / Y 上 / Z 南（右手系）。上から見た図では X が右、Z が下になる。
 * 進行方向はスタートラインから +X。したがってコースは**右回り**で、
 * 主要コーナーの曲率は負（左正の規約。`track.ts` を参照）。
 *
 * `bankDegrees` は**右側を持ち上げる向きを正**とする。右コーナーの外側は左なので、
 * 右コーナーのバンクは負の値になる。
 */
export interface TrackControlPoint {
  /** ワールド X [m] */
  readonly x: number;
  /** ワールド Z [m] */
  readonly z: number;
  /** 標高 [m]。既定 0。コース全体で最大 8 m の起伏に収める */
  readonly y?: number;
  /** 路面半幅 [m]。既定 6（幅 12 m）。コーナー進入で 7 まで広げる */
  readonly halfWidth?: number;
  /** バンク角 [deg]。右側が高いほど正。高速コーナーのみ最大 4 */
  readonly bankDegrees?: number;
}

export const TRACK_NAME = 'COAST CIRCUIT';

/** 既定の路面半幅 [m]。 */
export const DEFAULT_HALF_WIDTH = 6;

/** コーナー進入で広げるときの半幅 [m]。 */
export const WIDE_HALF_WIDTH = 7;

/**
 * 閉ループの制御点列。
 *
 * 構成: ホームストレート → 高速右スイーパー（バンク付き・上り）→ 丘の上の複合コーナー →
 * ヘアピン → 短いストレート → シケイン → インフィールドの 180° 左折り返し →
 * 戻りのストレート → 最終スイーパーでホームへ。
 */
export const TRACK_CONTROL_POINTS: readonly TrackControlPoint[] = [
  // ── ホームストレート（平坦・スタート/フィニッシュは s = 0）
  { x: 0, z: 0 },
  { x: 150, z: 0 },
  { x: 300, z: 0 },
  { x: 440, z: 0, halfWidth: WIDE_HALF_WIDTH }, // ターン 1 進入で拡幅

  // ── ターン 1〜3: 高速スイーパー（右・バンク 4°・上り）
  { x: 600, z: 40, y: 1.5, halfWidth: WIDE_HALF_WIDTH, bankDegrees: -2.5 },
  { x: 680, z: 150, y: 3.5, bankDegrees: -4 },
  { x: 690, z: 280, y: 5, bankDegrees: -4 },
  { x: 645, z: 400, y: 6.5, bankDegrees: -2.5 },

  // ── 複合コーナー（2 つの頂点・丘の頂上で標高 8 m）
  { x: 565, z: 465, y: 8, halfWidth: WIDE_HALF_WIDTH },
  { x: 470, z: 470, y: 7.6 },
  { x: 412, z: 442, y: 7.2 }, // 第 1 頂点
  { x: 348, z: 474, y: 6.6 }, // 第 2 頂点
  { x: 275, z: 505, y: 5.6 },

  // ── ヘアピン（下り・最も遅いコーナー）
  { x: 195, z: 505, y: 4.6, halfWidth: WIDE_HALF_WIDTH },
  { x: 135, z: 472, y: 4.1 },
  { x: 108, z: 420, y: 3.6 }, // 頂点
  { x: 145, z: 374, y: 3.1 },

  // ── 短いストレート
  { x: 235, z: 352, y: 2.6 },
  { x: 340, z: 344, y: 2.1 },

  // ── シケイン（右 → 左）
  { x: 405, z: 322, y: 1.9 },
  { x: 468, z: 330, y: 1.8 },
  { x: 528, z: 302, y: 1.7, halfWidth: WIDE_HALF_WIDTH },

  // ── インフィールドの 180° 左折り返し（半径 ≒ 45 m）
  { x: 572, z: 272, y: 1.6 },
  { x: 585, z: 232, y: 1.5 },
  { x: 560, z: 198, y: 1.4 },
  { x: 500, z: 186, y: 1.3 },

  // ── 戻りのストレート
  { x: 410, z: 190, y: 1.1 },
  { x: 285, z: 197, y: 0.9, halfWidth: WIDE_HALF_WIDTH },
  { x: 145, z: 198, y: 0.7 },
  { x: 0, z: 196, y: 0.5 },

  // ── 最終コーナー（右・半径 ≒ 98 m・軽いバンク）でホームストレートへ
  { x: -70, z: 167, y: 0.3, bankDegrees: -2 },
  { x: -98, z: 98, y: 0.15, bankDegrees: -2.5 },
  { x: -70, z: 29, y: 0.05, bankDegrees: -2 },
];
