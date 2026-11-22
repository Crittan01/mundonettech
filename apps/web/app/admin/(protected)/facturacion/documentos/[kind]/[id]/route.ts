import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const baseHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    await getAdminSession({ permission: "invoices:read" });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) {
      const forbidden = error.code === "FORBIDDEN";
      return Response.json(
        { error: forbidden ? "Forbidden." : "Unauthorized." },
        { status: forbidden ? 403 : 401, headers: baseHeaders },
      );
    }
    throw error;
  }
  const { kind, id } = await params;
  if (!["invoice", "credit-note"].includes(kind) || !uuidPattern.test(id)) {
    return new Response(null, { status: 404, headers: baseHeaders });
  }
  const document =
    kind === "invoice"
      ? await getDatabase().taxInvoice.findFirst({ where: { id, status: "ACCEPTED" } })
      : await getDatabase().creditNote.findFirst({ where: { id, status: "ACCEPTED" } });
  if (!document?.signedXml) return new Response(null, { status: 404, headers: baseHeaders });
  const safeFilename = document.fullNumber.replace(/[^A-Za-z0-9._-]/g, "_") || "documento";
  return new Response(document.signedXml, {
    headers: {
      ...baseHeaders,
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename}.xml"`,
    },
  });
}
