import { createHash, timingSafeEqual } from "node:crypto";

import { hasAdminPermission } from "@mundonettech/core";
import { OperationsService, OrderLifecycleService } from "@mundonettech/db";
import { z } from "zod";

import { crmPrivacyPolicyVersion, crmRetentionService } from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { financeService } from "@/lib/finance";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export async function GET() {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...noStoreHeaders, Allow: "POST" } },
  );
}

function matchesSecret(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  const secret = process.env.ORDER_CRON_SECRET?.trim() ?? "";
  const actorId = process.env.CRM_JOB_ACTOR_ID?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (secret.length < 16 || !z.uuid().safeParse(actorId).success) {
    return Response.json(
      { error: "Order scheduler is not configured." },
      { status: 503, headers: noStoreHeaders },
    );
  }
  if (!authorization.startsWith("Bearer ") || !matchesSecret(authorization.slice(7), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
  }
  const db = getDatabase();
  const actor = await db.adminUser.findFirst({
    where: { id: actorId, status: "ACTIVE", deletedAt: null },
  });
  if (!actor || !hasAdminPermission(actor.role, "crm:suppress")) {
    return Response.json(
      { error: "Scheduler actor is not authorized." },
      { status: 403, headers: noStoreHeaders },
    );
  }
  const service = new OrderLifecycleService(db);
  const abandoned = await service.captureAbandonedCarts();
  const reservations = await service.releaseExpiredOrderReservations();
  const partialPaymentReviews = await service.flagExpiredPartialPaymentReviews();
  const fiscalWatch = await financeService().refreshFiscalWatch();
  const security = await getRequestSecurityContext();
  const crmRetention = await crmRetentionService(db).runDue(
    { privacyPolicyVersion: crmPrivacyPolicyVersion! },
    {
      actorAdminUserId: actor.id,
      ipHash: security.ipHash,
      userAgentHash: security.userAgentHash,
    },
  );
  await new OperationsService(db).synchronizeNotifications();
  return Response.json(
    {
      abandonedCarts: abandoned,
      expiredReservations: reservations,
      partialPaymentReviews,
      crmRetention: {
        scanned: crmRetention.scanned,
        suppressed: crmRetention.suppressed.length,
        deferred: crmRetention.deferred.length,
      },
      fiscalWatch: {
        fiscalYear: fiscalWatch.fiscalYear,
        snapshotDate: fiscalWatch.snapshotDate,
        status: fiscalWatch.status,
      },
    },
    { headers: noStoreHeaders },
  );
}
