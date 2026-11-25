import { X509Certificate, createHash } from "node:crypto";

import type { IntegrationEnvironment } from "@mundonettech/db";

import { centsToDecimal, integrationText, publicHttpsUrl } from "./integration-utils.js";
import {
  InvoiceProviderError,
  InvoiceValidationError,
  type DianCredentials,
} from "./invoice-types.js";

const keys = [
  "bearerToken",
  "providerUrl",
  "issuerNit",
  "issuerDv",
  "issuerLegalName",
  "issuerEmail",
  "issuerAddress",
  "issuerDepartmentCode",
  "issuerDepartmentName",
  "issuerMunicipalityCode",
  "issuerMunicipalityName",
  "issuerPostalCode",
  "issuerPhoneE164",
  "softwareId",
  "softwarePin",
  "invoicePrefix",
  "invoiceResolutionNumber",
  "invoiceResolutionStart",
  "invoiceResolutionEnd",
  "invoiceResolutionDate",
  "invoiceResolutionValidFrom",
  "invoiceResolutionValidTo",
  "creditNotePrefix",
] as const;

function dianCredentialObject(plaintext: Uint8Array): Record<string, unknown> {
  const bytes = Buffer.from(plaintext);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("DIAN credential must be a JSON object.");
    }
    const record = parsed as Record<string, unknown>;
    const allowed = new Set([...keys, "signatureTrustAnchorPem"]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      keys.some((key) => !Object.hasOwn(record, key))
    ) {
      throw new TypeError("DIAN credential fields do not match the provider contract.");
    }
    return record;
  } finally {
    bytes.fill(0);
  }
}

const singlePemCertificatePattern =
  /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/]{1,76}\r?\n)*[A-Za-z0-9+/=]{1,76}\r?\n-----END CERTIFICATE-----$/;

function signatureTrustAnchor(
  record: Record<string, unknown>,
  environment: IntegrationEnvironment,
): string | null {
  const value = record.signatureTrustAnchorPem;
  if (value === undefined || value === null) {
    if (environment === "PRD") {
      throw new InvoiceProviderError(
        "DIAN signature trust anchor is required in PRD.",
        "INVALID_CREDENTIAL",
      );
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new InvoiceProviderError(
      "DIAN signature trust anchor must be an X.509 PEM certificate.",
      "INVALID_CREDENTIAL",
    );
  }
  const pem = value.trim();
  if (
    pem.length < 500 ||
    pem.length > 16_384 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(pem) ||
    !singlePemCertificatePattern.test(pem)
  ) {
    throw new InvoiceProviderError("DIAN signature trust anchor is invalid.", "INVALID_CREDENTIAL");
  }
  try {
    const certificate = new X509Certificate(pem);
    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    const keyUsageAllowed =
      !certificate.keyUsage ||
      certificate.keyUsage.some((usage) =>
        /digital\s*signature|non[- ]?repudiation|content\s*commitment|1\.3\.6\.1\.5\.5\.7\.3|2\.5\.29\.15/i.test(
          usage,
        ),
      );
    if (
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo < now ||
      !keyUsageAllowed ||
      certificate.publicKey.asymmetricKeyType !== "rsa" ||
      (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("invalid certificate");
    }
  } catch {
    throw new InvoiceProviderError(
      "DIAN signature trust anchor must be a valid RSA X.509 certificate.",
      "INVALID_CREDENTIAL",
    );
  }
  return pem;
}

function text(record: Record<string, unknown>, key: string, maximum: number, minimum = 1): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new InvoiceProviderError(`DIAN credential ${key} is invalid.`, "INVALID_CREDENTIAL");
  try {
    return integrationText(value, key, maximum, minimum);
  } catch {
    throw new InvoiceProviderError(`DIAN credential ${key} is invalid.`, "INVALID_CREDENTIAL");
  }
}

function phoneE164(record: Record<string, unknown>): string {
  const value = text(record, "issuerPhoneE164", 16, 8);
  if (!/^\+[1-9][0-9]{7,14}$/.test(value)) {
    throw new InvoiceProviderError(
      "DIAN issuerPhoneE164 must contain a normalized international E.164 number.",
      "INVALID_CREDENTIAL",
    );
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new InvoiceProviderError(
      `DIAN credential ${key} must be a positive integer.`,
      "INVALID_CREDENTIAL",
    );
  }
  return value;
}

function isoDate(value: string, field: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))
    throw new InvoiceProviderError(`${field} must use YYYY-MM-DD.`, "INVALID_CREDENTIAL");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new InvoiceProviderError(`${field} is not a valid calendar date.`, "INVALID_CREDENTIAL");
  return value;
}

export function parseDianCredentials(
  plaintext: Uint8Array,
  environment: IntegrationEnvironment,
): DianCredentials {
  if (!["LOCAL", "STG", "PRD"].includes(environment))
    throw new InvoiceProviderError("DIAN environment is invalid.", "INVALID_CREDENTIAL");
  try {
    const record = dianCredentialObject(plaintext);
    const issuerNit = text(record, "issuerNit", 15, 5);
    const issuerDv = text(record, "issuerDv", 1, 1);
    if (!/^[0-9]+$/.test(issuerNit) || !/^[0-9]$/.test(issuerDv))
      throw new InvoiceProviderError(
        "DIAN issuer NIT and verification digit are invalid.",
        "INVALID_CREDENTIAL",
      );
    const departmentCode = text(record, "issuerDepartmentCode", 2, 2);
    const municipalityCode = text(record, "issuerMunicipalityCode", 5, 5);
    if (
      !/^[0-9]{2}$/.test(departmentCode) ||
      !/^[0-9]{5}$/.test(municipalityCode) ||
      municipalityCode.slice(0, 2) !== departmentCode
    ) {
      throw new InvoiceProviderError(
        "DIAN issuer DANE codes are inconsistent.",
        "INVALID_CREDENTIAL",
      );
    }
    const resolutionStart = integer(record, "invoiceResolutionStart");
    const resolutionEnd = integer(record, "invoiceResolutionEnd");
    if (resolutionEnd < resolutionStart)
      throw new InvoiceProviderError("DIAN resolution range is inverted.", "INVALID_CREDENTIAL");
    const resolutionDate = isoDate(
      text(record, "invoiceResolutionDate", 10),
      "invoiceResolutionDate",
    );
    const validFrom = isoDate(
      text(record, "invoiceResolutionValidFrom", 10),
      "invoiceResolutionValidFrom",
    );
    const validTo = isoDate(
      text(record, "invoiceResolutionValidTo", 10),
      "invoiceResolutionValidTo",
    );
    if (validTo < validFrom || resolutionDate > validTo)
      throw new InvoiceProviderError(
        "DIAN resolution validity dates are inconsistent.",
        "INVALID_CREDENTIAL",
      );
    const invoicePrefix = text(record, "invoicePrefix", 20);
    const creditNotePrefix = text(record, "creditNotePrefix", 20);
    if (!/^[A-Z0-9-]{1,20}$/.test(invoicePrefix) || !/^[A-Z0-9-]{1,20}$/.test(creditNotePrefix))
      throw new InvoiceProviderError("DIAN document prefixes are invalid.", "INVALID_CREDENTIAL");
    const softwareId = text(record, "softwareId", 64, 8);
    const softwarePin = text(record, "softwarePin", 255, 5);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(softwareId))
      throw new InvoiceProviderError("DIAN softwareId is invalid.", "INVALID_CREDENTIAL");
    const allowLoopback = environment === "LOCAL";
    return {
      bearerToken: text(record, "bearerToken", 4096, 20),
      providerUrl: publicHttpsUrl(text(record, "providerUrl", 2048), "providerUrl", {
        allowLoopback,
      }).replace(/\/$/, ""),
      issuerNit,
      issuerDv,
      issuerLegalName: text(record, "issuerLegalName", 200, 2),
      issuerEmail: text(record, "issuerEmail", 320, 3),
      issuerAddress: text(record, "issuerAddress", 200, 5),
      issuerDepartmentCode: departmentCode,
      issuerDepartmentName: text(record, "issuerDepartmentName", 120, 2),
      issuerMunicipalityCode: municipalityCode,
      issuerMunicipalityName: text(record, "issuerMunicipalityName", 120, 2),
      issuerPostalCode: text(record, "issuerPostalCode", 6, 6),
      issuerPhoneE164: phoneE164(record),
      softwareId,
      softwarePin,
      signatureTrustAnchorPem: signatureTrustAnchor(record, environment),
      invoicePrefix,
      invoiceResolutionNumber: text(record, "invoiceResolutionNumber", 40),
      invoiceResolutionStart: resolutionStart,
      invoiceResolutionEnd: resolutionEnd,
      invoiceResolutionDate: resolutionDate,
      invoiceResolutionValidFrom: validFrom,
      invoiceResolutionValidTo: validTo,
      creditNotePrefix,
    };
  } catch (error) {
    if (error instanceof InvoiceProviderError) throw error;
    throw new InvoiceProviderError(
      "DIAN credentials are not valid for the closed provider contract.",
      "INVALID_CREDENTIAL",
    );
  }
}

export function dianTimestamp(date: Date): { date: string; time: string } {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    throw new InvoiceValidationError("Fiscal issue timestamp must be valid.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  const second = value("second");
  if (!year || !month || !day || !hour || !minute || !second)
    throw new InvoiceValidationError("Unable to format the DIAN timestamp.");
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}:${second}-05:00` };
}

export interface FiscalHashInput {
  readonly fullNumber: string;
  readonly issueDate: Date;
  readonly subtotalCents: bigint;
  readonly discountCents: bigint;
  readonly lineExtensionCents?: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly issuerNit: string;
  readonly buyerDocumentNumber: string;
  readonly buyerDocumentType: string;
  readonly softwarePin: string;
  readonly production: boolean;
}

function fiscalHash(input: FiscalHashInput): string {
  const timestamp = dianTimestamp(input.issueDate);
  const lineExtensionCents = input.lineExtensionCents ?? input.subtotalCents - input.discountCents;
  const material = [
    input.fullNumber,
    timestamp.date,
    timestamp.time,
    centsToDecimal(lineExtensionCents),
    "01",
    centsToDecimal(input.taxCents),
    "04",
    "0.00",
    "03",
    "0.00",
    centsToDecimal(input.totalCents),
    input.issuerNit,
    input.buyerDocumentNumber,
    input.softwarePin,
    input.production ? "1" : "2",
  ].join("");
  return createHash("sha384").update(material, "utf8").digest("hex");
}

export function calculateCufe(input: FiscalHashInput): string {
  return fiscalHash(input);
}

export function calculateCude(input: FiscalHashInput): string {
  return fiscalHash(input);
}
