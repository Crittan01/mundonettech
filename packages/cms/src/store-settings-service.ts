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
  readonly clickAndCollectEnabled: boolean;
  readonly localDeliveryEnabled: boolean;
}

function validateSettings(input: StoreSettingsInput) {
  if (!["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"].includes(input.taxRegime)) {
    throw new CmsValidationError("Invalid tax regime.");
  }
  if (!Number.isInteger(input.annualRevenueAlertUvt) || input.annualRevenueAlertUvt < 1) {
    throw new CmsValidationError("Annual revenue alert must be a positive integer.");
  }
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new CmsValidationError("Currency must use ISO 4217 uppercase letters.");
  try {
    new Intl.DateTimeFormat("es-CO", { timeZone: input.timeZone }).format(0);
  } catch {
    throw new CmsValidationError("Invalid IANA time zone.");
  }
  if (!/^[A-Z][A-Z0-9-]{0,11}$/.test(input.orderNumberPrefix)) {
    throw new CmsValidationError("Invalid order number prefix.");
  }
  if (
    !Number.isInteger(input.orderNumberPadding) ||
    input.orderNumberPadding < 1 ||
    input.orderNumberPadding > 12
  ) {
    throw new CmsValidationError("Order number padding must be between 1 and 12.");
  }
  if (
    typeof input.clickAndCollectEnabled !== "boolean" ||
    typeof input.localDeliveryEnabled !== "boolean"
  ) {
    throw new CmsValidationError("Operational feature flags must be boolean.");
  }
  return {
    ...input,
    currency: input.currency.toUpperCase(),
    orderNumberPrefix: input.orderNumberPrefix.toUpperCase(),
  };
}

type StoreSettingsRecord = Prisma.StoreSettingsGetPayload<{
  include: { updatedBy: { select: { id: true; displayName: true; email: true } } };
}>;

export class StoreSettingsService {
  constructor(private readonly db: PrismaClient) {}

  async get(): Promise<StoreSettingsRecord | null> {
    return this.db.storeSettings.findUnique({
      where: { key: "default" },
      include: { updatedBy: { select: { id: true, displayName: true, email: true } } },
    });
  }

  async save(input: StoreSettingsInput, audit: CmsAudit): Promise<StoreSettings> {
    const settings = validateSettings(input);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-settings-default'))`;
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
          metadata: {
            taxRegime: saved.taxRegime,
            annualRevenueAlertUvt: saved.annualRevenueAlertUvt,
            currency: saved.currency,
            timeZone: saved.timeZone,
            clickAndCollectEnabled: saved.clickAndCollectEnabled,
            localDeliveryEnabled: saved.localDeliveryEnabled,
          },
        },
      });
      return saved;
    });
  }
}
