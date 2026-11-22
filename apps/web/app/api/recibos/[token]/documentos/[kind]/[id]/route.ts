import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";
import { getDatabase } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; kind: string; id: string }> },
) {
  const { token, kind, id } = await params;
  if (!["invoice", "credit-note"].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id)) {
    return new Response(null, { status: 404 });
  }
  const receipt = await orderService().getReceiptByToken(hashCartToken(token));
  if (!receipt) return new Response(null, { status: 404 });
  const document =
    kind === "invoice"
      ? await getDatabase().taxInvoice.findFirst({
          where: { id, orderId: receipt.orderId, status: "ACCEPTED" },
        })
      : await getDatabase().creditNote.findFirst({
          where: { id, status: "ACCEPTED", invoice: { orderId: receipt.orderId } },
        });
  if (!document?.signedXml) return new Response(null, { status: 404 });
  return new Response(document.signedXml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${document.fullNumber}.xml"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
