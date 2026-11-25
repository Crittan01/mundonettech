export function createTiffExifPayload(orientation?: number, gpsNote?: string): Buffer;

export function createPng(
  width?: number,
  height?: number,
  includeExif?: boolean,
  orientation?: number,
): Buffer;

export function createPngHeaderOnly(width: number, height: number): Buffer;

export function createWebpVp8xHeader(width: number, height: number): Buffer;

export function bmffBox(type: string, payload: Buffer): Buffer;

export function createBmff(
  width?: number,
  height?: number,
  brand?: string,
  includeDimensions?: boolean,
  options?: {
    compatibleBrands?: string[];
    extraIspes?: Array<{ width: number; height: number }>;
  },
): Buffer;

export function createGlb(options?: {
  version?: number;
  assetVersion?: string;
  declaredLength?: number;
  bufferLength?: number;
  binaryLength?: number;
  viewLength?: number;
  byteOffset?: number;
  omitAsset?: boolean;
  omitBinChunk?: boolean;
  externalUri?: string;
  imageUri?: string;
  extras?: Record<string, unknown>;
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  accessors?: Array<{ bufferView?: number; byteOffset?: number }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>;
  rawDocument?: Record<string, unknown>;
}): Buffer;

export function createUsdz(
  entries: Array<{
    name: string;
    data: Uint8Array;
    method?: number;
    uncompressedSize?: number;
    compressedSize?: number;
    flags?: number;
    externalAttributes?: number;
  }>,
): Buffer;
