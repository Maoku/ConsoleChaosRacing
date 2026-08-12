import { GENERATION_IDS, HARDWARE_GENERATION_PROFILES } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { stepRace } from '../src/game/sim/race.js';
import { ENTRANT_COUNT, createRaceState } from '../src/game/sim/state.js';
import { TRACK, createTrack } from '../src/game/sim/track.js';
import {
  MINIMAP_LAYOUTS,
  minimapNormalized,
  minimapPoint,
  minimapProjection,
  textureRect,
} from '../src/game/view/shared/minimap-layout.js';
import {
  buildMinimap,
  defaultMinimapRect,
  fullScreenMinimapRect,
} from '../src/game/view/shared/minimap.js';

function raceAfter(ticks: number) {
  const state = createRaceState({ seed: 20260812, autoPilot: true });
  for (let tick = 0; tick < ticks; tick++) stepRace(state);
  return state;
}

describe('ミニマップ', () => {
  it('8 台のマーカーの正規化座標が 4 世代で完全に一致する', () => {
    const state = raceAfter(1500);

    const perGeneration = GENERATION_IDS.map((generation) => {
      const profile = HARDWARE_GENERATION_PROFILES[generation];
      const view = buildMinimap({
        generation,
        profile,
        state,
        rect: defaultMinimapRect(generation, profile),
        frameIndex: 3,
      });
      // 登録順は世代で変わらないが、比較はエントラント番号で揃える
      return new Map(view.markers.map((marker) => [marker.entrant, marker.normalized]));
    });

    const reference = perGeneration[0]!;
    expect(reference.size).toBe(ENTRANT_COUNT);
    for (const markers of perGeneration.slice(1)) {
      expect(markers.size).toBe(ENTRANT_COUNT);
      for (const [entrant, normalized] of reference) {
        // 完全一致（誤差ではなくビット一致）。同じ 1 本の計算を通っている証拠
        expect(markers.get(entrant)).toEqual(normalized);
      }
    }
  });

  it('マーカーは常に 8 個あり、矩形の内側に収まる', () => {
    for (const ticks of [0, 300, 1500, 6000]) {
      const state = raceAfter(ticks);
      for (const generation of GENERATION_IDS) {
        const profile = HARDWARE_GENERATION_PROFILES[generation];
        const rect = defaultMinimapRect(generation, profile);
        const view = buildMinimap({ generation, profile, state, rect });

        expect(view.markers).toHaveLength(ENTRANT_COUNT);
        expect(new Set(view.markers.map((marker) => marker.entrant)).size).toBe(ENTRANT_COUNT);

        for (const marker of view.markers) {
          expect(marker.normalized[0]).toBeGreaterThanOrEqual(0);
          expect(marker.normalized[0]).toBeLessThanOrEqual(1);
          expect(marker.normalized[1]).toBeGreaterThanOrEqual(0);
          expect(marker.normalized[1]).toBeLessThanOrEqual(1);
          expect(marker.position[0]).toBeGreaterThanOrEqual(rect.left);
          expect(marker.position[0]).toBeLessThanOrEqual(rect.left + rect.width);
          expect(marker.position[1]).toBeGreaterThanOrEqual(rect.top);
          expect(marker.position[1]).toBeLessThanOrEqual(rect.top + rect.height);
        }
      }
    }
  });

  it('自機は必ず先頭に登録され、ライバルの登録順は毎フレーム巡回する', () => {
    const state = raceAfter(900);
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    const rect = defaultMinimapRect('FC', profile);

    const orderAt = (frameIndex: number): number[] =>
      buildMinimap({ generation: 'FC', profile, state, rect, frameIndex }).markers.map(
        (marker) => marker.entrant,
      );

    const first = orderAt(0);
    expect(first[0]).toBe(0);
    for (let frameIndex = 0; frameIndex < 7; frameIndex++) {
      const order = orderAt(frameIndex);
      expect(order[0]).toBe(0);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
    // 7 台のライバルなので 7 フレームで一巡し、途中では順序が変わっている
    expect(orderAt(1)).not.toEqual(first);
    expect(orderAt(7)).toEqual(first);
  });

  it('FC の枠は 8px グリッドに載り、マーカーは 1 画素単位で置かれる', () => {
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    const rect = defaultMinimapRect('FC', profile);
    expect(profile.video.tileSnap).toBe(8);
    expect(rect.left % 8).toBe(0);
    expect(rect.top % 8).toBe(0);

    // 枠が画面内（安全領域の内側）に収まる
    expect(rect.left + rect.width).toBeLessThanOrEqual(profile.video.internalWidth);
    expect(rect.top + rect.height).toBeLessThanOrEqual(profile.video.internalHeight);
  });

  it('FC は半透明を一切使わない（能力契約）', () => {
    const state = raceAfter(600);
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    expect(profile.video.alphaBlend).toBe(false);
    expect(MINIMAP_LAYOUTS.FC.panelAlpha).toBe(0);

    const view = buildMinimap({
      generation: 'FC',
      profile,
      state,
      rect: defaultMinimapRect('FC', profile),
    });
    // 枠 1 枚 ＋ マーカー 8 枚。影も強調縁も置かない
    expect(view.sprites).toHaveLength(ENTRANT_COUNT + 1);
    expect(view.meshes).toHaveLength(0);
    for (const sprite of view.sprites) {
      expect(sprite.screenSpace).toBe(true);
      expect(sprite.alphaCutoff).toBeGreaterThan(0);
    }
  });

  it('真色世代（スプライトが描かれない）では板メッシュで同じ矩形を埋める', () => {
    const state = raceAfter(600);
    const camera = {
      projection: 'perspective' as const,
      position: [0, 2, 8] as const,
      target: [0, 2, 0] as const,
      zoom: 8,
      fovDegrees: 60,
    };

    for (const generation of ['PS1', 'PS2'] as const) {
      const profile = HARDWARE_GENERATION_PROFILES[generation];
      expect(profile.video.paletteMode).toBe('truecolor');

      const view = buildMinimap({
        generation,
        profile,
        state,
        rect: defaultMinimapRect(generation, profile),
        camera,
      });

      expect(view.sprites).toHaveLength(0);
      expect(view.meshes.length).toBeGreaterThanOrEqual(ENTRANT_COUNT + 1);

      // すべてのメッシュに対応するマテリアルがあり、必ずテクスチャを持つ
      const materials = new Map(view.materials.map((material) => [material.id, material]));
      for (const mesh of view.meshes) {
        const material = materials.get(mesh.material ?? '');
        expect(material, `${mesh.id} のマテリアルが無い`).toBeDefined();
        expect(material!.baseColorTexture, `${mesh.id} が fallback 柄で描かれる`).toBeTruthy();
      }
    }
  });

  it('カメラを渡さなければ板メッシュ経路は何も積まない', () => {
    const state = raceAfter(120);
    const profile = HARDWARE_GENERATION_PROFILES.PS1;
    const view = buildMinimap({
      generation: 'PS1',
      profile,
      state,
      rect: defaultMinimapRect('PS1', profile),
    });
    // 描けないことを黙って隠さない。マーカーの論理位置だけは常に求まる
    expect(view.sprites).toHaveLength(0);
    expect(view.meshes).toHaveLength(0);
    expect(view.markers).toHaveLength(ENTRANT_COUNT);
  });

  it('生成ツールと実行時が同じ trackBounds を見ている', () => {
    // ツールは src/game/sim/track.ts を直接 import する。同じ制御点から作れば同値
    const rebuilt = createTrack();
    expect(rebuilt.bounds.min).toEqual(TRACK.bounds.min);
    expect(rebuilt.bounds.max).toEqual(TRACK.bounds.max);
    expect(rebuilt.bounds.size).toEqual(TRACK.bounds.size);
  });

  it('テクスチャの射影と実行時の射影が一致する', () => {
    // ツールは textureRect(size) と layout.margin で描く。実行時に同じ寸法の矩形を
    // 与えれば、俯瞰図の画素とマーカーの画素が 1 対 1 で重なる
    for (const generation of GENERATION_IDS) {
      const layout = MINIMAP_LAYOUTS[generation];
      const rect = { left: 0, top: 0, width: layout.size, height: layout.size };
      const fromTool = minimapProjection(TRACK.bounds, textureRect(layout.size), layout.margin);
      const atRuntime = minimapProjection(TRACK.bounds, rect, layout.margin);
      expect(atRuntime).toEqual(fromTool);

      // スタート地点がテクスチャ上でも実行時でも同じ画素に落ちる
      const start = TRACK.toWorld(0, 0);
      expect(minimapPoint(atRuntime, start[0], start[2])).toEqual(
        minimapPoint(fromTool, start[0], start[2]),
      );
    }
  });

  it('矩形を変えても正規化座標は変わらない（縮小配置しても位置が飛ばない）', () => {
    const state = raceAfter(2400);
    const profile = HARDWARE_GENERATION_PROFILES.PS2;
    const small = buildMinimap({
      generation: 'PS2',
      profile,
      state,
      rect: defaultMinimapRect('PS2', profile),
    });
    const large = buildMinimap({
      generation: 'PS2',
      profile,
      state,
      rect: fullScreenMinimapRect(profile),
    });
    for (let index = 0; index < small.markers.length; index++) {
      expect(large.markers[index]!.normalized).toEqual(small.markers[index]!.normalized);
    }
  });

  it('正規化座標がコース全周をきちんと覆う', () => {
    // 全周を歩いて正規化座標の範囲を見る。片側に寄っていたら bounds が壊れている
    let minU = 1;
    let maxU = 0;
    let minV = 1;
    let maxV = 0;
    for (let s = 0; s < TRACK.length; s += 5) {
      const world = TRACK.toWorld(s, 0);
      const [u, v] = minimapNormalized(TRACK.bounds, world[0], world[2]);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    // AABB は最大半幅ぶん外へ広げてあるので、中心線は端まで届かない
    expect(minU).toBeLessThan(0.02);
    expect(maxU).toBeGreaterThan(0.98);
    expect(minV).toBeLessThan(0.02);
    expect(maxV).toBeGreaterThan(0.98);
  });
});
