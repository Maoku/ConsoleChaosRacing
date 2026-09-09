/**
 * 依存無しの最小 baseline JPEG デコーダ（車モデル入れ替え計画 §4.1 / D-5）。
 *
 * `png.mjs` と同じ方針 — **本作が実際に扱う範囲だけを読む。汎用にはしない。**
 * 範囲外は黙って壊れた絵を返さず、必ず例外を投げる。
 *
 * 対応: baseline sequential（SOF0 / SOF1）・8 bit 精度・1 成分（グレー）または
 *       3 成分（YCbCr）・任意のサンプリング比（4:4:4 / 4:2:2 / 4:2:0）・restart marker
 * 非対応: progressive（SOF2）・算術符号・12 bit・4 成分（CMYK / YCCK）・階層符号化
 *
 * 出力は `png.mjs` の `{ width, height, pixels }`（RGBA8）と同じ形なので、
 * `downscaleBox` / `encodePng` へそのまま渡せる。
 *
 * 生成物はリポジトリにコミットするので、丸めはすべて明示的に行う（決定論）。
 *
 * **macOS の `sips` との突き合わせ（開発時の一時確認・2026-09-09）**
 * — 車の base color 2 枚（512² / 1024², 4:2:0）で測った画素差:
 *
 * | | 全体の平均差 | 輝度 Y | 平坦部の Cb | 彩度の段差（勾配 > 30）の Cb |
 * | --- | --- | --- | --- | --- |
 * | gen3 512² | 0.27 | 0.12 | — | — |
 * | gen4 1024² | 1.33 | 0.17 | 0.13 | 7.0 |
 *
 * 輝度と平坦部はほぼ一致する（＝ ハフマン復号・逆量子化・IDCT は正しい）。
 * 残差は**クロマの段差にだけ**乗っており、4:2:0 の補間カーネルの違いである。
 * こちらは画素中心を合わせた双線形（倍率 2 では libjpeg の "fancy upsampling" と
 * 同じ 9:3:3:1）を使う。CoreGraphics のカーネルは公開されていないので、
 * これ以上は寄せない — 寄せる先が仕様として存在しない。
 */

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** IDCT の余弦表。`COS[u * 8 + x] = C(u)/2 · cos((2x+1)uπ/16)` */
const COS = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const scale = (u === 0 ? Math.SQRT1_2 : 1) / 2;
    for (let x = 0; x < 8; x++) {
      table[u * 8 + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

/**
 * ハフマン表。canonical code から値を引く（B.2.4.2 / F.2.2.3 の mincode/maxcode 方式）。
 * 木を作らずに済み、表の構築が符号長の順で決まるので決定論的になる。
 */
function buildHuffmanTable(counts, values) {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPointer = new Int32Array(17);

  let code = 0;
  let offset = 0;
  for (let length = 1; length <= 16; length++) {
    valPointer[length] = offset;
    minCode[length] = code;
    code += counts[length - 1];
    offset += counts[length - 1];
    maxCode[length] = counts[length - 1] === 0 ? -1 : code - 1;
    code <<= 1;
  }
  return { minCode, maxCode, valPointer, values };
}

/** エントロピー符号化データのビット読み出し。0xFF00 のバイトスタッフィングを外す */
class BitReader {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.offset = offset;
    this.buffer = 0;
    this.count = 0;
  }

  /** 1 ビット。データが尽きたら 0 を返す（末尾の詰め物と同じ扱い） */
  readBit() {
    if (this.count === 0) {
      if (this.offset >= this.bytes.length) return 0;
      let byte = this.bytes[this.offset++];
      if (byte === 0xff) {
        const next = this.bytes[this.offset];
        if (next === 0x00) {
          this.offset += 1; // スタッフィング
        } else if (next >= 0xd0 && next <= 0xd7) {
          throw new Error('restart marker をビット列の途中で踏んだ');
        } else {
          // マーカーに当たった。以降は 0 で埋める（最後のブロックの詰め物）
          this.offset -= 1;
          byte = 0;
        }
      }
      this.buffer = byte;
      this.count = 8;
    }
    this.count -= 1;
    return (this.buffer >> this.count) & 1;
  }

  receive(length) {
    let value = 0;
    for (let index = 0; index < length; index++) value = (value << 1) | this.readBit();
    return value;
  }

  decodeHuffman(table) {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | this.readBit();
      if (table.maxCode[length] >= 0 && code <= table.maxCode[length]) {
        return table.values[table.valPointer[length] + code - table.minCode[length]];
      }
    }
    throw new Error('ハフマン符号が表に無い（壊れた JPEG か非対応の符号化）');
  }

  /** restart marker（RSTn）まで読み飛ばし、ビット位置を揃える */
  alignToRestart() {
    this.count = 0;
    while (this.offset < this.bytes.length - 1) {
      if (this.bytes[this.offset] === 0xff) {
        const marker = this.bytes[this.offset + 1];
        if (marker >= 0xd0 && marker <= 0xd7) {
          this.offset += 2;
          return;
        }
      }
      this.offset += 1;
    }
    throw new Error('restart marker が見つからない');
  }
}

/** F.2.2.1 の EXTEND。符号付きの差分へ戻す */
function extend(value, length) {
  return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

/**
 * 逆 DCT（分離型・Float64）。`block` は逆量子化済みの自然順 64 係数。
 * レベルシフト（+128）とクランプまで済ませて 0〜255 の整数で返す。
 */
function inverseDct(block, output) {
  const rows = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    const base = y * 8;
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        const coefficient = block[base + u];
        if (coefficient !== 0) sum += coefficient * COS[u * 8 + x];
      }
      rows[base + x] = sum;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        const value = rows[v * 8 + x];
        if (value !== 0) sum += value * COS[v * 8 + y];
      }
      const level = Math.round(sum) + 128;
      output[y * 8 + x] = level < 0 ? 0 : level > 255 ? 255 : level;
    }
  }
}

function parseFrame(bytes, offset, progressive) {
  if (progressive) throw new Error('progressive JPEG（SOF2）は非対応');
  const precision = bytes[offset + 2];
  if (precision !== 8) throw new Error(`${precision} bit 精度は非対応（8 bit のみ）`);
  const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
  const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
  const componentCount = bytes[offset + 7];
  if (componentCount !== 1 && componentCount !== 3) {
    throw new Error(`${componentCount} 成分は非対応（1 または 3 のみ）`);
  }

  const components = [];
  for (let index = 0; index < componentCount; index++) {
    const base = offset + 8 + index * 3;
    components.push({
      id: bytes[base],
      h: bytes[base + 1] >> 4,
      v: bytes[base + 1] & 0x0f,
      quantTable: bytes[base + 2],
    });
  }
  for (const component of components) {
    if (component.h < 1 || component.h > 4 || component.v < 1 || component.v > 4) {
      throw new Error('サンプリング比が範囲外');
    }
  }
  return { width, height, components };
}

/**
 * baseline JPEG を復号する。
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ width: number, height: number, pixels: Buffer }} RGBA8
 */
export function decodeJpeg(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG（SOI）ではない');

  const quantTables = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let restartInterval = 0;
  let scan = null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`マーカー境界を見失った（${offset}）`);
    let marker = bytes[offset + 1];
    while (marker === 0xff) {
      offset += 1; // 詰め物の 0xFF
      marker = bytes[offset + 1];
    }
    if (marker === 0xd9) break; // EOI
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segment = offset + 2;

    switch (marker) {
      case 0xdb: {
        // DQT
        let cursor = segment + 2;
        while (cursor < segment + length) {
          const precision = bytes[cursor] >> 4;
          const id = bytes[cursor] & 0x0f;
          cursor += 1;
          const table = new Int32Array(64);
          for (let index = 0; index < 64; index++) {
            if (precision === 0) {
              table[index] = bytes[cursor + index];
            } else if (precision === 1) {
              table[index] = (bytes[cursor + index * 2] << 8) | bytes[cursor + index * 2 + 1];
            } else {
              throw new Error('量子化表の精度が範囲外');
            }
          }
          cursor += precision === 0 ? 64 : 128;
          quantTables[id] = table;
        }
        break;
      }
      case 0xc4: {
        // DHT
        let cursor = segment + 2;
        while (cursor < segment + length) {
          const klass = bytes[cursor] >> 4;
          const id = bytes[cursor] & 0x0f;
          cursor += 1;
          const counts = bytes.subarray(cursor, cursor + 16);
          cursor += 16;
          let total = 0;
          for (const count of counts) total += count;
          const values = bytes.subarray(cursor, cursor + total);
          cursor += total;
          const table = buildHuffmanTable(counts, values);
          if (klass === 0) dcTables[id] = table;
          else acTables[id] = table;
        }
        break;
      }
      case 0xc0:
      case 0xc1:
        frame = parseFrame(bytes, segment, false);
        break;
      case 0xc2:
        throw new Error('progressive JPEG（SOF2）は非対応');
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        throw new Error(`非対応の SOF マーカー 0x${marker.toString(16)}`);
      case 0xdd:
        restartInterval = (bytes[segment + 2] << 8) | bytes[segment + 3];
        break;
      case 0xda: {
        // SOS
        if (!frame) throw new Error('SOF より先に SOS が来た');
        const count = bytes[segment + 2];
        if (count !== frame.components.length) {
          throw new Error('単一スキャンで全成分を送っていない（progressive の疑い）');
        }
        const selectors = [];
        for (let index = 0; index < count; index++) {
          const base = segment + 3 + index * 2;
          const component = frame.components.find((item) => item.id === bytes[base]);
          if (!component) throw new Error('スキャンが未知の成分を指している');
          selectors.push({ component, dc: bytes[base + 1] >> 4, ac: bytes[base + 1] & 0x0f });
        }
        const spectral = segment + 3 + count * 2;
        if (bytes[spectral] !== 0 || bytes[spectral + 1] !== 63) {
          throw new Error('スペクトル選択が 0〜63 でない（progressive は非対応）');
        }
        scan = { selectors, dataOffset: segment + length };
        offset = bytes.length; // SOS 以降はエントロピーデータ。マーカー走査を終える
        continue;
      }
      default:
        break; // APPn / COM / その他は読み飛ばす
    }
    offset = segment + length;
  }

  if (!frame) throw new Error('SOF が無い');
  if (!scan) throw new Error('SOS が無い');

  return decodeScan(bytes, frame, scan, { quantTables, dcTables, acTables, restartInterval });
}

function decodeScan(bytes, frame, scan, tables) {
  const { quantTables, dcTables, acTables, restartInterval } = tables;
  const { width, height, components } = frame;

  let hMax = 1;
  let vMax = 1;
  for (const component of components) {
    if (component.h > hMax) hMax = component.h;
    if (component.v > vMax) vMax = component.v;
  }
  const mcusPerLine = Math.ceil(width / (8 * hMax));
  const mcusPerColumn = Math.ceil(height / (8 * vMax));

  for (const component of components) {
    component.blocksPerLine = mcusPerLine * component.h;
    component.blocksPerColumn = mcusPerColumn * component.v;
    component.lineWidth = component.blocksPerLine * 8;
    component.plane = new Uint8Array(component.lineWidth * component.blocksPerColumn * 8);
    component.prediction = 0;
    const quant = quantTables[component.quantTable];
    if (!quant) throw new Error(`量子化表 ${component.quantTable} が無い`);
    component.quant = quant;
  }

  const reader = new BitReader(bytes, scan.dataOffset);
  const block = new Float64Array(64);
  const pixels = new Uint8Array(64);

  const decodeBlock = (component, selector, blockRow, blockColumn) => {
    block.fill(0);
    const dcTable = dcTables[selector.dc];
    const acTable = acTables[selector.ac];
    if (!dcTable || !acTable) throw new Error('スキャンが指すハフマン表が無い');

    const dcLength = reader.decodeHuffman(dcTable);
    const diff = dcLength === 0 ? 0 : extend(reader.receive(dcLength), dcLength);
    component.prediction += diff;
    block[0] = component.prediction * component.quant[0];

    let index = 1;
    while (index < 64) {
      const rs = reader.decodeHuffman(acTable);
      const size = rs & 0x0f;
      const run = rs >> 4;
      if (size === 0) {
        if (run !== 15) break; // EOB
        index += 16;
        continue;
      }
      index += run;
      if (index > 63) throw new Error('AC 係数の位置が 63 を超えた');
      block[ZIGZAG[index]] = extend(reader.receive(size), size) * component.quant[index];
      index += 1;
    }

    inverseDct(block, pixels);
    const originX = blockColumn * 8;
    const originY = blockRow * 8;
    for (let y = 0; y < 8; y++) {
      const target = (originY + y) * component.lineWidth + originX;
      component.plane.set(pixels.subarray(y * 8, y * 8 + 8), target);
    }
  };

  const totalMcus = mcusPerLine * mcusPerColumn;
  let sinceRestart = 0;
  for (let mcu = 0; mcu < totalMcus; mcu++) {
    if (restartInterval > 0 && sinceRestart === restartInterval) {
      reader.alignToRestart();
      for (const component of components) component.prediction = 0;
      sinceRestart = 0;
    }
    const mcuRow = (mcu / mcusPerLine) | 0;
    const mcuColumn = mcu % mcusPerLine;
    for (let index = 0; index < scan.selectors.length; index++) {
      const selector = scan.selectors[index];
      const component = selector.component;
      for (let v = 0; v < component.v; v++) {
        for (let h = 0; h < component.h; h++) {
          decodeBlock(component, selector, mcuRow * component.v + v, mcuColumn * component.h + h);
        }
      }
    }
    sinceRestart += 1;
  }

  return toRgba(width, height, components, hMax, vMax);
}

/**
 * 間引かれた成分を出力の解像度へ広げる（画素中心を合わせた双線形）。
 *
 * 最近傍で置くとクロマの境目が 2 画素の階段になり、libjpeg 系のデコーダとの差が
 * 平均 1.5 まで開いた。倍率 2 のとき双線形は libjpeg の "fancy upsampling"
 * （3:1 の重み）と同じ式になる。等倍の成分は補間せずそのまま写す。
 */
function upsample(component, width, height, hMax, vMax) {
  const plane = new Uint8Array(width * height);
  const scaleX = component.h / hMax;
  const scaleY = component.v / vMax;
  const sourceWidth = Math.max(1, Math.ceil(width * scaleX));
  const sourceHeight = Math.max(1, Math.ceil(height * scaleY));

  for (let y = 0; y < height; y++) {
    const fy = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sourceHeight - 1, y0 + 1));
    const wy = fy - Math.floor(fy);
    const row0 = y0 * component.lineWidth;
    const row1 = y1 * component.lineWidth;

    for (let x = 0; x < width; x++) {
      const fx = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sourceWidth - 1, x0 + 1));
      const wx = fx - Math.floor(fx);

      const top = component.plane[row0 + x0] * (1 - wx) + component.plane[row0 + x1] * wx;
      const bottom = component.plane[row1 + x0] * (1 - wx) + component.plane[row1 + x1] * wx;
      plane[y * width + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
  return plane;
}

/** 等倍の成分を出力の解像度で切り出す（padding のぶんを落とすだけ） */
function crop(component, width, height) {
  const plane = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    plane.set(
      component.plane.subarray(y * component.lineWidth, y * component.lineWidth + width),
      y * width,
    );
  }
  return plane;
}

/** 成分の平面を RGBA8 へ（YCbCr → RGB は JFIF の式。丸めは明示的に行う） */
function toRgba(width, height, components, hMax, vMax) {
  const pixels = Buffer.alloc(width * height * 4, 0xff);
  const planes = components.map((component) =>
    component.h === hMax && component.v === vMax
      ? crop(component, width, height)
      : upsample(component, width, height, hMax, vMax),
  );

  if (components.length === 1) {
    for (let index = 0; index < width * height; index++) {
      const level = planes[0][index];
      pixels[index * 4] = level;
      pixels[index * 4 + 1] = level;
      pixels[index * 4 + 2] = level;
    }
    return { width, height, pixels };
  }

  for (let index = 0; index < width * height; index++) {
    const luma = planes[0][index];
    const cb = planes[1][index] - 128;
    const cr = planes[2][index] - 128;
    const target = index * 4;
    pixels[target] = clamp8(luma + 1.402 * cr);
    pixels[target + 1] = clamp8(luma - 0.344136 * cb - 0.714136 * cr);
    pixels[target + 2] = clamp8(luma + 1.772 * cb);
  }
  return { width, height, pixels };
}

function clamp8(value) {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}
