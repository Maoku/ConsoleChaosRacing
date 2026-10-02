# Gen1 FDS-inspired audio / 2026-10-02

この作業ブランチは `dev/four-stage-demo` の完成版 `fdf92b60df38a3d6788394dbc048aea13e446863` が基準。保存環境の旧 `work` ブランチは残している。実機エミュレーターではなく、既存エンジンの世代表現に追加する任意の音色。

## 使い方

右下「音声設定」で **FC 通常音源 / FC + FDS 拡張音源** を選択する。既定は通常音源。選択は第1世代にだけ作用し、第2〜4世代では元の音源が使われる。第1世代へ戻ると保存された選択が復帰する。BGM・効果音スライダーと全音声ミュートは独立したゲインを通す。保存キーは謎解き `chaos.audio.v1`、レース `chaos.racing.audio.v1`。既存キャンペーン・表示設定を変更しない。保存不能・不正JSONは安全に既定値へ戻す。

音声開始はユーザー操作から既存の unlock 経路を通す。全体ミュートは曲の進行を維持し、既存のBGMミュートは従来どおり再生位置を保存して止める。非表示タブは音楽を一時停止し、戻ると再開。レースのポーズとタブ非表示は別々の理由で管理し、片方の解除だけでは再開しない。

## 調査と再現範囲

- FDSはベースAPUに追加する単音1声。64点 unsigned 6bit 波形、12bitピッチ。非変調時は `1789773 * pitch / 4194304 Hz`、A4 は pitch 1031（約439.943 Hz）。波形・ピッチ・音量のレジスタ構成は [NESdev FDS audio](https://www.nesdev.org/wiki/FDS_audio) および [Mesen2 FdsAudio.cpp](https://raw.githubusercontent.com/SourMesen/Mesen2/master/Core/NES/Mappers/FDS/FdsAudio.cpp) を参照。NESdev本文はこの環境から403だったため、コードと別途受領した調査メモも照合した。
- 変調器は別の可聴声ではない。32個の3bitコードを各2回進める64段階。コードは `0,+1,+2,+4,reset,-4,-2,-1`、カウンタはsigned7bitで折返す。[Mesen2 ModChannel.h](https://raw.githubusercontent.com/SourMesen/Mesen2/master/Core/NES/Mappers/FDS/ModChannel.h)
- 音量gainは6bitだが32で頭打ち。実機のmaster attenuationは1, 2/3, 1/2, 2/5。本実装の音量は0〜32の離散値と32段階のノート包絡を使用する。エンベロープのハードタイマーは再現しない。Mesenの周期式は `8*(speed+1)*masterSpeed`。NESdev記述との差や実測モデルの違いは採用していない。[Mesen2 BaseFdsChannel.h](https://raw.githubusercontent.com/SourMesen/Mesen2/master/Core/NES/Mappers/FDS/BaseFdsChannel.h)

実装は独自作成で、Mesenコードを移植していない。64点整数波形とピッチ量子化、コードの2回送り、カウンタwrap/reset、単音制限は実装する。**変調速度は5Hz固定、深さはbias/1024の音楽用近似**。実測の24bit位相・16CPUクロック更新・特殊丸めは実装せず、旧モデルと新モデルを混ぜて忠実再現とは称さない。参考: [NESdev実測議論](https://forums.nesdev.org/viewtopic.php?start=15&t=10233)。レジスタ書込みタイミング・波形書込みgate・ハードエンベロープ・可変master attenuation・非線形APUミキサー・実機のアナログ個体差も対象外。

波形平均を引いてDC成分を除き、約2kHzの一次ローパスをPCM合成で近似。Web Audioサンプル時刻で位相を進めるためcycle accurateでも完全なアンチエイリアス処理でもない。APUは従来の様式的な5声実装を保持する。FDSはBGMの主旋律を重ねて厚みを足す独立単音で、効果音には使わない。複数の主旋律要求が来ても次の開始時刻で前のFDS声を停止する。APU伴奏とFDSは同じBGMバスへ加算し、SFXバスから分離する。

## オリジナル楽曲

謎解き「境界の鼓動」: 32小節、探索A→応答A'→緊張B→展開C。4ステージは旋律順序・移調・テンポが異なる。色をほどく回廊116 BPM、回転の庭園128、灯と継ぎ目の坑道108、終端の心臓140。ループ長は約66.2 / 60 / 71.1 / 54.9秒。ステージ遷移で対応曲へ替わり、同曲内の世代・音源切替では位置を保つ。既存pop/calmの選曲も残す。動的な危険度連動ではなく、曲中の構成として探索・緊張・展開を表す。

レース「Neon overdrive」: 152 BPM、32小節、約50.5秒。8分の推進力、4つの異なる8小節モチーフ、後半の高音域と着地で高揚感を作る。既存のベース・ドラム・世代別編成を土台に新規旋律を作成。既存市販曲の引用・ROM・音声素材は使用していない。

## 検証と試聴の再生成（以下は隣のConsoleChaosEngineルートで実行）

```sh
npm ci --cache /tmp/npm-cache
npm run pack:distribution
npm run test:engine
npm run test:console
npm run lint -w @console-chaos/engine
npm run lint -w @console-chaos/console-chaos
npm run build:console
npm run dev -w @console-chaos/console-chaos -- --host 0.0.0.0
# 別ターミナル。レースを隣に置く場合
./node_modules/.bin/tsx tools/render-fds-preview.ts artifacts/fds-preview ../ConsoleChaosRacing/src/game/audio/score.ts
python tools/verify-fds-browser.py artifacts/fds-preview
```

ブラウザ検証はPython Playwright、`/usr/bin/chromium`、謎解き5173・レース5174で起動したViteが必要。公開・pushは行わない。試聴WAVはゲームと同じ音源・スコア・スケジューラをweb-audio-engineでオフライン実行し、各曲1周+2秒（ループ境界を含む）を48kHz mono PCMで保存。BGM/master最大の比較用で、ゲームの既定音量より大きい。ヘッドホン・スピーカーでの実聴はできていないため、主観的な音楽品質や実機との聴感一致は未確認。

既存スケジューラはゲーム更新から120ms先を予約する。AudioWorklet独立駆動ではなく、120msを超えるメインスレッド停止中の連続再生は保証しない。追加ランタイム依存はなく、Web Audioが利用できない環境では既存の無音起動経路を維持する。

## 最終検証結果

- 謎解き: 57ファイル492テスト成功。最終追加の単音停止テストを含む音声重点テスト11件も成功（合計493件相当）。engine/testkit: 48テスト成功。ワークスペース全体lint/型検査成功。謎解き本番ビルド、import境界、描画budget、レベル、商標チェック成功。
- レース: 更新済み同梱エンジンからnpm ci成功。38ファイル563テスト成功。tscと本番ビルド成功。
- エンジンtarballのconsumer実行・型smoke検証成功。SHA-256: `e2f5124c9778262942d437b1075196025df4c47829702911cc573ad391450ef3`。
- Chromium: 音源選択/世代反復切替、Gen2への非漏洩、音量/ミュート、リロード保存復元、停止/再開。停止後の残存発音ノード0、ページエラー0。自動再生規制そのものはheadlessで再現されなかったため、AudioContextを明示的にsuspendしてユーザー操作でrunningへ復帰することを確認した。実ブラウザ各社の規制差は未検証。
- 謎解き既存の通しブラウザ検証: 4ステージ・endingまで成功、falls 0、pageErrors/failedRequestsなし。これは検証用操作による通過で人手プレイ評価ではない。
- 48kHz全10曲WAV（各曲1周+2秒）で有限値、最大peak 0.3541未満。44.1/48kHzの30秒負荷試験を各2回実行し同一hash。最大音量で効果音と音源切替を重ねてもpeak 0.352未満。ミュート区間peakは約3e-23。
- 詳細数値は [検証記録](fds-evidence/pcm-report.json)、[負荷試験](fds-evidence/stress-report.json)、[ブラウザ](fds-evidence/browser-report.json)。

ノード検証は発音ソースのendedを数えたもので、長時間のヒープ全体のリーク不存在までは証明しない。音声の実聴、Safari/Firefox/スマートフォン、実機波形との比較は未実施。
