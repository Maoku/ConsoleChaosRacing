import type { CameraCommand, TransformCommand } from '@console-chaos/engine';

/**
 * カメラ前面に置く板 — 真色世代（PS1 / PS2）の HUD の土台。
 *
 * **エンジン実測（実装計画 §1.3 への追記）**: `createGenerationWebGlRenderer` は
 * スプライト専用のレンダーターゲットを `paletteMode` が `fixed54` / `rgb555` の世代
 * （＝ FC と SFC）にしか確保しない。`truecolor` の PS1 / PS2 では
 * `SpriteCommand` が**一切描かれない**。README の「HUD はスクリーン空間スプライトで」は
 * 前半 2 世代にしか当てはまらない。
 *
 * したがって真色世代の HUD は、カメラの前に置いた薄い箱メッシュで作る。
 * `TransformCommand` の回転は `rotationY` だけなので、板はカメラの水平向きにだけ向く。
 * レースカメラの俯角は小さいので、ずれは無視できる。
 *
 * この関数は**内部解像度の画素矩形**を受け取る。スプライト経路とまったく同じ
 * レイアウト計算をそのまま渡せるので、HUD の配置は 4 世代で 1 つの式のままになる。
 */

export interface BillboardCamera {
  readonly camera: CameraCommand;
  /** 内部解像度 */
  readonly screenWidth: number;
  readonly screenHeight: number;
}

export interface BillboardFrame {
  /** カメラからの距離 [m] */
  readonly distance: number;
  /** 距離 `distance` の面での可視領域の半分 [m] */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** 板が向くべき Y 回転 [rad] */
  readonly rotationY: number;
  /** 画素 → ワールドの倍率 [m/px] */
  readonly metersPerPixel: number;
  readonly origin: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

/** 画面に貼り付いた板を作るための基底フレーム */
export function billboardFrame(view: BillboardCamera, distance: number): BillboardFrame {
  const { camera, screenWidth, screenHeight } = view;
  const forward: [number, number, number] = [
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ];
  const forwardLength = Math.hypot(forward[0], forward[1], forward[2]) || 1;
  forward[0] /= forwardLength;
  forward[1] /= forwardLength;
  forward[2] /= forwardLength;

  // right = forward × up、up' = right × forward
  const right: [number, number, number] = [-forward[2], 0, forward[0]];
  const rightLength = Math.hypot(right[0], right[2]) || 1;
  right[0] /= rightLength;
  right[2] /= rightLength;
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];

  const fov = ((camera.fovDegrees ?? 55) * Math.PI) / 180;
  const halfHeight = Math.tan(fov / 2) * distance;
  const halfWidth = (halfHeight * screenWidth) / screenHeight;

  return {
    distance,
    halfWidth,
    halfHeight,
    // 板の +Z 面をカメラへ向ける。rotationY(θ) は (0,0,1) を (sinθ, 0, cosθ) に写す
    rotationY: Math.atan2(-forward[0], -forward[2]),
    metersPerPixel: (halfHeight * 2) / screenHeight,
    origin: [
      camera.position[0] + forward[0] * distance,
      camera.position[1] + forward[1] * distance,
      camera.position[2] + forward[2] * distance,
    ],
    right,
    up,
  };
}

/** 内部解像度の画素座標（左上原点）→ 板の上のワールド座標 */
export function billboardPoint(
  frame: BillboardFrame,
  view: BillboardCamera,
  pixelX: number,
  pixelY: number,
): [number, number, number] {
  const ndcX = (pixelX / view.screenWidth) * 2 - 1;
  const ndcY = 1 - (pixelY / view.screenHeight) * 2;
  const offsetX = ndcX * frame.halfWidth;
  const offsetY = ndcY * frame.halfHeight;
  return [
    frame.origin[0] + frame.right[0] * offsetX + frame.up[0] * offsetY,
    frame.origin[1] + frame.right[1] * offsetX + frame.up[1] * offsetY,
    frame.origin[2] + frame.right[2] * offsetX + frame.up[2] * offsetY,
  ];
}

/**
 * 板に使う単位ボックス。`manifest.geometries` に**この値ちょうど**で登録しておく必要がある
 * （レンダラーはジオメトリを事前確保し、キーが一致しないと throw する）。
 * 寸法は `transform.scale` で与える。
 */
export const BILLBOARD_GEOMETRY = { kind: 'box', halfExtents: [0.5, 0.5, 0.5] } as const;

/**
 * 画素で指定した矩形を占める薄い箱の `TransformCommand`。
 *
 * 前後関係は**距離の殻**で作る。深度バッファの無い世代（PS1）ではレンダラーが
 * メッシュをカメラからの距離の降順に並べるため、手前に出したい要素ほど小さい
 * `distance` の `frame` を使う。板は距離に比例して拡大されるので、
 * どの殻に置いても画面上の大きさは変わらない。
 *
 * 画面上で重なる要素どうしはカメラから見てほぼ同じ方向にあるため、
 * 殻の順序がそのまま描画順になる。重ならない要素の順序は見た目に影響しない。
 */
export function billboardBox(
  frame: BillboardFrame,
  view: BillboardCamera,
  centerX: number,
  centerY: number,
  pixelWidth: number,
  pixelHeight: number,
): TransformCommand {
  const scale = frame.metersPerPixel;
  return {
    position: billboardPoint(frame, view, centerX, centerY),
    rotationY: frame.rotationY,
    // halfExtents 0.5 の単位ボックスなので、scale がそのまま実寸になる
    scale: [pixelWidth * scale, pixelHeight * scale, 0.004],
  };
}

/**
 * パネルを置くべき距離。
 *
 * 画面隅の要素はカメラから見て中央より遠い（`distance * √(1 + tan²(fov/2)(1+aspect²))`）。
 * すべての要素より確実に奥へ置くには、その最遠距離を上回る殻に載せる必要がある。
 */
export function enclosingDistance(view: BillboardCamera, distance: number): number {
  const fov = ((view.camera.fovDegrees ?? 55) * Math.PI) / 180;
  const tangent = Math.tan(fov / 2);
  const aspect = view.screenWidth / view.screenHeight;
  return distance * Math.sqrt(1 + tangent * tangent * (1 + aspect * aspect)) * 1.05;
}
