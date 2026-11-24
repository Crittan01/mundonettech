import { inspectImageMagic } from "./image-safety.js";
import { processImageSafely, type ImageDerivative } from "./sharp-safe.js";
import { validateGlb, validateUsdz } from "./model-safety.js";
import { R2MediaStorage, type StoredObject } from "./r2-storage.js";
import { contentAddressedKey, normalizeStoragePrefix } from "./storage-keys.js";

export interface StoredImageDerivative extends StoredObject {
  format: "avif" | "webp";
  width: number;
  height: number;
}

export interface PipelineStorageOptions {
  readonly cleanup?: (keys: readonly string[]) => Promise<void>;
}

async function removeObjects(
  storage: R2MediaStorage,
  objects: readonly { key: string }[],
  cleanup?: (keys: readonly string[]) => Promise<void>,
): Promise<void> {
  if (objects.length === 0) return;
  if (cleanup) {
    await cleanup(objects.map((object) => object.key));
    return;
  }
  const results = await Promise.allSettled(objects.map((object) => storage.delete(object.key)));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Failed to clean all partial media uploads.");
  }
}

async function failWithCleanup(
  storage: R2MediaStorage,
  objects: readonly { key: string }[],
  error: unknown,
  cleanup?: (keys: readonly string[]) => Promise<void>,
): Promise<never> {
  try {
    await removeObjects(storage, objects, cleanup);
  } catch (cleanupError) {
    const causes =
      error instanceof AggregateError ? [...error.errors, cleanupError] : [error, cleanupError];
    throw new AggregateError(causes, "Media upload and cleanup both failed.");
  }
  throw error;
}

export async function storeImageDerivatives(
  storage: R2MediaStorage,
  input: Uint8Array,
  prefix: string,
  widths?: readonly number[],
  options: PipelineStorageOptions = {},
): Promise<StoredImageDerivative[]> {
  const safePrefix = normalizeStoragePrefix(prefix);
  const processed = await processImageSafely(input, { ...(widths ? { widths } : {}) });
  const stored: StoredImageDerivative[] = [];
  try {
    for (const derivative of processed.derivatives) {
      const object = await storeDerivative(
        storage,
        derivative,
        contentAddressedKey(safePrefix, input, `${derivative.width}.${derivative.format}`),
      );
      stored.push({
        ...object,
        format: derivative.format,
        width: derivative.width,
        height: derivative.height,
      });
    }
  } catch (error) {
    return failWithCleanup(storage, stored, error, options.cleanup);
  }
  return stored;
}

async function storeDerivative(
  storage: R2MediaStorage,
  derivative: ImageDerivative,
  key: string,
): Promise<StoredObject> {
  return storage.put({ key, body: derivative.bytes, contentType: derivative.mimeType });
}

export async function storeSpin360(
  storage: R2MediaStorage,
  frames: readonly Uint8Array[],
  prefix: string,
  widths?: readonly number[],
  options: PipelineStorageOptions = {},
): Promise<{ frame: number; derivatives: StoredImageDerivative[] }[]> {
  const safePrefix = normalizeStoragePrefix(prefix);
  if (frames.length < 2 || frames.length > 120) {
    throw new RangeError("SPIN_360 requires between 2 and 120 frames.");
  }
  for (const frame of frames) {
    inspectImageMagic(frame);
  }
  const completed: { frame: number; derivatives: StoredImageDerivative[] }[] = [];
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]!;
      const derivatives = await storeImageDerivatives(
        storage,
        frame,
        `${safePrefix}/frame-${String(index + 1).padStart(3, "0")}`,
        widths,
        options,
      );
      completed.push({ frame: index, derivatives });
    }
  } catch (error) {
    return failWithCleanup(
      storage,
      completed.flatMap((frame) => frame.derivatives),
      error,
      options.cleanup,
    );
  }
  return completed;
}

export async function storeModel3d(
  storage: R2MediaStorage,
  input: Uint8Array,
  kind: "glb" | "usdz",
  prefix: string,
): Promise<StoredObject> {
  const safePrefix = normalizeStoragePrefix(prefix);
  if (kind === "glb") validateGlb(input);
  else await validateUsdz(input);
  return storage.put({
    key: contentAddressedKey(safePrefix, input, `model.${kind}`),
    body: input,
    contentType: kind === "glb" ? "model/gltf-binary" : "model/vnd.usdz+zip",
  });
}
