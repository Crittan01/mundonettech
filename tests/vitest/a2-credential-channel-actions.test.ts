import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createXmlDsigSigner } from "../helpers/xml-dsig-fixtures.mjs";
import { describe, expect, it, vi } from "vitest";

import * as integrations from "../../packages/integrations/dist/index.js";
import {
  ChannelAccountError,
  CredentialRevokedError,
} from "../../packages/integrations/dist/index.js";
import {
  actionError,
  actionSuccess,
  formString,
  type ActionState,
} from "../../apps/web/lib/action-state";
import { loadActionModule } from "./a2-action-loader";

const previous: ActionState = { status: "idle", message: "" };
const actorAdminUserId = randomUUID();
const credentialId = randomUUID();
const accountId = randomUUID();
const ipHash = createHash("sha256").update("a2-ip").digest();
const userAgentHash = createHash("sha256").update("a2-user-agent").digest();
const clientSecret = "a2-client-secret-must-not-leak-123456";
const privateKey = "prv_test_A2PRIVATEKEYMUSTNOTLEAK123456";
const originEmail = "operador-privado@example.test";
const dianSigner = createXmlDsigSigner("DIAN Credential Action Signer");

class AdminAuthorizationError extends Error {
  constructor(
    readonly code: "NO_SESSION" | "NO_PROFILE" | "AAL1" | "TIMEOUT" | "FORBIDDEN" | "MFA_STALE",
  ) {
    super(code);
    this.name = "AdminAuthorizationError";
  }
}

type FormAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
type ChannelActionState = ActionState & { authorizationUrl?: string };
type ChannelStartAction = (
  previous: ChannelActionState,
  formData: FormData,
) => Promise<ChannelActionState>;

interface VaultWriteOptions {
  provider: string;
  accountName: string;
  plaintext: Uint8Array;
  actorAdminUserId: string;
  audit: {
    requestId: string;
    ipHash: Uint8Array;
    userAgentHash?: Uint8Array | null;
  };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

function sensitiveForm(): FormData {
  return form({
    accountName: "Cuenta operativa A2",
    credentialId,
    accountId,
    confirmation: "REVOCAR",
    provider: "meta",
    label: "Mercado Libre principal",
    clientId: "123456789012",
    clientSecret,
    publicKey: "pub_test_A2PUBLICKEYMUSTNOTLEAK123456",
    privateKey,
    integritySecret: "test_integrity_A2INTEGRITYMUSTNOTLEAK123456",
    eventsSecret: "test_events_A2EVENTSMUSTNOTLEAK123456",
    accessToken: "a2-access-token-must-not-leak",
    originEmail,
    unexpectedSecret: "a2-unknown-field-must-not-leak",
  });
}

function baseMocks(role = "SUPERADMIN") {
  const getAdminSession = vi.fn(async () => ({ profile: { id: actorAdminUserId, role } }));
  const getRequestSecurityContext = vi.fn(async () => ({ ipHash, userAgentHash }));
  const revalidatePath = vi.fn();
  const updateTag = vi.fn();
  const getIntegrationEnvironment = vi.fn(() => "LOCAL");
  const getIntegrationCredentialVault = vi.fn();
  const channelAccountService = vi.fn();
  const channelCatalogService = vi.fn();
  const channelOrderService = vi.fn();
  const metaCapiService = vi.fn();
  const cookieSet = vi.fn();
  const cookies = vi.fn(async () => ({ set: cookieSet }));
  const mocks: Record<string, unknown> = {
    "@mundonettech/integrations": integrations,
    "@/lib/action-state": { actionError, actionSuccess, formString },
    "@/lib/security/admin-auth": { AdminAuthorizationError, getAdminSession },
    "@/lib/security/request-context": { getRequestSecurityContext },
    "@/lib/security/session-policy": {
      channelOAuthCookie: "mnt_channel_oauth",
      channelOAuthCookiePath: "/api/channels/mercado-libre/oauth/callback",
      channelOAuthCookieSecure: false,
    },
    "@/lib/integrations": {
      getIntegrationEnvironment,
      getIntegrationCredentialVault,
      channelAccountService,
      channelCatalogService,
      channelOrderService,
      metaCapiService,
      mercadoLibreOAuthRedirectUri: () =>
        "http://127.0.0.1:4010/api/channels/mercado-libre/oauth/callback",
    },
    "next/cache": { revalidatePath, updateTag },
    "next/headers": { cookies },
  };
  return {
    mocks,
    getAdminSession,
    getRequestSecurityContext,
    revalidatePath,
    updateTag,
    getIntegrationEnvironment,
    getIntegrationCredentialVault,
    channelAccountService,
    cookieSet,
    cookies,
  };
}

const actionCases = [
  ["admin-integrations", "createWompiCredentialAction"],
  ["admin-integrations", "rotateWompiCredentialAction"],
  ["admin-integrations", "reencryptCredentialAction"],
  ["admin-integrations", "revokeCredentialAction"],
  ["admin-operational-credentials", "createOperationalCredentialAction"],
  ["admin-operational-credentials", "rotateOperationalCredentialAction"],
  ["admin-channels", "startMercadoLibreConnectionAction"],
  ["admin-channels", "refreshChannelAccountAction"],
  ["admin-channels", "disconnectChannelAccountAction"],
] as const;

describe("A2 — credential and OAuth action authorization", () => {
  it.each(actionCases)(
    "%s.%s rejects stale MFA, insufficient role and missing session before effects",
    async (file, name) => {
      for (const code of ["MFA_STALE", "FORBIDDEN", "NO_SESSION"] as const) {
        const base = baseMocks();
        base.getAdminSession.mockRejectedValue(new AdminAuthorizationError(code));
        const actionModule = loadActionModule<Record<string, FormAction>>(file, base.mocks);
        const state = await actionModule[name]!(previous, sensitiveForm());
        const serialized = JSON.stringify(state);
        expect(state.status).toBe("error");
        expect(serialized).not.toContain(clientSecret);
        expect(serialized).not.toContain(privateKey);
        expect(serialized).not.toContain(originEmail);
        expect(serialized).not.toContain("a2-unknown-field-must-not-leak");
        expect(base.getAdminSession).toHaveBeenCalledWith({
          permission: "integrations:write",
          requireRecentMfa: true,
        });
        expect(base.getIntegrationCredentialVault).not.toHaveBeenCalled();
        expect(base.channelAccountService).not.toHaveBeenCalled();
        expect(base.revalidatePath).not.toHaveBeenCalled();
        expect(base.cookies).not.toHaveBeenCalled();
      }
    },
  );
});

function wompiValues(): Record<string, string> {
  return {
    accountName: "Wompi principal",
    publicKey: "pub_test_A2PUBLICKEYVALID1234567890",
    privateKey: "prv_test_A2PRIVATEKEYVALID1234567890",
    integritySecret: "test_integrity_A2INTEGRITYVALID1234567890",
    eventsSecret: "test_events_A2EVENTSVALID1234567890",
  };
}

describe("A2 — Wompi vault boundaries", () => {
  it("creates and rotates sealed credentials, zeroizes plaintext and omits account/key material from RSC", async () => {
    const base = baseMocks();
    const writes: Uint8Array[] = [];
    const create = vi.fn(async (options: VaultWriteOptions) => {
      writes.push(options.plaintext);
      return { accountName: options.accountName };
    });
    const rotate = vi.fn(async (options: { credentialId: string; plaintext: Uint8Array }) => {
      writes.push(options.plaintext);
      return { accountName: "Wompi principal" };
    });
    const list = vi.fn(async () => ({
      items: [
        {
          id: credentialId,
          provider: "wompi",
          accountName: "Wompi principal",
        },
      ],
      nextCursor: null,
    }));
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ create, rotate, list })),
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-integrations", base.mocks);

    const created = await actions.createWompiCredentialAction!(previous, form(wompiValues()));
    expect(created.status).toBe("success");
    expect(JSON.stringify(created)).not.toContain("Wompi principal");
    expect(JSON.stringify(created)).not.toContain(wompiValues().publicKey);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "wompi",
        actorAdminUserId,
        audit: expect.objectContaining({ ipHash, userAgentHash }),
      }),
    );

    const rotated = await actions.rotateWompiCredentialAction!(
      previous,
      form({ ...wompiValues(), credentialId }),
    );
    expect(rotated.status).toBe("success");
    expect(JSON.stringify(rotated)).not.toContain("Wompi principal");
    expect(rotate).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId, actorAdminUserId }),
    );
    expect(writes).toHaveLength(2);
    for (const plaintext of writes) {
      expect(plaintext.length).toBeGreaterThan(0);
      expect(plaintext.every((value) => value === 0)).toBe(true);
    }
  });

  it("does not return public or secret key material on validation and replay failures", async () => {
    const base = baseMocks();
    const create = vi.fn();
    const revoke = vi.fn().mockRejectedValue(new CredentialRevokedError());
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ create, revoke })),
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-integrations", base.mocks);
    const invalid = await actions.createWompiCredentialAction!(
      previous,
      form({ ...wompiValues(), publicKey: privateKey }),
    );
    expect(invalid.status).toBe("error");
    expect(invalid.values).toBeUndefined();
    expect(JSON.stringify(invalid)).not.toContain(privateKey);
    expect(create).not.toHaveBeenCalled();

    const replay = await actions.revokeCredentialAction!(
      previous,
      form({ ...wompiValues(), credentialId, confirmation: "REVOCAR" }),
    );
    expect(replay.status).toBe("error");
    expect(replay.values).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain(privateKey);
    expect(base.revalidatePath).not.toHaveBeenCalled();
  });

  it("reencrypts and revokes with request hashes and no credential state", async () => {
    const base = baseMocks();
    const reencryptWithActiveKey = vi.fn(async () => ({}));
    const revoke = vi.fn(async () => ({}));
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ reencryptWithActiveKey, revoke })),
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-integrations", base.mocks);
    expect(
      (await actions.reencryptCredentialAction!(previous, form({ credentialId }))).status,
    ).toBe("success");
    expect(
      (
        await actions.revokeCredentialAction!(
          previous,
          form({ credentialId, confirmation: "REVOCAR" }),
        )
      ).status,
    ).toBe("success");
    expect(reencryptWithActiveKey).toHaveBeenCalledWith(
      credentialId,
      actorAdminUserId,
      expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
    );
    expect(revoke).toHaveBeenCalledWith(
      credentialId,
      actorAdminUserId,
      expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
    );
  });
});

function operationalValues(provider: string): Record<string, string> {
  const common = { provider, accountName: `${provider} operativo` };
  if (provider === "aveonline") {
    return {
      ...common,
      username: "integration-user",
      password: "a-secure-password",
      companyId: "6077",
      companyCode: "company-code",
      companyDocument: "9010000001",
      originLegalName: "Operador logístico de pruebas",
      originEmail,
      agentId: "2600",
      carrierId: "29",
      authUrl: "https://app.aveonline.co/api/comunes/v1.0/autenticarusuario.php",
      labelsUrl: "https://app.aveonline.co/api/nacional/v1.0/generarGuia2.php",
      lookupUrl:
        "https://app.aveonline.co/api/nacional/v1.0/consultarGuia.php?dsreferencia={requestKey}",
    };
  }
  if (provider === "resend") {
    return {
      ...common,
      apiKey: "re_test_1234567890abcdef",
      fromEmail: "ventas@example.test",
      fromName: "Tienda de pruebas",
      replyTo: "",
      svixSecret: "whsec_12345678901234567890123456789012",
      unsubscribeSecret: Buffer.from("another-secure-secret-with-32-bytes").toString("base64"),
      apiUrl: "https://api.resend.com/emails",
    };
  }
  if (provider === "meta") {
    return {
      ...common,
      pixelId: "123456789012345",
      accessToken: randomBytes(32).toString("hex"),
      testEventCode: "",
    };
  }
  if (provider === "gemini") {
    return {
      ...common,
      apiKey: "a2-gemini-key-12345678901234567890",
      model: "gemini-2.5-flash",
      apiUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    };
  }
  return {
    ...common,
    bearerToken: "a-secure-provider-token-123456",
    providerUrl: "https://fiscal.example.test",
    issuerNit: "9010000001",
    issuerDv: "1",
    issuerLegalName: "Emisor de Prueba",
    issuerEmail: "fiscal@example.test",
    issuerAddress: "Carrera 7 # 71-21",
    issuerDepartmentCode: "11",
    issuerDepartmentName: "Bogotá, D.C.",
    issuerMunicipalityCode: "11001",
    issuerMunicipalityName: "Bogotá, D.C.",
    issuerPostalCode: "110231",
    issuerPhoneE164: "+573001234567",
    softwareId: "software-1234",
    softwarePin: "software-secret-pin",
    signatureTrustAnchorPem: dianSigner.certificate,
    invoicePrefix: "FE",
    invoiceResolutionNumber: "18760000001",
    invoiceResolutionStart: "1",
    invoiceResolutionEnd: "1000",
    invoiceResolutionDate: "2026-01-01",
    invoiceResolutionValidFrom: "2026-01-01",
    invoiceResolutionValidTo: "2027-12-31",
    creditNotePrefix: "NC",
  };
}

describe("A2 — operational credential closed contracts", () => {
  it.each(["aveonline", "resend", "meta", "gemini", "dian"])(
    "validates and seals every %s payload without returning credentials or PII",
    async (provider) => {
      const base = baseMocks();
      let plaintext: Uint8Array | undefined;
      let sealedPayload: Record<string, unknown> | undefined;
      const create = vi.fn(async (options: VaultWriteOptions) => {
        sealedPayload = JSON.parse(new TextDecoder().decode(options.plaintext)) as Record<
          string,
          unknown
        >;
        plaintext = options.plaintext;
        return { accountName: options.accountName };
      });
      base.mocks["@/lib/integrations"] = {
        getIntegrationEnvironment: base.getIntegrationEnvironment,
        getIntegrationCredentialVault: vi.fn(() => ({ create })),
      };
      const actions = loadActionModule<Record<string, FormAction>>(
        "admin-operational-credentials",
        base.mocks,
      );
      const values = operationalValues(provider);
      const state = await actions.createOperationalCredentialAction!(previous, form(values));
      expect(state.status).toBe("success");
      expect(state.values).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain(values.accountName!);
      expect(JSON.stringify(state)).not.toContain(originEmail);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          actorAdminUserId,
          audit: expect.objectContaining({ ipHash, userAgentHash }),
        }),
      );
      expect(plaintext?.every((value) => value === 0)).toBe(true);
      if (provider === "dian") {
        expect(sealedPayload?.signatureTrustAnchorPem).toBe(dianSigner.certificate);
        expect(JSON.stringify(state)).not.toContain(dianSigner.certificate);
      }
    },
  );

  it("returns only the provider after provider validation failure, never PII or unknown fields", async () => {
    const base = baseMocks();
    const create = vi.fn();
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ create })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-operational-credentials",
      base.mocks,
    );
    const values = {
      ...operationalValues("resend"),
      fromEmail: "not-an-email",
      clientSecret,
      unexpectedSecret: "a2-extra-secret",
    };
    const state = await actions.createOperationalCredentialAction!(previous, form(values));
    expect(state.status).toBe("error");
    expect(state.values).toEqual({ provider: "resend" });
    expect(JSON.stringify(state)).not.toContain(originEmail);
    expect(JSON.stringify(state)).not.toContain(values.fromEmail);
    expect(JSON.stringify(state)).not.toContain("re_test_1234567890abcdef");
    expect(JSON.stringify(state)).not.toContain("Tienda de pruebas");
    expect(JSON.stringify(state)).not.toContain(clientSecret);
    expect(JSON.stringify(state)).not.toContain(values.unexpectedSecret);
    expect(create).not.toHaveBeenCalled();
  });

  it("rotates only the matching provider account and zeroizes the replacement secret", async () => {
    const base = baseMocks();
    let plaintext: Uint8Array | undefined;
    const values = operationalValues("meta");
    const list = vi.fn(async () => ({
      items: [
        {
          id: credentialId,
          provider: "meta",
          accountName: values.accountName!,
        },
      ],
      nextCursor: null,
    }));
    const rotate = vi.fn(async (options: { plaintext: Uint8Array }) => {
      plaintext = options.plaintext;
      return {};
    });
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ list, rotate })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-operational-credentials",
      base.mocks,
    );
    const state = await actions.rotateOperationalCredentialAction!(
      previous,
      form({ ...values, credentialId }),
    );
    expect(state.status).toBe("success");
    expect(state.values).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(values.accountName!);
    expect(JSON.stringify(state)).not.toContain(values.accessToken!);
    expect(rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId,
        actorAdminUserId,
        audit: expect.objectContaining({ ipHash, userAgentHash }),
      }),
    );
    expect(plaintext?.every((value) => value === 0)).toBe(true);
  });

  it("requires a DIAN trust anchor in PRD and rejects invalid PEM without logging it", async () => {
    for (const signatureTrustAnchorPem of ["", "not-a-certificate"]) {
      const base = baseMocks();
      base.getIntegrationEnvironment.mockReturnValue("PRD");
      const create = vi.fn();
      base.mocks["@/lib/integrations"] = {
        getIntegrationEnvironment: base.getIntegrationEnvironment,
        getIntegrationCredentialVault: vi.fn(() => ({ create })),
      };
      const actions = loadActionModule<Record<string, FormAction>>(
        "admin-operational-credentials",
        base.mocks,
      );
      const state = await actions.createOperationalCredentialAction!(
        previous,
        form({ ...operationalValues("dian"), signatureTrustAnchorPem }),
      );
      expect(state.status).toBe("error");
      expect(state.values).toEqual({ provider: "dian" });
      expect(JSON.stringify(state)).not.toContain(dianSigner.certificate);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("keeps legacy LOCAL credentials without an anchor and zeroizes their sealed payload", async () => {
    const base = baseMocks();
    let sealedPayload: Record<string, unknown> | undefined;
    let plaintext: Uint8Array | undefined;
    const create = vi.fn(async (options: VaultWriteOptions) => {
      sealedPayload = JSON.parse(new TextDecoder().decode(options.plaintext)) as Record<
        string,
        unknown
      >;
      plaintext = options.plaintext;
      return { accountName: options.accountName };
    });
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ create })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-operational-credentials",
      base.mocks,
    );
    const state = await actions.createOperationalCredentialAction!(
      previous,
      form({ ...operationalValues("dian"), signatureTrustAnchorPem: "" }),
    );
    expect(state.status).toBe("success");
    expect(sealedPayload?.signatureTrustAnchorPem).toBeNull();
    expect(plaintext?.every((value) => value === 0)).toBe(true);
  });

  it("bounds DIAN integer fields before persistence", async () => {
    const base = baseMocks();
    const create = vi.fn();
    base.mocks["@/lib/integrations"] = {
      getIntegrationEnvironment: base.getIntegrationEnvironment,
      getIntegrationCredentialVault: vi.fn(() => ({ create })),
    };
    const actions = loadActionModule<Record<string, FormAction>>(
      "admin-operational-credentials",
      base.mocks,
    );
    const state = await actions.createOperationalCredentialAction!(
      previous,
      form({ ...operationalValues("dian"), invoiceResolutionStart: "999999999999999999999" }),
    );
    expect(state.status).toBe("error");
    expect(state.values).toEqual({ provider: "dian" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("A2 — Mercado Libre OAuth action wiring", () => {
  it("sets the bounded OAuth cookie and returns only the provider authorization URL", async () => {
    const base = baseMocks();
    const attemptId = randomUUID();
    const stateValue = randomBytes(32).toString("base64url");
    const authorizationUrl = `https://auth.mercadolibre.com.co/authorization?response_type=code&client_id=123456789012&state=${stateValue}&code_challenge=challenge&code_challenge_method=S256`;
    const startMercadoLibreOAuth = vi.fn(async () => ({
      attemptId,
      state: stateValue,
      authorizationUrl,
      expiresAt: new Date(),
    }));
    base.mocks["@/lib/integrations"] = {
      channelAccountService: vi.fn(() => ({
        startMercadoLibreOAuth,
      })),
      mercadoLibreOAuthRedirectUri: () =>
        "http://127.0.0.1:4010/api/channels/mercado-libre/oauth/callback",
    };
    const actions = loadActionModule<Record<string, ChannelStartAction>>(
      "admin-channels",
      base.mocks,
    );
    const result = await actions.startMercadoLibreConnectionAction!(
      previous,
      form({
        accountId: "",
        label: "Mercado Libre principal",
        clientId: "123456789012",
        clientSecret,
      }),
    );
    expect(result.status).toBe("success");
    expect(result.authorizationUrl).toBe(authorizationUrl);
    expect(JSON.stringify(result)).not.toContain(clientSecret);
    expect(JSON.stringify(result)).not.toContain("codeVerifier");
    expect(startMercadoLibreOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret,
        audit: expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      }),
    );
    expect(base.cookieSet).toHaveBeenCalledWith(
      "mnt_channel_oauth",
      `${attemptId}.${stateValue}`,
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/api/channels/mercado-libre/oauth/callback",
        maxAge: 600,
      }),
    );
  });

  it("redacts provider failures and keeps replays idempotent at the action boundary", async () => {
    const base = baseMocks();
    const startMercadoLibreOAuth = vi
      .fn()
      .mockRejectedValue(new Error(`provider leaked ${clientSecret}`));
    const disconnectAccount = vi.fn(async () => ({
      accountId,
      alreadyDisconnected: true,
      remoteRevoked: false,
    }));
    const refreshAccount = vi.fn(async () => ({
      accountId,
      status: "REFRESHED",
      tokenExpiresAt: new Date(),
    }));
    base.mocks["@/lib/integrations"] = {
      channelAccountService: vi.fn(() => ({
        startMercadoLibreOAuth,
        disconnectAccount,
        refreshAccount,
      })),
      mercadoLibreOAuthRedirectUri: () =>
        "http://127.0.0.1:4010/api/channels/mercado-libre/oauth/callback",
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-channels", base.mocks);
    const failed = await actions.startMercadoLibreConnectionAction!(
      previous,
      form({
        accountId: "",
        label: "Nombre con PII persona@example.test",
        clientId: "123456789012",
        clientSecret,
      }),
    );
    expect(failed.status).toBe("error");
    expect(failed.values).toEqual({ accountId: "", clientId: "123456789012" });
    expect(JSON.stringify(failed)).not.toContain(clientSecret);
    expect(JSON.stringify(failed)).not.toContain("persona@example.test");
    expect(JSON.stringify(failed)).not.toContain("provider leaked");
    expect(base.cookieSet).not.toHaveBeenCalled();

    const disconnected = await actions.disconnectChannelAccountAction!(
      previous,
      form({ accountId, confirmation: "DESVINCULAR" }),
    );
    expect(disconnected).toMatchObject({ status: "success" });
    expect(disconnected.message).toContain("ya estaba desvinculada");
    expect((await actions.refreshChannelAccountAction!(previous, form({ accountId }))).status).toBe(
      "success",
    );
    expect(refreshAccount).toHaveBeenCalledWith(
      accountId,
      expect.objectContaining({ actorAdminUserId, ipHash, userAgentHash }),
      { force: true },
    );
  });

  it("maps domain conflicts without exposing provider messages", async () => {
    const base = baseMocks();
    const refreshAccount = vi
      .fn()
      .mockRejectedValue(new ChannelAccountError("CONFLICT", `secret ${clientSecret}`));
    base.mocks["@/lib/integrations"] = {
      channelAccountService: vi.fn(() => ({ refreshAccount })),
    };
    const actions = loadActionModule<Record<string, FormAction>>("admin-channels", base.mocks);
    const state = await actions.refreshChannelAccountAction!(previous, form({ accountId }));
    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).not.toContain(clientSecret);
    expect(base.revalidatePath).not.toHaveBeenCalled();
  });
});
