CREATE TYPE "OrderFulfillmentMethod" AS ENUM ('HOME_DELIVERY', 'CLICK_COLLECT');
CREATE TYPE "OrderTaxRule" AS ENUM ('NOT_RESPONSABLE', 'STANDARD', 'EXEMPT', 'EXCLUDED', 'UVT_EXCLUDED_WITHIN_LIMIT', 'UVT_STANDARD_ABOVE_LIMIT');
CREATE TYPE "AbandonedCartStatus" AS ENUM ('DETECTED', 'RECOVERED', 'EXPIRED');
CREATE TYPE "ShipmentKind" AS ENUM ('DELIVERY', 'CLICK_COLLECT');
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED');
CREATE TYPE "OrderRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED');
CREATE TYPE "OrderRefundReason" AS ENUM ('RETRACT', 'WARRANTY', 'ADJUSTMENT', 'CUSTOMER_SUPPORT');

ALTER TABLE "StoreSettings"
  ADD COLUMN "uvtValueCents" BIGINT NOT NULL DEFAULT 5237400,
  ADD COLUMN "uvtYear" INTEGER NOT NULL DEFAULT 2026,
  ADD COLUMN "standardShippingCents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryPromiseDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "reservationMinutes" INTEGER NOT NULL DEFAULT 120;

ALTER TABLE "StockLocation"
  ADD COLUMN "addressLine1" VARCHAR(200),
  ADD COLUMN "departmentCode" CHAR(2),
  ADD COLUMN "municipalityCode" CHAR(5),
  ADD COLUMN "phoneE164" VARCHAR(16),
  ADD COLUMN "pickupInstructions" VARCHAR(500);

ALTER TABLE "CouponUsage" ADD COLUMN "orderId" UUID;

ALTER TABLE "Order"
  ADD COLUMN "cartId" UUID,
  ADD COLUMN "couponId" UUID,
  ADD COLUMN "fulfillmentMethod" "OrderFulfillmentMethod",
  ADD COLUMN "taxRegime" "StoreTaxRegime",
  ADD COLUMN "uvtValueCents" BIGINT,
  ADD COLUMN "uvtYear" INTEGER,
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  ADD COLUMN "emailSnapshot" VARCHAR(320),
  ADD COLUMN "recipientNameSnapshot" VARCHAR(200),
  ADD COLUMN "phoneE164Snapshot" VARCHAR(16),
  ADD COLUMN "countryCode" CHAR(2) NOT NULL DEFAULT 'CO',
  ADD COLUMN "departmentCode" CHAR(2),
  ADD COLUMN "departmentNameSnapshot" VARCHAR(120),
  ADD COLUMN "municipalityCode" CHAR(5),
  ADD COLUMN "municipalityNameSnapshot" VARCHAR(120),
  ADD COLUMN "addressLine1Snapshot" VARCHAR(200),
  ADD COLUMN "addressLine2Snapshot" VARCHAR(200),
  ADD COLUMN "neighborhoodSnapshot" VARCHAR(120),
  ADD COLUMN "postalCodeSnapshot" VARCHAR(6),
  ADD COLUMN "deliveryNotesSnapshot" VARCHAR(500),
  ADD COLUMN "clickCollectLocationId" UUID,
  ADD COLUMN "couponCodeSnapshot" VARCHAR(64),
  ADD COLUMN "wholesaleDiscountCents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "bundleDiscountCents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "couponDiscountCents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "reservationKey" VARCHAR(128),
  ADD COLUMN "reservationExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "deliveryPromiseAt" TIMESTAMPTZ(6),
  ADD COLUMN "termsVersion" VARCHAR(50),
  ADD COLUMN "privacyPolicyVersion" VARCHAR(50),
  ADD COLUMN "acceptanceProofHash" BYTEA,
  ADD COLUMN "acceptanceIpHash" BYTEA,
  ADD COLUMN "acceptanceUserAgentHash" BYTEA,
  ADD COLUMN "acceptedAt" TIMESTAMPTZ(6),
  ADD COLUMN "confirmedAt" TIMESTAMPTZ(6),
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(6),
  ADD COLUMN "completedAt" TIMESTAMPTZ(6);

CREATE TABLE "OrderItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "sourceCartItemId" UUID,
  "variantId" UUID NOT NULL,
  "bundleId" UUID,
  "quantity" INTEGER NOT NULL,
  "titleSnapshot" VARCHAR(200) NOT NULL,
  "productSlugSnapshot" VARCHAR(160) NOT NULL,
  "skuSnapshot" VARCHAR(64) NOT NULL,
  "unitPriceCents" BIGINT NOT NULL,
  "unitCostWacCents" BIGINT NOT NULL,
  "wholesaleDiscountCents" BIGINT NOT NULL DEFAULT 0,
  "bundleDiscountCents" BIGINT NOT NULL DEFAULT 0,
  "couponDiscountCents" BIGINT NOT NULL DEFAULT 0,
  "discountCents" BIGINT NOT NULL,
  "lineTotalCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderItemTaxLine" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderItemId" UUID NOT NULL,
  "taxGroupCode" VARCHAR(40) NOT NULL,
  "taxGroupName" VARCHAR(120) NOT NULL,
  "treatment" "TaxTreatment" NOT NULL,
  "rule" "OrderTaxRule" NOT NULL,
  "catalogRateBps" INTEGER NOT NULL,
  "appliedRateBps" INTEGER NOT NULL,
  "uvtLimit" INTEGER,
  "uvtValueCents" BIGINT NOT NULL,
  "uvtYear" INTEGER NOT NULL,
  "unitValueCents" BIGINT NOT NULL,
  "taxableBaseCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItemTaxLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderItemReservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderItemId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitCostWacCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItemReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "receiptNumber" VARCHAR(40) NOT NULL,
  "accessTokenHash" BYTEA NOT NULL,
  "taxRegime" "StoreTaxRegime" NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "subtotalCents" BIGINT NOT NULL,
  "discountCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "shippingCents" BIGINT NOT NULL,
  "totalCents" BIGINT NOT NULL,
  "contentHash" BYTEA NOT NULL,
  "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderStatusEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "orderStatus" "OrderStatus" NOT NULL,
  "paymentStatus" "PaymentStatus" NOT NULL,
  "fulfillmentStatus" "FulfillmentStatus" NOT NULL,
  "reason" VARCHAR(200),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AbandonedCart" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "cartId" UUID NOT NULL,
  "customerId" UUID,
  "contactEmail" VARCHAR(320),
  "status" "AbandonedCartStatus" NOT NULL DEFAULT 'DETECTED',
  "lastActivityAt" TIMESTAMPTZ(6) NOT NULL,
  "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recoveredAt" TIMESTAMPTZ(6),
  "expiredAt" TIMESTAMPTZ(6),
  "reminderCount" INTEGER NOT NULL DEFAULT 0,
  "lastReminderAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AbandonedCart_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderNumberSequence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "year" INTEGER NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderNumberSequence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DaneDepartment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" CHAR(2) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  CONSTRAINT "DaneDepartment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DaneMunicipality" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" CHAR(5) NOT NULL,
  "departmentCode" CHAR(2) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "locationType" VARCHAR(60) NOT NULL,
  CONSTRAINT "DaneMunicipality_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shipment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "originLocationId" UUID NOT NULL,
  "kind" "ShipmentKind" NOT NULL,
  "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
  "trackingCode" VARCHAR(120),
  "carrier" VARCHAR(120),
  "shippingCents" BIGINT NOT NULL DEFAULT 0,
  "promisedAt" TIMESTAMPTZ(6) NOT NULL,
  "readyAt" TIMESTAMPTZ(6),
  "shippedAt" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShipmentItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shipmentId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderRefund" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "reason" "OrderRefundReason" NOT NULL,
  "status" "OrderRefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "subtotalCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "shippingCents" BIGINT NOT NULL DEFAULT 0,
  "totalCents" BIGINT NOT NULL,
  "note" VARCHAR(500),
  "requestedByAdminUserId" UUID NOT NULL,
  "processedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderRefund_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderRefundItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "refundId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "subtotalCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "totalCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderRefundItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DaneDepartment" ADD CONSTRAINT "DaneDepartment_code_key" UNIQUE ("code");
ALTER TABLE "DaneMunicipality" ADD CONSTRAINT "DaneMunicipality_code_key" UNIQUE ("code");

ALTER TABLE "Order" ADD CONSTRAINT "Order_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_municipalityCode_fkey" FOREIGN KEY ("municipalityCode") REFERENCES "DaneMunicipality"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_clickCollectLocationId_fkey" FOREIGN KEY ("clickCollectLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sourceCartItemId_fkey" FOREIGN KEY ("sourceCartItemId") REFERENCES "CartItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemTaxLine" ADD CONSTRAINT "OrderItemTaxLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemReservation" ADD CONSTRAINT "OrderItemReservation_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemReservation" ADD CONSTRAINT "OrderItemReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderReceipt" ADD CONSTRAINT "OrderReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonedCart" ADD CONSTRAINT "AbandonedCart_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonedCart" ADD CONSTRAINT "AbandonedCart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DaneMunicipality" ADD CONSTRAINT "DaneMunicipality_departmentCode_fkey" FOREIGN KEY ("departmentCode") REFERENCES "DaneDepartment"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_originLocationId_fkey" FOREIGN KEY ("originLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_requestedByAdminUserId_fkey" FOREIGN KEY ("requestedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderRefundItem" ADD CONSTRAINT "OrderRefundItem_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderRefundItem" ADD CONSTRAINT "OrderRefundItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Order_cartId_key" ON "Order"("cartId") WHERE "cartId" IS NOT NULL;
CREATE UNIQUE INDEX "Order_reservationKey_key" ON "Order"("reservationKey") WHERE "reservationKey" IS NOT NULL;
CREATE INDEX "Order_paymentStatus_reservationExpiresAt_idx" ON "Order"("paymentStatus", "reservationExpiresAt");
CREATE INDEX "Order_municipalityCode_idx" ON "Order"("municipalityCode");
CREATE UNIQUE INDEX "OrderItem_sourceCartItemId_key" ON "OrderItem"("sourceCartItemId") WHERE "sourceCartItemId" IS NOT NULL;
CREATE INDEX "OrderItem_orderId_id_idx" ON "OrderItem"("orderId", "id");
CREATE INDEX "OrderItem_variantId_orderId_idx" ON "OrderItem"("variantId", "orderId");
CREATE UNIQUE INDEX "OrderItemTaxLine_orderItemId_taxGroupCode_rule_key" ON "OrderItemTaxLine"("orderItemId", "taxGroupCode", "rule");
CREATE INDEX "OrderItemTaxLine_rule_appliedRateBps_idx" ON "OrderItemTaxLine"("rule", "appliedRateBps");
CREATE UNIQUE INDEX "OrderItemReservation_orderItemId_locationId_key" ON "OrderItemReservation"("orderItemId", "locationId");
CREATE INDEX "OrderItemReservation_locationId_orderItemId_idx" ON "OrderItemReservation"("locationId", "orderItemId");
CREATE UNIQUE INDEX "OrderReceipt_orderId_key" ON "OrderReceipt"("orderId");
CREATE UNIQUE INDEX "OrderReceipt_receiptNumber_key" ON "OrderReceipt"("receiptNumber");
CREATE UNIQUE INDEX "OrderReceipt_accessTokenHash_key" ON "OrderReceipt"("accessTokenHash");
CREATE INDEX "OrderReceipt_issuedAt_orderId_idx" ON "OrderReceipt"("issuedAt", "orderId");
CREATE INDEX "OrderStatusEvent_orderId_occurredAt_id_idx" ON "OrderStatusEvent"("orderId", "occurredAt", "id");
CREATE UNIQUE INDEX "AbandonedCart_cartId_key" ON "AbandonedCart"("cartId");
CREATE INDEX "AbandonedCart_status_detectedAt_idx" ON "AbandonedCart"("status", "detectedAt");
CREATE INDEX "AbandonedCart_customerId_status_idx" ON "AbandonedCart"("customerId", "status");
CREATE UNIQUE INDEX "OrderNumberSequence_year_key" ON "OrderNumberSequence"("year");
CREATE INDEX "DaneMunicipality_departmentCode_name_code_idx" ON "DaneMunicipality"("departmentCode", "name", "code");
CREATE INDEX "Shipment_orderId_status_createdAt_idx" ON "Shipment"("orderId", "status", "createdAt");
CREATE INDEX "Shipment_originLocationId_status_idx" ON "Shipment"("originLocationId", "status");
CREATE INDEX "Shipment_status_promisedAt_idx" ON "Shipment"("status", "promisedAt");
CREATE UNIQUE INDEX "ShipmentItem_shipmentId_orderItemId_key" ON "ShipmentItem"("shipmentId", "orderItemId");
CREATE INDEX "ShipmentItem_orderItemId_shipmentId_idx" ON "ShipmentItem"("orderItemId", "shipmentId");
CREATE UNIQUE INDEX "OrderRefund_idempotencyKey_key" ON "OrderRefund"("idempotencyKey");
CREATE INDEX "OrderRefund_orderId_status_createdAt_idx" ON "OrderRefund"("orderId", "status", "createdAt");
CREATE INDEX "OrderRefund_requestedByAdminUserId_createdAt_idx" ON "OrderRefund"("requestedByAdminUserId", "createdAt");
CREATE UNIQUE INDEX "OrderRefundItem_refundId_orderItemId_key" ON "OrderRefundItem"("refundId", "orderItemId");
CREATE INDEX "OrderRefundItem_orderItemId_refundId_idx" ON "OrderRefundItem"("orderItemId", "refundId");
CREATE INDEX "CouponUsage_orderId_status_idx" ON "CouponUsage"("orderId", "status");

ALTER TABLE "StoreSettings"
  ADD CONSTRAINT "StoreSettings_uvt_value_valid" CHECK ("uvtValueCents" > 0 AND "uvtYear" BETWEEN 2000 AND 9999),
  ADD CONSTRAINT "StoreSettings_shipping_nonnegative" CHECK ("standardShippingCents" >= 0),
  ADD CONSTRAINT "StoreSettings_delivery_promise_valid" CHECK ("deliveryPromiseDays" BETWEEN 1 AND 365),
  ADD CONSTRAINT "StoreSettings_reservation_minutes_valid" CHECK ("reservationMinutes" BETWEEN 5 AND 10080);

ALTER TABLE "StockLocation"
  ADD CONSTRAINT "StockLocation_pickup_address_valid" CHECK (
    ("addressLine1" IS NULL AND "departmentCode" IS NULL AND "municipalityCode" IS NULL) OR
    ("addressLine1" IS NOT NULL AND "addressLine1" = btrim("addressLine1") AND char_length("addressLine1") >= 5 AND
     "departmentCode" ~ '^[0-9]{2}$' AND "municipalityCode" ~ '^[0-9]{5}$' AND left("municipalityCode", 2) = "departmentCode")
  ),
  ADD CONSTRAINT "StockLocation_phoneE164_valid" CHECK ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "StockLocation_pickup_instructions_valid" CHECK ("pickupInstructions" IS NULL OR ("pickupInstructions" = btrim("pickupInstructions") AND char_length("pickupInstructions") > 0));

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_checkout_money_nonnegative" CHECK ("wholesaleDiscountCents" >= 0 AND "bundleDiscountCents" >= 0 AND "couponDiscountCents" >= 0 AND ("uvtValueCents" IS NULL OR "uvtValueCents" > 0)),
  ADD CONSTRAINT "Order_discount_components_balanced" CHECK ("discountCents" = "wholesaleDiscountCents" + "bundleDiscountCents" + "couponDiscountCents"),
  ADD CONSTRAINT "Order_currency_valid" CHECK ("currency" = 'COP' AND "countryCode" = 'CO'),
  ADD CONSTRAINT "Order_contact_snapshots_valid" CHECK (
    ("emailSnapshot" IS NULL OR "emailSnapshot" = lower(btrim("emailSnapshot"))) AND
    ("recipientNameSnapshot" IS NULL OR ("recipientNameSnapshot" = btrim("recipientNameSnapshot") AND char_length("recipientNameSnapshot") BETWEEN 2 AND 200)) AND
    ("phoneE164Snapshot" IS NULL OR "phoneE164Snapshot" ~ '^\+[1-9][0-9]{7,14}$')
  ),
  ADD CONSTRAINT "Order_dane_snapshot_valid" CHECK (
    ("municipalityCode" IS NULL AND "departmentCode" IS NULL) OR
    ("municipalityCode" ~ '^[0-9]{5}$' AND "departmentCode" ~ '^[0-9]{2}$' AND left("municipalityCode", 2) = "departmentCode" AND
     "departmentNameSnapshot" IS NOT NULL AND "municipalityNameSnapshot" IS NOT NULL)
  ),
  ADD CONSTRAINT "Order_checkout_snapshot_complete" CHECK (
    "cartId" IS NULL OR (
      "fulfillmentMethod" IS NOT NULL AND "taxRegime" IS NOT NULL AND "uvtValueCents" > 0 AND
      "uvtYear" BETWEEN 2000 AND 9999 AND "emailSnapshot" IS NOT NULL AND "recipientNameSnapshot" IS NOT NULL AND
      "phoneE164Snapshot" IS NOT NULL AND "departmentCode" IS NOT NULL AND "addressLine1Snapshot" IS NOT NULL AND
      "deliveryPromiseAt" IS NOT NULL AND "reservationKey" IS NOT NULL AND "reservationExpiresAt" IS NOT NULL AND
      (("fulfillmentMethod" = 'HOME_DELIVERY' AND "clickCollectLocationId" IS NULL) OR
       ("fulfillmentMethod" = 'CLICK_COLLECT' AND "clickCollectLocationId" IS NOT NULL))
    )
  ),
  ADD CONSTRAINT "Order_acceptance_valid" CHECK (
    "cartId" IS NULL OR (
      "termsVersion" IS NOT NULL AND "privacyPolicyVersion" IS NOT NULL AND
      octet_length("acceptanceProofHash") = 32 AND "acceptedAt" IS NOT NULL AND
      ("acceptanceIpHash" IS NULL OR octet_length("acceptanceIpHash") = 32) AND
      ("acceptanceUserAgentHash" IS NULL OR octet_length("acceptanceUserAgentHash") = 32)
    )
  ),
  ADD CONSTRAINT "Order_status_timestamps_valid" CHECK (
    "cartId" IS NULL OR
    ("orderStatus" = 'PENDING' AND "confirmedAt" IS NULL AND "cancelledAt" IS NULL AND "completedAt" IS NULL) OR
    ("orderStatus" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "completedAt" IS NULL) OR
    ("orderStatus" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL) OR
    ("orderStatus" = 'COMPLETED' AND "confirmedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL)
  );

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "OrderItem_snapshots_not_blank" CHECK (
    "titleSnapshot" = btrim("titleSnapshot") AND char_length("titleSnapshot") > 0 AND
    "productSlugSnapshot" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND
    "skuSnapshot" = btrim("skuSnapshot") AND char_length("skuSnapshot") > 0
  ),
  ADD CONSTRAINT "OrderItem_money_nonnegative" CHECK (
    "unitPriceCents" >= 0 AND "unitCostWacCents" >= 0 AND "wholesaleDiscountCents" >= 0 AND
    "bundleDiscountCents" >= 0 AND "couponDiscountCents" >= 0 AND "discountCents" >= 0 AND
    "lineTotalCents" >= 0 AND "taxCents" >= 0
  ),
  ADD CONSTRAINT "OrderItem_discount_components_balanced" CHECK ("discountCents" = "wholesaleDiscountCents" + "bundleDiscountCents" + "couponDiscountCents"),
  ADD CONSTRAINT "OrderItem_total_balanced" CHECK ("lineTotalCents" = "unitPriceCents" * "quantity" - "discountCents");

ALTER TABLE "OrderItemTaxLine"
  ADD CONSTRAINT "OrderItemTaxLine_rates_valid" CHECK ("catalogRateBps" BETWEEN 0 AND 10000 AND "appliedRateBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "OrderItemTaxLine_uvt_valid" CHECK ("uvtValueCents" > 0 AND "uvtYear" BETWEEN 2000 AND 9999 AND ("uvtLimit" IS NULL OR "uvtLimit" > 0)),
  ADD CONSTRAINT "OrderItemTaxLine_money_nonnegative" CHECK ("unitValueCents" >= 0 AND "taxableBaseCents" >= 0 AND "taxCents" >= 0),
  ADD CONSTRAINT "OrderItemTaxLine_tax_balanced" CHECK ("taxCents" = (("taxableBaseCents" * "appliedRateBps" + 5000) / 10000)),
  ADD CONSTRAINT "OrderItemTaxLine_rule_valid" CHECK (
    ("rule" IN ('NOT_RESPONSABLE', 'EXEMPT', 'EXCLUDED', 'UVT_EXCLUDED_WITHIN_LIMIT') AND "appliedRateBps" = 0 AND "taxCents" = 0) OR
    ("rule" IN ('STANDARD', 'UVT_STANDARD_ABOVE_LIMIT') AND "appliedRateBps" > 0)
  );

ALTER TABLE "OrderItemReservation"
  ADD CONSTRAINT "OrderItemReservation_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "OrderItemReservation_cost_nonnegative" CHECK ("unitCostWacCents" >= 0);

ALTER TABLE "OrderReceipt"
  ADD CONSTRAINT "OrderReceipt_receiptNumber_valid" CHECK ("receiptNumber" ~ '^R-[A-Z0-9][A-Z0-9-]{3,33}$'),
  ADD CONSTRAINT "OrderReceipt_accessTokenHash_length" CHECK (octet_length("accessTokenHash") = 32),
  ADD CONSTRAINT "OrderReceipt_contentHash_length" CHECK (octet_length("contentHash") = 32),
  ADD CONSTRAINT "OrderReceipt_currency_valid" CHECK ("currency" = 'COP'),
  ADD CONSTRAINT "OrderReceipt_money_nonnegative" CHECK ("subtotalCents" >= 0 AND "discountCents" >= 0 AND "taxCents" >= 0 AND "shippingCents" >= 0 AND "totalCents" >= 0),
  ADD CONSTRAINT "OrderReceipt_total_balanced" CHECK ("totalCents" = "subtotalCents" - "discountCents" + "taxCents" + "shippingCents");

ALTER TABLE "OrderStatusEvent"
  ADD CONSTRAINT "OrderStatusEvent_reason_not_blank" CHECK ("reason" IS NULL OR ("reason" = btrim("reason") AND char_length("reason") > 0)),
  ADD CONSTRAINT "OrderStatusEvent_metadata_object" CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "AbandonedCart"
  ADD CONSTRAINT "AbandonedCart_email_valid" CHECK ("contactEmail" IS NULL OR "contactEmail" = lower(btrim("contactEmail"))),
  ADD CONSTRAINT "AbandonedCart_status_timestamps" CHECK (
    ("status" = 'DETECTED' AND "recoveredAt" IS NULL AND "expiredAt" IS NULL) OR
    ("status" = 'RECOVERED' AND "recoveredAt" IS NOT NULL AND "expiredAt" IS NULL) OR
    ("status" = 'EXPIRED' AND "recoveredAt" IS NULL AND "expiredAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "AbandonedCart_reminders_valid" CHECK ("reminderCount" >= 0 AND ("reminderCount" > 0 OR "lastReminderAt" IS NULL));

ALTER TABLE "OrderNumberSequence" ADD CONSTRAINT "OrderNumberSequence_values_valid" CHECK ("year" BETWEEN 2000 AND 9999 AND "lastNumber" >= 0);
ALTER TABLE "DaneDepartment" ADD CONSTRAINT "DaneDepartment_values_valid" CHECK ("code" ~ '^[0-9]{2}$' AND "name" = btrim("name") AND char_length("name") > 0);
ALTER TABLE "DaneMunicipality" ADD CONSTRAINT "DaneMunicipality_values_valid" CHECK ("code" ~ '^[0-9]{5}$' AND left("code", 2) = "departmentCode" AND "name" = btrim("name") AND char_length("name") > 0 AND "locationType" = btrim("locationType") AND char_length("locationType") > 0);

ALTER TABLE "Shipment"
  ADD CONSTRAINT "Shipment_shipping_nonnegative" CHECK ("shippingCents" >= 0),
  ADD CONSTRAINT "Shipment_tracking_consistent" CHECK (("trackingCode" IS NULL) = ("carrier" IS NULL)),
  ADD CONSTRAINT "Shipment_status_timestamps" CHECK (
    ("status" = 'PENDING' AND "readyAt" IS NULL AND "shippedAt" IS NULL AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'READY' AND "readyAt" IS NOT NULL AND "shippedAt" IS NULL AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'SHIPPED' AND "shippedAt" IS NOT NULL AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'DELIVERED' AND "deliveredAt" IS NOT NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "deliveredAt" IS NULL)
  );

ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "OrderRefund"
  ADD CONSTRAINT "OrderRefund_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "OrderRefund_idempotencyKey_valid" CHECK ("idempotencyKey" = btrim("idempotencyKey") AND char_length("idempotencyKey") > 0),
  ADD CONSTRAINT "OrderRefund_money_nonnegative" CHECK ("subtotalCents" >= 0 AND "taxCents" >= 0 AND "shippingCents" >= 0 AND "totalCents" >= 0),
  ADD CONSTRAINT "OrderRefund_total_balanced" CHECK ("totalCents" = "subtotalCents" + "taxCents" + "shippingCents" AND "totalCents" > 0),
  ADD CONSTRAINT "OrderRefund_note_not_blank" CHECK ("note" IS NULL OR ("note" = btrim("note") AND char_length("note") > 0)),
  ADD CONSTRAINT "OrderRefund_processed_consistent" CHECK (("status" = 'COMPLETED') = ("processedAt" IS NOT NULL));

ALTER TABLE "OrderRefundItem"
  ADD CONSTRAINT "OrderRefundItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "OrderRefundItem_money_nonnegative" CHECK ("subtotalCents" >= 0 AND "taxCents" >= 0 AND "totalCents" >= 0),
  ADD CONSTRAINT "OrderRefundItem_total_balanced" CHECK ("totalCents" = "subtotalCents" + "taxCents" AND "totalCents" > 0);

ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_municipalityCode_fkey" FOREIGN KEY ("municipalityCode") REFERENCES "DaneMunicipality"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['AbandonedCart', 'OrderNumberSequence', 'Shipment', 'OrderRefund'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_coupon_usage_transition"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Coupon usage history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."couponId" IS DISTINCT FROM OLD."couponId" OR NEW."cartId" IS DISTINCT FROM OLD."cartId" OR
     (OLD."customerId" IS NOT NULL AND NEW."customerId" IS DISTINCT FROM OLD."customerId") OR
     NEW."reservedAt" IS DISTINCT FROM OLD."reservedAt" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."orderId" IS NOT NULL AND NEW."orderId" IS DISTINCT FROM OLD."orderId") THEN
    RAISE EXCEPTION 'Coupon usage identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."status" = 'RESERVED' AND NEW."status" NOT IN ('REDEEMED', 'RELEASED')) OR
     (OLD."status" = 'REDEEMED' AND NEW."status" <> 'RELEASED') OR
     (OLD."status" = 'RELEASED') OR
     (NEW."status" = 'REDEEMED' AND (NEW."redeemedAt" IS NULL OR NEW."orderId" IS NULL OR NEW."customerId" IS NULL)) OR
     (NEW."status" = 'RELEASED' AND NEW."releasedAt" IS NULL) OR
     (NEW."status" <> 'REDEEMED' AND OLD."status" = 'RESERVED' AND (NEW."orderId" IS NOT NULL OR NEW."customerId" IS DISTINCT FROM OLD."customerId")) THEN
    RAISE EXCEPTION 'Invalid coupon usage transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "CouponUsage" DROP CONSTRAINT "CouponUsage_status_timestamps";
ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_status_timestamps" CHECK (
  ("status" = 'RESERVED' AND "orderId" IS NULL AND "redeemedAt" IS NULL AND "releasedAt" IS NULL) OR
  ("status" = 'REDEEMED' AND "orderId" IS NOT NULL AND "customerId" IS NOT NULL AND "redeemedAt" IS NOT NULL AND "releasedAt" IS NULL) OR
  ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL)
);

CREATE FUNCTION "protect_order_snapshots"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Order history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."orderStatus" <> 'PENDING' AND (
     NEW."orderNumber" IS DISTINCT FROM OLD."orderNumber" OR NEW."cartId" IS DISTINCT FROM OLD."cartId" OR
     NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."couponId" IS DISTINCT FROM OLD."couponId" OR
     NEW."fulfillmentMethod" IS DISTINCT FROM OLD."fulfillmentMethod" OR NEW."taxRegime" IS DISTINCT FROM OLD."taxRegime" OR
     NEW."uvtValueCents" IS DISTINCT FROM OLD."uvtValueCents" OR NEW."uvtYear" IS DISTINCT FROM OLD."uvtYear" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."emailSnapshot" IS DISTINCT FROM OLD."emailSnapshot" OR
     NEW."recipientNameSnapshot" IS DISTINCT FROM OLD."recipientNameSnapshot" OR NEW."phoneE164Snapshot" IS DISTINCT FROM OLD."phoneE164Snapshot" OR
     NEW."countryCode" IS DISTINCT FROM OLD."countryCode" OR NEW."departmentCode" IS DISTINCT FROM OLD."departmentCode" OR
     NEW."departmentNameSnapshot" IS DISTINCT FROM OLD."departmentNameSnapshot" OR NEW."municipalityCode" IS DISTINCT FROM OLD."municipalityCode" OR
     NEW."municipalityNameSnapshot" IS DISTINCT FROM OLD."municipalityNameSnapshot" OR NEW."addressLine1Snapshot" IS DISTINCT FROM OLD."addressLine1Snapshot" OR
     NEW."addressLine2Snapshot" IS DISTINCT FROM OLD."addressLine2Snapshot" OR NEW."neighborhoodSnapshot" IS DISTINCT FROM OLD."neighborhoodSnapshot" OR
     NEW."postalCodeSnapshot" IS DISTINCT FROM OLD."postalCodeSnapshot" OR NEW."deliveryNotesSnapshot" IS DISTINCT FROM OLD."deliveryNotesSnapshot" OR
     NEW."clickCollectLocationId" IS DISTINCT FROM OLD."clickCollectLocationId" OR NEW."couponCodeSnapshot" IS DISTINCT FROM OLD."couponCodeSnapshot" OR
     NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR NEW."wholesaleDiscountCents" IS DISTINCT FROM OLD."wholesaleDiscountCents" OR
     NEW."bundleDiscountCents" IS DISTINCT FROM OLD."bundleDiscountCents" OR NEW."couponDiscountCents" IS DISTINCT FROM OLD."couponDiscountCents" OR
     NEW."discountCents" IS DISTINCT FROM OLD."discountCents" OR NEW."taxCents" IS DISTINCT FROM OLD."taxCents" OR
     NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents" OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR
     NEW."reservationKey" IS DISTINCT FROM OLD."reservationKey" OR NEW."deliveryPromiseAt" IS DISTINCT FROM OLD."deliveryPromiseAt" OR
     NEW."termsVersion" IS DISTINCT FROM OLD."termsVersion" OR NEW."privacyPolicyVersion" IS DISTINCT FROM OLD."privacyPolicyVersion" OR
     NEW."acceptanceProofHash" IS DISTINCT FROM OLD."acceptanceProofHash" OR NEW."acceptanceIpHash" IS DISTINCT FROM OLD."acceptanceIpHash" OR
     NEW."acceptanceUserAgentHash" IS DISTINCT FROM OLD."acceptanceUserAgentHash" OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt" OR
     NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt") OR
     (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")) THEN
    RAISE EXCEPTION 'Order commercial and acceptance snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."orderStatus" = 'CANCELLED' AND (
     NEW."orderStatus" <> 'CANCELLED' OR
     NEW."paymentStatus" IS DISTINCT FROM OLD."paymentStatus" OR
     NEW."fulfillmentStatus" IS DISTINCT FROM OLD."fulfillmentStatus" OR
     NEW."reservationExpiresAt" IS DISTINCT FROM OLD."reservationExpiresAt") THEN
    RAISE EXCEPTION 'Cancelled orders are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."orderStatus" <> 'PENDING' AND OLD."orderStatus" <> NEW."orderStatus" AND
     NOT (OLD."orderStatus" = 'CONFIRMED' AND NEW."orderStatus" IN ('CANCELLED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'Invalid order status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_protect_snapshots" BEFORE UPDATE OR DELETE ON "Order" FOR EACH ROW EXECUTE FUNCTION "protect_order_snapshots"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['OrderItem', 'OrderItemTaxLine', 'OrderItemReservation', 'OrderReceipt', 'OrderStatusEvent', 'ShipmentItem', 'OrderRefundItem'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', table_name || '_immutable_history', table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION "validate_order_receipt"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent "Order";
BEGIN
  SELECT * INTO parent FROM "Order" WHERE "id" = NEW."orderId";
  IF parent."id" IS NULL OR parent."orderStatus" = 'PENDING' OR
     parent."taxRegime" IS DISTINCT FROM NEW."taxRegime" OR parent."currency" <> NEW."currency" OR
     parent."subtotalCents" <> NEW."subtotalCents" OR parent."discountCents" <> NEW."discountCents" OR
     parent."taxCents" <> NEW."taxCents" OR parent."shippingCents" <> NEW."shippingCents" OR
     parent."totalCents" <> NEW."totalCents" OR parent."orderNumber" <> substring(NEW."receiptNumber" from 3) THEN
    RAISE EXCEPTION 'Receipt does not match its confirmed order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderReceipt_validate" BEFORE INSERT ON "OrderReceipt" FOR EACH ROW EXECUTE FUNCTION "validate_order_receipt"();

CREATE FUNCTION "validate_refund_item"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrderRefund" refund
    JOIN "OrderItem" item ON item."orderId" = refund."orderId"
    WHERE refund."id" = NEW."refundId" AND refund."status" = 'REQUESTED' AND item."id" = NEW."orderItemId" AND
          NEW."quantity" <= item."quantity" AND NEW."subtotalCents" <= item."lineTotalCents" AND
          NEW."taxCents" <= item."taxCents" AND NEW."totalCents" <= item."lineTotalCents" + item."taxCents"
  ) THEN
    RAISE EXCEPTION 'Refund item exceeds or does not belong to the order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderRefundItem_validate" BEFORE INSERT ON "OrderRefundItem" FOR EACH ROW EXECUTE FUNCTION "validate_refund_item"();

CREATE FUNCTION "validate_order_balance"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target_order_id UUID;
  parent "Order";
  item_record RECORD;
BEGIN
  IF TG_TABLE_NAME = 'Order' THEN
    target_order_id := NEW."id";
  ELSIF TG_TABLE_NAME IN ('OrderItem', 'Shipment') THEN
    target_order_id := NEW."orderId";
  ELSIF TG_TABLE_NAME IN ('OrderItemTaxLine', 'OrderItemReservation') THEN
    SELECT "orderId" INTO target_order_id FROM "OrderItem" WHERE "id" = NEW."orderItemId";
  ELSIF TG_TABLE_NAME = 'ShipmentItem' THEN
    SELECT "orderId" INTO target_order_id FROM "Shipment" WHERE "id" = NEW."shipmentId";
  ELSE
    RAISE EXCEPTION 'Unsupported order balance trigger table %', TG_TABLE_NAME;
  END IF;
  SELECT * INTO parent FROM "Order" WHERE "id" = target_order_id;
  IF parent."id" IS NULL OR parent."cartId" IS NULL OR parent."orderStatus" IN ('PENDING', 'CANCELLED') THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum("unitPriceCents" * "quantity"), 0) AS subtotal,
         COALESCE(sum("wholesaleDiscountCents"), 0) AS wholesale,
         COALESCE(sum("bundleDiscountCents"), 0) AS bundle,
         COALESCE(sum("couponDiscountCents"), 0) AS coupon,
         COALESCE(sum("lineTotalCents"), 0) AS net,
         COALESCE(sum("taxCents"), 0) AS tax,
         count(*) AS items
  INTO item_record FROM "OrderItem" WHERE "orderId" = parent."id";
  IF item_record.items = 0 OR parent."subtotalCents" <> item_record.subtotal OR
     parent."wholesaleDiscountCents" <> item_record.wholesale OR parent."bundleDiscountCents" <> item_record.bundle OR
     parent."couponDiscountCents" <> item_record.coupon OR
     parent."subtotalCents" - parent."discountCents" <> item_record.net OR parent."taxCents" <> item_record.tax THEN
    RAISE EXCEPTION 'Confirmed order item totals do not balance' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "OrderItem" item
    WHERE item."orderId" = parent."id" AND (
      (SELECT COALESCE(sum(tax."taxCents"), 0) FROM "OrderItemTaxLine" tax WHERE tax."orderItemId" = item."id") <> item."taxCents" OR
      (SELECT COALESCE(sum(reservation."quantity"), 0) FROM "OrderItemReservation" reservation WHERE reservation."orderItemId" = item."id") <> item."quantity" OR
      (SELECT COALESCE(sum(shipment."quantity"), 0) FROM "ShipmentItem" shipment WHERE shipment."orderItemId" = item."id") <> item."quantity"
    )
  ) THEN
    RAISE EXCEPTION 'Confirmed order tax, reservation and shipment quantities do not balance' USING ERRCODE = '23514';
  END IF;
  IF (SELECT COALESCE(sum("shippingCents"), 0) FROM "Shipment" WHERE "orderId" = parent."id" AND "status" <> 'CANCELLED') <> parent."shippingCents" THEN
    RAISE EXCEPTION 'Confirmed order shipments do not balance shipping totals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_validate_balance" AFTER INSERT OR UPDATE ON "Order"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_order_balance"();
CREATE CONSTRAINT TRIGGER "OrderItem_validate_balance" AFTER INSERT ON "OrderItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_order_balance"();
CREATE CONSTRAINT TRIGGER "OrderItemTaxLine_validate_balance" AFTER INSERT ON "OrderItemTaxLine"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_order_balance"();
CREATE CONSTRAINT TRIGGER "OrderItemReservation_validate_balance" AFTER INSERT ON "OrderItemReservation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_order_balance"();
CREATE CONSTRAINT TRIGGER "Shipment_validate_balance" AFTER INSERT OR UPDATE ON "Shipment"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_order_balance"();
CREATE CONSTRAINT TRIGGER "ShipmentItem_validate_balance" AFTER INSERT ON "ShipmentItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_order_balance"();

CREATE FUNCTION "enforce_order_refund_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."reason" IS DISTINCT FROM OLD."reason" OR
     NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR NEW."taxCents" IS DISTINCT FROM OLD."taxCents" OR
     NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents" OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR
     NEW."requestedByAdminUserId" IS DISTINCT FROM OLD."requestedByAdminUserId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Refund identity and financial snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'APPROVED' AND NEW."status" IN ('PROCESSING', 'CANCELLED')) OR
    (OLD."status" = 'PROCESSING' AND NEW."status" IN ('COMPLETED', 'FAILED')) OR
    (OLD."status" = 'FAILED' AND NEW."status" IN ('PROCESSING', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid refund status transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Terminal refunds are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderRefund_enforce_state" BEFORE UPDATE OR DELETE ON "OrderRefund"
FOR EACH ROW EXECUTE FUNCTION "enforce_order_refund_state"();

CREATE FUNCTION "enforce_shipment_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shipment history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."originLocationId" IS DISTINCT FROM OLD."originLocationId" OR
     NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents" OR
     NEW."promisedAt" IS DISTINCT FROM OLD."promisedAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Shipment identity and commercial snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('READY', 'CANCELLED')) OR
    (OLD."status" = 'READY' AND NEW."status" IN ('SHIPPED', 'CANCELLED')) OR
    (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
  ) THEN
    RAISE EXCEPTION 'Invalid shipment status transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('DELIVERED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Terminal shipments are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Shipment_enforce_state" BEFORE UPDATE OR DELETE ON "Shipment"
FOR EACH ROW EXECUTE FUNCTION "enforce_shipment_state"();

CREATE FUNCTION "validate_refund_totals"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target_order_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'OrderRefund' THEN
    target_order_id := NEW."orderId";
  ELSE
    SELECT "orderId" INTO target_order_id FROM "OrderRefund" WHERE "id" = NEW."refundId";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "OrderRefund" refund
    WHERE refund."orderId" = target_order_id AND (
      (SELECT COALESCE(sum(item."subtotalCents"), 0) FROM "OrderRefundItem" item WHERE item."refundId" = refund."id") <> refund."subtotalCents" OR
      (SELECT COALESCE(sum(item."taxCents"), 0) FROM "OrderRefundItem" item WHERE item."refundId" = refund."id") <> refund."taxCents" OR
      (SELECT COALESCE(sum(item."totalCents"), 0) FROM "OrderRefundItem" item WHERE item."refundId" = refund."id") + refund."shippingCents" <> refund."totalCents"
    )
  ) THEN
    RAISE EXCEPTION 'Refund totals do not balance their items' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "OrderItem" order_item
    WHERE order_item."orderId" = target_order_id AND (
      SELECT COALESCE(sum(refund_item."quantity"), 0)
      FROM "OrderRefundItem" refund_item
      JOIN "OrderRefund" refund ON refund."id" = refund_item."refundId"
      WHERE refund_item."orderItemId" = order_item."id" AND refund."status" NOT IN ('REJECTED', 'CANCELLED')
    ) > order_item."quantity"
  ) THEN
    RAISE EXCEPTION 'Refund quantities exceed the ordered items' USING ERRCODE = '23514';
  END IF;
  IF (SELECT COALESCE(sum("shippingCents"), 0) FROM "OrderRefund" WHERE "orderId" = target_order_id AND "status" NOT IN ('REJECTED', 'CANCELLED')) >
     (SELECT "shippingCents" FROM "Order" WHERE "id" = target_order_id) OR
     (SELECT COALESCE(sum("subtotalCents"), 0) FROM "OrderRefund" WHERE "orderId" = target_order_id AND "status" NOT IN ('REJECTED', 'CANCELLED')) >
     (SELECT "subtotalCents" - "discountCents" FROM "Order" WHERE "id" = target_order_id) OR
     (SELECT COALESCE(sum("taxCents"), 0) FROM "OrderRefund" WHERE "orderId" = target_order_id AND "status" NOT IN ('REJECTED', 'CANCELLED')) >
     (SELECT "taxCents" FROM "Order" WHERE "id" = target_order_id) THEN
    RAISE EXCEPTION 'Refund amounts exceed the order financial snapshots' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "OrderRefund_validate_totals" AFTER INSERT OR UPDATE ON "OrderRefund"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_refund_totals"();
CREATE CONSTRAINT TRIGGER "OrderRefundItem_validate_totals" AFTER INSERT ON "OrderRefundItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_refund_totals"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'OrderItem', 'OrderItemTaxLine', 'OrderItemReservation', 'OrderReceipt', 'OrderStatusEvent',
    'AbandonedCart', 'OrderNumberSequence', 'DaneDepartment', 'DaneMunicipality',
    'Shipment', 'ShipmentItem', 'OrderRefund', 'OrderRefundItem'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
