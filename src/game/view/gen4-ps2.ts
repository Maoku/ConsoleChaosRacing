import type {
  BackgroundCommand,
  CameraCommand,
  GenerationId,
  HardwareGenerationProfile,
  LightCommand,
  MaterialCommand,
  MeshCommand,
  RenderFrame,
} from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import { carModelFor, carTextureFor, carTransform } from './shared/car-model.js';
import { followCamera } from './shared/camera.js';
import { ENVIRONMENT_MAP, SKYLINE, SUN_DIRECTION, equirectU } from './shared/environment.js';
import { pushHud } from './shared/hud.js';
import { defaultMinimapRect, pushMinimap } from './shared/minimap.js';
import {
  trackMeshLodFor,
  trackSectorAsset,
  trackSurfaceTexture,
  visibleSectors,
} from './shared/track-mesh.js';
import { ENTRANT_COLORS, PLAYER_ENTRANT, SKY_COLORS, generationValue } from './shared/variants.js';

/**
 * 第4世代（PS2）— 深度バッファと動的ライトのある 3D（実装計画 §3.4）。
 *
 * レンダラーが自動でやること: 640×448 / linear フィルタ / 頂点量子化なし /
 * perspective UV / component の CRT。**第3世代と同じ車・同じコース定義・同じカメラ**を
 * 通しても別物に見えることが、この世代の主張になる。ゲーム側が足すのは 4 つ。
 *
 * 1. **映り込み** — `environmentTexture` に正距円筒の環境マップ。車の向きに応じて
 *    景色が車体を流れる。4 世代でこの世代だけの表現（§6.1 第4世代基準 1）。
 * 2. **空との一致** — 遠景の層に、同じ環境マップから焼いた地平線の帯を貼る。
 *    水平線の位置と方位を実際のカメラから求めるので、映り込みと画面の空が揃う（基準 2）。
 * 3. **動的ライト** — 環境マップの太陽と同じ向きの directional、空の色の ambient、
 *    そして落ち影を生む点光源（基準 3）。
 * 4. **前後関係** — 深度バッファがあるので ordering table も三角形ソートも要らない。
 *    第3世代の `orderTableIndex` / `polygonSortRange` がここには 1 つも無いことが、
 *    そのままハードウェアの差になっている。
 */

/** フォグ密度 [1/m]。exp(-d·density) なので 100 m で 67%・300 m で 96% 霞む */
const FOG_DENSITY = 0.011;

/**
 * 映り込みの強さ。シェーダは
 * `color·(1−k) + k·min(color·0.55 + env·0.65, 1)` という合成なので、
 * 0.35 でも空の青が車体へはっきり乗る。上げると塗装の色が飛ぶ。
 */
const ENVIRONMENT_STRENGTH = 0.35;

/**
 * ライティング。`uAmbient = material.ambient × (ambient ライトの色 × 強さ)` で、
 * そこへ `directional の色 × diffuse × lambert` が足される。
 * 上向きの面で合計がほぼ 1 になるように選んである。
 */
const AMBIENT_LIGHT = { color: '#9ab4d2', intensity: 1 } as const;
const SUN_LIGHT = { color: '#fff2d8', intensity: 1 } as const;
const SURFACE = { ambient: 0.75, diffuse: 0.55 } as const;

/**
 * 落ち影を生む点光源（実装計画 §3.4）。
 *
 * エンジンは**最も強い点光源 1 つ**から、`castShadow` を持つメッシュの影を
 * `groundY` の高さへ落とす。倍率は `高さ /(高さ − 車の高さ)` で、影の大きさに掛かり
 * 濃さにはその逆数が掛かる。低く置くと影が巨大化して薄まり、しかも遠くの車ほど
 * 影が横へ流れる（影は光源から見た投影なので、`(車 − 光源) × 倍率` だけずれる）。
 * **高く置くほど倍率が 1 に近づく**ので、40 m 上に置いて倍率 1.006 に収めている。
 *
 * 半径は「高さより少しだけ大きい」程度にする。点光源は距離減衰つきの照明でもあり、
 * 半径を広げると自機のまわりだけが明るく浮く。
 */
const KEY_LIGHT = { height: 40, radius: 44, color: '#fff2d8', intensity: 0.3 } as const;

/**
 * 落ち影の半径 [m]。**影を落とすためだけの、描かれないメッシュ**に与える。
 *
 * 影の四角形の大きさは `transform.scale` から作られる。車のメッシュに与えれば
 * 車体そのものが歪むので、代わりに影専用のメッシュを 1 台につき 1 つ積む。
 * `SHADOW_MATERIAL` が `colorFactor` を透明にして `alphaCutoff` で全画素を捨てるため、
 * 色は 1 画素も描かれず、影の投影にだけ現れる。ジオメトリは事前確保済みの quad
 * （2 三角形）なので、費用はドローコール 1 つぶんしかない。
 *
 * 四角形は**回転しない**（影の行列は平行移動と拡大だけ）ので、正方形に採る。
 * 車の footprint は 1.9 × 0.88 m。1.0 m 角なら、どの向きでも車体の下から
 * はみ出す量が最小になる（車幅より少しだけ広いのは、タイヤのぶん）。
 */
const SHADOW_HALF = 0.5;

/**
 * ライバルを描く上限距離 [m]。フォグが 95% を超えるとほぼ背景と区別が付かない。
 * 描画するセクターの前方保証（310 m）の内側でもある。
 */
const CAR_DRAW_DISTANCE = 280;

/**
 * `asset` 付きメッシュの `geometry` は参照されないが、`quad` の `halfSize` だけは
 * モデル行列へ掛かる。単位のまま置く。
 */
const TRACK_GEOMETRY = { kind: 'quad', halfSize: [1, 1] } as const;

export function buildGen4View(frame: RenderFrame, context: ViewContext): void {
  const { generation, profile, state, display } = context;
  const track = state.track;
  const lod = trackMeshLodFor(generation);
  const carModel = carModelFor(generation);
  const player = display.cars[PLAYER_ENTRANT];
  if (!lod || !carModel || !player) return;

  const camera = followCamera({ track, car: player });
  frame.camera = camera;

  for (const background of skylineBackgrounds(generation, profile, camera)) {
    frame.backgrounds.push(background);
  }

  // ── ライト。太陽の向きは環境マップの最輝点から実測した 1 つの定数で、
  // 映り込みに写っている太陽と陰影が食い違わない
  const playerWorld = track.toWorld(player.s, player.lateral);
  frame.lights.push(
    {
      id: `ambient-${generation}`,
      kind: 'ambient',
      position: [0, 0, 0],
      color: AMBIENT_LIGHT.color,
      intensity: AMBIENT_LIGHT.intensity,
      radius: 0,
      generations: [generation],
    },
    {
      id: `sun-${generation}`,
      kind: 'directional',
      position: [0, 0, 0],
      direction: [...SUN_DIRECTION],
      color: SUN_LIGHT.color,
      intensity: SUN_LIGHT.intensity,
      radius: 0,
      generations: [generation],
    },
    {
      id: `key-${generation}`,
      kind: 'point',
      position: [playerWorld[0], playerWorld[1] + KEY_LIGHT.height, playerWorld[2]],
      color: KEY_LIGHT.color,
      intensity: KEY_LIGHT.intensity,
      radius: KEY_LIGHT.radius,
      generations: [generation],
    } satisfies LightCommand,
  );

  // ── 路面。深度バッファがあるので、セクター分割は純粋に描画距離のカリングでしかない
  const trackMaterial: MaterialCommand = {
    id: `track-${generation}`,
    baseColorTexture: trackSurfaceTexture(lod),
    // レンダラーは UV 補正をプロファイル（`affineTexture`）から決める。ここは意図の記録
    uvMode: 'perspective',
    ...SURFACE,
    generations: [generation],
  };
  frame.materials.push(trackMaterial);

  for (const sector of visibleSectors(lod, player.s, track.length)) {
    frame.meshes.push({
      id: `track-${generation}-${sector}`,
      geometry: TRACK_GEOMETRY,
      asset: trackSectorAsset(lod, sector),
      transform: { position: [0, 0, 0] },
      color: '#ffffff',
      material: trackMaterial.id,
      receiveShadow: true,
      generations: [generation],
    });
  }

  // ── 車。塗装テクスチャは無彩色 1 枚を 8 台で共有し、車体色は乗算だけで決まる。
  // 映り込みはマテリアル側なので、8 台とも同じ環境マップが同じ強さで乗る
  const carMaterial: MaterialCommand = {
    id: `car-${generation}`,
    baseColorTexture: carTextureFor(generation),
    environmentTexture: ENVIRONMENT_MAP.url,
    environmentStrength: ENVIRONMENT_STRENGTH,
    uvMode: 'perspective',
    ...SURFACE,
    generations: [generation],
  };
  frame.materials.push(carMaterial);

  // 影を落とすためだけのメッシュが使うマテリアル。全画素を捨てる（`SHADOW_HALF`）
  const shadowMaterial: MaterialCommand = {
    id: `car-shadow-${generation}`,
    baseColorTexture: carTextureFor(generation),
    colorFactor: [0, 0, 0, 0],
    alphaCutoff: 1,
    generations: [generation],
  };
  frame.materials.push(shadowMaterial);

  for (const car of display.cars) {
    const ground = track.toWorld(car.s, car.lateral);
    const away = Math.hypot(
      ground[0] - camera.position[0],
      ground[1] - camera.position[1],
      ground[2] - camera.position[2],
    );
    if (car.entrant !== PLAYER_ENTRANT && away > CAR_DRAW_DISTANCE) continue;

    const transform = carTransform(track, car);
    frame.meshes.push({
      id: `car-${generation}-${car.entrant}`,
      geometry: TRACK_GEOMETRY,
      asset: carModel.asset,
      transform,
      color: ENTRANT_COLORS[car.entrant % ENTRANT_COLORS.length] ?? '#ffffff',
      material: carMaterial.id,
      generations: [generation],
    } satisfies MeshCommand);

    frame.meshes.push({
      id: `car-shadow-${generation}-${car.entrant}`,
      geometry: TRACK_GEOMETRY,
      transform: { position: transform.position, scale: [SHADOW_HALF, 1, SHADOW_HALF] },
      color: '#000000',
      material: shadowMaterial.id,
      castShadow: true,
      groundY: ground[1],
      generations: [generation],
    } satisfies MeshCommand);
  }

  pushMinimap(frame, {
    generation,
    profile,
    track,
    cars: display.cars,
    rect: defaultMinimapRect(generation, profile),
    frameIndex: display.frameIndex,
  });

  // HUD は最後 ＝ 最前面。深度バッファがあってもスクリーン空間スプライトは
  // シーンの末尾へ合成されるので、積んだ順がそのまま重ね順になる
  pushHud(frame, { generation, profile, display, screen: context.screen });
}

/** カメラの向き。方位はワールドの `atan2(z, x)`、ピッチは見下ろしが負 */
export function cameraAngles(camera: CameraCommand): { azimuth: number; pitch: number } {
  const dx = camera.target[0] - camera.position[0];
  const dy = camera.target[1] - camera.position[1];
  const dz = camera.target[2] - camera.position[2];
  return { azimuth: Math.atan2(dz, dx), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/**
 * 空の階調 ＋ 環境マップの地平線の帯（実装計画 §3.4 / §6.1 第4世代基準 2）。
 *
 * `BackgroundCommand.parallax` はレンダラーが読まないので、視差は自分で `offset` へ
 * 畳み込む（第1・第2世代の `backdrop.ts` と同じ事情）。違うのは、こちらは
 * **視差の量が推測ではなく決まっている**ことである。帯は 360° を 1 枚に収めた
 * 正距円筒の切り出しなので、画角ぶんの U を覗き、視線の方位ぶんずらせばよい。
 * 映り込みが引く U とまったく同じ式（`equirectU`）を通るため、車体に映る景色と
 * 画面の空が必ず一致する。
 *
 * 縦は水平線の位置だけを合わせる。層は画面に平らに貼られるので仰角と行の対応は
 * 本来 tan で曲がるが、帯を ±50° と広く採って画面を覆いきらせ、ずれは絵の無い空へ
 * 逃がしてある（`shared/environment.ts` の `SKYLINE`）。
 */
export function skylineBackgrounds(
  generation: GenerationId,
  profile: HardwareGenerationProfile,
  camera: CameraCommand,
): BackgroundCommand[] {
  const width = profile.video.internalWidth;
  const height = profile.video.internalHeight;
  const sky = generationValue(SKY_COLORS, generation);

  const { azimuth, pitch } = cameraAngles(camera);
  const halfTan = Math.tan((((camera.fovDegrees ?? 55) * Math.PI) / 180) / 2);
  // 画面中央付近では 1 rad ＝ この画素数。水平線はカメラのほぼ正面にあるので十分正確
  const pixelsPerRadian = height / 2 / halfTan;
  const horizonRow = height / 2 + pitch * pixelsPerRadian;
  const rowTop = horizonRow - SKYLINE.topAngle * pixelsPerRadian;
  const rowBottom = horizonRow - SKYLINE.bottomAngle * pixelsPerRadian;

  // 画面が覆う水平画角。縦画角と内部解像度の縦横比から出る
  const horizontalFov = 2 * Math.atan((halfTan * width) / height);
  const repeat = horizontalFov / (2 * Math.PI);

  return [
    // テクスチャを持たない背景が空の階調とフォグ色を決める。帯が画面を覆うので
    // 階調が見えることは無いが、フォグ色はここでしか指定できない
    {
      color: sky.bottom,
      secondaryColor: sky.top,
      fogDensity: FOG_DENSITY,
      generations: [generation],
    },
    {
      color: sky.bottom,
      texture: SKYLINE.url,
      repeat: [repeat, 1],
      offset: [equirectU(azimuth) - repeat / 2, 0],
      placement: {
        bottom: (height - rowBottom) / height,
        height: (rowBottom - rowTop) / height,
      },
      generations: [generation],
    },
  ];
}
