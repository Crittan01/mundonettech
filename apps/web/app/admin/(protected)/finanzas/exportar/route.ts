import { randomUUID } from "node:crypto";

import { z } from "zod";

import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { parseFinanceRange } from "@/lib/finance-params";
import { financeService } from "@/lib/finance";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "GET" } },
  );
}

function singleSearchParam(searchParams: URLSearchParams, key: string): string | undefined {
  const values = searchParams.getAll(key);
  if (values.length > 1) throw new TypeError(`Duplicate ${key} parameter.`);
  return values[0];
}

export async function GET(request: Request) {
  let session;
  try {
    session = await getAdminSession({ permission: "finance:read", requireRecentMfa: true });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) {
      const forbidden = error.code === "FORBIDDEN";
      return Response.json(
        { error: forbidden ? "Forbidden." : "Unauthorized." },
        { status: forbidden ? 403 : 401, headers },
      );
    }
    return Response.json({ error: "Internal server error." }, { status: 500, headers });
  }
  try {
    const url = new URL(request.url);
    const db = getDatabase();
    const now = await getDatabaseClock(db);
    const defaultYear = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(now),
    );
    const range = parseFinanceRange(
      {
        from: singleSearchParam(url.searchParams, "from"),
        to: singleSearchParam(url.searchParams, "to"),
        year: singleSearchParam(url.searchParams, "year"),
      },
      defaultYear,
    );
    const context = await getRequestSecurityContext();
    const csv = await financeService().exportCsv(range);
    const rowCount = csv.split(/\r?\n/).filter((line) => line.length > 0).length - 1;
    await db.adminActionLog.create({
      data: {
        actorAdminUserId: session.profile.id,
        action: "FINANCE_CSV_EXPORTED",
        targetType: "FinanceReport",
        targetId: `${range.fromDate}:${range.toDate}`,
        requestId: randomUUID(),
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: {
          fromDate: range.fromDate,
          toDate: range.toDate,
          rowCount: Math.max(0, rowCount),
        },
      },
    });
    return new Response(`\uFEFF${csv}\r\n`, {
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="finanzas-${range.fromDate}-${range.toDate}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
      return Response.json(
        { error: "Invalid or excessive finance range." },
        { status: 400, headers },
      );
    }
    return Response.json({ error: "Finance export failed." }, { status: 500, headers });
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
