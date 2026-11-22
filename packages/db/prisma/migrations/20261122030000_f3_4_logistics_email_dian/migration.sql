CREATE TYPE "ShippingProviderCode" AS ENUM ('AVEONLINE', 'FLEX', 'PICKUP');
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('PENDING', 'PICKING', 'PACKED', 'LABELLED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RECONCILING');
CREATE TYPE "ShipmentPackageStatus" AS ENUM ('SEALED', 'CLAIMED', 'LABELLED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RECONCILING');
CREATE TYPE "ShipmentEventType" AS ENUM ('FULFILLMENT_CREATED', 'PICKING_STARTED', 'PACKAGE_SEALED', 'LABEL_CLAIMED', 'LABEL_GENERATED', 'PROVIDER_REJECTED', 'PROVIDER_UNCERTAIN', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'NOTE');
CREATE TYPE "EmailTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "EmailEventStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERY_DELAYED', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED', 'FAILED');
CREATE TYPE "EmailSuppressionReason" AS ENUM ('UNSUBSCRIBE', 'BOUNCE', 'COMPLAINT', 'MANUAL');
CREATE TYPE "FiscalDocumentStatus" AS ENUM ('DRAFT', 'TRANSMITTING', 'ACCEPTED', 'REJECTED', 'UNCERTAIN', 'CANCELLED');

ALTER TABLE "Order"
  ADD COLUMN "buyerDocumentTypeSnapshot" CHAR(2),
  ADD COLUMN "buyerDocumentNumberSnapshot" VARCHAR(30),
  ADD COLUMN "buyerTaxRegimeSnapshot" "StoreTaxRegime",
  ADD COLUMN "deliveryLatitudeE6" INTEGER,
  ADD COLUMN "deliveryLongitudeE6" INTEGER;
ALTER TABLE "DomainOutbox" ADD COLUMN "failedAt" TIMESTAMPTZ(6);
ALTER TABLE "Shipment"
  ADD COLUMN "localDeliveryZoneId" UUID,
  ADD COLUMN "localDriverName" VARCHAR(200),
  ADD COLUMN "localDriverPhoneE164" VARCHAR(16);
ALTER TABLE "ShipmentItem" ADD COLUMN "declaredValueCents" BIGINT;

CREATE TABLE "LocalDeliveryZone" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "municipalityCodes" JSONB NOT NULL,
  "polygon" JSONB NOT NULL,
  "baseFeeCents" BIGINT NOT NULL,
  "freeShippingThresholdCents" BIGINT,
  "cutoffMinutes" INTEGER NOT NULL,
  "deliveryPromiseMinutes" INTEGER NOT NULL,
  "createdByAdminUserId" UUID NOT NULL,
  "updatedByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "LocalDeliveryZone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderFulfillment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "shipmentId" UUID NOT NULL,
  "provider" "ShippingProviderCode" NOT NULL,
  "status" "OrderFulfillmentStatus" NOT NULL DEFAULT 'PENDING',
  "credentialId" UUID,
  "environment" "IntegrationEnvironment",
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderFulfillment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShipmentPackage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shipmentId" UUID NOT NULL,
  "packageNumber" INTEGER NOT NULL,
  "status" "ShipmentPackageStatus" NOT NULL DEFAULT 'SEALED',
  "weightGrams" INTEGER NOT NULL,
  "lengthMillimeters" INTEGER NOT NULL,
  "widthMillimeters" INTEGER NOT NULL,
  "heightMillimeters" INTEGER NOT NULL,
  "declaredValueCents" BIGINT NOT NULL,
  "requestKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "credentialId" UUID,
  "providerReference" VARCHAR(128),
  "trackingCode" VARCHAR(120),
  "labelUrl" VARCHAR(2048),
  "claimedBy" VARCHAR(120),
  "claimedAt" TIMESTAMPTZ(6),
  "claimExpiresAt" TIMESTAMPTZ(6),
  "requestStartedAt" TIMESTAMPTZ(6),
  "lastError" VARCHAR(1000),
  "labelledAt" TIMESTAMPTZ(6),
  "shippedAt" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentPackage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShipmentPackageItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "packageId" UUID NOT NULL,
  "shipmentItemId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "declaredValueCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentPackageItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShipmentEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shipmentId" UUID NOT NULL,
  "packageId" UUID,
  "actorAdminUserId" UUID,
  "type" "ShipmentEventType" NOT NULL,
  "eventKey" VARCHAR(128) NOT NULL,
  "providerEventId" VARCHAR(128),
  "payloadHash" BYTEA,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailTemplateOverride" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "templateKey" VARCHAR(80) NOT NULL,
  "locale" VARCHAR(10) NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "EmailTemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "subject" VARCHAR(200) NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT NOT NULL,
  "variables" JSONB NOT NULL DEFAULT '[]',
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailTemplateOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID,
  "credentialId" UUID NOT NULL,
  "templateKey" VARCHAR(80) NOT NULL,
  "locale" VARCHAR(10) NOT NULL DEFAULT 'es-CO',
  "topic" VARCHAR(80) NOT NULL,
  "subjectSnapshot" VARCHAR(200) NOT NULL,
  "htmlBodySnapshot" TEXT NOT NULL,
  "textBodySnapshot" TEXT NOT NULL,
  "variablesSnapshot" JSONB NOT NULL,
  "recipientEmail" VARCHAR(320) NOT NULL,
  "recipientHash" BYTEA NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "unsubscribeTokenHash" BYTEA NOT NULL,
  "status" "EmailEventStatus" NOT NULL DEFAULT 'QUEUED',
  "statusRank" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6),
  "providerMessageId" VARCHAR(128),
  "lastError" VARCHAR(1000),
  "queuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "finalAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailSuppression" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recipientHash" BYTEA NOT NULL,
  "topic" VARCHAR(80) NOT NULL,
  "reason" "EmailSuppressionReason" NOT NULL,
  "sourceEventId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailWebhookEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "credentialId" UUID NOT NULL,
  "emailEventId" UUID,
  "svixEventId" VARCHAR(128) NOT NULL,
  "eventType" VARCHAR(80) NOT NULL,
  "payloadHash" BYTEA NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(6),
  "error" VARCHAR(1000),
  CONSTRAINT "EmailWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaxInvoice" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "environment" "IntegrationEnvironment" NOT NULL,
  "prefix" VARCHAR(20) NOT NULL,
  "number" INTEGER NOT NULL,
  "fullNumber" VARCHAR(40) NOT NULL,
  "cufe" CHAR(96) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "subtotalCents" BIGINT NOT NULL,
  "discountCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "shippingCents" BIGINT NOT NULL,
  "totalCents" BIGINT NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "claimedBy" VARCHAR(120),
  "claimExpiresAt" TIMESTAMPTZ(6),
  "unsignedXml" TEXT NOT NULL,
  "signedXml" TEXT,
  "documentHash" BYTEA,
  "providerDocumentId" VARCHAR(128),
  "status" "FiscalDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  "failureCode" VARCHAR(200),
  "transmittedAt" TIMESTAMPTZ(6),
  "acceptedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaxInvoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditNote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL,
  "refundId" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "prefix" VARCHAR(20) NOT NULL,
  "number" INTEGER NOT NULL,
  "fullNumber" VARCHAR(40) NOT NULL,
  "cude" CHAR(96) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "subtotalCents" BIGINT NOT NULL,
  "discountCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "shippingCents" BIGINT NOT NULL,
  "totalCents" BIGINT NOT NULL,
  "reasonCode" INTEGER NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "claimedBy" VARCHAR(120),
  "claimExpiresAt" TIMESTAMPTZ(6),
  "unsignedXml" TEXT NOT NULL,
  "signedXml" TEXT,
  "documentHash" BYTEA,
  "providerDocumentId" VARCHAR(128),
  "status" "FiscalDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  "failureCode" VARCHAR(200),
  "transmittedAt" TIMESTAMPTZ(6),
  "acceptedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LocalDeliveryZone" ADD CONSTRAINT "LocalDeliveryZone_createdBy_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalDeliveryZone" ADD CONSTRAINT "LocalDeliveryZone_updatedBy_fkey" FOREIGN KEY ("updatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_localDeliveryZoneId_fkey" FOREIGN KEY ("localDeliveryZoneId") REFERENCES "LocalDeliveryZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentPackage" ADD CONSTRAINT "ShipmentPackage_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentPackage" ADD CONSTRAINT "ShipmentPackage_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentPackageItem" ADD CONSTRAINT "ShipmentPackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ShipmentPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentPackageItem" ADD CONSTRAINT "ShipmentPackageItem_shipmentItemId_fkey" FOREIGN KEY ("shipmentItemId") REFERENCES "ShipmentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ShipmentPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_actorAdminUserId_fkey" FOREIGN KEY ("actorAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailTemplateOverride" ADD CONSTRAINT "EmailTemplateOverride_createdBy_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "EmailEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailWebhookEvent" ADD CONSTRAINT "EmailWebhookEvent_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailWebhookEvent" ADD CONSTRAINT "EmailWebhookEvent_emailEventId_fkey" FOREIGN KEY ("emailEventId") REFERENCES "EmailEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "LocalDeliveryZone_code_active_key" ON "LocalDeliveryZone"("code") WHERE "deletedAt" IS NULL;
CREATE INDEX "LocalDeliveryZone_active_deletedAt_idx" ON "LocalDeliveryZone"("active", "deletedAt");
CREATE INDEX "Shipment_localDeliveryZoneId_status_idx" ON "Shipment"("localDeliveryZoneId", "status");
CREATE UNIQUE INDEX "OrderFulfillment_shipmentId_key" ON "OrderFulfillment"("shipmentId");
CREATE INDEX "OrderFulfillment_orderId_status_createdAt_idx" ON "OrderFulfillment"("orderId", "status", "createdAt");
CREATE INDEX "OrderFulfillment_status_provider_createdAt_idx" ON "OrderFulfillment"("status", "provider", "createdAt");
CREATE INDEX "OrderFulfillment_credentialId_status_idx" ON "OrderFulfillment"("credentialId", "status");
CREATE UNIQUE INDEX "ShipmentPackage_shipmentId_packageNumber_key" ON "ShipmentPackage"("shipmentId", "packageNumber");
CREATE UNIQUE INDEX "ShipmentPackage_requestKey_key" ON "ShipmentPackage"("requestKey");
CREATE UNIQUE INDEX "ShipmentPackage_trackingCode_key" ON "ShipmentPackage"("trackingCode");
CREATE UNIQUE INDEX "ShipmentPackage_one_active_claim_key" ON "ShipmentPackage"("shipmentId") WHERE "status" IN ('CLAIMED', 'RECONCILING');
CREATE INDEX "ShipmentPackage_status_claimExpiresAt_createdAt_idx" ON "ShipmentPackage"("status", "claimExpiresAt", "createdAt");
CREATE INDEX "ShipmentPackage_credentialId_status_idx" ON "ShipmentPackage"("credentialId", "status");
CREATE UNIQUE INDEX "ShipmentPackageItem_packageId_shipmentItemId_key" ON "ShipmentPackageItem"("packageId", "shipmentItemId");
CREATE INDEX "ShipmentPackageItem_shipmentItemId_packageId_idx" ON "ShipmentPackageItem"("shipmentItemId", "packageId");
CREATE UNIQUE INDEX "ShipmentEvent_eventKey_key" ON "ShipmentEvent"("eventKey");
CREATE UNIQUE INDEX "ShipmentEvent_shipmentId_providerEventId_key" ON "ShipmentEvent"("shipmentId", "providerEventId");
CREATE INDEX "ShipmentEvent_shipmentId_occurredAt_id_idx" ON "ShipmentEvent"("shipmentId", "occurredAt", "id");
CREATE INDEX "ShipmentEvent_packageId_occurredAt_idx" ON "ShipmentEvent"("packageId", "occurredAt");
CREATE UNIQUE INDEX "EmailTemplateOverride_templateKey_locale_version_key" ON "EmailTemplateOverride"("templateKey", "locale", "version");
CREATE UNIQUE INDEX "EmailTemplateOverride_one_published_key" ON "EmailTemplateOverride"("templateKey", "locale") WHERE "status" = 'PUBLISHED';
CREATE INDEX "EmailTemplateOverride_templateKey_locale_status_version_idx" ON "EmailTemplateOverride"("templateKey", "locale", "status", "version");
CREATE UNIQUE INDEX "EmailEvent_idempotencyKey_key" ON "EmailEvent"("idempotencyKey");
CREATE UNIQUE INDEX "EmailEvent_credentialId_providerMessageId_key" ON "EmailEvent"("credentialId", "providerMessageId");
CREATE INDEX "EmailEvent_status_nextAttemptAt_queuedAt_idx" ON "EmailEvent"("status", "nextAttemptAt", "queuedAt");
CREATE INDEX "EmailEvent_recipientHash_topic_createdAt_idx" ON "EmailEvent"("recipientHash", "topic", "createdAt");
CREATE INDEX "EmailEvent_orderId_createdAt_idx" ON "EmailEvent"("orderId", "createdAt");
CREATE UNIQUE INDEX "EmailSuppression_recipientHash_topic_key" ON "EmailSuppression"("recipientHash", "topic");
CREATE INDEX "EmailSuppression_sourceEventId_idx" ON "EmailSuppression"("sourceEventId");
CREATE UNIQUE INDEX "EmailWebhookEvent_credentialId_svixEventId_key" ON "EmailWebhookEvent"("credentialId", "svixEventId");
CREATE INDEX "EmailWebhookEvent_emailEventId_occurredAt_idx" ON "EmailWebhookEvent"("emailEventId", "occurredAt");
CREATE UNIQUE INDEX "TaxInvoice_orderId_key" ON "TaxInvoice"("orderId");
CREATE UNIQUE INDEX "TaxInvoice_credentialId_prefix_number_key" ON "TaxInvoice"("credentialId", "prefix", "number");
CREATE UNIQUE INDEX "TaxInvoice_credentialId_fullNumber_key" ON "TaxInvoice"("credentialId", "fullNumber");
CREATE UNIQUE INDEX "TaxInvoice_cufe_key" ON "TaxInvoice"("cufe");
CREATE INDEX "TaxInvoice_status_createdAt_idx" ON "TaxInvoice"("status", "createdAt");
CREATE UNIQUE INDEX "CreditNote_refundId_key" ON "CreditNote"("refundId");
CREATE UNIQUE INDEX "CreditNote_credentialId_prefix_number_key" ON "CreditNote"("credentialId", "prefix", "number");
CREATE UNIQUE INDEX "CreditNote_credentialId_fullNumber_key" ON "CreditNote"("credentialId", "fullNumber");
CREATE UNIQUE INDEX "CreditNote_cude_key" ON "CreditNote"("cude");
CREATE INDEX "CreditNote_invoiceId_status_createdAt_idx" ON "CreditNote"("invoiceId", "status", "createdAt");
CREATE INDEX "DomainOutbox_failedAt_availableAt_idx" ON "DomainOutbox"("failedAt", "availableAt", "claimExpiresAt");

ALTER TABLE "Order" DROP CONSTRAINT "Order_checkout_snapshot_complete";
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_checkout_snapshot_complete" CHECK (
    "cartId" IS NULL OR (
      "fulfillmentMethod" IS NOT NULL AND "taxRegime" IS NOT NULL AND "uvtValueCents" > 0 AND
      "uvtYear" BETWEEN 2000 AND 9999 AND "emailSnapshot" IS NOT NULL AND "recipientNameSnapshot" IS NOT NULL AND
      "phoneE164Snapshot" IS NOT NULL AND "departmentCode" IS NOT NULL AND "addressLine1Snapshot" IS NOT NULL AND
      "deliveryPromiseAt" IS NOT NULL AND "reservationKey" IS NOT NULL AND "reservationExpiresAt" IS NOT NULL AND
      (("fulfillmentMethod" IN ('HOME_DELIVERY', 'LOCAL_DELIVERY') AND "clickCollectLocationId" IS NULL) OR
       ("fulfillmentMethod" = 'CLICK_COLLECT' AND "clickCollectLocationId" IS NOT NULL))
    )
  ),
  ADD CONSTRAINT "Order_delivery_coordinates_valid" CHECK (
    (("deliveryLatitudeE6" IS NULL) = ("deliveryLongitudeE6" IS NULL)) AND
    ("deliveryLatitudeE6" IS NULL OR ("deliveryLatitudeE6" BETWEEN -90000000 AND 90000000 AND "deliveryLongitudeE6" BETWEEN -180000000 AND 180000000)) AND
    ("fulfillmentMethod" IS DISTINCT FROM 'LOCAL_DELIVERY' OR "deliveryLatitudeE6" IS NOT NULL)
  ),
  ADD CONSTRAINT "Order_buyer_document_valid" CHECK (
    (("buyerDocumentTypeSnapshot" IS NULL) = ("buyerDocumentNumberSnapshot" IS NULL)) AND
    ("buyerDocumentTypeSnapshot" IS NULL OR "buyerDocumentTypeSnapshot" IN ('11', '12', '13', '21', '22', '31', '41', '42', '50', '91')) AND
    ("buyerDocumentNumberSnapshot" IS NULL OR "buyerDocumentNumberSnapshot" ~ '^[A-Za-z0-9.-]{3,30}$') AND
    (("taxRegime" IS DISTINCT FROM 'RESPONSABLE_IVA' AND "fulfillmentMethod" IS DISTINCT FROM 'HOME_DELIVERY') OR "buyerDocumentTypeSnapshot" IS NOT NULL)
  ),
  ADD CONSTRAINT "Order_buyer_fiscal_regime_valid" CHECK (
    "taxRegime" IS DISTINCT FROM 'RESPONSABLE_IVA' OR "buyerTaxRegimeSnapshot" IS NOT NULL
  );
ALTER TABLE "DomainOutbox"
  ADD CONSTRAINT "DomainOutbox_failure_consistent" CHECK (
    "failedAt" IS NULL OR ("processedAt" IS NULL AND "claimedAt" IS NULL AND "claimedBy" IS NULL AND "claimExpiresAt" IS NULL AND "lastError" IS NOT NULL)
  );
ALTER TABLE "Shipment"
  ADD CONSTRAINT "Shipment_local_driver_consistent" CHECK (
    (("localDriverName" IS NULL) = ("localDriverPhoneE164" IS NULL)) AND
    ("localDriverName" IS NULL OR ("localDriverName" = btrim("localDriverName") AND char_length("localDriverName") BETWEEN 2 AND 200 AND "localDriverPhoneE164" ~ '^\+[1-9][0-9]{7,14}$'))
  );
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_declared_value_nonnegative" CHECK ("declaredValueCents" IS NULL OR "declaredValueCents" >= 0);
ALTER TABLE "LocalDeliveryZone"
  ADD CONSTRAINT "LocalDeliveryZone_identity_valid" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$' AND "name" = btrim("name") AND char_length("name") BETWEEN 2 AND 120),
  ADD CONSTRAINT "LocalDeliveryZone_money_nonnegative" CHECK ("baseFeeCents" >= 0 AND ("freeShippingThresholdCents" IS NULL OR "freeShippingThresholdCents" >= 0)),
  ADD CONSTRAINT "LocalDeliveryZone_schedule_valid" CHECK ("cutoffMinutes" BETWEEN 0 AND 1439 AND "deliveryPromiseMinutes" BETWEEN 5 AND 10080),
  ADD CONSTRAINT "LocalDeliveryZone_municipalities_array" CHECK (jsonb_typeof("municipalityCodes") = 'array' AND jsonb_array_length("municipalityCodes") > 0),
  ADD CONSTRAINT "LocalDeliveryZone_polygon_array" CHECK (jsonb_typeof("polygon") = 'array' AND jsonb_array_length("polygon") >= 3);
ALTER TABLE "OrderFulfillment"
  ADD CONSTRAINT "OrderFulfillment_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "OrderFulfillment_provider_configuration" CHECK (
    ("provider" = 'AVEONLINE' AND "credentialId" IS NOT NULL AND "environment" IS NOT NULL) OR
    ("provider" IN ('FLEX', 'PICKUP') AND "credentialId" IS NULL AND "environment" IS NULL)
  );
ALTER TABLE "ShipmentPackage"
  ADD CONSTRAINT "ShipmentPackage_dimensions_positive" CHECK ("packageNumber" > 0 AND "weightGrams" > 0 AND "lengthMillimeters" > 0 AND "widthMillimeters" > 0 AND "heightMillimeters" > 0),
  ADD CONSTRAINT "ShipmentPackage_declared_value_nonnegative" CHECK ("declaredValueCents" >= 0),
  ADD CONSTRAINT "ShipmentPackage_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "ShipmentPackage_claim_consistent" CHECK (
    ("status" IN ('CLAIMED', 'RECONCILING') AND "claimedBy" IS NOT NULL AND "claimedAt" IS NOT NULL AND "claimExpiresAt" IS NOT NULL) OR
    ("status" NOT IN ('CLAIMED', 'RECONCILING'))
  ),
  ADD CONSTRAINT "ShipmentPackage_label_consistent" CHECK (
    ("status" IN ('LABELLED', 'SHIPPED', 'DELIVERED') AND "trackingCode" IS NOT NULL AND "labelledAt" IS NOT NULL) OR
    ("status" NOT IN ('LABELLED', 'SHIPPED', 'DELIVERED'))
  ),
  ADD CONSTRAINT "ShipmentPackage_delivery_consistent" CHECK (
    ("status" = 'SHIPPED' AND "shippedAt" IS NOT NULL AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'DELIVERED' AND "shippedAt" IS NOT NULL AND "deliveredAt" IS NOT NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "deliveredAt" IS NULL) OR
    ("status" NOT IN ('SHIPPED', 'DELIVERED', 'CANCELLED'))
  );
ALTER TABLE "ShipmentPackageItem"
  ADD CONSTRAINT "ShipmentPackageItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "ShipmentPackageItem_declared_value_nonnegative" CHECK ("declaredValueCents" >= 0);
ALTER TABLE "ShipmentEvent"
  ADD CONSTRAINT "ShipmentEvent_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  ADD CONSTRAINT "ShipmentEvent_payloadHash_length" CHECK ("payloadHash" IS NULL OR octet_length("payloadHash") = 32);
ALTER TABLE "EmailTemplateOverride"
  ADD CONSTRAINT "EmailTemplateOverride_identity_valid" CHECK ("templateKey" ~ '^[a-z][a-z0-9.-]{1,79}$' AND "locale" = 'es-CO' AND "version" > 0),
  ADD CONSTRAINT "EmailTemplateOverride_content_valid" CHECK (
    "subject" = btrim("subject") AND char_length("subject") BETWEEN 1 AND 200 AND
    char_length("htmlBody") BETWEEN 1 AND 200000 AND char_length("textBody") BETWEEN 1 AND 100000 AND
    "subject" !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "EmailTemplateOverride_variables_array" CHECK (jsonb_typeof("variables") = 'array');
ALTER TABLE "EmailEvent"
  ADD CONSTRAINT "EmailEvent_hashes_length" CHECK (octet_length("recipientHash") = 32 AND octet_length("unsubscribeTokenHash") = 32),
  ADD CONSTRAINT "EmailEvent_identity_valid" CHECK ("templateKey" ~ '^[a-z][a-z0-9.-]{1,79}$' AND "locale" = 'es-CO' AND "topic" ~ '^[a-z][a-z0-9.-]{1,79}$' AND "recipientEmail" = btrim("recipientEmail") AND "idempotencyKey" ~ '^[A-Za-z0-9._:-]{3,128}$'),
  ADD CONSTRAINT "EmailEvent_attempts_nonnegative" CHECK ("attemptCount" >= 0),
  ADD CONSTRAINT "EmailEvent_status_rank_valid" CHECK ("statusRank" = CASE "status" WHEN 'QUEUED' THEN 0 WHEN 'SENDING' THEN 10 WHEN 'SENT' THEN 20 WHEN 'DELIVERY_DELAYED' THEN 25 WHEN 'DELIVERED' THEN 30 WHEN 'BOUNCED' THEN 50 WHEN 'COMPLAINED' THEN 60 WHEN 'SUPPRESSED' THEN 70 WHEN 'CANCELLED' THEN 70 WHEN 'FAILED' THEN 70 END),
  ADD CONSTRAINT "EmailEvent_final_consistent" CHECK (("status" IN ('BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED', 'FAILED')) = ("finalAt" IS NOT NULL));
ALTER TABLE "EmailSuppression"
  ADD CONSTRAINT "EmailSuppression_recipientHash_length" CHECK (octet_length("recipientHash") = 32),
  ADD CONSTRAINT "EmailSuppression_topic_valid" CHECK ("topic" ~ '^[a-z][a-z0-9.-]{1,79}$');
ALTER TABLE "EmailWebhookEvent"
  ADD CONSTRAINT "EmailWebhookEvent_payloadHash_length" CHECK (octet_length("payloadHash") = 32),
  ADD CONSTRAINT "EmailWebhookEvent_processing_consistent" CHECK ("processedAt" IS NULL OR "error" IS NULL);
ALTER TABLE "TaxInvoice"
  ADD CONSTRAINT "TaxInvoice_number_valid" CHECK ("prefix" ~ '^[A-Z0-9-]{1,20}$' AND "number" > 0 AND "fullNumber" = "prefix" || "number"::text),
  ADD CONSTRAINT "TaxInvoice_cufe_valid" CHECK ("cufe" ~ '^[0-9a-f]{96}$'),
  ADD CONSTRAINT "TaxInvoice_money_nonnegative" CHECK ("subtotalCents" >= 0 AND "discountCents" >= 0 AND "taxCents" >= 0 AND "shippingCents" >= 0 AND "totalCents" >= 0),
  ADD CONSTRAINT "TaxInvoice_total_balanced" CHECK ("totalCents" = "subtotalCents" - "discountCents" + "taxCents" + "shippingCents"),
  ADD CONSTRAINT "TaxInvoice_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "TaxInvoice_accepted_consistent" CHECK (("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL) AND ("status" <> 'ACCEPTED' OR ("signedXml" IS NOT NULL AND octet_length("documentHash") = 32)));
ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_number_valid" CHECK ("prefix" ~ '^[A-Z0-9-]{1,20}$' AND "number" > 0 AND "fullNumber" = "prefix" || "number"::text),
  ADD CONSTRAINT "CreditNote_cude_valid" CHECK ("cude" ~ '^[0-9a-f]{96}$'),
  ADD CONSTRAINT "CreditNote_money_nonnegative" CHECK ("subtotalCents" >= 0 AND "discountCents" >= 0 AND "taxCents" >= 0 AND "shippingCents" >= 0 AND "totalCents" > 0),
  ADD CONSTRAINT "CreditNote_total_balanced" CHECK ("totalCents" = "subtotalCents" - "discountCents" + "taxCents" + "shippingCents"),
  ADD CONSTRAINT "CreditNote_reason_valid" CHECK ("reasonCode" BETWEEN 1 AND 6),
  ADD CONSTRAINT "CreditNote_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "CreditNote_accepted_consistent" CHECK (("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL) AND ("status" <> 'ACCEPTED' OR ("signedXml" IS NOT NULL AND octet_length("documentHash") = 32)));

ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_claim_consistent" CHECK (("claimedBy" IS NULL) = ("claimExpiresAt" IS NULL));
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_claim_consistent" CHECK (("claimedBy" IS NULL) = ("claimExpiresAt" IS NULL));

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['LocalDeliveryZone', 'OrderFulfillment', 'ShipmentPackage', 'EmailTemplateOverride', 'EmailEvent', 'TaxInvoice', 'CreditNote'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION "enforce_order_f3_4_snapshots"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."orderStatus" <> 'PENDING' AND (
    NEW."buyerDocumentTypeSnapshot" IS DISTINCT FROM OLD."buyerDocumentTypeSnapshot" OR
    NEW."buyerDocumentNumberSnapshot" IS DISTINCT FROM OLD."buyerDocumentNumberSnapshot" OR
    NEW."buyerTaxRegimeSnapshot" IS DISTINCT FROM OLD."buyerTaxRegimeSnapshot" OR
    NEW."deliveryLatitudeE6" IS DISTINCT FROM OLD."deliveryLatitudeE6" OR
    NEW."deliveryLongitudeE6" IS DISTINCT FROM OLD."deliveryLongitudeE6"
  ) THEN
    RAISE EXCEPTION 'Order fiscal and delivery coordinates are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_enforce_f3_4_snapshots" BEFORE UPDATE ON "Order"
FOR EACH ROW EXECUTE FUNCTION "enforce_order_f3_4_snapshots"();

CREATE FUNCTION "enforce_shipment_logistics"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."localDeliveryZoneId" IS DISTINCT FROM OLD."localDeliveryZoneId" OR
     (OLD."status" IN ('SHIPPED', 'DELIVERED', 'CANCELLED') AND
      (NEW."localDriverName" IS DISTINCT FROM OLD."localDriverName" OR NEW."localDriverPhoneE164" IS DISTINCT FROM OLD."localDriverPhoneE164")) THEN
    RAISE EXCEPTION 'Shipment logistics assignment is immutable after dispatch' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Shipment_enforce_logistics" BEFORE UPDATE ON "Shipment"
FOR EACH ROW EXECUTE FUNCTION "enforce_shipment_logistics"();

CREATE FUNCTION "enforce_fulfillment_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_shipment "Shipment";
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Fulfillment history cannot be deleted' USING ERRCODE = '55000'; END IF;
  SELECT * INTO parent_shipment FROM "Shipment" WHERE "id" = NEW."shipmentId";
  IF parent_shipment."orderId" <> NEW."orderId" THEN RAISE EXCEPTION 'Fulfillment order and shipment do not match' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId" OR
       NEW."provider" IS DISTINCT FROM OLD."provider" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
       NEW."environment" IS DISTINCT FROM OLD."environment" OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Fulfillment identity is immutable and versions are monotonic' USING ERRCODE = '55000';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'PENDING' AND NEW."status" IN ('PICKING', 'CANCELLED')) OR
      (OLD."status" = 'PICKING' AND NEW."status" IN ('PACKED', 'CANCELLED')) OR
      (OLD."status" = 'PACKED' AND NEW."status" IN ('LABELLED', 'RECONCILING', 'CANCELLED')) OR
      (OLD."status" = 'RECONCILING' AND NEW."status" IN ('PACKED', 'LABELLED', 'CANCELLED')) OR
      (OLD."status" = 'LABELLED' AND NEW."status" IN ('SHIPPED', 'CANCELLED')) OR
      (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
    ) THEN RAISE EXCEPTION 'Invalid fulfillment status transition' USING ERRCODE = '55000'; END IF;
    IF OLD."status" IN ('DELIVERED', 'CANCELLED') THEN RAISE EXCEPTION 'Terminal fulfillments are immutable' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderFulfillment_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "OrderFulfillment"
FOR EACH ROW EXECUTE FUNCTION "enforce_fulfillment_state"();

CREATE FUNCTION "enforce_package_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Package history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId" OR NEW."packageNumber" IS DISTINCT FROM OLD."packageNumber" OR
       NEW."weightGrams" IS DISTINCT FROM OLD."weightGrams" OR NEW."lengthMillimeters" IS DISTINCT FROM OLD."lengthMillimeters" OR
       NEW."widthMillimeters" IS DISTINCT FROM OLD."widthMillimeters" OR NEW."heightMillimeters" IS DISTINCT FROM OLD."heightMillimeters" OR
       NEW."declaredValueCents" IS DISTINCT FROM OLD."declaredValueCents" OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey" OR
       NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
       (OLD."trackingCode" IS NOT NULL AND NEW."trackingCode" IS DISTINCT FROM OLD."trackingCode") OR
       (OLD."providerReference" IS NOT NULL AND NEW."providerReference" IS DISTINCT FROM OLD."providerReference") THEN
      RAISE EXCEPTION 'Package identity, physical measurements and claim request are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'SEALED' AND NEW."status" IN ('CLAIMED', 'CANCELLED')) OR
      (OLD."status" = 'CLAIMED' AND NEW."status" IN ('SEALED', 'LABELLED', 'RECONCILING', 'CANCELLED')) OR
      (OLD."status" = 'RECONCILING' AND NEW."status" IN ('SEALED', 'LABELLED', 'CANCELLED')) OR
      (OLD."status" = 'LABELLED' AND NEW."status" IN ('SHIPPED', 'CANCELLED')) OR
      (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
    ) THEN RAISE EXCEPTION 'Invalid package status transition' USING ERRCODE = '55000'; END IF;
    IF OLD."status" IN ('DELIVERED', 'CANCELLED') THEN RAISE EXCEPTION 'Terminal packages are immutable' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ShipmentPackage_enforce_state" BEFORE UPDATE OR DELETE ON "ShipmentPackage"
FOR EACH ROW EXECUTE FUNCTION "enforce_package_state"();
CREATE TRIGGER "ShipmentPackageItem_append_only" BEFORE UPDATE OR DELETE ON "ShipmentPackageItem"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "validate_package_balance"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_shipment UUID;
BEGIN
  IF TG_TABLE_NAME = 'ShipmentPackage' THEN target_shipment := NEW."shipmentId";
  ELSE SELECT "shipmentId" INTO target_shipment FROM "ShipmentPackage" WHERE "id" = NEW."packageId"; END IF;
  IF EXISTS (
    SELECT 1 FROM "ShipmentPackageItem" package_item
    JOIN "ShipmentPackage" package ON package."id" = package_item."packageId"
    JOIN "ShipmentItem" shipment_item ON shipment_item."id" = package_item."shipmentItemId"
    WHERE package."shipmentId" = target_shipment AND shipment_item."shipmentId" <> target_shipment
  ) THEN RAISE EXCEPTION 'Package contents belong to another shipment' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "ShipmentPackage" package
    WHERE package."shipmentId" = target_shipment AND package."status" <> 'CANCELLED' AND
      (SELECT COALESCE(sum(item."declaredValueCents"), 0) FROM "ShipmentPackageItem" item WHERE item."packageId" = package."id") <> package."declaredValueCents"
  ) THEN RAISE EXCEPTION 'Package declared value does not match its contents' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "OrderFulfillment" fulfillment
    WHERE fulfillment."shipmentId" = target_shipment AND fulfillment."status" IN ('PACKED', 'LABELLED', 'SHIPPED', 'DELIVERED', 'RECONCILING') AND EXISTS (
      SELECT 1 FROM "ShipmentItem" expected
      WHERE expected."shipmentId" = target_shipment AND (
        (SELECT COALESCE(sum(content."quantity"), 0) FROM "ShipmentPackageItem" content JOIN "ShipmentPackage" package ON package."id" = content."packageId" AND package."status" <> 'CANCELLED' WHERE content."shipmentItemId" = expected."id") <> expected."quantity" OR
        (expected."declaredValueCents" IS NOT NULL AND
          (SELECT COALESCE(sum(content."declaredValueCents"), 0) FROM "ShipmentPackageItem" content JOIN "ShipmentPackage" package ON package."id" = content."packageId" AND package."status" <> 'CANCELLED' WHERE content."shipmentItemId" = expected."id") <> expected."declaredValueCents")
      )
    )
  ) THEN RAISE EXCEPTION 'Packed quantities or declared values do not cover the shipment' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ShipmentPackage_validate_balance" AFTER INSERT OR UPDATE ON "ShipmentPackage"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_package_balance"();
CREATE CONSTRAINT TRIGGER "ShipmentPackageItem_validate_balance" AFTER INSERT ON "ShipmentPackageItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_package_balance"();

CREATE FUNCTION "enforce_shipment_event"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN RAISE EXCEPTION 'Shipment events are append-only' USING ERRCODE = '55000'; END IF;
  IF NEW."packageId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ShipmentPackage" WHERE "id" = NEW."packageId" AND "shipmentId" = NEW."shipmentId") THEN
    RAISE EXCEPTION 'Shipment event package belongs to another shipment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ShipmentEvent_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "ShipmentEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_shipment_event"();

CREATE FUNCTION "enforce_email_template_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email template history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."templateKey" IS DISTINCT FROM OLD."templateKey" OR NEW."locale" IS DISTINCT FROM OLD."locale" OR
     NEW."version" IS DISTINCT FROM OLD."version" OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'DRAFT' AND NEW."status" IN ('PUBLISHED', 'ARCHIVED') OR OLD."status" = 'PUBLISHED' AND NEW."status" = 'ARCHIVED') OR
     OLD."status" <> 'DRAFT' AND (NEW."subject" IS DISTINCT FROM OLD."subject" OR NEW."htmlBody" IS DISTINCT FROM OLD."htmlBody" OR NEW."textBody" IS DISTINCT FROM OLD."textBody" OR NEW."variables" IS DISTINCT FROM OLD."variables") OR
     OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'Email template identity and published content are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailTemplateOverride_enforce_state" BEFORE UPDATE OR DELETE ON "EmailTemplateOverride"
FOR EACH ROW EXECUTE FUNCTION "enforce_email_template_state"();

CREATE FUNCTION "enforce_email_event_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email events cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
     NEW."templateKey" IS DISTINCT FROM OLD."templateKey" OR NEW."locale" IS DISTINCT FROM OLD."locale" OR NEW."topic" IS DISTINCT FROM OLD."topic" OR
     NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail" OR NEW."recipientHash" IS DISTINCT FROM OLD."recipientHash" OR
     NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."unsubscribeTokenHash" IS DISTINCT FROM OLD."unsubscribeTokenHash" OR
     NEW."statusRank" < OLD."statusRank" OR NEW."attemptCount" < OLD."attemptCount" OR
     (OLD."providerMessageId" IS NOT NULL AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId") OR
     OLD."status" IN ('BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED', 'FAILED') THEN
    RAISE EXCEPTION 'Email identity is immutable and delivery status must be monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailEvent_enforce_state" BEFORE UPDATE OR DELETE ON "EmailEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_email_event_state"();
CREATE TRIGGER "EmailSuppression_append_only" BEFORE UPDATE OR DELETE ON "EmailSuppression"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "enforce_email_webhook_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email webhook history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."emailEventId" IS DISTINCT FROM OLD."emailEventId" OR
     NEW."svixEventId" IS DISTINCT FROM OLD."svixEventId" OR NEW."eventType" IS DISTINCT FROM OLD."eventType" OR
     NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash" OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" THEN
    RAISE EXCEPTION 'Email webhook identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailWebhookEvent_enforce_state" BEFORE UPDATE OR DELETE ON "EmailWebhookEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_email_webhook_state"();

CREATE FUNCTION "enforce_tax_invoice_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Fiscal documents cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."prefix" IS DISTINCT FROM OLD."prefix" OR
     NEW."number" IS DISTINCT FROM OLD."number" OR NEW."fullNumber" IS DISTINCT FROM OLD."fullNumber" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."unsignedXml" IS DISTINCT FROM OLD."unsignedXml" OR
     NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."cufe" IS DISTINCT FROM OLD."cufe" OR
     NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR NEW."discountCents" IS DISTINCT FROM OLD."discountCents" OR
     NEW."taxCents" IS DISTINCT FROM OLD."taxCents" OR NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents" OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR
     (OLD."signedXml" IS NOT NULL AND NEW."signedXml" IS DISTINCT FROM OLD."signedXml") OR
     OLD."status" IN ('ACCEPTED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Fiscal identity, references and financial snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('TRANSMITTING', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'TRANSMITTING' AND NEW."status" IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN')) OR
    (OLD."status" = 'UNCERTAIN' AND NEW."status" IN ('TRANSMITTING', 'ACCEPTED', 'REJECTED'))
  ) THEN RAISE EXCEPTION 'Invalid fiscal document status transition' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "TaxInvoice_enforce_state" BEFORE UPDATE OR DELETE ON "TaxInvoice" FOR EACH ROW EXECUTE FUNCTION "enforce_tax_invoice_state"();

CREATE FUNCTION "enforce_credit_note_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Fiscal documents cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."prefix" IS DISTINCT FROM OLD."prefix" OR
     NEW."number" IS DISTINCT FROM OLD."number" OR NEW."fullNumber" IS DISTINCT FROM OLD."fullNumber" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."unsignedXml" IS DISTINCT FROM OLD."unsignedXml" OR
     NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" OR NEW."refundId" IS DISTINCT FROM OLD."refundId" OR NEW."cude" IS DISTINCT FROM OLD."cude" OR
     NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR NEW."discountCents" IS DISTINCT FROM OLD."discountCents" OR
     NEW."taxCents" IS DISTINCT FROM OLD."taxCents" OR NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents" OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR
     (OLD."signedXml" IS NOT NULL AND NEW."signedXml" IS DISTINCT FROM OLD."signedXml") OR
     OLD."status" IN ('ACCEPTED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Fiscal identity, references and financial snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('TRANSMITTING', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'TRANSMITTING' AND NEW."status" IN ('ACCEPTED', 'REJECTED', 'UNCERTAIN')) OR
    (OLD."status" = 'UNCERTAIN' AND NEW."status" IN ('TRANSMITTING', 'ACCEPTED', 'REJECTED'))
  ) THEN RAISE EXCEPTION 'Invalid fiscal document status transition' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CreditNote_enforce_state" BEFORE UPDATE OR DELETE ON "CreditNote" FOR EACH ROW EXECUTE FUNCTION "enforce_credit_note_state"();

CREATE FUNCTION "validate_tax_invoice_document"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "taxRegime" = 'RESPONSABLE_IVA' AND "paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND
    "subtotalCents" = NEW."subtotalCents" AND "discountCents" = NEW."discountCents" AND "taxCents" = NEW."taxCents" AND "shippingCents" = NEW."shippingCents" AND "totalCents" = NEW."totalCents") THEN
    RAISE EXCEPTION 'Tax invoice does not match its paid responsible-VAT order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "TaxInvoice_validate_document" AFTER INSERT OR UPDATE ON "TaxInvoice"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_tax_invoice_document"();

CREATE FUNCTION "validate_credit_note_document"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrderRefund" refund JOIN "TaxInvoice" invoice ON invoice."orderId" = refund."orderId"
    WHERE refund."id" = NEW."refundId" AND refund."status" = 'COMPLETED' AND invoice."id" = NEW."invoiceId" AND invoice."status" = 'ACCEPTED' AND
      refund."subtotalCents" = NEW."subtotalCents" - NEW."discountCents" AND refund."taxCents" = NEW."taxCents" AND refund."shippingCents" = NEW."shippingCents" AND refund."totalCents" = NEW."totalCents"
  ) THEN RAISE EXCEPTION 'Credit note does not match its completed refund and accepted invoice' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "CreditNote_validate_document" AFTER INSERT OR UPDATE ON "CreditNote"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_credit_note_document"();

CREATE OR REPLACE FUNCTION "claim_domain_outbox"(p_worker_id TEXT, p_limit INTEGER, p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
RETURNS SETOF "DomainOutbox" LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_worker_id <> btrim(p_worker_id) OR char_length(p_worker_id) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'worker id must be trimmed and contain between 1 and 120 characters'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'claim batch size must be between 1 and 100'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT "id" FROM "DomainOutbox"
    WHERE "processedAt" IS NULL AND "failedAt" IS NULL AND "availableAt" <= p_now AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= p_now)
    ORDER BY "availableAt", "occurredAt", "id" FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE "DomainOutbox" AS outbox
    SET "claimedAt" = p_now, "claimedBy" = p_worker_id, "claimExpiresAt" = p_now + INTERVAL '5 minutes', "attempts" = outbox."attempts" + 1, "lastError" = NULL
    FROM candidates WHERE outbox."id" = candidates."id" RETURNING outbox.*
  ) SELECT * FROM claimed ORDER BY "availableAt", "occurredAt", "id";
END;
$$;

CREATE FUNCTION "claim_domain_outbox_events"(p_worker_id TEXT, p_event_types TEXT[], p_limit INTEGER, p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
RETURNS SETOF "DomainOutbox" LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_worker_id <> btrim(p_worker_id) OR char_length(p_worker_id) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'worker id must be trimmed and contain between 1 and 120 characters'; END IF;
  IF p_event_types IS NULL OR cardinality(p_event_types) = 0 OR cardinality(p_event_types) > 100 THEN RAISE EXCEPTION 'event types must contain between 1 and 100 entries'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'claim batch size must be between 1 and 100'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT "id" FROM "DomainOutbox"
    WHERE "processedAt" IS NULL AND "failedAt" IS NULL AND "eventType" = ANY(p_event_types) AND "availableAt" <= p_now AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= p_now)
    ORDER BY "availableAt", "occurredAt", "id" FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE "DomainOutbox" AS outbox
    SET "claimedAt" = p_now, "claimedBy" = p_worker_id, "claimExpiresAt" = p_now + INTERVAL '5 minutes', "attempts" = outbox."attempts" + 1, "lastError" = NULL
    FROM candidates WHERE outbox."id" = candidates."id" RETURNING outbox.*
  ) SELECT * FROM claimed ORDER BY "availableAt", "occurredAt", "id";
END;
$$;

CREATE FUNCTION "fail_domain_outbox"(p_id UUID, p_worker_id TEXT, p_error VARCHAR(2000), p_now TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE updated_count INTEGER;
BEGIN
  IF p_error IS NULL OR p_error <> btrim(p_error) OR char_length(p_error) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'outbox error must be trimmed and contain between 1 and 2000 characters'; END IF;
  UPDATE "DomainOutbox"
  SET "failedAt" = p_now, "claimedAt" = NULL, "claimedBy" = NULL, "claimExpiresAt" = NULL, "lastError" = p_error
  WHERE "id" = p_id AND "claimedBy" = p_worker_id AND "claimExpiresAt" > p_now AND "processedAt" IS NULL AND "failedAt" IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

ALTER TABLE "EmailEvent"
  ADD CONSTRAINT "EmailEvent_content_snapshot_valid" CHECK (
    "subjectSnapshot" = btrim("subjectSnapshot") AND char_length("subjectSnapshot") BETWEEN 1 AND 200 AND
    char_length("htmlBodySnapshot") BETWEEN 1 AND 200000 AND char_length("textBodySnapshot") BETWEEN 1 AND 100000 AND
    jsonb_typeof("variablesSnapshot") = 'object'
  );

CREATE FUNCTION "enforce_email_content_snapshot"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."subjectSnapshot" IS DISTINCT FROM OLD."subjectSnapshot" OR
     NEW."htmlBodySnapshot" IS DISTINCT FROM OLD."htmlBodySnapshot" OR
     NEW."textBodySnapshot" IS DISTINCT FROM OLD."textBodySnapshot" OR
     NEW."variablesSnapshot" IS DISTINCT FROM OLD."variablesSnapshot" THEN
    RAISE EXCEPTION 'Email content snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailEvent_enforce_content_snapshot" BEFORE UPDATE ON "EmailEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_email_content_snapshot"();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'LocalDeliveryZone', 'OrderFulfillment', 'ShipmentPackage', 'ShipmentPackageItem', 'ShipmentEvent',
    'EmailTemplateOverride', 'EmailEvent', 'EmailSuppression', 'EmailWebhookEvent', 'TaxInvoice', 'CreditNote'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
