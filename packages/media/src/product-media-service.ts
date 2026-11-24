import { createHash } from "node:crypto";

import { Prisma, PrismaClient, type ProductMedia } from "@mundonettech/db";

import {
  storeImageDerivatives,
  storeModel3d,
  storeSpin360,
  type StoredImageDerivative,
} from "./pipeline.js";
import { contentAddressedKey } from "./storage-keys.js";
import type { R2MediaStorage } from "./r2-storage.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxPosition = 1_000_000;

export const productMediaLimits = {
  imageBytes: 20 * 1024 * 1024,
  spinFrameBytes: 20 * 1024 * 1024,
  spinTotalBytes: 100 * 1024 * 1024,
  spinMinFrames: 2,
  spinMaxFrames: 120,
  glbBytes: 50 * 1024 * 1024,
  usdzBytes: 25 * 1024 * 1024,
} as const;

export interface ProductMediaAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash: Uint8Array | null;
}

export interface ProductMediaTargetInput {
  readonly productId: string;
  readonly variantId?: string | null;
  readonly altText: string;
}

export interface ProductImageUploadInput extends ProductMediaTargetInput {
  readonly bytes: Uint8Array;
}

export interface ProductSpinUploadInput extends ProductMediaTargetInput {
  readonly frames: readonly Uint8Array[];
}

export interface ProductModelUploadInput extends ProductMediaTargetInput {
  readonly glb: Uint8Array;
  readonly usdz?: Uint8Array;
}

export interface ProductMediaUpdateInput {
  readonly altText: string;
  readonly position: number;
}

export interface ProductMediaMutationResult {
  readonly media: ProductMedia;
  readonly slug: string;
}

export interface ProductMediaUploadResult extends ProductMediaMutationResult {
  readonly reused: boolean;
}

export class ProductMediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductMediaValidationError";
  }
}

export class ProductMediaNotFoundError extends Error {
  constructor(message = "Product media or target not found.") {
    super(message);
    this.name = "ProductMediaNotFoundError";
  }
}

export class ProductMediaConflictError extends Error {
  constructor(message = "The storage key belongs to a different active asset.") {
    super(message);
    this.name = "ProductMediaConflictError";
  }
}

interface MediaAssociation {
  readonly productId: string;
  readonly variantId: string | null;
}

interface NormalizedTarget extends MediaAssociation {
  readonly altText: string;
}

interface LockedTarget {
  readonly id: string;
  readonly slug: string;
}

interface PreparedMedia {
  readonly mediaType: "IMAGE" | "SPIN_360" | "MODEL_3D";
  readonly storageKey: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly frames: Prisma.JsonArray | null;
  readonly frameCount: number | null;
  readonly usdzKey: string | null;
  readonly derivativeCount: number;
  readonly objectGroups: readonly (readonly string[])[];
}

type DatabaseReader = PrismaClient | Prisma.TransactionClient;

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) {
    throw new ProductMediaValidationError(`${field} must be a canonical UUID.`);
  }
}

function validateAltText(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim() !== value ||
    value.length > 250 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /<(?:[a-zA-Z!/])/.test(value)
  ) {
    throw new ProductMediaValidationError(
      "Alt text must be trimmed plain text and contain at most 250 characters.",
    );
  }
  return value;
}

function normalizeTarget(input: ProductMediaTargetInput): NormalizedTarget {
  assertUuid(input.productId, "productId");
  const variantId = input.variantId ?? null;
  if (variantId !== null) assertUuid(variantId, "variantId");
  return {
    productId: input.productId,
    variantId,
    altText: validateAltText(input.altText),
  };
}

function validateAudit(audit: ProductMediaAudit): void {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (
    !(audit.ipHash instanceof Uint8Array) ||
    audit.ipHash.byteLength !== 32 ||
    (audit.userAgentHash !== null &&
      (!(audit.userAgentHash instanceof Uint8Array) || audit.userAgentHash.byteLength !== 32))
  ) {
    throw new ProductMediaValidationError("Audit hashes must contain 32 bytes.");
  }
}

function validateBytes(value: Uint8Array, maximum: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new ProductMediaValidationError(`${label} must contain between 1 and ${maximum} bytes.`);
  }
}

function derivativeJson(items: readonly StoredImageDerivative[]): Prisma.JsonArray {
  return items.map((item) => ({
    key: item.key,
    byteSize: item.byteSize,
    contentType: item.contentType,
    width: item.width,
    height: item.height,
    format: item.format,
  }));
}

function primaryDerivative(items: readonly StoredImageDerivative[]): StoredImageDerivative {
  if (
    !items.some((item) => item.format === "avif") ||
    !items.some((item) => item.format === "webp")
  ) {
    throw new ProductMediaValidationError("Both AVIF and WebP derivatives are required.");
  }
  const primary = [...items]
    .filter((item) => item.format === "webp")
    .sort((left, right) => right.width - left.width)[0];
  if (!primary) throw new ProductMediaValidationError("A WebP fallback derivative is required.");
  return primary;
}

function targetPrefix(target: NormalizedTarget, kind: string): string {
  return `catalog/${target.productId}/${target.variantId ?? "product"}/${kind}`;
}

function spinDigest(frames: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const frame of frames) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(frame.byteLength);
    hash.update(length);
    hash.update(frame);
  }
  return hash.digest("hex");
}

function isSameAsset(
  existing: ProductMedia,
  target: NormalizedTarget,
  prepared: PreparedMedia,
): boolean {
  return (
    existing.productId === target.productId &&
    existing.variantId === target.variantId &&
    existing.deletedAt === null &&
    existing.status === "READY" &&
    existing.mediaType === prepared.mediaType &&
    existing.storageKey === prepared.storageKey &&
    existing.usdzKey === prepared.usdzKey &&
    existing.frameCount === prepared.frameCount
  );
}

export class ProductMediaService {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: R2MediaStorage | null,
  ) {}

  private requireStorage(): R2MediaStorage {
    if (!this.storage) {
      throw new ProductMediaValidationError("R2 storage is required for product media uploads.");
    }
    return this.storage;
  }

  private async assertTargetExists(target: NormalizedTarget): Promise<void> {
    const product = await this.db.product.findFirst({
      where: { id: target.productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new ProductMediaNotFoundError("Product not found.");
    if (target.variantId) {
      const variant = await this.db.productVariant.findFirst({
        where: { id: target.variantId, productId: target.productId, deletedAt: null },
        select: { id: true },
      });
      if (!variant) throw new ProductMediaNotFoundError("Variant does not belong to the product.");
    }
  }

  private async lockTarget(
    tx: Prisma.TransactionClient,
    target: MediaAssociation,
  ): Promise<LockedTarget> {
    const products = await tx.$queryRaw<LockedTarget[]>`
      SELECT "id", "slug" FROM "Product"
      WHERE "id" = ${target.productId}::uuid AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const product = products[0];
    if (!product) throw new ProductMediaNotFoundError("Product not found.");
    if (target.variantId) {
      const variant = await tx.productVariant.findFirst({
        where: { id: target.variantId, productId: target.productId, deletedAt: null },
        select: { id: true },
      });
      if (!variant) throw new ProductMediaNotFoundError("Variant does not belong to the product.");
    }
    return product;
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    audit: ProductMediaAudit,
    action: string,
    targetId: string,
    metadata: Prisma.JsonObject,
  ): Promise<void> {
    await tx.adminActionLog.create({
      data: {
        actorAdminUserId: audit.actorAdminUserId,
        action,
        targetType: "ProductMedia",
        targetId,
        ipHash: Uint8Array.from(audit.ipHash),
        userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
        metadata,
      },
    });
  }

  private async referencedKeys(
    tx: Prisma.TransactionClient,
    keys: readonly string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const values = Prisma.join(keys.map((key) => Prisma.sql`(${key})`));
    const rows = await tx.$queryRaw<Array<{ key: string; referenced: boolean }>>`
      WITH candidates("key") AS (
        SELECT * FROM (VALUES ${values}) AS supplied("key")
      )
      SELECT candidates."key", EXISTS (
        SELECT 1 FROM "ProductMedia" pm
        WHERE pm."storageKey" = candidates."key"
          OR pm."posterKey" = candidates."key"
          OR pm."usdzKey" = candidates."key"
          OR jsonb_path_exists(
            pm."frames", '$[*].key ? (@ == $key)',
            jsonb_build_object('key', candidates."key")
          )
          OR jsonb_path_exists(
            pm."frames", '$[*].storageKey ? (@ == $key)',
            jsonb_build_object('key', candidates."key")
          )
          OR jsonb_path_exists(
            pm."frames", '$[*].derivatives[*].key ? (@ == $key)',
            jsonb_build_object('key', candidates."key")
          )
          OR jsonb_path_exists(
            pm."frames", '$[*].derivatives[*].storageKey ? (@ == $key)',
            jsonb_build_object('key', candidates."key")
          )
          OR jsonb_path_exists(
            pm."frames", '$[*] ? (@.type() == "string" && @ == $key)',
            jsonb_build_object('key', candidates."key")
          )
      ) AS "referenced"
      FROM candidates
    `;
    return new Set(rows.filter((row) => row.referenced).map((row) => row.key));
  }

  private async compensate(
    productId: string,
    objectGroups: readonly (readonly string[])[],
  ): Promise<void> {
    const storage = this.requireStorage();
    const keys = [...new Set(objectGroups.flatMap((group) => [...group]))];
    if (keys.length === 0) return;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Product" WHERE "id" = ${productId}::uuid FOR UPDATE
      `;
      const referenced = await this.referencedKeys(tx, keys);
      const deletable = objectGroups.flatMap((group) =>
        group.some((key) => referenced.has(key))
          ? []
          : [...new Set(group.filter((key) => !referenced.has(key)))],
      );
      const results = await Promise.allSettled(
        [...new Set(deletable)].map((key) => storage.delete(key)),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Some unreferenced R2 objects could not be removed.",
        );
      }
    });
  }

  private async failUpload(
    productId: string,
    objectGroups: readonly (readonly string[])[],
    error: unknown,
    message: string,
  ): Promise<never> {
    try {
      await this.compensate(productId, objectGroups);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], message);
    }
    throw error;
  }

  private async reusableAsset(
    db: DatabaseReader,
    target: NormalizedTarget,
    prepared: PreparedMedia,
  ): Promise<ProductMedia | null> {
    const existing = await db.productMedia.findFirst({
      where: { storageKey: prepared.storageKey, deletedAt: null },
    });
    return existing && isSameAsset(existing, target, prepared) ? existing : null;
  }

  private async persist(
    target: NormalizedTarget,
    prepared: PreparedMedia,
    audit: ProductMediaAudit,
  ): Promise<ProductMediaUploadResult> {
    try {
      return await this.db.$transaction(async (tx) => {
        const product = await this.lockTarget(tx, target);
        const existing = await tx.productMedia.findFirst({
          where: { storageKey: prepared.storageKey, deletedAt: null },
        });
        if (existing) {
          if (!isSameAsset(existing, target, prepared)) throw new ProductMediaConflictError();
          return { media: existing, slug: product.slug, reused: true };
        }
        const positions = await tx.productMedia.aggregate({
          where: { productId: target.productId },
          _max: { position: true },
        });
        const position = (positions._max.position ?? -1) + 1;
        if (position > maxPosition) {
          throw new ProductMediaValidationError("Product media position limit exceeded.");
        }
        const created = await tx.productMedia.create({
          data: {
            productId: target.productId,
            variantId: target.variantId,
            mediaType: prepared.mediaType,
            status: "READY",
            storageKey: prepared.storageKey,
            mimeType: prepared.mimeType,
            altText: target.altText,
            width: prepared.width,
            height: prepared.height,
            ...(prepared.frames ? { frames: prepared.frames } : {}),
            frameCount: prepared.frameCount,
            usdzKey: prepared.usdzKey,
            position,
          },
        });
        await this.writeAudit(tx, audit, "CATALOG_MEDIA_CREATED", created.id, {
          productId: target.productId,
          variantId: target.variantId,
          mediaType: prepared.mediaType,
          storageKey: prepared.storageKey,
          usdzKey: prepared.usdzKey,
          frameCount: prepared.frameCount,
          derivativeCount: prepared.derivativeCount,
          position,
        });
        return { media: created, slug: product.slug, reused: false };
      });
    } catch (error) {
      let duplicate: ProductMedia | null = null;
      try {
        duplicate = await this.reusableAsset(this.db, target, prepared);
      } catch {
        duplicate = null;
      }
      if (duplicate) {
        const product = await this.db.product.findUniqueOrThrow({
          where: { id: target.productId },
          select: { slug: true },
        });
        return { media: duplicate, slug: product.slug, reused: true };
      }
      const persistenceError = hasErrorCode(error, "P2002")
        ? new ProductMediaConflictError()
        : error;
      try {
        await this.compensate(target.productId, prepared.objectGroups);
      } catch (cleanupError) {
        throw new AggregateError(
          [persistenceError, cleanupError],
          "Product media persistence and R2 compensation both failed.",
        );
      }
      throw persistenceError;
    }
  }

  async uploadImage(
    input: ProductImageUploadInput,
    audit: ProductMediaAudit,
  ): Promise<ProductMediaUploadResult> {
    const target = normalizeTarget(input);
    validateAudit(audit);
    validateBytes(input.bytes, productMediaLimits.imageBytes, "Image bytes");
    await this.assertTargetExists(target);
    const storage = this.requireStorage();
    const stored = await storeImageDerivatives(storage, input.bytes, targetPrefix(target, "image"));
    const objectGroups = [stored.map((item) => item.key)];
    let primary: StoredImageDerivative;
    try {
      primary = primaryDerivative(stored);
    } catch (error) {
      return this.failUpload(
        target.productId,
        objectGroups,
        error,
        "Image validation and R2 compensation both failed.",
      );
    }
    return this.persist(
      target,
      {
        mediaType: "IMAGE",
        storageKey: primary.key,
        mimeType: primary.contentType,
        width: primary.width,
        height: primary.height,
        frames: null,
        frameCount: null,
        usdzKey: null,
        derivativeCount: stored.length,
        objectGroups,
      },
      audit,
    );
  }

  async uploadSpin360(
    input: ProductSpinUploadInput,
    audit: ProductMediaAudit,
  ): Promise<ProductMediaUploadResult> {
    const target = normalizeTarget(input);
    validateAudit(audit);
    if (
      !Array.isArray(input.frames) ||
      input.frames.length < productMediaLimits.spinMinFrames ||
      input.frames.length > productMediaLimits.spinMaxFrames
    ) {
      throw new ProductMediaValidationError("SPIN_360 requires between 2 and 120 frames.");
    }
    let totalBytes = 0;
    for (const frame of input.frames) {
      validateBytes(frame, productMediaLimits.spinFrameBytes, "SPIN_360 frame bytes");
      totalBytes += frame.byteLength;
      if (totalBytes > productMediaLimits.spinTotalBytes) {
        throw new ProductMediaValidationError("SPIN_360 exceeds the aggregate byte limit.");
      }
    }
    await this.assertTargetExists(target);
    const storage = this.requireStorage();
    const prefix = `${targetPrefix(target, "spin")}-${spinDigest(input.frames)}`;
    const stored = await storeSpin360(storage, input.frames, prefix);
    const objectGroups = stored.map((frame) => frame.derivatives.map((item) => item.key));
    let primary: StoredImageDerivative;
    try {
      const first = stored[0];
      if (!first || stored.length !== input.frames.length) {
        throw new ProductMediaValidationError("SPIN_360 did not produce every required frame.");
      }
      primary = primaryDerivative(first.derivatives);
      for (const frame of stored) primaryDerivative(frame.derivatives);
    } catch (error) {
      return this.failUpload(
        target.productId,
        objectGroups,
        error,
        "SPIN_360 validation and R2 compensation both failed.",
      );
    }
    return this.persist(
      target,
      {
        mediaType: "SPIN_360",
        storageKey: primary.key,
        mimeType: primary.contentType,
        width: primary.width,
        height: primary.height,
        frames: stored.map((frame) => ({
          frame: frame.frame,
          derivatives: derivativeJson(frame.derivatives),
        })),
        frameCount: stored.length,
        usdzKey: null,
        derivativeCount: stored.reduce((sum, frame) => sum + frame.derivatives.length, 0),
        objectGroups,
      },
      audit,
    );
  }

  async uploadModel3d(
    input: ProductModelUploadInput,
    audit: ProductMediaAudit,
  ): Promise<ProductMediaUploadResult> {
    const target = normalizeTarget(input);
    validateAudit(audit);
    validateBytes(input.glb, productMediaLimits.glbBytes, "GLB bytes");
    if (input.usdz) validateBytes(input.usdz, productMediaLimits.usdzBytes, "USDZ bytes");
    await this.assertTargetExists(target);
    const storage = this.requireStorage();
    const prefix = targetPrefix(target, "model");
    const objectGroups: string[][] = [];
    let glb;
    let usdz;
    try {
      glb = await storeModel3d(storage, input.glb, "glb", prefix);
      objectGroups.push([glb.key]);
      if (input.usdz) {
        usdz = await storeModel3d(storage, input.usdz, "usdz", prefix);
        objectGroups.push([usdz.key]);
      }
      const expectedUsdzKey = input.usdz
        ? contentAddressedKey(prefix, input.usdz, "model.usdz")
        : null;
      if ((usdz?.key ?? null) !== expectedUsdzKey) {
        throw new ProductMediaValidationError("Stored USDZ key does not match its content.");
      }
    } catch (error) {
      return this.failUpload(
        target.productId,
        objectGroups,
        error,
        "Model upload and R2 compensation both failed.",
      );
    }
    return this.persist(
      target,
      {
        mediaType: "MODEL_3D",
        storageKey: glb.key,
        mimeType: glb.contentType,
        width: null,
        height: null,
        frames: null,
        frameCount: null,
        usdzKey: usdz?.key ?? null,
        derivativeCount: 0,
        objectGroups,
      },
      audit,
    );
  }

  async update(
    productId: string,
    mediaId: string,
    input: ProductMediaUpdateInput,
    audit: ProductMediaAudit,
  ): Promise<ProductMediaMutationResult> {
    assertUuid(productId, "productId");
    assertUuid(mediaId, "mediaId");
    validateAudit(audit);
    const altText = validateAltText(input.altText);
    if (
      !Number.isSafeInteger(input.position) ||
      input.position < 0 ||
      input.position > maxPosition
    ) {
      throw new ProductMediaValidationError("Invalid product media position.");
    }
    return this.db.$transaction(async (tx) => {
      const product = await this.lockTarget(tx, { productId, variantId: null });
      const rows = await tx.$queryRaw<Array<Pick<ProductMedia, "id" | "position" | "altText">>>`
        SELECT "id", "position", "altText" FROM "ProductMedia"
        WHERE "id" = ${mediaId}::uuid AND "productId" = ${productId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      const existing = rows[0];
      if (!existing) throw new ProductMediaNotFoundError("Active product media not found.");
      const siblings = await tx.productMedia.findMany({
        where: { productId, deletedAt: null },
        select: { position: true },
      });
      const highestPosition = Math.max(...siblings.map((item) => item.position));
      if (input.position > highestPosition) {
        throw new ProductMediaValidationError("Position exceeds the active media range.");
      }
      if (input.position < existing.position) {
        await tx.productMedia.updateMany({
          where: {
            productId,
            deletedAt: null,
            id: { not: mediaId },
            position: { gte: input.position, lt: existing.position },
          },
          data: { position: { increment: 1 } },
        });
      } else if (input.position > existing.position) {
        await tx.productMedia.updateMany({
          where: {
            productId,
            deletedAt: null,
            id: { not: mediaId },
            position: { gt: existing.position, lte: input.position },
          },
          data: { position: { decrement: 1 } },
        });
      }
      const media = await tx.productMedia.update({
        where: { id: mediaId },
        data: { altText, position: input.position },
      });
      await this.writeAudit(tx, audit, "CATALOG_MEDIA_UPDATED", mediaId, {
        productId,
        mediaType: media.mediaType,
        previousPosition: existing.position,
        position: input.position,
        altTextChanged: existing.altText !== altText,
      });
      return { media, slug: product.slug };
    });
  }

  async archive(
    productId: string,
    mediaId: string,
    audit: ProductMediaAudit,
  ): Promise<ProductMediaMutationResult> {
    assertUuid(productId, "productId");
    assertUuid(mediaId, "mediaId");
    validateAudit(audit);
    return this.db.$transaction(async (tx) => {
      const product = await this.lockTarget(tx, { productId, variantId: null });
      const rows = await tx.$queryRaw<
        Array<{ id: string; mediaType: ProductMedia["mediaType"]; now: Date }>
      >`
        SELECT "id", "mediaType", CURRENT_TIMESTAMP AS "now" FROM "ProductMedia"
        WHERE "id" = ${mediaId}::uuid AND "productId" = ${productId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      const existing = rows[0];
      if (!existing) throw new ProductMediaNotFoundError("Active product media not found.");
      const media = await tx.productMedia.update({
        where: { id: mediaId },
        data: { deletedAt: existing.now },
      });
      await this.writeAudit(tx, audit, "CATALOG_MEDIA_ARCHIVED", mediaId, {
        productId,
        mediaType: existing.mediaType,
        storageKey: media.storageKey,
        usdzKey: media.usdzKey,
      });
      return { media, slug: product.slug };
    });
  }
}
