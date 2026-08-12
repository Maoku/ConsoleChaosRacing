/**
 * `png.mjs` の型。生成ツールは JavaScript のままにしてあるが、
 * テストから使うぶんだけ型を与える。
 */

export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8。width * height * 4 バイト */
  readonly pixels: Buffer;
}

export declare function encodePng(width: number, height: number, pixels: Buffer): Buffer;
export declare function decodePng(buffer: Buffer): RasterImage;
export declare function downscaleBox(image: RasterImage, factor: number): RasterImage;

export declare class Raster {
  constructor(width: number, height: number);
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer;
  blend(x: number, y: number, color: readonly number[], alpha: number): void;
  dot(x: number, y: number, width: number, color: readonly number[], alpha?: number): void;
  hardDot(x: number, y: number, width: number, color: readonly number[], alpha?: number): void;
  flipVertical(): this;
  toPng(): Buffer;
}
