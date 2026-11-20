-- Harden ProductMedia storage keys, MIME types, SPIN_360 frame bounds/elements, and MODEL_3D USDZ uniqueness
ALTER TABLE "ProductMedia" DROP CONSTRAINT "ProductMedia_frames_valid";

ALTER TABLE "ProductMedia"
  ADD CONSTRAINT "ProductMedia_frames_valid" CHECK (
    (
      "mediaType" = 'SPIN_360' AND
      "frameCount" BETWEEN 2 AND 120 AND
      jsonb_typeof("frames") = 'array' AND
      jsonb_array_length("frames") = "frameCount" AND
      NOT jsonb_path_exists("frames", '$[*] ? (@.type() != "string" && @.type() != "object")') AND
      NOT jsonb_path_exists("frames", '$[*] ? (@.type() == "string" && @ == "")')
    ) OR (
      "mediaType" <> 'SPIN_360' AND
      "frames" IS NULL AND
      ("frameCount" IS NULL OR "frameCount" > 0)
    )
  ),
  ADD CONSTRAINT "ProductMedia_mime_valid" CHECK (
    "mimeType" = btrim("mimeType") AND
    "mimeType" ~ '^[a-zA-Z0-9]+/[a-zA-Z0-9.+_-]+$'
  ),
  ADD CONSTRAINT "ProductMedia_usdzKey_valid" CHECK (
    "usdzKey" IS NULL OR (
      "mediaType" = 'MODEL_3D' AND
      "usdzKey" = btrim("usdzKey") AND
      char_length("usdzKey") > 0
    )
  ),
  ADD CONSTRAINT "ProductMedia_keys_safe" CHECK (
    "storageKey" !~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))' AND
    ("posterKey" IS NULL OR "posterKey" !~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))') AND
    ("usdzKey" IS NULL OR "usdzKey" !~ '(^/|/$|//|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))')
  );

CREATE UNIQUE INDEX "ProductMedia_usdzKey_active_key" ON "ProductMedia"("usdzKey")
WHERE "usdzKey" IS NOT NULL AND "deletedAt" IS NULL;

