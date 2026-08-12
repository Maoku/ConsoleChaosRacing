import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { GENERATION_IDS } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { MANIFEST, manifestUrls } from '../src/assets/manifest.js';

const publicRoot = join(process.cwd(), 'public');

describe('アセット目録', () => {
  it('すべての URL が public/ に実在する', () => {
    const missing = manifestUrls().filter((url) => !existsSync(join(publicRoot, url)));
    expect(missing).toEqual([]);
  });

  it('スプライトとして描くものは atlases にだけ登録されている', () => {
    // レンダラーは atlas の URL に flipY:false / wrap:'clamp' を強制するので、
    // textures への二重登録は効かない。事故を型ではなくテストで防ぐ
    const textureUrls = new Set(MANIFEST.textures.map((texture) => texture.url));
    for (const atlas of MANIFEST.atlases) {
      expect(textureUrls.has(atlas.url), `${atlas.url} が textures にも登録されている`).toBe(
        false,
      );
    }
  });

  it('4 世代ぶんのフォールバックテクスチャが textures にある', () => {
    const textureUrls = new Set(MANIFEST.textures.map((texture) => texture.url));
    for (const generation of GENERATION_IDS) {
      expect(textureUrls.has(MANIFEST.fallbackTextures[generation])).toBe(true);
    }
  });

  it('URL に重複が無い', () => {
    const urls = manifestUrls();
    expect(new Set(urls).size).toBe(new Set(urls).size);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const url of [
      ...MANIFEST.textures.map((entry) => entry.url),
      ...MANIFEST.atlases.map((entry) => entry.url),
      ...MANIFEST.models.map((entry) => entry.url),
    ]) {
      if (seen.has(url)) duplicates.push(url);
      seen.add(url);
    }
    expect(duplicates).toEqual([]);
  });
});
