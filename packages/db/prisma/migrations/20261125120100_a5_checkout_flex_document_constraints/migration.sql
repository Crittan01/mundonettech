ALTER TABLE "Order" DROP CONSTRAINT "Order_buyer_document_valid";
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyer_document_valid" CHECK (
  (("buyerDocumentTypeSnapshot" IS NULL) = ("buyerDocumentNumberSnapshot" IS NULL)) AND
  ("buyerDocumentTypeSnapshot" IS NULL OR "buyerDocumentTypeSnapshot" IN ('11', '12', '13', '21', '22', '31', '41', '42', '50', '91')) AND
  ("buyerDocumentNumberSnapshot" IS NULL OR "buyerDocumentNumberSnapshot" ~ '^[A-Za-z0-9.-]{3,30}$') AND
  ("anonymizedAt" IS NOT NULL OR ("legacyNullFulfillmentDocumentExempt" AND "fulfillmentMethod" IS NULL) OR
   (("taxRegime" IS DISTINCT FROM 'RESPONSABLE_IVA' AND "fulfillmentMethod" IS NOT DISTINCT FROM 'CLICK_COLLECT') OR "buyerDocumentTypeSnapshot" IS NOT NULL))
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_legacy_null_fulfillment_document_exempt_valid" CHECK (
  "legacyNullFulfillmentDocumentExempt" = false OR (
    "fulfillmentMethod" IS NULL AND
    "buyerDocumentTypeSnapshot" IS NULL AND
    "buyerDocumentNumberSnapshot" IS NULL
  )
);

CREATE FUNCTION "validate_legacy_null_fulfillment_document_exempt"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."legacyNullFulfillmentDocumentExempt" IS TRUE AND
     (TG_OP = 'INSERT' OR OLD."legacyNullFulfillmentDocumentExempt" IS NOT TRUE) THEN
    RAISE EXCEPTION 'Legacy NULL fulfillment document exemption cannot be granted at write time';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_legacy_null_fulfillment_document_exempt_guard"
BEFORE INSERT OR UPDATE ON "Order"
FOR EACH ROW EXECUTE FUNCTION "validate_legacy_null_fulfillment_document_exempt"();
