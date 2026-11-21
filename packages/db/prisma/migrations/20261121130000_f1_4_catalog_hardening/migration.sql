-- Enforce active-only variants in Product.searchVector (ADR-023) and add product-first active price index
CREATE INDEX "ProductVariant_product_active_price_idx"
  ON "ProductVariant"("productId", "priceCents", "id")
  WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;

CREATE OR REPLACE FUNCTION "refresh_product_search_vector"(p_product_id UUID) RETURNS void
LANGUAGE sql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH brand_text AS (
    SELECT brand."name" AS text
    FROM "Brand" brand
    WHERE brand."id" = (SELECT "brandId" FROM "Product" WHERE "id" = p_product_id)
      AND brand."deletedAt" IS NULL
  ), variant_text AS (
    SELECT string_agg(
      variant."sku" || ' ' || COALESCE(variant."gtin", '') || ' ' ||
      COALESCE(variant."ean", '') || ' ' || COALESCE(variant."mpn", ''),
      ' '
    ) AS text
    FROM "ProductVariant" variant
    WHERE variant."productId" = p_product_id
      AND variant."status" = 'ACTIVE'
      AND variant."deletedAt" IS NULL
  ), attribute_text AS (
    SELECT string_agg(pav."normalizedValue", ' ') AS text
    FROM "ProductAttributeValue" pav
    JOIN "AttributeDefinition" ad ON ad."id" = pav."attributeId"
    WHERE pav."productId" = p_product_id
      AND ad."searchable" = true
      AND ad."deletedAt" IS NULL
  )
  UPDATE "Product" product
  SET "searchVector" =
    setweight(to_tsvector('simple', public.immutable_unaccent(product."name" || ' ' || COALESCE(product."shortDescription", ''))), 'A') ||
    setweight(to_tsvector('simple', public.immutable_unaccent(COALESCE((SELECT text FROM brand_text), ''))), 'B') ||
    setweight(to_tsvector('simple', public.immutable_unaccent(COALESCE((SELECT text FROM variant_text), ''))), 'C') ||
    setweight(to_tsvector('simple', public.immutable_unaccent(COALESCE((SELECT text FROM attribute_text), ''))), 'D')
  WHERE product."id" = p_product_id;
$$;

REVOKE ALL ON FUNCTION "refresh_product_search_vector"(UUID) FROM PUBLIC, anon, authenticated, service_role;

SELECT public.refresh_product_search_vector("id") FROM "Product";

