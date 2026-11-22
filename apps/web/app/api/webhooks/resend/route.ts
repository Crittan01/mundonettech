import { EmailValidationError } from "@mundonettech/integrations";

import { emailService } from "@/lib/integrations";

const headers = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 1_000_000)
    return Response.json({ error: "Payload too large." }, { status: 413, headers });
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 1_000_000)
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
