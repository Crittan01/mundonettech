import { z } from "zod";

import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { parseFinanceRange } from "@/lib/finance-params";
import { financeService } from "@/lib/finance";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";

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
  try {
    await getAdminSession({ permission: "finance:read", requireRecentMfa: true });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) {
      const forbidden = error.code === "FORBIDDEN";
      return Response.json(
        { error: forbidden ? "Forbidden." : "Unauthorized." },
        { status: forbidden ? 403 : 401, headers },
      );
    }
    throw error;
  }
  try {
    const url = new URL(request.url);
    const now = await getDatabaseClock(getDatabase());
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
    const csv = await financeService().exportCsv(range);
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
    throw error;
  }
}

export const HEAD = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
