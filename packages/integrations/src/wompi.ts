import { createHash, timingSafeEqual } from "node:crypto";

import { IntegrationEnvironment } from "@mundonettech/db";

import { fetchWithLimit, IntegrationTransportError } from "./integration-http.js";
import {
  PaymentProviderError,
  PaymentValidationError,
  type PaymentProvider,
  type ProviderOperationInput,
  type ProviderOperationResult,
  type ProviderStartInput,
  type ProviderStartResult,
  type WompiCredentials,
  type WompiTransactionEvent,
} from "./payment-types.js";

const maximumEventBytes = 1_000_000;
const maximumResponseBytes = 1_000_000;
const transactionStatuses = new Set(["PENDING", "APPROVED", "DECLINED", "VOIDED", "ERROR"]);
const unsafePathSegments = new Set(["__proto__", "prototype", "constructor"]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function credentialString(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 255 ||
    !pattern.test(value)
  ) {
    throw new PaymentProviderError(
      "Wompi credentials do not match the expected key format.",
      "INVALID_CREDENTIAL",
    );
  }
  return value;
}

export function parseWompiCredentials(
  plaintext: Uint8Array,
  environment: IntegrationEnvironment,
): WompiCredentials {
  const bytes = Buffer.from(plaintext);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const record = objectValue(parsed);
    if (
      !record ||
      Object.keys(record).length !== 4 ||
      !["eventsSecret", "integritySecret", "privateKey", "publicKey"].every((key) =>
        Object.hasOwn(record, key),
      )
    ) {
      throw new PaymentProviderError(
        "Wompi credentials must contain exactly four keys.",
        "INVALID_CREDENTIAL",
      );
    }
    const publicKey = credentialString(record.publicKey, /^pub_(test|prod)_[A-Za-z0-9]+$/);
    const privateKey = credentialString(record.privateKey, /^prv_(test|prod)_[A-Za-z0-9]+$/);
    const integritySecret = credentialString(
      record.integritySecret,
      /^(test|prod)_integrity_[A-Za-z0-9]+$/,
    );
    const eventsSecret = credentialString(record.eventsSecret, /^(test|prod)_events_[A-Za-z0-9]+$/);
    const mode = publicKey.startsWith("pub_prod_") ? "prod" : "test";
    const prefixesMatch = [
      privateKey.startsWith(`prv_${mode}_`),
      integritySecret.startsWith(`${mode}_integrity_`),
      eventsSecret.startsWith(`${mode}_events_`),
    ].every(Boolean);
    if (
      !prefixesMatch ||
      (environment === IntegrationEnvironment.PRD ? mode !== "prod" : mode !== "test")
    ) {
      throw new PaymentProviderError(
        "Wompi credential mode does not match the isolated environment.",
        "INVALID_CREDENTIAL",
      );
    }
    return { publicKey, privateKey, integritySecret, eventsSecret, mode };
  } catch (error) {
    if (error instanceof PaymentProviderError) throw error;
    throw new PaymentProviderError(
      "Wompi credentials are not valid UTF-8 JSON.",
      "INVALID_CREDENTIAL",
    );
  } finally {
    bytes.fill(0);
  }
}

function safeUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new PaymentValidationError("returnUrl must be a valid URL of at most 2048 characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PaymentValidationError("returnUrl must be an absolute URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new PaymentValidationError(
      "returnUrl requires HTTPS outside loopback and no credentials or fragment.",
    );
  }
  return parsed;
}

function assertAmount(amountCents: bigint): void {
  if (
    typeof amountCents !== "bigint" ||
    amountCents <= 0n ||
    amountCents > 9_223_372_036_854_775_807n
  ) {
    throw new PaymentValidationError("Wompi amount must be a positive signed BIGINT in COP cents.");
  }
}

export function createWompiCheckoutUrl(
  credentials: WompiCredentials,
  input: ProviderStartInput,
  now = new Date(),
): string {
  assertAmount(input.amountCents);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.reference)) {
    throw new PaymentValidationError(
      "Wompi reference must contain 8 to 64 alphanumeric, dash or underscore characters.",
    );
  }
  if (!input.returnUrl) throw new PaymentValidationError("Wompi checkout requires a returnUrl.");
  const returnUrl = safeUrl(input.returnUrl);
  const expiration = input.expiresAt;
  if (
    !expiration ||
    expiration.getTime() <= now.getTime() ||
    expiration.getTime() > now.getTime() + 86_400_000
  ) {
    throw new PaymentValidationError(
      "Wompi expiration must be in the future and no more than 24 hours ahead.",
    );
  }
  const expirationTime = expiration.toISOString();
  const signature = createHash("sha256")
    .update(
      `${input.reference}${input.amountCents}COP${expirationTime}${credentials.integritySecret}`,
      "utf8",
    )
    .digest("hex");
  const checkout = new URL("https://checkout.wompi.co/p/");
  checkout.searchParams.set("public-key", credentials.publicKey);
  checkout.searchParams.set("currency", "COP");
  checkout.searchParams.set("amount-in-cents", input.amountCents.toString());
  checkout.searchParams.set("reference", input.reference);
  checkout.searchParams.set("signature:integrity", signature);
  checkout.searchParams.set("redirect-url", returnUrl.toString());
  checkout.searchParams.set("expiration-time", expirationTime);
  checkout.searchParams.set("collect-shipping", "false");
  return checkout.toString();
}

function signatureValue(data: Record<string, unknown>, path: string): string {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.length > 8 ||
    segments.some((segment) => !/^[A-Za-z0-9_]+$/.test(segment) || unsafePathSegments.has(segment))
  ) {
    throw new PaymentValidationError("Wompi signature contains an unsafe property path.");
  }
  let current: unknown = data;
  for (const segment of segments) {
    const record = objectValue(current);
    if (!record || !Object.hasOwn(record, segment)) {
      throw new PaymentValidationError("Wompi signature references a missing property.");
    }
    current = record[segment];
  }
  if (current === null) return "null";
  if (typeof current === "string" || typeof current === "boolean") return String(current);
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  throw new PaymentValidationError("Wompi signature properties must contain scalar values.");
}

function checksumBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new PaymentValidationError("Wompi event checksum must be a SHA-256 hexadecimal value.");
  }
  return Buffer.from(value.toLowerCase(), "hex");
}

function transactionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) {
    throw new PaymentValidationError("Wompi transaction ID has an invalid format.");
  }
  return value;
}

export function verifyWompiWebhook(options: {
  body: string;
  credentials: WompiCredentials;
  headerChecksum?: string | null;
  now?: Date;
}): WompiTransactionEvent {
  if (
    typeof options.body !== "string" ||
    options.body.length === 0 ||
    Buffer.byteLength(options.body, "utf8") > maximumEventBytes
  ) {
    throw new PaymentValidationError("Wompi webhook body is empty or exceeds the resource limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.body);
  } catch {
    throw new PaymentValidationError("Wompi webhook must be valid JSON.");
  }
  const root = objectValue(parsed);
  const data = objectValue(root?.data);
  const signature = objectValue(root?.signature);
  if (!root || !data || !signature || typeof root.event !== "string") {
    throw new PaymentValidationError("Wompi webhook is missing its signed envelope.");
  }
  const timestamp = root.timestamp;
  if (!Number.isSafeInteger(timestamp) || typeof timestamp !== "number" || timestamp <= 0) {
    throw new PaymentValidationError("Wompi webhook timestamp must be a positive Unix timestamp.");
  }
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  if (timestamp > nowSeconds + 300 || timestamp < nowSeconds - 172_800) {
    throw new PaymentValidationError(
      "Wompi webhook timestamp is outside the accepted replay window.",
    );
  }
  if (
    !Array.isArray(signature.properties) ||
    signature.properties.length < 1 ||
    signature.properties.length > 32
  ) {
    throw new PaymentValidationError("Wompi webhook signature properties are invalid.");
  }
  const properties = signature.properties;
  if (
    properties.some((property) => typeof property !== "string") ||
    new Set(properties).size !== properties.length
  ) {
    throw new PaymentValidationError("Wompi webhook signature properties must be unique strings.");
  }
  const material = `${properties.map((property) => signatureValue(data, property as string)).join("")}${timestamp}${options.credentials.eventsSecret}`;
  const expected = createHash("sha256").update(material, "utf8").digest();
  const supplied = checksumBytes(signature.checksum);
  if (!timingSafeEqual(expected, supplied)) {
    throw new PaymentValidationError("Wompi webhook signature verification failed.");
  }
  if (options.headerChecksum) {
    const header = checksumBytes(options.headerChecksum);
    if (!timingSafeEqual(header, supplied)) {
      throw new PaymentValidationError("Wompi header and body checksums differ.");
    }
  }
  if (root.environment !== options.credentials.mode) {
    throw new PaymentValidationError(
      "Wompi webhook environment does not match the credential mode.",
    );
  }
  const payloadHash = createHash("sha256").update(options.body, "utf8").digest();
  const event = root.event;
  if (event !== "transaction.updated") {
    return {
      eventKey: createHash("sha256")
        .update(`wompi-event:${event}:${timestamp}:${supplied.toString("hex")}`)
        .digest("hex"),
      payloadHash,
      supported: false,
      occurredAt: new Date(timestamp * 1000),
      transaction: null,
    };
  }
  const transaction = objectValue(data.transaction);
  if (!transaction)
    throw new PaymentValidationError("Wompi transaction event is missing its transaction.");
  const id = transactionId(transaction.id);
  const reference = transaction.reference;
  const amount = transaction.amount_in_cents;
  const status = transaction.status;
  if (
    typeof reference !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(reference) ||
    !Number.isSafeInteger(amount) ||
    typeof amount !== "number" ||
    amount <= 0 ||
    transaction.currency !== "COP" ||
    typeof status !== "string" ||
    !transactionStatuses.has(status)
  ) {
    throw new PaymentValidationError("Wompi transaction fields are invalid.");
  }
  const statusMessage =
    typeof transaction.status_message === "string"
      ? transaction.status_message
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, 500) || null
      : null;
  return {
    eventKey: createHash("sha256")
      .update(`wompi-event:${id}:${timestamp}:${supplied.toString("hex")}`)
      .digest("hex"),
    payloadHash,
    supported: true,
    occurredAt: new Date(timestamp * 1000),
    transaction: {
      id,
      reference,
      amountCents: BigInt(amount),
      currency: "COP",
      status: status as "PENDING" | "APPROVED" | "DECLINED" | "VOIDED" | "ERROR",
      statusMessage,
    },
  };
}

type FetchImplementation = typeof fetch;

function providerAmount(value: unknown): bigint {
  if (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
  ) {
    const amount = BigInt(value);
    if (amount > 0n) return amount;
  }
  throw new PaymentProviderError("Wompi response contains an invalid amount.", "INVALID_RESPONSE");
}

export class WompiPaymentProvider implements PaymentProvider {
  readonly code = "WOMPI" as const;
  private readonly apiOrigin: string;

  constructor(
    private readonly credentials: WompiCredentials,
    private readonly options: { fetchImpl?: FetchImplementation; timeoutMs?: number } = {},
  ) {
    this.apiOrigin =
      credentials.mode === "prod" ? "https://production.wompi.co" : "https://sandbox.wompi.co";
  }

  async start(input: ProviderStartInput): Promise<ProviderStartResult> {
    return { checkoutUrl: createWompiCheckoutUrl(this.credentials, input, input.now) };
  }

  private async request(
    path: string,
    init: RequestInit,
    expectedStatuses: readonly number[],
  ): Promise<unknown> {
    if (!/^\/v1\/[A-Za-z0-9/_-]+$/.test(path))
      throw new PaymentValidationError("Invalid Wompi API path.");
    try {
      const response = await fetchWithLimit({
        url: `${this.apiOrigin}${path}`,
        init: {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.credentials.privateKey}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 10_000,
        maximumBytes: maximumResponseBytes,
      });
      if (!expectedStatuses.includes(response.status)) {
        throw new PaymentProviderError(
          `Wompi rejected the operation with HTTP ${response.status}.`,
          "HTTP_ERROR",
        );
      }
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw new PaymentProviderError("Wompi returned malformed JSON.", "INVALID_RESPONSE");
      }
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      if (error instanceof IntegrationTransportError && error.code === "RESPONSE_TOO_LARGE") {
        throw new PaymentProviderError(
          "Wompi response exceeds the resource limit.",
          "INVALID_RESPONSE",
        );
      }
      throw new PaymentProviderError(
        "Wompi operation outcome is uncertain and must be reconciled before retrying.",
        "NETWORK_UNCERTAIN",
      );
    }
  }

  verifyWebhook(options: {
    body: string;
    headerChecksum?: string | null;
    now?: Date;
  }): WompiTransactionEvent {
    return verifyWompiWebhook({ ...options, credentials: this.credentials });
  }

  async refund(input: ProviderOperationInput): Promise<ProviderOperationResult> {
    if (!input.externalCaptureId)
      throw new PaymentValidationError("Wompi refund requires an external capture ID.");
    assertAmount(input.amountCents);
    if (input.amountCents > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PaymentValidationError("Wompi refund amount exceeds the safe JSON integer range.");
    }
    const response = objectValue(
      await this.request(
        "/v1/refunds",
        {
          method: "POST",
          body: JSON.stringify({
            transaction_id: input.externalCaptureId,
            amount_in_cents: Number(input.amountCents),
            reason: input.reason.slice(0, 200),
            reference: `refund:${input.transactionId}`,
            reference_2: input.paymentReference,
          }),
        },
        [201],
      ),
    );
    const data = objectValue(response?.data);
    const id = data?.v2_refund_id ?? data?.id;
    if (
      !data ||
      (typeof id !== "string" && typeof id !== "number") ||
      String(id).length === 0 ||
      data.transaction_id !== input.externalCaptureId ||
      providerAmount(data.amount_in_cents) !== input.amountCents ||
      !["APPROVED", "PENDING", "DECLINED", "ERROR", "CANCELLED"].includes(String(data.status))
    ) {
      throw new PaymentProviderError(
        "Wompi refund response does not match the request.",
        "INVALID_RESPONSE",
      );
    }
    const status =
      data.status === "APPROVED" ? "SUCCEEDED" : data.status === "PENDING" ? "PENDING" : "FAILED";
    return {
      status,
      externalId: String(id).slice(0, 128),
      providerReference: `refund:${input.transactionId}`,
      message: typeof data.status_message === "string" ? data.status_message.slice(0, 500) : null,
    };
  }

  async void(input: ProviderOperationInput): Promise<ProviderOperationResult> {
    if (!input.externalCaptureId)
      throw new PaymentValidationError("Wompi void requires an external capture ID.");
    const path = `/v1/transactions/${transactionId(input.externalCaptureId)}/void`;
    const response = objectValue(await this.request(path, { method: "POST" }, [200, 201]));
    const data = objectValue(response?.data);
    if (
      !data ||
      data.id !== input.externalCaptureId ||
      typeof data.status !== "string" ||
      !["VOIDED", "PENDING", "DECLINED", "ERROR"].includes(data.status)
    ) {
      throw new PaymentProviderError(
        "Wompi void response does not match the capture.",
        "INVALID_RESPONSE",
      );
    }
    return {
      status:
        data.status === "VOIDED" ? "SUCCEEDED" : data.status === "PENDING" ? "PENDING" : "FAILED",
      externalId: input.externalCaptureId,
      providerReference: input.paymentReference,
      message: typeof data.status_message === "string" ? data.status_message.slice(0, 500) : null,
    };
  }

  async getTransaction(
    externalId: string,
  ): Promise<NonNullable<WompiTransactionEvent["transaction"]>> {
    const response = objectValue(
      await this.request(`/v1/transactions/${transactionId(externalId)}`, { method: "GET" }, [200]),
    );
    const data = objectValue(response?.data);
    if (
      !data ||
      data.id !== externalId ||
      typeof data.reference !== "string" ||
      !/^[A-Za-z0-9_-]{1,255}$/.test(data.reference) ||
      data.currency !== "COP" ||
      typeof data.status !== "string" ||
      !transactionStatuses.has(data.status)
    ) {
      throw new PaymentProviderError("Wompi transaction response is invalid.", "INVALID_RESPONSE");
    }
    const amountCents = providerAmount(data.amount_in_cents);
    return {
      id: externalId,
      reference: data.reference,
      amountCents,
      currency: "COP",
      status: data.status as "PENDING" | "APPROVED" | "DECLINED" | "VOIDED" | "ERROR",
      statusMessage:
        typeof data.status_message === "string" ? data.status_message.slice(0, 500) : null,
    };
  }
}
