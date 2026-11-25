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

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function GET() {
  return methodNotAllowed();
}

export async function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

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
  try {
    const db = getDatabase();
    const actor = await db.adminUser.findFirst({
      where: { id: actorId, status: "ACTIVE", deletedAt: null },
      select: { id: true, role: true },
    });
    if (!actor || !hasAdminPermission(actor.role, "integrations:write")) {
      return Response.json(
        { error: "Scheduler actor is not authorized." },
        { status: 403, headers },
      );
    }
    const security = await getRequestSecurityContext();
    const audit = {
      actorAdminUserId: actor.id,
      requestId: randomUUID(),
      ipHash: security.ipHash,
      userAgentHash: security.userAgentHash,
    };
    const errors: Array<{ stage: string; code: string }> = [];
    const stageErrorCode = (error: unknown): string => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        return error.code;
      }
      return error instanceof Error ? error.name : "STAGE_FAILED";
    };

    let refresh: Awaited<
      ReturnType<ReturnType<typeof channelAccountService>["refreshDueAccounts"]>
    > | null = null;
    try {
      refresh = await channelAccountService(db).refreshDueAccounts(audit);
    } catch (error) {
      errors.push({ stage: "refreshDueAccounts", code: stageErrorCode(error) });
    }

    let ingestion: Awaited<
      ReturnType<ReturnType<typeof channelOrderService>["processResourceEvents"]>
    > | null = null;
    try {
      ingestion = await channelOrderService(db).processResourceEvents(
        { ...audit, requestId: randomUUID() },
        { limit: 10 },
      );
      if (ingestion.claimed > 0) revalidateTag("catalog:inventory", { expire: 0 });
    } catch (error) {
      revalidateTag("catalog:inventory", { expire: 0 });
      errors.push({ stage: "processResourceEvents", code: stageErrorCode(error) });
    }

    let sync: Awaited<
      ReturnType<ReturnType<typeof channelCatalogService>["processSyncJobs"]>
    > | null = null;
    if (ingestion !== null) {
      try {
        sync = await channelCatalogService(db).processSyncJobs(
          { ...audit, requestId: randomUUID() },
          { limit: 10 },
        );
      } catch (error) {
        errors.push({ stage: "processSyncJobs", code: stageErrorCode(error) });
      }
    }

    let notificationsSynchronized = false;
    try {
      await new OperationsService(db).synchronizeNotifications();
      notificationsSynchronized = true;
    } catch (error) {
      errors.push({ stage: "synchronizeNotifications", code: stageErrorCode(error) });
    }

    if (errors.length > 0) {
      return Response.json(
        {
          ...(refresh ?? {}),
          ...(ingestion ? { ingestion } : {}),
          ...(sync ? { sync } : {}),
          notificationsSynchronized,
          errors,
        },
        { status: 500, headers },
      );
    }
    return Response.json({ ...refresh!, ingestion: ingestion!, sync: sync! }, { headers });
  } catch {
    return Response.json(
      { error: "Channel scheduler execution failed." },
      { status: 500, headers },
    );
  }
}
