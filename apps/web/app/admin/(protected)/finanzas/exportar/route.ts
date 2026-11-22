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

export async function GET(request: Request) {
  try {
    await getAdminSession({ permission: "finance:read" });
    const url = new URL(request.url);
    const now = await getDatabaseClock(getDatabase());
    const defaultYear = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(now),
    );
    const range = parseFinanceRange(
      {
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        year: url.searchParams.get("year") ?? undefined,
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
    if (error instanceof AdminAuthorizationError) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    }
    if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
      return Response.json(
        { error: "Invalid or excessive finance range." },
        { status: 400, headers },
      );
    }
    throw error;
  }
}
