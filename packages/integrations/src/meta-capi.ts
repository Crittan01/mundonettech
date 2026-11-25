import { IntegrationEnvironment } from "@mundonettech/db";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";
import {
  centsToDecimal,
  credentialObject,
  hash32,
  integrationDigest,
  integrationMoney,
  publicHttpsUrl,
  uuidPattern,
} from "./integration-utils.js";

const metaCapiGraphApiBaseUrl = "https://graph.facebook.com/v24.0";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const tracePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type MetaCapiErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CREDENTIALS"
  | "INVALID_PROVIDER_RESPONSE"
  | "CREDENTIAL_REJECTED"
  | "PAYLOAD_REJECTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNCERTAIN";

export class MetaCapiError extends Error {
  constructor(
    readonly code: MetaCapiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MetaCapiError";
  }
}

export interface MetaCredentials {
  readonly pixelId: string;
  readonly accessToken: string;
  readonly testEventCode: string | null;
}

export interface MetaCapiContent {
  readonly id: string;
  readonly quantity: number;
}

export interface MetaCapiPurchaseInput {
  readonly orderId: string;
  readonly eventTime: Date;
  readonly eventSourceUrl: string;
  readonly valueCents: bigint;
  readonly contents: readonly MetaCapiContent[];
  readonly externalIdHash: Uint8Array;
  readonly emailHash?: Uint8Array | null;
  readonly phoneHash?: Uint8Array | null;
}

export interface MetaCapiRequest {
  readonly requestUrl: string;
  readonly body: string;
  readonly requestHash: Uint8Array<ArrayBuffer>;
}

export type MetaCapiSendResult =
  | { readonly kind: "SENT"; readonly providerTraceId: string }
  | { readonly kind: "REJECTED"; readonly code: "CREDENTIAL_REJECTED" | "PAYLOAD_REJECTED" }
  | { readonly kind: "RATE_LIMITED"; readonly retryAfterSeconds: number }
  | {
      readonly kind: "UNCERTAIN";
      readonly code: "INVALID_PROVIDER_RESPONSE" | "PROVIDER_UNCERTAIN";
    };

function parsePixelId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{5,32}$/.test(value)) {
    throw new MetaCapiError("INVALID_CREDENTIALS", "Meta pixel_id is invalid.");
  }
  return value;
}

export function parseMetaCredentials(
  plaintext: Uint8Array,
  environment: IntegrationEnvironment,
): MetaCredentials {
  try {
    const root = credentialObject(plaintext, ["pixelId", "accessToken", "testEventCode"]);
    const accessToken = root.accessToken;
    if (
      typeof accessToken !== "string" ||
      accessToken.length < 20 ||
      accessToken.length > 4096 ||
      /\s|[\u0000-\u001f\u007f]/.test(accessToken)
    ) {
      throw new MetaCapiError("INVALID_CREDENTIALS", "Meta access token is invalid.");
    }
    const testEventCode = root.testEventCode;
    if (
      testEventCode !== null &&
      (typeof testEventCode !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(testEventCode))
    ) {
      throw new MetaCapiError("INVALID_CREDENTIALS", "Meta test event code is invalid.");
    }
    if (environment === IntegrationEnvironment.PRD && testEventCode !== null) {
      throw new MetaCapiError(
        "INVALID_CREDENTIALS",
        "Meta test event codes are forbidden in production.",
      );
    }
    return {
      pixelId: parsePixelId(root.pixelId),
      accessToken,
      testEventCode,
    };
  } catch (error) {
    if (error instanceof MetaCapiError) throw error;
    throw new MetaCapiError("INVALID_CREDENTIALS", "Encrypted Meta credential is invalid.");
  }
}

export function metaCapiEventsUrl(
  pixelId: string,
  options?: { apiUrl?: string; allowLoopback?: boolean },
): string {
  parsePixelId(pixelId);
  const base = new URL(options?.apiUrl ?? metaCapiGraphApiBaseUrl);
  const normalized = base.toString().replace(/\/$/, "");
  const official = base.protocol === "https:" && normalized === metaCapiGraphApiBaseUrl;
  const loopbackFixture =
    options?.allowLoopback === true &&
    loopbackHosts.has(base.hostname) &&
    ["http:", "https:"].includes(base.protocol);
  if (
    (!official && !loopbackFixture) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new MetaCapiError("INVALID_INPUT", "Meta CAPI endpoint violates the environment policy.");
  }
  return `${normalized}/${pixelId}/events`;
}

function sha256Hex(value: Uint8Array, field: string): string {
  return Buffer.from(hash32(value, field)).toString("hex");
}

function purchaseBody(
  input: MetaCapiPurchaseInput,
  testEventCode: string | null,
  allowLoopback = false,
): string {
  if (!uuidPattern.test(input.orderId)) {
    throw new MetaCapiError("INVALID_INPUT", "Meta purchase orderId must be a UUID.");
  }
  if (!(input.eventTime instanceof Date) || Number.isNaN(input.eventTime.getTime())) {
    throw new MetaCapiError("INVALID_INPUT", "Meta purchase eventTime is invalid.");
  }
  integrationMoney(input.valueCents, "valueCents");
  if (!Array.isArray(input.contents) || input.contents.length < 1 || input.contents.length > 100) {
    throw new MetaCapiError("INVALID_INPUT", "Meta purchase requires 1 to 100 content rows.");
  }
  const ids = new Set<string>();
  let itemCount = 0;
  const contents = input.contents.map((content) => {
    if (!uuidPattern.test(content.id) || ids.has(content.id)) {
      throw new MetaCapiError("INVALID_INPUT", "Meta purchase content IDs must be unique UUIDs.");
    }
    if (!Number.isInteger(content.quantity) || content.quantity < 1) {
      throw new MetaCapiError(
        "INVALID_INPUT",
        "Meta purchase content quantities must be positive.",
      );
    }
    ids.add(content.id);
    itemCount += content.quantity;
    if (!Number.isSafeInteger(itemCount)) {
      throw new MetaCapiError("INVALID_INPUT", "Meta purchase item count exceeds JSON bounds.");
    }
    return `{"id":${JSON.stringify(content.id)},"quantity":${content.quantity}}`;
  });
  const externalId = sha256Hex(input.externalIdHash, "externalIdHash");
  const email = input.emailHash ? sha256Hex(input.emailHash, "emailHash") : null;
  const phone = input.phoneHash ? sha256Hex(input.phoneHash, "phoneHash") : null;
  const userData = `{"external_id":[${JSON.stringify(externalId)}]${email ? `,"em":[${JSON.stringify(email)}]` : ""}${phone ? `,"ph":[${JSON.stringify(phone)}]` : ""}}`;
  const customData = `{"currency":"COP","value":${centsToDecimal(input.valueCents)},"contents":[${contents.join(",")}],"content_ids":[${[...ids].map((id) => JSON.stringify(id)).join(",")}],"content_type":"product","num_items":${itemCount},"order_id":${JSON.stringify(input.orderId)}}`;
  const event = `{"event_name":"Purchase","event_time":${Math.floor(input.eventTime.getTime() / 1000)},"event_id":${JSON.stringify(`purchase:${input.orderId}`)},"event_source_url":${JSON.stringify(publicHttpsUrl(input.eventSourceUrl, "eventSourceUrl", { allowLoopback }))},"action_source":"website","user_data":${userData},"custom_data":${customData}}`;
  return `{"data":[${event}]${testEventCode ? `,"test_event_code":${JSON.stringify(testEventCode)}` : ""}}`;
}

export function buildMetaCapiPurchaseRequest(options: {
  readonly pixelId: string;
  readonly testEventCode: string | null;
  readonly purchase: MetaCapiPurchaseInput;
  readonly apiUrl?: string;
  readonly allowLoopback?: boolean;
}): MetaCapiRequest {
  const requestUrl = metaCapiEventsUrl(options.pixelId, {
    ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
    ...(options.allowLoopback !== undefined ? { allowLoopback: options.allowLoopback } : {}),
  });
  const body = purchaseBody(
    options.purchase,
    options.testEventCode,
    options.allowLoopback === true,
  );
  return {
    requestUrl,
    body,
    requestHash: integrationDigest({ requestUrl, body }),
  };
}

export interface MetaConversionsApiClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class MetaConversionsApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MetaConversionsApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(request: MetaCapiRequest, accessToken: string): Promise<MetaCapiSendResult> {
    try {
      const response = await fetchWithLimit({
        url: request.requestUrl,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: request.body,
          redirect: "error",
        },
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maximumBytes: 65_536,
      });
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const parsed = header && /^[0-9]{1,4}$/.test(header) ? Number(header) : 60;
        return { kind: "RATE_LIMITED", retryAfterSeconds: Math.min(900, Math.max(1, parsed)) };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "REJECTED", code: "CREDENTIAL_REJECTED" };
      }
      if (response.status >= 400 && response.status < 500) {
        return { kind: "REJECTED", code: "PAYLOAD_REJECTED" };
      }
      if (response.status !== 200) return { kind: "UNCERTAIN", code: "PROVIDER_UNCERTAIN" };
      const payload = parseHttpJson(response.body);
      if (
        !Object.keys(payload).every((key) =>
          ["events_received", "fbtrace_id", "messages"].includes(key),
        ) ||
        payload.events_received !== 1 ||
        typeof payload.fbtrace_id !== "string" ||
        !tracePattern.test(payload.fbtrace_id)
      ) {
        return { kind: "UNCERTAIN", code: "INVALID_PROVIDER_RESPONSE" };
      }
      return { kind: "SENT", providerTraceId: payload.fbtrace_id };
    } catch (error) {
      if (error instanceof IntegrationTransportError || error instanceof MetaCapiError) {
        return { kind: "UNCERTAIN", code: "PROVIDER_UNCERTAIN" };
      }
      throw error;
    }
  }
}
