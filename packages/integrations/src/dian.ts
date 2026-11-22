import { createHash } from "node:crypto";

import type { IntegrationEnvironment } from "@mundonettech/db";

import {
  centsToDecimal,
  credentialObject,
  integrationText,
  publicHttpsUrl,
} from "./integration-utils.js";
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
    const record = credentialObject(plaintext, keys);
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
    return {
      bearerToken: text(record, "bearerToken", 4096, 20),
      providerUrl: publicHttpsUrl(text(record, "providerUrl", 2048), "providerUrl").replace(
        /\/$/,
        "",
      ),
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
      issuerPhoneE164: text(record, "issuerPhoneE164", 16, 8),
      softwareId,
      softwarePin,
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
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly issuerNit: string;
  readonly buyerDocumentNumber: string;
  readonly buyerDocumentType: string;
  readonly softwarePin: string;
}

function fiscalHash(input: FiscalHashInput): string {
  const timestamp = dianTimestamp(input.issueDate);
  const material = [
    input.fullNumber,
    timestamp.date,
    timestamp.time,
    centsToDecimal(input.subtotalCents - input.discountCents),
    "01",
    centsToDecimal(input.taxCents),
    "04",
    "0.00",
    "03",
    "0.00",
    centsToDecimal(input.totalCents),
    input.issuerNit,
    input.buyerDocumentNumber,
    input.buyerDocumentType,
    input.softwarePin,
  ].join("");
  return createHash("sha384").update(material, "utf8").digest("hex");
}

export function calculateCufe(input: FiscalHashInput): string {
  return fiscalHash(input);
}

export function calculateCude(input: FiscalHashInput): string {
  return fiscalHash(input);
}
