import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelAccountError } from "../../packages/integrations/dist/index.js";
import { cookies } from "./next-headers-stub";
import { expectNoStoreNoIndex } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  completeOAuth: vi.fn(),
  getCookie: vi.fn(),
  getPublicSiteUrl: vi.fn(() => "https://mundonettech.co"),
  getRequestSecurityContext: vi.fn(),
  redirectUri: vi.fn(() => "https://mundonettech.co/api/channels/mercado-libre/oauth/callback"),
}));

vi.mock("@/lib/integrations", () => ({
  channelAccountService: () => ({ completeMercadoLibreOAuth: mocks.completeOAuth }),
  getPublicSiteUrl: mocks.getPublicSiteUrl,
  mercadoLibreOAuthRedirectUri: mocks.redirectUri,
}));
vi.mock("@/lib/security/request-context", () => ({
  getRequestSecurityContext: mocks.getRequestSecurityContext,
}));
vi.mock("@/lib/security/session-policy", () => ({
  channelOAuthCookie: "__Secure-mnt_channel_oauth",
  channelOAuthCookiePath: "/api/channels/mercado-libre/oauth/callback",
  channelOAuthCookieSecure: true,
}));

import * as oauthRoute from "../../apps/web/app/api/channels/mercado-libre/oauth/callback/route";

cookies.mockImplementation(async () => ({ get: mocks.getCookie }));

function channelAccountError(code: ConstructorParameters<typeof ChannelAccountError>[0]) {
  return new ChannelAccountError(code, "OAuth failed.");
}

const attemptId = "12345678-1234-4123-8123-123456789abc";
const state = "S".repeat(43);
const code = "authorization-code-123";

function callbackRequest(query = `state=${state}&code=${code}`): Promise<Response> {
  return oauthRoute.GET(
    new Request(`https://mundonettech.co/api/channels/mercado-libre/oauth/callback?${query}`),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCookie.mockReturnValue({ value: `${attemptId}.${state}` });
  mocks.completeOAuth.mockResolvedValue({ id: "channel-account-id" });
  mocks.getRequestSecurityContext.mockResolvedValue({
    ipHash: Uint8Array.from([1, 2, 3]),
    userAgentHash: Uint8Array.from([4, 5, 6]),
  });
});

describe("Mercado Libre OAuth callback", () => {
  it("binds cookie, attempt and state before completing PKCE server-side", async () => {
    const response = await callbackRequest();
    expect(response.status).toBe(200);
    expect(mocks.getCookie).toHaveBeenCalledWith("__Secure-mnt_channel_oauth");
    expect(mocks.completeOAuth).toHaveBeenCalledOnce();
    const input = mocks.completeOAuth.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      attemptId,
      state,
      code,
      redirectUri: "https://mundonettech.co/api/channels/mercado-libre/oauth/callback",
      audit: {
        ipHash: Uint8Array.from([1, 2, 3]),
        userAgentHash: Uint8Array.from([4, 5, 6]),
      },
    });
    expect(input.audit.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expectNoStoreNoIndex(response);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("https://mundonettech.co/admin/canales?oauth=connected");
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
  });

  it("expires the exact host cookie with all original attributes", async () => {
    const response = await callbackRequest();
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Secure-mnt_channel_oauth=;");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cookie).toContain("Path=/api/channels/mercado-libre/oauth/callback");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).not.toContain("Domain=");
  });

  it.each([
    { cookie: null, query: `state=${state}&code=${code}` },
    { cookie: `${attemptId}.${state}`, query: `state=${"T".repeat(43)}&code=${code}` },
    { cookie: `${attemptId}.${state}`, query: `state=short&code=${code}` },
    { cookie: `${attemptId}.${state}.`, query: `state=${state}&code=${code}` },
    { cookie: `not-a-uuid.${state}`, query: `state=${state}&code=${code}` },
    { cookie: `${attemptId}.${state}`, query: `code=${code}` },
    { cookie: `${attemptId}.${state}`, query: `state=${state}&state=${state}&code=${code}` },
    { cookie: `${attemptId}.${state}`, query: `state=${state}&code=${code}&code=other` },
    { cookie: `${attemptId}.${state}`, query: `state=${state}&error=denied&error=other` },
  ])(
    "rejects malformed, duplicated or mismatched state without service access",
    async (scenario) => {
      if (scenario.cookie === null) mocks.getCookie.mockReturnValue(undefined);
      else mocks.getCookie.mockReturnValue({ value: scenario.cookie });
      const response = await callbackRequest(scenario.query);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("oauth=replay");
      expect(mocks.completeOAuth).not.toHaveBeenCalled();
      expect(mocks.getRequestSecurityContext).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    },
  );

  it.each([
    ["OAUTH_EXPIRED", "expired"],
    ["OAUTH_REPLAY", "replay"],
    ["OAUTH_REJECTED", "denied"],
    ["FORBIDDEN", "forbidden"],
    ["CONFLICT", "conflict"],
    ["OAUTH_UNCERTAIN", "uncertain"],
  ] as const)("maps %s to a generic no-store outcome", async (errorCode, outcome) => {
    mocks.completeOAuth.mockRejectedValue(channelAccountError(errorCode));
    const response = await callbackRequest();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`oauth=${outcome}`);
    expectNoStoreNoIndex(response);
  });

  it("blocks a consumed callback as replay after the atomic service claim", async () => {
    mocks.completeOAuth
      .mockResolvedValueOnce({ id: "channel-account-id" })
      .mockRejectedValueOnce(channelAccountError("OAUTH_REPLAY"));
    const first = await callbackRequest();
    const replay = await callbackRequest();
    expect(await first.text()).toContain("oauth=connected");
    expect(await replay.text()).toContain("oauth=replay");
    expect(mocks.completeOAuth).toHaveBeenCalledTimes(2);
  });

  it("does not leak provider or internal error details", async () => {
    mocks.completeOAuth.mockRejectedValue(new Error("client_secret=super-secret"));
    const response = await callbackRequest();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("oauth=uncertain");
    expect(html).not.toContain("super-secret");
    expect(html).not.toContain("client_secret");
  });

  it("rejects HEAD and every mutation with Allow GET and no service access", async () => {
    const handlers = [
      ["HEAD", oauthRoute.HEAD],
      ["POST", oauthRoute.POST],
      ["PUT", oauthRoute.PUT],
      ["PATCH", oauthRoute.PATCH],
      ["DELETE", oauthRoute.DELETE],
      ["OPTIONS", oauthRoute.OPTIONS],
    ] as const;
    for (const [method, handler] of handlers) {
      const response = await handler();
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET");
      expect(response.headers.get("referrer-policy"), method).toBe("no-referrer");
      expectNoStoreNoIndex(response);
      if (method === "HEAD") expect(await response.text()).toBe("");
      else expect(await response.json()).toEqual({ error: "Method not allowed." });
    }
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(mocks.getCookie).not.toHaveBeenCalled();
  });
});
