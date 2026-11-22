import { createHash, timingSafeEqual } from "node:crypto";

import { CmsService } from "@mundonettech/cms";
import { hasAdminPermission } from "@mundonettech/core";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { getDatabase } from "@/lib/db";
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
  const secret = process.env.CMS_CRON_SECRET?.trim() ?? "";
  const actorId = process.env.CMS_JOB_ACTOR_ID?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";

  if (secret.length < 16 || !z.uuid().safeParse(actorId).success) {
    return Response.json(
      { error: "CMS scheduler is not configured." },
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
  if (!actor || !hasAdminPermission(actor.role, "content:write")) {
    return Response.json(
      { error: "Scheduler actor is not authorized." },
      { status: 403, headers: noStoreHeaders },
    );
  }

  const security = await getRequestSecurityContext();
  const result = await new CmsService(db).publishScheduled({
    actorAdminUserId: actor.id,
    ipHash: security.ipHash,
    userAgentHash: security.userAgentHash,
  });

  if (result.versions > 0 || result.pages > 0) {
    revalidateTag("cms", { expire: 0 });
    for (const slug of result.affectedSlugs) {
      revalidateTag(`cms:page:${slug}`, { expire: 0 });
    }
    revalidatePath("/admin/contenido");
  }

  return Response.json(
    {
      versions: result.versions,
      pages: result.pages,
      pagesDeferred: result.pagesDeferred,
    },
    { headers: noStoreHeaders },
  );
}
