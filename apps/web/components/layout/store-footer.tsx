import { cacheLife, cacheTag } from "next/cache";

import { storeConfig } from "@mundonettech/config/store";

export async function StoreFooter() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:footer");

  return (
    <footer className="border-t border-border bg-secondary/50">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-secondary-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>{storeConfig.name}</p>
        <p>Comercio electrónico de tecnología en Colombia</p>
      </div>
    </footer>
  );
}
