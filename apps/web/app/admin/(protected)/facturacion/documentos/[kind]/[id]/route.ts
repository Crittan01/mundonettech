import { randomUUID } from "node:crypto";

import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const baseHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...baseHeaders, Allow: "GET" } },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  let session;
  try {
    session = await getAdminSession({ permission: "invoices:read", requireRecentMfa: true });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) {
      const forbidden = error.code === "FORBIDDEN";
      return Response.json(
        { error: forbidden ? "Forbidden." : "Unauthorized." },
        { status: forbidden ? 403 : 401, headers: baseHeaders },
      );
    }
    return Response.json(
      { error: "Internal server error." },
      { status: 500, headers: baseHeaders },
    );
  }
  try {
    const { kind, id } = await params;
    if (!["invoice", "credit-note"].includes(kind) || !uuidPattern.test(id)) {
      return new Response(null, { status: 404, headers: baseHeaders });
    }
    const db = getDatabase();
    const document =
      kind === "invoice"
        ? await db.taxInvoice.findFirst({
            where: { id, status: "ACCEPTED" },
            select: { fullNumber: true, signedXml: true },
          })
        : await db.creditNote.findFirst({
            where: { id, status: "ACCEPTED" },
            select: { fullNumber: true, signedXml: true },
          });
    if (!document?.signedXml) return new Response(null, { status: 404, headers: baseHeaders });
    const context = await getRequestSecurityContext();
    await db.adminActionLog.create({
      data: {
        actorAdminUserId: session.profile.id,
        action: "TAX_DOCUMENT_XML_DOWNLOADED",
        targetType: kind === "invoice" ? "TaxInvoice" : "CreditNote",
        targetId: id,
        requestId: randomUUID(),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { kind, documentId: id },
      },
    });
    const safeFilename =
      document.fullNumber.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "documento";
    return new Response(document.signedXml, {
      headers: {
        ...baseHeaders,
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFilename}.xml"`,
      },
    });
  } catch {
    return Response.json(
      { error: "Document download failed." },
      { status: 500, headers: baseHeaders },
    );
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
