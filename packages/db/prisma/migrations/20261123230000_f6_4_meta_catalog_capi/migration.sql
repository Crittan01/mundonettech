ALTER TYPE "ConsentPurpose" ADD VALUE 'ADVERTISING';

CREATE TYPE "MetaCapiEventName" AS ENUM ('PURCHASE');
CREATE TYPE "MetaCapiEventStatus" AS ENUM ('PENDING', 'DISPATCHING', 'SENT', 'SKIPPED', 'FAILED', 'UNCERTAIN');

CREATE TABLE "MetaCapiEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "eventId" VARCHAR(128) NOT NULL,
  "eventName" "MetaCapiEventName" NOT NULL,
  "status" "MetaCapiEventStatus" NOT NULL DEFAULT 'PENDING',
  "environment" "IntegrationEnvironment" NOT NULL,
  "credentialId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "consentId" UUID NOT NULL,
  "pixelId" VARCHAR(32) NOT NULL,
  "requestUrl" VARCHAR(2048) NOT NULL,
  "testEventCode" VARCHAR(100),
  "eventTime" TIMESTAMPTZ(6) NOT NULL,
  "eventSourceUrl" VARCHAR(2048) NOT NULL,
  "valueCents" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "contents" JSONB NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "externalIdHash" BYTEA,
  "emailHash" BYTEA,
  "phoneHash" BYTEA,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimId" UUID,
  "claimedBy" VARCHAR(120),
  "claimedAt" TIMESTAMPTZ(6),
  "claimExpiresAt" TIMESTAMPTZ(6),
  "requestStartedAt" TIMESTAMPTZ(6),
  "sentAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "providerTraceId" VARCHAR(128),
  "failureCode" VARCHAR(100),
  "reconciliationReference" VARCHAR(128),
  "reconciledAt" TIMESTAMPTZ(6),
  "reconciledByAdminUserId" UUID,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetaCapiEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MetaCapiEvent"
  ADD CONSTRAINT "MetaCapiEvent_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaCapiEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaCapiEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaCapiEvent_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaCapiEvent_reconciledByAdminUserId_fkey" FOREIGN KEY ("reconciledByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "MetaCapiEvent_eventId_key" ON "MetaCapiEvent"("eventId");
CREATE UNIQUE INDEX "MetaCapiEvent_orderId_key" ON "MetaCapiEvent"("orderId");
CREATE INDEX "MetaCapiEvent_status_available_id_idx" ON "MetaCapiEvent"("status", "availableAt", "id");
CREATE INDEX "MetaCapiEvent_customer_status_idx" ON "MetaCapiEvent"("customerId", "status");
CREATE INDEX "MetaCapiEvent_consentId_idx" ON "MetaCapiEvent"("consentId");
CREATE INDEX "MetaCapiEvent_claim_expiry_status_idx" ON "MetaCapiEvent"("claimExpiresAt", "status");
CREATE INDEX "MetaCapiEvent_environment_status_idx" ON "MetaCapiEvent"("environment", "status");
CREATE INDEX "MetaCapiEvent_reconciler_created_idx" ON "MetaCapiEvent"("reconciledByAdminUserId", "createdAt");
CREATE UNIQUE INDEX "IntegrationCredential_meta_active_unique" ON "IntegrationCredential"("environment") WHERE "provider" = 'meta' AND "revokedAt" IS NULL;

ALTER TABLE "MetaCapiEvent"
  ADD CONSTRAINT "MetaCapiEvent_identity_valid" CHECK (
    "eventId" ~ '^purchase:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
    "pixelId" ~ '^[0-9]{5,32}$' AND
    "requestUrl" ~ '^https?://' AND
    "eventSourceUrl" ~ '^https?://' AND
    ("testEventCode" IS NULL OR "testEventCode" ~ '^[A-Za-z0-9_-]{3,100}$')
  ),
  ADD CONSTRAINT "MetaCapiEvent_money_nonnegative" CHECK ("valueCents" >= 0),
  ADD CONSTRAINT "MetaCapiEvent_currency_cop" CHECK ("currency" = 'COP'),
  ADD CONSTRAINT "MetaCapiEvent_contents_valid" CHECK (
    jsonb_typeof("contents") = 'array' AND jsonb_array_length("contents") BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT "MetaCapiEvent_hashes_length" CHECK (
    octet_length("requestHash") = 32 AND
    (
      ("status" IN ('PENDING', 'DISPATCHING', 'UNCERTAIN') AND
        octet_length("externalIdHash") = 32 AND
        ("emailHash" IS NULL OR octet_length("emailHash") = 32) AND
        ("phoneHash" IS NULL OR octet_length("phoneHash") = 32)) OR
      ("status" IN ('SENT', 'SKIPPED', 'FAILED') AND
        "externalIdHash" IS NULL AND "emailHash" IS NULL AND "phoneHash" IS NULL)
    )
  ),
  ADD CONSTRAINT "MetaCapiEvent_attempts_valid" CHECK ("attempts" BETWEEN 0 AND 100 AND "version" BETWEEN 0 AND 1000000),
  ADD CONSTRAINT "MetaCapiEvent_claim_consistent" CHECK (
    (num_nonnulls("claimId", "claimedBy", "claimedAt", "claimExpiresAt") IN (0, 4)) AND
    ("status" = 'DISPATCHING' OR num_nonnulls("claimId", "claimedBy", "claimedAt", "claimExpiresAt") = 0) AND
    ("status" <> 'DISPATCHING' OR num_nonnulls("claimId", "claimedBy", "claimedAt", "claimExpiresAt") = 4) AND
    ("claimExpiresAt" IS NULL OR "claimExpiresAt" > "claimedAt") AND
    ("requestStartedAt" IS NULL OR "requestStartedAt" >= "claimedAt")
  ),
  ADD CONSTRAINT "MetaCapiEvent_status_consistent" CHECK (
    ("status" IN ('PENDING', 'DISPATCHING') AND "sentAt" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'UNCERTAIN' AND "sentAt" IS NULL AND "completedAt" IS NULL AND "requestStartedAt" IS NOT NULL AND "failureCode" IS NOT NULL) OR
    ("status" = 'SENT' AND "sentAt" IS NOT NULL AND "completedAt" IS NOT NULL AND num_nonnulls("providerTraceId", "reconciliationReference") >= 1 AND "failureCode" IS NULL) OR
    ("status" IN ('SKIPPED', 'FAILED') AND "sentAt" IS NULL AND "completedAt" IS NOT NULL AND "failureCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "MetaCapiEvent_failure_code_valid" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  ADD CONSTRAINT "MetaCapiEvent_reconciliation_consistent" CHECK (
    (num_nonnulls("reconciliationReference", "reconciledAt", "reconciledByAdminUserId") IN (0, 3)) AND
    ("reconciliationReference" IS NULL OR "reconciliationReference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$')
  ),
  ADD CONSTRAINT "MetaCapiEvent_environment_test_valid" CHECK ("environment" <> 'PRD' OR "testEventCode" IS NULL);

CREATE FUNCTION "enforce_meta_capi_event"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Meta CAPI events cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."contents") content
      WHERE jsonb_typeof(content) <> 'object' OR
        content ?| ARRAY['itemPriceCents', 'email', 'phone', 'name', 'address'] OR
        (content ->> 'id') IS NULL OR
        (content ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
        (content ->> 'quantity') !~ '^[0-9]{1,10}$' OR
        (content ->> 'quantity')::bigint < 1 OR
        (content ->> 'quantity')::bigint > 2147483647 OR
        (SELECT count(*) FROM jsonb_object_keys(content)) <> 2
    ) THEN
      RAISE EXCEPTION 'Invalid Meta CAPI content row' USING ERRCODE = '23514';
    END IF;
    IF NEW."eventName" <> 'PURCHASE' OR NEW."status" <> 'PENDING' OR
       NOT EXISTS (
         SELECT 1 FROM "Consent" consent
         JOIN "Customer" customer ON customer."id" = consent."customerId"
         WHERE consent."id" = NEW."consentId" AND consent."customerId" = NEW."customerId" AND
           consent."purpose" = 'ADVERTISING' AND consent."status" = 'GRANTED' AND
           consent."revokesId" IS NULL AND consent."occurredAt" <= NEW."eventTime" AND
           customer."id" = NEW."customerId" AND customer."deletedAt" IS NULL AND
           customer."status" IN ('GUEST', 'ACTIVE')
       ) OR NOT EXISTS (
         SELECT 1 FROM "Order" orders
         WHERE orders."id" = NEW."orderId" AND orders."customerId" = NEW."customerId" AND
           orders."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND
           orders."currency" = NEW."currency" AND orders."totalCents" = NEW."valueCents"
       ) OR NOT EXISTS (
         SELECT 1 FROM "IntegrationCredential" credential
         WHERE credential."id" = NEW."credentialId" AND credential."provider" = 'meta' AND
           credential."environment" = NEW."environment" AND credential."revokedAt" IS NULL
       ) THEN
      RAISE EXCEPTION 'Invalid Meta CAPI purchase provenance' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('SENT', 'SKIPPED') THEN
    RAISE EXCEPTION 'Terminal Meta CAPI events are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."eventId" IS DISTINCT FROM OLD."eventId" OR
     NEW."eventName" IS DISTINCT FROM OLD."eventName" OR
     NEW."environment" IS DISTINCT FROM OLD."environment" OR
     NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR
     NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
     NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."consentId" IS DISTINCT FROM OLD."consentId" OR
     NEW."pixelId" IS DISTINCT FROM OLD."pixelId" OR
     NEW."requestUrl" IS DISTINCT FROM OLD."requestUrl" OR
     NEW."testEventCode" IS DISTINCT FROM OLD."testEventCode" OR
     NEW."eventTime" IS DISTINCT FROM OLD."eventTime" OR
     NEW."eventSourceUrl" IS DISTINCT FROM OLD."eventSourceUrl" OR
     NEW."valueCents" IS DISTINCT FROM OLD."valueCents" OR
     NEW."currency" IS DISTINCT FROM OLD."currency" OR
     NEW."contents" IS DISTINCT FROM OLD."contents" OR
     NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Meta CAPI event identity and request are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."status", NEW."status") NOT IN (
    ('PENDING', 'PENDING'), ('PENDING', 'DISPATCHING'), ('PENDING', 'SKIPPED'), ('PENDING', 'FAILED'),
    ('DISPATCHING', 'DISPATCHING'), ('DISPATCHING', 'SENT'), ('DISPATCHING', 'SKIPPED'),
    ('DISPATCHING', 'FAILED'), ('DISPATCHING', 'UNCERTAIN'), ('DISPATCHING', 'PENDING'),
    ('UNCERTAIN', 'UNCERTAIN'), ('UNCERTAIN', 'PENDING'), ('UNCERTAIN', 'SENT'),
    ('FAILED', 'FAILED'), ('FAILED', 'PENDING')
  ) THEN
    RAISE EXCEPTION 'Invalid Meta CAPI event transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'FAILED' AND NEW."status" IN ('PENDING', 'DISPATCHING', 'UNCERTAIN') AND
     (NEW."externalIdHash" IS DISTINCT FROM OLD."externalIdHash" OR
      NEW."emailHash" IS DISTINCT FROM OLD."emailHash" OR
      NEW."phoneHash" IS DISTINCT FROM OLD."phoneHash") THEN
    RAISE EXCEPTION 'Meta CAPI user matching data cannot change before a terminal state' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IN ('SENT', 'SKIPPED', 'FAILED') AND
     (NEW."externalIdHash" IS NOT NULL OR NEW."emailHash" IS NOT NULL OR NEW."phoneHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'Terminal Meta CAPI events must discard user matching data' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" = 'PENDING' AND
     (NEW."reconciliationReference" IS NULL OR NEW."reconciledAt" IS NULL OR
      NEW."reconciledByAdminUserId" IS NULL OR NEW."version" <> OLD."version" + 1) THEN
    RAISE EXCEPTION 'Retrying an uncertain or failed Meta CAPI event requires reconciled evidence' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MetaCapiEvent_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "MetaCapiEvent" FOR EACH ROW EXECUTE FUNCTION "enforce_meta_capi_event"();

ALTER TABLE "MetaCapiEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaCapiEvent" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "MetaCapiEvent" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_meta_capi_event"() FROM PUBLIC, anon, authenticated, service_role;
