-- AlterTable
ALTER TABLE "ProductMedia" DROP CONSTRAINT "ProductMedia_frames_valid";
ALTER TABLE "ProductMedia" DROP CONSTRAINT "ProductMedia_variantId_fkey";
ALTER TABLE "ProductMedia" RENAME CONSTRAINT "ProductMedia_variant_product_fkey" TO "ProductMedia_variantId_productId_fkey";

-- AlterTable
ALTER TABLE "ProductMedia"
  ADD COLUMN "frames" JSONB,
  ADD COLUMN "posterKey" VARCHAR(500),
  ADD CONSTRAINT "ProductMedia_frames_valid" CHECK (
    (
      "mediaType" = 'SPIN_360' AND "frameCount" >= 2 AND
      jsonb_typeof("frames") = 'array' AND jsonb_array_length("frames") = "frameCount"
    ) OR ("mediaType" <> 'SPIN_360' AND "frames" IS NULL)
  ),
  ADD CONSTRAINT "ProductMedia_posterKey_not_blank" CHECK (
    "posterKey" IS NULL OR ("posterKey" = btrim("posterKey") AND char_length("posterKey") > 0)
  );

CREATE UNIQUE INDEX "ProductMedia_posterKey_active_key" ON "ProductMedia"("posterKey")
WHERE "posterKey" IS NOT NULL AND "deletedAt" IS NULL;
