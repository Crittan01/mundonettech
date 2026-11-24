CREATE TABLE "UrlRedirectCacheState" (
  "id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  "version" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "UrlRedirectCacheState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UrlRedirectCacheState_singleton" CHECK ("id" = '00000000-0000-0000-0000-000000000001'::uuid),
  CONSTRAINT "UrlRedirectCacheState_version_nonnegative" CHECK ("version" >= 0)
);

INSERT INTO "UrlRedirectCacheState" ("id", "version")
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 0);

ALTER TABLE "UrlRedirectCacheState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UrlRedirectCacheState" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "UrlRedirectCacheState" FROM PUBLIC, anon, authenticated, service_role;
