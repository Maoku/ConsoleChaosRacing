import type { RenderAssetManifest } from '@console-chaos/engine';

/**
 * レンダラーへ渡すアセット目録（実装計画 付録 B）。
 *
 * 規約:
 * - スプライトとして描く画像は `atlases` にだけ登録する。レンダラーは atlas の URL も
 *   画像として読み込み `flipY:false` / `wrap:'clamp'` を強制するため、`textures` への
 *   二重登録は無意味（`textures` 側の指定は無視される）。
 * - `textures` に載せるのは背景・マテリアル・サーフェスが参照するものだけ。
 * - 生成物（font / logo / markers / minimap / track）は、生成したフェーズで追加する。
 *   `manifest.spec.ts` が全 URL の実在を検査するため、先に書くとテストが落ちる。
 */
export const MANIFEST: RenderAssetManifest = {
  textures: [
    { url: 'assets/common/fallback.png', wrap: 'clamp' },
    { url: 'assets/gen1/road/road.png', wrap: 'clamp' }, // V は CPU 側で fract 済み
    { url: 'assets/gen1/backgrounds/coast.png', wrap: 'repeat' },
    { url: 'assets/gen2/tiles/circuit.png', wrap: 'clamp' },
    { url: 'assets/gen2/backgrounds/coast.png', wrap: 'repeat' },
    { url: 'assets/gen3/textures/car_base_color.png', wrap: 'clamp' },
    { url: 'assets/gen4/textures/car_base_color.png', wrap: 'clamp' },
    { url: 'assets/gen4/environment/circuit.png', wrap: 'repeat' },
  ],
  atlases: [
    { url: 'assets/gen1/sprites/cars.png', columns: 3, rows: 2 },
    { url: 'assets/gen2/sprites/cars.png', columns: 3, rows: 2 },
    // 生成物（tools/build-minimap.mjs・フェーズ 1）
    { url: 'assets/common/markers.png', columns: 2, rows: 1 }, // 丸 / 四角。色は SpriteCommand.color
    { url: 'assets/gen1/hud/minimap.png', columns: 1, rows: 1 },
    { url: 'assets/gen2/hud/minimap.png', columns: 1, rows: 1 },
    { url: 'assets/gen3/hud/minimap.png', columns: 1, rows: 1 },
    { url: 'assets/gen4/hud/minimap.png', columns: 1, rows: 1 },
  ],
  models: [
    { url: 'assets/gen3/models/car.glb', polygonSort: true },
    { url: 'assets/gen4/models/car.glb' },
  ],
  geometries: [
    { kind: 'box', halfExtents: [0.5, 0.5, 0.5] },
    { kind: 'quad', halfSize: [1, 1] },
  ],
  fallbackTextures: {
    FC: 'assets/common/fallback.png',
    SFC: 'assets/common/fallback.png',
    PS1: 'assets/common/fallback.png',
    PS2: 'assets/common/fallback.png',
  },
};

/** manifest.spec.ts / 生成ツールが参照する、全アセット URL の平坦なリスト。 */
export function manifestUrls(manifest: RenderAssetManifest = MANIFEST): readonly string[] {
  return [
    ...manifest.textures.map((texture) => texture.url),
    ...manifest.atlases.map((atlas) => atlas.url),
    ...manifest.models.map((model) => model.url),
    ...new Set(Object.values(manifest.fallbackTextures)),
  ];
}
