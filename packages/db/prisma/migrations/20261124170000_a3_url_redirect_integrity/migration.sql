CREATE OR REPLACE FUNCTION "enforce_url_redirect_cache_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'UrlRedirectCacheState version must be monotonic.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_url_redirect_cache_state"() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS "UrlRedirectCacheState_enforce_monotonic" ON "UrlRedirectCacheState";
CREATE TRIGGER "UrlRedirectCacheState_enforce_monotonic"
BEFORE UPDATE ON "UrlRedirectCacheState"
FOR EACH ROW
EXECUTE FUNCTION "enforce_url_redirect_cache_state"();

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
AFTER INSERT OR UPDATE OR DELETE ON "UrlRedirect"
FOR EACH STATEMENT
EXECUTE FUNCTION "bump_url_redirect_cache_state"();
