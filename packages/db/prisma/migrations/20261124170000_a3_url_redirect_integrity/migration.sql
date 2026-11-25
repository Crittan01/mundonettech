CREATE OR REPLACE FUNCTION "enforce_url_redirect_cache_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UrlRedirectCacheState singleton row cannot be deleted.' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'UrlRedirectCacheState version must be monotonic.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_url_redirect_cache_state"() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS "UrlRedirectCacheState_enforce_monotonic" ON "UrlRedirectCacheState";
CREATE TRIGGER "UrlRedirectCacheState_enforce_monotonic"
BEFORE UPDATE OR DELETE ON "UrlRedirectCacheState"
FOR EACH ROW
EXECUTE FUNCTION "enforce_url_redirect_cache_state"();

CREATE OR REPLACE FUNCTION "prevent_url_redirect_cache_state_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'UrlRedirectCacheState cannot be truncated.' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION "prevent_url_redirect_cache_state_truncate"() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS "UrlRedirectCacheState_prevent_truncate" ON "UrlRedirectCacheState";
CREATE TRIGGER "UrlRedirectCacheState_prevent_truncate"
BEFORE TRUNCATE ON "UrlRedirectCacheState"
FOR EACH STATEMENT
EXECUTE FUNCTION "prevent_url_redirect_cache_state_truncate"();

CREATE OR REPLACE FUNCTION "bump_url_redirect_cache_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE "UrlRedirectCacheState"
  SET "version" = "version" + 1
  WHERE "id" = '00000000-0000-0000-0000-000000000001'::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'URL redirect cache generation is not initialized.' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION "bump_url_redirect_cache_state"() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS "UrlRedirect_bump_cache_state" ON "UrlRedirect";
CREATE TRIGGER "UrlRedirect_bump_cache_state"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "UrlRedirect"
FOR EACH STATEMENT
EXECUTE FUNCTION "bump_url_redirect_cache_state"();

CREATE OR REPLACE FUNCTION "validate_url_redirect"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  cycle_found BOOLEAN := false;
  outgoing_hops INTEGER := 0;
  incoming_hops INTEGER := 0;
  excluded_id UUID;
BEGIN
  NEW."fromPath" := normalize_redirect_path(NEW."fromPath");
  NEW."toPath" := normalize_redirect_path(NEW."toPath");
  IF NEW."fromPath" = NEW."toPath" THEN
    RAISE EXCEPTION 'Redirect cannot target itself' USING ERRCODE = '23514';
  END IF;

  IF NOT NEW."active" OR NEW."deletedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('url-redirect-graph'));
  excluded_id := CASE WHEN TG_OP = 'UPDATE' THEN OLD."id" ELSE NEW."id" END;

  WITH RECURSIVE forward_chain(path, hops) AS (
    SELECT NEW."toPath", 0
    UNION ALL
    SELECT redirect."toPath", forward_chain.hops + 1
    FROM "UrlRedirect" redirect
    JOIN forward_chain ON redirect."fromPath" = forward_chain.path
    WHERE redirect."active"
      AND redirect."deletedAt" IS NULL
      AND redirect."id" <> excluded_id
      AND forward_chain.path <> NEW."fromPath"
      AND forward_chain.hops <= 100
  )
  SELECT COALESCE(bool_or(path = NEW."fromPath"), false), COALESCE(max(hops), 0)
  INTO cycle_found, outgoing_hops
  FROM forward_chain;

  IF cycle_found THEN
    RAISE EXCEPTION 'Redirect cycle detected' USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE backward_chain(path, hops) AS (
    SELECT NEW."fromPath", 0
    UNION ALL
    SELECT redirect."fromPath", backward_chain.hops + 1
    FROM "UrlRedirect" redirect
    JOIN backward_chain ON redirect."toPath" = backward_chain.path
    WHERE redirect."active"
      AND redirect."deletedAt" IS NULL
      AND redirect."id" <> excluded_id
      AND backward_chain.hops <= 100
  )
  SELECT COALESCE(max(hops), 0)
  INTO incoming_hops
  FROM backward_chain;

  IF (incoming_hops + 1 + outgoing_hops) > 100 THEN
    RAISE EXCEPTION 'Redirect chain exceeds 100 hops' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_url_redirect"() FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX "UrlRedirect_toPath_active_idx"
  ON "UrlRedirect"("toPath")
  WHERE "active" AND "deletedAt" IS NULL;
