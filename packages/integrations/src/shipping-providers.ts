import { createHash } from "node:crypto";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";
import {
  assertIntegrationKey,
  centsToDecimal,
  credentialObject,
  integrationText,
  publicHttpsUrl,
  recordValue,
} from "./integration-utils.js";
import {
  ShippingProviderError,
  type AveonlineCredentials,
  type ShippingLabelRequest,
  type ShippingLabelResult,
  type ShippingProvider,
} from "./shipping-types.js";

const credentialKeys = [
  "username",
  "password",
  "companyId",
  "companyCode",
  "companyDocument",
  "originLegalName",
  "originEmail",
  "agentId",
  "carrierId",
  "authUrl",
  "labelsUrl",
  "lookupUrl",
] as const;

function credentialText(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  minimum = 1,
): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new ShippingProviderError(
      `Aveonline credential ${key} is invalid.`,
      "INVALID_CREDENTIAL",
    );
  try {
    return integrationText(value, key, maximum, minimum);
  } catch {
    throw new ShippingProviderError(
      `Aveonline credential ${key} is invalid.`,
      "INVALID_CREDENTIAL",
    );
  }
}

function credentialUrl(record: Record<string, unknown>, key: string): string {
  try {
    return publicHttpsUrl(credentialText(record, key, 2048), key);
  } catch {
    throw new ShippingProviderError(
      `Aveonline credential ${key} is invalid.`,
      "INVALID_CREDENTIAL",
    );
  }
}

export function parseAveonlineCredentials(plaintext: Uint8Array): AveonlineCredentials {
  try {
    const record = credentialObject(plaintext, credentialKeys);
    const lookupUrl = credentialUrl(record, "lookupUrl");
    if (!lookupUrl.includes("{requestKey}")) {
      throw new ShippingProviderError(
        "Aveonline lookup URL requires the requestKey placeholder.",
        "INVALID_CREDENTIAL",
      );
    }
    return {
      username: credentialText(record, "username", 120),
      password: credentialText(record, "password", 255, 8),
      companyId: credentialText(record, "companyId", 30),
      companyCode: credentialText(record, "companyCode", 60),
      companyDocument: credentialText(record, "companyDocument", 30, 3),
      originLegalName: credentialText(record, "originLegalName", 200, 2),
      originEmail: credentialText(record, "originEmail", 320, 3),
      agentId: credentialText(record, "agentId", 30),
      carrierId: credentialText(record, "carrierId", 30),
      authUrl: credentialUrl(record, "authUrl"),
      labelsUrl: credentialUrl(record, "labelsUrl"),
      lookupUrl,
    };
  } catch (error) {
    if (error instanceof ShippingProviderError) throw error;
    throw new ShippingProviderError(
      "Aveonline credentials are not valid for the closed provider contract.",
      "INVALID_CREDENTIAL",
    );
  }
}

function numericIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(value))
    throw new ShippingProviderError(
      `${field} has an invalid provider format.`,
      "INVALID_CREDENTIAL",
    );
  return value;
}

function guideRecord(root: Record<string, unknown>): Record<string, unknown> | null {
  const result = recordValue(root.resultado);
  const direct = recordValue(result?.guia);
  if (direct) return direct;
  const data = recordValue(root.data);
  return recordValue(data?.guia) ?? recordValue(root.guia);
}

function parseGuide(root: Record<string, unknown>, requestKey: string): ShippingLabelResult | null {
  const status = root.status;
  if (status === "error") {
    const message =
      typeof root.message === "string" ? root.message : "Provider rejected the request.";
    if (/no se encontr|not found|no existe/i.test(message)) return null;
    throw new ShippingProviderError("Aveonline rejected the shipping request.", "REJECTED");
  }
  if (status !== "ok")
    throw new ShippingProviderError(
      "Aveonline returned an unsupported status.",
      "INVALID_RESPONSE",
    );
  const guide = guideRecord(root);
  if (!guide)
    throw new ShippingProviderError("Aveonline omitted the generated guide.", "INVALID_RESPONSE");
  if (guide.dsreferencia !== undefined && guide.dsreferencia !== requestKey) {
    throw new ShippingProviderError(
      "Aveonline returned a guide for another request.",
      "INVALID_RESPONSE",
    );
  }
  if (guide.codigo !== undefined && String(guide.codigo) !== "0") {
    throw new ShippingProviderError("Aveonline rejected the shipping guide.", "REJECTED");
  }
  const reference = guide.numguia ?? guide.guia ?? guide.numero;
  if (
    (typeof reference !== "string" && typeof reference !== "number") ||
    !/^[A-Za-z0-9_-]{3,120}$/.test(String(reference))
  ) {
    throw new ShippingProviderError(
      "Aveonline returned an invalid guide number.",
      "INVALID_RESPONSE",
    );
  }
  const carrier = guide.transportadora;
  if (typeof carrier !== "string" || carrier.trim().length < 2 || carrier.length > 120) {
    throw new ShippingProviderError("Aveonline omitted the carrier.", "INVALID_RESPONSE");
  }
  const rawUrl = guide.rutaguia ?? guide.rotulo ?? guide.url ?? null;
  let labelUrl: string | null = null;
  if (rawUrl !== null) {
    if (typeof rawUrl !== "string")
      throw new ShippingProviderError(
        "Aveonline returned an invalid label URL.",
        "INVALID_RESPONSE",
      );
    try {
      labelUrl = publicHttpsUrl(rawUrl.replaceAll("&amp;", "&"), "labelUrl");
    } catch {
      throw new ShippingProviderError(
        "Aveonline returned an unsafe label URL.",
        "INVALID_RESPONSE",
      );
    }
  }
  return {
    providerReference: String(reference),
    trackingCode: String(reference),
    carrier: carrier.trim(),
    labelUrl,
  };
}

export class AveonlineShippingProvider implements ShippingProvider {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: AveonlineCredentials,
    private readonly options: {
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    numericIdentifier(credentials.companyId, "companyId");
    numericIdentifier(credentials.agentId, "agentId");
    numericIdentifier(credentials.carrierId, "carrierId");
  }

  private async request(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetchWithLimit({
        url,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 15_000,
      });
      if (response.status === 429 || response.status >= 500) {
        throw new ShippingProviderError(
          "Aveonline result is uncertain and requires reconciliation.",
          "NETWORK_UNCERTAIN",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ShippingProviderError("Aveonline rejected the HTTP request.", "HTTP_ERROR");
      }
      return parseHttpJson(response.body);
    } catch (error) {
      if (error instanceof ShippingProviderError) throw error;
      if (error instanceof IntegrationTransportError) {
        throw new ShippingProviderError(
          "Aveonline result is uncertain and requires reconciliation.",
          "NETWORK_UNCERTAIN",
        );
      }
      throw error;
    }
  }

  private async authenticate(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const response = await this.request(this.credentials.authUrl, {
      tipo: "auth",
      usuario: this.credentials.username,
      clave: this.credentials.password,
    });
    if (response.status === "error")
      throw new ShippingProviderError("Aveonline rejected its credentials.", "HTTP_ERROR");
    const token = response.token;
    if (
      response.status !== "ok" ||
      typeof token !== "string" ||
      token.length < 40 ||
      token.length > 8192
    ) {
      throw new ShippingProviderError(
        "Aveonline did not return a valid access token.",
        "INVALID_RESPONSE",
      );
    }
    let expiresAt = Date.now() + 3_300_000;
    const segments = token.split(".");
    if (segments.length === 3) {
      try {
        const payload: unknown = JSON.parse(
          Buffer.from(segments[1]!, "base64url").toString("utf8"),
        );
        const record = recordValue(payload);
        if (!record || typeof record.exp !== "number" || !Number.isSafeInteger(record.exp))
          throw new Error("exp required");
        expiresAt = record.exp * 1000;
      } catch {
        throw new ShippingProviderError(
          "Aveonline returned an invalid JWT expiration.",
          "INVALID_RESPONSE",
        );
      }
    }
    if (expiresAt <= Date.now() + 30_000 || expiresAt > Date.now() + 7_200_000) {
      throw new ShippingProviderError(
        "Aveonline token expiration is outside the accepted window.",
        "INVALID_RESPONSE",
      );
    }
    this.token = { value: token, expiresAt };
    return token;
  }

  async createLabel(input: ShippingLabelRequest): Promise<ShippingLabelResult> {
    assertIntegrationKey(input.requestKey, "requestKey");
    const token = await this.authenticate();
    const content = input.contents
      .map((item) => `${item.quantity}×${item.sku}`)
      .join(", ")
      .slice(0, 450);
    const response = await this.request(this.credentials.labelsUrl, {
      tipo: "generarGuia2",
      token,
      idempresa: this.credentials.companyId,
      codigo: this.credentials.companyCode,
      dsclavex: "Webservices",
      origen: `${input.origin.municipalityName}(${input.origin.departmentName})`,
      dsdirre: input.origin.addressLine1,
      dsbarrioo: input.origin.neighborhood ?? "",
      destino: `${input.destination.municipalityName}(${input.destination.departmentName})`,
      IdTipoEntrega: "1",
      dsdir: input.destination.addressLine1,
      dsbarrio: input.destination.neighborhood ?? "",
      dsnitre: this.credentials.companyDocument,
      dstelre: input.origin.phoneE164.replace("+", ""),
      dscelularre: input.origin.phoneE164.replace("+", ""),
      dscorreopre: input.origin.email,
      dsnit: input.destination.documentNumber,
      dsnombre: input.destination.name,
      dsnombrecompleto: input.destination.name,
      dscorreop: input.destination.email,
      dstel: input.destination.phoneE164.replace("+", ""),
      dscelular: input.destination.phoneE164.replace("+", ""),
      idtransportador: this.credentials.carrierId,
      unidades: 1,
      productos: [
        {
          alto: (input.heightMillimeters / 10).toFixed(1),
          largo: (input.lengthMillimeters / 10).toFixed(1),
          ancho: (input.widthMillimeters / 10).toFixed(1),
          peso: (input.weightGrams / 1000).toFixed(3),
          unidades: 1,
          nombre: content.slice(0, 180),
          ref: input.packageId,
          valorDeclarado: centsToDecimal(input.declaredValueCents),
        },
      ],
      dscontenido: content,
      dscom: input.orderNumber,
      idasumecosto: 0,
      contraentrega: input.cashOnDeliveryCents > 0n ? 1 : 0,
      valorrecaudo: centsToDecimal(input.cashOnDeliveryCents),
      idagente: this.credentials.agentId,
      dsreferencia: input.requestKey,
      dsordendecompra: input.orderNumber,
      bloquegenerarguia: "1",
      relacion_envios: "1",
      enviarcorreos: "0",
      numeroFactura: input.orderNumber,
      dsvalor_pedido: centsToDecimal(input.declaredValueCents),
    });
    const guide = parseGuide(response, input.requestKey);
    if (!guide)
      throw new ShippingProviderError(
        "Aveonline did not return the created guide.",
        "INVALID_RESPONSE",
      );
    return guide;
  }

  async findLabel(requestKey: string): Promise<ShippingLabelResult | null> {
    assertIntegrationKey(requestKey, "requestKey");
    const token = await this.authenticate();
    const baseUrl = this.credentials.lookupUrl.replace(
      "{requestKey}",
      encodeURIComponent(requestKey),
    );
    try {
      const response = await fetchWithLimit({
        url: baseUrl,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ tipo: "consultarGuia", token, dsreferencia: requestKey }),
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 15_000,
      });
      if (response.status === 404) return null;
      if (response.status === 429 || response.status >= 500)
        throw new ShippingProviderError(
          "Aveonline reconciliation is temporarily unavailable.",
          "NETWORK_UNCERTAIN",
        );
      if (response.status < 200 || response.status >= 300)
        throw new ShippingProviderError(
          "Aveonline rejected the reconciliation request.",
          "HTTP_ERROR",
        );
      return parseGuide(parseHttpJson(response.body), requestKey);
    } catch (error) {
      if (error instanceof ShippingProviderError) throw error;
      if (error instanceof IntegrationTransportError)
        throw new ShippingProviderError(
          "Aveonline reconciliation did not produce a result.",
          "NETWORK_UNCERTAIN",
        );
      throw error;
    }
  }
}

export function flexTrackingCode(requestKey: string): string {
  const suffix = createHash("sha256").update(requestKey).digest("hex").slice(0, 20).toUpperCase();
  return `FLEX-${suffix}`;
}

export class FlexShippingProvider implements ShippingProvider {
  async createLabel(input: ShippingLabelRequest): Promise<ShippingLabelResult> {
    assertIntegrationKey(input.requestKey, "requestKey");
    return {
      providerReference: input.requestKey,
      trackingCode: flexTrackingCode(input.requestKey),
      carrier: "FLEX",
      labelUrl: null,
    };
  }

  async findLabel(requestKey: string): Promise<ShippingLabelResult | null> {
    assertIntegrationKey(requestKey, "requestKey");
    return {
      providerReference: requestKey,
      trackingCode: flexTrackingCode(requestKey),
      carrier: "FLEX",
      labelUrl: null,
    };
  }
}
