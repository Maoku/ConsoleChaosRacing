#!/usr/bin/env node
/**
 * public/assets/car-conversion.json に記録された SHA-256 と現物を照合する。
 *
 * 記録されたパスはリポジトリルート相対なので、そのまま読む（実装計画 §2.4）。
 * 変換記録そのものは tools/prepare-cars.mjs（フェーズ 2）が書き出す。
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = join(repoRoot, 'public/assets/car-conversion.json');

async function digest(relativePath) {
  const absolute = join(repoRoot, relativePath);
  const bytes = await readFile(absolute);
  const { size } = await stat(absolute);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size };
}

const failures = [];

async function verify(label, entry) {
  let actual;
  try {
    actual = await digest(entry.path);
  } catch (error) {
    failures.push(`${label}: ${entry.path} を読めない (${error.code ?? error.message})`);
    return;
  }
  if (actual.sha256 !== entry.sha256) {
    failures.push(
      `${label}: ${entry.path} の SHA-256 不一致\n    記録 ${entry.sha256}\n    現物 ${actual.sha256}`,
    );
    return;
  }
  if (entry.bytes !== undefined && actual.bytes !== entry.bytes) {
    failures.push(
      `${label}: ${entry.path} のバイト数不一致 (記録 ${entry.bytes} / 現物 ${actual.bytes})`,
    );
    return;
  }
  console.log(`  ok  ${entry.path}`);
}

const record = JSON.parse(await readFile(recordPath, 'utf8'));
console.log(`car-conversion.json v${record.version} — ${record.records.length} レコード`);

for (const item of record.records) {
  console.log(`[${item.generation}]`);
  await verify(item.generation, item.source);
  await verify(item.generation, item.runtime.model);
  // 車輪は位相ぶん（フェーズ 12-7）。1 枚でも欠けると車が空中を滑る
  for (const file of item.runtime.wheels?.files ?? []) {
    await verify(item.generation, file);
  }
  await verify(item.generation, item.runtime.texture);
}

if (failures.length > 0) {
  console.error('\ncheck:cars 失敗');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\ncheck:cars 通過');
