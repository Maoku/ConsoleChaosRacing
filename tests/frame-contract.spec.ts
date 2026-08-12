import {
  GENERATION_IDS,
  geometryCommandKey,
  type GenerationId,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { MANIFEST } from '../src/assets/manifest.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * レンダラーが実行時に `throw` する条件と、例外にならないぶん気付きにくい事故を、
 * コマンド列の段階で検出する（実装計画 §6.2）。
 *
 * - `MeshCommand.material` に対応する `MaterialCommand` が無い → throw
 * - `MeshCommand.asset` が manifest に無い → throw
 * - ジオメトリが manifest に事前確保されていない → throw
 * - `SpriteCommand.texture` がアトラス登録されていない → throw
 * - マテリアルに `baseColorTexture` が無い → **例外にならず fallback 柄で描かれる**
 */

const MODEL_URLS = new Set(MANIFEST.models.map((model) => model.url));
const TEXTURE_URLS = new Set(MANIFEST.textures.map((texture) => texture.url));
const ATLAS_URLS = new Set(MANIFEST.atlases.map((atlas) => atlas.url));
const GEOMETRY_KEYS = new Set(MANIFEST.geometries.map((geometry) => geometryCommandKey(geometry)));

/** 走行中・グリッド上・完走後で、積まれるコマンドの顔ぶれが変わりうる */
const MOMENTS = [
  { name: 'カウントダウン中', ticks: 60 },
  { name: '走行中', ticks: 1500 },
  { name: '周回を跨いだ後', ticks: 6000 },
];

describe('フレームの契約', () => {
  for (const moment of MOMENTS) {
    describe(moment.name, () => {
      const state = raceAfter(moment.ticks);

      for (const generation of GENERATION_IDS) {
        it(`${generation}: すべてのメッシュに material があり、テクスチャを持つ`, () => {
          const frame = buildFrame(generation, state);
          const materials = new Map(frame.materials.map((material) => [material.id, material]));

          for (const mesh of frame.meshes) {
            const material = materials.get(mesh.material ?? '');
            expect(material, `${mesh.id} の material が無い（実行時 throw）`).toBeDefined();
            expect(
              material!.baseColorTexture,
              `${mesh.id} が fallback 柄で描かれる（例外にならない事故）`,
            ).toBeTruthy();
            expect(
              TEXTURE_URLS.has(material!.baseColorTexture!),
              `${material!.baseColorTexture} が manifest.textures に無い`,
            ).toBe(true);
          }
        });

        it(`${generation}: 参照するアセットがすべて manifest にある`, () => {
          const frame = buildFrame(generation, state);

          for (const mesh of frame.meshes) {
            if (mesh.asset === undefined) {
              expect(
                GEOMETRY_KEYS.has(geometryCommandKey(mesh.geometry)),
                `${mesh.id} のジオメトリが事前確保されていない`,
              ).toBe(true);
            } else {
              expect(MODEL_URLS.has(mesh.asset), `${mesh.asset} が manifest.models に無い`).toBe(
                true,
              );
              // asset を使うメッシュでも quad の halfSize はモデル行列へ掛かる
              if (mesh.geometry.kind === 'quad') {
                expect(mesh.geometry.halfSize).toEqual([1, 1]);
              }
            }
          }

          for (const sprite of frame.sprites) {
            expect(sprite.texture, `${sprite.id} にテクスチャが無い`).toBeTruthy();
            expect(
              ATLAS_URLS.has(sprite.texture!),
              `${sprite.texture} が manifest.atlases に無い（スプライトはアトラス経由のみ）`,
            ).toBe(true);
          }
        });

        it(`${generation}: コマンドがその世代だけに限定されている`, () => {
          const frame = buildFrame(generation, state);
          const commands = [
            ...frame.meshes,
            ...frame.sprites,
            ...frame.materials,
            ...frame.backgrounds,
            ...frame.lights,
          ];
          expect(commands.length).toBeGreaterThan(0);
          for (const command of commands) {
            // 切替演出中は 2 世代ぶんが同じフレームへ積まれる。混ざらないよう必ず絞る
            expect(command.generations).toEqual([generation as GenerationId]);
          }
        });
      }
    });
  }

  it('切替演出中に 2 世代を積んでも互いのコマンドが混ざらない', () => {
    const state = raceAfter(1500);
    const frame = buildFrame('PS1', state);
    const before = frame.meshes.length;
    // 同じフレームへ FC のビューも積む（GameHost が切替中にやること）
    const merged = buildFrame('FC', state);
    for (const sprite of merged.sprites) frame.sprites.push(sprite);

    expect(frame.meshes).toHaveLength(before);
    const ps1Sprites = frame.sprites.filter((sprite) => sprite.generations?.[0] === 'PS1');
    const fcSprites = frame.sprites.filter((sprite) => sprite.generations?.[0] === 'FC');
    expect(ps1Sprites.length).toBeGreaterThan(0);
    expect(fcSprites.length).toBeGreaterThan(0);
    expect(ps1Sprites.length + fcSprites.length).toBe(frame.sprites.length);
  });

  it('第3世代は路面を三角形単位に分配し、車を固定スロットへ置く', () => {
    const frame = buildFrame('PS1', raceAfter(1500));
    const trackMeshes = frame.meshes.filter((mesh) => mesh.id.startsWith('track-'));
    const carMeshes = frame.meshes.filter((mesh) => mesh.id.startsWith('car-'));

    expect(trackMeshes.length).toBeGreaterThan(0);
    expect(carMeshes).toHaveLength(8);

    for (const mesh of trackMeshes) {
      expect(mesh.polygonSortRange).toEqual([1, 8]);
      expect(mesh.orderTableIndex).toBeUndefined();
    }
    // 車は路面の分配範囲より必ず後のスロットへ（深度バッファが無くても埋まらない）
    for (const mesh of carMeshes) {
      expect(mesh.orderTableIndex).toBe(9);
    }
  });

  it('第3世代のフレームが三角形予算に収まる', () => {
    const frame = buildFrame('PS1', raceAfter(1500));
    // セクター 3 つ ＋ 車 8 台。§6.3 の予算は 20,000 tri/frame
    const trackMeshes = frame.meshes.filter((mesh) => mesh.id.startsWith('track-'));
    expect(trackMeshes.length).toBeLessThanOrEqual(3);
  });
});
