/**
 * 依存無しの最小 PNG エンコーダ／デコーダと、生成ツールが使う小さなラスタ。
 *
 * 生成ツールは**決定論的**であることが要件（実装計画 §2.6）なので、
 * 圧縮設定を固定し、浮動小数の丸めも明示的に行う。
 *
 * デコーダは本作が実際に扱う範囲だけを読む（8bit / colorType 2・6 / 非インターレース）。
 * 汎用にはしない — 範囲外は明示的に失敗させる。
 */
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** RGBA8 のピクセル列を PNG へ。`pixels` は width * height * 4 バイト */
export function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // フィルタは全行 0（None）に固定する。決定論のためであり、
  // ミニマップのような小さな画像では圧縮率もほぼ変わらない。
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy
      ? pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 単純な RGBA ラスタ。座標は整数画素、色は 0..255 */
export class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
  }

  /** src-over 合成。`alpha` は 0..1 */
  blend(x, y, [red, green, blue], alpha) {
    if (alpha <= 0) return;
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const offset = (py * this.width + px) * 4;
    const source = Math.min(1, alpha);
    const destinationAlpha = this.pixels[offset + 3] / 255;
    const outAlpha = source + destinationAlpha * (1 - source);
    if (outAlpha <= 0) return;
    for (let channel = 0; channel < 3; channel++) {
      const destination = this.pixels[offset + channel] / 255;
      const value =
        ([red, green, blue][channel] / 255) * source +
        destination * destinationAlpha * (1 - source);
      this.pixels[offset + channel] = Math.round((value / outAlpha) * 255);
    }
    this.pixels[offset + 3] = Math.round(outAlpha * 255);
  }

  /** 中心 (x, y)・直径 `width` の点。`width` が 1 なら 1 画素 */
  dot(x, y, width, color, alpha = 1) {
    const radius = width / 2;
    const minX = Math.floor(x - radius);
    const maxX = Math.ceil(x + radius);
    const minY = Math.floor(y - radius);
    const maxY = Math.ceil(y + radius);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const distance = Math.hypot(px + 0.5 - x, py + 0.5 - y);
        // 端を 1 画素ぶんだけなだらかにする。FC 用は呼び出し側で hard=true にする
        const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance));
        if (coverage > 0) this.blend(px, py, color, coverage * alpha);
      }
    }
  }

  /** アンチエイリアス無しの点。FC / SFC の色数制約を守るために使う */
  hardDot(x, y, width, color, alpha = 1) {
    const half = (width - 1) / 2;
    const centerX = Math.round(x);
    const centerY = Math.round(y);
    for (let py = Math.round(centerY - half); py <= Math.round(centerY + half); py++) {
      for (let px = Math.round(centerX - half); px <= Math.round(centerX + half); px++) {
        this.blend(px, py, color, alpha);
      }
    }
  }

  /**
   * 上下を反転する。
   *
   * レンダラーはアトラス画像を `flipY: false` で取り込むため、画像の 1 行目が
   * スプライトの下端に来る。俯瞰図は画面座標系（Y 下向き）で描いているので、
   * 書き出しの直前にここで反転して辻褄を合わせる。
   */
  flipVertical() {
    const stride = this.width * 4;
    const row = Buffer.alloc(stride);
    for (let y = 0; y < Math.floor(this.height / 2); y++) {
      const top = y * stride;
      const bottom = (this.height - 1 - y) * stride;
      this.pixels.copy(row, 0, top, top + stride);
      this.pixels.copy(this.pixels, top, bottom, bottom + stride);
      row.copy(this.pixels, bottom);
    }
    return this;
  }

  toPng() {
    return encodePng(this.width, this.height, this.pixels);
  }
}

// ─────────────────────────────────────────────────────────────
// デコード
// ─────────────────────────────────────────────────────────────

/**
 * PNG → { width, height, pixels }（RGBA8）。
 * 対応: bitDepth 8 / colorType 2 (RGB)・6 (RGBA) / 非インターレース。
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG のシグネチャが一致しない');

  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('IHDR が無い');
  if (header.bitDepth !== 8) throw new Error(`bitDepth ${header.bitDepth} は非対応（8 のみ）`);
  if (header.interlace !== 0) throw new Error('インターレース PNG は非対応');
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`colorType ${header.colorType} は非対応（2 / 6 のみ）`);
  }

  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(header.width * header.height * 4);

  // 直前の行を持ち回りながらフィルタを外す（PNG 仕様 §9）
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    unfilterRow(filter, row, previous, channels);

    for (let x = 0; x < header.width; x++) {
      const from = x * channels;
      const to = (y * header.width + x) * 4;
      out[to] = row[from];
      out[to + 1] = row[from + 1];
      out[to + 2] = row[from + 2];
      out[to + 3] = channels === 4 ? row[from + 3] : 255;
    }
    previous = row;
  }

  return { width: header.width, height: header.height, pixels: out };
}

function unfilterRow(filter, row, previous, bytesPerPixel) {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bytesPerPixel; i < row.length; i++) row[i] = (row[i] + row[i - bytesPerPixel]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < row.length; i++) row[i] = (row[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < row.length; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
        row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < row.length; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
        const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
        row[i] = (row[i] + paeth(left, previous[i], upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`未知の PNG フィルタ: ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 整数倍のボックス縮小。1024² → 256² のように割り切れる場合だけを扱う。
 *
 * 整数倍に限るのは決定論のため — 任意倍率のリサンプルはフィルタの選び方で
 * 結果が変わり、「二度実行してバイト一致」の保証が設計判断に依存してしまう。
 */
export function downscaleBox(image, factor) {
  if (!Number.isInteger(factor) || factor < 1) throw new Error('縮小率は 1 以上の整数のみ');
  if (image.width % factor !== 0 || image.height % factor !== 0) {
    throw new Error(`${image.width}x${image.height} を ${factor} で割り切れない`);
  }
  const width = image.width / factor;
  const height = image.height / factor;
  const pixels = Buffer.alloc(width * height * 4);
  const samples = factor * factor;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const from = ((y * factor + sy) * image.width + x * factor + sx) * 4;
          r += image.pixels[from];
          g += image.pixels[from + 1];
          b += image.pixels[from + 2];
          a += image.pixels[from + 3];
        }
      }
      const to = (y * width + x) * 4;
      // 四捨五入は Math.round に固定する（丸め方を変えると出力が変わる）
      pixels[to] = Math.round(r / samples);
      pixels[to + 1] = Math.round(g / samples);
      pixels[to + 2] = Math.round(b / samples);
      pixels[to + 3] = Math.round(a / samples);
    }
  }
  return { width, height, pixels };
}
