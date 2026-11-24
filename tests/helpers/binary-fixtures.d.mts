export function createPng(
  width?: number,
  height?: number,
  includeExif?: boolean,
  orientation?: number,
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
