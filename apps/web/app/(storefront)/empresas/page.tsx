import { B2bLeadForm } from "@/components/b2b/lead-form";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = {
  title: "Ventas a empresas",
  description: "Solicita una propuesta comercial para compras corporativas y al por mayor.",
};

export default async function BusinessPage() {
  const security = await getAuthPageSecurity();
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <p className="text-sm font-medium text-primary">Canal empresas</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Tecnología para tu operación</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Registra tu necesidad real de compra. Un asesor revisará disponibilidad, cantidades y
          condiciones para emitir una propuesta versionada con precios e impuestos claros.
        </p>
      </div>
      <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <B2bLeadForm {...security} />
      </section>
      <section aria-labelledby="b2b-process" className="space-y-3">
        <h2 id="b2b-process" className="text-xl font-semibold">
          Cómo continúa la gestión
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Revisamos tu solicitud y la disponibilidad actual de cada referencia.</li>
          <li>Recibes un enlace privado con una versión y una vigencia concretas.</li>
          <li>
            Al firmar, el sistema vuelve a validar precios, impuestos y stock antes de crear el
            pedido.
          </li>
        </ol>
      </section>
    </div>
  );
}
