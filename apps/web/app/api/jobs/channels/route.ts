import { randomUUID } from "node:crypto";

import { hasAdminPermission, matchesSecretTimingSafe as matchesSecret } from "@mundonettech/core";
import { OperationsService } from "@mundonettech/db";
import { revalidateTag } from "next/cache";
import { z } from "zod";

import { getDatabase } from "@/lib/db";
import {
  channelAccountService,
  channelCatalogService,
  channelOrderService,
} from "@/lib/integrations";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export async function GET() {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function POST(request: Request) {
  const secret = process.env.CHANNEL_CRON_SECRET?.trim() ?? "";
  const actorId = process.env.CHANNEL_JOB_ACTOR_ID?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (secret.length < 16 || !z.uuid().safeParse(actorId).success) {
    return Response.json(
      { error: "Channel scheduler is not configured." },
      { status: 503, headers },
    );
  }
  if (!authorization.startsWith("Bearer ") || !matchesSecret(authorization.slice(7), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  const db = getDatabase();
  const actor = await db.adminUser.findFirst({
    where: { id: actorId, status: "ACTIVE", deletedAt: null },
  });
  if (!actor || !hasAdminPermission(actor.role, "integrations:write")) {
    return Response.json({ error: "Scheduler actor is not authorized." }, { status: 403, headers });
  }
  const security = await getRequestSecurityContext();
  const audit = {
    actorAdminUserId: actor.id,
    requestId: randomUUID(),
    ipHash: security.ipHash,
    userAgentHash: security.userAgentHash,
  };
  const result = await channelAccountService(db).refreshDueAccounts(audit);
  const ingestion = await channelOrderService(db).processResourceEvents(
    { ...audit, requestId: randomUUID() },
    { limit: 10 },
  );
  if (ingestion.claimed > 0) revalidateTag("catalog:inventory", { expire: 0 });
  const sync = await channelCatalogService(db).processSyncJobs(
    { ...audit, requestId: randomUUID() },
    { limit: 10 },
  );
  await new OperationsService(db).synchronizeNotifications();
  return Response.json({ ...result, ingestion, sync }, { headers });
}
