import { maskEmail, maskName, sanitizeAuditValue } from "@mundonettech/core";
import { Prisma, PrismaClient, type StoreSettings } from "@mundonettech/db";

import type { CmsAudit } from "./cms-service.js";
import { CmsValidationError } from "./cms-service.js";

export interface StoreSettingsInput {
  readonly taxRegime: "NO_RESPONSABLE_IVA" | "RESPONSABLE_IVA";
  readonly annualRevenueAlertUvt: number;
  readonly currency: string;
  readonly timeZone: string;
  readonly orderNumberPrefix: string;
  readonly orderNumberPadding: number;
  readonly uvtValueCents: string;
  readonly uvtYear: number;
  readonly standardShippingCents: string;
  readonly deliveryPromiseDays: number;
  readonly reservationMinutes: number;
  readonly clickAndCollectEnabled: boolean;
  readonly localDeliveryEnabled: boolean;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ianaTimeZonePattern = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

function cents(value: string, field: string, positive: boolean): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
    throw new CmsValidationError(`${field} must contain integer cents.`);
  }
  const parsed = BigInt(value.trim());
  if (parsed < (positive ? 1n : 0n) || parsed > 9_223_372_036_854_775_807n) {
    throw new CmsValidationError(`${field} must fit a non-negative INT8.`);
  }
  return parsed;
}

function validateSettings(input: StoreSettingsInput) {
  if (!["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"].includes(input.taxRegime)) {
    throw new CmsValidationError("Invalid tax regime.");
  }
  if (
    !Number.isSafeInteger(input.annualRevenueAlertUvt) ||
    input.annualRevenueAlertUvt < 1 ||
    input.annualRevenueAlertUvt > 2_147_483_647
  ) {
    throw new CmsValidationError("Annual revenue alert must be a positive 32-bit integer.");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CmsValidationError("Currency must use ISO 4217 uppercase letters.");
  }
  const timeZone = input.timeZone.trim();
  if (!timeZone || timeZone.length > 64 || !ianaTimeZonePattern.test(timeZone)) {
    throw new CmsValidationError("Invalid IANA time zone.");
  }
  try {
    new Intl.DateTimeFormat("es-CO", { timeZone }).format(0);
  } catch {
    throw new CmsValidationError("Invalid IANA time zone.");
  }
  const orderNumberPrefix = input.orderNumberPrefix.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,11}$/.test(orderNumberPrefix)) {
    throw new CmsValidationError("Invalid order number prefix.");
  }
  if (
    !Number.isInteger(input.orderNumberPadding) ||
    input.orderNumberPadding < 1 ||
    input.orderNumberPadding > 12
  ) {
    throw new CmsValidationError("Order number padding must be between 1 and 12.");
  }
  if (!Number.isInteger(input.uvtYear) || input.uvtYear < 2000 || input.uvtYear > 9999) {
    throw new CmsValidationError("The UVT year must be a four-digit year.");
  }
  if (
    !Number.isInteger(input.deliveryPromiseDays) ||
    input.deliveryPromiseDays < 1 ||
    input.deliveryPromiseDays > 365
  ) {
    throw new CmsValidationError("Delivery promise must be between 1 and 365 calendar days.");
  }
  if (
    !Number.isInteger(input.reservationMinutes) ||
    input.reservationMinutes < 5 ||
    input.reservationMinutes > 10_080
  ) {
    throw new CmsValidationError("Stock reservation must be between 5 and 10080 minutes.");
  }
  if (
    typeof input.clickAndCollectEnabled !== "boolean" ||
    typeof input.localDeliveryEnabled !== "boolean"
  ) {
    throw new CmsValidationError("Operational feature flags must be boolean.");
  }
  return {
    ...input,
    currency,
    timeZone,
    orderNumberPrefix,
    uvtValueCents: cents(input.uvtValueCents, "uvtValueCents", true),
    standardShippingCents: cents(input.standardShippingCents, "standardShippingCents", false),
  };
}

type StoreSettingsRecord = Prisma.StoreSettingsGetPayload<{
  include: { updatedBy: { select: { id: true; displayName: true; email: true } } };
}>;

function settingsAuditState(settings: StoreSettings): Prisma.JsonObject {
  return {
    id: settings.id,
    taxRegime: settings.taxRegime,
    annualRevenueAlertUvt: settings.annualRevenueAlertUvt,
    currency: settings.currency,
    timeZone: settings.timeZone,
    orderNumberPrefix: settings.orderNumberPrefix,
    orderNumberPadding: settings.orderNumberPadding,
    uvtValueCents: settings.uvtValueCents.toString(),
    uvtYear: settings.uvtYear,
    deliveryCents: settings.standardShippingCents.toString(),
    deliveryPromiseDays: settings.deliveryPromiseDays,
    reservationMinutes: settings.reservationMinutes,
    clickAndCollectEnabled: settings.clickAndCollectEnabled,
    localDeliveryEnabled: settings.localDeliveryEnabled,
  };
}

export class StoreSettingsService {
  constructor(private readonly db: PrismaClient) {}

  async get(): Promise<StoreSettingsRecord | null> {
    const settings = await this.db.storeSettings.findUnique({
      where: { key: "default" },
      include: { updatedBy: { select: { id: true, displayName: true, email: true } } },
    });
    if (!settings) return null;
    return {
      ...settings,
      updatedBy: settings.updatedBy
        ? {
            ...settings.updatedBy,
            displayName: maskName(settings.updatedBy.displayName),
            email: maskEmail(settings.updatedBy.email),
          }
        : null,
    };
  }

  async save(input: StoreSettingsInput, audit: CmsAudit): Promise<StoreSettings> {
    if (!uuidPattern.test(audit.actorAdminUserId)) {
      throw new CmsValidationError("actorAdminUserId must be a canonical UUID.");
    }
    const settings = validateSettings(input);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-settings-default'))`;
      const existing = await tx.storeSettings.findUnique({ where: { key: "default" } });
      const saved = await tx.storeSettings.upsert({
        where: { key: "default" },
        create: { key: "default", ...settings, updatedByAdminUserId: audit.actorAdminUserId },
        update: { ...settings, updatedByAdminUserId: audit.actorAdminUserId },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: audit.actorAdminUserId,
          action: "STORE_SETTINGS_UPDATED",
          targetType: "StoreSettings",
          targetId: saved.id,
          ipHash: audit.ipHash ? Uint8Array.from(audit.ipHash) : null,
          userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
          metadata: sanitizeAuditValue({
            before: existing ? settingsAuditState(existing) : null,
            after: settingsAuditState(saved),
          }) as Prisma.JsonObject,
        },
      });
      return saved;
    });
  }
}
