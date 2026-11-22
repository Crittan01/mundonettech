CREATE TYPE "GuestOrderChallengeStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CONSUMED', 'EXPIRED');
CREATE TYPE "ReturnRequestKind" AS ENUM ('REFUND', 'EXCHANGE');
CREATE TYPE "ReturnRequestStatus" AS ENUM ('REQUESTED', 'AWAITING_RETURN', 'RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED');
CREATE TYPE "WarrantyClaimStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RESOLVED', 'CANCELLED');
CREATE TYPE "WarrantyRemedy" AS ENUM ('REFUND', 'REPAIR', 'REPLACEMENT');
CREATE TYPE "SupportTicketKind" AS ENUM ('QUERY', 'COMPLAINT', 'CLAIM', 'APPEAL', 'SUGGESTION');
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');
CREATE TYPE "SupportMessageAuthor" AS ENUM ('CUSTOMER', 'GUEST', 'ADMIN');
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

CREATE TABLE "Address" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "label" VARCHAR(80) NOT NULL,
  "recipientName" VARCHAR(200) NOT NULL,
  "phoneE164" VARCHAR(16) NOT NULL,
  "countryCode" CHAR(2) NOT NULL DEFAULT 'CO',
  "departmentCode" CHAR(2) NOT NULL,
  "municipalityCode" CHAR(5) NOT NULL,
  "addressLine1" VARCHAR(200) NOT NULL,
  "addressLine2" VARCHAR(200),
  "neighborhood" VARCHAR(120),
  "postalCode" VARCHAR(6),
  "deliveryNotes" VARCHAR(500),
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GuestOrderChallenge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "codeHash" BYTEA NOT NULL,
  "requestIpHash" BYTEA NOT NULL,
  "status" "GuestOrderChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "providerMessageId" VARCHAR(128),
  "failureCode" VARCHAR(100),
  "lastSentAt" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestOrderChallenge_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GuestOrderSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "challengeId" UUID NOT NULL,
  "tokenHash" BYTEA NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "lastUsedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestOrderSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReturnRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "requesterCustomerId" UUID,
  "requesterGuestSessionId" UUID,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "kind" "ReturnRequestKind" NOT NULL,
  "status" "ReturnRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "reason" VARCHAR(2000) NOT NULL,
  "resolutionNote" VARCHAR(500),
  "retractRefundDueAt" TIMESTAMPTZ(6),
  "refundId" UUID,
  "version" INTEGER NOT NULL DEFAULT 0,
  "reviewedByAdminUserId" UUID,
  "reviewedAt" TIMESTAMPTZ(6),
  "receivedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReturnRequestItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "returnRequestId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "shipmentItemId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "replacementVariantId" UUID,
  "deliveredAt" TIMESTAMPTZ(6) NOT NULL,
  "retractDueAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnRequestItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReturnRequestUnit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "returnRequestItemId" UUID NOT NULL,
  "serializedUnitId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnRequestUnit_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WarrantyClaim" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "serializedUnitId" UUID NOT NULL,
  "requesterCustomerId" UUID,
  "requesterGuestSessionId" UUID,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "issueDescription" VARCHAR(2000) NOT NULL,
  "remedy" "WarrantyRemedy" NOT NULL,
  "status" "WarrantyClaimStatus" NOT NULL DEFAULT 'REQUESTED',
  "warrantyDueAt" TIMESTAMPTZ(6) NOT NULL,
  "resolutionNote" VARCHAR(500),
  "refundId" UUID,
  "version" INTEGER NOT NULL DEFAULT 0,
  "reviewedByAdminUserId" UUID,
  "reviewedAt" TIMESTAMPTZ(6),
  "resolvedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WarrantyClaim_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SupportTicket" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ticketNumber" VARCHAR(64) NOT NULL,
  "orderId" UUID,
  "requesterCustomerId" UUID,
  "requesterGuestSessionId" UUID,
  "assignedToAdminUserId" UUID,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "kind" "SupportTicketKind" NOT NULL,
  "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
  "subject" VARCHAR(200) NOT NULL,
  "contactEmailSnapshot" VARCHAR(320) NOT NULL,
  "slaDueAt" TIMESTAMPTZ(6) NOT NULL,
  "firstResponseAt" TIMESTAMPTZ(6),
  "resolvedAt" TIMESTAMPTZ(6),
  "closedAt" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SupportTicketMessage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ticketId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "authorType" "SupportMessageAuthor" NOT NULL,
  "authorCustomerId" UUID,
  "authorGuestSessionId" UUID,
  "authorAdminUserId" UUID,
  "body" VARCHAR(5000) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Review" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderItemId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "requesterCustomerId" UUID,
  "requesterGuestSessionId" UUID,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "body" VARCHAR(2000) NOT NULL,
  "authorDisplayName" VARCHAR(80) NOT NULL,
  "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
  "moderationNote" VARCHAR(500),
  "moderatedByAdminUserId" UUID,
  "moderatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Order" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(6);

ALTER TABLE "Address" ADD CONSTRAINT "Address_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Address_municipalityCode_fkey" FOREIGN KEY ("municipalityCode") REFERENCES "DaneMunicipality"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuestOrderChallenge" ADD CONSTRAINT "GuestOrderChallenge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuestOrderSession" ADD CONSTRAINT "GuestOrderSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GuestOrderSession_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "GuestOrderChallenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequest_requesterCustomerId_fkey" FOREIGN KEY ("requesterCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequest_requesterGuestSessionId_fkey" FOREIGN KEY ("requesterGuestSessionId") REFERENCES "GuestOrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequest_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequest_reviewedByAdminUserId_fkey" FOREIGN KEY ("reviewedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequestItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequestItem_shipmentItemId_fkey" FOREIGN KEY ("shipmentItemId") REFERENCES "ShipmentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequestItem_replacementVariantId_fkey" FOREIGN KEY ("replacementVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnRequestUnit" ADD CONSTRAINT "ReturnRequestUnit_returnRequestItemId_fkey" FOREIGN KEY ("returnRequestItemId") REFERENCES "ReturnRequestItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReturnRequestUnit_serializedUnitId_fkey" FOREIGN KEY ("serializedUnitId") REFERENCES "SerializedUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WarrantyClaim_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WarrantyClaim_serializedUnitId_fkey" FOREIGN KEY ("serializedUnitId") REFERENCES "SerializedUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WarrantyClaim_requesterCustomerId_fkey" FOREIGN KEY ("requesterCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WarrantyClaim_requesterGuestSessionId_fkey" FOREIGN KEY ("requesterGuestSessionId") REFERENCES "GuestOrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WarrantyClaim_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "WarrantyClaim_reviewedByAdminUserId_fkey" FOREIGN KEY ("reviewedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicket_requesterCustomerId_fkey" FOREIGN KEY ("requesterCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicket_requesterGuestSessionId_fkey" FOREIGN KEY ("requesterGuestSessionId") REFERENCES "GuestOrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicket_assignedToAdminUserId_fkey" FOREIGN KEY ("assignedToAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicketMessage_authorCustomerId_fkey" FOREIGN KEY ("authorCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicketMessage_authorGuestSessionId_fkey" FOREIGN KEY ("authorGuestSessionId") REFERENCES "GuestOrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicketMessage_authorAdminUserId_fkey" FOREIGN KEY ("authorAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Review_requesterCustomerId_fkey" FOREIGN KEY ("requesterCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Review_requesterGuestSessionId_fkey" FOREIGN KEY ("requesterGuestSessionId") REFERENCES "GuestOrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Review_moderatedByAdminUserId_fkey" FOREIGN KEY ("moderatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GuestOrderChallenge_idempotencyKey_key" ON "GuestOrderChallenge"("idempotencyKey");
CREATE UNIQUE INDEX "GuestOrderSession_challengeId_key" ON "GuestOrderSession"("challengeId");
CREATE UNIQUE INDEX "GuestOrderSession_tokenHash_key" ON "GuestOrderSession"("tokenHash");
CREATE UNIQUE INDEX "ReturnRequest_idempotencyKey_key" ON "ReturnRequest"("idempotencyKey");
CREATE UNIQUE INDEX "ReturnRequest_refundId_key" ON "ReturnRequest"("refundId");
CREATE UNIQUE INDEX "ReturnRequestItem_returnRequestId_shipmentItemId_key" ON "ReturnRequestItem"("returnRequestId", "shipmentItemId");
CREATE UNIQUE INDEX "ReturnRequestUnit_serializedUnitId_key" ON "ReturnRequestUnit"("serializedUnitId");
CREATE UNIQUE INDEX "ReturnRequestUnit_returnRequestItemId_serializedUnitId_key" ON "ReturnRequestUnit"("returnRequestItemId", "serializedUnitId");
CREATE UNIQUE INDEX "WarrantyClaim_idempotencyKey_key" ON "WarrantyClaim"("idempotencyKey");
CREATE UNIQUE INDEX "WarrantyClaim_refundId_key" ON "WarrantyClaim"("refundId");
CREATE UNIQUE INDEX "SupportTicket_ticketNumber_key" ON "SupportTicket"("ticketNumber");
CREATE UNIQUE INDEX "SupportTicket_idempotencyKey_key" ON "SupportTicket"("idempotencyKey");
CREATE UNIQUE INDEX "SupportTicketMessage_idempotencyKey_key" ON "SupportTicketMessage"("idempotencyKey");
CREATE UNIQUE INDEX "Review_orderItemId_key" ON "Review"("orderItemId");
CREATE UNIQUE INDEX "Review_idempotencyKey_key" ON "Review"("idempotencyKey");
CREATE INDEX "Address_customerId_deletedAt_isDefault_idx" ON "Address"("customerId", "deletedAt", "isDefault");
CREATE INDEX "Address_municipalityCode_idx" ON "Address"("municipalityCode");
CREATE UNIQUE INDEX "Address_one_default_active_key" ON "Address"("customerId") WHERE "isDefault" = true AND "deletedAt" IS NULL;
CREATE INDEX "GuestOrderChallenge_orderId_status_createdAt_idx" ON "GuestOrderChallenge"("orderId", "status", "createdAt");
CREATE INDEX "GuestOrderChallenge_status_expiresAt_idx" ON "GuestOrderChallenge"("status", "expiresAt");
CREATE INDEX "GuestOrderSession_orderId_revokedAt_expiresAt_idx" ON "GuestOrderSession"("orderId", "revokedAt", "expiresAt");
CREATE INDEX "ReturnRequest_orderId_status_createdAt_idx" ON "ReturnRequest"("orderId", "status", "createdAt");
CREATE INDEX "ReturnRequest_requesterCustomerId_createdAt_idx" ON "ReturnRequest"("requesterCustomerId", "createdAt");
CREATE INDEX "ReturnRequest_requesterGuestSessionId_createdAt_idx" ON "ReturnRequest"("requesterGuestSessionId", "createdAt");
CREATE INDEX "ReturnRequest_status_createdAt_idx" ON "ReturnRequest"("status", "createdAt");
CREATE INDEX "ReturnRequestItem_orderItemId_returnRequestId_idx" ON "ReturnRequestItem"("orderItemId", "returnRequestId");
CREATE INDEX "ReturnRequestItem_replacementVariantId_idx" ON "ReturnRequestItem"("replacementVariantId");
CREATE INDEX "ReturnRequestUnit_returnRequestItemId_idx" ON "ReturnRequestUnit"("returnRequestItemId");
CREATE INDEX "WarrantyClaim_orderId_status_createdAt_idx" ON "WarrantyClaim"("orderId", "status", "createdAt");
CREATE INDEX "WarrantyClaim_serializedUnitId_status_createdAt_idx" ON "WarrantyClaim"("serializedUnitId", "status", "createdAt");
CREATE INDEX "WarrantyClaim_requesterCustomerId_createdAt_idx" ON "WarrantyClaim"("requesterCustomerId", "createdAt");
CREATE INDEX "WarrantyClaim_requesterGuestSessionId_createdAt_idx" ON "WarrantyClaim"("requesterGuestSessionId", "createdAt");
CREATE INDEX "WarrantyClaim_status_warrantyDueAt_createdAt_idx" ON "WarrantyClaim"("status", "warrantyDueAt", "createdAt");
CREATE INDEX "SupportTicket_requesterCustomerId_createdAt_idx" ON "SupportTicket"("requesterCustomerId", "createdAt");
CREATE INDEX "SupportTicket_requesterGuestSessionId_createdAt_idx" ON "SupportTicket"("requesterGuestSessionId", "createdAt");
CREATE INDEX "SupportTicket_orderId_createdAt_idx" ON "SupportTicket"("orderId", "createdAt");
CREATE INDEX "SupportTicket_status_slaDueAt_createdAt_idx" ON "SupportTicket"("status", "slaDueAt", "createdAt");
CREATE INDEX "SupportTicket_assignedToAdminUserId_status_createdAt_idx" ON "SupportTicket"("assignedToAdminUserId", "status", "createdAt");
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_id_idx" ON "SupportTicketMessage"("ticketId", "createdAt", "id");
CREATE INDEX "SupportTicketMessage_authorCustomerId_createdAt_idx" ON "SupportTicketMessage"("authorCustomerId", "createdAt");
CREATE INDEX "SupportTicketMessage_authorGuestSessionId_createdAt_idx" ON "SupportTicketMessage"("authorGuestSessionId", "createdAt");
CREATE INDEX "SupportTicketMessage_authorAdminUserId_createdAt_idx" ON "SupportTicketMessage"("authorAdminUserId", "createdAt");
CREATE INDEX "Review_productId_status_createdAt_idx" ON "Review"("productId", "status", "createdAt");
CREATE INDEX "Review_requesterCustomerId_createdAt_idx" ON "Review"("requesterCustomerId", "createdAt");
CREATE INDEX "Review_requesterGuestSessionId_createdAt_idx" ON "Review"("requesterGuestSessionId", "createdAt");
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

ALTER TABLE "Address" ADD CONSTRAINT "Address_identity_valid" CHECK (
  "label" = btrim("label") AND char_length("label") BETWEEN 2 AND 80 AND
  "recipientName" = btrim("recipientName") AND char_length("recipientName") BETWEEN 2 AND 200 AND
  "phoneE164" ~ '^\+[1-9][0-9]{7,14}$' AND "countryCode" = 'CO' AND
  "departmentCode" ~ '^[0-9]{2}$' AND "municipalityCode" ~ '^[0-9]{5}$' AND
  "addressLine1" = btrim("addressLine1") AND char_length("addressLine1") BETWEEN 3 AND 200 AND
  ("addressLine2" IS NULL OR char_length("addressLine2") <= 200) AND
  ("neighborhood" IS NULL OR char_length("neighborhood") <= 120) AND
  ("postalCode" IS NULL OR "postalCode" ~ '^[0-9]{6}$') AND
  ("deliveryNotes" IS NULL OR char_length("deliveryNotes") <= 500)
);
ALTER TABLE "GuestOrderChallenge" ADD CONSTRAINT "GuestOrderChallenge_hashes_length" CHECK (octet_length("codeHash") = 32 AND octet_length("requestIpHash") = 32),
  ADD CONSTRAINT "GuestOrderChallenge_attempts_valid" CHECK ("attempts" BETWEEN 0 AND 5),
  ADD CONSTRAINT "GuestOrderChallenge_expiration_valid" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "GuestOrderChallenge_status_consistent" CHECK (
    ("status" = 'CONSUMED' AND "consumedAt" IS NOT NULL AND "lastSentAt" IS NOT NULL) OR
    ("status" = 'SENT' AND "lastSentAt" IS NOT NULL AND "providerMessageId" IS NOT NULL AND "consumedAt" IS NULL) OR
    ("status" IN ('PENDING', 'FAILED', 'EXPIRED') AND "consumedAt" IS NULL)
  );
ALTER TABLE "GuestOrderSession" ADD CONSTRAINT "GuestOrderSession_tokenHash_length" CHECK (octet_length("tokenHash") = 32),
  ADD CONSTRAINT "GuestOrderSession_expiration_valid" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_requester_valid" CHECK (num_nonnulls("requesterCustomerId", "requesterGuestSessionId") = 1),
  ADD CONSTRAINT "ReturnRequest_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "ReturnRequest_reason_valid" CHECK ("reason" = btrim("reason") AND char_length("reason") BETWEEN 10 AND 2000),
  ADD CONSTRAINT "ReturnRequest_refund_deadline_valid" CHECK (("kind" = 'REFUND') = ("retractRefundDueAt" IS NOT NULL)),
  ADD CONSTRAINT "ReturnRequest_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_requester_valid" CHECK (num_nonnulls("requesterCustomerId", "requesterGuestSessionId") = 1),
  ADD CONSTRAINT "WarrantyClaim_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "WarrantyClaim_issue_valid" CHECK ("issueDescription" = btrim("issueDescription") AND char_length("issueDescription") BETWEEN 10 AND 2000),
  ADD CONSTRAINT "WarrantyClaim_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_requester_valid" CHECK (num_nonnulls("requesterCustomerId", "requesterGuestSessionId") = 1),
  ADD CONSTRAINT "SupportTicket_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "SupportTicket_ticketNumber_valid" CHECK ("ticketNumber" ~ '^PQR-[0-9]{4}-[0-9a-f-]{36}$'),
  ADD CONSTRAINT "SupportTicket_subject_valid" CHECK ("subject" = btrim("subject") AND char_length("subject") BETWEEN 5 AND 200),
  ADD CONSTRAINT "SupportTicket_contact_valid" CHECK ("contactEmailSnapshot" = lower(btrim("contactEmailSnapshot")) AND "contactEmailSnapshot" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  ADD CONSTRAINT "SupportTicket_version_nonnegative" CHECK ("version" >= 0),
  ADD CONSTRAINT "SupportTicket_sla_valid" CHECK ("slaDueAt" > "createdAt");
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_author_valid" CHECK (
  ("authorType" = 'CUSTOMER' AND "authorCustomerId" IS NOT NULL AND "authorGuestSessionId" IS NULL AND "authorAdminUserId" IS NULL) OR
  ("authorType" = 'GUEST' AND "authorCustomerId" IS NULL AND "authorGuestSessionId" IS NOT NULL AND "authorAdminUserId" IS NULL) OR
  ("authorType" = 'ADMIN' AND "authorCustomerId" IS NULL AND "authorGuestSessionId" IS NULL AND "authorAdminUserId" IS NOT NULL)
), ADD CONSTRAINT "SupportTicketMessage_body_valid" CHECK ("body" = btrim("body") AND char_length("body") BETWEEN 2 AND 5000);
ALTER TABLE "Review" ADD CONSTRAINT "Review_requester_valid" CHECK (num_nonnulls("requesterCustomerId", "requesterGuestSessionId") = 1),
  ADD CONSTRAINT "Review_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "Review_rating_valid" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "Review_content_valid" CHECK (
    "title" = btrim("title") AND char_length("title") BETWEEN 3 AND 120 AND
    "body" = btrim("body") AND char_length("body") BETWEEN 20 AND 2000 AND
    "authorDisplayName" = btrim("authorDisplayName") AND char_length("authorDisplayName") BETWEEN 2 AND 80
  ),
  ADD CONSTRAINT "Review_moderation_consistent" CHECK (("status" = 'PENDING') = ("moderatedAt" IS NULL) AND ("status" = 'PENDING') = ("moderatedByAdminUserId" IS NULL));

ALTER TABLE "Order" DROP CONSTRAINT "Order_checkout_snapshot_complete";
ALTER TABLE "Order" ADD CONSTRAINT "Order_checkout_snapshot_complete" CHECK (
  "cartId" IS NULL OR "anonymizedAt" IS NOT NULL OR (
    "fulfillmentMethod" IS NOT NULL AND "taxRegime" IS NOT NULL AND "uvtValueCents" > 0 AND
    "uvtYear" BETWEEN 2000 AND 9999 AND "emailSnapshot" IS NOT NULL AND "recipientNameSnapshot" IS NOT NULL AND
    "phoneE164Snapshot" IS NOT NULL AND "departmentCode" IS NOT NULL AND "addressLine1Snapshot" IS NOT NULL AND
    "deliveryPromiseAt" IS NOT NULL AND "reservationKey" IS NOT NULL AND "reservationExpiresAt" IS NOT NULL AND
    (("fulfillmentMethod" IN ('HOME_DELIVERY', 'LOCAL_DELIVERY') AND "clickCollectLocationId" IS NULL) OR
     ("fulfillmentMethod" = 'CLICK_COLLECT' AND "clickCollectLocationId" IS NOT NULL))
  )
);
ALTER TABLE "Order" DROP CONSTRAINT "Order_delivery_coordinates_valid", DROP CONSTRAINT "Order_buyer_document_valid", DROP CONSTRAINT "Order_buyer_fiscal_regime_valid";
ALTER TABLE "Order" ADD CONSTRAINT "Order_delivery_coordinates_valid" CHECK (
  (("deliveryLatitudeE6" IS NULL) = ("deliveryLongitudeE6" IS NULL)) AND
  ("deliveryLatitudeE6" IS NULL OR ("deliveryLatitudeE6" BETWEEN -90000000 AND 90000000 AND "deliveryLongitudeE6" BETWEEN -180000000 AND 180000000)) AND
  ("anonymizedAt" IS NOT NULL OR "fulfillmentMethod" IS DISTINCT FROM 'LOCAL_DELIVERY' OR "deliveryLatitudeE6" IS NOT NULL)
), ADD CONSTRAINT "Order_buyer_document_valid" CHECK (
  (("buyerDocumentTypeSnapshot" IS NULL) = ("buyerDocumentNumberSnapshot" IS NULL)) AND
  ("buyerDocumentTypeSnapshot" IS NULL OR "buyerDocumentTypeSnapshot" IN ('11', '12', '13', '21', '22', '31', '41', '42', '50', '91')) AND
  ("buyerDocumentNumberSnapshot" IS NULL OR "buyerDocumentNumberSnapshot" ~ '^[A-Za-z0-9.-]{3,30}$') AND
  ("anonymizedAt" IS NOT NULL OR (("taxRegime" IS DISTINCT FROM 'RESPONSABLE_IVA' AND "fulfillmentMethod" IS DISTINCT FROM 'HOME_DELIVERY') OR "buyerDocumentTypeSnapshot" IS NOT NULL))
), ADD CONSTRAINT "Order_buyer_fiscal_regime_valid" CHECK (
  "anonymizedAt" IS NOT NULL OR "taxRegime" IS DISTINCT FROM 'RESPONSABLE_IVA' OR "buyerTaxRegimeSnapshot" IS NOT NULL
);

CREATE OR REPLACE FUNCTION "protect_order_snapshots"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Order history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."anonymizedAt" IS NOT NULL THEN
    IF NEW."emailSnapshot" IS NOT NULL OR NEW."recipientNameSnapshot" IS NOT NULL OR
       NEW."phoneE164Snapshot" IS NOT NULL OR NEW."buyerDocumentTypeSnapshot" IS NOT NULL OR
       NEW."buyerDocumentNumberSnapshot" IS NOT NULL OR NEW."buyerTaxRegimeSnapshot" IS NOT NULL OR
       NEW."addressLine1Snapshot" IS NOT NULL OR NEW."addressLine2Snapshot" IS NOT NULL OR
       NEW."neighborhoodSnapshot" IS NOT NULL OR NEW."postalCodeSnapshot" IS NOT NULL OR
       NEW."deliveryNotesSnapshot" IS NOT NULL OR NEW."deliveryLatitudeE6" IS NOT NULL OR
       NEW."deliveryLongitudeE6" IS NOT NULL OR NEW."acceptanceIpHash" IS NOT NULL OR
       NEW."acceptanceUserAgentHash" IS NOT NULL THEN
      RAISE EXCEPTION 'Anonymized orders cannot restore personal snapshots' USING ERRCODE = '55000';
    END IF;
    IF OLD."anonymizedAt" IS NULL THEN
      IF to_jsonb(NEW) - ARRAY['emailSnapshot','recipientNameSnapshot','phoneE164Snapshot','buyerDocumentTypeSnapshot','buyerDocumentNumberSnapshot','buyerTaxRegimeSnapshot','addressLine1Snapshot','addressLine2Snapshot','neighborhoodSnapshot','postalCodeSnapshot','deliveryNotesSnapshot','deliveryLatitudeE6','deliveryLongitudeE6','acceptanceIpHash','acceptanceUserAgentHash','anonymizedAt','updatedAt'] IS DISTINCT FROM
         to_jsonb(OLD) - ARRAY['emailSnapshot','recipientNameSnapshot','phoneE164Snapshot','buyerDocumentTypeSnapshot','buyerDocumentNumberSnapshot','buyerTaxRegimeSnapshot','addressLine1Snapshot','addressLine2Snapshot','neighborhoodSnapshot','postalCodeSnapshot','deliveryNotesSnapshot','deliveryLatitudeE6','deliveryLongitudeE6','acceptanceIpHash','acceptanceUserAgentHash','anonymizedAt','updatedAt'] THEN
        RAISE EXCEPTION 'Anonymization only removes personal snapshots' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" THEN
      RAISE EXCEPTION 'Order anonymization is irreversible' USING ERRCODE = '55000';
    END IF;
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
     NEW."orderStatus" <> 'CANCELLED' OR NEW."paymentStatus" IS DISTINCT FROM OLD."paymentStatus" OR
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

CREATE OR REPLACE FUNCTION "enforce_order_f3_4_snapshots"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."anonymizedAt" IS NOT NULL THEN
    IF NEW."buyerDocumentTypeSnapshot" IS NOT NULL OR NEW."buyerDocumentNumberSnapshot" IS NOT NULL OR
       NEW."buyerTaxRegimeSnapshot" IS NOT NULL OR NEW."deliveryLatitudeE6" IS NOT NULL OR NEW."deliveryLongitudeE6" IS NOT NULL THEN
      RAISE EXCEPTION 'Anonymized orders cannot restore fiscal identities or coordinates' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
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

CREATE FUNCTION "enforce_customer_anonymization"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" = 'ANONYMIZED' THEN
    RAISE EXCEPTION 'Anonymized customers are immutable and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'ANONYMIZED' THEN
    IF NEW."authUserId" IS NOT NULL OR NEW."givenName" IS NOT NULL OR NEW."familyName" IS NOT NULL OR
       NEW."phoneE164" IS NOT NULL OR NEW."loyaltyPoints" <> 0 OR NEW."deletedAt" IS NULL OR
       NEW."email" <> 'anon-' || replace(NEW."id"::text, '-', '') || '@anonymized.invalid' THEN
      RAISE EXCEPTION 'Customer anonymization must remove every direct identifier' USING ERRCODE = '55000';
    END IF;
    IF to_jsonb(NEW) - ARRAY['authUserId','email','givenName','familyName','phoneE164','status','loyaltyPoints','deletedAt','updatedAt'] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['authUserId','email','givenName','familyName','phoneE164','status','loyaltyPoints','deletedAt','updatedAt'] THEN
      RAISE EXCEPTION 'Customer anonymization only removes personal data' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."status" <> NEW."status" AND NOT (OLD."status" = 'GUEST' AND NEW."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'Invalid customer status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Customer_enforce_anonymization" BEFORE UPDATE OR DELETE ON "Customer"
FOR EACH ROW EXECUTE FUNCTION "enforce_customer_anonymization"();

CREATE FUNCTION "validate_address"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Addresses require an active customer' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DaneMunicipality" WHERE "code" = NEW."municipalityCode" AND "departmentCode" = NEW."departmentCode") THEN
    RAISE EXCEPTION 'Address municipality does not belong to its department' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt")) THEN
    RAISE EXCEPTION 'Address ownership and deletion history are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Address_validate" BEFORE INSERT OR UPDATE ON "Address" FOR EACH ROW EXECUTE FUNCTION "validate_address"();

CREATE FUNCTION "enforce_guest_order_challenge"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Guest challenges cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."codeHash" IS DISTINCT FROM OLD."codeHash" OR NEW."requestIpHash" IS DISTINCT FROM OLD."requestIpHash" OR
     NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."attempts" < OLD."attempts" OR (OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt") THEN
    RAISE EXCEPTION 'Guest challenge identity and attempts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('SENT', 'FAILED', 'EXPIRED')) OR
    (OLD."status" = 'SENT' AND NEW."status" IN ('CONSUMED', 'EXPIRED')) OR
    (OLD."status" = 'FAILED' AND NEW."status" = 'EXPIRED')
  ) THEN RAISE EXCEPTION 'Invalid guest challenge transition' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('CONSUMED', 'EXPIRED') THEN RAISE EXCEPTION 'Terminal guest challenges are immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GuestOrderChallenge_enforce_state" BEFORE UPDATE OR DELETE ON "GuestOrderChallenge"
FOR EACH ROW EXECUTE FUNCTION "enforce_guest_order_challenge"();
CREATE FUNCTION "enforce_guest_order_session"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."challengeId" IS DISTINCT FROM OLD."challengeId" OR
     NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."lastUsedAt" < OLD."lastUsedAt" OR
     (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'Guest session identity and revocation history are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "GuestOrderChallenge" challenge WHERE challenge."id" = NEW."challengeId" AND challenge."orderId" = NEW."orderId" AND challenge."status" = 'CONSUMED' AND challenge."consumedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Guest sessions require a consumed challenge for the same order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GuestOrderSession_enforce_state" BEFORE UPDATE OR DELETE ON "GuestOrderSession"
FOR EACH ROW EXECUTE FUNCTION "enforce_guest_order_session"();

CREATE FUNCTION "validate_postsale_requester"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_order_id UUID;
DECLARE owner_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'Review' THEN
    SELECT item."orderId" INTO target_order_id FROM "OrderItem" item WHERE item."id" = NEW."orderItemId";
    IF target_order_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM "OrderItem" item JOIN "ProductVariant" variant ON variant."id" = item."variantId"
      WHERE item."id" = NEW."orderItemId" AND variant."productId" = NEW."productId"
    ) THEN RAISE EXCEPTION 'Review product does not match the purchased item' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "ShipmentItem" delivered_item JOIN "Shipment" shipment ON shipment."id" = delivered_item."shipmentId"
      WHERE delivered_item."orderItemId" = NEW."orderItemId" AND shipment."status" = 'DELIVERED' AND shipment."deliveredAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'Reviews require a delivered order item' USING ERRCODE = '23514';
    END IF;
  ELSE
    target_order_id := NEW."orderId";
  END IF;
  IF target_order_id IS NOT NULL THEN SELECT "customerId" INTO owner_id FROM "Order" WHERE "id" = target_order_id; END IF;
  IF NEW."requesterCustomerId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."requesterCustomerId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL) OR
       (target_order_id IS NOT NULL AND owner_id IS DISTINCT FROM NEW."requesterCustomerId") THEN
      RAISE EXCEPTION 'Post-sale customer does not own the order' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF target_order_id IS NULL OR NOT EXISTS (SELECT 1 FROM "GuestOrderSession" session WHERE session."id" = NEW."requesterGuestSessionId" AND session."orderId" = target_order_id AND session."revokedAt" IS NULL AND session."expiresAt" > CURRENT_TIMESTAMP) THEN
      RAISE EXCEPTION 'Post-sale guest session does not own the order or has expired' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReturnRequest_validate_requester" BEFORE INSERT ON "ReturnRequest" FOR EACH ROW EXECUTE FUNCTION "validate_postsale_requester"();
CREATE TRIGGER "WarrantyClaim_validate_requester" BEFORE INSERT ON "WarrantyClaim" FOR EACH ROW EXECUTE FUNCTION "validate_postsale_requester"();
CREATE TRIGGER "SupportTicket_validate_requester" BEFORE INSERT ON "SupportTicket" FOR EACH ROW EXECUTE FUNCTION "validate_postsale_requester"();
CREATE TRIGGER "Review_validate_requester" BEFORE INSERT ON "Review" FOR EACH ROW EXECUTE FUNCTION "validate_postsale_requester"();

CREATE FUNCTION "validate_return_request_item"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_order UUID;
DECLARE parent_kind "ReturnRequestKind";
DECLARE item_variant UUID;
BEGIN
  SELECT "orderId", "kind" INTO parent_order, parent_kind FROM "ReturnRequest" WHERE "id" = NEW."returnRequestId";
  SELECT "variantId" INTO item_variant FROM "OrderItem" WHERE "id" = NEW."orderItemId" AND "orderId" = parent_order;
  IF item_variant IS NULL OR NOT EXISTS (
    SELECT 1 FROM "ShipmentItem" shipment_item JOIN "Shipment" shipment ON shipment."id" = shipment_item."shipmentId"
    WHERE shipment_item."id" = NEW."shipmentItemId" AND shipment_item."orderItemId" = NEW."orderItemId" AND
      shipment."orderId" = parent_order AND shipment."status" = 'DELIVERED' AND shipment."deliveredAt" = NEW."deliveredAt" AND NEW."retractDueAt" > NEW."deliveredAt"
  ) THEN RAISE EXCEPTION 'Return item does not belong to the order or its delivery snapshot is invalid' USING ERRCODE = '23514'; END IF;
  IF parent_kind = 'EXCHANGE' THEN
    IF NEW."replacementVariantId" IS NULL OR NEW."replacementVariantId" = item_variant OR NOT EXISTS (
      SELECT 1 FROM "ProductVariant" replacement JOIN "ProductVariant" original ON original."productId" = replacement."productId"
      WHERE replacement."id" = NEW."replacementVariantId" AND original."id" = item_variant AND replacement."status" = 'ACTIVE' AND replacement."deletedAt" IS NULL
    ) THEN RAISE EXCEPTION 'Exchange replacement must be another active variant of the same product' USING ERRCODE = '23514'; END IF;
  ELSIF NEW."replacementVariantId" IS NOT NULL THEN
    RAISE EXCEPTION 'Refunds cannot select a replacement variant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReturnRequestItem_validate" BEFORE INSERT OR UPDATE ON "ReturnRequestItem"
FOR EACH ROW EXECUTE FUNCTION "validate_return_request_item"();
CREATE FUNCTION "validate_return_request_unit"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ReturnRequestItem" return_item JOIN "ReturnRequest" request ON request."id" = return_item."returnRequestId"
    JOIN "OrderItem" order_item ON order_item."id" = return_item."orderItemId" AND order_item."orderId" = request."orderId"
    JOIN "ShipmentItem" shipment_item ON shipment_item."id" = return_item."shipmentItemId"
    JOIN "SerializedUnit" unit ON unit."id" = NEW."serializedUnitId" AND unit."orderId" = request."orderId" AND unit."variantId" = order_item."variantId" AND unit."shipmentId" = shipment_item."shipmentId"
    WHERE return_item."id" = NEW."returnRequestItemId" AND unit."status" IN ('SOLD', 'RETURNED')
  ) THEN RAISE EXCEPTION 'Returned serial does not match the order item' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReturnRequestUnit_validate" BEFORE INSERT ON "ReturnRequestUnit" FOR EACH ROW EXECUTE FUNCTION "validate_return_request_unit"();
CREATE TRIGGER "ReturnRequestItem_append_only" BEFORE UPDATE OR DELETE ON "ReturnRequestItem" FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();
CREATE TRIGGER "ReturnRequestUnit_append_only" BEFORE UPDATE OR DELETE ON "ReturnRequestUnit" FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "validate_warranty_claim"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrderItem" item JOIN "SerializedUnit" unit ON unit."orderId" = item."orderId" AND unit."variantId" = item."variantId"
    JOIN "Shipment" shipment ON shipment."id" = unit."shipmentId" AND shipment."status" = 'DELIVERED'
    WHERE item."id" = NEW."orderItemId" AND item."orderId" = NEW."orderId" AND unit."id" = NEW."serializedUnitId" AND unit."status" IN ('SOLD', 'RETURNED')
  ) THEN RAISE EXCEPTION 'Warranty serial must belong to a delivered order item' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WarrantyClaim_validate_serial" BEFORE INSERT ON "WarrantyClaim" FOR EACH ROW EXECUTE FUNCTION "validate_warranty_claim"();

CREATE FUNCTION "enforce_return_request_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR
     NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."reason" IS DISTINCT FROM OLD."reason" OR
     NEW."retractRefundDueAt" IS DISTINCT FROM OLD."retractRefundDueAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Return identity is immutable and versions must be monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN ('AWAITING_RETURN', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'AWAITING_RETURN' AND NEW."status" IN ('RECEIVED', 'CANCELLED')) OR
    (OLD."status" = 'RECEIVED' AND NEW."status" = 'COMPLETED')
  ) THEN RAISE EXCEPTION 'Invalid return request transition' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('COMPLETED', 'REJECTED', 'CANCELLED') THEN RAISE EXCEPTION 'Terminal return requests are immutable' USING ERRCODE = '55000'; END IF;
  IF (NEW."status" = 'AWAITING_RETURN' AND (NEW."reviewedByAdminUserId" IS NULL OR NEW."reviewedAt" IS NULL OR (NEW."kind" = 'REFUND') <> (NEW."refundId" IS NOT NULL))) OR
     (NEW."status" = 'RECEIVED' AND NEW."receivedAt" IS NULL) OR (NEW."status" = 'COMPLETED' AND NEW."completedAt" IS NULL) THEN
    RAISE EXCEPTION 'Return review, refund and timestamp snapshots are inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReturnRequest_enforce_state" BEFORE UPDATE OR DELETE ON "ReturnRequest" FOR EACH ROW EXECUTE FUNCTION "enforce_return_request_state"();

CREATE FUNCTION "enforce_warranty_claim_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."orderItemId" IS DISTINCT FROM OLD."orderItemId" OR
     NEW."serializedUnitId" IS DISTINCT FROM OLD."serializedUnitId" OR NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR
     NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."issueDescription" IS DISTINCT FROM OLD."issueDescription" OR
     NEW."remedy" IS DISTINCT FROM OLD."remedy" OR NEW."warrantyDueAt" IS DISTINCT FROM OLD."warrantyDueAt" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Warranty identity is immutable and versions must be monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'UNDER_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED')) OR
    (OLD."status" = 'APPROVED' AND NEW."status" IN ('RESOLVED', 'CANCELLED'))
  ) THEN RAISE EXCEPTION 'Invalid warranty claim transition' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('RESOLVED', 'REJECTED', 'CANCELLED') THEN RAISE EXCEPTION 'Terminal warranty claims are immutable' USING ERRCODE = '55000'; END IF;
  IF (NEW."status" = 'APPROVED' AND (NEW."reviewedByAdminUserId" IS NULL OR NEW."reviewedAt" IS NULL OR (NEW."remedy" = 'REFUND') <> (NEW."refundId" IS NOT NULL))) OR
     (NEW."status" = 'RESOLVED' AND NEW."resolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'Warranty review, refund and resolution snapshots are inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WarrantyClaim_enforce_state" BEFORE UPDATE OR DELETE ON "WarrantyClaim" FOR EACH ROW EXECUTE FUNCTION "enforce_warranty_claim_state"();

CREATE FUNCTION "validate_support_message"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ticket_record "SupportTicket";
BEGIN
  SELECT * INTO ticket_record FROM "SupportTicket" WHERE "id" = NEW."ticketId";
  IF ticket_record."id" IS NULL OR ticket_record."status" IN ('RESOLVED', 'CLOSED') THEN RAISE EXCEPTION 'Support ticket is not accepting messages' USING ERRCODE = '23514'; END IF;
  IF (NEW."authorType" = 'CUSTOMER' AND NEW."authorCustomerId" IS DISTINCT FROM ticket_record."requesterCustomerId") OR
     (NEW."authorType" = 'GUEST' AND NEW."authorGuestSessionId" IS DISTINCT FROM ticket_record."requesterGuestSessionId") THEN
    RAISE EXCEPTION 'Support message author does not own the ticket' USING ERRCODE = '23514';
  END IF;
  IF NEW."authorType" = 'ADMIN' AND NOT EXISTS (SELECT 1 FROM "AdminUser" WHERE "id" = NEW."authorAdminUserId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Support administrator is not active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SupportTicketMessage_validate" BEFORE INSERT ON "SupportTicketMessage" FOR EACH ROW EXECUTE FUNCTION "validate_support_message"();
CREATE TRIGGER "SupportTicketMessage_append_only" BEFORE UPDATE OR DELETE ON "SupportTicketMessage" FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "enforce_support_ticket_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."ticketNumber" IS DISTINCT FROM OLD."ticketNumber" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
     NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR
     NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
     NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."subject" IS DISTINCT FROM OLD."subject" OR NEW."slaDueAt" IS DISTINCT FROM OLD."slaDueAt" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Support identity and SLA are immutable and versions must be monotonic' USING ERRCODE = '55000';
  END IF;
  IF NEW."contactEmailSnapshot" IS DISTINCT FROM OLD."contactEmailSnapshot" AND NOT EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."requesterCustomerId" AND "status" = 'ANONYMIZED' AND "email" = NEW."contactEmailSnapshot"
  ) THEN RAISE EXCEPTION 'Support contact can only be removed by account anonymization' USING ERRCODE = '55000'; END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" IN ('IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED')) OR
    (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('OPEN', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED')) OR
    (OLD."status" = 'WAITING_CUSTOMER' AND NEW."status" IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')) OR
    (OLD."status" = 'RESOLVED' AND NEW."status" IN ('IN_PROGRESS', 'CLOSED'))
  ) THEN RAISE EXCEPTION 'Invalid support ticket transition' USING ERRCODE = '55000'; END IF;
  IF OLD."status" = 'CLOSED' THEN RAISE EXCEPTION 'Closed support tickets are immutable' USING ERRCODE = '55000'; END IF;
  IF (NEW."status" = 'RESOLVED' AND NEW."resolvedAt" IS NULL) OR (NEW."status" = 'CLOSED' AND NEW."closedAt" IS NULL) THEN
    RAISE EXCEPTION 'Support resolution timestamps are inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SupportTicket_enforce_state" BEFORE UPDATE OR DELETE ON "SupportTicket" FOR EACH ROW EXECUTE FUNCTION "enforce_support_ticket_state"();

CREATE FUNCTION "enforce_review_moderation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."orderItemId" IS DISTINCT FROM OLD."orderItemId" OR NEW."productId" IS DISTINCT FROM OLD."productId" OR
     NEW."requesterCustomerId" IS DISTINCT FROM OLD."requesterCustomerId" OR NEW."requesterGuestSessionId" IS DISTINCT FROM OLD."requesterGuestSessionId" OR
     NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
     NEW."rating" IS DISTINCT FROM OLD."rating" OR NEW."title" IS DISTINCT FROM OLD."title" OR NEW."body" IS DISTINCT FROM OLD."body" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Verified review purchase and content are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."authorDisplayName" IS DISTINCT FROM OLD."authorDisplayName" AND NOT EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."requesterCustomerId" AND "status" = 'ANONYMIZED' AND NEW."authorDisplayName" = 'Cliente verificado'
  ) THEN RAISE EXCEPTION 'Review author display name can only be anonymized' USING ERRCODE = '55000'; END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PUBLISHED', 'REJECTED')) OR
    (OLD."status" IN ('PUBLISHED', 'REJECTED') AND NEW."status" IN ('PUBLISHED', 'REJECTED'))
  ) THEN RAISE EXCEPTION 'Invalid review moderation transition' USING ERRCODE = '55000'; END IF;
  IF NEW."status" <> 'PENDING' AND (NEW."moderatedByAdminUserId" IS NULL OR NEW."moderatedAt" IS NULL) THEN
    RAISE EXCEPTION 'Moderated reviews require an administrator and timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Review_enforce_moderation" BEFORE UPDATE OR DELETE ON "Review" FOR EACH ROW EXECUTE FUNCTION "enforce_review_moderation"();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Address','GuestOrderChallenge','ReturnRequest','WarrantyClaim','SupportTicket','Review'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['Address','GuestOrderChallenge','GuestOrderSession','ReturnRequest','ReturnRequestItem','ReturnRequestUnit','WarrantyClaim','SupportTicket','SupportTicketMessage','Review'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
