import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vitest/config';

/**
 * 開発時だけの画面取り込み口（実装計画 §7 フェーズ 8-2「スクリーンショットを
 * `Docs/screenshots/` に保存する」）。
 *
 * `POST /__screenshot?name=gen1-title` の本文（PNG）をそのままファイルへ書く。
 * ブラウザ側からは `canvas.toBlob()` の結果を投げるだけでよく、
 * 品質ゲートの証拠がリポジトリに残る。**`apply` を `serve` に絞ってあるので
 * 本番ビルドには 1 バイトも入らない。**
 */
function screenshotEndpoint(): Plugin {
  const root = resolve('.');
  return {
    name: 'racing-screenshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__screenshot', (request, response) => {
        const url = new URL(request.url ?? '', 'http://localhost');
        const name = (url.searchParams.get('name') ?? 'screenshot').replace(/[^\w.-]/g, '');
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const file = join(root, 'Docs/screenshots', `${name}.png`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.concat(chunks));
          response.statusCode = 200;
          response.end(`${chunks.reduce((total, chunk) => total + chunk.length, 0)}`);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotEndpoint()],
  // リポジトリルート = アプリルート（Docs/IMPLEMENTATION_PLAN.md §2.4）
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
