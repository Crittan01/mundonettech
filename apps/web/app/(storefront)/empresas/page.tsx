import { storeConfig } from "@mundonettech/config/store";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { B2bLeadForm } from "@/components/b2b/lead-form";
import { defaultSocialImage } from "@/lib/brand-seo";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

const canonical = new URL("/empresas", storeConfig.url).toString();

export const metadata: Metadata = {
  title: "Ventas a empresas",
  description: "Solicita una propuesta comercial para compras corporativas y al por mayor.",
  alternates: { canonical },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: canonical,
    title: "Ventas a empresas",
    description: "Solicita una propuesta comercial para compras corporativas y al por mayor.",
    images: [defaultSocialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ventas a empresas",
    description: "Solicita una propuesta comercial para compras corporativas y al por mayor.",
    images: [defaultSocialImage.url],
  },
};

export default async function BusinessPage() {
  if (!storeConfig.modules.wholesale) notFound();
  const security = await getAuthPageSecurity();
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="relative overflow-hidden rounded-3xl border border-brand-surface-border bg-brand-surface p-7 text-brand-surface-foreground shadow-lg sm:p-10">
        <div aria-hidden="true" className="mnt-hero-glow pointer-events-none absolute inset-0" />
        <div className="relative">
          <p className="inline-flex items-center gap-2 rounded-full border border-brand-surface-border bg-brand-cyan-muted px-3 py-1 text-xs font-semibold tracking-wider text-brand-cyan uppercase">
            Canal empresas
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Tecnología para tu operación
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-brand-surface-muted sm:text-base">
            Registra tu necesidad real de compra. Un asesor revisará disponibilidad, cantidades y
            condiciones para emitir una propuesta versionada con precios e impuestos claros.
          </p>
        </div>
      </div>
      <section className="rounded-2xl border border-border bg-card p-6 shadow-xs sm:p-8">
        <B2bLeadForm {...security} />
      </section>
      <section
        aria-labelledby="b2b-process"
        className="space-y-4 rounded-2xl border border-border bg-secondary/70 p-6"
      >
        <h2 id="b2b-process" className="text-xl font-semibold">
          Cómo continúa la gestión
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            <span className="font-mono text-xs font-bold text-primary">01</span>
            <p className="mt-1.5">
              Revisamos tu solicitud y la disponibilidad actual de cada referencia.
            </p>
          </li>
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            <span className="font-mono text-xs font-bold text-primary">02</span>
            <p className="mt-1.5">
              Recibes un enlace privado con una versión y una vigencia concretas.
            </p>
          </li>
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            <span className="font-mono text-xs font-bold text-primary">03</span>
            <p className="mt-1.5">
              Al firmar, el sistema vuelve a validar precios, impuestos y stock antes de crear el
              pedido.
            </p>
          </li>
        </ol>
      </section>
    </div>
  );
}
