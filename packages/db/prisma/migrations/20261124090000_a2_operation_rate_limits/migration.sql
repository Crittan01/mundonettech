CREATE TYPE "OperationRateLimitSubjectType" AS ENUM ('ADMIN_USER', 'ORDER', 'IP');

CREATE TABLE "OperationRateLimit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation" VARCHAR(80) NOT NULL,
  "subjectType" "OperationRateLimitSubjectType" NOT NULL,
  "subjectHash" BYTEA NOT NULL,
  "ipHash" BYTEA NOT NULL,
  "windowStartedAt" TIMESTAMPTZ(6) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperationRateLimit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperationRateLimit_operation_check"
    CHECK ("operation" ~ '^[a-z][a-z0-9.-]{1,79}$'),
  CONSTRAINT "OperationRateLimit_subjectHash_check" CHECK (octet_length("subjectHash") = 32),
  CONSTRAINT "OperationRateLimit_ipHash_check" CHECK (octet_length("ipHash") = 32),
  CONSTRAINT "OperationRateLimit_ip_subject_check"
    CHECK ("subjectType" <> 'IP' OR "subjectHash" = "ipHash"),
  CONSTRAINT "OperationRateLimit_count_check" CHECK ("count" >= 1),
  CONSTRAINT "OperationRateLimit_expiration_check" CHECK ("expiresAt" > "windowStartedAt")
);

CREATE UNIQUE INDEX "OperationRateLimit_bucket_key"
  ON "OperationRateLimit"("operation", "subjectType", "subjectHash", "ipHash", "windowStartedAt");
CREATE INDEX "OperationRateLimit_expiresAt_idx" ON "OperationRateLimit"("expiresAt");

ALTER TABLE "OperationRateLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationRateLimit" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "OperationRateLimit" FROM PUBLIC, anon, authenticated, service_role;
