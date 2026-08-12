import {
  DEFAULT_HALF_WIDTH,
  TRACK_CONTROL_POINTS,
  type TrackControlPoint,
} from './track-data.js';

/**
 * トラック空間 — 4 世代が共有する唯一の真実（実装計画 §2.2）。
 *
 * 中心線を等間隔にリサンプリングした配列だけが座標系の橋渡しであり、
 * 第1・第2世代の擬似3D投影も、第3・第4世代のワールド座標も、ミニマップも、
 * すべてこの 1 つの配列と `toWorld()` の上に乗る。
 *
 * 規約:
 * - 座標系は X 東 / Y 上 / Z 南の右手系。上から見ると X が右、Z が下。
 * - `right = tangent × up` なので、+X を向いているとき右は +Z（＝上から見て下）。
 * - `curvature` は**左が正**。本コースは右回りなので主要コーナーは負になる。
 * - `lateral` は中心線からの右向きの符号付き距離 [m]。
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export interface TrackSample {
  /** 始点からの弧長 [m] */
  readonly s: number;
  /** ワールド座標（y は標高） */
  readonly position: Vec3;
  /** XZ 平面の進行方向（単位） */
  readonly tangent: Vec2;
  /** XZ 平面の右方向（単位） */
  readonly right: Vec2;
  /** atan2(tangentZ, tangentX) [rad] */
  readonly heading: number;
  /** 1/半径 [1/m]。左が正 */
  readonly curvature: number;
  /** 路面半幅 [m] */
  readonly halfWidth: number;
  /** バンク角 [rad]。右側が高いほど正 */
  readonly bank: number;
}

export interface TrackBounds {
  /** XZ 平面の最小 [x, z] */
  readonly min: Vec2;
  /** XZ 平面の最大 [x, z] */
  readonly max: Vec2;
  /** max - min */
  readonly size: Vec2;
}

export interface TrackLocation {
  /** 弧長 [m]。[0, length) に正規化済み */
  readonly s: number;
  /** 中心線からの右向き距離 [m] */
  readonly lateral: number;
}

export interface Track {
  readonly samples: readonly TrackSample[];
  /** 1 周の長さ [m] */
  readonly length: number;
  /** サンプル間隔 [m]。length / samples.length */
  readonly spacing: number;
  /** XZ 平面の AABB。路面の最大半幅ぶん外へ広げてある（ミニマップと共有する） */
  readonly bounds: TrackBounds;

  /** s を [0, length) へ正規化する */
  wrapS(s: number): number;
  /** 2 つの弧長の符号付き最短差（a - b）。[-length/2, length/2) */
  deltaS(a: number, b: number): number;
  /** 任意の s の補間サンプル */
  sampleAt(s: number): TrackSample;
  /** トラック空間 → ワールド座標 */
  toWorld(s: number, lateral: number): Vec3;
  /** ワールド XZ → トラック空間。hintS を渡すと近傍だけを探す */
  toTrack(x: number, z: number, hintS?: number): TrackLocation;
}

// ─────────────────────────────────────────────────────────────
// Catmull-Rom（centripetal, alpha = 0.5）
// ─────────────────────────────────────────────────────────────

/** 制御点 1 つを数値ベクトルへ展開したもの: [x, z, y, halfWidth, bank(rad)] */
type ControlVector = [number, number, number, number, number];
const DIMENSIONS = 5;

function toVector(point: TrackControlPoint): ControlVector {
  return [
    point.x,
    point.z,
    point.y ?? 0,
    point.halfWidth ?? DEFAULT_HALF_WIDTH,
    ((point.bankDegrees ?? 0) * Math.PI) / 180,
  ];
}

/**
 * Barry-Goldman 形式の非一様 Catmull-Rom。
 * ノット間隔を XZ 距離の平方根で取る（centripetal）ことで、
 * 制御点の粗密が偏っていてもループが自己交差したりカスプが出たりしない。
 */
function catmullRom(
  p0: ControlVector,
  p1: ControlVector,
  p2: ControlVector,
  p3: ControlVector,
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  t: number,
  out: ControlVector,
): ControlVector {
  for (let d = 0; d < DIMENSIONS; d++) {
    const a1 = ((t1 - t) * p0[d] + (t - t0) * p1[d]) / (t1 - t0);
    const a2 = ((t2 - t) * p1[d] + (t - t1) * p2[d]) / (t2 - t1);
    const a3 = ((t3 - t) * p2[d] + (t - t2) * p3[d]) / (t3 - t2);
    const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
    out[d] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
  }
  return out;
}

/** 制御点あたりの細分数。弧長の数値積分の精度を決める */
const SUBDIVISIONS = 64;

interface DensePoint {
  readonly distance: number;
  readonly value: ControlVector;
}

function buildDensePolyline(points: readonly TrackControlPoint[]): DensePoint[] {
  const count = points.length;
  const vectors = points.map(toVector);

  // centripetal のノット列（閉ループなので前後に巻き込む）
  const knot = (index: number): number => {
    const a = vectors[(index - 1 + count * 2) % count]!;
    const b = vectors[(index + count * 2) % count]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    return Math.sqrt(Math.hypot(dx, dz));
  };

  const dense: DensePoint[] = [];
  const scratch: ControlVector = [0, 0, 0, 0, 0];
  let distance = 0;
  let previousX = vectors[0]![0];
  let previousZ = vectors[0]![1];

  for (let segment = 0; segment < count; segment++) {
    const p0 = vectors[(segment - 1 + count) % count]!;
    const p1 = vectors[segment]!;
    const p2 = vectors[(segment + 1) % count]!;
    const p3 = vectors[(segment + 2) % count]!;

    const t0 = 0;
    const t1 = t0 + knot(segment);
    const t2 = t1 + knot(segment + 1);
    const t3 = t2 + knot(segment + 2);

    for (let step = 0; step < SUBDIVISIONS; step++) {
      const t = t1 + ((t2 - t1) * step) / SUBDIVISIONS;
      const value = catmullRom(p0, p1, p2, p3, t0, t1, t2, t3, t, scratch);
      if (segment === 0 && step === 0) {
        dense.push({ distance: 0, value: [...value] as ControlVector });
        previousX = value[0];
        previousZ = value[1];
        continue;
      }
      distance += Math.hypot(value[0] - previousX, value[1] - previousZ);
      previousX = value[0];
      previousZ = value[1];
      dense.push({ distance, value: [...value] as ControlVector });
    }
  }

  // 閉じる: 始点へ戻る分の距離を末尾に足しておく
  const first = dense[0]!;
  distance += Math.hypot(first.value[0] - previousX, first.value[1] - previousZ);
  dense.push({ distance, value: first.value });
  return dense;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function extent(values: readonly number[]): readonly [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

function clamp(value: number, [minimum, maximum]: readonly [number, number]): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 角度差を [-π, π) に畳む */
function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return angle - twoPi * Math.floor((angle + Math.PI) / twoPi);
}

// ─────────────────────────────────────────────────────────────
// Track の構築
// ─────────────────────────────────────────────────────────────

export interface CreateTrackOptions {
  /** リサンプリング間隔 [m]。既定 1 */
  readonly spacing?: number;
}

export function createTrack(
  points: readonly TrackControlPoint[] = TRACK_CONTROL_POINTS,
  options: CreateTrackOptions = {},
): Track {
  if (points.length < 4) throw new Error('コースには 4 点以上の制御点が要る');

  const dense = buildDensePolyline(points);
  const totalLength = dense[dense.length - 1]!.distance;
  const requested = options.spacing ?? 1;
  const count = Math.max(8, Math.round(totalLength / requested));
  const spacing = totalLength / count;

  // 1) 等間隔の位置と属性
  const positions = new Float64Array(count * 3);
  const halfWidths = new Float64Array(count);
  const banks = new Float64Array(count);

  // スプライトは制御点の間で行き過ぎる。位置はそれでよいが、路面半幅とバンクは
  // 「書いた値の範囲」を出てはいけない量なので、補間結果を範囲へ丸める。
  const authored = points.map(toVector);
  const halfWidthRange = extent(authored.map((vector) => vector[3]));
  const bankRange = extent(authored.map((vector) => vector[4]));

  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const target = index * spacing;
    while (cursor + 1 < dense.length - 1 && dense[cursor + 1]!.distance <= target) cursor++;
    const a = dense[cursor]!;
    const b = dense[cursor + 1]!;
    const span = b.distance - a.distance;
    const t = span > 1e-12 ? (target - a.distance) / span : 0;

    positions[index * 3 + 0] = lerp(a.value[0], b.value[0], t);
    positions[index * 3 + 1] = lerp(a.value[2], b.value[2], t);
    positions[index * 3 + 2] = lerp(a.value[1], b.value[1], t);
    halfWidths[index] = clamp(lerp(a.value[3], b.value[3], t), halfWidthRange);
    banks[index] = clamp(lerp(a.value[4], b.value[4], t), bankRange);
  }

  // 2) 接線・右方向・向き（閉ループなので中央差分が使える）
  const samples: TrackSample[] = [];
  const headings = new Float64Array(count);
  const tangents = new Float64Array(count * 2);
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    const previous = (index - 1 + count) % count;
    let dx = positions[next * 3 + 0]! - positions[previous * 3 + 0]!;
    let dz = positions[next * 3 + 2]! - positions[previous * 3 + 2]!;
    const magnitude = Math.hypot(dx, dz) || 1;
    dx /= magnitude;
    dz /= magnitude;
    tangents[index * 2 + 0] = dx;
    tangents[index * 2 + 1] = dz;
    headings[index] = Math.atan2(dz, dx);
  }

  // 3) 曲率（左正 ＝ -dheading/ds）
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    const previous = (index - 1 + count) % count;
    const delta = wrapAngle(headings[next]! - headings[previous]!);
    const curvature = -delta / (2 * spacing);
    const tx = tangents[index * 2 + 0]!;
    const tz = tangents[index * 2 + 1]!;
    samples.push({
      s: index * spacing,
      position: [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!],
      tangent: [tx, tz],
      right: [-tz, tx],
      heading: headings[index]!,
      curvature,
      halfWidth: halfWidths[index]!,
      bank: banks[index]!,
    });
  }

  // 4) AABB。路面の最大半幅ぶん外へ広げ、路上のどの点も内側に入るようにする
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let maxHalfWidth = 0;
  for (const sample of samples) {
    minX = Math.min(minX, sample.position[0]);
    maxX = Math.max(maxX, sample.position[0]);
    minZ = Math.min(minZ, sample.position[2]);
    maxZ = Math.max(maxZ, sample.position[2]);
    maxHalfWidth = Math.max(maxHalfWidth, sample.halfWidth);
  }
  minX -= maxHalfWidth;
  minZ -= maxHalfWidth;
  maxX += maxHalfWidth;
  maxZ += maxHalfWidth;
  const bounds: TrackBounds = {
    min: [minX, minZ],
    max: [maxX, maxZ],
    size: [maxX - minX, maxZ - minZ],
  };

  // ── 参照系のヘルパー
  function wrapS(s: number): number {
    const wrapped = s % totalLength;
    return wrapped < 0 ? wrapped + totalLength : wrapped;
  }

  function deltaS(a: number, b: number): number {
    const half = totalLength / 2;
    let delta = (a - b) % totalLength;
    if (delta >= half) delta -= totalLength;
    if (delta < -half) delta += totalLength;
    return delta;
  }

  /** s のサンプル間補間に使う、下側インデックスと重み */
  function locate(s: number): { index: number; next: number; t: number } {
    const normalized = wrapS(s) / spacing;
    const index = Math.floor(normalized) % count;
    return { index, next: (index + 1) % count, t: normalized - Math.floor(normalized) };
  }

  function sampleAt(s: number): TrackSample {
    const { index, next, t } = locate(s);
    const a = samples[index]!;
    const b = samples[next]!;
    const tx = lerp(a.tangent[0], b.tangent[0], t);
    const tz = lerp(a.tangent[1], b.tangent[1], t);
    const magnitude = Math.hypot(tx, tz) || 1;
    const ux = tx / magnitude;
    const uz = tz / magnitude;
    return {
      s: wrapS(s),
      position: [
        lerp(a.position[0], b.position[0], t),
        lerp(a.position[1], b.position[1], t),
        lerp(a.position[2], b.position[2], t),
      ],
      tangent: [ux, uz],
      right: [-uz, ux],
      heading: a.heading + wrapAngle(b.heading - a.heading) * t,
      curvature: lerp(a.curvature, b.curvature, t),
      halfWidth: lerp(a.halfWidth, b.halfWidth, t),
      bank: lerp(a.bank, b.bank, t),
    };
  }

  /** toWorld / toTrack が共有する、中心と右方向の評価（XZ のみ） */
  function frameAt(s: number, out: Float64Array): void {
    const { index, next, t } = locate(s);
    const a = samples[index]!;
    const b = samples[next]!;
    const tx = lerp(a.tangent[0], b.tangent[0], t);
    const tz = lerp(a.tangent[1], b.tangent[1], t);
    const magnitude = Math.hypot(tx, tz) || 1;
    out[0] = lerp(a.position[0], b.position[0], t);
    out[1] = lerp(a.position[2], b.position[2], t);
    out[2] = -(tz / magnitude);
    out[3] = tx / magnitude;
  }

  const frame = new Float64Array(4);
  const frameH = new Float64Array(4);

  function toWorld(s: number, lateral: number): Vec3 {
    const sample = sampleAt(s);
    return [
      sample.position[0] + sample.right[0] * lateral,
      sample.position[1] + Math.sin(sample.bank) * lateral,
      sample.position[2] + sample.right[1] * lateral,
    ];
  }

  function nearestIndex(x: number, z: number): number {
    // 粗く走査してから近傍を詰める。1 m 刻みの中心線をそのまま総当たりすると
    // 8 台 × 60Hz では効かないので、まず 16 サンプルおきに見る。
    const stride = Math.max(1, Math.floor(count / 256));
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < count; index += stride) {
      const dx = positions[index * 3]! - x;
      const dz = positions[index * 3 + 2]! - z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    for (let offset = -stride; offset <= stride; offset++) {
      const index = (best + offset + count) % count;
      const dx = positions[index * 3]! - x;
      const dz = positions[index * 3 + 2]! - z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  function nearestIndexNear(x: number, z: number, hintS: number, window: number): number {
    const center = Math.round(wrapS(hintS) / spacing);
    let best = center % count;
    let bestDistance = Infinity;
    for (let offset = -window; offset <= window; offset++) {
      const index = (((center + offset) % count) + count) % count;
      const dx = positions[index * 3]! - x;
      const dz = positions[index * 3 + 2]! - z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  /**
   * ワールド XZ → トラック空間。
   *
   * `toWorld` は `center(s) + lateral * right(s)` そのものなので、
   * 同じ式を (s, lateral) について 2 元 Newton 法で解けば逆変換は厳密に求まる。
   * 往復誤差はテストで 1 mm 未満に固定する（`track.spec.ts`）。
   */
  function toTrack(x: number, z: number, hintS?: number): TrackLocation {
    const seed =
      hintS === undefined
        ? nearestIndex(x, z)
        : nearestIndexNear(x, z, hintS, Math.max(4, Math.ceil(40 / spacing)));
    let s = seed * spacing;

    frameAt(s, frame);
    let lateral = (x - frame[0]!) * frame[2]! + (z - frame[1]!) * frame[3]!;

    const h = spacing * 1e-3;
    for (let iteration = 0; iteration < 12; iteration++) {
      frameAt(s, frame);
      const fx = frame[0]! + lateral * frame[2]! - x;
      const fz = frame[1]! + lateral * frame[3]! - z;
      if (Math.abs(fx) < 1e-10 && Math.abs(fz) < 1e-10) break;

      // ∂F/∂s は差分で近似する。ヤコビアンが近似でも不動点は動かない
      frameAt(s + h, frameH);
      const dsx = (frameH[0]! + lateral * frameH[2]! - (frame[0]! + lateral * frame[2]!)) / h;
      const dsz = (frameH[1]! + lateral * frameH[3]! - (frame[1]! + lateral * frame[3]!)) / h;
      const dlx = frame[2]!;
      const dlz = frame[3]!;

      const determinant = dsx * dlz - dsz * dlx;
      if (Math.abs(determinant) < 1e-12) break;
      const deltaSStep = (fx * dlz - fz * dlx) / determinant;
      const deltaLateral = (dsx * fz - dsz * fx) / determinant;

      // 1 反復で 1 サンプル以上飛ばすと別のコーナーへ落ちるので刻みを抑える
      const clamped = Math.max(-spacing * 4, Math.min(spacing * 4, deltaSStep));
      s -= clamped;
      lateral -= deltaLateral;
    }

    return { s: wrapS(s), lateral };
  }

  return {
    samples,
    length: totalLength,
    spacing,
    bounds,
    wrapS,
    deltaS,
    sampleAt,
    toWorld,
    toTrack,
  };
}

/**
 * 既定のサーキット。ゲーム本体も生成ツール（`tools/build-minimap.mjs`）も
 * **この 1 つのインスタンス**を見る。実装を二重に持たないことが、
 * ミニマップの俯瞰図とマーカー座標がずれない構造的な保証になる（実装計画 §3.6）。
 */
export const TRACK: Track = createTrack();
