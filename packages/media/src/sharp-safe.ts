import sharp from "sharp";

import { inspectImageMagic, type ImageSafetyOptions } from "./image-safety.js";

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

export async function processImageSafely(
  input: Uint8Array,
  options: ImageSafetyOptions & { widths?: readonly number[] } = {},
): Promise<ProcessedImage> {
  const magic = inspectImageMagic(input, options);
  const source = Buffer.from(input);
  const metadata = await sharp(source, {
    limitInputPixels: options.maxPixels ?? 40_000_000,
    sequentialRead: true,
    failOn: "error",
  }).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("Decoded image dimensions are unavailable.");
  const pixelBudget = options.maxPixels ?? 40_000_000;
  const dimensionBudget = options.maxDimension ?? 12_000;
  if (
    metadata.width > dimensionBudget ||
    metadata.height > dimensionBudget ||
    metadata.width * metadata.height > pixelBudget
  ) {
    throw new Error("Decoded image exceeds the allowed pixel budget.");
  }
  if (["avif", "heic"].includes(magic.format) && magic.bmffWidth === undefined)
    throw new Error("Missing pre-decode BMFF inspection.");

  const requested = options.widths ?? defaultWidths;
  if (requested.some((width) => !Number.isSafeInteger(width) || width < 32 || width > 8192))
    throw new RangeError("Invalid derivative width.");
  const widths = [
    ...new Set([...requested.filter((width) => width < metadata.width!), metadata.width]),
  ].sort((a, b) => a - b);
  const derivatives: ImageDerivative[] = [];

  for (const width of widths) {
    for (const format of ["avif", "webp"] as const) {
      const pipeline = sharp(source, {
        limitInputPixels: pixelBudget,
        sequentialRead: true,
        failOn: "error",
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
      }).metadata();
      if (
        !outputMetadata.width ||
        !outputMetadata.height ||
        outputMetadata.exif ||
        outputMetadata.iptc ||
        outputMetadata.xmp
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
  return { sourceWidth: metadata.width, sourceHeight: metadata.height, derivatives };
}
