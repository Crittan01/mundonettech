ALTER TABLE "Order" ADD COLUMN "legacyNullFulfillmentDocumentExempt" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Order"
SET "legacyNullFulfillmentDocumentExempt" = true
WHERE "fulfillmentMethod" IS NULL
  AND "buyerDocumentTypeSnapshot" IS NULL
  AND "buyerDocumentNumberSnapshot" IS NULL;
