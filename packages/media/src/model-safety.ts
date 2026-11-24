import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

import { inspectImageMagic } from "./image-safety.js";

interface GltfDocument {
  asset?: { version?: unknown; minVersion?: unknown };
  extensionsRequired?: unknown;
  buffers?: Array<{ byteLength: number; uri?: string }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>;
  [key: string]: unknown;
}

export interface ModelSafetyResult {
  kind: "glb" | "usdz";
  byteSize: number;
  entryCount?: number;
  uncompressedBytes?: number;
}

const forbiddenGlbExtensions = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression"]);

function assertNoExternalUri(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("glTF JSON nesting depth exceeds the safe limit.");
  if (Array.isArray(value)) {
    for (const item of value) assertNoExternalUri(item, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && child !== undefined) {
        throw new Error("External glTF resources are forbidden; embed all bytes in GLB.");
      }
      assertNoExternalUri(child, depth + 1);
    }
  }
}

export function validateGlb(input: Uint8Array): ModelSafetyResult {
  const buffer = Buffer.from(input);
  if (
    buffer.length < 20 ||
    buffer.length > 50 * 1024 * 1024 ||
    buffer.toString("ascii", 0, 4) !== "glTF"
  ) {
    throw new Error("Invalid GLB header or size.");
  }
  if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
    throw new Error("GLB version 2 and exact declared length are required.");
  }

  let offset = 12;
  let jsonText = "";
  let binary = Buffer.alloc(0);
  let hasBinChunk = false;
  let chunkIndex = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length || chunkIndex > 1) throw new Error("Invalid GLB chunk table.");
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (length === 0 || length % 4 !== 0 || end > buffer.length) {
      throw new Error("Truncated or unaligned GLB chunk.");
    }
    if (chunkIndex === 0) {
      if (type !== 0x4e4f534a) throw new Error("GLB requires a JSON first chunk.");
      jsonText = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start, end));
    } else {
      if (type !== 0x004e4942) throw new Error("GLB supports only JSON and BIN chunks.");
      binary = buffer.subarray(start, end);
      hasBinChunk = true;
    }
    offset = end;
    chunkIndex += 1;
  }

  if (!jsonText) throw new Error("GLB JSON chunk is missing.");
  const document = JSON.parse(jsonText) as GltfDocument;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("Invalid glTF document.");
  }
  if (
    typeof document.asset !== "object" ||
    document.asset === null ||
    Array.isArray(document.asset) ||
    typeof document.asset.version !== "string" ||
    !/^2\.[0-9]+$/.test(document.asset.version) ||
    (document.asset.minVersion !== undefined &&
      (typeof document.asset.minVersion !== "string" || !/^2\.0$/.test(document.asset.minVersion)))
  ) {
    throw new Error("GLB requires a valid glTF 2.x asset descriptor.");
  }

  if (document.extensionsRequired !== undefined) {
    if (!Array.isArray(document.extensionsRequired)) {
      throw new Error("Invalid glTF extensionsRequired field.");
    }
    for (const ext of document.extensionsRequired) {
      if (typeof ext !== "string" || forbiddenGlbExtensions.has(ext)) {
        throw new Error(
          `Unsupported required glTF extension "${String(ext)}"; self-contained GLB without external WASM decoders is required.`,
        );
      }
    }
  }

  assertNoExternalUri(document);

  for (const [field, collection] of [
    ["buffers", document.buffers],
    ["bufferViews", document.bufferViews],
    ["accessors", document.accessors],
    ["images", document.images],
  ] as const) {
    if (collection !== undefined && !Array.isArray(collection)) {
      throw new Error(`Invalid glTF ${field} array.`);
    }
  }

  const buffers = document.buffers ?? [];
  if (buffers.length > 1 || (buffers.length === 1 && !hasBinChunk)) {
    throw new Error("GLB buffers must map to a single embedded BIN chunk.");
  }
  for (const bufferDefinition of buffers) {
    if (
      typeof bufferDefinition !== "object" ||
      bufferDefinition === null ||
      !Number.isSafeInteger(bufferDefinition.byteLength) ||
      bufferDefinition.byteLength < 1 ||
      bufferDefinition.byteLength > binary.length
    ) {
      throw new Error("GLB buffer exceeds the BIN chunk.");
    }
  }

  const views = document.bufferViews ?? [];
  for (const view of views) {
    const target = buffers[view?.buffer ?? -1];
    const start = view?.byteOffset ?? 0;
    if (
      !target ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(view.byteLength) ||
      start < 0 ||
      view.byteLength < 1 ||
      start + view.byteLength > target.byteLength
    ) {
      throw new Error("GLB buffer view is out of bounds.");
    }
  }

  for (const accessor of document.accessors ?? []) {
    if (
      typeof accessor !== "object" ||
      accessor === null ||
      (accessor.bufferView !== undefined &&
        (!Number.isSafeInteger(accessor.bufferView) || !views[accessor.bufferView]))
    ) {
      throw new Error("GLB accessor references an invalid bufferView.");
    }
  }

  for (const image of document.images ?? []) {
    if (
      typeof image !== "object" ||
      image === null ||
      image.bufferView === undefined ||
      !views[image.bufferView] ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType ?? "")
    ) {
      throw new Error("GLB images must use an embedded PNG/JPEG/WebP buffer view.");
    }
  }
  return { kind: "glb", byteSize: buffer.length };
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("Invalid USDZ archive."));
        else resolve(zip);
      },
    );
  });
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("error", onError);
      zip.removeListener("end", onEnd);
    };
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    zip.once("entry", onEntry);
    zip.once("error", onError);
    zip.once("end", onEnd);
    zip.readEntry();
  });
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("Unable to read USDZ entry."));
      else resolve(stream);
    });
  });
}

function parseSafeUsdzPath(name: string): { isDirectory: boolean; extension: string | null } {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("USDZ contains unsafe paths.");
  }
  const isDirectory = name.endsWith("/");
  const trimmed = isDirectory ? name.slice(0, -1) : name;
  const parts = trimmed.split("/");
  if (
    !trimmed ||
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error("USDZ contains traversal, empty, or hidden path segments.");
  }
  if (isDirectory) return { isDirectory: true, extension: null };
  const baseName = parts.at(-1)!;
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
    throw new Error("USDZ payload files require an explicit extension.");
  }
  return { isDirectory: false, extension: baseName.slice(dotIndex + 1).toLowerCase() };
}

const allowedTextureExtensions: Record<string, "png" | "jpeg" | "webp" | "avif"> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  avif: "avif",
};

export async function validateUsdz(input: Uint8Array): Promise<ModelSafetyResult> {
  const buffer = Buffer.from(input);
  if (
    buffer.length < 22 ||
    buffer.length > 25 * 1024 * 1024 ||
    buffer.readUInt32LE(0) !== 0x04034b50
  ) {
    throw new Error("Invalid USDZ ZIP header or size.");
  }
  const zip = await openZip(buffer);
  let total = 0;
  let count = 0;
  let fileCount = 0;
  let modelCount = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      count += 1;
      if (count > 1000) throw new Error("USDZ contains too many entries.");

      const { isDirectory, extension } = parseSafeUsdzPath(entry.fileName);
      const unixModeType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (unixModeType === 0o120000) {
        throw new Error("Symbolic links inside USDZ archives are forbidden.");
      }
      if (
        (entry.generalPurposeBitFlag & 1) !== 0 ||
        ![0, 8].includes(entry.compressionMethod) ||
        entry.compressedSize < 0 ||
        entry.uncompressedSize < 0 ||
        (entry.compressedSize === 0 && entry.uncompressedSize > 0) ||
        entry.uncompressedSize > 100 * 1024 * 1024
      ) {
        throw new Error("Encrypted, unsupported, or oversized USDZ entries are forbidden.");
      }
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) {
        throw new Error("USDZ compression ratio exceeds the safe limit.");
      }

      if (!isDirectory) {
        fileCount += 1;
        const isUsdModel = extension === "usdc" || extension === "usda";
        const expectedTextureFormat = extension ? allowedTextureExtensions[extension] : undefined;
        if (fileCount === 1 && !isUsdModel) {
          throw new Error("USDZ root entry must be a .usdc or .usda stage.");
        }
        if (isUsdModel) {
          modelCount += 1;
          if (entry.uncompressedSize < 4) {
            throw new Error("USDZ model payload is empty or truncated.");
          }
        } else if (!expectedTextureFormat) {
          throw new Error("USDZ allows only USD and PNG/JPEG/WebP/AVIF payload files.");
        }

        total += entry.uncompressedSize;
        if (total > 100 * 1024 * 1024) throw new Error("USDZ uncompressed byte budget exceeded.");

        let actual = 0;
        const headerSample: Buffer[] = [];
        let sampledBytes = 0;
        const stream = await entryStream(zip, entry);
        await pipeline(
          stream,
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              actual += chunk.length;
              if (sampledBytes < 512) {
                const slice = chunk.subarray(0, 512 - sampledBytes);
                headerSample.push(Buffer.from(slice));
                sampledBytes += slice.length;
              }
              if (
                actual > entry.uncompressedSize ||
                total - entry.uncompressedSize + actual > 100 * 1024 * 1024
              ) {
                callback(new Error("USDZ entry exceeded its declared size."));
              } else {
                callback();
              }
            },
          }),
        );
        if (actual !== entry.uncompressedSize) throw new Error("USDZ entry size mismatch.");

        if (expectedTextureFormat) {
          const magic = inspectImageMagic(Buffer.concat(headerSample));
          if (magic.format !== expectedTextureFormat) {
            throw new Error("USDZ embedded texture magic bytes do not match file extension.");
          }
        }
      }
    }
  } finally {
    zip.close();
  }
  if (modelCount !== 1) throw new Error("USDZ requires exactly one USD model payload.");
  return { kind: "usdz", byteSize: buffer.length, entryCount: count, uncompressedBytes: total };
}
