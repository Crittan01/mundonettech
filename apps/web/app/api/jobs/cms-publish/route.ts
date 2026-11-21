import { createHash, timingSafeEqual } from "node:crypto";

import { CmsService } from "@mundonettech/cms";
import { hasAdminPermission } from "@mundonettech/core";

import { getDatabase } from "@/lib/db";

function matchesSecret(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  const secret = process.env.CMS_CRON_SECRET;
  const actorId = process.env.CMS_JOB_ACTOR_ID;
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || !actorId)
    return Response.json({ error: "CMS scheduler is not configured." }, { status: 503 });
  if (!authorization.startsWith("Bearer ") || !matchesSecret(authorization.slice(7), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const db = getDatabase();
  const actor = await db.adminUser.findFirst({
    where: { id: actorId, status: "ACTIVE", deletedAt: null },
  });
  if (!actor || !hasAdminPermission(actor.role, "content:write")) {
    return Response.json({ error: "Scheduler actor is not authorized." }, { status: 403 });
  }
  const result = await new CmsService(db).publishScheduled({ actorAdminUserId: actor.id });
  return Response.json(result);
}
