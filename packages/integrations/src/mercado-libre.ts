import { createHash, randomBytes } from "node:crypto";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";

export const mercadoLibreAuthorizationUrl = "https://auth.mercadolibre.com.co/authorization";
const mercadoLibreTokenUrl = "https://api.mercadolibre.com/oauth/token";
const mercadoLibreScopes = ["offline_access", "read", "write"] as const;
export const mercadoLibreCallbackPath = "/api/channels/mercado-libre/oauth/callback";

export function resolveMercadoLibreOAuthCookiePolicy(env: {
  readonly NODE_ENV?: string | undefined;
  readonly INTEGRATION_ENVIRONMENT?: string | undefined;
}): {
  readonly name: "__Secure-mnt_channel_oauth" | "mnt_channel_oauth";
  readonly secure: boolean;
  readonly path: typeof mercadoLibreCallbackPath;
  readonly httpOnly: true;
  readonly sameSite: "lax";
} {
  const secure = env.NODE_ENV === "production" && env.INTEGRATION_ENVIRONMENT !== "LOCAL";
  return {
    name: secure ? "__Secure-mnt_channel_oauth" : "mnt_channel_oauth",
    secure,
    path: mercadoLibreCallbackPath,
    httpOnly: true,
    sameSite: "lax",
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type MercadoLibreProviderErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CREDENTIALS"
  | "INVALID_RESPONSE"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNCERTAIN";

export class MercadoLibreProviderError extends Error {
  constructor(
    readonly code: MercadoLibreProviderErrorCode,
    readonly providerCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "MercadoLibreProviderError";
  }
}

export interface MercadoLibreClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MercadoLibrePendingCredential extends MercadoLibreClientCredentials {
  readonly codeVerifier: string;
}

export interface MercadoLibreTokenCredential extends MercadoLibreClientCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly externalAccountId: string;
  readonly scopes: readonly string[];
}

export interface MercadoLibreTokenSet extends MercadoLibreTokenCredential {
  readonly expiresInSeconds: number;
}

export interface MercadoLibreClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenUrl?: string;
  readonly allowLoopback?: boolean;
}

function exactKeys(root: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(root).sort();
  if (actual.join(",") !== [...expected].sort().join(",")) throw new Error("Unexpected fields.");
}

function secret(value: unknown, minimum = 8, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /\s|[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Invalid secret.");
  }
  return value;
}

export function parseMercadoLibreClientCredentials(input: {
  readonly clientId: string;
  readonly clientSecret: string;
}): MercadoLibreClientCredentials {
  if (!/^[0-9]{5,64}$/.test(input.clientId)) {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "Mercado Libre client_id must be a numeric application identifier.",
    );
  }
  try {
    return { clientId: input.clientId, clientSecret: secret(input.clientSecret, 8, 255) };
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "Mercado Libre client_secret does not meet the credential contract.",
    );
  }
}

function clientFromJson(root: Record<string, unknown>): MercadoLibreClientCredentials {
  const clientId = root.clientId;
  const clientSecret = root.clientSecret;
  if (typeof clientId !== "string" || typeof clientSecret !== "string") throw new Error();
  return parseMercadoLibreClientCredentials({ clientId, clientSecret });
}

function parseJson(plaintext: Uint8Array): Record<string, unknown> {
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0 || plaintext.length > 65_536) {
    throw new Error();
  }
  const parsed: unknown = JSON.parse(decoder.decode(plaintext));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
  return parsed as Record<string, unknown>;
}

export function serializeMercadoLibrePendingCredential(
  credential: MercadoLibrePendingCredential,
): Uint8Array<ArrayBuffer> {
  parseMercadoLibreClientCredentials(credential);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(credential.codeVerifier)) {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "The PKCE verifier does not meet RFC 7636.",
    );
  }
  return Uint8Array.from(
    encoder.encode(
      JSON.stringify({
        kind: "MERCADO_LIBRE_OAUTH_PENDING",
        version: 1,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        codeVerifier: credential.codeVerifier,
      }),
    ),
  );
}

export function parseMercadoLibrePendingCredential(
  plaintext: Uint8Array,
): MercadoLibrePendingCredential {
  try {
    const root = parseJson(plaintext);
    exactKeys(root, ["kind", "version", "clientId", "clientSecret", "codeVerifier"]);
    if (root.kind !== "MERCADO_LIBRE_OAUTH_PENDING" || root.version !== 1) throw new Error();
    const client = clientFromJson(root);
    const codeVerifier = root.codeVerifier;
    if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) {
      throw new Error();
    }
    return { ...client, codeVerifier };
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_CREDENTIALS",
      null,
      "The encrypted Mercado Libre OAuth credential is invalid.",
    );
  }
}

export function serializeMercadoLibreTokenCredential(
  credential: MercadoLibreTokenCredential,
): Uint8Array<ArrayBuffer> {
  parseMercadoLibreClientCredentials(credential);
  secret(credential.accessToken);
  secret(credential.refreshToken);
  externalAccountId(credential.externalAccountId);
  scopes(credential.scopes.join(" "));
  return Uint8Array.from(
    encoder.encode(
      JSON.stringify({
        kind: "MERCADO_LIBRE_TOKENS",
        version: 1,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        externalAccountId: credential.externalAccountId,
        scopes: [...credential.scopes],
      }),
    ),
  );
}

export function parseMercadoLibreTokenCredential(
  plaintext: Uint8Array,
): MercadoLibreTokenCredential {
  try {
    const root = parseJson(plaintext);
    exactKeys(root, [
      "kind",
      "version",
      "clientId",
      "clientSecret",
      "accessToken",
      "refreshToken",
      "externalAccountId",
      "scopes",
    ]);
    if (root.kind !== "MERCADO_LIBRE_TOKENS" || root.version !== 1) throw new Error();
    const client = clientFromJson(root);
    const accessToken = secret(root.accessToken);
    const refreshToken = secret(root.refreshToken);
    const externalId = externalAccountId(root.externalAccountId);
    if (!Array.isArray(root.scopes) || !root.scopes.every((scope) => typeof scope === "string")) {
      throw new Error();
    }
    const grantedScopes = scopes(root.scopes.join(" "));
    return {
      ...client,
      accessToken,
      refreshToken,
      externalAccountId: externalId,
      scopes: grantedScopes,
    };
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_CREDENTIALS",
      null,
      "The encrypted Mercado Libre token credential is invalid.",
    );
  }
}

function externalAccountId(value: unknown): string {
  if (!(
    (typeof value === "string" && /^[0-9]{1,64}$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  )) {
    throw new Error("Invalid external account.");
  }
  const normalized = BigInt(value).toString();
  if (normalized === "0" || normalized.length > 64) throw new Error("Invalid external account.");
  return normalized;
}

const granularScopePattern = /^urn:ml:[a-z0-9_-]+(?::[a-z0-9_-]+){1,4}$/;

function scopes(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid scope.");
  const granted = value.split(/\s+/).filter(Boolean);
  if (
    granted.length > 32 ||
    new Set(granted).size !== granted.length ||
    granted.some(
      (scope) =>
        !mercadoLibreScopes.includes(scope as (typeof mercadoLibreScopes)[number]) &&
        !granularScopePattern.test(scope),
    ) ||
    !mercadoLibreScopes.every((scope) => granted.includes(scope))
  ) {
    throw new Error("Required Mercado Libre scopes were not granted.");
  }
  const extra = granted
    .filter((scope) => !mercadoLibreScopes.includes(scope as (typeof mercadoLibreScopes)[number]))
    .sort();
  return [...mercadoLibreScopes, ...extra];
}

function tokenSetFromJson(value: Record<string, unknown>): MercadoLibreTokenSet {
  try {
    const accessToken = secret(value.access_token);
    const refreshToken = secret(value.refresh_token);
    if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
      throw new Error();
    }
    if (
      typeof value.expires_in !== "number" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 60 ||
      value.expires_in > 86_400
    ) {
      throw new Error();
    }
    return {
      accessToken,
      refreshToken,
      externalAccountId: externalAccountId(value.user_id),
      scopes: scopes(value.scope),
      expiresInSeconds: value.expires_in,
      clientId: "",
      clientSecret: "",
    };
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_RESPONSE",
      null,
      "Mercado Libre returned an invalid or insufficient OAuth grant.",
    );
  }
}

function redirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "The OAuth redirect URI must be the fixed callback and use HTTPS outside loopback.",
    );
  }
  const loopback = loopbackHosts.has(url.hostname.toLowerCase());
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.pathname !== mercadoLibreCallbackPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "The OAuth redirect URI must be the fixed callback and use HTTPS outside loopback.",
    );
  }
  return url.toString();
}

function tokenEndpoint(value: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "The Mercado Libre token endpoint is not allowed.",
    );
  }
  const official =
    url.protocol === "https:" &&
    url.hostname === "api.mercadolibre.com" &&
    url.pathname === "/oauth/token" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  const loopback =
    allowLoopback &&
    loopbackHosts.has(url.hostname.toLowerCase()) &&
    ["http:", "https:"].includes(url.protocol) &&
    url.pathname === "/oauth/token" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  if (!official && !loopback) {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "The Mercado Libre token endpoint is not allowed.",
    );
  }
  return url.toString();
}

export function createMercadoLibrePkce(): {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly stateHash: Uint8Array<ArrayBuffer>;
} {
  const codeVerifier = randomBytes(64).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    state,
    stateHash: Uint8Array.from(createHash("sha256").update(state).digest()),
  };
}

export function createMercadoLibreAuthorizationUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)
  ) {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "OAuth state and PKCE challenge must be SHA-256 base64url values.",
    );
  }
  const client = parseMercadoLibreClientCredentials({
    clientId: input.clientId,
    clientSecret: "validation-only",
  });
  const url = new URL(mercadoLibreAuthorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri(input.redirectUri));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", mercadoLibreScopes.join(" "));
  return url.toString();
}

function authorizationCode(value: string): string {
  try {
    return secret(value, 8, 2048);
  } catch {
    throw new MercadoLibreProviderError(
      "INVALID_INPUT",
      null,
      "The OAuth authorization code is invalid.",
    );
  }
}

function providerErrorCode(body: string): string | null {
  try {
    const parsed = parseHttpJson(body);
    return typeof parsed.error === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(parsed.error)
      ? parsed.error
      : null;
  } catch {
    return null;
  }
}

export class MercadoLibreOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenUrl: string;

  constructor(options: MercadoLibreClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.tokenUrl = tokenEndpoint(
      options.tokenUrl ?? mercadoLibreTokenUrl,
      options.allowLoopback === true,
    );
  }

  private async request(body: URLSearchParams): Promise<MercadoLibreTokenSet> {
    let response;
    try {
      response = await fetchWithLimit({
        url: this.tokenUrl,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
          redirect: "error",
        },
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maximumBytes: 65_536,
      });
    } catch (error) {
      if (error instanceof IntegrationTransportError) {
        throw new MercadoLibreProviderError(
          "PROVIDER_UNCERTAIN",
          null,
          "Mercado Libre did not produce a deterministic OAuth result.",
        );
      }
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      const providerCode = providerErrorCode(response.body);
      if ([400, 401, 403].includes(response.status)) {
        throw new MercadoLibreProviderError(
          "PROVIDER_REJECTED",
          providerCode,
          "Mercado Libre rejected the OAuth grant.",
        );
      }
      throw new MercadoLibreProviderError(
        "PROVIDER_UNCERTAIN",
        providerCode,
        "Mercado Libre returned an uncertain OAuth result.",
      );
    }
    try {
      return tokenSetFromJson(parseHttpJson(response.body));
    } catch (error) {
      if (error instanceof MercadoLibreProviderError) throw error;
      throw new MercadoLibreProviderError(
        "INVALID_RESPONSE",
        null,
        "Mercado Libre returned an invalid OAuth response.",
      );
    }
  }

  async exchangeAuthorizationCode(options: {
    readonly credential: MercadoLibrePendingCredential;
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<MercadoLibreTokenSet> {
    const token = await this.request(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.credential.clientId,
        client_secret: options.credential.clientSecret,
        code: authorizationCode(options.code),
        redirect_uri: redirectUri(options.redirectUri),
        code_verifier: options.credential.codeVerifier,
      }),
    );
    return {
      ...token,
      clientId: options.credential.clientId,
      clientSecret: options.credential.clientSecret,
    };
  }

  async refresh(credential: MercadoLibreTokenCredential): Promise<MercadoLibreTokenSet> {
    const token = await this.request(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        refresh_token: credential.refreshToken,
      }),
    );
    if (token.externalAccountId !== credential.externalAccountId) {
      throw new MercadoLibreProviderError(
        "INVALID_RESPONSE",
        null,
        "Mercado Libre returned a token for a different seller.",
      );
    }
    if (token.refreshToken === credential.refreshToken) {
      throw new MercadoLibreProviderError(
        "INVALID_RESPONSE",
        null,
        "Mercado Libre did not rotate the single-use refresh token.",
      );
    }
    return { ...token, clientId: credential.clientId, clientSecret: credential.clientSecret };
  }

  async revoke(credential: MercadoLibreTokenCredential): Promise<boolean> {
    const url = new URL(
      `/users/${encodeURIComponent(credential.externalAccountId)}/applications/${encodeURIComponent(credential.clientId)}`,
      this.tokenUrl,
    );
    try {
      const response = await fetchWithLimit({
        url: url.toString(),
        init: {
          method: "DELETE",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${credential.accessToken}`,
          },
          redirect: "error",
        },
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maximumBytes: 65_536,
      });
      return (response.status >= 200 && response.status < 300) || response.status === 404;
    } catch (error) {
      if (error instanceof IntegrationTransportError) return false;
      throw error;
    }
  }
}
