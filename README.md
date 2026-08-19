# Console Chaos Racing

FC / SFC / PS1 / PS2 の 4 世代表現を 1 つのシミュレーションの上で切り替えるサーキットレース。

- 要求仕様: [`Docs/PLAN.md`](Docs/PLAN.md)
- 実装計画: [`Docs/IMPLEMENTATION_PLAN.md`](Docs/IMPLEMENTATION_PLAN.md)

不変条件は 1 つだけ — **シミュレーションは 1 つ。世代は表示と入出力の作法だけを変える**。

## セットアップ

このリポジトリは **クローンしただけでは `npm install` が通らない**。描画エンジン
`@console-chaos/engine` は npm レジストリに公開されておらず、tarball を `file:` 参照で
取り込んでいるためである（`.gitignore` で `reference/` を除外している。実装計画 §9-5 の決定）。

### 1. エンジン tarball を配置する

`ConsoleChaosEngine` リポジトリで `npm pack` して生成される tarball を、本リポジトリの
`reference/` 直下へ次の名前で置く。

```
reference/console-chaos-engine-0.2.0.tgz
```

| 項目 | 値 |
| --- | --- |
| パッケージ | `@console-chaos/engine@0.2.0` |
| 生成元 | `ConsoleChaosEngine` の `npm pack`（`artifacts/console-chaos-engine-0.2.0.tgz`） |
| SHA-256 | `e6b5b57c1a55179cccc3f1d690c1c481d418708f796039023dd6f4203b726d74` |

配置したら現物を照合する。

```bash
shasum -a 256 reference/console-chaos-engine-0.2.0.tgz
```

過去のバージョン:

| バージョン | SHA-256 |
| --- | --- |
| 0.1.0 | `0871693e0e662fab0652970d7e54dc10acd84ec4ce2a91000973ba44d41b1786` |

### 2. 依存を入れる

```bash
npm install
```

`package-lock.json` は `file:` 参照を記録するだけで tarball の中身を持たない。したがって
**tarball を差し替えても lockfile は変わらず、古い `node_modules` のまま動いてしまう**。
エンジンを更新したときは必ず次を実行する。

```bash
rm -rf node_modules && npm install
```

## 開発

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | Vite 開発サーバ（http://localhost:5173） |
| `npm run build` | 型チェック＋本番ビルド（`dist/`） |
| `npm run preview` | ビルド結果のプレビュー |
| `npm test` | Vitest（純ロジックのテスト） |
| `npm run typecheck` | 型チェックのみ |
| `npm run check:cars` | 変換済み車アセットの SHA-256 照合 |
| `npm run measure:pace` | 敵車の速度スケールとペース較正を実測（下記） |
| `npm run build:minimap` | コース中心線からミニマップ PNG とマーカーを生成 |
| `npm run build:assets` | 生成系アセットをまとめて再生成 |

### バランス定数の較正

`BALANCE.SPEED_SCALE`（敵車の速度倍率）と AI のペース較正は、**コース形状と車両定数から
決まる実測値**であって手で選べる数ではない。要求は「敵車が走行中に出す最高速度が自機の
0.95 倍」だが、直線が短いこのコースでは定数を 0.95 倍しても実測比は 0.971 にしかならない
（詳細は [`Docs/BALANCE_PLAN.md`](Docs/BALANCE_PLAN.md) §2.3）。

したがって**コース形状・車両定数・AI のライン計算を変えたら必ず流し直す**。

```bash
npm run measure:pace
```

実測が現在の定数とずれていれば異常終了する。出た値で `src/game/sim/` の定数を置き換える。

## 操作

| 入力 | 動作 |
| --- | --- |
| ← → | ステア |
| Z | アクセル |
| X | ブレーキ |
| C | 視点切替（第3・第4世代） |
| Q / E | 世代切替（前 / 次） |
| 1〜4 | 世代の直接指定（HUD の `CH n` と対応） |
| F | フラットディスプレイ（画面の丸み）の ON / OFF |
| M | モアレ（走査線と蛍光体マスク）の ON / OFF |
| Esc | ポーズ |
| Backspace | タイトルへ戻る |

タイトル画面を 5 秒放置すると、5 秒ごとに 1 → 4 世代を巡回する（何か操作すると止まる）。

## 動作要件

WebGL2 が使えるブラウザ。エンジンは ESM / ES2022 前提でビルドされている。

## ライセンス

`data/` の車ソース GLB とその派生物はプロジェクト所有の入力として扱う。
詳細は [`data/README.md`](data/README.md) を参照。
