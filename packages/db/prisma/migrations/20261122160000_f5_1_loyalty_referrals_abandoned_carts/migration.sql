CREATE TYPE "LoyaltyTxnType" AS ENUM ('EARN', 'EARN_REVERSAL', 'REFERRAL_EARN', 'REFERRAL_REVERSAL', 'FORFEIT');
CREATE TYPE "ReferralStatus" AS ENUM ('ATTRIBUTED', 'QUALIFIED', 'REJECTED', 'REVERSED');

CREATE TABLE "ReferralCode" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "code" VARCHAR(12) NOT NULL,
  "disabledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Referral" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "codeId" UUID NOT NULL,
  "referrerCustomerId" UUID NOT NULL,
  "referredCustomerId" UUID NOT NULL,
  "orderId" UUID,
  "status" "ReferralStatus" NOT NULL DEFAULT 'ATTRIBUTED',
  "rejectionReason" VARCHAR(80),
  "qualifiedAt" TIMESTAMPTZ(6),
  "reversedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoyaltyTxn" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "refundId" UUID,
  "referralId" UUID,
  "type" "LoyaltyTxnType" NOT NULL,
  "points" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "operationKey" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyTxn_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AbandonedCart"
  ADD COLUMN "lastReminderActivityAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastReminderOutcome" VARCHAR(40);
ALTER TABLE "EmailEvent"
  ADD COLUMN "customerId" UUID,
  ADD COLUMN "abandonedCartId" UUID;

ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ReferralCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Referral_referrerCustomerId_fkey" FOREIGN KEY ("referrerCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Referral_referredCustomerId_fkey" FOREIGN KEY ("referredCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Referral_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoyaltyTxn"
  ADD CONSTRAINT "LoyaltyTxn_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LoyaltyTxn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LoyaltyTxn_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "OrderRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LoyaltyTxn_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailEvent"
  ADD CONSTRAINT "EmailEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmailEvent_abandonedCartId_fkey" FOREIGN KEY ("abandonedCartId") REFERENCES "AbandonedCart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ReferralCode_customerId_key" ON "ReferralCode"("customerId");
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE INDEX "ReferralCode_disabledAt_createdAt_idx" ON "ReferralCode"("disabledAt", "createdAt");
CREATE UNIQUE INDEX "Referral_referredCustomerId_key" ON "Referral"("referredCustomerId");
CREATE UNIQUE INDEX "Referral_orderId_key" ON "Referral"("orderId");
CREATE INDEX "Referral_referrerCustomerId_status_createdAt_idx" ON "Referral"("referrerCustomerId", "status", "createdAt");
CREATE INDEX "Referral_codeId_status_createdAt_idx" ON "Referral"("codeId", "status", "createdAt");
CREATE INDEX "Referral_status_createdAt_idx" ON "Referral"("status", "createdAt");
CREATE UNIQUE INDEX "LoyaltyTxn_operationKey_key" ON "LoyaltyTxn"("operationKey");
CREATE INDEX "LoyaltyTxn_customerId_createdAt_id_idx" ON "LoyaltyTxn"("customerId", "createdAt", "id");
CREATE INDEX "LoyaltyTxn_orderId_type_createdAt_idx" ON "LoyaltyTxn"("orderId", "type", "createdAt");
CREATE INDEX "LoyaltyTxn_refundId_type_idx" ON "LoyaltyTxn"("refundId", "type");
CREATE INDEX "LoyaltyTxn_referralId_type_idx" ON "LoyaltyTxn"("referralId", "type");
CREATE INDEX "AbandonedCart_status_lastReminderOutcome_detectedAt_idx" ON "AbandonedCart"("status", "lastReminderOutcome", "detectedAt");
CREATE INDEX "EmailEvent_customerId_templateKey_createdAt_idx" ON "EmailEvent"("customerId", "templateKey", "createdAt");
CREATE INDEX "EmailEvent_abandonedCartId_createdAt_idx" ON "EmailEvent"("abandonedCartId", "createdAt");

ALTER TABLE "ReferralCode"
  ADD CONSTRAINT "ReferralCode_identity_valid" CHECK ("code" ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$'),
  ADD CONSTRAINT "ReferralCode_disablement_valid" CHECK ("disabledAt" IS NULL OR "disabledAt" >= "createdAt");
ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_parties_distinct" CHECK ("referrerCustomerId" <> "referredCustomerId"),
  ADD CONSTRAINT "Referral_rejection_reason_valid" CHECK ("rejectionReason" IS NULL OR "rejectionReason" IN ('SELF_REFERRAL', 'REFERRER_UNAVAILABLE', 'REFERRED_UNAVAILABLE', 'PREVIOUS_PAID_ORDER', 'BELOW_MINIMUM', 'B2B_ORDER')),
  ADD CONSTRAINT "Referral_status_consistent" CHECK (
    ("status" = 'ATTRIBUTED' AND "orderId" IS NULL AND "rejectionReason" IS NULL AND "qualifiedAt" IS NULL AND "reversedAt" IS NULL) OR
    ("status" = 'QUALIFIED' AND "orderId" IS NOT NULL AND "rejectionReason" IS NULL AND "qualifiedAt" IS NOT NULL AND "reversedAt" IS NULL) OR
    ("status" = 'REJECTED' AND "rejectionReason" IS NOT NULL AND "qualifiedAt" IS NULL AND "reversedAt" IS NULL) OR
    ("status" = 'REVERSED' AND "orderId" IS NOT NULL AND "rejectionReason" IS NULL AND "qualifiedAt" IS NOT NULL AND "reversedAt" IS NOT NULL)
  );
ALTER TABLE "LoyaltyTxn"
  ADD CONSTRAINT "LoyaltyTxn_points_nonzero" CHECK ("points" <> 0),
  ADD CONSTRAINT "LoyaltyTxn_balance_nonnegative" CHECK ("balanceAfter" >= 0),
  ADD CONSTRAINT "LoyaltyTxn_operation_key_valid" CHECK ("operationKey" ~ '^[A-Za-z0-9._:-]{3,128}$'),
  ADD CONSTRAINT "LoyaltyTxn_references_consistent" CHECK (
    ("type" = 'EARN' AND "points" > 0 AND "refundId" IS NULL AND "referralId" IS NULL) OR
    ("type" = 'EARN_REVERSAL' AND "points" < 0 AND "refundId" IS NOT NULL AND "referralId" IS NULL) OR
    ("type" = 'REFERRAL_EARN' AND "points" > 0 AND "refundId" IS NULL AND "referralId" IS NOT NULL) OR
    ("type" = 'REFERRAL_REVERSAL' AND "points" < 0 AND "refundId" IS NOT NULL AND "referralId" IS NOT NULL) OR
    ("type" = 'FORFEIT' AND "points" < 0 AND "refundId" IS NULL AND "referralId" IS NULL)
  );
ALTER TABLE "AbandonedCart" DROP CONSTRAINT "AbandonedCart_reminders_valid";
ALTER TABLE "AbandonedCart"
  ADD CONSTRAINT "AbandonedCart_reminders_valid" CHECK (
    "reminderCount" >= 0 AND
    (("reminderCount" = 0 AND "lastReminderAt" IS NULL) OR ("reminderCount" > 0 AND "lastReminderAt" IS NOT NULL)) AND
    (("lastReminderActivityAt" IS NULL AND "lastReminderOutcome" IS NULL) OR
     ("lastReminderActivityAt" IS NOT NULL AND "lastReminderOutcome" IN ('QUEUED', 'NO_CONTACT', 'NO_CONSENT', 'SUPPRESSED', 'STALE'))) AND
    ("lastReminderOutcome" <> 'QUEUED' OR "lastReminderAt" IS NOT NULL)
  );
ALTER TABLE "EmailEvent"
  ADD CONSTRAINT "EmailEvent_growth_relation_valid" CHECK (
    ("templateKey" = 'cart.recovery' AND "topic" = 'cart-recovery' AND "orderId" IS NULL AND "customerId" IS NOT NULL AND "abandonedCartId" IS NOT NULL) OR
    ("templateKey" <> 'cart.recovery' AND "abandonedCartId" IS NULL)
  );

CREATE FUNCTION "validate_referral_code"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Referral codes cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL) THEN
      RAISE EXCEPTION 'Referral codes require an active customer' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."code" IS DISTINCT FROM OLD."code" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."disabledAt" IS NOT NULL AND NEW."disabledAt" IS DISTINCT FROM OLD."disabledAt") THEN
    RAISE EXCEPTION 'Referral code identity and disablement are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReferralCode_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "ReferralCode"
FOR EACH ROW EXECUTE FUNCTION "validate_referral_code"();

CREATE FUNCTION "validate_referral"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Referral history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ReferralCode" code
      JOIN "Customer" referrer ON referrer."id" = code."customerId"
      WHERE code."id" = NEW."codeId" AND code."customerId" = NEW."referrerCustomerId" AND
        code."disabledAt" IS NULL AND referrer."status" = 'ACTIVE' AND referrer."deletedAt" IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM "Customer" WHERE "id" = NEW."referredCustomerId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
    ) THEN RAISE EXCEPTION 'Referral parties or code are not active' USING ERRCODE = '23514'; END IF;
    IF NEW."status" <> 'ATTRIBUTED' THEN RAISE EXCEPTION 'Referrals start as attributed' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."codeId" IS DISTINCT FROM OLD."codeId" OR NEW."referrerCustomerId" IS DISTINCT FROM OLD."referrerCustomerId" OR
     NEW."referredCustomerId" IS DISTINCT FROM OLD."referredCustomerId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     (OLD."orderId" IS NOT NULL AND NEW."orderId" IS DISTINCT FROM OLD."orderId") OR
     OLD."status" IN ('REJECTED', 'REVERSED') OR
     NOT ((OLD."status" = 'ATTRIBUTED' AND NEW."status" IN ('ATTRIBUTED', 'QUALIFIED', 'REJECTED')) OR
          (OLD."status" = 'QUALIFIED' AND NEW."status" IN ('QUALIFIED', 'REVERSED'))) THEN
    RAISE EXCEPTION 'Invalid referral state or identity mutation' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IN ('QUALIFIED', 'REVERSED') AND NOT EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "customerId" = NEW."referredCustomerId" AND
      "paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
  ) THEN RAISE EXCEPTION 'A qualified referral requires a paid order from the referred customer' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Referral_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "Referral"
FOR EACH ROW EXECUTE FUNCTION "validate_referral"();
CREATE TRIGGER "Referral_set_updated_at" BEFORE UPDATE ON "Referral"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "validate_loyalty_txn"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_balance INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Loyalty transactions are append-only' USING ERRCODE = '55000'; END IF;
  SELECT "loyaltyPoints" INTO current_balance FROM "Customer" WHERE "id" = NEW."customerId" FOR UPDATE;
  IF NOT FOUND OR current_balance IS DISTINCT FROM NEW."balanceAfter" OR current_balance - NEW."points" < 0 THEN
    RAISE EXCEPTION 'Loyalty balance does not match the appended transaction' USING ERRCODE = '23514';
  END IF;
  IF NEW."type" IN ('EARN', 'REFERRAL_EARN') AND NOT EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "paymentStatus" = 'PAID'
  ) THEN RAISE EXCEPTION 'Loyalty earnings require a fully paid order' USING ERRCODE = '23514'; END IF;
  IF NEW."type" IN ('EARN', 'EARN_REVERSAL') AND NOT EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "customerId" = NEW."customerId"
  ) THEN RAISE EXCEPTION 'Order loyalty entries belong to the purchasing customer' USING ERRCODE = '23514'; END IF;
  IF NEW."type" = 'FORFEIT' AND NOT EXISTS (
    SELECT 1 FROM "Order" parent_order WHERE parent_order."id" = NEW."orderId" AND (
      parent_order."customerId" = NEW."customerId" OR EXISTS (
        SELECT 1 FROM "Referral" referral WHERE referral."orderId" = parent_order."id" AND
          NEW."customerId" IN (referral."referrerCustomerId", referral."referredCustomerId")
      )
    )
  ) THEN RAISE EXCEPTION 'Forfeited points require an order linked to the customer' USING ERRCODE = '23514'; END IF;
  IF NEW."type" IN ('EARN_REVERSAL', 'REFERRAL_REVERSAL') AND NOT EXISTS (
    SELECT 1 FROM "OrderRefund" WHERE "id" = NEW."refundId" AND "orderId" = NEW."orderId" AND "status" = 'COMPLETED'
  ) THEN RAISE EXCEPTION 'Loyalty reversals require a completed order refund' USING ERRCODE = '23514'; END IF;
  IF NEW."type" IN ('REFERRAL_EARN', 'REFERRAL_REVERSAL') AND NOT EXISTS (
    SELECT 1 FROM "Referral" WHERE "id" = NEW."referralId" AND "orderId" = NEW."orderId" AND
      NEW."customerId" IN ("referrerCustomerId", "referredCustomerId")
  ) THEN RAISE EXCEPTION 'Referral loyalty entry does not match its attribution' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LoyaltyTxn_validate" BEFORE INSERT ON "LoyaltyTxn"
FOR EACH ROW EXECUTE FUNCTION "validate_loyalty_txn"();
CREATE TRIGGER "LoyaltyTxn_append_only" BEFORE UPDATE OR DELETE ON "LoyaltyTxn"
FOR EACH ROW EXECUTE FUNCTION "validate_loyalty_txn"();

CREATE FUNCTION "validate_email_growth_relation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."templateKey" = 'cart.recovery' AND NOT EXISTS (
    SELECT 1 FROM "AbandonedCart" abandoned
    JOIN "Customer" customer ON customer."id" = abandoned."customerId"
    WHERE abandoned."id" = NEW."abandonedCartId" AND abandoned."customerId" = NEW."customerId" AND
      customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
  ) THEN RAISE EXCEPTION 'Cart recovery email does not match its active customer and abandoned cart' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailEvent_validate_growth_relation" BEFORE INSERT OR UPDATE OF "customerId", "abandonedCartId" ON "EmailEvent"
FOR EACH ROW EXECUTE FUNCTION "validate_email_growth_relation"();

CREATE OR REPLACE FUNCTION "enforce_email_event_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email events cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD."anonymizedAt" IS NULL AND NEW."anonymizedAt" IS NOT NULL THEN
    IF to_jsonb(NEW) - ARRAY['recipientEmail', 'anonymizedAt', 'updatedAt'] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['recipientEmail', 'anonymizedAt', 'updatedAt'] THEN
      RAISE EXCEPTION 'Email anonymization only removes the recipient identity' USING ERRCODE = '55000';
    END IF;
    IF NEW."recipientEmail" !~ '^anon-[0-9a-f]{32}@anonymized\.invalid$' OR (
      (NEW."orderId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Order" parent_order
        JOIN "Customer" customer ON customer."id" = parent_order."customerId"
        WHERE parent_order."id" = NEW."orderId" AND customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      )) OR
      (NEW."orderId" IS NULL AND NOT EXISTS (
        SELECT 1 FROM "Customer" customer
        WHERE customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      ))
    ) THEN RAISE EXCEPTION 'Email recipient anonymization does not match the customer erasure' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL AND (
    NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" OR NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail"
  ) THEN RAISE EXCEPTION 'Email anonymization is irreversible' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."abandonedCartId" IS DISTINCT FROM OLD."abandonedCartId" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
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

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ReferralCode', 'Referral', 'LoyaltyTxn'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "validate_referral_code"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_referral"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_loyalty_txn"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_email_growth_relation"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_email_event_state"() FROM PUBLIC, anon, authenticated, service_role;
