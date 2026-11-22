import { createHash } from "node:crypto";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";
import {
  InvoiceProviderError,
  type DianCredentials,
  type FiscalTransmissionInput,
  type FiscalTransmissionResult,
  type InvoiceProvider,
} from "./invoice-types.js";

function parseResult(
  root: Record<string, unknown>,
  expectedHash: string,
): FiscalTransmissionResult {
  if (root.status === "REJECTED")
    throw new InvoiceProviderError("The DIAN provider rejected the fiscal document.", "REJECTED");
  if (root.status !== "ACCEPTED")
    throw new InvoiceProviderError(
      "The DIAN provider returned an unsupported document status.",
      "INVALID_RESPONSE",
    );
  const providerDocumentId = root.providerDocumentId;
  const signedXml = root.signedXml;
  const documentHash = root.documentHash;
  if (
    typeof providerDocumentId !== "string" ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(providerDocumentId) ||
    typeof signedXml !== "string" ||
    signedXml.length < 100 ||
    signedXml.length > 4_000_000 ||
    documentHash !== expectedHash
  ) {
    throw new InvoiceProviderError(
      "The DIAN provider response does not match the transmitted document.",
      "INVALID_RESPONSE",
    );
  }
  if (
    !signedXml.includes(expectedHash) ||
    !/<(?:[A-Za-z0-9]+:)?Signature(?:\s|>)/.test(signedXml)
  ) {
    throw new InvoiceProviderError(
      "Accepted DIAN XML must contain its document identifier and digital signature.",
      "INVALID_RESPONSE",
    );
  }
  return { providerDocumentId, signedXml };
}

export class DianInvoiceProvider implements InvoiceProvider {
  constructor(
    private readonly credentials: DianCredentials,
    private readonly options: {
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {}

  private async response(
    url: string,
    init: RequestInit,
    expectedHash: string,
  ): Promise<FiscalTransmissionResult | null> {
    try {
      const response = await fetchWithLimit({
        url,
        init: {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${this.credentials.bearerToken}`,
            accept: "application/json",
          },
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 20_000,
        maximumBytes: 5_000_000,
      });
      if (response.status === 404) return null;
      if (response.status === 409 || response.status === 429 || response.status >= 500)
        throw new InvoiceProviderError(
          "DIAN transmission result is uncertain and requires reconciliation.",
          "NETWORK_UNCERTAIN",
        );
      if (response.status < 200 || response.status >= 300)
        throw new InvoiceProviderError(
          "The DIAN provider rejected the HTTP request.",
          "HTTP_ERROR",
        );
      return parseResult(parseHttpJson(response.body), expectedHash);
    } catch (error) {
      if (error instanceof InvoiceProviderError) throw error;
      if (error instanceof IntegrationTransportError)
        throw new InvoiceProviderError(
          "DIAN transmission result is uncertain and requires reconciliation.",
          "NETWORK_UNCERTAIN",
        );
      throw error;
    }
  }

  async transmit(input: FiscalTransmissionInput): Promise<FiscalTransmissionResult> {
    const result = await this.response(
      `${this.credentials.providerUrl}/documents`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
        body: JSON.stringify(input),
      },
      input.documentHash,
    );
    if (!result)
      throw new InvoiceProviderError("DIAN transmission returned no document.", "INVALID_RESPONSE");
    return result;
  }

  async find(documentHash: string): Promise<FiscalTransmissionResult | null> {
    if (!/^[0-9a-f]{96}$/.test(documentHash))
      throw new InvoiceProviderError("Fiscal document hash is invalid.", "INVALID_RESPONSE");
    return this.response(
      `${this.credentials.providerUrl}/documents/${encodeURIComponent(documentHash)}`,
      { method: "GET" },
      documentHash,
    );
  }
}

export function signedDocumentHash(signedXml: string): Uint8Array<ArrayBuffer> {
  return createHash("sha256").update(signedXml, "utf8").digest();
}
