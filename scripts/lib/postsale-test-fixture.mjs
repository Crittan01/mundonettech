import { randomBytes, randomUUID } from "node:crypto";

export const postsaleTables = [
  "Address",
  "GuestOrderChallenge",
  "GuestOrderSession",
  "ReturnRequest",
  "ReturnRequestItem",
  "ReturnRequestUnit",
  "WarrantyClaim",
  "SupportTicket",
  "SupportTicketMessage",
  "Review",
];

export async function seedPostSaleFixture(client, { catalog, inventory }) {
  await client.query(
    `INSERT INTO "Address" ("customerId", "label", "recipientName", "phoneE164", "departmentCode", "municipalityCode", "addressLine1", "isDefault")
     VALUES ($1, 'Casa matriz', 'Cliente RLS', '+573001234567', '11', '11001', 'Carrera 7 # 71-21', true)`,
    [catalog.customerId],
  );

  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const shipmentId = randomUUID();
  const shipmentItemId = randomUUID();
  const orderNumber = `POST-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  const deliveredAt = new Date();
  await client.query(
    `INSERT INTO "Order" ("id", "orderNumber", "customerId", "orderStatus", "paymentStatus", "fulfillmentStatus", "fulfillmentMethod", "taxRegime", "emailSnapshot", "buyerDocumentTypeSnapshot", "buyerDocumentNumberSnapshot", "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "confirmedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 'PAID', 'FULFILLED', 'HOME_DELIVERY', 'NO_RESPONSABLE_IVA', 'rls-postsale@example.test', '13', '1020304050', 200000, 0, 0, 0, 200000, CURRENT_TIMESTAMP)`,
    [orderId, orderNumber, catalog.customerId],
  );
  await client.query(
    `INSERT INTO "OrderItem" ("id", "orderId", "variantId", "quantity", "titleSnapshot", "productSlugSnapshot", "skuSnapshot", "unitPriceCents", "unitCostWacCents", "discountCents", "lineTotalCents", "taxCents")
     VALUES ($1, $2, $3, 2, 'Audífonos TÁCTILES Pro', 'producto-postsale', $4, 100000, 60000, 0, 200000, 0)`,
    [orderItemId, orderId, catalog.variantId, `POST-${randomUUID().slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO "OrderReceipt" ("orderId", "receiptNumber", "accessTokenHash", "taxRegime", "currency", "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents", "contentHash")
     VALUES ($1, $2, $3, 'NO_RESPONSABLE_IVA', 'COP', 200000, 0, 0, 0, 200000, $4)`,
    [orderId, `R-${orderNumber}`, randomBytes(32), randomBytes(32)],
  );
  await client.query(
    `INSERT INTO "Shipment" ("id", "orderId", "originLocationId", "kind", "promisedAt") VALUES ($1, $2, $3, 'DELIVERY', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
    [shipmentId, orderId, inventory.locationId],
  );
  await client.query(
    `INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "quantity", "declaredValueCents") VALUES ($1, $2, $3, 2, 200000)`,
    [shipmentItemId, shipmentId, orderItemId],
  );
  const serializedUnitIds = [randomUUID(), randomUUID()];
  for (const [index, id] of serializedUnitIds.entries()) {
    await client.query(
      `INSERT INTO "SerializedUnit" ("id", "variantId", "locationId", "orderId", "shipmentId", "serial", "status", "soldAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'SOLD', CURRENT_TIMESTAMP)`,
      [
        id,
        catalog.variantId,
        inventory.locationId,
        orderId,
        shipmentId,
        `POST-SERIAL-${randomUUID()}-${index}`,
      ],
    );
  }
  await client.query(`UPDATE "Shipment" SET "status" = 'READY', "readyAt" = $2 WHERE "id" = $1`, [
    shipmentId,
    new Date(deliveredAt.getTime() - 3_600_000),
  ]);
  await client.query(
    `UPDATE "Shipment" SET "status" = 'SHIPPED', "shippedAt" = $2 WHERE "id" = $1`,
    [shipmentId, new Date(deliveredAt.getTime() - 2_600_000)],
  );
  await client.query(
    `UPDATE "Shipment" SET "status" = 'DELIVERED', "deliveredAt" = $2 WHERE "id" = $1`,
    [shipmentId, deliveredAt],
  );

  const challengeId = randomUUID();
  await client.query(
    `INSERT INTO "GuestOrderChallenge" ("id", "orderId", "idempotencyKey", "codeHash", "requestIpHash", "status", "lastSentAt", "providerMessageId", "expiresAt", "consumedAt")
     VALUES ($1, $2, $3, $4, $5, 'CONSUMED', CURRENT_TIMESTAMP, $6, CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP)`,
    [
      challengeId,
      orderId,
      `matrix-guest-${randomUUID()}`,
      randomBytes(32),
      randomBytes(32),
      `msg_${randomUUID().replaceAll("-", "")}`,
    ],
  );
  await client.query(
    `INSERT INTO "GuestOrderSession" ("orderId", "challengeId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
    [orderId, challengeId, randomBytes(32)],
  );

  const returnRequestId = randomUUID();
  await client.query(
    `INSERT INTO "ReturnRequest" ("id", "orderId", "requesterCustomerId", "idempotencyKey", "requestHash", "kind", "status", "reason", "retractRefundDueAt")
     VALUES ($1, $2, $3, $4, $5, 'REFUND', 'REJECTED', 'Solicitud parcial dentro de la ventana legal de retracto.', CURRENT_TIMESTAMP + INTERVAL '15 days')`,
    [
      returnRequestId,
      orderId,
      catalog.customerId,
      `matrix-return-${randomUUID()}`,
      randomBytes(32),
    ],
  );
  const returnItemId = randomUUID();
  await client.query(
    `INSERT INTO "ReturnRequestItem" ("id", "returnRequestId", "orderItemId", "shipmentItemId", "quantity", "deliveredAt", "retractDueAt")
     VALUES ($1, $2, $3, $4, 1, $5, CURRENT_TIMESTAMP + INTERVAL '5 days')`,
    [returnItemId, returnRequestId, orderItemId, shipmentItemId, deliveredAt],
  );
  await client.query(
    `INSERT INTO "ReturnRequestUnit" ("returnRequestItemId", "serializedUnitId") VALUES ($1, $2)`,
    [returnItemId, serializedUnitIds[0]],
  );

  await client.query(
    `INSERT INTO "WarrantyClaim" ("orderId", "orderItemId", "serializedUnitId", "requesterCustomerId", "idempotencyKey", "requestHash", "issueDescription", "remedy", "warrantyDueAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'La unidad presenta una falla técnica cubierta por la garantía.', 'REPAIR', CURRENT_TIMESTAMP + INTERVAL '12 months')`,
    [
      orderId,
      orderItemId,
      serializedUnitIds[1],
      catalog.customerId,
      `matrix-warranty-${randomUUID()}`,
      randomBytes(32),
    ],
  );

  const ticketId = randomUUID();
  await client.query(
    `INSERT INTO "SupportTicket" ("id", "ticketNumber", "orderId", "requesterCustomerId", "idempotencyKey", "requestHash", "kind", "subject", "contactEmailSnapshot", "slaDueAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'QUERY', 'Consulta de posventa matriz', 'rls-postsale@example.test', CURRENT_TIMESTAMP + INTERVAL '10 days')`,
    [
      ticketId,
      `PQR-2026-${ticketId}`,
      orderId,
      catalog.customerId,
      `matrix-support-${randomUUID()}`,
      randomBytes(32),
    ],
  );
  await client.query(
    `INSERT INTO "SupportTicketMessage" ("ticketId", "idempotencyKey", "authorType", "authorCustomerId", "body")
     VALUES ($1, $2, 'CUSTOMER', $3, 'Necesito confirmar el estado de mi solicitud de posventa.')`,
    [ticketId, `matrix-message-${randomUUID()}`, catalog.customerId],
  );

  await client.query(
    `INSERT INTO "Review" ("orderItemId", "productId", "requesterCustomerId", "idempotencyKey", "requestHash", "rating", "title", "body", "authorDisplayName")
     VALUES ($1, $2, $3, $4, $5, 5, 'Compra verificada', 'El producto entregado coincide con las especificaciones de la compra.', 'Cliente RLS')`,
    [
      orderItemId,
      catalog.productId,
      catalog.customerId,
      `matrix-review-${randomUUID()}`,
      randomBytes(32),
    ],
  );

  return {
    orderId,
    orderItemId,
    shipmentId,
    shipmentItemId,
    returnRequestId,
    returnItemId,
    ticketId,
  };
}
