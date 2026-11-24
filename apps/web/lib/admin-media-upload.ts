import { AdminAuthorizationError } from "@/lib/security/admin-auth";

export const adminMediaUploadLimits = {
  catalogBodyBytes: 101 * 1024 * 1024,
  cmsBodyBytes: 21 * 1024 * 1024,
} as const;

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

export type AdminUploadErrorCode =
  | "invalid_origin"
  | "unauthorized"
  | "forbidden"
  | "mfa_stale"
  | "invalid_upload"
  | "payload_too_large"
  | "unsupported_media_type"
  | "upload_conflict"
  | "upload_failed";

export function adminUploadJson(
  body: Record<string, unknown>,
  status: number,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...responseHeaders, ...headers },
  });
}

export function adminUploadError(status: number, code: AdminUploadErrorCode): Response {
  return adminUploadJson({ ok: false, error: code }, status);
}

export function adminMediaMethodNotAllowed(): Response {
  return adminUploadJson({ ok: false, error: "invalid_upload" }, 405, { Allow: "POST" });
}

export function rejectInvalidAdminUploadOrigin(request: Request): Response | null {
  const value = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!value || !host || value.includes(",") || /[\s/\\@]/.test(host)) {
    return adminUploadError(403, "invalid_origin");
  }
  try {
    const origin = new URL(value);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.host.toLowerCase() !== host.toLowerCase()
    ) {
      return adminUploadError(403, "invalid_origin");
    }
  } catch {
    return adminUploadError(403, "invalid_origin");
  }
  return null;
}

export function adminUploadAuthenticationError(error: unknown): Response {
  if (error instanceof AdminAuthorizationError) {
    if (error.code === "MFA_STALE") return adminUploadError(403, "mfa_stale");
    if (error.code === "FORBIDDEN") return adminUploadError(403, "forbidden");
    return adminUploadError(401, "unauthorized");
  }
  return adminUploadError(401, "unauthorized");
}

function multipartBoundary(contentType: string): string | null {
  const segments = contentType.split(";");
  if (segments.length !== 2 || segments[0]?.trim().toLowerCase() !== "multipart/form-data") {
    return null;
  }
  const parameter = segments[1]?.trim() ?? "";
  const match = /^boundary=(?:("([^"]{1,200})")|([A-Za-z0-9'()+_,.\/:=?-]{1,200}))$/i.exec(
    parameter,
  );
  const boundary = match?.[2] ?? match?.[3] ?? null;
  if (!boundary || /[\u0000-\u001f\u007f\uFFFD]/.test(boundary)) return null;
  return boundary;
}

export type AdminMultipartResult =
  | { readonly ok: true; readonly form: FormData }
  | { readonly ok: false; readonly response: Response };

export async function readAdminMultipart(
  request: Request,
  maximumBodyBytes: number,
): Promise<AdminMultipartResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!multipartBoundary(contentType)) {
    return { ok: false, response: adminUploadError(415, "unsupported_media_type") };
  }
  const rawDeclared = request.headers.get("content-length");
  let declared: number | null = null;
  if (rawDeclared !== null) {
    if (!/^[0-9]{1,15}$/.test(rawDeclared)) {
      return { ok: false, response: adminUploadError(400, "invalid_upload") };
    }
    declared = Number(rawDeclared);
    if (!Number.isSafeInteger(declared)) {
      return { ok: false, response: adminUploadError(400, "invalid_upload") };
    }
    if (declared > maximumBodyBytes) {
      return { ok: false, response: adminUploadError(413, "payload_too_large") };
    }
  }
  if (!request.body) {
    return { ok: false, response: adminUploadError(400, "invalid_upload") };
  }

  let total = 0;
  let exceeded = false;
  let lengthMismatch = false;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maximumBodyBytes) {
        exceeded = true;
        controller.error(new Error("Multipart body limit exceeded."));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (declared !== null && declared !== total) {
        lengthMismatch = true;
        controller.error(new Error("Multipart content length mismatch."));
      }
    },
  });
  const limitedBody = request.body.pipeThrough(limiter);
  try {
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: limitedBody,
      duplex: "half",
    };
    const limitedRequest = new Request(request.url, init);
    const form = await limitedRequest.formData();
    return { ok: true, form };
  } catch {
    if (exceeded) {
      return { ok: false, response: adminUploadError(413, "payload_too_large") };
    }
    if (lengthMismatch) {
      return { ok: false, response: adminUploadError(400, "invalid_upload") };
    }
    return { ok: false, response: adminUploadError(400, "invalid_upload") };
  }
}

export function validAdminUploadKeys(
  form: FormData,
  allowed: ReadonlySet<string>,
  repeatable?: string,
): boolean {
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (!allowed.has(key)) return false;
    if (key !== repeatable && seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function adminUploadText(form: FormData, key: string): string | null {
  const values = form.getAll(key);
  if (values.length > 1) return null;
  const value = values[0];
  if (value === undefined) return "";
  if (typeof value !== "string" || /[\u0000\uFFFD]/.test(value)) return null;
  return value;
}

export function requiredAdminUploadFile(
  form: FormData,
  key: string,
  maximumBytes: number,
): File | null {
  const values = form.getAll(key);
  if (values.length !== 1) return null;
  const file = values[0];
  if (
    !(file instanceof File) ||
    file.size === 0 ||
    file.size > maximumBytes ||
    /[\u0000\uFFFD]/.test(file.name)
  ) {
    return null;
  }
  return file;
}

export function optionalAdminUploadFile(
  form: FormData,
  key: string,
  maximumBytes: number,
): File | null | undefined {
  if (!form.has(key)) return undefined;
  const values = form.getAll(key);
  if (
    values.length === 1 &&
    values[0] instanceof File &&
    values[0].size === 0 &&
    values[0].name === ""
  ) {
    return undefined;
  }
  return requiredAdminUploadFile(form, key, maximumBytes);
}

export async function uploadFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
