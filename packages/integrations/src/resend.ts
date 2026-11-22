import { assertOutboundEmailAllowed } from "@mundonettech/core";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";
import { credentialObject, integrationText, publicHttpsUrl } from "./integration-utils.js";
import {
  EmailProviderError,
  type EmailCredentials,
  type EmailProvider,
  type EmailSendInput,
  type EmailSendResult,
} from "./email-types.js";

const keys = [
  "apiKey",
  "fromEmail",
  "fromName",
  "replyTo",
  "svixSecret",
  "unsubscribeSecret",
  "apiUrl",
] as const;

function text(record: Record<string, unknown>, key: string, maximum: number, minimum = 1): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new EmailProviderError(`Resend credential ${key} is invalid.`, "INVALID_CREDENTIAL");
  try {
    return integrationText(value, key, maximum, minimum);
  } catch {
    throw new EmailProviderError(`Resend credential ${key} is invalid.`, "INVALID_CREDENTIAL");
  }
}

function email(value: string): string {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) || value.length > 320)
    throw new EmailProviderError(
      "Resend sender or reply-to email is invalid.",
      "INVALID_CREDENTIAL",
    );
  return value;
}

export function parseEmailCredentials(plaintext: Uint8Array): EmailCredentials {
  try {
    const record = credentialObject(plaintext, keys);
    const apiKey = text(record, "apiKey", 255, 20);
    const svixSecret = text(record, "svixSecret", 255, 20);
    const unsubscribeSecret = text(record, "unsubscribeSecret", 255, 32);
    if (
      !apiKey.startsWith("re_") ||
      !svixSecret.startsWith("whsec_") ||
      !/^[A-Za-z0-9+/=_-]{32,255}$/.test(unsubscribeSecret)
    ) {
      throw new EmailProviderError("Resend credential formats are invalid.", "INVALID_CREDENTIAL");
    }
    const replyToValue = record.replyTo;
    if (replyToValue !== null && typeof replyToValue !== "string")
      throw new EmailProviderError(
        "Resend replyTo must be a string or null.",
        "INVALID_CREDENTIAL",
      );
    return {
      apiKey,
      fromEmail: email(text(record, "fromEmail", 320, 3)),
      fromName: text(record, "fromName", 120, 2),
      replyTo: replyToValue === null ? null : email(replyToValue),
      svixSecret,
      unsubscribeSecret,
      apiUrl: publicHttpsUrl(text(record, "apiUrl", 2048), "apiUrl"),
    };
  } catch (error) {
    if (error instanceof EmailProviderError) throw error;
    throw new EmailProviderError(
      "Resend credentials are not valid for the closed provider contract.",
      "INVALID_CREDENTIAL",
    );
  }
}

export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly credentials: EmailCredentials,
    private readonly options: {
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {}

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    assertOutboundEmailAllowed();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.to))
      throw new EmailProviderError("Recipient email is invalid.", "REJECTED");
    try {
      const response = await fetchWithLimit({
        url: this.credentials.apiUrl,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.credentials.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            "idempotency-key": input.idempotencyKey,
          },
          body: JSON.stringify({
            from: `${this.credentials.fromName} <${this.credentials.fromEmail}>`,
            to: [input.to],
            subject: input.subject,
            html: input.html,
            text: input.text,
            ...(this.credentials.replyTo ? { reply_to: this.credentials.replyTo } : {}),
            ...(input.unsubscribeUrl
              ? {
                  headers: {
                    "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
                    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                  },
                }
              : {}),
          }),
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 15_000,
      });
      if (response.status === 429 || response.status >= 500)
        throw new EmailProviderError(
          "Resend is temporarily unavailable; the same idempotency key must be reused.",
          "NETWORK_UNCERTAIN",
        );
      if (response.status < 200 || response.status >= 300)
        throw new EmailProviderError("Resend rejected the email request.", "HTTP_ERROR");
      const root = parseHttpJson(response.body);
      if (typeof root.id !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(root.id))
        throw new EmailProviderError(
          "Resend returned an invalid message identifier.",
          "INVALID_RESPONSE",
        );
      return { providerMessageId: root.id };
    } catch (error) {
      if (error instanceof EmailProviderError) throw error;
      if (error instanceof IntegrationTransportError)
        throw new EmailProviderError(
          "Resend did not confirm the request; the same idempotency key must be reused.",
          "NETWORK_UNCERTAIN",
        );
      throw error;
    }
  }
}
