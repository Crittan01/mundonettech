import { ReceiptBalanceError } from "@mundonettech/db";

import { hashCartToken } from "@/lib/cart-token";
import { orderService } from "@/lib/checkout";
import { getDatabase } from "@/lib/db";

const baseHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...baseHeaders, Allow: "GET" } },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; kind: string; id: string }> },
) {
  const { token, kind, id } = await params;
  if (
    !["invoice", "credit-note"].includes(kind) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    return new Response(null, { status: 404, headers: baseHeaders });
  }
  let receipt;
  try {
    receipt = await orderService().getReceiptByToken(hashCartToken(token));
    if (!receipt) return new Response(null, { status: 404, headers: baseHeaders });
    const document =
      kind === "invoice"
        ? await getDatabase().taxInvoice.findFirst({
            where: { id, orderId: receipt.orderId, status: "ACCEPTED" },
            select: { fullNumber: true, signedXml: true },
          })
        : await getDatabase().creditNote.findFirst({
            where: { id, status: "ACCEPTED", invoice: { orderId: receipt.orderId } },
            select: { fullNumber: true, signedXml: true },
          });
    if (!document?.signedXml) return new Response(null, { status: 404, headers: baseHeaders });
    const safeFilename =
      document.fullNumber.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "documento";
    return new Response(document.signedXml, {
      headers: {
        ...baseHeaders,
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFilename}.xml"`,
      },
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReceiptBalanceError) {
      return new Response(null, { status: 404, headers: baseHeaders });
    }
    return new Response(null, { status: 500, headers: baseHeaders });
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
