export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "heic";

export interface ImageSafetyOptions {
  maxBytes?: number;
  maxPixels?: number;
  maxDimension?: number;
}

export interface ImageSafetyResult {
  format: ImageFormat;
  bmffWidth?: number;
  bmffHeight?: number;
}

const maxInputBytes = 20 * 1024 * 1024;
const maxInputPixels = 40_000_000;
const maxInputDimension = 12_000;
const maxBmffDepth = 8;
const maxBmffBoxes = 4_096;

const avifBrands = new Set(["avif", "avis"]);
const heicBrands = new Set(["heic", "heix", "hevc", "hevx"]);
const containerBrands = new Set(["mif1", "msf1", "miaf"]);

function assertDimensions(
  width: number,
  height: number,
  options: Required<ImageSafetyOptions>,
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > options.maxDimension ||
    height > options.maxDimension ||
    width * height > options.maxPixels
  ) {
    throw new Error("Image dimensions exceed the allowed pixel budget.");
  }
}

function readBoxHeader(
  buffer: Buffer,
  offset: number,
  end: number,
): { type: string; dataStart: number; boxEnd: number } {
  if (offset + 8 > end) throw new Error("Truncated BMFF box.");
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  const headerBytes = size32 === 1 ? 16 : 8;
  if (offset + headerBytes > end) throw new Error("Truncated BMFF extended box header.");
  const boxSize =
    size32 === 0
      ? end - offset
      : size32 === 1
        ? Number(buffer.readBigUInt64BE(offset + 8))
        : size32;
  if (!Number.isSafeInteger(boxSize) || boxSize < headerBytes || offset + boxSize > end) {
    throw new Error("Invalid BMFF box size.");
  }
  return { type, dataStart: offset + headerBytes, boxEnd: offset + boxSize };
}

function classifyBmffBrand(buffer: Buffer): ImageFormat {
  const ftyp = readBoxHeader(buffer, 0, buffer.length);
  if (
    ftyp.type !== "ftyp" ||
    ftyp.boxEnd - ftyp.dataStart < 8 ||
    (ftyp.boxEnd - ftyp.dataStart) % 4 !== 0
  ) {
    throw new Error("Invalid ISO-BMFF ftyp box.");
  }
  const majorBrand = buffer.toString("ascii", ftyp.dataStart, ftyp.dataStart + 4);
  const compatibleBrands: string[] = [];
  for (let pos = ftyp.dataStart + 8; pos + 4 <= ftyp.boxEnd; pos += 4) {
    compatibleBrands.push(buffer.toString("ascii", pos, pos + 4));
  }
  if (avifBrands.has(majorBrand)) return "avif";
  if (heicBrands.has(majorBrand)) return "heic";
  if (containerBrands.has(majorBrand)) {
    if (compatibleBrands.some((brand) => avifBrands.has(brand))) return "avif";
    if (
      majorBrand === "mif1" ||
      majorBrand === "msf1" ||
      compatibleBrands.some((brand) => heicBrands.has(brand) || containerBrands.has(brand))
    ) {
      return "heic";
    }
  }
  throw new Error("Unsupported AVIF/HEIC brand.");
}

function inspectBmff(buffer: Buffer, options: Required<ImageSafetyOptions>): ImageSafetyResult {
  if (buffer.length < 16) throw new Error("Invalid ISO-BMFF input.");
  const format = classifyBmffBrand(buffer);
  let foundDimensions = false;
  let bmffWidth = 0;
  let bmffHeight = 0;
  let boxCount = 0;

  function walk(start: number, end: number, depth: number): void {
    if (depth > maxBmffDepth) throw new Error("BMFF nesting depth exceeds the safe limit.");
    let offset = start;
    while (offset < end) {
      boxCount += 1;
      if (boxCount > maxBmffBoxes) throw new Error("BMFF box count exceeds the safe limit.");
      const { type, dataStart, boxEnd } = readBoxHeader(buffer, offset, end);
      if (type === "ispe") {
        if (dataStart + 12 > boxEnd) throw new Error("Truncated ispe box.");
        const width = buffer.readUInt32BE(dataStart + 4);
        const height = buffer.readUInt32BE(dataStart + 8);
        assertDimensions(width, height, options);
        if (!foundDimensions || width * height >= bmffWidth * bmffHeight) {
          bmffWidth = width;
          bmffHeight = height;
        }
        foundDimensions = true;
      } else if (type === "meta") {
        // ISO/IEC 14496-12 FullBox('meta') carries 4 bytes (version + flags) before child boxes.
        if (dataStart + 4 > boxEnd) throw new Error("Truncated BMFF meta FullBox.");
        walk(dataStart + 4, boxEnd, depth + 1);
      } else if (type === "iprp" || type === "ipco") {
        // ISO/IEC 23008-12 Box('iprp') and Box('ipco') are plain Boxes without FullBox flags.
        walk(dataStart, boxEnd, depth + 1);
      }
      offset = boxEnd;
    }
  }

  walk(0, buffer.length, 0);
  if (!foundDimensions) throw new Error("AVIF/HEIC input is missing an ispe dimension box.");
  return { format, bmffWidth, bmffHeight };
}

function inspectPngHeader(buffer: Buffer, limits: Required<ImageSafetyOptions>): ImageSafetyResult {
  if (
    buffer.length < 24 ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Invalid or truncated PNG IHDR header.");
  }
  assertDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20), limits);
  return { format: "png" };
}

function inspectWebpHeader(
  buffer: Buffer,
  limits: Required<ImageSafetyOptions>,
): ImageSafetyResult {
  if (buffer.length >= 30 && buffer.toString("ascii", 12, 16) === "VP8X") {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    assertDimensions(width, height, limits);
  }
  return { format: "webp" };
}

export function inspectImageMagic(
  input: Uint8Array,
  options: ImageSafetyOptions = {},
): ImageSafetyResult {
  const buffer = Buffer.from(input);
  const limits = {
    maxBytes: options.maxBytes ?? maxInputBytes,
    maxPixels: options.maxPixels ?? maxInputPixels,
    maxDimension: options.maxDimension ?? maxInputDimension,
  };
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
    throw new RangeError("Image safety limits must be positive safe integers.");
  }
  if (buffer.length < 1 || buffer.length > limits.maxBytes)
    throw new Error("Image byte size exceeds the allowed limit.");
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { format: "jpeg" };
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return inspectPngHeader(buffer, limits);
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return inspectWebpHeader(buffer, limits);
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp")
    return inspectBmff(buffer, limits);
  throw new Error("Unsupported image format. SVG and unknown binary loaders are forbidden.");
}
