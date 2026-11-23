import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { hasAdminPermission } from "@mundonettech/core";
import { OperationsService } from "@mundonettech/db";
import { z } from "zod";

import { getDatabase } from "@/lib/db";
import { channelAccountService } from "@/lib/integrations";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function matchesSecret(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

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
  const result = await channelAccountService(db).refreshDueAccounts({
    actorAdminUserId: actor.id,
    requestId: randomUUID(),
    ipHash: security.ipHash,
    userAgentHash: security.userAgentHash,
  });
  await new OperationsService(db).synchronizeNotifications();
  return Response.json(result, { headers });
}
