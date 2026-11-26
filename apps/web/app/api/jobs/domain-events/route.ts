import { verifyCronBearer } from "@mundonettech/core";
import { OperationsService } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";
import { domainEventWorker } from "@/lib/domain-worker";

const batchLimit = 25;
const maxBatches = 4;
const maxExecutionMs = 45_000;

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
  const auth = verifyCronBearer(
    request.headers.get("authorization"),
    process.env.DOMAIN_WORKER_CRON_SECRET,
  );
  if (auth === "UNCONFIGURED")
    return Response.json({ error: "Domain worker is not configured." }, { status: 503, headers });
  if (auth === "UNAUTHORIZED") {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  try {
    const worker = domainEventWorker();
    const total = { claimed: 0, completed: 0, retries: 0, failed: 0 };
    const startedAt = Date.now();
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await worker.runBatch(batchLimit);
      total.claimed += result.claimed;
      total.completed += result.completed;
      total.retries += result.retries;
      total.failed += result.failed;
      const settled = result.completed + result.retries + result.failed;
      if (result.claimed < batchLimit || settled < result.claimed) break;
      if (Date.now() - startedAt >= maxExecutionMs) break;
    }
    if (total.failed > 0) {
      await new OperationsService(getDatabase()).synchronizeNotifications().catch(() => undefined);
    }
    return Response.json(total, { headers });
  } catch {
    return Response.json({ error: "Domain worker execution failed." }, { status: 500, headers });
  }
}
