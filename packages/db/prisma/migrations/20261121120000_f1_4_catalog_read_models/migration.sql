-- Index effective variant prices for catalog filtering and sorting without soft-deleted rows
CREATE INDEX "ProductVariant_active_price_idx"
  ON "ProductVariant"("priceCents", "productId", "id")
  WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;

CREATE INDEX "ProductAttributeValue_product_attribute_normalized_idx"
  ON "ProductAttributeValue"("productId", "attributeId", "normalizedValue");
