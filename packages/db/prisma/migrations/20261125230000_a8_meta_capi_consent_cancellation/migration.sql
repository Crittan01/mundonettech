CREATE OR REPLACE FUNCTION "enforce_meta_capi_event"() RETURNS trigger
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
           consent."revokesId" IS NULL AND NOT EXISTS (
             SELECT 1 FROM "Consent" rev WHERE rev."revokesId" = consent."id"
           ) AND
           date_trunc('milliseconds', consent."occurredAt") <= date_trunc('milliseconds', NEW."eventTime") AND
           customer."id" = NEW."customerId" AND customer."deletedAt" IS NULL AND
           customer."status" IN ('GUEST', 'ACTIVE')
       ) OR NOT EXISTS (
         SELECT 1 FROM "Order" orders
         WHERE orders."id" = NEW."orderId" AND orders."customerId" = NEW."customerId" AND
           orders."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND
           orders."currency" = NEW."currency" AND orders."totalCents" = NEW."valueCents" AND
           date_trunc('milliseconds', orders."createdAt") <= date_trunc('milliseconds', NEW."eventTime")
       ) OR NOT EXISTS (
         SELECT 1 FROM "IntegrationCredential" credential
         WHERE credential."id" = NEW."credentialId" AND credential."provider" = 'meta' AND
           credential."environment" = NEW."environment" AND credential."revokedAt" IS NULL
       ) OR (
         SELECT date_trunc('milliseconds', max(payment."completedAt"))
         FROM "PaymentTransaction" payment
         JOIN "PaymentAttempt" attempt ON attempt."id" = payment."attemptId"
         WHERE attempt."orderId" = NEW."orderId" AND payment."kind" = 'CAPTURE' AND
           payment."status" = 'SUCCEEDED' AND payment."completedAt" IS NOT NULL
       ) IS DISTINCT FROM date_trunc('milliseconds', NEW."eventTime") THEN
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
     (NEW."credentialId" IS DISTINCT FROM OLD."credentialId" AND NOT (
       OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" = 'PENDING' AND
       EXISTS (
         SELECT 1 FROM "IntegrationCredential" credential
         WHERE credential."id" = NEW."credentialId" AND credential."provider" = 'meta' AND
           credential."environment" = NEW."environment" AND credential."revokedAt" IS NULL
       )
     )) OR
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
    ('UNCERTAIN', 'UNCERTAIN'), ('UNCERTAIN', 'PENDING'), ('UNCERTAIN', 'SENT'), ('UNCERTAIN', 'SKIPPED'),
    ('FAILED', 'FAILED'), ('FAILED', 'PENDING'), ('FAILED', 'SKIPPED')
  ) THEN
    RAISE EXCEPTION 'Invalid Meta CAPI event transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'FAILED' AND NEW."status" IN ('PENDING', 'DISPATCHING') AND
     (NEW."externalIdHash" IS DISTINCT FROM OLD."externalIdHash" OR
      NEW."emailHash" IS DISTINCT FROM OLD."emailHash" OR
      NEW."phoneHash" IS DISTINCT FROM OLD."phoneHash") THEN
    RAISE EXCEPTION 'Meta CAPI user matching data cannot change before a terminal state' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'FAILED' AND NEW."status" = 'UNCERTAIN' AND
     (NEW."externalIdHash" IS DISTINCT FROM OLD."externalIdHash" OR
      NEW."emailHash" IS DISTINCT FROM OLD."emailHash" OR
      NEW."phoneHash" IS DISTINCT FROM OLD."phoneHash") AND
     NOT (NEW."externalIdHash" IS NULL AND NEW."emailHash" IS NULL AND NEW."phoneHash" IS NULL) THEN
    RAISE EXCEPTION 'Meta CAPI user matching data cannot change before a terminal state' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IN ('SENT', 'SKIPPED', 'FAILED') AND
     (NEW."externalIdHash" IS NOT NULL OR NEW."emailHash" IS NOT NULL OR NEW."phoneHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'Terminal Meta CAPI events must discard user matching data' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('UNCERTAIN', 'FAILED') AND NEW."status" IN ('PENDING', 'SENT', 'SKIPPED') AND
     (NEW."reconciliationReference" IS NULL OR NEW."reconciledAt" IS NULL OR
      NEW."reconciledByAdminUserId" IS NULL OR
      (NEW."status" = 'PENDING' AND NEW."version" <> OLD."version" + 1) OR
      (NEW."status" IN ('SENT', 'SKIPPED') AND NEW."version" <> OLD."version")) AND
     NOT (
       NEW."status" = 'SKIPPED' AND NEW."failureCode" = 'NO_CONSENT' AND
       NEW."externalIdHash" IS NULL AND NEW."emailHash" IS NULL AND NEW."phoneHash" IS NULL AND
       (
         EXISTS (
           SELECT 1 FROM "Consent" consent
           WHERE consent."id" = OLD."consentId" AND
             (consent."status" = 'REVOKED' OR EXISTS (
               SELECT 1 FROM "Consent" rev WHERE rev."revokesId" = consent."id"
             ))
         ) OR EXISTS (
           SELECT 1 FROM "Customer" customer
           WHERE customer."id" = OLD."customerId" AND
             (customer."status" = 'ANONYMIZED' OR customer."deletedAt" IS NOT NULL)
         )
       )
     ) THEN
    RAISE EXCEPTION 'Reconciling an uncertain or failed Meta CAPI event requires audited evidence' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_meta_capi_event"() FROM PUBLIC, anon, authenticated, service_role;
