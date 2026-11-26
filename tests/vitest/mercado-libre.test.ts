import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MercadoLibreOAuthClient,
  MercadoLibreProviderError,
  createMercadoLibreAuthorizationUrl,
  createMercadoLibrePkce,
  mercadoLibreAuthorizationUrl,
  mercadoLibreCallbackPath,
  parseMercadoLibreClientCredentials,
  parseMercadoLibrePendingCredential,
  parseMercadoLibreTokenCredential,
  resolveMercadoLibreOAuthCookiePolicy,
  serializeMercadoLibrePendingCredential,
  serializeMercadoLibreTokenCredential,
  type MercadoLibreTokenCredential,
} from "../../packages/integrations/dist/index.js";

const client = { clientId: "123456789012", clientSecret: "secret-test-only-1234567890" };
const redirectUri = "https://shop.example.test/api/channels/mercado-libre/oauth/callback";
const tokenCredential: MercadoLibreTokenCredential = {
  ...client,
  accessToken: "APP_USR-test-access-1234567890",
  refreshToken: "TG-test-refresh-1234567890",
  externalAccountId: "8035443",
  scopes: ["offline_access", "read", "write"],
};

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "APP_USR-test-new-access-1234567890",
    token_type: "bearer",
    expires_in: 21_600,
    scope: "offline_access read write",
    user_id: 8035443,
    refresh_token: "TG-test-new-refresh-1234567890",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("F6.1 — Mercado Libre PKCE and credential contracts", () => {
  it("creates independent S256 verifiers, challenges and hashed state", () => {
    const first = createMercadoLibrePkce();
    const second = createMercadoLibrePkce();
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(first.codeChallenge).toBe(
      createHash("sha256").update(first.codeVerifier).digest("base64url"),
    );
    expect(first.stateHash).toEqual(
      Uint8Array.from(createHash("sha256").update(first.state).digest()),
    );
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.state).not.toBe(second.state);
    expect(first.stateHash).toHaveLength(32);
  });

  it("builds the official MCO authorization URL without exposing the verifier", () => {
    const pkce = createMercadoLibrePkce();
    const url = new URL(
      createMercadoLibreAuthorizationUrl({
        clientId: client.clientId,
        redirectUri,
        state: pkce.state,
        codeChallenge: pkce.codeChallenge,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(mercadoLibreAuthorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state: pkce.state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      scope: "offline_access read write",
    });
    expect(url.toString()).not.toContain(pkce.codeVerifier);
  });

  it("rejects dynamic or insecure redirects and malformed PKCE values", () => {
    const pkce = createMercadoLibrePkce();
    for (const invalid of [
      "http://shop.example.test/callback",
      "https://shop.example.test/callback?next=changed",
      "https://user:pass@shop.example.test/callback",
      "https://shop.example.test/callback#fragment",
    ]) {
      expect(() =>
        createMercadoLibreAuthorizationUrl({
          clientId: client.clientId,
          redirectUri: invalid,
          state: pkce.state,
          codeChallenge: pkce.codeChallenge,
        }),
      ).toThrow(MercadoLibreProviderError);
    }
    expect(() =>
      createMercadoLibreAuthorizationUrl({
        clientId: client.clientId,
        redirectUri,
        state: "short",
        codeChallenge: pkce.codeChallenge,
      }),
    ).toThrow(MercadoLibreProviderError);
  });

  it("round-trips only encrypted pending and token credential payloads", () => {
    const pending = { ...client, codeVerifier: randomBytes(64).toString("base64url") };
    const pendingBytes = serializeMercadoLibrePendingCredential(pending);
    expect(parseMercadoLibrePendingCredential(pendingBytes)).toEqual(pending);
    const tokenBytes = serializeMercadoLibreTokenCredential(tokenCredential);
    expect(parseMercadoLibreTokenCredential(tokenBytes)).toEqual(tokenCredential);
    expect(new TextDecoder().decode(tokenBytes)).toContain(tokenCredential.accessToken);
    pendingBytes.fill(0);
    tokenBytes.fill(0);
  });

  it("rejects malformed, unexpected or insufficient credential payloads", () => {
    const valid = JSON.parse(
      new TextDecoder().decode(serializeMercadoLibreTokenCredential(tokenCredential)),
    );
    const invalidPayloads = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, scopes: ["read"] },
      { ...valid, scopes: ["offline_access", "read", "write", "admin"] },
      { ...valid, externalAccountId: "seller" },
      { ...valid, accessToken: "contains whitespace" },
      { ...valid, refreshToken: "short" },
    ];
    for (const payload of invalidPayloads) {
      expect(() =>
        parseMercadoLibreTokenCredential(new TextEncoder().encode(JSON.stringify(payload))),
      ).toThrow(MercadoLibreProviderError);
    }
    expect(() =>
      parseMercadoLibreClientCredentials({ clientId: "app", clientSecret: "12345678" }),
    ).toThrow(MercadoLibreProviderError);
  });

  it("accepts canonical Mercado Libre granular URN scopes alongside core scopes", () => {
    const granular = {
      ...tokenCredential,
      scopes: [
        "offline_access",
        "read",
        "write",
        "urn:ml:mktp:orders:read-write",
        "urn:ml:mktp:publish-sync:read-write",
      ],
    };
    const serialized = serializeMercadoLibreTokenCredential(granular);
    expect(parseMercadoLibreTokenCredential(serialized).scopes).toEqual([
      "offline_access",
      "read",
      "write",
      "urn:ml:mktp:orders:read-write",
      "urn:ml:mktp:publish-sync:read-write",
    ]);
    serialized.fill(0);
  });

  it("enforces RFC 6265bis __Secure- cookie prefix when path-scoped to OAuth callback in STG/PRD", () => {
    const localDev = resolveMercadoLibreOAuthCookiePolicy({
      NODE_ENV: "development",
      INTEGRATION_ENVIRONMENT: "LOCAL",
    });
    expect(localDev).toEqual({
      name: "mnt_channel_oauth",
      secure: false,
      path: mercadoLibreCallbackPath,
      httpOnly: true,
      sameSite: "lax",
    });
    const localStandalone = resolveMercadoLibreOAuthCookiePolicy({
      NODE_ENV: "production",
      INTEGRATION_ENVIRONMENT: "LOCAL",
    });
    expect(localStandalone.name).toBe("mnt_channel_oauth");
    expect(localStandalone.secure).toBe(false);
    for (const integrationEnv of ["STG", "PRD"]) {
      const policy = resolveMercadoLibreOAuthCookiePolicy({
        NODE_ENV: "production",
        INTEGRATION_ENVIRONMENT: integrationEnv,
      });
      expect(policy.name).toBe("__Secure-mnt_channel_oauth");
      expect(policy.secure).toBe(true);
      expect(policy.path).toBe(mercadoLibreCallbackPath);
      expect(policy.name.startsWith("__Host-") && String(policy.path) !== "/").toBe(false);
    }
  });
});

describe("F6.1 — Mercado Libre HTTP OAuth provider", () => {
  it("exchanges a code using a bounded form POST with PKCE and no URL secrets", async () => {
    const pkce = createMercadoLibrePkce();
    let requestUrl = "";
    let requestBody = "";
    const oauth = new MercadoLibreOAuthClient({
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = String(init?.body);
        return jsonResponse(tokenResponse());
      },
    });
    const result = await oauth.exchangeAuthorizationCode({
      credential: { ...client, codeVerifier: pkce.codeVerifier },
      code: "TG-test-authorization-code",
      redirectUri,
    });
    expect(result.externalAccountId).toBe("8035443");
    expect(result.clientId).toBe(client.clientId);
    const form = new URLSearchParams(requestBody);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: "TG-test-authorization-code",
      redirect_uri: redirectUri,
      code_verifier: pkce.codeVerifier,
    });
    expect(requestUrl).toBe("https://api.mercadolibre.com/oauth/token");
    expect(requestUrl).not.toContain(client.clientSecret);
    expect(requestUrl).not.toContain(pkce.codeVerifier);
  });

  it("refreshes with the latest single-use token and rejects a seller mismatch", async () => {
    let body = "";
    const oauth = new MercadoLibreOAuthClient({
      fetchImpl: async (_input, init) => {
        body = String(init?.body);
        return jsonResponse(tokenResponse());
      },
    });
    const tokens = await oauth.refresh(tokenCredential);
    expect(tokens.refreshToken).toBe("TG-test-new-refresh-1234567890");
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: "refresh_token",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: tokenCredential.refreshToken,
    });
    const mismatch = new MercadoLibreOAuthClient({
      fetchImpl: async () => jsonResponse(tokenResponse({ user_id: 999999 })),
    });
    await expect(mismatch.refresh(tokenCredential)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("classifies deterministic rejection separately from uncertain outcomes", async () => {
    const rejected = new MercadoLibreOAuthClient({
      fetchImpl: async () =>
        jsonResponse({ error: "invalid_grant", error_description: "secret" }, 400),
    });
    await expect(rejected.refresh(tokenCredential)).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
      providerCode: "invalid_grant",
    });
    const serverFailure = new MercadoLibreOAuthClient({
      fetchImpl: async () => jsonResponse({ error: "internal_error" }, 500),
    });
    await expect(serverFailure.refresh(tokenCredential)).rejects.toMatchObject({
      code: "PROVIDER_UNCERTAIN",
    });
    const networkFailure = new MercadoLibreOAuthClient({
      fetchImpl: async () => {
        throw new Error(`network ${client.clientSecret}`);
      },
    });
    const promise = networkFailure.refresh(tokenCredential);
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN" });
    await promise.catch((error: unknown) => {
      expect(error instanceof Error && error.message).not.toContain(client.clientSecret);
    });
  });

  it("rejects malformed successful responses and insufficient scopes", async () => {
    for (const body of [
      tokenResponse({ scope: "read write" }),
      tokenResponse({ expires_in: 10 }),
      tokenResponse({ token_type: "mac" }),
      tokenResponse({ user_id: "not-a-number" }),
      tokenResponse({ access_token: "white space" }),
    ]) {
      const oauth = new MercadoLibreOAuthClient({ fetchImpl: async () => jsonResponse(body) });
      await expect(oauth.refresh(tokenCredential)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
    const invalidJson = new MercadoLibreOAuthClient({
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    await expect(invalidJson.refresh(tokenCredential)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("revokes through the seller application endpoint with bearer authorization", async () => {
    let url = "";
    let method = "";
    let authorization = "";
    const oauth = new MercadoLibreOAuthClient({
      fetchImpl: async (input, init) => {
        url = String(input);
        method = init?.method ?? "";
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return jsonResponse({}, 200);
      },
    });
    await expect(oauth.revoke(tokenCredential)).resolves.toBe(true);
    expect(url).toBe(`https://api.mercadolibre.com/users/8035443/applications/${client.clientId}`);
    expect(method).toBe("DELETE");
    expect(authorization).toBe(`Bearer ${tokenCredential.accessToken}`);
    expect(url).not.toContain(tokenCredential.accessToken);
  });

  it("allows loopback token endpoints only when explicitly enabled for isolated tests", async () => {
    expect(
      () => new MercadoLibreOAuthClient({ tokenUrl: "http://127.0.0.1:54420/oauth/token" }),
    ).toThrow(MercadoLibreProviderError);
    expect(
      () =>
        new MercadoLibreOAuthClient({
          tokenUrl: "https://attacker.example/oauth/token",
          allowLoopback: true,
        }),
    ).toThrow(MercadoLibreProviderError);
    expect(
      () =>
        new MercadoLibreOAuthClient({
          tokenUrl: "http://127.0.0.1:54420/oauth/token",
          allowLoopback: true,
        }),
    ).not.toThrow();
  });
});

describe("A8 — fail-closed OAuth callback and refresh rotation", () => {
  it("accepts only the exact MCO callback path and canonical URL", () => {
    const pkce = createMercadoLibrePkce();
    for (const invalid of [
      "not-a-url",
      "https://shop.example.test/callback",
      "https://shop.example.test/api/channels/mercado-libre/oauth/callback/",
      "https://shop.example.test/api/channels/mercado-libre/oauth/callback?code=injected",
    ]) {
      expect(() =>
        createMercadoLibreAuthorizationUrl({
          clientId: client.clientId,
          redirectUri: invalid,
          state: pkce.state,
          codeChallenge: pkce.codeChallenge,
        }),
      ).toThrow(MercadoLibreProviderError);
    }
    expect(() =>
      createMercadoLibreAuthorizationUrl({
        clientId: client.clientId,
        redirectUri,
        state: pkce.state,
        codeChallenge: pkce.codeChallenge,
      }),
    ).not.toThrow();
  });

  it("rejects a successful refresh response that reuses the single-use refresh token", async () => {
    const oauth = new MercadoLibreOAuthClient({
      fetchImpl: async () =>
        jsonResponse(tokenResponse({ refresh_token: tokenCredential.refreshToken })),
    });
    await expect(oauth.refresh(tokenCredential)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects non-default ports and non-canonical fixture paths before network access", async () => {
    const fetchImpl = vi.fn();
    expect(
      () =>
        new MercadoLibreOAuthClient({
          tokenUrl: "https://api.mercadolibre.com:444/oauth/token",
          fetchImpl,
        }),
    ).toThrow(MercadoLibreProviderError);
    expect(
      () =>
        new MercadoLibreOAuthClient({
          tokenUrl: "http://127.0.0.1:54420/another-path",
          allowLoopback: true,
          fetchImpl,
        }),
    ).toThrow(MercadoLibreProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
