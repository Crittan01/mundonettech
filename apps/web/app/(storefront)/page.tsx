import { cacheLife, cacheTag } from "next/cache";

import { storeConfig } from "@mundonettech/config/store";

export default async function HomePage() {
  "use cache";

  cacheLife("max");
  cacheTag("storefront:home");

  return (
    <section className="grid min-h-[60vh] items-center gap-12 py-10 lg:grid-cols-[1.15fr_0.85fr]">
      <div className="space-y-6">
        <p className="text-sm font-semibold tracking-[0.18em] text-primary uppercase">
          Tecnología multimarca en Colombia
        </p>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
          Tecnología que conecta tu mundo.
        </h1>
        <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
          {storeConfig.description}
        </p>
      </div>
      <aside className="rounded-3xl border border-border bg-card p-8 text-card-foreground shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">Tu tienda de tecnología</p>
        <p className="mt-3 text-2xl font-semibold">{storeConfig.name}</p>
        <p className="mt-4 leading-7 text-muted-foreground">
          Soluciones para trabajar, crear, conectarte y disfrutar cada día.
        </p>
      </aside>
    </section>
  );
}
