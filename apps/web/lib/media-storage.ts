import "server-only";

import { R2MediaStorage } from "@mundonettech/media";

import { getPublicMediaOrigin } from "@/lib/env";

export function createCmsMediaStorage(): R2MediaStorage {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 endpoint, bucket and credentials are required for CMS uploads.");
  }
  return new R2MediaStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(getPublicMediaOrigin() ? { publicBaseUrl: getPublicMediaOrigin()! } : {}),
  });
}
