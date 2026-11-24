import { matchesSecretTimingSafe as matches } from "@mundonettech/core";

import { domainEventWorker } from "@/lib/domain-worker";

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
  const secret = process.env.DOMAIN_WORKER_CRON_SECRET?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (secret.length < 16)
    return Response.json({ error: "Domain worker is not configured." }, { status: 503, headers });
  if (!authorization.startsWith("Bearer ") || !matches(authorization.slice(7), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  const worker = domainEventWorker();
  const total = { claimed: 0, completed: 0, retries: 0, failed: 0 };
  for (let batch = 0; batch < 4; batch += 1) {
    const result = await worker.runBatch(25);
    total.claimed += result.claimed;
    total.completed += result.completed;
    total.retries += result.retries;
    total.failed += result.failed;
    if (result.claimed === 0) break;
  }
  return Response.json(total, { headers });
}
