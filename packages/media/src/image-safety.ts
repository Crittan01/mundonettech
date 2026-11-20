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

function inspectBmff(buffer: Buffer, options: Required<ImageSafetyOptions>): ImageSafetyResult {
  if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp")
    throw new Error("Invalid ISO-BMFF input.");
  const majorBrand = buffer.toString("ascii", 8, 12);
  const format = ["avif", "avis"].includes(majorBrand)
    ? "avif"
    : ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(majorBrand)
      ? "heic"
      : null;
  if (!format) throw new Error("Unsupported AVIF/HEIC brand.");
  let foundDimensions = false;
  let bmffWidth = 0;
  let bmffHeight = 0;

  function walk(start: number, end: number): void {
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) throw new Error("Truncated BMFF box.");
      const size32 = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const headerBytes = size32 === 1 ? 16 : 8;
      const boxSize =
        size32 === 0
          ? end - offset
          : size32 === 1
            ? Number(buffer.readBigUInt64BE(offset + 8))
            : size32;
      if (!Number.isSafeInteger(boxSize) || boxSize < headerBytes || offset + boxSize > end)
        throw new Error("Invalid BMFF box size.");
      const dataStart = offset + headerBytes;
      const boxEnd = offset + boxSize;
      if (type === "ispe") {
        if (dataStart + 12 > boxEnd) throw new Error("Truncated ispe box.");
        bmffWidth = buffer.readUInt32BE(dataStart + 4);
        bmffHeight = buffer.readUInt32BE(dataStart + 8);
        assertDimensions(bmffWidth, bmffHeight, options);
        foundDimensions = true;
      } else if (["meta", "iprp"].includes(type)) {
        walk(dataStart + 4, boxEnd);
      } else if (type === "ipco") {
        walk(dataStart, boxEnd);
      }
      offset = boxEnd;
    }
  }

  walk(0, buffer.length);
  if (!foundDimensions) throw new Error("AVIF/HEIC input is missing an ispe dimension box.");
  return { format, bmffWidth, bmffHeight };
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
  )
    return { format: "png" };
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return { format: "webp" };
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp")
    return inspectBmff(buffer, limits);
  throw new Error("Unsupported image format. SVG and unknown binary loaders are forbidden.");
}
