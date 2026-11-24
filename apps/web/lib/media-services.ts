import "server-only";

import { CmsMediaService } from "@mundonettech/cms";
import { ProductMediaService, type R2MediaStorage } from "@mundonettech/media";

import { getDatabase } from "@/lib/db";

export function createCatalogMediaService(storage: R2MediaStorage): ProductMediaService {
  return new ProductMediaService(getDatabase(), storage);
}

export function createCmsMediaService(storage: R2MediaStorage): CmsMediaService {
  return new CmsMediaService(getDatabase(), storage);
}
