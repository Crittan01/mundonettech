import { randomUUID } from "node:crypto";

import { PostSaleError } from "@mundonettech/db";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { GuestOrderAccessForms } from "@/components/orders/postsale-forms";
import { OrderPostSaleView } from "@/components/orders/order-post-sale";
import { postSaleService } from "@/lib/account";
import { getGuestOrderAccess } from "@/lib/security/guest-order-access";

export const metadata = {
  title: "Posventa de tu pedido",
  robots: { index: false, follow: false, nocache: true },
};

function GuestOrderGate({ token }: { readonly token: string }) {
  return (
    <div className="py-2">
      <div className="mx-auto mb-8 max-w-4xl">
        <h1 className="text-3xl font-bold">Acceso seguro a tu pedido</h1>
        <p className="mt-2 text-muted-foreground">
          Verifica el enlace de compra y un código temporal para consultar entregas y realizar
          solicitudes de posventa.
        </p>
      </div>
      <GuestOrderAccessForms token={token} idempotencyKey={randomUUID()} />
    </div>
  );
}

async function GuestOrderContent({ params }: PageProps<"/pedido/[token]">) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) notFound();
  const access = await getGuestOrderAccess(token);
  if (!access) {
    return <GuestOrderGate token={token} />;
  }
  let order: Awaited<ReturnType<ReturnType<typeof postSaleService>["getOrder"]>>;
  try {
    order = await postSaleService().getOrder(access.actor, access.orderId);
  } catch (error) {
    if (error instanceof PostSaleError && error.code === "FORBIDDEN") {
      return <GuestOrderGate token={token} />;
    }
    throw error;
  }
  return (
    <div>
      <OrderPostSaleView
        order={order}
        channel={{ channel: "guest", orderId: access.orderId, token }}
        idempotencySeed={randomUUID()}
      />
    </div>
  );
}

export default function GuestOrderPage(props: PageProps<"/pedido/[token]">) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-live="polite" className="mx-auto max-w-4xl animate-pulse py-6">
          <span className="sr-only">Cargando acceso al pedido…</span>
          <div className="h-10 w-80 max-w-full rounded bg-muted" />
          <div className="mt-8 h-64 rounded-xl bg-muted" />
        </div>
      }
    >
      <GuestOrderContent {...props} />
    </Suspense>
  );
}
