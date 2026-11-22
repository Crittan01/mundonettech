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

export const logisticsTables = [
  "LocalDeliveryZone",
  "OrderFulfillment",
  "ShipmentPackage",
  "ShipmentPackageItem",
  "ShipmentEvent",
  "EmailTemplateOverride",
  "EmailEvent",
  "EmailSuppression",
  "EmailWebhookEvent",
  "TaxInvoice",
  "CreditNote",
];

export async function seedCheckoutFixture(
  client,
  { catalog, inventory, pricing, adminId, receiptAccessTokenHash },
) {
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
      "recipientNameSnapshot", "phoneE164Snapshot", "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot", "buyerTaxRegimeSnapshot",
      "departmentCode", "departmentNameSnapshot",
      "municipalityCode", "municipalityNameSnapshot", "addressLine1Snapshot", "couponCodeSnapshot",
      "subtotalCents", "couponDiscountCents", "discountCents", "totalCents", "reservationKey",
      "reservationExpiresAt", "deliveryPromiseAt", "termsVersion", "privacyPolicyVersion",
      "acceptanceProofHash", "acceptedAt", "confirmedAt"
    ) VALUES (
      $1, $2, $3, $4, $5, 'CONFIRMED', 'PAID', 'HOME_DELIVERY', 'RESPONSABLE_IVA', 5237400, 2026,
      'rls-checkout@example.test', 'Matriz Cliente', '+573001234567', '13', '1020304050', 'NO_RESPONSABLE_IVA', '11', 'BOGOTÁ, D.C.',
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
    ) VALUES ($1, 'IVA_19', 'IVA general 19 %', 'EXCLUDED', 'EXCLUDED', 0, 0, 5237400, 2026, 97500, 195000, 0)`,
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
    ) VALUES ($1, $2, $3, 'RESPONSABLE_IVA', 'COP', 200000, 5000, 0, 0, 195000, $4)`,
    [orderId, `R-${orderNumber}`, receiptAccessTokenHash ?? randomBytes(32), randomBytes(32)],
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
    `INSERT INTO "ShipmentItem" ("shipmentId", "orderItemId", "quantity", "declaredValueCents") VALUES ($1, $2, 2, 195000)`,
    [shipmentId, orderItemId],
  );
  await client.query(
    `UPDATE "SerializedUnit" SET "status" = 'RESERVED', "reservationKey" = $1
     WHERE "id" = ANY($2::uuid[])`,
    [`order-reservation:${orderId}`, inventory.serializedUnitIds.slice(0, 2)],
  );
  await client.query(
    `UPDATE "StockLevel" SET "committed" = "committed" + 2
     WHERE "locationId" = $1 AND "variantId" = $2`,
    [inventory.locationId, catalog.variantId],
  );
  await client.query(
    `INSERT INTO "InventoryLedger" (
      "locationId", "variantId", "entryType", "quantityDelta", "committedDelta",
      "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
      "operationKey", "operationHash", "operationSequence", "metadata"
    )
    SELECT $1, $2, 'RESERVATION', 0, 2, "onHand", "committed", "safetyStock",
      "weightedAvgCostCents", $3, $4, 0, '{"source":"paid-fixture"}'::jsonb
    FROM "StockLevel" WHERE "locationId" = $1 AND "variantId" = $2`,
    [inventory.locationId, catalog.variantId, `order-reservation:${orderId}`, randomBytes(32)],
  );
  await client.query(
    `UPDATE "SerializedUnit"
     SET "status" = 'SOLD', "orderId" = $1, "shipmentId" = $2, "soldAt" = CURRENT_TIMESTAMP,
       "reservationKey" = NULL
     WHERE "id" = ANY($3::uuid[])`,
    [orderId, shipmentId, inventory.serializedUnitIds.slice(0, 2)],
  );
  await client.query(
    `UPDATE "StockLevel" SET "onHand" = "onHand" - 2, "committed" = "committed" - 2
     WHERE "locationId" = $1 AND "variantId" = $2`,
    [inventory.locationId, catalog.variantId],
  );
  await client.query(
    `INSERT INTO "InventoryLedger" (
      "locationId", "variantId", "orderId", "entryType", "quantityDelta", "committedDelta",
      "onHandAfter", "committedAfter", "safetyStockAfter", "weightedAvgCostAfterCents",
      "operationKey", "operationHash", "operationSequence", "referenceKey", "metadata"
    )
    SELECT $1, $2, $3, 'FULFILLMENT', -2, -2, "onHand", "committed", "safetyStock",
      "weightedAvgCostCents", $4, $5, 0, $6, '{"source":"paid-fixture"}'::jsonb
    FROM "StockLevel" WHERE "locationId" = $1 AND "variantId" = $2`,
    [
      inventory.locationId,
      catalog.variantId,
      orderId,
      `order-fulfillment:${orderId}`,
      randomBytes(32),
      `order-reservation:${orderId}`,
    ],
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
  return { wompiAttemptId };
}

export async function seedLogisticsFixture(client, { checkout, payments, adminId }) {
  async function credential(provider, accountName) {
    const result = await client.query(
      `INSERT INTO "IntegrationCredential" (
        "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
      ) VALUES ($1, 'LOCAL', $2, 1, $3, $4, $5, $6) RETURNING "id"`,
      [provider, accountName, randomBytes(12), randomBytes(32), randomBytes(16), adminId],
    );
    return result.rows[0].id;
  }
  const aveonlineCredentialId = await credential(
    "aveonline",
    `matrix-shipping-${randomUUID().slice(0, 8)}`,
  );
  const resendCredentialId = await credential("resend", `matrix-email-${randomUUID().slice(0, 8)}`);
  const dianCredentialId = await credential("dian", `matrix-fiscal-${randomUUID().slice(0, 8)}`);

  const zoneId = randomUUID();
  await client.query(
    `INSERT INTO "LocalDeliveryZone" (
      "id", "code", "name", "municipalityCodes", "polygon", "baseFeeCents", "cutoffMinutes",
      "deliveryPromiseMinutes", "createdByAdminUserId", "updatedByAdminUserId"
    ) VALUES ($1, $2, 'Zona matriz', $3::jsonb, $4::jsonb, 500000, 720, 120, $5, $5)`,
    [
      zoneId,
      `MATRIX-${randomUUID().slice(0, 8).toUpperCase()}`,
      JSON.stringify(["11001"]),
      JSON.stringify([
        { latitudeE6: 46000000, longitudeE6: -74100000 },
        { latitudeE6: 46000000, longitudeE6: -74000000 },
        { latitudeE6: 47000000, longitudeE6: -74000000 },
        { latitudeE6: 47000000, longitudeE6: -74100000 },
      ]),
      adminId,
    ],
  );
  const fulfillmentId = randomUUID();
  await client.query(
    `INSERT INTO "OrderFulfillment" ("id", "orderId", "shipmentId", "provider", "status", "credentialId", "environment", "version")
     VALUES ($1, $2, $3, 'AVEONLINE', 'PICKING', $4, 'LOCAL', 1)`,
    [fulfillmentId, checkout.orderId, checkout.shipmentId, aveonlineCredentialId],
  );
  const packageId = randomUUID();
  await client.query(
    `INSERT INTO "ShipmentPackage" (
      "id", "shipmentId", "packageNumber", "weightGrams", "lengthMillimeters", "widthMillimeters",
      "heightMillimeters", "declaredValueCents", "requestKey", "requestHash", "credentialId"
    ) VALUES ($1, $2, 1, 1500, 300, 200, 100, 195000, $3, $4, $5)`,
    [
      packageId,
      checkout.shipmentId,
      `matrix-package-${randomUUID()}`,
      randomBytes(32),
      aveonlineCredentialId,
    ],
  );
  await client.query(
    `INSERT INTO "ShipmentPackageItem" ("packageId", "shipmentItemId", "quantity", "declaredValueCents")
     SELECT $1, "id", 2, 195000 FROM "ShipmentItem" WHERE "shipmentId" = $2 AND "orderItemId" = $3`,
    [packageId, checkout.shipmentId, checkout.orderItemId],
  );
  await client.query(
    `INSERT INTO "ShipmentEvent" ("shipmentId", "packageId", "actorAdminUserId", "type", "eventKey", "metadata")
     VALUES ($1, $2, $3, 'PACKAGE_SEALED', $4, '{"source":"matrix"}'::jsonb)`,
    [checkout.shipmentId, packageId, adminId, `matrix-package-event-${randomUUID()}`],
  );

  await client.query(
    `INSERT INTO "EmailTemplateOverride" (
      "templateKey", "locale", "version", "subject", "htmlBody", "textBody", "variables", "createdByAdminUserId"
    ) VALUES ('order.paid', 'es-CO', 1, 'Aviso {{unsubscribeUrl}}', '<p>{{unsubscribeUrl}}</p>', '{{unsubscribeUrl}}', '["unsubscribeUrl"]'::jsonb, $1)`,
    [adminId],
  );
  const emailEventId = randomUUID();
  await client.query(
    `INSERT INTO "EmailEvent" (
      "id", "orderId", "credentialId", "templateKey", "topic", "subjectSnapshot", "htmlBodySnapshot",
      "textBodySnapshot", "variablesSnapshot", "recipientEmail", "recipientHash", "idempotencyKey", "unsubscribeTokenHash"
    ) VALUES ($1, $2, $3, 'order.paid', 'orders', 'Pago confirmado', '<p>Confirmado</p>', 'Confirmado',
      '{"unsubscribeUrl":"https://example.test/baja"}'::jsonb, 'rls-checkout@example.test', $4, $5, $6)`,
    [
      emailEventId,
      checkout.orderId,
      resendCredentialId,
      randomBytes(32),
      `matrix-email-${randomUUID()}`,
      randomBytes(32),
    ],
  );
  await client.query(
    `INSERT INTO "EmailSuppression" ("recipientHash", "topic", "reason", "sourceEventId")
     VALUES ($1, 'orders', 'UNSUBSCRIBE', $2)`,
    [randomBytes(32), emailEventId],
  );
  await client.query(
    `INSERT INTO "EmailWebhookEvent" ("credentialId", "emailEventId", "svixEventId", "eventType", "payloadHash", "occurredAt", "processedAt")
     VALUES ($1, $2, $3, 'email.sent', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [resendCredentialId, emailEventId, `msg_${randomUUID().replaceAll("-", "")}`, randomBytes(32)],
  );

  const completedRefundId = randomUUID();
  await client.query(
    `INSERT INTO "OrderRefund" ("id", "orderId", "idempotencyKey", "requestHash", "reason", "subtotalCents", "taxCents", "totalCents", "requestedByAdminUserId")
     VALUES ($1, $2, $3, $4, 'RETRACT', 50000, 0, 50000, $5)`,
    [
      completedRefundId,
      checkout.orderId,
      `matrix-completed-refund-${randomUUID()}`,
      randomBytes(32),
      adminId,
    ],
  );
  await client.query(
    `INSERT INTO "OrderRefundItem" ("refundId", "orderItemId", "quantity", "subtotalCents", "taxCents", "totalCents")
     VALUES ($1, $2, 1, 50000, 0, 50000)`,
    [completedRefundId, checkout.orderItemId],
  );
  await client.query(
    `INSERT INTO "PaymentTransaction" ("attemptId", "refundId", "provider", "kind", "status", "amountCents", "externalId", "requestHash", "completedAt")
     VALUES ($1, $2, 'WOMPI', 'REFUND', 'SUCCEEDED', 50000, $3, $4, CURRENT_TIMESTAMP)`,
    [payments.wompiAttemptId, completedRefundId, `refund-${randomUUID()}`, randomBytes(32)],
  );
  await client.query(`UPDATE "OrderRefund" SET "status" = 'APPROVED' WHERE "id" = $1`, [
    completedRefundId,
  ]);
  await client.query(`UPDATE "OrderRefund" SET "status" = 'PROCESSING' WHERE "id" = $1`, [
    completedRefundId,
  ]);
  await client.query(
    `UPDATE "OrderRefund" SET "status" = 'COMPLETED', "processedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [completedRefundId],
  );

  const invoiceId = randomUUID();
  await client.query(
    `INSERT INTO "TaxInvoice" (
      "id", "orderId", "credentialId", "environment", "prefix", "number", "fullNumber", "cufe",
      "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "requestHash",
      "unsignedXml", "signedXml", "documentHash", "providerDocumentId", "status", "acceptedAt"
    ) VALUES ($1, $2, $3, 'LOCAL', 'RLS', 1, 'RLS1', $4, 200000, 5000, 0, 0, 195000, $5,
      '<Invoice>RLS1</Invoice>', '<Invoice><Signature>RLS1</Signature></Invoice>', $6, $7, 'ACCEPTED', CURRENT_TIMESTAMP)`,
    [
      invoiceId,
      checkout.orderId,
      dianCredentialId,
      randomBytes(48).toString("hex"),
      randomBytes(32),
      randomBytes(32),
      `dian-${randomUUID()}`,
    ],
  );
  const creditNoteId = randomUUID();
  await client.query(
    `INSERT INTO "CreditNote" (
      "id", "invoiceId", "refundId", "credentialId", "prefix", "number", "fullNumber", "cude",
      "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "reasonCode", "requestHash",
      "unsignedXml", "signedXml", "documentHash", "providerDocumentId", "status", "acceptedAt"
    ) VALUES ($1, $2, $3, $4, 'RLSNC', 1, 'RLSNC1', $5, 100000, 50000, 0, 0, 50000, 1, $6,
      '<CreditNote>RLSNC1</CreditNote>', '<CreditNote><Signature>RLSNC1</Signature></CreditNote>', $7, $8, 'ACCEPTED', CURRENT_TIMESTAMP)`,
    [
      creditNoteId,
      invoiceId,
      completedRefundId,
      dianCredentialId,
      randomBytes(48).toString("hex"),
      randomBytes(32),
      randomBytes(32),
      `dian-${randomUUID()}`,
    ],
  );
  return { zoneId, fulfillmentId, packageId, emailEventId, invoiceId, creditNoteId };
}
