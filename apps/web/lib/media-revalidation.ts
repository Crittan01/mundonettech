import { revalidateTag } from "next/cache";

export function revalidateCatalogMediaUpload(slug: string): void {
  revalidateTag("catalog", { expire: 0 });
  revalidateTag("catalog:search", { expire: 0 });
  revalidateTag("catalog:compare", { expire: 0 });
  revalidateTag("catalog:cms-grid", { expire: 0 });
  revalidateTag("merchant-feed", { expire: 0 });
  revalidateTag("meta-catalog-feed", { expire: 0 });
  revalidateTag("sitemap", { expire: 0 });
  revalidateTag(`catalog:product:${slug}`, { expire: 0 });
}

export function revalidateCmsMediaUpload(): void {
  revalidateTag("cms:media", { expire: 0 });
}
