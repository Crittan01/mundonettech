import { randomUUID } from "node:crypto";

import { hasAdminPermission, matchesSecretTimingSafe as matchesSecret } from "@mundonettech/core";
import {
  OperationsService,
  OrderLifecycleService,
  purgeExpiredIdempotencyKeys,
  purgeExpiredOperationRateLimits,
} from "@mundonettech/db";
import { revalidateTag } from "next/cache";
import { z } from "zod";

import { b2bService } from "@/lib/b2b";
import { crmPrivacyPolicyVersion, crmRetentionService } from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { financeService } from "@/lib/finance";
import { lifecycleService } from "@/lib/lifecycle";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...noStoreHeaders, Allow: "POST" } },
  );
}

export async function GET() {
  return methodNotAllowed();
}

export async function HEAD() {
  return new Response(null, { status: 405, headers: { ...noStoreHeaders, Allow: "POST" } });
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

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
  try {
    const db = getDatabase();
    const actor = await db.adminUser.findFirst({
      where: { id: actorId, status: "ACTIVE", deletedAt: null },
      select: { id: true, role: true },
    });
    if (!actor || !hasAdminPermission(actor.role, "crm:suppress")) {
      return Response.json(
        { error: "Scheduler actor is not authorized." },
        { status: 403, headers: noStoreHeaders },
      );
    }
    const security = await getRequestSecurityContext();
    const service = new OrderLifecycleService(db);
    const abandoned = await service.captureAbandonedCarts();
    let reservations: Awaited<ReturnType<OrderLifecycleService["releaseExpiredOrderReservations"]>>;
    try {
      reservations = await service.releaseExpiredOrderReservations();
      if (reservations.releasedOrders > 0) revalidateTag("catalog:inventory", { expire: 0 });
    } catch (error) {
      revalidateTag("catalog:inventory", { expire: 0 });
      throw error;
    }
    const partialPaymentReviews = await service.flagExpiredPartialPaymentReviews();
    const fiscalWatch = await financeService().refreshFiscalWatch();
    const expiredProposals = await b2bService(db).expireDueProposals();
    const lifecycle = await lifecycleService(db).runScheduledWork(100);
    let crmRetention: Awaited<ReturnType<ReturnType<typeof crmRetentionService>["runDue"]>>;
    try {
      crmRetention = await crmRetentionService(db).runDue(
        { privacyPolicyVersion: crmPrivacyPolicyVersion! },
        {
          actorAdminUserId: actor.id,
          requestId: randomUUID(),
          ipHash: security.ipHash,
          userAgentHash: security.userAgentHash,
        },
      );
      if (crmRetention.suppressed.length > 0) revalidateTag("reviews", { expire: 0 });
    } catch (error) {
      revalidateTag("reviews", { expire: 0 });
      throw error;
    }
    const purgedIdempotencyKeys = await purgeExpiredIdempotencyKeys(db, { limit: 500 });
    const purgedRateLimits = await purgeExpiredOperationRateLimits(db, 500);
    await new OperationsService(db).synchronizeNotifications();
    return Response.json(
      {
        abandonedCarts: abandoned,
        expiredReservations: reservations,
        partialPaymentReviews,
        expiredProposals,
        lifecycle,
        purgedIdempotencyKeys,
        purgedRateLimits,
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
  } catch {
    return Response.json(
      { error: "Order scheduler execution failed." },
      { status: 500, headers: noStoreHeaders },
    );
  }
}
