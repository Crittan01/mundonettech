import { createHash } from "node:crypto";

import { maskEmail, maskName, sanitizeAuditValue } from "@mundonettech/core";
import { Prisma, PrismaClient } from "@mundonettech/db";
import {
  R2MediaStorage,
  storeImageDerivatives,
  type StoredImageDerivative,
} from "@mundonettech/media";

import type { CmsAudit } from "./cms-service.js";
import { CmsConflictError, CmsNotFoundError, CmsValidationError } from "./cms-service.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CmsMediaUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly altText: string;
}

function assertUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) {
    throw new CmsValidationError(`${field} must be a canonical UUID.`);
  }
  return value;
}

function validateUpload(input: CmsMediaUpload): void {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > 20 * 1024 * 1024
  ) {
    throw new CmsValidationError("Image bytes must be between 1 byte and 20 MiB.");
  }
  if (
    !input.filename.trim() ||
    input.filename.trim() !== input.filename ||
    input.filename.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(input.filename)
  ) {
    throw new CmsValidationError("Invalid original filename.");
  }
  if (
    !input.altText.trim() ||
    input.altText.trim() !== input.altText ||
    input.altText.length > 250 ||
    /[\u0000-\u001f\u007f]/.test(input.altText) ||
    /<(?:[a-zA-Z!/])/.test(input.altText)
  ) {
    throw new CmsValidationError(
      "Alt text must be trimmed, plain text and contain at most 250 characters.",
    );
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

export class CmsMediaService {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: R2MediaStorage | null,
  ) {}

  async list(options: { limit?: number; cursor?: string; includeArchived?: boolean } = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CmsValidationError("Invalid media page size.");
    }
    if (options.cursor) {
      assertUuid(options.cursor, "cursor");
      const cursor = await this.db.cmsMedia.findUnique({ where: { id: options.cursor } });
      if (!cursor || (!options.includeArchived && cursor.deletedAt)) {
        throw new CmsNotFoundError("Media cursor not found in this view.");
      }
    }
    const items = await this.db.cmsMedia.findMany({
      where: options.includeArchived ? {} : { deletedAt: null },
      include: { createdBy: { select: { id: true, displayName: true, email: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const page = items.slice(0, limit).map((media) => ({
      ...media,
      createdBy: {
        ...media.createdBy,
        displayName: maskName(media.createdBy.displayName),
        email: maskEmail(media.createdBy.email),
      },
    }));
    return { items: page, nextCursor: items.length > limit ? (page.at(-1)?.id ?? null) : null };
  }

  async upload(input: CmsMediaUpload, audit: CmsAudit) {
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (audit.requestId !== undefined) assertUuid(audit.requestId, "requestId");
    validateUpload(input);
    const hash = createHash("sha256").update(input.bytes).digest();
    const hashBytes = Uint8Array.from(hash);
    const existing = await this.db.cmsMedia.findFirst({
      where: { contentHash: hashBytes, deletedAt: null },
    });
    if (existing) return { media: existing, reused: true };

    const storage = this.storage;
    if (!storage) throw new CmsValidationError("R2 storage is required for uploads.");

    const stored = await storeImageDerivatives(storage, input.bytes, "cms");
    const primary =
      [...stored].filter((item) => item.format === "webp").sort((a, b) => b.width - a.width)[0] ??
      stored.at(-1);
    if (!primary) throw new CmsValidationError("No safe image derivative was produced.");

    let failed = false;
    try {
      const media = await this.db.$transaction(async (tx) => {
        const created = await tx.cmsMedia.create({
          data: {
            storageKey: primary.key,
            contentHash: hashBytes,
            originalFilename: input.filename,
            mimeType: primary.contentType,
            altText: input.altText,
            byteSize: primary.byteSize,
            width: primary.width,
            height: primary.height,
            derivatives: derivativeJson(stored),
            createdByAdminUserId: audit.actorAdminUserId,
          },
        });
        await tx.adminActionLog.create({
          data: {
            actorAdminUserId: audit.actorAdminUserId,
            action: "CMS_MEDIA_CREATED",
            targetType: "CmsMedia",
            targetId: created.id,
            requestId: audit.requestId ?? null,
            ipHash: audit.ipHash ? Uint8Array.from(audit.ipHash) : null,
            userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
            metadata: sanitizeAuditValue({
              before: null,
              after: {
                id: created.id,
                mimeType: created.mimeType,
                byteSize: created.byteSize,
                width: created.width,
                height: created.height,
                derivativeCount: stored.length,
                deleted: created.deletedAt !== null,
              },
            }) as Prisma.JsonObject,
          },
        });
        return created;
      });
      return { media, reused: false };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        const duplicate = await this.db.cmsMedia.findFirst({
          where: { contentHash: hashBytes, deletedAt: null },
        });
        if (duplicate) return { media: duplicate, reused: true };
        failed = true;
      } else {
        failed = true;
      }
      if (failed) {
        let sharedReferenceCount = 0;
        try {
          sharedReferenceCount = await this.db.cmsMedia.count({
            where: {
              OR: [{ contentHash: hashBytes }, { storageKey: primary.key }],
            },
          });
        } catch {
          sharedReferenceCount = 0;
        }
        if (sharedReferenceCount === 0) {
          const cleanup = await Promise.allSettled(stored.map((item) => storage.delete(item.key)));
          if (cleanup.some((result) => result.status === "rejected")) {
            throw new AggregateError(
              [
                error,
                ...cleanup
                  .filter((result) => result.status === "rejected")
                  .map((result) => result.reason),
              ],
              "Media persistence and cleanup both failed.",
            );
          }
        }
      }
      throw error;
    }
  }

  async updateAltText(id: string, altText: string, audit: CmsAudit) {
    assertUuid(id, "mediaId");
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (
      !altText.trim() ||
      altText.trim() !== altText ||
      altText.length > 250 ||
      /[\u0000-\u001f\u007f]/.test(altText) ||
      /<(?:[a-zA-Z!/])/.test(altText)
    ) {
      throw new CmsValidationError("Invalid alt text.");
    }
    return this.db.$transaction(async (tx) => {
      const existing = await tx.cmsMedia.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new CmsNotFoundError("Media not found.");
      const updated = await tx.cmsMedia.update({ where: { id }, data: { altText } });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: audit.actorAdminUserId,
          action: "CMS_MEDIA_UPDATED",
          targetType: "CmsMedia",
          targetId: id,
          ipHash: audit.ipHash ? Uint8Array.from(audit.ipHash) : null,
          userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
          metadata: sanitizeAuditValue({
            before: {
              id: existing.id,
              mimeType: existing.mimeType,
              byteSize: existing.byteSize,
              altTextLength: existing.altText.length,
              deleted: existing.deletedAt !== null,
            },
            after: {
              id: updated.id,
              mimeType: updated.mimeType,
              byteSize: updated.byteSize,
              altTextLength: updated.altText.length,
              deleted: updated.deletedAt !== null,
            },
            altTextChanged: existing.altText !== updated.altText,
          }) as Prisma.JsonObject,
        },
      });
      return updated;
    });
  }

  async archive(id: string, audit: CmsAudit) {
    assertUuid(id, "mediaId");
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; mimeType: string; byteSize: number; now: Date }>
      >`
        SELECT "id", "mimeType", "byteSize", CURRENT_TIMESTAMP AS "now"
        FROM "CmsMedia"
        WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      const existing = locked[0];
      if (!existing) throw new CmsNotFoundError("Media not found.");

      const references = await tx.$queryRaw<Array<{ referenced: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM "CmsBlockVersion"
          WHERE jsonb_path_exists("content", '$.**.mediaId ? (@ == $id)', jsonb_build_object('id', ${id}::text))
        ) AS "referenced"
      `;
      if (references[0]?.referenced) {
        throw new CmsConflictError(
          "Media is referenced by CMS version history and cannot be archived.",
        );
      }

      const updated = await tx.cmsMedia.update({
        where: { id },
        data: { deletedAt: existing.now },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: audit.actorAdminUserId,
          action: "CMS_MEDIA_ARCHIVED",
          targetType: "CmsMedia",
          targetId: id,
          ipHash: audit.ipHash ? Uint8Array.from(audit.ipHash) : null,
          userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
          metadata: sanitizeAuditValue({
            before: {
              id: existing.id,
              mimeType: existing.mimeType,
              byteSize: existing.byteSize,
              deleted: false,
            },
            after: {
              id: updated.id,
              mimeType: updated.mimeType,
              byteSize: updated.byteSize,
              deleted: updated.deletedAt !== null,
            },
          }) as Prisma.JsonObject,
        },
      });
      return updated;
    });
  }
}
