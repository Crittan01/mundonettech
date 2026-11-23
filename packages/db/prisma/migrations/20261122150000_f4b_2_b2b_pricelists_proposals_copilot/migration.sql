CREATE TYPE "PriceListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "OpportunityStatus" AS ENUM ('NEW', 'QUALIFYING', 'PROPOSAL_SENT', 'WON', 'LOST', 'CANCELLED');
CREATE TYPE "OpportunityProposalStatus" AS ENUM ('DRAFT', 'SENT', 'CONVERTED', 'SUPERSEDED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "OpportunityCopilotRunStatus" AS ENUM ('REQUESTED', 'SUCCEEDED', 'FAILED');

CREATE TABLE "PriceList" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" VARCHAR(500),
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "status" "PriceListStatus" NOT NULL DEFAULT 'DRAFT',
  "validFrom" TIMESTAMPTZ(6),
  "validTo" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PriceListItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "priceListId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "unitPriceCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceListItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Opportunity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "contactId" UUID NOT NULL,
  "status" "OpportunityStatus" NOT NULL DEFAULT 'NEW',
  "source" VARCHAR(60) NOT NULL,
  "requirements" VARCHAR(5000) NOT NULL,
  "currentVersion" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "privacyPolicyVersion" VARCHAR(50) NOT NULL,
  "acceptanceProofHash" BYTEA NOT NULL,
  "acceptanceIpHash" BYTEA,
  "acceptanceUserAgentHash" BYTEA,
  "acceptedAt" TIMESTAMPTZ(6) NOT NULL,
  "anonymizedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityProposal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "opportunityId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "OpportunityProposalStatus" NOT NULL DEFAULT 'DRAFT',
  "publicTokenHash" BYTEA,
  "contentHash" BYTEA NOT NULL,
  "priceListId" UUID,
  "priceListCodeSnapshot" VARCHAR(40),
  "priceListVersionSnapshot" INTEGER,
  "currency" CHAR(3) NOT NULL DEFAULT 'COP',
  "subtotalCents" BIGINT NOT NULL,
  "discountCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "shippingCents" BIGINT NOT NULL,
  "totalCents" BIGINT NOT NULL,
  "taxRegime" "StoreTaxRegime" NOT NULL,
  "uvtValueCents" BIGINT NOT NULL,
  "uvtYear" INTEGER NOT NULL,
  "deliveryPromiseDays" INTEGER NOT NULL,
  "reservationMinutes" INTEGER NOT NULL,
  "commercialNotes" VARCHAR(2000),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "issuedAt" TIMESTAMPTZ(6),
  "acceptedAt" TIMESTAMPTZ(6),
  "convertedAt" TIMESTAMPTZ(6),
  "signerName" VARCHAR(200),
  "signerDocumentType" CHAR(2),
  "signerDocumentNumber" VARCHAR(30),
  "acceptanceProofHash" BYTEA,
  "acceptanceIpHash" BYTEA,
  "acceptanceUserAgentHash" BYTEA,
  "orderId" UUID,
  "cartId" UUID,
  "anonymizedAt" TIMESTAMPTZ(6),
  "createdByAdminUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpportunityProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityProposalItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "proposalId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "titleSnapshot" VARCHAR(200) NOT NULL,
  "productSlugSnapshot" VARCHAR(160) NOT NULL,
  "skuSnapshot" VARCHAR(64) NOT NULL,
  "catalogUnitPriceCents" BIGINT NOT NULL,
  "unitPriceCents" BIGINT NOT NULL,
  "discountCents" BIGINT NOT NULL,
  "lineTotalCents" BIGINT NOT NULL,
  "taxGroupCode" VARCHAR(40) NOT NULL,
  "taxGroupName" VARCHAR(120) NOT NULL,
  "treatment" "TaxTreatment" NOT NULL,
  "taxRule" "OrderTaxRule" NOT NULL,
  "catalogRateBps" INTEGER NOT NULL,
  "appliedRateBps" INTEGER NOT NULL,
  "uvtLimit" INTEGER,
  "unitValueCents" BIGINT NOT NULL,
  "taxableBaseCents" BIGINT NOT NULL,
  "taxCents" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpportunityProposalItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityCopilotRun" (
  "id" UUID NOT NULL,
  "opportunityId" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "inputHash" BYTEA NOT NULL,
  "promptHash" BYTEA NOT NULL,
  "status" "OpportunityCopilotRunStatus" NOT NULL DEFAULT 'REQUESTED',
  "output" JSONB,
  "failureCode" VARCHAR(100),
  "requestedByAdminUserId" UUID NOT NULL,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpportunityCopilotRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IdentityMergeCandidate" ADD COLUMN "movedOpportunityIds" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "PriceListItem"
  ADD CONSTRAINT "PriceListItem_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PriceListItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Opportunity"
  ADD CONSTRAINT "Opportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Opportunity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpportunityProposal"
  ADD CONSTRAINT "OpportunityProposal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityProposal_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityProposal_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityProposal_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityProposal_createdByAdminUserId_fkey" FOREIGN KEY ("createdByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpportunityProposalItem"
  ADD CONSTRAINT "OpportunityProposalItem_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "OpportunityProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityProposalItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpportunityCopilotRun"
  ADD CONSTRAINT "OpportunityCopilotRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityCopilotRun_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpportunityCopilotRun_requestedByAdminUserId_fkey" FOREIGN KEY ("requestedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PriceList_code_active_key" ON "PriceList"("code") WHERE "deletedAt" IS NULL;
CREATE INDEX "PriceList_status_validFrom_validTo_deletedAt_idx" ON "PriceList"("status", "validFrom", "validTo", "deletedAt");
CREATE INDEX "PriceList_deletedAt_idx" ON "PriceList"("deletedAt");
CREATE UNIQUE INDEX "PriceListItem_priceListId_variantId_key" ON "PriceListItem"("priceListId", "variantId");
CREATE INDEX "PriceListItem_variantId_priceListId_idx" ON "PriceListItem"("variantId", "priceListId");
CREATE INDEX "Opportunity_organizationId_status_createdAt_idx" ON "Opportunity"("organizationId", "status", "createdAt");
CREATE INDEX "Opportunity_contactId_status_createdAt_idx" ON "Opportunity"("contactId", "status", "createdAt");
CREATE INDEX "Opportunity_status_createdAt_id_idx" ON "Opportunity"("status", "createdAt", "id");
CREATE INDEX "Opportunity_anonymizedAt_idx" ON "Opportunity"("anonymizedAt");
CREATE UNIQUE INDEX "OpportunityProposal_opportunityId_version_key" ON "OpportunityProposal"("opportunityId", "version");
CREATE UNIQUE INDEX "OpportunityProposal_publicTokenHash_key" ON "OpportunityProposal"("publicTokenHash") WHERE "publicTokenHash" IS NOT NULL;
CREATE UNIQUE INDEX "OpportunityProposal_orderId_key" ON "OpportunityProposal"("orderId") WHERE "orderId" IS NOT NULL;
CREATE UNIQUE INDEX "OpportunityProposal_cartId_key" ON "OpportunityProposal"("cartId") WHERE "cartId" IS NOT NULL;
CREATE INDEX "OpportunityProposal_status_expiresAt_idx" ON "OpportunityProposal"("status", "expiresAt");
CREATE INDEX "OpportunityProposal_createdByAdminUserId_createdAt_idx" ON "OpportunityProposal"("createdByAdminUserId", "createdAt");
CREATE INDEX "OpportunityProposal_anonymizedAt_idx" ON "OpportunityProposal"("anonymizedAt");
CREATE UNIQUE INDEX "OpportunityProposalItem_proposalId_variantId_key" ON "OpportunityProposalItem"("proposalId", "variantId");
CREATE INDEX "OpportunityProposalItem_variantId_proposalId_idx" ON "OpportunityProposalItem"("variantId", "proposalId");
CREATE INDEX "OpportunityCopilotRun_opportunityId_createdAt_idx" ON "OpportunityCopilotRun"("opportunityId", "createdAt");
CREATE INDEX "OpportunityCopilotRun_status_createdAt_idx" ON "OpportunityCopilotRun"("status", "createdAt");

ALTER TABLE "PriceList"
  ADD CONSTRAINT "PriceList_identity_valid" CHECK (
    "code" = upper(btrim("code")) AND "code" ~ '^[A-Z][A-Z0-9_-]{2,39}$' AND
    "name" = btrim("name") AND char_length("name") BETWEEN 2 AND 160 AND
    ("description" IS NULL OR (char_length("description") BETWEEN 1 AND 500 AND "description" = btrim("description"))) AND
    "currency" = 'COP' AND coalesce("name", '') !~ '[[:cntrl:]]' AND coalesce("description", '') !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT "PriceList_schedule_valid" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validTo" > "validFrom"),
  ADD CONSTRAINT "PriceList_state_consistent" CHECK (("status" = 'ARCHIVED' AND "deletedAt" IS NOT NULL) OR ("status" <> 'ARCHIVED' AND "deletedAt" IS NULL)),
  ADD CONSTRAINT "PriceList_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "PriceListItem"
  ADD CONSTRAINT "PriceListItem_unitPrice_nonnegative" CHECK ("unitPriceCents" >= 0);
ALTER TABLE "Opportunity"
  ADD CONSTRAINT "Opportunity_content_valid" CHECK (
    "source" ~ '^[a-z][a-z0-9.-]{1,59}$' AND char_length("requirements") BETWEEN 10 AND 5000 AND
    "requirements" !~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' AND
    char_length("privacyPolicyVersion") BETWEEN 1 AND 50
  ),
  ADD CONSTRAINT "Opportunity_hashes_length" CHECK (
    octet_length("acceptanceProofHash") = 32 AND
    ("acceptanceIpHash" IS NULL OR octet_length("acceptanceIpHash") = 32) AND
    ("acceptanceUserAgentHash" IS NULL OR octet_length("acceptanceUserAgentHash") = 32)
  ),
  ADD CONSTRAINT "Opportunity_versions_nonnegative" CHECK ("currentVersion" >= 0 AND "version" >= 0),
  ADD CONSTRAINT "Opportunity_anonymization_consistent" CHECK (
    "anonymizedAt" IS NULL OR "requirements" = '[contenido suprimido por retención]'
  );
ALTER TABLE "OpportunityProposal"
  ADD CONSTRAINT "OpportunityProposal_money_nonnegative" CHECK (
    "subtotalCents" >= 0 AND "discountCents" >= 0 AND "taxCents" >= 0 AND
    "shippingCents" >= 0 AND "totalCents" >= 0 AND "uvtValueCents" > 0
  ),
  ADD CONSTRAINT "OpportunityProposal_total_balanced" CHECK ("totalCents" = "subtotalCents" - "discountCents" + "taxCents" + "shippingCents"),
  ADD CONSTRAINT "OpportunityProposal_configuration_valid" CHECK (
    "currency" = 'COP' AND "uvtYear" BETWEEN 2000 AND 9999 AND
    "deliveryPromiseDays" BETWEEN 1 AND 365 AND "reservationMinutes" BETWEEN 5 AND 10080 AND
    "version" > 0 AND ("priceListVersionSnapshot" IS NULL OR "priceListVersionSnapshot" >= 0)
  ),
  ADD CONSTRAINT "OpportunityProposal_hashes_length" CHECK (
    octet_length("contentHash") = 32 AND
    ("publicTokenHash" IS NULL OR octet_length("publicTokenHash") = 32) AND
    ("acceptanceProofHash" IS NULL OR octet_length("acceptanceProofHash") = 32) AND
    ("acceptanceIpHash" IS NULL OR octet_length("acceptanceIpHash") = 32) AND
    ("acceptanceUserAgentHash" IS NULL OR octet_length("acceptanceUserAgentHash") = 32)
  ),
  ADD CONSTRAINT "OpportunityProposal_notes_valid" CHECK (
    "commercialNotes" IS NULL OR (char_length("commercialNotes") BETWEEN 1 AND 2000 AND
    "commercialNotes" !~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
  ),
  ADD CONSTRAINT "OpportunityProposal_issue_consistent" CHECK (
    ("status" = 'DRAFT' AND "publicTokenHash" IS NULL AND "cartId" IS NULL AND "issuedAt" IS NULL AND "orderId" IS NULL AND "acceptedAt" IS NULL AND "convertedAt" IS NULL) OR
    ("status" = 'SENT' AND "publicTokenHash" IS NOT NULL AND "cartId" IS NOT NULL AND "issuedAt" IS NOT NULL AND "orderId" IS NULL AND "acceptedAt" IS NULL AND "convertedAt" IS NULL) OR
    ("status" = 'CONVERTED' AND "publicTokenHash" IS NOT NULL AND "cartId" IS NOT NULL AND "issuedAt" IS NOT NULL AND "orderId" IS NOT NULL AND "acceptedAt" IS NOT NULL AND "convertedAt" IS NOT NULL AND (("signerName" IS NOT NULL AND "signerDocumentType" IS NOT NULL AND "signerDocumentNumber" IS NOT NULL) OR "anonymizedAt" IS NOT NULL) AND "acceptanceProofHash" IS NOT NULL) OR
    ("status" IN ('SUPERSEDED', 'CANCELLED', 'EXPIRED') AND "orderId" IS NULL AND "acceptedAt" IS NULL AND "convertedAt" IS NULL)
  ),
  ADD CONSTRAINT "OpportunityProposal_signer_valid" CHECK (
    ("signerName" IS NULL AND "signerDocumentType" IS NULL AND "signerDocumentNumber" IS NULL) OR
    ("signerName" = btrim("signerName") AND char_length("signerName") BETWEEN 2 AND 200 AND
     "signerDocumentType" IN ('11', '12', '13', '21', '22', '31', '41', '42', '50', '91') AND
     "signerDocumentNumber" ~ '^[A-Z0-9.-]{3,30}$')
  );
ALTER TABLE "OpportunityProposalItem"
  ADD CONSTRAINT "OpportunityProposalItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "OpportunityProposalItem_money_nonnegative" CHECK (
    "catalogUnitPriceCents" >= 0 AND "unitPriceCents" >= 0 AND "discountCents" >= 0 AND
    "lineTotalCents" >= 0 AND "unitValueCents" >= 0 AND "taxableBaseCents" >= 0 AND "taxCents" >= 0
  ),
  ADD CONSTRAINT "OpportunityProposalItem_total_balanced" CHECK (
    "unitPriceCents" <= "catalogUnitPriceCents" AND
    "lineTotalCents" = "unitPriceCents" * "quantity" AND
    "discountCents" = ("catalogUnitPriceCents" - "unitPriceCents") * "quantity" AND
    "taxableBaseCents" = "lineTotalCents"
  ),
  ADD CONSTRAINT "OpportunityProposalItem_tax_valid" CHECK (
    "catalogRateBps" BETWEEN 0 AND 10000 AND "appliedRateBps" BETWEEN 0 AND 10000 AND
    ("uvtLimit" IS NULL OR "uvtLimit" > 0) AND
    ("taxRule" = 'NOT_RESPONSABLE' OR "uvtLimit" IS NOT NULL OR "taxRule" IN ('STANDARD', 'EXEMPT', 'EXCLUDED'))
  );
ALTER TABLE "OpportunityCopilotRun"
  ADD CONSTRAINT "OpportunityCopilotRun_hashes_length" CHECK (octet_length("inputHash") = 32 AND octet_length("promptHash") = 32),
  ADD CONSTRAINT "OpportunityCopilotRun_model_valid" CHECK ("model" ~ '^[A-Za-z0-9._-]{2,120}$'),
  ADD CONSTRAINT "OpportunityCopilotRun_completion_consistent" CHECK (
    ("status" = 'REQUESTED' AND "output" IS NULL AND "failureCode" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'SUCCEEDED' AND jsonb_typeof("output") = 'object' AND "failureCode" IS NULL AND "completedAt" IS NOT NULL) OR
    ("status" = 'FAILED' AND "output" IS NULL AND "failureCode" IS NOT NULL AND "completedAt" IS NOT NULL)
  );
ALTER TABLE "IdentityMergeCandidate"
  ADD CONSTRAINT "IdentityMergeCandidate_opportunity_array_valid" CHECK (jsonb_typeof("movedOpportunityIds") = 'array');

ALTER TABLE "Cart" DROP CONSTRAINT "Cart_assisted_consistent";
ALTER TABLE "Cart"
  ADD CONSTRAINT "Cart_assisted_consistent" CHECK (
    ("kind" IN ('STOREFRONT', 'B2B') AND "assistedByAdminUserId" IS NULL AND "assistedTokenHash" IS NULL AND "assistedExpiresAt" IS NULL AND "assistedClaimedAt" IS NULL) OR
    ("kind" = 'ASSISTED' AND "assistedByAdminUserId" IS NOT NULL AND "assistedExpiresAt" IS NOT NULL AND ("assistedTokenHash" IS NULL OR "assistedClaimedAt" IS NULL))
  ),
  ADD CONSTRAINT "Cart_b2b_consistent" CHECK ("kind" <> 'B2B' OR "couponId" IS NULL);

CREATE OR REPLACE FUNCTION "enforce_price_list_item_mutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  list_id UUID;
  list_status "PriceListStatus";
  list_deleted TIMESTAMPTZ;
BEGIN
  list_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."priceListId" ELSE NEW."priceListId" END;
  SELECT "status", "deletedAt" INTO list_status, list_deleted FROM "PriceList" WHERE "id" = list_id;
  IF list_status IS DISTINCT FROM 'DRAFT' OR list_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Price list items are mutable only while the list is a draft' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."priceListId" IS DISTINCT FROM OLD."priceListId" OR NEW."variantId" IS DISTINCT FROM OLD."variantId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt") THEN
    RAISE EXCEPTION 'Price list item identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_price_list_item_mutable"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "PriceListItem_enforce_mutable" BEFORE INSERT OR UPDATE OR DELETE ON "PriceListItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_price_list_item_mutable"();

CREATE OR REPLACE FUNCTION "enforce_price_list_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Price list history and versions are protected' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."code" IS DISTINCT FROM OLD."code" OR NEW."currency" IS DISTINCT FROM OLD."currency") THEN
    RAISE EXCEPTION 'An active price list identity cannot change' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."status" = NEW."status" OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'ARCHIVED')) OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED')) THEN
    RAISE EXCEPTION 'Invalid price list state transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'ARCHIVED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Archived price lists are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'ARCHIVED' AND EXISTS (SELECT 1 FROM "Organization" WHERE "priceListId" = NEW."id" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Unassign active organizations before archiving a price list' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_price_list_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "PriceList_enforce_state" BEFORE UPDATE OR DELETE ON "PriceList"
FOR EACH ROW EXECUTE FUNCTION "enforce_price_list_state"();

CREATE OR REPLACE FUNCTION "enforce_organization_price_list"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."priceListId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PriceList" WHERE "id" = NEW."priceListId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Organizations require an active price list' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_organization_price_list"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Organization_enforce_price_list" BEFORE INSERT OR UPDATE OF "priceListId" ON "Organization"
FOR EACH ROW EXECUTE FUNCTION "enforce_organization_price_list"();

CREATE OR REPLACE FUNCTION "enforce_opportunity_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" < OLD."version" OR NEW."currentVersion" < OLD."currentVersion" THEN
    RAISE EXCEPTION 'Opportunity history and versions are protected' USING ERRCODE = '55000';
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL AND (NEW."requirements" IS DISTINCT FROM OLD."requirements" OR NEW."contactId" IS DISTINCT FROM OLD."contactId" OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    RAISE EXCEPTION 'Anonymized opportunities are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."anonymizedAt" IS NOT NULL AND NEW."requirements" <> '[contenido suprimido por retención]' THEN
    RAISE EXCEPTION 'Opportunity retention must redact free text' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'WON' AND NOT EXISTS (
    SELECT 1 FROM "OpportunityProposal" WHERE "opportunityId" = NEW."id" AND "version" = NEW."currentVersion" AND "status" = 'CONVERTED'
  ) THEN
    RAISE EXCEPTION 'A won opportunity requires its current proposal to be converted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_opportunity_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "Opportunity_enforce_state" BEFORE UPDATE OR DELETE ON "Opportunity"
FOR EACH ROW EXECUTE FUNCTION "enforce_opportunity_state"();

CREATE OR REPLACE FUNCTION "enforce_proposal_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  retention_redaction BOOLEAN;
BEGIN
  retention_redaction := OLD."anonymizedAt" IS NULL AND NEW."anonymizedAt" IS NOT NULL AND
    NEW."signerName" IS NULL AND NEW."signerDocumentType" IS NULL AND NEW."signerDocumentNumber" IS NULL AND
    NEW."acceptanceIpHash" IS NULL AND NEW."acceptanceUserAgentHash" IS NULL;
  IF TG_OP = 'DELETE' OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."opportunityId" IS DISTINCT FROM OLD."opportunityId" OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Proposal identity and content hash are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL AND NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" THEN
    RAISE EXCEPTION 'Proposal retention metadata is irreversible' USING ERRCODE = '55000';
  END IF;
  IF NEW."priceListId" IS DISTINCT FROM OLD."priceListId" OR NEW."priceListCodeSnapshot" IS DISTINCT FROM OLD."priceListCodeSnapshot" OR NEW."priceListVersionSnapshot" IS DISTINCT FROM OLD."priceListVersionSnapshot" OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR NEW."discountCents" IS DISTINCT FROM OLD."discountCents" OR NEW."taxCents" IS DISTINCT FROM OLD."taxCents" OR NEW."shippingCents" IS DISTINCT FROM OLD."shippingCents" OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR NEW."taxRegime" IS DISTINCT FROM OLD."taxRegime" OR NEW."uvtValueCents" IS DISTINCT FROM OLD."uvtValueCents" OR NEW."uvtYear" IS DISTINCT FROM OLD."uvtYear" OR NEW."deliveryPromiseDays" IS DISTINCT FROM OLD."deliveryPromiseDays" OR NEW."reservationMinutes" IS DISTINCT FROM OLD."reservationMinutes" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR (NEW."commercialNotes" IS DISTINCT FROM OLD."commercialNotes" AND NOT (retention_redaction AND NEW."commercialNotes" IS NULL)) THEN
    RAISE EXCEPTION 'Proposal commercial snapshots are immutable; create another version' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."status" = NEW."status" OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'SUPERSEDED', 'CANCELLED')) OR (OLD."status" = 'SENT' AND NEW."status" IN ('CONVERTED', 'SUPERSEDED', 'CANCELLED', 'EXPIRED')) OR (OLD."status" = 'EXPIRED' AND NEW."status" IN ('SUPERSEDED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'Invalid proposal state transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CONVERTED' AND NOT retention_redaction AND (NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt" OR NEW."convertedAt" IS DISTINCT FROM OLD."convertedAt" OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."signerDocumentType" IS DISTINCT FROM OLD."signerDocumentType" OR NEW."signerDocumentNumber" IS DISTINCT FROM OLD."signerDocumentNumber" OR NEW."acceptanceProofHash" IS DISTINCT FROM OLD."acceptanceProofHash") THEN
    RAISE EXCEPTION 'Converted proposal acceptance is immutable except for retention redaction' USING ERRCODE = '55000';
  END IF;
  IF NEW."orderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "cartId" = NEW."cartId" AND "subtotalCents" = NEW."subtotalCents" AND "discountCents" = NEW."discountCents" AND "taxCents" = NEW."taxCents" AND "shippingCents" = NEW."shippingCents" AND "totalCents" = NEW."totalCents"
  ) THEN
    RAISE EXCEPTION 'Converted order must balance exactly with its proposal' USING ERRCODE = '55000';
  END IF;
  IF NEW."cartId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Cart" WHERE "id" = NEW."cartId" AND "kind" = 'B2B' AND "couponId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Proposal carts must use the isolated B2B pricing mode' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_proposal_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "OpportunityProposal_enforce_state" BEFORE UPDATE OR DELETE ON "OpportunityProposal"
FOR EACH ROW EXECUTE FUNCTION "enforce_proposal_state"();

CREATE OR REPLACE FUNCTION "enforce_proposal_item_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Proposal items are immutable; create another proposal version' USING ERRCODE = '55000';
END;
$$;
ALTER FUNCTION "enforce_proposal_item_immutable"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "OpportunityProposalItem_immutable_update" BEFORE UPDATE ON "OpportunityProposalItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_proposal_item_immutable"();
CREATE TRIGGER "OpportunityProposalItem_immutable_delete" BEFORE DELETE ON "OpportunityProposalItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_proposal_item_immutable"();

CREATE OR REPLACE FUNCTION "enforce_copilot_run_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."opportunityId" IS DISTINCT FROM OLD."opportunityId" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId" OR NEW."model" IS DISTINCT FROM OLD."model" OR NEW."inputHash" IS DISTINCT FROM OLD."inputHash" OR NEW."promptHash" IS DISTINCT FROM OLD."promptHash" OR NEW."requestedByAdminUserId" IS DISTINCT FROM OLD."requestedByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Copilot run identity and zero-PII input hashes are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'REQUESTED' OR NEW."status" NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'Copilot runs can complete only once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_copilot_run_state"() SECURITY DEFINER SET search_path = pg_catalog, public;
CREATE TRIGGER "OpportunityCopilotRun_enforce_state" BEFORE UPDATE OR DELETE ON "OpportunityCopilotRun"
FOR EACH ROW EXECUTE FUNCTION "enforce_copilot_run_state"();

CREATE OR REPLACE FUNCTION "enforce_identity_merge_candidate_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."pairKey" IS DISTINCT FROM OLD."pairKey" OR
     NEW."sourceContactId" IS DISTINCT FROM OLD."sourceContactId" OR
     NEW."targetContactId" IS DISTINCT FROM OLD."targetContactId" OR
     NEW."matchScore" IS DISTINCT FROM OLD."matchScore" OR
     NEW."matchReasons" IS DISTINCT FROM OLD."matchReasons" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Identity merge candidate identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."status" = NEW."status" OR
          (OLD."status" = 'PENDING' AND NEW."status" IN ('MERGED', 'REJECTED')) OR
          (OLD."status" = 'MERGED' AND NEW."status" = 'REVERSED')) THEN
    RAISE EXCEPTION 'Invalid identity merge candidate transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'MERGED' AND NEW."status" = 'REVERSED' AND
     OLD."sourceSnapshot" = '{"redacted":true}'::jsonb THEN
    RAISE EXCEPTION 'A redacted identity merge cannot be reversed' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'PENDING' AND NOT (
    NEW."sourceSnapshot" = '{"redacted":true}'::jsonb AND
    NEW."targetSnapshot" = '{"redacted":true}'::jsonb AND
    NEW."movedIdentityIds" = '[]'::jsonb AND NEW."retiredIdentityIds" = '[]'::jsonb AND
    NEW."movedActivityIds" = '[]'::jsonb AND NEW."movedTaskIds" = '[]'::jsonb AND NEW."movedOpportunityIds" = '[]'::jsonb
  ) AND (
    NEW."sourceSnapshot" IS DISTINCT FROM OLD."sourceSnapshot" OR
    NEW."targetSnapshot" IS DISTINCT FROM OLD."targetSnapshot" OR
    NEW."movedIdentityIds" IS DISTINCT FROM OLD."movedIdentityIds" OR
    NEW."retiredIdentityIds" IS DISTINCT FROM OLD."retiredIdentityIds" OR
    NEW."movedActivityIds" IS DISTINCT FROM OLD."movedActivityIds" OR
    NEW."movedTaskIds" IS DISTINCT FROM OLD."movedTaskIds" OR
    NEW."movedOpportunityIds" IS DISTINCT FROM OLD."movedOpportunityIds" OR
    NEW."mergedTargetVersion" IS DISTINCT FROM OLD."mergedTargetVersion" OR
    NEW."mergedSourceVersion" IS DISTINCT FROM OLD."mergedSourceVersion" OR
    NEW."mergedByAdminUserId" IS DISTINCT FROM OLD."mergedByAdminUserId" OR
    NEW."mergedAt" IS DISTINCT FROM OLD."mergedAt") THEN
    RAISE EXCEPTION 'Identity merge snapshots are immutable except for retention redaction' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'Identity merge candidate version cannot move backwards' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "enforce_identity_merge_candidate_state"() SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE TRIGGER "PriceList_set_updated_at" BEFORE UPDATE ON "PriceList" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "PriceListItem_set_updated_at" BEFORE UPDATE ON "PriceListItem" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "Opportunity_set_updated_at" BEFORE UPDATE ON "Opportunity" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
CREATE TRIGGER "OpportunityProposal_set_updated_at" BEFORE UPDATE ON "OpportunityProposal" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['PriceList', 'PriceListItem', 'Opportunity', 'OpportunityProposal', 'OpportunityProposalItem', 'OpportunityCopilotRun'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_price_list_item_mutable"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_price_list_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_organization_price_list"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_opportunity_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_proposal_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_proposal_item_immutable"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_copilot_run_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_identity_merge_candidate_state"() FROM PUBLIC, anon, authenticated, service_role;
