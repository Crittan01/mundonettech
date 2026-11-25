import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { AdminActorAuthorizationError } from "../../packages/db/dist/index.js";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET as catalogGet,
  POST as catalogPost,
} from "../../apps/web/app/api/admin/catalog-media/upload/route";
import {
  GET as cmsGet,
  POST as cmsPost,
} from "../../apps/web/app/api/admin/cms-media/upload/route";

const harness = vi.hoisted(() => {
  class AdminAuthorizationError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "AdminAuthorizationError";
    }
  }
  return {
    AdminAuthorizationError,
    getAdminSession: vi.fn(),
    getRequestSecurityContext: vi.fn(),
    createMediaStorage: vi.fn(),
    storageDestroy: vi.fn(),
    uploadImage: vi.fn(),
    uploadSpin360: vi.fn(),
    uploadModel3d: vi.fn(),
    cmsUpload: vi.fn(),
    revalidateTag: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/security/origin", async () => {
  return import("../../apps/web/lib/security/origin");
});
vi.mock("@/lib/admin-media-upload", async () => {
  return import("../../apps/web/lib/admin-media-upload");
});
vi.mock("@/lib/security/admin-auth", () => ({
  AdminAuthorizationError: harness.AdminAuthorizationError,
  getAdminSession: harness.getAdminSession,
}));
vi.mock("@/lib/security/request-context", () => ({
  getRequestSecurityContext: harness.getRequestSecurityContext,
}));
vi.mock("@/lib/db", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/media-storage", () => ({
  createMediaStorage: harness.createMediaStorage,
}));
vi.mock("@/lib/media-services", () => ({
  createCatalogMediaService: () => ({
    uploadImage: harness.uploadImage,
    uploadSpin360: harness.uploadSpin360,
    uploadModel3d: harness.uploadModel3d,
  }),
  createCmsMediaService: () => ({ upload: harness.cmsUpload }),
}));
vi.mock("@/lib/media-revalidation", () => ({
  revalidateCatalogMediaUpload: (slug: string) =>
    harness.revalidateTag(`catalog:product:${slug}`, { expire: 0 }),
  revalidateCmsMediaUpload: () => harness.revalidateTag("cms:media", { expire: 0 }),
}));

const origin = "https://admin.test";
const productId = randomUUID();
const mediaId = randomUUID();

function streamOf(body: Uint8Array, chunkSize = 977): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= body.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(body.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function multipart(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const draft = new Request(`${origin}/upload`, { method: "POST", body: form });
  const contentType = draft.headers.get("content-type");
  if (!contentType) throw new TypeError("Multipart content type was not generated.");
  return { body: new Uint8Array(await draft.arrayBuffer()), contentType };
}

function uploadRequest(options: {
  body: Uint8Array | ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number | null;
  requestOrigin?: string | null;
}): Request {
  const headers = new Headers({
    Host: "admin.test",
    Origin: options.requestOrigin === undefined ? origin : (options.requestOrigin ?? ""),
    "Content-Type": options.contentType,
  });
  if (options.contentLength !== null) {
    headers.set(
      "Content-Length",
      String(
        options.contentLength ?? (options.body instanceof Uint8Array ? options.body.byteLength : 0),
      ),
    );
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body: options.body as BodyInit,
  };
  if (options.body instanceof ReadableStream) init.duplex = "half";
  return new Request(`${origin}/api/admin/upload`, init);
}

function catalogForm(): FormData {
  const form = new FormData();
  form.set("productId", productId);
  form.set("variantId", "");
  form.set("altText", "Vista frontal");
  form.set("mediaType", "IMAGE");
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "front.png"));
  return form;
}

function cmsForm(): FormData {
  const form = new FormData();
  form.set("altText", "Imagen editorial");
  form.set("file", new File([new Uint8Array([5, 6, 7, 8])], "editorial.png"));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.getAdminSession.mockResolvedValue({ profile: { id: randomUUID() } });
  harness.getRequestSecurityContext.mockResolvedValue({
    ipHash: new Uint8Array(32),
    userAgentHash: new Uint8Array(32),
  });
  harness.createMediaStorage.mockReturnValue({ destroy: harness.storageDestroy });
  harness.storageDestroy.mockResolvedValue(undefined);
  harness.uploadImage.mockResolvedValue({
    media: { id: mediaId, mediaType: "IMAGE" },
    slug: "producto-real",
    reused: false,
  });
  harness.uploadSpin360.mockResolvedValue({
    media: { id: mediaId, mediaType: "SPIN_360" },
    slug: "producto-real",
    reused: false,
  });
  harness.uploadModel3d.mockResolvedValue({
    media: { id: mediaId, mediaType: "MODEL_3D" },
    slug: "producto-real",
    reused: false,
  });
  harness.cmsUpload.mockResolvedValue({ media: { id: mediaId }, reused: false });
});

describe("A2 — admin media handlers authenticate before body and R2", () => {
  it.each([
    ["NO_SESSION", 401, "unauthorized"],
    ["FORBIDDEN", 403, "forbidden"],
    ["MFA_STALE", 403, "mfa_stale"],
  ])("rejects %s without reading the body or opening storage", async (code, status, error) => {
    let bodyReads = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    harness.getAdminSession.mockRejectedValue(new harness.AdminAuthorizationError(code));
    const request = uploadRequest({
      body,
      contentType: "multipart/form-data; boundary=a2",
      contentLength: null,
    });
    const guarded = new Proxy(request, {
      get(target, property, receiver) {
        if (property === "body") bodyReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const response = await catalogPost(guarded);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error });
    expect(bodyReads).toBe(0);
    expect(harness.createMediaStorage).not.toHaveBeenCalled();
    expect(harness.uploadImage).not.toHaveBeenCalled();
  });

  it("rejects missing/cross-site Origin before authentication or body reads", async () => {
    for (const requestOrigin of [null, "https://evil.example"]) {
      const response = await cmsPost(
        uploadRequest({
          body: new Uint8Array([1]),
          contentType: "multipart/form-data; boundary=a2",
          requestOrigin,
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: "invalid_origin" });
    }
    expect(harness.getAdminSession).not.toHaveBeenCalled();
    expect(harness.createMediaStorage).not.toHaveBeenCalled();
  });

  it("uses exact write permissions and recent MFA on both handlers", async () => {
    const catalog = await multipart(catalogForm());
    await catalogPost(uploadRequest({ ...catalog }));
    expect(harness.getAdminSession).toHaveBeenLastCalledWith({
      permission: "catalog:write",
      requireRecentMfa: true,
    });
    const cms = await multipart(cmsForm());
    await cmsPost(uploadRequest({ ...cms }));
    expect(harness.getAdminSession).toHaveBeenLastCalledWith({
      permission: "content:write",
      requireRecentMfa: true,
    });
  });

  it("returns an explicit 405 without invoking authentication", async () => {
    for (const response of [await catalogGet(), await cmsGet()]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(harness.getAdminSession).not.toHaveBeenCalled();
  });
});

describe("A2 — real multipart parsing, limits and safe responses", () => {
  it("uploads catalog media and returns no R2 keys or sensitive error details", async () => {
    const response = await catalogPost(uploadRequest({ ...(await multipart(catalogForm())) }));
    expect(harness.uploadImage).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, mediaId, mediaType: "IMAGE", reused: false });
    expect(JSON.stringify(payload)).not.toContain("storageKey");
    expect(harness.uploadImage).toHaveBeenCalledOnce();
    const [input, audit] = harness.uploadImage.mock.calls[0]!;
    expect(input.productId).toBe(productId);
    expect(input.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(audit.ipHash).toHaveLength(32);
    expect(audit.requestId).toBe(payload.requestId);
    expect(harness.createMediaStorage).toHaveBeenCalledOnce();
    expect(harness.storageDestroy).toHaveBeenCalledOnce();
    expect(harness.revalidateTag).toHaveBeenCalledWith("catalog:product:producto-real", {
      expire: 0,
    });
  });

  it("accepts valid chunked CMS multipart without Content-Length", async () => {
    const data = await multipart(cmsForm());
    const response = await cmsPost(
      uploadRequest({ ...data, body: streamOf(data.body), contentLength: null }),
    );
    expect(response.status).toBe(201);
    expect(harness.cmsUpload).toHaveBeenCalledOnce();
    expect(harness.revalidateTag).toHaveBeenCalledWith("cms:media", { expire: 0 });
  });

  it("rejects malformed content types and unknown/duplicate fields before R2", async () => {
    const wrongType = await cmsPost(
      uploadRequest({ body: new Uint8Array([1]), contentType: "text/plain" }),
    );
    expect(wrongType.status).toBe(415);

    const unknown = cmsForm();
    unknown.set("unexpected", "value");
    const unknownResponse = await cmsPost(uploadRequest({ ...(await multipart(unknown)) }));
    expect(unknownResponse.status).toBe(400);

    const duplicate = cmsForm();
    duplicate.append("altText", "Duplicado");
    const duplicateResponse = await cmsPost(uploadRequest({ ...(await multipart(duplicate)) }));
    expect(duplicateResponse.status).toBe(400);
    expect(harness.createMediaStorage).not.toHaveBeenCalled();
  });

  it("rejects a divergent Content-Length and declared over-limit bodies", async () => {
    const data = await multipart(cmsForm());
    const mismatch = await cmsPost(
      uploadRequest({ ...data, contentLength: data.body.byteLength - 1 }),
    );
    expect(mismatch.status).toBe(400);
    const declared = await cmsPost(uploadRequest({ ...data, contentLength: 21 * 1024 * 1024 + 1 }));
    expect(declared.status).toBe(413);
    expect(harness.createMediaStorage).not.toHaveBeenCalled();
  });

  it("enforces actual bytes on chunked bodies without a length header", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(22 * 1024 * 1024));
        controller.close();
      },
    });
    const response = await cmsPost(
      uploadRequest({
        body,
        contentType: "multipart/form-data; boundary=a2",
        contentLength: null,
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large" });
    expect(harness.createMediaStorage).not.toHaveBeenCalled();
  });

  it("enforces per-file and aggregate spin limits before reading file bytes", async () => {
    const oversized = cmsForm();
    const data = await multipart(oversized);
    const size = vi.spyOn(File.prototype, "size", "get").mockReturnValue(20 * 1024 * 1024 + 1);
    try {
      const response = await cmsPost(uploadRequest({ ...data }));
      expect(response.status).toBe(413);
    } finally {
      size.mockRestore();
    }

    const spin = new FormData();
    spin.set("productId", productId);
    spin.set("variantId", "");
    spin.set("altText", "Secuencia");
    spin.set("mediaType", "SPIN_360");
    for (let index = 0; index < 4; index += 1) {
      spin.append("frames", new File([new Uint8Array([index])], `frame-${index}.png`));
    }
    const spinData = await multipart(spin);
    const spinSize = vi.spyOn(File.prototype, "size", "get").mockReturnValue(30 * 1024 * 1024);
    try {
      const response = await catalogPost(uploadRequest({ ...spinData }));
      expect(response.status).toBe(413);
      expect(harness.uploadSpin360).not.toHaveBeenCalled();
    } finally {
      spinSize.mockRestore();
    }
  });

  it("rejects more than 120 spin frames before opening R2", async () => {
    const form = new FormData();
    form.set("productId", productId);
    form.set("variantId", "");
    form.set("altText", "Secuencia");
    form.set("mediaType", "SPIN_360");
    for (let index = 0; index < 121; index += 1) {
      form.append("frames", new File([new Uint8Array([1])], `frame-${index}.png`));
    }
    const response = await catalogPost(uploadRequest({ ...(await multipart(form)) }));
    expect(response.status).toBe(400);
    expect(harness.createMediaStorage).not.toHaveBeenCalled();
  });

  it("makes retries safe through reused responses and suppresses repeat invalidation", async () => {
    const data = await multipart(cmsForm());
    const first = await cmsPost(uploadRequest({ ...data }));
    expect(first.status).toBe(201);
    harness.cmsUpload.mockResolvedValue({ media: { id: mediaId }, reused: true });
    const replay = await cmsPost(uploadRequest({ ...data }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, reused: true });
    expect(harness.revalidateTag).toHaveBeenCalledTimes(1);
  });

  it("returns generic failures and always destroys initialized storage", async () => {
    harness.uploadImage.mockRejectedValue(new Error("R2 secret endpoint and private key"));
    const response = await catalogPost(uploadRequest({ ...(await multipart(catalogForm())) }));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"ok":false,"error":"upload_failed"}');
    expect(text).not.toContain("private key");
    expect(harness.storageDestroy).toHaveBeenCalledOnce();
  });

  it("maps a transactionally revoked admin actor to forbidden without details", async () => {
    harness.uploadImage.mockRejectedValue(new AdminActorAuthorizationError());
    const response = await catalogPost(uploadRequest({ ...(await multipart(catalogForm())) }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "forbidden" });
    expect(harness.storageDestroy).toHaveBeenCalledOnce();
    expect(harness.revalidateTag).not.toHaveBeenCalled();
  });
});

describe("A2 — upload wiring and reduced Server Action body budget", () => {
  it("points both clients at Route Handlers with progress and double-submit locks", () => {
    const catalog = readFileSync("apps/web/components/admin/catalog-media-forms.tsx", "utf8");
    const cms = readFileSync("apps/web/components/admin/cms-forms.tsx", "utf8");
    expect(catalog).toContain('"/api/admin/catalog-media/upload"');
    expect(cms).toContain('"/api/admin/cms-media/upload"');
    for (const source of [catalog, cms]) {
      expect(source).toContain("submitting.current");
      expect(source).toContain("router.refresh()");
      expect(source).toContain("aria-live");
      expect(source).toContain("mfa_stale");
    }
    const actions =
      readFileSync("apps/web/lib/actions/admin-catalog.ts", "utf8") +
      readFileSync("apps/web/lib/actions/admin-cms.ts", "utf8");
    expect(actions).not.toContain("uploadCatalogMediaAction");
    expect(actions).not.toContain("uploadCmsMediaAction");
    expect(actions).not.toContain("arrayBuffer()");
  });

  it("expires every changed catalog and feed tag immediately in Route Handlers", () => {
    const revalidation = readFileSync("apps/web/lib/media-revalidation.ts", "utf8");
    for (const tag of [
      "catalog",
      "catalog:search",
      "catalog:compare",
      "catalog:cms-grid",
      "merchant-feed",
      "meta-catalog-feed",
      "sitemap",
      "cms:media",
    ]) {
      expect(revalidation).toContain(`revalidateTag("${tag}", { expire: 0 })`);
    }
    expect(revalidation).toContain("revalidateTag(`catalog:product:${slug}`, { expire: 0 })");
    expect(revalidation).not.toContain('"max"');
  });

  it("bounds remaining Server Actions at 5mb while retaining the 4,000,000-character RMA payload", () => {
    const config = readFileSync("apps/web/next.config.ts", "utf8");
    expect(config).toContain('bodySizeLimit: "5mb"');
    expect(config).not.toContain("110mb");
    const postsale = readFileSync("apps/web/lib/actions/postsale.ts", "utf8");
    expect(postsale).toContain("z.string().max(4_000_000)");
    expect(4_000_000).toBeLessThan(5 * 1024 * 1024);
  });

  it("maps AdminActorAuthorizationError to 403 forbidden in CMS media upload", async () => {
    harness.cmsUpload.mockRejectedValueOnce(new AdminActorAuthorizationError("Revoked CMS editor"));
    const form = new FormData();
    form.set("altText", "Banner editorial");
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "banner.png", { type: "image/png" }));
    const payload = await multipart(form);
    const response = await cmsPost(uploadRequest(payload));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "forbidden" });
    expect(harness.revalidateTag).not.toHaveBeenCalled();
  });
});
