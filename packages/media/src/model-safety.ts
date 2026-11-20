import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

export interface GltfDocument {
  buffers?: Array<{ byteLength: number; uri?: string }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>;
  [key: string]: unknown;
}

export interface ModelSafetyResult {
  kind: "glb" | "usdz";
  byteSize: number;
  entryCount?: number;
  uncompressedBytes?: number;
}

export function validateGlb(input: Uint8Array): ModelSafetyResult {
  const buffer = Buffer.from(input);
  if (
    buffer.length < 20 ||
    buffer.length > 50 * 1024 * 1024 ||
    buffer.toString("ascii", 0, 4) !== "glTF"
  )
    throw new Error("Invalid GLB header or size.");
  if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length)
    throw new Error("GLB version 2 and exact declared length are required.");
  let offset = 12;
  let jsonText = "";
  let binary = Buffer.alloc(0);
  let chunkIndex = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length || chunkIndex > 1) throw new Error("Invalid GLB chunk table.");
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error("Truncated GLB chunk.");
    if (chunkIndex === 0) {
      if (type !== 0x4e4f534a || length % 4 !== 0)
        throw new Error("GLB requires an aligned JSON first chunk.");
      jsonText = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start, end));
    } else {
      if (type !== 0x004e4942) throw new Error("GLB supports only JSON and BIN chunks.");
      binary = buffer.subarray(start, end);
    }
    offset = end;
    chunkIndex += 1;
  }
  if (!jsonText) throw new Error("GLB JSON chunk is missing.");
  const document = JSON.parse(jsonText) as GltfDocument;
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new Error("Invalid glTF document.");
  for (const resource of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    if (resource.uri !== undefined)
      throw new Error("External glTF resources are forbidden; embed all bytes in GLB.");
  }
  for (const bufferDefinition of document.buffers ?? []) {
    if (
      !Number.isSafeInteger(bufferDefinition.byteLength) ||
      bufferDefinition.byteLength < 1 ||
      bufferDefinition.byteLength > binary.length
    ) {
      throw new Error("GLB buffer exceeds the BIN chunk.");
    }
  }
  for (const view of document.bufferViews ?? []) {
    const target = document.buffers?.[view.buffer];
    const start = view.byteOffset ?? 0;
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
  for (const image of document.images ?? []) {
    if (
      image.bufferView === undefined ||
      !document.bufferViews?.[image.bufferView] ||
      !["image/png", "image/jpeg"].includes(image.mimeType ?? "")
    ) {
      throw new Error("GLB images must use an embedded PNG/JPEG buffer view.");
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

export async function validateUsdz(input: Uint8Array): Promise<ModelSafetyResult> {
  const buffer = Buffer.from(input);
  if (
    buffer.length < 22 ||
    buffer.length > 25 * 1024 * 1024 ||
    buffer.readUInt32LE(0) !== 0x04034b50
  )
    throw new Error("Invalid USDZ ZIP header or size.");
  const zip = await openZip(buffer);
  let total = 0;
  let count = 0;
  let modelCount = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      count += 1;
      const name = entry.fileName;
      if (
        count > 1000 ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").includes("..") ||
        /[\u0000-\u001f\u007f]/.test(name)
      ) {
        throw new Error("USDZ contains unsafe paths or too many entries.");
      }
      if (
        (entry.generalPurposeBitFlag & 1) !== 0 ||
        entry.compressedSize < 0 ||
        entry.uncompressedSize < 0 ||
        entry.uncompressedSize > 100 * 1024 * 1024
      ) {
        throw new Error("Encrypted or oversized USDZ entries are forbidden.");
      }
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)
        throw new Error("USDZ compression ratio exceeds the safe limit.");
      if (!entry.fileName.endsWith("/")) {
        const extension = name.split(".").at(-1)?.toLowerCase();
        if (["usdc", "usda"].includes(extension ?? "")) modelCount += 1;
        else if (!["png", "jpg", "jpeg"].includes(extension ?? ""))
          throw new Error("USDZ allows only USD and PNG/JPEG payload files.");
        total += entry.uncompressedSize;
        if (total > 100 * 1024 * 1024) throw new Error("USDZ uncompressed byte budget exceeded.");
        let actual = 0;
        const stream = await entryStream(zip, entry);
        await pipeline(
          stream,
          new Writable({
            write(chunk, _encoding, callback) {
              actual += chunk.length;
              if (
                actual > entry.uncompressedSize ||
                total - entry.uncompressedSize + actual > 100 * 1024 * 1024
              )
                callback(new Error("USDZ entry exceeded its declared size."));
              else callback();
            },
          }),
        );
        if (actual !== entry.uncompressedSize) throw new Error("USDZ entry size mismatch.");
      }
    }
  } finally {
    zip.close();
  }
  if (modelCount !== 1) throw new Error("USDZ requires exactly one USD model payload.");
  return { kind: "usdz", byteSize: buffer.length, entryCount: count, uncompressedBytes: total };
}
