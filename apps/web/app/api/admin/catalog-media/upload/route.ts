import { randomUUID } from "node:crypto";

import {
  ProductMediaConflictError,
  ProductMediaNotFoundError,
  ProductMediaService,
  ProductMediaValidationError,
  productMediaLimits,
} from "@mundonettech/media";
import { revalidateCatalogMediaUpload } from "@/lib/media-revalidation";
import { z } from "zod";

import {
  adminMediaMethodNotAllowed,
  adminMediaUploadLimits,
  adminUploadAuthenticationError,
  adminUploadError,
  adminUploadJson,
  adminUploadText,
  optionalAdminUploadFile,
  readAdminMultipart,
  rejectInvalidAdminUploadOrigin,
  requiredAdminUploadFile,
  uploadFileBytes,
  validAdminUploadKeys,
} from "@/lib/admin-media-upload";
import { createMediaStorage } from "@/lib/media-storage";
import { createCatalogMediaService } from "@/lib/media-services";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const allowedFields = new Set([
  "productId",
  "variantId",
  "altText",
  "mediaType",
  "file",
  "frames",
  "glb",
  "usdz",
]);
const targetSchema = z
  .object({
    productId: z.string().uuid(),
    variantId: z.union([z.string().uuid(), z.literal("")]),
    altText: z.string().trim().min(1).max(250),
    mediaType: z.enum(["IMAGE", "SPIN_360", "MODEL_3D"]),
  })
  .strict();

function hasOnlyFileFields(form: FormData, expected: readonly string[]): boolean {
  const actual = ["file", "frames", "glb", "usdz"].filter((key) => form.has(key));
  return actual.length === expected.length && expected.every((key) => form.has(key));
}

function fileExceeds(form: FormData, key: string, maximum: number): boolean {
  return form.getAll(key).some((entry) => entry instanceof File && entry.size > maximum);
}

function failure(error: unknown): Response {
  if (error instanceof AdminAuthorizationError) return adminUploadAuthenticationError(error);
  if (error instanceof ProductMediaConflictError) return adminUploadError(409, "upload_conflict");
  if (
    error instanceof ProductMediaValidationError ||
    error instanceof ProductMediaNotFoundError ||
    error instanceof z.ZodError
  ) {
    return adminUploadError(400, "invalid_upload");
  }
  return adminUploadError(500, "upload_failed");
}

export async function POST(request: Request): Promise<Response> {
  const invalidOrigin = rejectInvalidAdminUploadOrigin(request);
  if (invalidOrigin) return invalidOrigin;

  let session;
  try {
    session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
  } catch (error) {
    return adminUploadAuthenticationError(error);
  }

  let storage: ReturnType<typeof createMediaStorage> | null = null;
  try {
    const context = await getRequestSecurityContext();
    const multipart = await readAdminMultipart(request, adminMediaUploadLimits.catalogBodyBytes);
    if (!multipart.ok) return multipart.response;
    const form = multipart.form;
    if (!validAdminUploadKeys(form, allowedFields, "frames")) {
      return adminUploadError(400, "invalid_upload");
    }
    const rawTarget = {
      productId: adminUploadText(form, "productId"),
      variantId: adminUploadText(form, "variantId"),
      altText: adminUploadText(form, "altText"),
      mediaType: adminUploadText(form, "mediaType"),
    };
    const parsed = targetSchema.safeParse(rawTarget);
    if (!parsed.success) return adminUploadError(400, "invalid_upload");
    const target = {
      productId: parsed.data.productId,
      variantId: parsed.data.variantId || null,
      altText: parsed.data.altText,
    };
    const requestId = randomUUID();
    const audit = {
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      requestId,
    };

    let operation: (
      service: ProductMediaService,
    ) => Promise<Awaited<ReturnType<ProductMediaService["uploadImage"]>>>;
    if (parsed.data.mediaType === "IMAGE") {
      if (!hasOnlyFileFields(form, ["file"])) return adminUploadError(400, "invalid_upload");
      if (fileExceeds(form, "file", productMediaLimits.imageBytes)) {
        return adminUploadError(413, "payload_too_large");
      }
      const file = requiredAdminUploadFile(form, "file", productMediaLimits.imageBytes);
      if (!file) return adminUploadError(400, "invalid_upload");
      const bytes = await uploadFileBytes(file);
      operation = (service) => service.uploadImage({ ...target, bytes }, audit);
    } else if (parsed.data.mediaType === "SPIN_360") {
      if (!hasOnlyFileFields(form, ["frames"])) return adminUploadError(400, "invalid_upload");
      const entries = form.getAll("frames");
      if (
        entries.length < productMediaLimits.spinMinFrames ||
        entries.length > productMediaLimits.spinMaxFrames
      ) {
        return adminUploadError(400, "invalid_upload");
      }
      let total = 0;
      const files: File[] = [];
      for (const entry of entries) {
        if (!(entry instanceof File) || entry.size === 0) {
          return adminUploadError(400, "invalid_upload");
        }
        total += entry.size;
        if (
          entry.size > productMediaLimits.spinFrameBytes ||
          total > productMediaLimits.spinTotalBytes
        ) {
          return adminUploadError(413, "payload_too_large");
        }
        files.push(entry);
      }
      const frames = await Promise.all(files.map(uploadFileBytes));
      operation = (service) => service.uploadSpin360({ ...target, frames }, audit);
    } else {
      if (!hasOnlyFileFields(form, ["glb", "usdz"]) && !hasOnlyFileFields(form, ["glb"])) {
        return adminUploadError(400, "invalid_upload");
      }
      if (
        fileExceeds(form, "glb", productMediaLimits.glbBytes) ||
        fileExceeds(form, "usdz", productMediaLimits.usdzBytes)
      ) {
        return adminUploadError(413, "payload_too_large");
      }
      const glbFile = requiredAdminUploadFile(form, "glb", productMediaLimits.glbBytes);
      const usdzFile = optionalAdminUploadFile(form, "usdz", productMediaLimits.usdzBytes);
      if (!glbFile || usdzFile === null) return adminUploadError(400, "invalid_upload");
      const glb = await uploadFileBytes(glbFile);
      const usdz = usdzFile ? await uploadFileBytes(usdzFile) : undefined;
      operation = (service) =>
        service.uploadModel3d({ ...target, glb, ...(usdz ? { usdz } : {}) }, audit);
    }

    storage = createMediaStorage();
    const result = await operation(createCatalogMediaService(storage));
    if (!result.reused) revalidateCatalogMediaUpload(result.slug);
    return adminUploadJson(
      {
        ok: true,
        mediaId: result.media.id,
        mediaType: result.media.mediaType,
        reused: result.reused,
        requestId,
      },
      result.reused ? 200 : 201,
    );
  } catch (error) {
    return failure(error);
  } finally {
    if (storage) await storage.destroy().catch(() => undefined);
  }
}

async function methodNotAllowed(): Promise<Response> {
  return adminMediaMethodNotAllowed();
}

export {
  methodNotAllowed as GET,
  methodNotAllowed as HEAD,
  methodNotAllowed as PUT,
  methodNotAllowed as PATCH,
  methodNotAllowed as DELETE,
  methodNotAllowed as OPTIONS,
};
