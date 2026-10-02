# スプライトの向きとFDS同梱Engineへの移行

旧レース素材はscreenSpaceスプライトのY-down投影を相殺するため、各セルの中で事前に上下反転していた。
FDS同梱Engineは `writeSpriteModelMatrix` でscreenSpaceのYスケールを負に補正し、画像上端を画面上端へ貼る。
古い反転素材をそのまま使うと、Gen1/2の車体・看板/木と全世代のHUDが逆さまになる。
Gen3/4の車体は3Dメッシュ、木はworld-space billboardなので、このscreenSpace差の影響を受けない。
音声のFDS処理ではなく、依存Engineの更新と素材規約の互換差が原因だった。

フォント、タイトルロゴ、車スプライト、擬似3D風景、ミニマップ、タコメーター、コックピット/ステアリングを正立で再生成する。
セルの並び・車体接地線・パレット・コース座標は変えない。Gen3/4のworld-space風景、カメラ、投影、ポスト処理、音声、セーブは変更しない。

```sh
npm run build:font
npm run build:logo
npm run build:sprites
npm run build:scenery
npm run build:minimap
npm run build:gauge
npm run build:cockpit
npm run typecheck
npm test
npm run build
```

PNGの圧縮バイトはNode/zlibの環境により異なる。`car-palette.spec.ts` は保存PNGと2回の再生成の寸法・全RGBA画素を比較し、色や透明度の変化を許容せず決定論を検査する。
`sprite-image-orientation.spec.ts` は同梱EngineとP字形の組合せ、ミニマップの線とマーカーの座標、上向き針、下側ダッシュボード/スポークを検査する。
既存のフォント・車体・風景テストも、画像を反転して読み戻す旧前提を除き、画像そのものの上下を検査する。

TsumugiのNode26で型検査、本番ビルド、39ファイル571テストが成功。
Tsumugiの実ブラウザでタイトルとレース開始、Gen1〜4の車体・風景・HUD・ミニマップの正立を切替後の定常画面で確認した。
FDS設定での各世代確認後、通常音源へ切り替えてGen1〜4を再度切り替えた。Gen4コックピット、一時停止/再開、FDSへ戻した後の再読込と設定保持も確認した。
ブラウザで取得できた警告・エラーは0件。音の波形・聴感品質はこの視覚検証の対象に含めていない。
