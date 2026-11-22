import { EmailValidationError } from "@mundonettech/integrations";

import { emailService } from "@/lib/integrations";

const maxWebhookBytes = 1_000_000;
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

async function readBoundedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > maxWebhookBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxWebhookBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function GET() {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function POST(request: Request) {
  const body = await readBoundedBody(request);
  if (body === null)
    return Response.json({ error: "Payload too large." }, { status: 413, headers });
  try {
    const result = await emailService().processWebhook({
      body,
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof EmailValidationError)
      return Response.json({ error: "Invalid webhook." }, { status: 401, headers });
    throw error;
  }
}
