import { createHmac, timingSafeEqual } from "node:crypto";

import { EmailValidationError } from "./email-types.js";
import { recordValue } from "./integration-utils.js";

export interface VerifiedSvixEvent {
  readonly svixEventId: string;
  readonly eventType: string;
  readonly providerMessageId: string;
  readonly occurredAt: Date;
  readonly payloadHashInput: string;
}

export function verifySvixWebhook(options: {
  readonly body: string;
  readonly secret: string;
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly now?: Date;
}): VerifiedSvixEvent {
  if (
    Buffer.byteLength(options.body, "utf8") > 1_000_000 ||
    !options.id ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(options.id) ||
    !options.timestamp ||
    !/^[0-9]{1,13}$/.test(options.timestamp) ||
    !options.signature ||
    options.signature.length > 2048
  ) {
    throw new EmailValidationError("Svix webhook envelope is invalid.");
  }
  const timestamp = Number(options.timestamp);
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300)
    throw new EmailValidationError("Svix webhook timestamp is outside the replay window.");
  const encodedSecret = options.secret.startsWith("whsec_")
    ? options.secret.slice(6)
    : options.secret;
  let key: Buffer;
  try {
    key = Buffer.from(encodedSecret, "base64");
  } catch {
    throw new EmailValidationError("Svix secret is invalid.");
  }
  if (key.length < 16 || key.length > 128)
    throw new EmailValidationError("Svix secret must decode to between 16 and 128 bytes.");
  const expected = createHmac("sha256", key)
    .update(`${options.id}.${options.timestamp}.${options.body}`, "utf8")
    .digest();
  const rawEntries = options.signature.trim().split(/\s+/);
  if (rawEntries.length > 16) {
    throw new EmailValidationError("Svix webhook signature header has too many entries.");
  }
  const signatures = rawEntries
    .map((entry) => entry.split(","))
    .filter((parts) => parts.length === 2 && parts[0] === "v1")
    .map((parts) => parts[1]!);
  const valid = signatures.some((value) => {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
    const candidate = Buffer.from(value, "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) throw new EmailValidationError("Svix webhook signature is invalid.");
  let root: Record<string, unknown> | null;
  try {
    root = recordValue(JSON.parse(options.body));
  } catch {
    throw new EmailValidationError("Svix webhook body must be valid JSON.");
  }
  const data = recordValue(root?.data);
  const eventType = root?.type;
  const providerMessageId = data?.email_id;
  if (
    !data ||
    typeof eventType !== "string" ||
    !/^email\.[a-z_]{2,40}$/.test(eventType) ||
    typeof providerMessageId !== "string" ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(providerMessageId)
  ) {
    throw new EmailValidationError("Resend webhook payload is incomplete.");
  }
  const dateValue = data.created_at ?? root?.created_at ?? new Date(timestamp * 1000).toISOString();
  const occurredAt = typeof dateValue === "string" ? new Date(dateValue) : new Date(Number.NaN);
  if (Number.isNaN(occurredAt.getTime()))
    throw new EmailValidationError("Resend webhook timestamp is invalid.");
  return {
    svixEventId: options.id,
    eventType,
    providerMessageId,
    occurredAt,
    payloadHashInput: options.body,
  };
}
