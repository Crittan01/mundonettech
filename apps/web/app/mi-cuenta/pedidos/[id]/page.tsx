import { randomUUID } from "node:crypto";

import { notFound } from "next/navigation";
import { z } from "zod";

import { OrderPostSaleView } from "@/components/orders/order-post-sale";
import { accountService } from "@/lib/account";
import { AccountError } from "@mundonettech/db";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = {
  title: "Posventa del pedido",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AccountOrderDetailPage({
  params,
}: PageProps<"/mi-cuenta/pedidos/[id]">) {
  const [{ id }, { profile }] = await Promise.all([params, requireCustomerPage()]);
  if (!z.string().uuid().safeParse(id).success) notFound();
  const order = await accountService()
    .getOrder(profile.id, id)
    .catch((error: unknown) => {
      if (error instanceof AccountError && error.code === "NOT_FOUND") notFound();
      throw error;
    });
  return (
    <div>
      <OrderPostSaleView
        order={order}
        channel={{ channel: "account", orderId: id }}
        idempotencySeed={randomUUID()}
      />
    </div>
  );
}
