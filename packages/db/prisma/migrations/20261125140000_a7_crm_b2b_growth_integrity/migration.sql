CREATE FUNCTION "validate_copilot_output_zero_pii"(value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT value IS NULL OR (
    jsonb_typeof(value) = 'object' AND
    (SELECT count(*) FROM jsonb_object_keys(value)) = 4 AND
    value ?& ARRAY['priority', 'nextAction', 'reasonCodes', 'confidenceBps'] AND
    value->>'priority' IN ('LOW', 'NORMAL', 'HIGH', 'URGENT') AND
    value->>'nextAction' IN ('CONTACT_CUSTOMER', 'REVISE_PRICING', 'VERIFY_STOCK', 'SCHEDULE_FOLLOW_UP', 'ESCALATE') AND
    jsonb_typeof(value->'reasonCodes') = 'array' AND
    jsonb_array_length(value->'reasonCodes') BETWEEN 1 AND 5 AND
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(value->'reasonCodes') AS reason
      WHERE reason NOT IN ('HIGH_VALUE', 'LARGE_VOLUME', 'EXPIRING_SOON', 'EXPIRED', 'STOCK_RISK', 'NO_PROPOSAL', 'MULTIPLE_VERSIONS', 'READY_TO_CONVERT')
    ) AND
    (SELECT count(DISTINCT reason) FROM jsonb_array_elements_text(value->'reasonCodes') AS reason) = jsonb_array_length(value->'reasonCodes') AND
    CASE WHEN jsonb_typeof(value->'confidenceBps') = 'number' THEN
      (value->>'confidenceBps')::numeric BETWEEN 0 AND 10000 AND
      (value->>'confidenceBps')::numeric = trunc((value->>'confidenceBps')::numeric)
    ELSE false END
  );
$$;

ALTER TABLE "OpportunityProposalItem"
  ADD CONSTRAINT "OpportunityProposalItem_tax_balanced"
  CHECK ("taxCents" = (("taxableBaseCents" * "appliedRateBps" + 5000) / 10000));

ALTER TABLE "OpportunityCopilotRun"
  ADD CONSTRAINT "OpportunityCopilotRun_failure_code_valid"
  CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  ADD CONSTRAINT "OpportunityCopilotRun_output_zero_pii"
  CHECK ("validate_copilot_output_zero_pii"("output"));

CREATE OR REPLACE FUNCTION "enforce_price_list_item_mutable"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  list_id UUID;
  list_status "PriceListStatus";
  list_deleted TIMESTAMPTZ;
BEGIN
  list_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."priceListId" ELSE NEW."priceListId" END;
  PERFORM pg_advisory_xact_lock(hashtextextended('b2b-price-list:' || list_id::text, 0));
  SELECT "status", "deletedAt" INTO list_status, list_deleted FROM "PriceList" WHERE "id" = list_id FOR SHARE;
  IF list_status IS DISTINCT FROM 'DRAFT' OR list_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Price list items are mutable only while the list is a draft' USING ERRCODE = '55000';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT EXISTS (
    SELECT 1 FROM "ProductVariant" variant
    JOIN "Product" product ON product."id" = variant."productId"
    JOIN "Brand" brand ON brand."id" = product."brandId"
    JOIN "Category" category ON category."id" = product."categoryId"
    WHERE variant."id" = NEW."variantId" AND variant."status" = 'ACTIVE' AND variant."deletedAt" IS NULL AND
      product."status" = 'ACTIVE' AND product."deletedAt" IS NULL AND brand."deletedAt" IS NULL AND category."deletedAt" IS NULL AND
      NEW."unitPriceCents" <= variant."priceCents"
    FOR SHARE OF variant, product, brand, category
  ) THEN
    RAISE EXCEPTION 'Price list items require a sellable variant and cannot exceed its catalog price' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."priceListId" IS DISTINCT FROM OLD."priceListId" OR NEW."variantId" IS DISTINCT FROM OLD."variantId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt") THEN
    RAISE EXCEPTION 'Price list item identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_price_list_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('b2b-price-list:' || OLD."id"::text, 0));
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
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' THEN
    IF NEW."validTo" IS NOT NULL AND NEW."validTo" <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'An expired price list cannot be activated' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PriceListItem" WHERE "priceListId" = NEW."id") THEN
      RAISE EXCEPTION 'A price list requires at least one item before activation' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "PriceListItem" item
      JOIN "ProductVariant" variant ON variant."id" = item."variantId"
      JOIN "Product" product ON product."id" = variant."productId"
      JOIN "Brand" brand ON brand."id" = product."brandId"
      JOIN "Category" category ON category."id" = product."categoryId"
      WHERE item."priceListId" = NEW."id" AND (
        item."unitPriceCents" > variant."priceCents" OR variant."status" <> 'ACTIVE' OR variant."deletedAt" IS NOT NULL OR
        product."status" <> 'ACTIVE' OR product."deletedAt" IS NOT NULL OR brand."deletedAt" IS NOT NULL OR category."deletedAt" IS NOT NULL
      )
      FOR SHARE OF variant, product, brand, category
    ) THEN
      RAISE EXCEPTION 'Every price list item must be sellable and cannot exceed its catalog price' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."status" = 'ARCHIVED' AND EXISTS (SELECT 1 FROM "Organization" WHERE "priceListId" = NEW."id" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Unassign active organizations before archiving a price list' USING ERRCODE = '55000';
  END IF;
  IF (NEW."status" = 'ARCHIVED' OR (OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL)) AND EXISTS (
    SELECT 1 FROM "OpportunityProposal" WHERE "priceListId" = NEW."id" AND "status" IN ('DRAFT', 'SENT')
  ) THEN
    RAISE EXCEPTION 'Close open proposals before archiving a price list' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_organization_price_list"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."priceListId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-price-list:' || NEW."priceListId"::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('crm-organization:' || NEW."id"::text, 0));
    IF NOT EXISTS (
      SELECT 1 FROM "PriceList" WHERE "id" = NEW."priceListId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE
    ) THEN
      RAISE EXCEPTION 'Organizations require an active price list' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "prevent_crm_organization_delete"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-organization:' || OLD."id"::text, 0));
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Organizations use archival instead of destructive deletion' USING ERRCODE = '55000';
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "Contact" WHERE "organizationId" = NEW."id" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL) OR
    EXISTS (SELECT 1 FROM "Opportunity" WHERE "organizationId" = NEW."id" AND "status" IN ('NEW', 'QUALIFYING', 'PROPOSAL_SENT'))
  ) THEN
    RAISE EXCEPTION 'Cannot archive an organization with active contacts or open opportunities' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "validate_crm_organization_reference"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."organizationId" IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'Contact' THEN
    IF NEW."status" <> 'ACTIVE' THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-organization:' || NEW."organizationId"::text, 0));
  IF TG_TABLE_NAME = 'Opportunity' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Contact" WHERE "id" = NEW."contactId" AND "organizationId" = NEW."organizationId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE
    ) THEN
      RAISE EXCEPTION 'Opportunities require an active contact from the same organization' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = NEW."organizationId" AND "deletedAt" IS NULL FOR SHARE) THEN
    RAISE EXCEPTION 'CRM references require an active organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Contact_validate_organization" BEFORE INSERT OR UPDATE OF "organizationId" ON "Contact"
FOR EACH ROW EXECUTE FUNCTION "validate_crm_organization_reference"();
CREATE TRIGGER "Opportunity_validate_organization" BEFORE INSERT OR UPDATE OF "organizationId", "contactId" ON "Opportunity"
FOR EACH ROW EXECUTE FUNCTION "validate_crm_organization_reference"();

CREATE OR REPLACE FUNCTION "enforce_proposal_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  retention_redaction BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-opportunity:' || NEW."opportunityId"::text, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-opportunity:' || OLD."opportunityId"::text, 0));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "Opportunity" WHERE "id" = NEW."opportunityId" AND "status" IN ('WON', 'LOST', 'CANCELLED') FOR SHARE) THEN
      RAISE EXCEPTION 'Closed opportunities cannot create proposals' USING ERRCODE = '23514';
    END IF;
    IF NEW."priceListId" IS NULL THEN
      IF NEW."priceListCodeSnapshot" IS NOT NULL OR NEW."priceListVersionSnapshot" IS NOT NULL THEN
        RAISE EXCEPTION 'Proposal price list snapshots must match their source' USING ERRCODE = '23514';
      END IF;
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended('b2b-price-list:' || NEW."priceListId"::text, 0));
      IF NOT EXISTS (SELECT 1 FROM "PriceList" WHERE "id" = NEW."priceListId" FOR SHARE) THEN
        RAISE EXCEPTION 'Proposal price list snapshot must reference its current active source' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
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
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' AND NEW."priceListId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-price-list:' || NEW."priceListId"::text, 0));
    IF NOT EXISTS (
      SELECT 1 FROM "PriceList" WHERE "id" = NEW."priceListId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL AND
        ((NEW."priceListCodeSnapshot" IS NULL AND NEW."priceListVersionSnapshot" IS NULL) OR
         ("code" = NEW."priceListCodeSnapshot" AND "version" = NEW."priceListVersionSnapshot")) AND
        ("validFrom" IS NULL OR "validFrom" <= CURRENT_TIMESTAMP) AND ("validTo" IS NULL OR "validTo" > CURRENT_TIMESTAMP)
      FOR SHARE
    ) THEN
      RAISE EXCEPTION 'Issued proposals require the exact active price list snapshot' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW."orderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "cartId" = NEW."cartId" AND "subtotalCents" = NEW."subtotalCents" AND "discountCents" = NEW."discountCents" AND "taxCents" = NEW."taxCents" AND "shippingCents" = NEW."shippingCents" AND "totalCents" = NEW."totalCents" FOR SHARE
  ) THEN
    RAISE EXCEPTION 'Converted order must balance exactly with its proposal' USING ERRCODE = '55000';
  END IF;
  IF NEW."cartId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Cart" WHERE "id" = NEW."cartId" AND "kind" = 'B2B' AND "couponId" IS NULL FOR SHARE
  ) THEN
    RAISE EXCEPTION 'Proposal carts must use the isolated B2B pricing mode' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER "OpportunityProposal_enforce_state" ON "OpportunityProposal";
CREATE TRIGGER "OpportunityProposal_enforce_state" BEFORE INSERT OR UPDATE OR DELETE ON "OpportunityProposal"
FOR EACH ROW EXECUTE FUNCTION "enforce_proposal_state"();

CREATE OR REPLACE FUNCTION "enforce_proposal_item_immutable"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_opportunity UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "opportunityId" INTO parent_opportunity FROM "OpportunityProposal" WHERE "id" = NEW."proposalId" AND "status" = 'DRAFT' FOR SHARE;
    IF parent_opportunity IS NULL THEN
      RAISE EXCEPTION 'Proposal items can only be inserted into a draft proposal' USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-opportunity:' || parent_opportunity::text, 0));
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Proposal items are immutable; create another proposal version' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "OpportunityProposalItem_validate_insert" BEFORE INSERT ON "OpportunityProposalItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_proposal_item_immutable"();

CREATE FUNCTION "validate_proposal_balance"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  proposal_id UUID;
  parent "OpportunityProposal";
  item_count INTEGER;
  catalog_total BIGINT;
  discount_total BIGINT;
  tax_total BIGINT;
  merchandise_total BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'OpportunityProposal' THEN
    proposal_id := NEW."id";
  ELSE
    proposal_id := NEW."proposalId";
  END IF;
  SELECT * INTO parent FROM "OpportunityProposal" WHERE "id" = proposal_id;
  SELECT count(*), COALESCE(sum("catalogUnitPriceCents" * "quantity"), 0), COALESCE(sum("discountCents"), 0),
    COALESCE(sum("taxCents"), 0), COALESCE(sum("lineTotalCents"), 0)
    INTO item_count, catalog_total, discount_total, tax_total, merchandise_total
    FROM "OpportunityProposalItem" WHERE "proposalId" = proposal_id;
  IF parent."totalCents" <= 0 OR (item_count > 0 AND (
    merchandise_total <= 0 OR parent."subtotalCents" <> catalog_total OR
    parent."discountCents" <> discount_total OR parent."taxCents" <> tax_total OR
    parent."totalCents" <> merchandise_total + tax_total + parent."shippingCents"
  )) THEN
    RAISE EXCEPTION 'Proposal totals must balance exactly with all proposal items' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "OpportunityProposal_validate_balance" AFTER INSERT OR UPDATE ON "OpportunityProposal"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_proposal_balance"();
CREATE CONSTRAINT TRIGGER "OpportunityProposalItem_validate_balance" AFTER INSERT ON "OpportunityProposalItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_proposal_balance"();

CREATE FUNCTION "enforce_b2b_cart_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE linked_opportunity UUID;
BEGIN
  SELECT "opportunityId" INTO linked_opportunity FROM "OpportunityProposal" WHERE "cartId" = OLD."id" LIMIT 1 FOR SHARE;
  IF linked_opportunity IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-opportunity:' || linked_opportunity::text, 0));
    IF NEW."kind" <> 'B2B' OR NEW."accessTokenHash" IS DISTINCT FROM OLD."accessTokenHash" OR
       NEW."couponId" IS DISTINCT FROM OLD."couponId" OR NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR
       NEW."wholesaleDiscountCents" IS DISTINCT FROM OLD."wholesaleDiscountCents" OR NEW."bundleDiscountCents" IS DISTINCT FROM OLD."bundleDiscountCents" OR
       NEW."couponDiscountCents" IS DISTINCT FROM OLD."couponDiscountCents" OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR
       NEW."itemCount" IS DISTINCT FROM OLD."itemCount" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
       NEW."assistedByAdminUserId" IS DISTINCT FROM OLD."assistedByAdminUserId" OR NEW."assistedTokenHash" IS DISTINCT FROM OLD."assistedTokenHash" OR
       NEW."assistedExpiresAt" IS DISTINCT FROM OLD."assistedExpiresAt" OR NEW."assistedClaimedAt" IS DISTINCT FROM OLD."assistedClaimedAt" OR
       NOT (NEW."status" = OLD."status" OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('CANCELLED', 'CONVERTED'))) THEN
      RAISE EXCEPTION 'A linked B2B cart is sealed; only cancellation or conversion is allowed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Cart_enforce_b2b_seal" BEFORE UPDATE ON "Cart"
FOR EACH ROW EXECUTE FUNCTION "enforce_b2b_cart_state"();

CREATE FUNCTION "enforce_b2b_cart_item_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_cart UUID;
  linked_opportunity UUID;
BEGIN
  parent_cart := CASE WHEN TG_OP = 'DELETE' THEN OLD."cartId" ELSE NEW."cartId" END;
  SELECT proposal."opportunityId" INTO linked_opportunity
    FROM "Cart" cart JOIN "OpportunityProposal" proposal ON proposal."cartId" = cart."id"
    WHERE cart."id" = parent_cart FOR SHARE OF cart, proposal;
  IF linked_opportunity IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b2b-opportunity:' || linked_opportunity::text, 0));
    RAISE EXCEPTION 'Items in a linked B2B cart are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "CartItem_enforce_b2b_seal" BEFORE INSERT OR UPDATE OR DELETE ON "CartItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_b2b_cart_item_state"();

CREATE OR REPLACE FUNCTION "validate_referral_code"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Referral codes cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
    IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE) THEN
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

CREATE OR REPLACE FUNCTION "validate_referral"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE party_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Referral history cannot be deleted' USING ERRCODE = '55000'; END IF;
  FOR party_id IN SELECT unnest(ARRAY[NEW."referrerCustomerId", NEW."referredCustomerId"]) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || party_id::text, 0));
  END LOOP;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ReferralCode" code JOIN "Customer" referrer ON referrer."id" = code."customerId"
      WHERE code."id" = NEW."codeId" AND code."customerId" = NEW."referrerCustomerId" AND code."disabledAt" IS NULL AND
        referrer."status" = 'ACTIVE' AND referrer."deletedAt" IS NULL FOR SHARE OF code, referrer
    ) OR NOT EXISTS (
      SELECT 1 FROM "Customer" WHERE "id" = NEW."referredCustomerId" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE
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
  IF NEW."status" = 'QUALIFIED' AND NOT EXISTS (
    SELECT 1 FROM "ReferralCode" code
    JOIN "Customer" referrer ON referrer."id" = code."customerId" AND referrer."status" = 'ACTIVE' AND referrer."deletedAt" IS NULL
    JOIN "Customer" referred ON referred."id" = NEW."referredCustomerId" AND referred."status" = 'ACTIVE' AND referred."deletedAt" IS NULL
    WHERE code."id" = NEW."codeId" AND code."customerId" = NEW."referrerCustomerId" AND code."disabledAt" IS NULL
    FOR SHARE OF code, referrer, referred
  ) THEN RAISE EXCEPTION 'Referral qualification requires an active code and parties' USING ERRCODE = '23514'; END IF;
  IF NEW."status" IN ('QUALIFIED', 'REVERSED') AND NOT EXISTS (
    SELECT 1 FROM "Order" parent_order LEFT JOIN "Cart" cart ON cart."id" = parent_order."cartId"
    WHERE parent_order."id" = NEW."orderId" AND parent_order."customerId" = NEW."referredCustomerId" AND
      parent_order."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND (cart."id" IS NULL OR cart."kind" <> 'B2B')
    FOR SHARE OF parent_order
  ) THEN RAISE EXCEPTION 'A qualified referral requires an eligible paid order from the referred customer' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_loyalty_txn"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_balance INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Loyalty transactions are append-only' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
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
  IF NEW."type" IN ('EARN_REVERSAL', 'REFERRAL_REVERSAL') THEN
    IF NEW."refundId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "OrderRefund" WHERE "id" = NEW."refundId" AND "orderId" = NEW."orderId" AND "status" = 'COMPLETED'
    ) THEN RAISE EXCEPTION 'Loyalty reversals require a completed order refund' USING ERRCODE = '23514'; END IF;
    IF NEW."paymentTransactionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "PaymentTransaction" pt JOIN "PaymentAttempt" pa ON pa."id" = pt."attemptId"
      WHERE pt."id" = NEW."paymentTransactionId" AND pa."orderId" = NEW."orderId" AND pt."kind" = 'VOID' AND pt."status" = 'SUCCEEDED'
    ) THEN RAISE EXCEPTION 'Loyalty void reversals require a succeeded void payment transaction' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW."type" IN ('REFERRAL_EARN', 'REFERRAL_REVERSAL') AND NOT EXISTS (
    SELECT 1 FROM "Referral" WHERE "id" = NEW."referralId" AND "orderId" = NEW."orderId" AND
      NEW."customerId" IN ("referrerCustomerId", "referredCustomerId")
  ) THEN RAISE EXCEPTION 'Referral loyalty entry does not match its attribution' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_consent_revocation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE original "Consent";
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
  IF NEW."status" = 'GRANTED' AND NOT EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "status" IN ('GUEST', 'ACTIVE') AND "deletedAt" IS NULL FOR SHARE
  ) THEN RAISE EXCEPTION 'Consent grants require an available customer' USING ERRCODE = '23514'; END IF;
  IF NEW."status" = 'REVOKED' THEN
    SELECT * INTO original FROM "Consent" WHERE "id" = NEW."revokesId" FOR SHARE;
    IF original."id" IS NULL OR original."status" <> 'GRANTED' OR
       original."customerId" <> NEW."customerId" OR original."purpose" <> NEW."purpose" THEN
      RAISE EXCEPTION 'a revocation must reference a grant for the same customer and purpose' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_segment_membership"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE previous_record "CustomerSegmentMembership"; current_sequence INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Segment membership evidence is append-only' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-segment:' || NEW."segmentId"::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
  IF NOT EXISTS (SELECT 1 FROM "CustomerSegment" WHERE "id" = NEW."segmentId" AND "version" = NEW."segmentVersion" AND "definitionHash" = NEW."definitionHash" FOR SHARE) THEN
    RAISE EXCEPTION 'Segment membership does not match the segment version' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Consent" WHERE "id" = NEW."consentId" AND "customerId" = NEW."customerId" AND "purpose" = 'MARKETING_EMAIL' FOR SHARE) THEN
    RAISE EXCEPTION 'Segment membership requires customer marketing consent evidence' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous_record FROM "CustomerSegmentMembership" WHERE "segmentId" = NEW."segmentId" AND "customerId" = NEW."customerId" ORDER BY "sequence" DESC LIMIT 1;
  current_sequence := COALESCE(previous_record."sequence", 0) + 1;
  IF NEW."sequence" <> current_sequence THEN RAISE EXCEPTION 'Segment membership sequence is not consecutive' USING ERRCODE = '23514'; END IF;
  IF NEW."status" = 'ENTERED' THEN
    IF previous_record."status" = 'ENTERED' OR NOT EXISTS (
      SELECT 1 FROM "Consent" consent JOIN "Customer" customer ON customer."id" = consent."customerId"
      WHERE consent."id" = NEW."consentId" AND consent."status" = 'GRANTED' AND NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id") AND customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
      FOR SHARE OF consent, customer
    ) OR NOT EXISTS (SELECT 1 FROM "CustomerSegment" WHERE "id" = NEW."segmentId" AND "status" = 'ACTIVE' FOR SHARE) THEN
      RAISE EXCEPTION 'Segment entry requires an active customer, segment and unrevoked consent' USING ERRCODE = '23514';
    END IF;
  ELSIF previous_record."status" IS DISTINCT FROM 'ENTERED' THEN
    RAISE EXCEPTION 'Segment exit requires a current entered membership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_lifecycle_journey"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE step_count INTEGER; minimum_position INTEGER; maximum_position INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('customer-segment:' || NEW."segmentId"::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-journey:' || NEW."id"::text, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('customer-segment:' || OLD."segmentId"::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-journey:' || OLD."id"::text, 0));
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lifecycle journeys cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."version" <> 0 THEN RAISE EXCEPTION 'Lifecycle journeys start as drafts' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdByAdminUserId" IS DISTINCT FROM OLD."createdByAdminUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Lifecycle journey identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN RAISE EXCEPTION 'Archived lifecycle journeys are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IN ('ACTIVE', 'PAUSED') THEN
    IF to_jsonb(NEW) - ARRAY['status', 'version', 'updatedByAdminUserId', 'archivedAt', 'updatedAt'] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['status', 'version', 'updatedByAdminUserId', 'archivedAt', 'updatedAt'] OR
       NOT ((OLD."status" = 'ACTIVE' AND NEW."status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')) OR
            (OLD."status" = 'PAUSED' AND NEW."status" IN ('PAUSED', 'ACTIVE', 'ARCHIVED'))) THEN
      RAISE EXCEPTION 'Activated lifecycle journeys only accept pause, resume or archive' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF NEW."status" NOT IN ('ACTIVE', 'ARCHIVED') OR
     to_jsonb(NEW) - ARRAY['status', 'version', 'segmentVersion', 'updatedByAdminUserId', 'activatedAt', 'archivedAt', 'updatedAt'] IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['status', 'version', 'segmentVersion', 'updatedByAdminUserId', 'activatedAt', 'archivedAt', 'updatedAt'] THEN
    RAISE EXCEPTION 'Draft activation cannot change journey content' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'ACTIVE' THEN
    IF NOT EXISTS (SELECT 1 FROM "CustomerSegment" WHERE "id" = NEW."segmentId" AND "status" = 'ACTIVE' AND "version" = NEW."segmentVersion" FOR SHARE) THEN
      RAISE EXCEPTION 'Lifecycle activation requires the current active segment' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), min("position"), max("position") INTO step_count, minimum_position, maximum_position FROM "LifecycleStep" WHERE "journeyId" = NEW."id";
    IF step_count < 1 OR minimum_position <> 0 OR maximum_position <> step_count - 1 THEN
      RAISE EXCEPTION 'Lifecycle activation requires contiguous steps' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_lifecycle_step"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_id UUID; parent_status "LifecycleJourneyStatus";
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."journeyId" ELSE NEW."journeyId" END;
  PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-journey:' || parent_id::text, 0));
  SELECT "status" INTO parent_status FROM "LifecycleJourney" WHERE "id" = parent_id FOR SHARE;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Activated journey steps are immutable' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."subject" ~ '[\x00-\x1F\x7F]' THEN
    RAISE EXCEPTION 'Lifecycle email subject contains control characters' USING ERRCODE = '23514';
  END IF;
  IF NEW."htmlBody" ~* '<\/?(script|iframe|object|embed|form|meta|link|base|svg|style)([^a-z0-9_-]|$)' OR
     NEW."htmlBody" ~* '[[:space:]/]on[a-z]+[[:space:]]*=' OR
     NEW."htmlBody" ~* '(javascript|vbscript)[[:space:]]*:' OR
     NEW."htmlBody" ~* 'data[[:space:]]*:[[:space:]]*text/html' OR
     NEW."htmlBody" ~* 'expression[[:space:]]*\(' THEN
    RAISE EXCEPTION 'Lifecycle email HTML contains active content' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."variables") variable WHERE variable NOT IN ('accountUrl', 'customerFirstName', 'storeName', 'unsubscribeUrl')) OR
     NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."variables") variable WHERE variable = 'unsubscribeUrl') THEN
    RAISE EXCEPTION 'Lifecycle email variables are invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_lifecycle_enrollment"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  message_count INTEGER;
  queued_count INTEGER;
  step_count INTEGER;
  email_count INTEGER;
  accepted_email_count INTEGER;
  segment_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lifecycle enrollments cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "segmentId" INTO segment_id FROM "LifecycleJourney" WHERE "id" = NEW."journeyId";
    IF segment_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('customer-segment:' || segment_id::text, 0));
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-journey:' || NEW."journeyId"::text, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NOT EXISTS (
      SELECT 1 FROM "LifecycleJourney" journey
      JOIN "CustomerSegmentMembership" membership ON membership."segmentId" = journey."segmentId" AND membership."segmentVersion" = journey."segmentVersion"
      JOIN "Customer" customer ON customer."id" = membership."customerId"
      JOIN "Consent" consent ON consent."id" = membership."consentId" AND consent."customerId" = customer."id"
      WHERE journey."id" = NEW."journeyId" AND journey."status" = 'ACTIVE' AND membership."id" = NEW."entryMembershipId" AND
        membership."customerId" = NEW."customerId" AND membership."status" = 'ENTERED' AND membership."consentId" = NEW."consentId" AND
        customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL AND consent."status" = 'GRANTED' AND
        NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id") AND
        NOT EXISTS (SELECT 1 FROM "CustomerSegmentMembership" later WHERE later."segmentId" = membership."segmentId" AND later."customerId" = membership."customerId" AND later."sequence" > membership."sequence")
      FOR SHARE OF journey, membership, customer, consent
    ) THEN RAISE EXCEPTION 'Lifecycle entry requires a current eligible membership' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."journeyId" IS DISTINCT FROM OLD."journeyId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR
     NEW."entryMembershipId" IS DISTINCT FROM OLD."entryMembershipId" OR NEW."consentId" IS DISTINCT FROM OLD."consentId" OR
     NEW."enteredAt" IS DISTINCT FROM OLD."enteredAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR OLD."status" <> 'ACTIVE' OR
     NEW."status" NOT IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED') THEN
    RAISE EXCEPTION 'Lifecycle enrollment identity or terminal state is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    SELECT count(*) INTO step_count FROM "LifecycleStep" WHERE "journeyId" = NEW."journeyId";
    SELECT count(*), count(*) FILTER (WHERE "status" = 'QUEUED') INTO message_count, queued_count
      FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id";
    SELECT count(*), count(*) FILTER (WHERE "status" IN ('SENT', 'DELIVERY_DELAYED', 'DELIVERED'))
      INTO email_count, accepted_email_count
      FROM "EmailEvent" WHERE "lifecycleMessageId" IN (SELECT "id" FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id");
    IF message_count <> step_count OR queued_count <> step_count OR
       email_count <> step_count OR accepted_email_count <> step_count THEN
      RAISE EXCEPTION 'A completed enrollment requires provider acceptance for every step' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" = 'CANCELLED' AND EXISTS (SELECT 1 FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id" AND "status" IN ('SCHEDULED', 'DISPATCHING')) THEN
    RAISE EXCEPTION 'Cancel pending lifecycle messages before cancelling enrollment' USING ERRCODE = '23514';
  ELSIF NEW."status" = 'FAILED' AND NOT EXISTS (SELECT 1 FROM "LifecycleMessage" WHERE "enrollmentId" = NEW."id" AND "status" = 'FAILED') THEN
    RAISE EXCEPTION 'A failed enrollment requires a failed message' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_lifecycle_message"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lifecycle messages cannot be deleted' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SCHEDULED' OR NOT EXISTS (
      SELECT 1 FROM "LifecycleEnrollment" enrollment
      JOIN "LifecycleStep" step ON step."journeyId" = enrollment."journeyId"
      JOIN "LifecycleJourney" journey ON journey."id" = enrollment."journeyId" AND journey."status" = 'ACTIVE'
      WHERE enrollment."id" = NEW."enrollmentId" AND enrollment."status" = 'ACTIVE' AND enrollment."customerId" = NEW."customerId" AND
        step."id" = NEW."stepId" AND NEW."scheduledAt" = enrollment."enteredAt" + make_interval(mins => step."offsetMinutes")
      FOR SHARE OF enrollment, step, journey
    ) THEN RAISE EXCEPTION 'Lifecycle message does not match its active enrollment and step schedule' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."enrollmentId" IS DISTINCT FROM OLD."enrollmentId" OR NEW."stepId" IS DISTINCT FROM OLD."stepId" OR
     NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."scheduledAt" IS DISTINCT FROM OLD."scheduledAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Lifecycle message identity and schedule are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD."status" = 'SCHEDULED' AND NEW."status" IN ('SCHEDULED', 'DISPATCHING', 'CANCELLED')) OR
          (OLD."status" = 'DISPATCHING' AND NEW."status" IN ('DISPATCHING', 'SCHEDULED', 'QUEUED', 'SUPPRESSED', 'CANCELLED', 'FAILED')) OR
          (OLD."status" = 'QUEUED' AND NEW."status" IN ('QUEUED', 'SUPPRESSED', 'CANCELLED', 'FAILED')) OR
          (OLD."status" = 'FAILED' AND NEW."status" IN ('FAILED', 'CANCELLED')) OR
          (OLD."status" IN ('SUPPRESSED', 'CANCELLED') AND NEW."status" = OLD."status")) THEN
    RAISE EXCEPTION 'Invalid lifecycle message state transition' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IN ('DISPATCHING', 'QUEUED') AND NOT EXISTS (
    SELECT 1 FROM "LifecycleEnrollment" enrollment JOIN "LifecycleJourney" journey ON journey."id" = enrollment."journeyId"
    WHERE enrollment."id" = NEW."enrollmentId" AND enrollment."status" = 'ACTIVE' AND journey."status" = 'ACTIVE'
    FOR SHARE OF enrollment, journey
  ) THEN RAISE EXCEPTION 'Dispatch requires an active enrollment and journey' USING ERRCODE = '23514'; END IF;
  IF NEW."status" IN ('QUEUED', 'SUPPRESSED') AND NOT EXISTS (SELECT 1 FROM "EmailEvent" WHERE "lifecycleMessageId" = NEW."id" AND "customerId" = NEW."customerId") THEN
    RAISE EXCEPTION 'Queued or suppressed lifecycle messages require their email event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_email_growth_relation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."customerId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('growth-customer:' || NEW."customerId"::text, 0));
  END IF;
  IF NEW."templateKey" = 'cart.recovery' AND NOT EXISTS (
    SELECT 1 FROM "AbandonedCart" abandoned JOIN "Customer" customer ON customer."id" = abandoned."customerId"
    WHERE abandoned."id" = NEW."abandonedCartId" AND abandoned."customerId" = NEW."customerId" AND
      customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL FOR SHARE OF abandoned, customer
  ) THEN RAISE EXCEPTION 'Cart recovery email does not match its active customer and abandoned cart' USING ERRCODE = '23514'; END IF;
  IF NEW."templateKey" = 'lifecycle.campaign' AND NOT EXISTS (
    SELECT 1 FROM "LifecycleMessage" message
    JOIN "LifecycleEnrollment" enrollment ON enrollment."id" = message."enrollmentId"
    JOIN "LifecycleJourney" journey ON journey."id" = enrollment."journeyId"
    JOIN "Customer" customer ON customer."id" = message."customerId"
    WHERE message."id" = NEW."lifecycleMessageId" AND message."customerId" = NEW."customerId" AND
      customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL AND
      (TG_OP <> 'INSERT' OR (message."status" = 'DISPATCHING' AND enrollment."status" = 'ACTIVE' AND journey."status" = 'ACTIVE'))
    FOR SHARE OF message, enrollment, journey, customer
  ) THEN RAISE EXCEPTION 'Lifecycle email does not match its active customer and dispatching message' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_copilot_output_zero_pii"(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_price_list_item_mutable"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_price_list_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_organization_price_list"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "prevent_crm_organization_delete"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_crm_organization_reference"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_proposal_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_proposal_item_immutable"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_proposal_balance"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_b2b_cart_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "enforce_b2b_cart_item_state"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_referral_code"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_referral"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_loyalty_txn"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_consent_revocation"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_segment_membership"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_journey"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_step"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_enrollment"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_lifecycle_message"() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION "validate_email_growth_relation"() FROM PUBLIC, anon, authenticated, service_role;
