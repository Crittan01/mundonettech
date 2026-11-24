import { matchesSecretTimingSafe as matchesSecret } from "@mundonettech/core";
import { OperationalHealthService, OperationsService } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";
import { getIntegrationEnvironment } from "@/lib/integrations";

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
  const secret = process.env.HEALTH_CRON_SECRET?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (secret.length < 16) {
    return Response.json(
      { error: "Health scheduler is not configured." },
      { status: 503, headers },
    );
  }
  if (!authorization.startsWith("Bearer ") || !matchesSecret(authorization.slice(7), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  try {
    const db = getDatabase();
    const result = await new OperationalHealthService(db).capture(getIntegrationEnvironment());
    await new OperationsService(db).synchronizeNotifications();
    return Response.json(
      {
        capturedAt: result.snapshot.capturedAt,
        status: result.snapshot.status,
        activeAlerts: result.activeAlerts,
      },
      { headers },
    );
  } catch {
    return Response.json({ error: "Health scheduler execution failed." }, { status: 500, headers });
  }
}
