import sharp from "sharp";

import { inspectImageMagic, type ImageFormat, type ImageSafetyOptions } from "./image-safety.js";

// Allowlist only hardened in-memory still-image decoders at the native libvips C layer.
// Blocks SVG, PDF, TIFF, GIF, Magick, JP2K, Raw, OpenSlide, FITS, and all filesystem *File loaders.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpBuffer",
    "VipsForeignLoadHeifBuffer",
  ],
});

export interface ImageDerivative {
  format: "avif" | "webp";
  mimeType: "image/avif" | "image/webp";
  width: number;
  height: number;
  bytes: Uint8Array<ArrayBuffer>;
  byteSize: number;
}

export interface ProcessedImage {
  sourceWidth: number;
  sourceHeight: number;
  derivatives: ImageDerivative[];
}

const defaultWidths = [480, 768, 1280, 1920] as const;

function expectedSharpFormat(format: ImageFormat): string {
  return format === "avif" || format === "heic" ? "heif" : format;
}

export async function processImageSafely(
  input: Uint8Array,
  options: ImageSafetyOptions & { widths?: readonly number[] } = {},
): Promise<ProcessedImage> {
  const requested = options.widths ?? defaultWidths;
  if (requested.some((width) => !Number.isSafeInteger(width) || width < 32 || width > 8192)) {
    throw new RangeError("Invalid derivative width.");
  }

  const magic = inspectImageMagic(input, options);
  if (["avif", "heic"].includes(magic.format) && magic.bmffWidth === undefined) {
    throw new Error("Missing pre-decode BMFF inspection.");
  }

  const pixelBudget = options.maxPixels ?? 40_000_000;
  const dimensionBudget = options.maxDimension ?? 12_000;
  const source = Buffer.from(input);
  const metadata = await sharp(source, {
    limitInputPixels: pixelBudget,
    sequentialRead: true,
    failOn: "error",
    pages: 1,
    page: 0,
  }).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Decoded image dimensions are unavailable.");
  }
  if (metadata.format !== expectedSharpFormat(magic.format)) {
    throw new Error("Decoded image format does not match inspected magic bytes.");
  }
  if (
    metadata.width > dimensionBudget ||
    metadata.height > dimensionBudget ||
    metadata.width * metadata.height > pixelBudget
  ) {
    throw new Error("Decoded image exceeds the allowed pixel budget.");
  }

  // EXIF orientations 5..8 transpose width and height when .rotate() auto-orients pixels.
  const swapsAxes = (metadata.orientation ?? 1) >= 5 && (metadata.orientation ?? 1) <= 8;
  const orientedWidth = swapsAxes ? metadata.height : metadata.width;
  const orientedHeight = swapsAxes ? metadata.width : metadata.height;

  const widths = [
    ...new Set([...requested.filter((width) => width < orientedWidth), orientedWidth]),
  ].sort((a, b) => a - b);
  const derivatives: ImageDerivative[] = [];

  for (const width of widths) {
    for (const format of ["avif", "webp"] as const) {
      const pipeline = sharp(source, {
        limitInputPixels: pixelBudget,
        sequentialRead: true,
        failOn: "error",
        pages: 1,
        page: 0,
      })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .toColorspace("srgb");
      const bytes =
        format === "avif"
          ? await pipeline.avif({ quality: 60, effort: 6, chromaSubsampling: "4:2:0" }).toBuffer()
          : await pipeline.webp({ quality: 82, smartSubsample: true }).toBuffer();
      const outputMetadata = await sharp(bytes, {
        limitInputPixels: pixelBudget,
        failOn: "error",
        pages: 1,
        page: 0,
      }).metadata();
      if (
        outputMetadata.width !== width ||
        !outputMetadata.height ||
        outputMetadata.exif ||
        outputMetadata.iptc ||
        outputMetadata.xmp ||
        outputMetadata.tifftagPhotoshop
      ) {
        throw new Error("Output metadata validation failed.");
      }
      derivatives.push({
        format,
        mimeType: format === "avif" ? "image/avif" : "image/webp",
        width: outputMetadata.width,
        height: outputMetadata.height,
        bytes,
        byteSize: bytes.length,
      });
    }
  }
  return { sourceWidth: orientedWidth, sourceHeight: orientedHeight, derivatives };
}
