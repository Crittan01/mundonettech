import { randomBytes, randomUUID } from "node:crypto";

export const paymentTables = [
  "PaymentAttempt",
  "PaymentTransaction",
  "PaymentWebhookEvent",
  "BlockedIdentity",
  "RemittanceBatch",
  "CodReconciliation",
  "StoreCreditAccount",
  "StoreCreditEntry",
];

export const checkoutTables = [
  "OrderItem",
  "OrderItemTaxLine",
  "OrderItemReservation",
  "OrderReceipt",
  "OrderStatusEvent",
  "AbandonedCart",
  "OrderNumberSequence",
  "DaneDepartment",
  "DaneMunicipality",
  "Shipment",
  "ShipmentItem",
  "OrderRefund",
  "OrderRefundItem",
];

export async function seedCheckoutFixture(client, { catalog, inventory, pricing, adminId }) {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const shipmentId = randomUUID();
  const refundId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase();
  const orderNumber = `RLS-${suffix}`;

  await client.query(
    `INSERT INTO "DaneDepartment" ("code", "name") VALUES ('00', 'Matriz departamental')`,
  );
  await client.query(
    `INSERT INTO "DaneMunicipality" ("code", "departmentCode", "name", "locationType")
     VALUES ('00001', '00', 'Matriz municipal', 'Municipio')`,
  );
  await client.query(`INSERT INTO "OrderNumberSequence" ("year", "lastNumber") VALUES (2999, 1)`);
  await client.query(
    `INSERT INTO "Order" (
      "id", "orderNumber", "cartId", "customerId", "couponId", "orderStatus", "paymentStatus",
      "fulfillmentMethod", "taxRegime", "uvtValueCents", "uvtYear", "emailSnapshot",
      "recipientNameSnapshot", "phoneE164Snapshot", "departmentCode", "departmentNameSnapshot",
      "municipalityCode", "municipalityNameSnapshot", "addressLine1Snapshot", "couponCodeSnapshot",
      "subtotalCents", "couponDiscountCents", "discountCents", "totalCents", "reservationKey",
      "reservationExpiresAt", "deliveryPromiseAt", "termsVersion", "privacyPolicyVersion",
      "acceptanceProofHash", "acceptedAt", "confirmedAt"
    ) VALUES (
      $1, $2, $3, $4, $5, 'CONFIRMED', 'PAID', 'HOME_DELIVERY', 'NO_RESPONSABLE_IVA', 5237400, 2026,
      'rls-checkout@example.test', 'Matriz Cliente', '+573001234567', '11', 'BOGOTÁ, D.C.',
      '11001', 'BOGOTÁ, D.C.', 'Carrera 7 # 71-21', $6, 200000, 5000, 5000, 195000, $7,
      CURRENT_TIMESTAMP + INTERVAL '2 hours', CURRENT_TIMESTAMP + INTERVAL '30 days',
      '1.0.0', '1.0.0', $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`,
    [
      orderId,
      orderNumber,
      pricing.cartId,
      catalog.customerId,
      pricing.couponId,
      `RLS-${suffix.slice(0, 12)}`,
      `order-reservation:${orderId}`,
      randomBytes(32),
    ],
  );
  await client.query(
    `INSERT INTO "OrderItem" (
      "id", "orderId", "sourceCartItemId", "variantId", "quantity", "titleSnapshot",
      "productSlugSnapshot", "skuSnapshot", "unitPriceCents", "unitCostWacCents",
      "couponDiscountCents", "discountCents", "lineTotalCents", "taxCents"
    ) VALUES ($1, $2, $3, $4, 2, 'Audífonos TÁCTILES Pro', $5, $6, 100000, 60000, 5000, 5000, 195000, 0)`,
    [
      orderItemId,
      orderId,
      pricing.cartItemId,
      catalog.variantId,
      `product-${catalog.productId}`,
      catalog.sku,
    ],
  );
  await client.query(
    `INSERT INTO "OrderItemTaxLine" (
      "orderItemId", "taxGroupCode", "taxGroupName", "treatment", "rule", "catalogRateBps",
      "appliedRateBps", "uvtValueCents", "uvtYear", "unitValueCents", "taxableBaseCents", "taxCents"
    ) VALUES ($1, 'IVA_19', 'IVA general 19 %', 'STANDARD', 'NOT_RESPONSABLE', 1900, 0, 5237400, 2026, 97500, 195000, 0)`,
    [orderItemId],
  );
  await client.query(
    `INSERT INTO "OrderItemReservation" ("orderItemId", "locationId", "quantity", "unitCostWacCents")
     VALUES ($1, $2, 2, 60000)`,
    [orderItemId, inventory.locationId],
  );
  await client.query(
    `INSERT INTO "OrderReceipt" (
      "orderId", "receiptNumber", "accessTokenHash", "taxRegime", "currency", "subtotalCents",
      "discountCents", "taxCents", "shippingCents", "totalCents", "contentHash"
    ) VALUES ($1, $2, $3, 'NO_RESPONSABLE_IVA', 'COP', 200000, 5000, 0, 0, 195000, $4)`,
    [orderId, `R-${orderNumber}`, randomBytes(32), randomBytes(32)],
  );
  await client.query(
    `INSERT INTO "OrderStatusEvent" ("orderId", "orderStatus", "paymentStatus", "fulfillmentStatus", "reason")
     VALUES ($1, 'CONFIRMED', 'PAID', 'UNFULFILLED', 'RLS_MATRIX_SEED')`,
    [orderId],
  );
  await client.query(
    `INSERT INTO "AbandonedCart" ("cartId", "customerId", "contactEmail", "lastActivityAt")
     VALUES ($1, $2, 'rls-checkout@example.test', CURRENT_TIMESTAMP - INTERVAL '2 hours')`,
    [pricing.cartId, catalog.customerId],
  );
  await client.query(
    `INSERT INTO "Shipment" ("id", "orderId", "originLocationId", "kind", "promisedAt")
     VALUES ($1, $2, $3, 'DELIVERY', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
    [shipmentId, orderId, inventory.locationId],
  );
  await client.query(
    `INSERT INTO "ShipmentItem" ("shipmentId", "orderItemId", "quantity") VALUES ($1, $2, 2)`,
    [shipmentId, orderItemId],
  );
  await client.query(
    `INSERT INTO "OrderRefund" (
      "id", "orderId", "idempotencyKey", "requestHash", "reason", "subtotalCents",
      "taxCents", "totalCents", "requestedByAdminUserId"
    ) VALUES ($1, $2, $3, $4, 'RETRACT', 50000, 0, 50000, $5)`,
    [refundId, orderId, `rls-refund-${randomUUID()}`, randomBytes(32), adminId],
  );
  await client.query(
    `INSERT INTO "OrderRefundItem" ("refundId", "orderItemId", "quantity", "subtotalCents", "taxCents", "totalCents")
     VALUES ($1, $2, 1, 50000, 0, 50000)`,
    [refundId, orderItemId],
  );
  return { orderId, orderItemId, shipmentId, refundId };
}

export async function seedPaymentFixture(client, { checkout, catalog, adminId }) {
  const credentialId = randomUUID();
  const wompiAttemptId = randomUUID();
  const codAttemptId = randomUUID();
  const creditAccountId = randomUUID();
  await client.query(
    `INSERT INTO "IntegrationCredential" (
      "id", "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
    ) VALUES ($1, 'wompi', 'LOCAL', 'matrix-payments', 1, $2, $3, $4, $5)`,
    [credentialId, randomBytes(12), randomBytes(32), randomBytes(16), adminId],
  );
  await client.query(
    `INSERT INTO "PaymentAttempt" (
      "id", "orderId", "provider", "environment", "status", "idempotencyKey", "requestHash",
      "reference", "amountCents", "credentialId", "providerStatus", "completedAt"
    ) VALUES ($1, $2, 'WOMPI', 'LOCAL', 'SUCCEEDED', $3, $4, $5, 195000, $6, 'APPROVED', CURRENT_TIMESTAMP)`,
    [
      wompiAttemptId,
      checkout.orderId,
      `rls-wompi-${randomUUID()}`,
      randomBytes(32),
      randomUUID(),
      credentialId,
    ],
  );
  await client.query(
    `INSERT INTO "PaymentTransaction" (
      "attemptId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt"
    ) VALUES ($1, 'WOMPI', 'CAPTURE', 'SUCCEEDED', 195000, $2, $3, CURRENT_TIMESTAMP)`,
    [wompiAttemptId, `trx-${randomUUID()}`, randomBytes(32)],
  );
  await client.query(
    `INSERT INTO "PaymentWebhookEvent" (
      "provider", "attemptId", "eventKey", "payloadHash", "transactionExternalId", "status", "processedAt"
    ) VALUES ('WOMPI', $1, $2, $3, $4, 'PROCESSED', CURRENT_TIMESTAMP)`,
    [wompiAttemptId, randomBytes(32).toString("hex"), randomBytes(32), `trx-${randomUUID()}`],
  );
  await client.query(
    `INSERT INTO "BlockedIdentity" ("kind", "identityHash", "reason", "blockedByAdminUserId")
     VALUES ('EMAIL', $1, 'Revisión de fraude confirmada', $2)`,
    [randomBytes(32), adminId],
  );
  const remittance = await client.query(
    `INSERT INTO "RemittanceBatch" ("carrier", "reference", "requestHash", "expectedCents", "createdByAdminUserId")
     VALUES ('Transportadora matriz', $1, $2, 1000, $3) RETURNING "id"`,
    [`RLS-REMIT-${randomUUID()}`, randomBytes(32), adminId],
  );
  await client.query(
    `INSERT INTO "PaymentAttempt" (
      "id", "orderId", "provider", "environment", "idempotencyKey", "requestHash", "reference", "amountCents"
    ) VALUES ($1, $2, 'COD', 'LOCAL', $3, $4, $5, 1000)`,
    [codAttemptId, checkout.orderId, `rls-cod-${randomUUID()}`, randomBytes(32), randomUUID()],
  );
  await client.query(
    `INSERT INTO "CodReconciliation" ("paymentAttemptId", "remittanceBatchId", "expectedCents")
     VALUES ($1, $2, 1000)`,
    [codAttemptId, remittance.rows[0].id],
  );
  await client.query(`INSERT INTO "StoreCreditAccount" ("id", "customerId") VALUES ($1, $2)`, [
    creditAccountId,
    catalog.customerId,
  ]);
  await client.query(
    `UPDATE "StoreCreditAccount" SET "availableCents" = 50000, "version" = 1 WHERE "id" = $1`,
    [creditAccountId],
  );
  await client.query(
    `INSERT INTO "StoreCreditEntry" (
      "accountId", "actorAdminUserId", "type", "operationKey", "sequence", "requestHash", "amountCents",
      "availableAfterCents", "heldAfterCents", "reason"
    ) VALUES ($1, $2, 'GRANT', $3, 1, $4, 50000, 50000, 0, 'Abono de conciliación')`,
    [creditAccountId, adminId, `rls-credit-${randomUUID()}`, randomBytes(32)],
  );
}
