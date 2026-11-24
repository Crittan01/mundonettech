CREATE OR REPLACE FUNCTION "set_admin_action_self_dealing"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."targetAdminUserId" IS NULL AND NEW."targetType" = 'AdminUser' AND
     NEW."targetId" IS NOT NULL AND lower(NEW."targetId") = NEW."actorAdminUserId"::text THEN
    NEW."targetAdminUserId" := NEW."actorAdminUserId";
  END IF;
  NEW."selfDealing" := COALESCE(NEW."selfDealing", FALSE) OR COALESCE(
    (NEW."targetAdminUserId" IS NOT NULL AND NEW."actorAdminUserId" = NEW."targetAdminUserId") OR
    (NEW."targetType" = 'AdminUser' AND NEW."targetId" IS NOT NULL AND lower(NEW."targetId") = NEW."actorAdminUserId"::text),
    FALSE
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_email_event_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  snapshots_changed BOOLEAN;
  is_valid_redaction BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email events cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD."anonymizedAt" IS NULL AND NEW."anonymizedAt" IS NOT NULL THEN
    IF to_jsonb(NEW) - ARRAY[
         'recipientEmail',
         'anonymizedAt',
         'updatedAt',
         'subjectSnapshot',
         'htmlBodySnapshot',
         'textBodySnapshot',
         'variablesSnapshot'
       ] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'recipientEmail',
         'anonymizedAt',
         'updatedAt',
         'subjectSnapshot',
         'htmlBodySnapshot',
         'textBodySnapshot',
         'variablesSnapshot'
       ] THEN
      RAISE EXCEPTION 'Email anonymization only removes the recipient identity' USING ERRCODE = '55000';
    END IF;
    snapshots_changed :=
      NEW."subjectSnapshot" IS DISTINCT FROM OLD."subjectSnapshot" OR
      NEW."htmlBodySnapshot" IS DISTINCT FROM OLD."htmlBodySnapshot" OR
      NEW."textBodySnapshot" IS DISTINCT FROM OLD."textBodySnapshot" OR
      NEW."variablesSnapshot" IS DISTINCT FROM OLD."variablesSnapshot";
    IF snapshots_changed THEN
      is_valid_redaction :=
        NEW."subjectSnapshot" = 'Notificación anonimizada' AND
        NEW."htmlBodySnapshot" = '<p>Contenido anonimizado por solicitud de privacidad.</p>' AND
        NEW."textBodySnapshot" = 'Contenido anonimizado por solicitud de privacidad.' AND
        NEW."variablesSnapshot" = '{}'::jsonb;
      IF NOT is_valid_redaction THEN
        RAISE EXCEPTION 'Email anonymization only removes the recipient identity' USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW."recipientEmail" !~ '^anon-[0-9a-f]{32}@anonymized\.invalid$' OR (
      (NEW."orderId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Order" parent_order
        JOIN "Customer" customer ON customer."id" = parent_order."customerId"
        WHERE parent_order."id" = NEW."orderId" AND customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      )) OR
      (NEW."orderId" IS NULL AND NOT EXISTS (
        SELECT 1 FROM "Customer" customer
        WHERE (NEW."customerId" IS NULL OR customer."id" = NEW."customerId")
          AND customer."status" = 'ANONYMIZED' AND customer."email" = NEW."recipientEmail"
      ))
    ) THEN RAISE EXCEPTION 'Email recipient anonymization does not match the customer erasure' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL AND (
    NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" OR
    NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail" OR
    NEW."subjectSnapshot" IS DISTINCT FROM OLD."subjectSnapshot" OR
    NEW."htmlBodySnapshot" IS DISTINCT FROM OLD."htmlBodySnapshot" OR
    NEW."textBodySnapshot" IS DISTINCT FROM OLD."textBodySnapshot" OR
    NEW."variablesSnapshot" IS DISTINCT FROM OLD."variablesSnapshot"
  ) THEN RAISE EXCEPTION 'Email anonymization is irreversible' USING ERRCODE = '55000'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."abandonedCartId" IS DISTINCT FROM OLD."abandonedCartId" OR NEW."lifecycleMessageId" IS DISTINCT FROM OLD."lifecycleMessageId" OR
     NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."templateKey" IS DISTINCT FROM OLD."templateKey" OR
     NEW."locale" IS DISTINCT FROM OLD."locale" OR NEW."topic" IS DISTINCT FROM OLD."topic" OR
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

CREATE OR REPLACE FUNCTION "enforce_email_content_snapshot"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  is_valid_redaction BOOLEAN;
BEGIN
  IF NEW."subjectSnapshot" IS DISTINCT FROM OLD."subjectSnapshot" OR
     NEW."htmlBodySnapshot" IS DISTINCT FROM OLD."htmlBodySnapshot" OR
     NEW."textBodySnapshot" IS DISTINCT FROM OLD."textBodySnapshot" OR
     NEW."variablesSnapshot" IS DISTINCT FROM OLD."variablesSnapshot" THEN
    is_valid_redaction :=
      OLD."anonymizedAt" IS NULL AND
      NEW."anonymizedAt" IS NOT NULL AND
      NEW."recipientEmail" LIKE '%@anonymized.invalid' AND
      NEW."subjectSnapshot" = 'Notificación anonimizada' AND
      NEW."htmlBodySnapshot" = '<p>Contenido anonimizado por solicitud de privacidad.</p>' AND
      NEW."textBodySnapshot" = 'Contenido anonimizado por solicitud de privacidad.' AND
      NEW."variablesSnapshot" = '{}'::jsonb;
    IF NOT is_valid_redaction THEN
      RAISE EXCEPTION 'Email content snapshots are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

