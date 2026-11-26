import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import * as core from "../../packages/core/dist/index.js";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const actorAdminUserId = "123e4567-e89b-42d3-a456-426614174000";
const accountName = "persona-privada@example.test";

class AdminAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdminAuthorizationError";
  }
}

interface PageModule {
  default(input?: { searchParams?: Promise<{ cursor?: string | string[] }> }): Promise<unknown>;
}

function loadPage(mocks: Record<string, unknown>): PageModule {
  const filename = fileURLToPath(
    new URL("../../apps/web/app/admin/(protected)/integraciones/page.tsx", import.meta.url),
  );
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const pageModule = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return webRequire(id) as unknown;
  };
  const context = createContext({
    ArrayBuffer,
    BigInt,
    Buffer,
    Date,
    Error,
    FormData,
    Headers,
    Intl,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    RangeError,
    RegExp,
    Set,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    Uint8Array,
    console,
    exports: pageModule.exports,
    module: pageModule,
    process,
    require: localRequire,
  });
  new Script(output, { filename }).runInContext(context);
  return pageModule.exports as unknown as PageModule;
}

function session() {
  return {
    profile: { id: actorAdminUserId, role: "FINANCE_ANALYST" },
    lastMfaAt: new Date(),
    supabase: { auth: { mfa: { listFactors: vi.fn() } } },
  };
}

function componentMocks() {
  const component = () => null;
  return {
    "@/components/admin/cms-step-up": { CmsStepUp: component },
    "@/components/admin/meta-capi-dashboard": { MetaCapiDashboard: component },
    "@/components/admin/meta-catalog-refresh-button": { MetaCatalogRefreshButton: component },
    "@/components/admin/operational-credential-form": { OperationalCredentialForm: component },
    "@/components/admin/integration-credential-forms": {
      CredentialRotationForm: component,
      ReencryptCredentialForm: component,
      RevokeCredentialForm: component,
      WompiCredentialWizard: component,
    },
    "next/link": { __esModule: true, default: component },
  };
}

describe("A2 — integrations page recent MFA and safe RSC", () => {
  it("renders only step-up and performs no integration reads when MFA is stale", async () => {
    const getIntegrationCredentialVault = vi.fn();
    const metaCapiService = vi.fn();
    const getMetaCatalogFeed = vi.fn();
    const getIntegrationEnvironment = vi.fn();
    const getAdminSession = vi.fn().mockRejectedValue(new AdminAuthorizationError("MFA_STALE"));
    const page = loadPage({
      "@mundonettech/core": core,
      ...componentMocks(),
      "@/lib/security/admin-auth": {
        AdminAuthorizationError,
        getAdminSession,
        requireAdminPage: vi.fn(async () => session()),
      },
      "@/lib/integrations": {
        getIntegrationCredentialVault,
        getIntegrationEnvironment,
        metaCapiService,
      },
      "@/lib/seo-data": { getMetaCatalogFeed },
    });
    const tree = await page.default();
    expect(JSON.stringify(tree)).toContain("Confirma tu autenticador");
    expect(getAdminSession).toHaveBeenCalledWith({
      permission: "integrations:read",
      requireRecentMfa: true,
    });
    expect(getIntegrationCredentialVault).not.toHaveBeenCalled();
    expect(metaCapiService).not.toHaveBeenCalled();
    expect(getMetaCatalogFeed).not.toHaveBeenCalled();
    expect(getIntegrationEnvironment).not.toHaveBeenCalled();
  });

  it("passes the active actor to both domain reads and never serializes accountName", async () => {
    const list = vi.fn(async () => ({
      items: [
        {
          id: "123e4567-e89b-42d3-a456-426614174001",
          provider: "meta",
          accountName,
          environment: "LOCAL",
          keyVersion: 1,
          createdAt: new Date("2026-11-24T12:00:00.000Z"),
          updatedAt: new Date("2026-11-24T12:00:00.000Z"),
          revokedAt: null,
        },
      ],
      nextCursor: null,
    }));
    const listEvents = vi.fn(async () => []);
    const getIntegrationCredentialVault = vi.fn(() => ({ list }));
    const metaCapiService = vi.fn(() => ({ listEvents }));
    const page = loadPage({
      "@mundonettech/core": core,
      ...componentMocks(),
      "@/lib/security/admin-auth": {
        AdminAuthorizationError,
        getAdminSession: vi.fn(async () => session()),
        requireAdminPage: vi.fn(async () => session()),
      },
      "@/lib/integrations": {
        getIntegrationCredentialVault,
        getIntegrationEnvironment: vi.fn(() => "LOCAL"),
        metaCapiService,
      },
      "@/lib/seo-data": {
        getMetaCatalogFeed: vi.fn(async () => ({ accepted: 0, issues: [] })),
      },
    });
    const tree = await page.default();
    const serialized = JSON.stringify(tree);
    expect(list).toHaveBeenCalledWith(actorAdminUserId, { includeRevoked: true, limit: 100 });
    expect(listEvents).toHaveBeenCalledWith(actorAdminUserId, 50);
    expect(serialized).not.toContain(accountName);
    expect(serialized).not.toContain("accountName");
    expect(serialized).toContain("123e4567-e89b-42d3-a456-426614174001");
  });

  it("passes the cursor to the domain and renders safe navigation beyond 100 credentials", async () => {
    const cursor = "123e4567-e89b-42d3-a456-426614174001";
    const nextCursor = "123e4567-e89b-42d3-a456-426614174002";
    const list = vi.fn(async () => ({
      items: [
        {
          id: "123e4567-e89b-42d3-a456-426614174003",
          provider: "meta",
          accountName,
          environment: "LOCAL",
          keyVersion: 1,
          createdAt: new Date("2026-11-24T12:00:00.000Z"),
          updatedAt: new Date("2026-11-24T12:00:00.000Z"),
          revokedAt: null,
        },
      ],
      nextCursor,
    }));
    const page = loadPage({
      "@mundonettech/core": core,
      ...componentMocks(),
      "@/lib/security/admin-auth": {
        AdminAuthorizationError,
        getAdminSession: vi.fn(async () => session()),
        requireAdminPage: vi.fn(async () => session()),
      },
      "@/lib/integrations": {
        getIntegrationCredentialVault: vi.fn(() => ({ list })),
        getIntegrationEnvironment: vi.fn(() => "LOCAL"),
        metaCapiService: vi.fn(() => ({ listEvents: vi.fn(async () => []) })),
      },
      "@/lib/seo-data": {
        getMetaCatalogFeed: vi.fn(async () => ({ accepted: 0, issues: [] })),
      },
    });

    const tree = await page.default({ searchParams: Promise.resolve({ cursor }) });
    const serialized = JSON.stringify(tree);
    expect(list).toHaveBeenCalledWith(actorAdminUserId, {
      includeRevoked: true,
      limit: 100,
      cursor,
    });
    expect(serialized).toContain("Primera página");
    expect(serialized).toContain("Siguiente página");
    expect(serialized).toContain(`/admin/integraciones?cursor=${nextCursor}`);
    expect(serialized).not.toContain(accountName);
    expect(serialized).not.toContain("accountName");
  });
});

describe("A2 — channel request stability across RSC refreshes", () => {
  it("pins ledger version and idempotency key to the original client request", () => {
    const filename = fileURLToPath(
      new URL("../../apps/web/components/admin/channel-order-actions.tsx", import.meta.url),
    );
    const source = readFileSync(filename, "utf8");
    expect(source).toContain("const [adjustmentRequest] = useState(() => ({");
    expect(source).toContain("expectedVersion: order.version");
    expect(source).toContain("idempotencyKey: adjustmentIdempotencyKey");
    expect(source).toContain("value={adjustmentRequest.expectedVersion}");
    expect(source).toContain('name="idempotencyKey"');
    expect(source).toContain("value={adjustmentRequest.idempotencyKey}");
  });

  it("pins offer optimistic version to the original client request", () => {
    const filename = fileURLToPath(
      new URL("../../apps/web/components/admin/channel-catalog-forms.tsx", import.meta.url),
    );
    const source = readFileSync(filename, "utf8");
    expect(source).toContain("const [expectedVersion] = useState(offer.version);");
    expect(source).toContain('name="version" value={expectedVersion}');
  });
});

describe("A5 — DIAN trust anchor wizard", () => {
  it("exposes the X.509 trust anchor as a multiline field required only in PRD", () => {
    const filename = fileURLToPath(
      new URL("../../apps/web/components/admin/operational-credential-form.tsx", import.meta.url),
    );
    const source = readFileSync(filename, "utf8");
    expect(source).toContain('name: "signatureTrustAnchorPem"');
    expect(source).toContain("Certificado X.509 del firmante");
    expect(source).toContain("multiline: true");
    expect(source).toContain('field.name === "signatureTrustAnchorPem"');
    expect(source).toContain('environment === "PRD"');
    expect(source).toContain("<textarea");
  });
});

describe("A8 — credential form progress and repeated success", () => {
  it("re-arms the Wompi success view for every new submission and exposes pending states", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../apps/web/components/admin/integration-credential-forms.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(source).toContain("setDismissSuccess(false);");
    expect(source).toContain("encrypt(event.currentTarget);");
    expect(source).toContain('pending ? "Recifrando…"');
    expect(source).toContain('pending ? "Revocando…"');
    expect(source.match(/aria-busy=\{pending\}/g)).toHaveLength(2);
  });
});
