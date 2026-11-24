import { randomUUID } from "node:crypto";

import { CmsConflictError, CmsNotFoundError, CmsValidationError } from "@mundonettech/cms";
import { revalidateCmsMediaUpload } from "@/lib/media-revalidation";
import { z } from "zod";

import {
  adminMediaMethodNotAllowed,
  adminMediaUploadLimits,
  adminUploadAuthenticationError,
  adminUploadError,
  adminUploadJson,
  adminUploadText,
  readAdminMultipart,
  rejectInvalidAdminUploadOrigin,
  requiredAdminUploadFile,
  uploadFileBytes,
  validAdminUploadKeys,
} from "@/lib/admin-media-upload";
import { createMediaStorage } from "@/lib/media-storage";
import { createCmsMediaService } from "@/lib/media-services";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const maximumCmsImageBytes = 20 * 1024 * 1024;
const allowedFields = new Set(["file", "altText"]);
const altTextSchema = z.string().trim().min(1).max(250);

function failure(error: unknown): Response {
  if (error instanceof AdminAuthorizationError) return adminUploadAuthenticationError(error);
  if (error instanceof CmsConflictError) return adminUploadError(409, "upload_conflict");
  if (
    error instanceof CmsValidationError ||
    error instanceof CmsNotFoundError ||
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
    session = await getAdminSession({ permission: "content:write", requireRecentMfa: true });
  } catch (error) {
    return adminUploadAuthenticationError(error);
  }

  let storage: ReturnType<typeof createMediaStorage> | null = null;
  try {
    const context = await getRequestSecurityContext();
    const multipart = await readAdminMultipart(request, {
      maximumBodyBytes: adminMediaUploadLimits.cmsBodyBytes,
      maximumParts: 5,
    });
    if (!multipart.ok) return multipart.response;
    const form = multipart.form;
    if (!validAdminUploadKeys(form, allowedFields)) {
      return adminUploadError(400, "invalid_upload");
    }
    const altText = altTextSchema.parse(adminUploadText(form, "altText"));
    const entries = form.getAll("file");
    if (entries.some((entry) => entry instanceof File && entry.size > maximumCmsImageBytes)) {
      return adminUploadError(413, "payload_too_large");
    }
    const file = requiredAdminUploadFile(form, "file", maximumCmsImageBytes);
    if (!file) return adminUploadError(400, "invalid_upload");
    const bytes = await uploadFileBytes(file);
    const requestId = randomUUID();
    storage = createMediaStorage();
    const result = await createCmsMediaService(storage).upload(
      { bytes, filename: file.name, altText },
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        requestId,
      },
    );
    if (!result.reused) revalidateCmsMediaUpload();
    return adminUploadJson(
      { ok: true, mediaId: result.media.id, reused: result.reused, requestId },
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
