CREATE TYPE "PaymentProvider" AS ENUM ('WOMPI', 'COD', 'BANK_TRANSFER', 'STORE_CREDIT');
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('REQUIRES_ACTION', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "PaymentTransactionKind" AS ENUM ('CAPTURE', 'REFUND', 'VOID');
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "PaymentWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');
CREATE TYPE "CodReconciliationStatus" AS ENUM ('PENDING_COLLECTION', 'COLLECTED', 'REMITTED', 'RECONCILED', 'DISCREPANCY', 'CANCELLED');
CREATE TYPE "RemittanceBatchStatus" AS ENUM ('OPEN', 'CLOSED', 'RECONCILED', 'DISCREPANCY', 'CANCELLED');
CREATE TYPE "BlockedIdentityKind" AS ENUM ('EMAIL', 'PHONE', 'DOCUMENT');
CREATE TYPE "StoreCreditEntryType" AS ENUM ('GRANT', 'WITHDRAWAL', 'HOLD', 'CAPTURE', 'RELEASE', 'REFUND');

CREATE TABLE "StoreCreditAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "availableCents" BIGINT NOT NULL DEFAULT 0,
  "heldCents" BIGINT NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCreditAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RemittanceBatch" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "carrier" VARCHAR(120) NOT NULL,
  "reference" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "status" "RemittanceBatchStatus" NOT NULL DEFAULT 'OPEN',
  "expectedCents" BIGINT NOT NULL DEFAULT 0,
  "receivedCents" BIGINT NOT NULL DEFAULT 0,
  "receivedAt" TIMESTAMPTZ(6),
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RemittanceBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "environment" "IntegrationEnvironment" NOT NULL,
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "reference" VARCHAR(64) NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "credentialId" UUID,
  "storeCreditAccountId" UUID,
  "providerStatus" VARCHAR(40),
  "providerOccurredAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(100),
  "expiresAt" TIMESTAMPTZ(6),
  "confirmedByAdminUserId" UUID,
  "confirmedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentTransaction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attemptId" UUID NOT NULL,
  "refundId" UUID,
  "provider" "PaymentProvider" NOT NULL,
  "kind" "PaymentTransactionKind" NOT NULL,
  "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "amountCents" BIGINT NOT NULL,
  "externalId" VARCHAR(128),
  "providerReference" VARCHAR(255),
  "requestHash" BYTEA NOT NULL,
  "statusMessage" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentWebhookEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "PaymentProvider" NOT NULL,
  "attemptId" UUID,
  "eventKey" CHAR(64) NOT NULL,
  "payloadHash" BYTEA NOT NULL,
  "transactionExternalId" VARCHAR(128),
  "status" "PaymentWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  "errorCode" VARCHAR(100),
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(6),
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BlockedIdentity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" "BlockedIdentityKind" NOT NULL,
  "identityHash" BYTEA NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMPTZ(6),
  "blockedByAdminUserId" UUID NOT NULL,
  "blockedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unblockedByAdminUserId" UUID,
  "unblockedAt" TIMESTAMPTZ(6),
  CONSTRAINT "BlockedIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodReconciliation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "paymentAttemptId" UUID NOT NULL,
  "remittanceBatchId" UUID,
  "status" "CodReconciliationStatus" NOT NULL DEFAULT 'PENDING_COLLECTION',
  "expectedCents" BIGINT NOT NULL,
  "collectedCents" BIGINT NOT NULL DEFAULT 0,
  "remittedCents" BIGINT NOT NULL DEFAULT 0,
  "carrierReference" VARCHAR(128),
  "collectedAt" TIMESTAMPTZ(6),
  "remittedAt" TIMESTAMPTZ(6),
  "reconciledAt" TIMESTAMPTZ(6),
  "reconciledByAdminUserId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoreCreditEntry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "paymentAttemptId" UUID,
  "refundId" UUID,
  "actorAdminUserId" UUID,
  "type" "StoreCreditEntryType" NOT NULL,
  "operationKey" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "availableAfterCents" BIGINT NOT NULL,
  "heldAfterCents" BIGINT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCreditEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "StoreCreditAccount"
  ADD CONSTRAINT "StoreCreditAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreCreditAccount_money_nonnegative" CHECK ("availableCents" >= 0 AND "heldCents" >= 0),
  ADD CONSTRAINT "StoreCreditAccount_currency_valid" CHECK ("currency" = 'COP'),
  ADD CONSTRAINT "StoreCreditAccount_version_nonnegative" CHECK ("version" >= 0);

ALTER TABLE "RemittanceBatch"
  ADD CONSTRAINT "RemittanceBatch_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "RemittanceBatch_identity_valid" CHECK (
    "carrier" = btrim("carrier") AND char_length("carrier") > 0 AND
    "reference" = btrim("reference") AND char_length("reference") >= 3
  ),
  ADD CONSTRAINT "RemittanceBatch_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "RemittanceBatch_money_nonnegative" CHECK ("expectedCents" >= 0 AND "receivedCents" >= 0),
  ADD CONSTRAINT "RemittanceBatch_status_consistent" CHECK (
    ("status" = 'RECONCILED' AND "receivedAt" IS NOT NULL AND "expectedCents" = "receivedCents") OR
    ("status" <> 'RECONCILED')
  );

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentAttempt_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentAttempt_storeCreditAccountId_fkey" FOREIGN KEY ("storeCreditAccountId") REFERENCES "StoreCreditAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentAttempt_confirmedByAdminUserId_fkey" FOREIGN KEY ("confirmedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentAttempt_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "PaymentAttempt_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "PaymentAttempt_currency_valid" CHECK ("currency" = 'COP'),
  ADD CONSTRAINT "PaymentAttempt_reference_valid" CHECK ("reference" ~ '^[A-Za-z0-9_-]{8,64}$'),
  ADD CONSTRAINT "PaymentAttempt_expiration_valid" CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt"),
  ADD CONSTRAINT "PaymentAttempt_provider_configuration" CHECK (
    ("provider" = 'WOMPI' AND "credentialId" IS NOT NULL AND "storeCreditAccountId" IS NULL) OR
    ("provider" = 'STORE_CREDIT' AND "credentialId" IS NULL AND "storeCreditAccountId" IS NOT NULL) OR
    ("provider" IN ('COD', 'BANK_TRANSFER') AND "credentialId" IS NULL AND "storeCreditAccountId" IS NULL)
  ),
  ADD CONSTRAINT "PaymentAttempt_completion_consistent" CHECK (
    ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') AND "completedAt" IS NOT NULL) OR
    ("status" NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') AND "completedAt" IS NULL)
  ),
  ADD CONSTRAINT "PaymentAttempt_confirmation_consistent" CHECK (
    (("confirmedByAdminUserId" IS NULL) = ("confirmedAt" IS NULL)) AND
    ("provider" <> 'BANK_TRANSFER' OR "status" <> 'SUCCEEDED' OR "confirmedByAdminUserId" IS NOT NULL)
  );

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentTransaction_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentTransaction_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "PaymentTransaction_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "PaymentTransaction_reference_consistent" CHECK (
    ("kind" = 'REFUND' AND "refundId" IS NOT NULL) OR ("kind" <> 'REFUND' AND "refundId" IS NULL)
  ),
  ADD CONSTRAINT "PaymentTransaction_completion_consistent" CHECK (
    ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "completedAt" IS NOT NULL) OR
    ("status" NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "completedAt" IS NULL)
  ),
  ADD CONSTRAINT "PaymentTransaction_success_reference" CHECK ("status" <> 'SUCCEEDED' OR "externalId" IS NOT NULL);

ALTER TABLE "PaymentWebhookEvent"
  ADD CONSTRAINT "PaymentWebhookEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentWebhookEvent_payloadHash_length" CHECK (octet_length("payloadHash") = 32),
  ADD CONSTRAINT "PaymentWebhookEvent_eventKey_valid" CHECK ("eventKey" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "PaymentWebhookEvent_status_consistent" CHECK (
    ("status" IN ('PROCESSED', 'IGNORED') AND "processedAt" IS NOT NULL) OR
    ("status" IN ('RECEIVED', 'FAILED') AND "processedAt" IS NULL)
  );

ALTER TABLE "BlockedIdentity"
  ADD CONSTRAINT "BlockedIdentity_blockedByAdminUserId_fkey" FOREIGN KEY ("blockedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BlockedIdentity_unblockedByAdminUserId_fkey" FOREIGN KEY ("unblockedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BlockedIdentity_identityHash_length" CHECK (octet_length("identityHash") = 32),
  ADD CONSTRAINT "BlockedIdentity_reason_not_blank" CHECK (
    "reason" = btrim("reason") AND char_length("reason") > 0 AND "reason" !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "BlockedIdentity_expiration_valid" CHECK ("expiresAt" IS NULL OR "expiresAt" > "blockedAt"),
  ADD CONSTRAINT "BlockedIdentity_unblock_consistent" CHECK (
    ("active" AND "unblockedAt" IS NULL AND "unblockedByAdminUserId" IS NULL) OR
    (NOT "active" AND "unblockedAt" IS NOT NULL AND "unblockedByAdminUserId" IS NOT NULL)
  );

ALTER TABLE "CodReconciliation"
  ADD CONSTRAINT "CodReconciliation_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CodReconciliation_remittanceBatchId_fkey" FOREIGN KEY ("remittanceBatchId") REFERENCES "RemittanceBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CodReconciliation_reconciledByAdminUserId_fkey" FOREIGN KEY ("reconciledByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CodReconciliation_money_nonnegative" CHECK (
    "expectedCents" > 0 AND "collectedCents" >= 0 AND "remittedCents" >= 0
  ),
  ADD CONSTRAINT "CodReconciliation_pending_consistent" CHECK (
    "status" <> 'PENDING_COLLECTION' OR
    ("collectedCents" = 0 AND "remittedCents" = 0 AND "collectedAt" IS NULL AND "remittedAt" IS NULL AND "reconciledAt" IS NULL)
  ),
  ADD CONSTRAINT "CodReconciliation_reconciled_consistent" CHECK (
    "status" <> 'RECONCILED' OR
    ("expectedCents" = "collectedCents" AND "expectedCents" = "remittedCents" AND
     "collectedAt" IS NOT NULL AND "remittedAt" IS NOT NULL AND "reconciledAt" IS NOT NULL AND
     "reconciledByAdminUserId" IS NOT NULL AND "remittanceBatchId" IS NOT NULL)
  );

ALTER TABLE "StoreCreditEntry"
  ADD CONSTRAINT "StoreCreditEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoreCreditAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreCreditEntry_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreCreditEntry_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreCreditEntry_actorAdminUserId_fkey" FOREIGN KEY ("actorAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StoreCreditEntry_sequence_positive" CHECK ("sequence" > 0),
  ADD CONSTRAINT "StoreCreditEntry_requestHash_length" CHECK (octet_length("requestHash") = 32),
  ADD CONSTRAINT "StoreCreditEntry_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "StoreCreditEntry_balances_nonnegative" CHECK ("availableAfterCents" >= 0 AND "heldAfterCents" >= 0),
  ADD CONSTRAINT "StoreCreditEntry_reason_not_blank" CHECK (
    "reason" = btrim("reason") AND char_length("reason") > 0 AND "reason" !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "StoreCreditEntry_reference_consistent" CHECK (
    ("type" IN ('HOLD', 'CAPTURE', 'RELEASE') AND "paymentAttemptId" IS NOT NULL AND "refundId" IS NULL) OR
    ("type" = 'REFUND' AND "paymentAttemptId" IS NOT NULL AND "refundId" IS NOT NULL) OR
    ("type" IN ('GRANT', 'WITHDRAWAL') AND "paymentAttemptId" IS NULL AND "refundId" IS NULL AND "actorAdminUserId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "StoreCreditAccount_customerId_currency_key" ON "StoreCreditAccount"("customerId", "currency");
CREATE INDEX "StoreCreditAccount_active_updatedAt_idx" ON "StoreCreditAccount"("active", "updatedAt");
CREATE UNIQUE INDEX "RemittanceBatch_reference_key" ON "RemittanceBatch"("reference");
CREATE INDEX "RemittanceBatch_carrier_status_createdAt_idx" ON "RemittanceBatch"("carrier", "status", "createdAt");
CREATE UNIQUE INDEX "PaymentAttempt_reference_key" ON "PaymentAttempt"("reference");
CREATE UNIQUE INDEX "PaymentAttempt_orderId_idempotencyKey_key" ON "PaymentAttempt"("orderId", "idempotencyKey");
CREATE INDEX "PaymentAttempt_orderId_status_createdAt_idx" ON "PaymentAttempt"("orderId", "status", "createdAt");
CREATE INDEX "PaymentAttempt_provider_status_expiresAt_idx" ON "PaymentAttempt"("provider", "status", "expiresAt");
CREATE INDEX "PaymentAttempt_credentialId_createdAt_idx" ON "PaymentAttempt"("credentialId", "createdAt");
CREATE INDEX "PaymentAttempt_storeCreditAccountId_status_idx" ON "PaymentAttempt"("storeCreditAccountId", "status");
CREATE UNIQUE INDEX "PaymentTransaction_provider_kind_externalId_key" ON "PaymentTransaction"("provider", "kind", "externalId");
CREATE UNIQUE INDEX "PaymentTransaction_one_capture_per_attempt_key" ON "PaymentTransaction"("attemptId") WHERE "kind" = 'CAPTURE';
CREATE INDEX "PaymentTransaction_attemptId_kind_status_createdAt_idx" ON "PaymentTransaction"("attemptId", "kind", "status", "createdAt");
CREATE INDEX "PaymentTransaction_refundId_status_createdAt_idx" ON "PaymentTransaction"("refundId", "status", "createdAt");
CREATE INDEX "PaymentTransaction_provider_externalId_idx" ON "PaymentTransaction"("provider", "externalId");
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_eventKey_key" ON "PaymentWebhookEvent"("provider", "eventKey");
CREATE INDEX "PaymentWebhookEvent_attemptId_receivedAt_idx" ON "PaymentWebhookEvent"("attemptId", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_status_receivedAt_idx" ON "PaymentWebhookEvent"("status", "receivedAt");
CREATE UNIQUE INDEX "BlockedIdentity_kind_identityHash_active_key" ON "BlockedIdentity"("kind", "identityHash") WHERE "active";
CREATE INDEX "BlockedIdentity_kind_identityHash_active_expiresAt_idx" ON "BlockedIdentity"("kind", "identityHash", "active", "expiresAt");
CREATE INDEX "BlockedIdentity_blockedByAdminUserId_blockedAt_idx" ON "BlockedIdentity"("blockedByAdminUserId", "blockedAt");
CREATE UNIQUE INDEX "CodReconciliation_paymentAttemptId_key" ON "CodReconciliation"("paymentAttemptId");
CREATE INDEX "CodReconciliation_status_createdAt_idx" ON "CodReconciliation"("status", "createdAt");
CREATE INDEX "CodReconciliation_remittanceBatchId_status_idx" ON "CodReconciliation"("remittanceBatchId", "status");
CREATE UNIQUE INDEX "StoreCreditEntry_operationKey_key" ON "StoreCreditEntry"("operationKey");
CREATE INDEX "StoreCreditEntry_accountId_createdAt_id_idx" ON "StoreCreditEntry"("accountId", "createdAt", "id");
CREATE INDEX "StoreCreditEntry_paymentAttemptId_type_idx" ON "StoreCreditEntry"("paymentAttemptId", "type");
CREATE INDEX "StoreCreditEntry_refundId_type_idx" ON "StoreCreditEntry"("refundId", "type");


CREATE UNIQUE INDEX "PaymentTransaction_one_void_per_attempt_key" ON "PaymentTransaction"("attemptId") WHERE "kind" = 'VOID';

CREATE FUNCTION "validate_payment_attempt"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_order "Order";
  credential_record "IntegrationCredential";
  credit_account "StoreCreditAccount";
BEGIN
  SELECT * INTO parent_order FROM "Order" WHERE "id" = NEW."orderId";
  IF parent_order."id" IS NULL OR NEW."currency" <> parent_order."currency" THEN
    RAISE EXCEPTION 'Payment attempt does not match its order currency' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND parent_order."orderStatus" IN ('PENDING', 'CANCELLED') THEN
    RAISE EXCEPTION 'Payment attempts require a confirmed, open order' USING ERRCODE = '23514';
  END IF;
  IF NEW."provider" = 'WOMPI' THEN
    SELECT * INTO credential_record FROM "IntegrationCredential" WHERE "id" = NEW."credentialId";
    IF credential_record."id" IS NULL OR credential_record."provider" <> 'wompi' OR
       credential_record."environment" <> NEW."environment" OR credential_record."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Wompi credential is invalid for this environment' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."provider" = 'STORE_CREDIT' THEN
    SELECT * INTO credit_account FROM "StoreCreditAccount" WHERE "id" = NEW."storeCreditAccountId";
    IF credit_account."id" IS NULL OR parent_order."customerId" IS NULL OR
       credit_account."customerId" <> parent_order."customerId" OR
       credit_account."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'Store credit account does not belong to the order customer' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NOT credit_account."active" THEN
      RAISE EXCEPTION 'Store credit account is inactive' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentAttempt_validate" BEFORE INSERT OR UPDATE ON "PaymentAttempt"
FOR EACH ROW EXECUTE FUNCTION "validate_payment_attempt"();

CREATE FUNCTION "validate_payment_transaction"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_attempt "PaymentAttempt";
BEGIN
  SELECT * INTO parent_attempt FROM "PaymentAttempt" WHERE "id" = NEW."attemptId";
  IF parent_attempt."id" IS NULL OR parent_attempt."provider" <> NEW."provider" THEN
    RAISE EXCEPTION 'Payment transaction provider does not match its attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" IN ('CAPTURE', 'VOID') AND NEW."amountCents" <> parent_attempt."amountCents" THEN
    RAISE EXCEPTION 'Capture and void amounts must equal their payment attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'REFUND' AND (
    NEW."amountCents" > parent_attempt."amountCents" OR NOT EXISTS (
      SELECT 1 FROM "OrderRefund" refund
      WHERE refund."id" = NEW."refundId" AND refund."orderId" = parent_attempt."orderId"
    )
  ) THEN
    RAISE EXCEPTION 'Refund transaction exceeds or does not belong to the payment order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentTransaction_validate" BEFORE INSERT OR UPDATE ON "PaymentTransaction"
FOR EACH ROW EXECUTE FUNCTION "validate_payment_transaction"();

CREATE FUNCTION "validate_cod_reconciliation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PaymentAttempt" attempt
    WHERE attempt."id" = NEW."paymentAttemptId" AND attempt."provider" = 'COD' AND
          attempt."amountCents" = NEW."expectedCents"
  ) THEN
    RAISE EXCEPTION 'COD reconciliation must match a cash-on-delivery attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CodReconciliation_validate" BEFORE INSERT OR UPDATE ON "CodReconciliation"
FOR EACH ROW EXECUTE FUNCTION "validate_cod_reconciliation"();

CREATE FUNCTION "enforce_payment_attempt_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment attempts are append-only financial history' USING ERRCODE = '55000';
  END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."provider" IS DISTINCT FROM OLD."provider" OR
     NEW."environment" IS DISTINCT FROM OLD."environment" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR
     NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
     NEW."storeCreditAccountId" IS DISTINCT FROM OLD."storeCreditAccountId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Payment attempt identity and financial snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'REQUIRES_ACTION' AND NEW."status" IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PROCESSING', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'PROCESSING' AND NEW."status" IN ('AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'AUTHORIZED' AND NEW."status" IN ('SUCCEEDED', 'CANCELLED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid payment attempt status transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'Terminal payment attempts are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentAttempt_enforce_state" BEFORE UPDATE OR DELETE ON "PaymentAttempt"
FOR EACH ROW EXECUTE FUNCTION "enforce_payment_attempt_state"();

CREATE FUNCTION "enforce_payment_transaction_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment transactions are append-only financial history' USING ERRCODE = '55000';
  END IF;
  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId" OR NEW."refundId" IS DISTINCT FROM OLD."refundId" OR
     NEW."provider" IS DISTINCT FROM OLD."provider" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR
     NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."externalId" IS NOT NULL AND NEW."externalId" IS DISTINCT FROM OLD."externalId") THEN
    RAISE EXCEPTION 'Payment transaction identity and amount are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED')) OR
    (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) OR
    (OLD."status" = 'FAILED' AND NEW."status" IN ('PROCESSING', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid payment transaction status transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Terminal payment transactions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentTransaction_enforce_state" BEFORE UPDATE OR DELETE ON "PaymentTransaction"
FOR EACH ROW EXECUTE FUNCTION "enforce_payment_transaction_state"();

CREATE FUNCTION "enforce_payment_webhook_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment webhook history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."provider" IS DISTINCT FROM OLD."provider" OR
     (OLD."attemptId" IS NOT NULL AND NEW."attemptId" IS DISTINCT FROM OLD."attemptId") OR
     NEW."eventKey" IS DISTINCT FROM OLD."eventKey" OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash" OR
     NEW."transactionExternalId" IS DISTINCT FROM OLD."transactionExternalId" OR
     NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'Webhook identity and payload hash are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'RECEIVED' AND NEW."status" IN ('PROCESSED', 'IGNORED', 'FAILED')) OR
    (OLD."status" = 'FAILED' AND NEW."status" = 'RECEIVED')
  ) THEN
    RAISE EXCEPTION 'Invalid webhook processing transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('PROCESSED', 'IGNORED') THEN
    RAISE EXCEPTION 'Processed webhooks are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentWebhookEvent_enforce_state" BEFORE UPDATE OR DELETE ON "PaymentWebhookEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_payment_webhook_state"();

CREATE FUNCTION "enforce_blocked_identity_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Blocked identity history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."identityHash" IS DISTINCT FROM OLD."identityHash" OR
     NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
     NEW."blockedByAdminUserId" IS DISTINCT FROM OLD."blockedByAdminUserId" OR
     NEW."blockedAt" IS DISTINCT FROM OLD."blockedAt" OR NOT OLD."active" OR NEW."active" THEN
    RAISE EXCEPTION 'Blocked identities may only be deactivated once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "BlockedIdentity_enforce_state" BEFORE UPDATE OR DELETE ON "BlockedIdentity"
FOR EACH ROW EXECUTE FUNCTION "enforce_blocked_identity_state"();


CREATE FUNCTION "enforce_cod_reconciliation_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COD reconciliation history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId" OR
     NEW."expectedCents" IS DISTINCT FROM OLD."expectedCents" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'COD identity and expected amount are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING_COLLECTION' AND NEW."status" IN ('COLLECTED', 'CANCELLED')) OR
    (OLD."status" = 'COLLECTED' AND NEW."status" IN ('REMITTED', 'DISCREPANCY', 'CANCELLED')) OR
    (OLD."status" = 'REMITTED' AND NEW."status" IN ('RECONCILED', 'DISCREPANCY')) OR
    (OLD."status" = 'DISCREPANCY' AND NEW."status" IN ('COLLECTED', 'REMITTED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid COD reconciliation transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('RECONCILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Terminal COD reconciliations are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CodReconciliation_enforce_state" BEFORE UPDATE OR DELETE ON "CodReconciliation"
FOR EACH ROW EXECUTE FUNCTION "enforce_cod_reconciliation_state"();

CREATE FUNCTION "enforce_remittance_batch_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Remittance batches cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."carrier" IS DISTINCT FROM OLD."carrier" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR
     NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Remittance identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" IN ('CLOSED', 'CANCELLED')) OR
    (OLD."status" = 'CLOSED' AND NEW."status" IN ('RECONCILED', 'DISCREPANCY')) OR
    (OLD."status" = 'DISCREPANCY' AND NEW."status" IN ('CLOSED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid remittance batch transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('RECONCILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Terminal remittance batches are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW."expectedCents" IS DISTINCT FROM OLD."expectedCents" THEN
    RAISE EXCEPTION 'Closed remittance totals are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "RemittanceBatch_enforce_state" BEFORE UPDATE OR DELETE ON "RemittanceBatch"
FOR EACH ROW EXECUTE FUNCTION "enforce_remittance_batch_state"();

CREATE FUNCTION "enforce_store_credit_account_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Store credit accounts cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."availableCents" <> 0 OR NEW."heldCents" <> 0 OR NEW."version" <> 0 THEN
      RAISE EXCEPTION 'Store credit accounts must start with zero balances and version' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 OR
     (NOT OLD."active" AND NEW."active") THEN
    RAISE EXCEPTION 'Store credit account identity is immutable and versions must be monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StoreCreditAccount_enforce_state" BEFORE UPDATE OR DELETE ON "StoreCreditAccount"
FOR EACH ROW EXECUTE FUNCTION "enforce_store_credit_account_state"();
CREATE CONSTRAINT TRIGGER "StoreCreditAccount_validate_opening" AFTER INSERT ON "StoreCreditAccount"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_store_credit_account_state"();

CREATE FUNCTION "validate_store_credit_entry"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  account_record "StoreCreditAccount";
  previous_entry "StoreCreditEntry";
  attempt_record "PaymentAttempt";
  previous_available BIGINT := 0;
  previous_held BIGINT := 0;
  expected_available BIGINT;
  expected_held BIGINT;
BEGIN
  SELECT * INTO account_record FROM "StoreCreditAccount" WHERE "id" = NEW."accountId";
  IF account_record."id" IS NULL OR account_record."version" < NEW."sequence" THEN
    RAISE EXCEPTION 'Store credit entry version exceeds its account version' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "StoreCreditEntry" following
    WHERE following."accountId" = NEW."accountId" AND following."sequence" > NEW."sequence"
  ) AND (
    account_record."availableCents" <> NEW."availableAfterCents" OR
    account_record."heldCents" <> NEW."heldAfterCents" OR
    account_record."version" <> NEW."sequence"
  ) THEN
    RAISE EXCEPTION 'Latest store credit entry does not match the current account balances and version' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous_entry FROM "StoreCreditEntry"
  WHERE "accountId" = NEW."accountId" AND "sequence" < NEW."sequence"
  ORDER BY "sequence" DESC LIMIT 1;
  IF previous_entry."id" IS NOT NULL THEN
    previous_available := previous_entry."availableAfterCents";
    previous_held := previous_entry."heldAfterCents";
  END IF;
  expected_available := previous_available;
  expected_held := previous_held;
  CASE NEW."type"
    WHEN 'GRANT' THEN expected_available := previous_available + NEW."amountCents";
    WHEN 'WITHDRAWAL' THEN expected_available := previous_available - NEW."amountCents";
    WHEN 'HOLD' THEN
      expected_available := previous_available - NEW."amountCents";
      expected_held := previous_held + NEW."amountCents";
    WHEN 'CAPTURE' THEN expected_held := previous_held - NEW."amountCents";
    WHEN 'RELEASE' THEN
      expected_available := previous_available + NEW."amountCents";
      expected_held := previous_held - NEW."amountCents";
    WHEN 'REFUND' THEN expected_available := previous_available + NEW."amountCents";
  END CASE;
  IF expected_available < 0 OR expected_held < 0 OR
     NEW."availableAfterCents" <> expected_available OR NEW."heldAfterCents" <> expected_held THEN
    RAISE EXCEPTION 'Store credit ledger transition is not balanced' USING ERRCODE = '23514';
  END IF;
  IF NEW."paymentAttemptId" IS NOT NULL THEN
    SELECT * INTO attempt_record FROM "PaymentAttempt" WHERE "id" = NEW."paymentAttemptId";
    IF attempt_record."id" IS NULL OR attempt_record."provider" <> 'STORE_CREDIT' OR
       attempt_record."storeCreditAccountId" <> NEW."accountId" OR
       NEW."amountCents" > attempt_record."amountCents" THEN
      RAISE EXCEPTION 'Store credit entry does not belong to the payment attempt account' USING ERRCODE = '23514';
    END IF;
    IF NEW."type" = 'REFUND' AND NOT EXISTS (
      SELECT 1 FROM "OrderRefund" refund
      WHERE refund."id" = NEW."refundId" AND refund."orderId" = attempt_record."orderId"
    ) THEN
      RAISE EXCEPTION 'Store credit refund does not belong to the original order' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "StoreCreditEntry_validate" AFTER INSERT ON "StoreCreditEntry"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_store_credit_entry"();
CREATE TRIGGER "StoreCreditEntry_append_only" BEFORE UPDATE OR DELETE ON "StoreCreditEntry"
FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_mutation"();

CREATE FUNCTION "enforce_order_payment_transition"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."paymentStatus" IS DISTINCT FROM OLD."paymentStatus" AND NOT (
    (OLD."paymentStatus" = 'UNPAID' AND NEW."paymentStatus" IN ('PARTIALLY_PAID', 'PAID', 'FAILED')) OR
    (OLD."paymentStatus" = 'FAILED' AND NEW."paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')) OR
    (OLD."paymentStatus" = 'PARTIALLY_PAID' AND NEW."paymentStatus" IN ('UNPAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')) OR
    (OLD."paymentStatus" = 'PAID' AND NEW."paymentStatus" IN ('PARTIALLY_REFUNDED', 'REFUNDED')) OR
    (OLD."paymentStatus" = 'PARTIALLY_REFUNDED' AND NEW."paymentStatus" = 'REFUNDED')
  ) THEN
    RAISE EXCEPTION 'Invalid order payment status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_enforce_payment_transition" BEFORE UPDATE OF "paymentStatus" ON "Order"
FOR EACH ROW EXECUTE FUNCTION "enforce_order_payment_transition"();

CREATE FUNCTION "validate_payment_totals"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target_order_id UUID;
  parent_order "Order";
  captured BIGINT;
  compensated BIGINT;
  expected_status "PaymentStatus";
BEGIN
  IF TG_TABLE_NAME = 'PaymentAttempt' THEN
    target_order_id := NEW."orderId";
  ELSIF TG_TABLE_NAME = 'PaymentTransaction' THEN
    SELECT "orderId" INTO target_order_id FROM "PaymentAttempt" WHERE "id" = NEW."attemptId";
  ELSIF TG_TABLE_NAME = 'OrderRefund' THEN
    target_order_id := NEW."orderId";
    IF NEW."status" = 'COMPLETED' AND (
      SELECT COALESCE(sum(transaction."amountCents"), 0) FROM "PaymentTransaction" transaction
      WHERE transaction."refundId" = NEW."id" AND transaction."kind" = 'REFUND' AND transaction."status" = 'SUCCEEDED'
    ) <> NEW."totalCents" THEN
      RAISE EXCEPTION 'Completed refund does not match successful provider refunds' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'Order' THEN
    target_order_id := NEW."id";
  ELSE
    RAISE EXCEPTION 'Unsupported payment totals trigger table %', TG_TABLE_NAME;
  END IF;
  SELECT * INTO parent_order FROM "Order" WHERE "id" = target_order_id;
  IF parent_order."id" IS NULL THEN RETURN NEW; END IF;

  IF EXISTS (
    SELECT 1 FROM "PaymentAttempt" attempt
    LEFT JOIN "PaymentTransaction" capture ON capture."attemptId" = attempt."id" AND
      capture."kind" = 'CAPTURE' AND capture."status" = 'SUCCEEDED'
    WHERE attempt."orderId" = target_order_id
    GROUP BY attempt."id", attempt."status", attempt."amountCents"
    HAVING (attempt."status" = 'SUCCEEDED' AND COALESCE(sum(capture."amountCents"), 0) <> attempt."amountCents") OR
           (attempt."status" <> 'SUCCEEDED' AND COALESCE(sum(capture."amountCents"), 0) <> 0) OR
           COALESCE(sum(capture."amountCents"), 0) < (
             SELECT COALESCE(sum(other."amountCents"), 0) FROM "PaymentTransaction" other
             WHERE other."attemptId" = attempt."id" AND other."kind" IN ('REFUND', 'VOID') AND other."status" = 'SUCCEEDED'
           )
  ) THEN
    RAISE EXCEPTION 'Payment attempt captures and compensations do not balance' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" = 'CAPTURE'), 0),
         COALESCE(sum(transaction."amountCents") FILTER (WHERE transaction."kind" IN ('REFUND', 'VOID')), 0)
  INTO captured, compensated
  FROM "PaymentTransaction" transaction
  JOIN "PaymentAttempt" attempt ON attempt."id" = transaction."attemptId"
  WHERE attempt."orderId" = target_order_id AND transaction."status" = 'SUCCEEDED';
  IF captured > parent_order."totalCents" OR compensated > captured THEN
    RAISE EXCEPTION 'Order payment captures or compensations exceed their bounds' USING ERRCODE = '23514';
  END IF;
  IF compensated > 0 THEN
    expected_status := CASE WHEN compensated = captured THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END;
  ELSIF captured = parent_order."totalCents" THEN
    expected_status := 'PAID';
  ELSIF captured > 0 THEN
    expected_status := 'PARTIALLY_PAID';
  ELSIF EXISTS (
    SELECT 1 FROM "PaymentAttempt" attempt
    WHERE attempt."orderId" = target_order_id AND
          attempt."status" IN ('REQUIRES_ACTION', 'PENDING', 'PROCESSING', 'AUTHORIZED')
  ) THEN
    expected_status := 'UNPAID';
  ELSIF EXISTS (
    SELECT 1 FROM "PaymentAttempt" attempt
    WHERE attempt."orderId" = target_order_id AND attempt."status" = 'FAILED'
  ) THEN
    expected_status := 'FAILED';
  ELSE
    expected_status := 'UNPAID';
  END IF;
  IF TG_TABLE_NAME = 'Order' AND EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = target_order_id) AND
     parent_order."paymentStatus" <> expected_status THEN
    RAISE EXCEPTION 'Order payment status % does not match provider ledger %', parent_order."paymentStatus", expected_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "PaymentAttempt_validate_totals" AFTER INSERT OR UPDATE ON "PaymentAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_payment_totals"();
CREATE CONSTRAINT TRIGGER "PaymentTransaction_validate_totals" AFTER INSERT OR UPDATE ON "PaymentTransaction"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_payment_totals"();
CREATE CONSTRAINT TRIGGER "OrderRefund_validate_provider_totals" AFTER UPDATE ON "OrderRefund"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_payment_totals"();
CREATE CONSTRAINT TRIGGER "Order_validate_payment_totals" AFTER UPDATE OF "paymentStatus" ON "Order"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_payment_totals"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'PaymentAttempt', 'PaymentTransaction', 'RemittanceBatch', 'CodReconciliation', 'StoreCreditAccount'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'PaymentAttempt', 'PaymentTransaction', 'PaymentWebhookEvent', 'BlockedIdentity',
    'RemittanceBatch', 'CodReconciliation', 'StoreCreditAccount', 'StoreCreditEntry'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX "StoreCreditEntry_accountId_sequence_key" ON "StoreCreditEntry"("accountId", "sequence");
