import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "@mundonettech/integrations";
import { z } from "zod";

import { getIntegrationEnvironment, wompiWebhookService } from "@/lib/integrations";

const maximumBodyBytes = 1_000_000;
const headers = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBodyBytes)
    throw new RangeError("Body too large.");
  if (!request.body) return request.text();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBodyBytes) {
      await reader.cancel();
      throw new RangeError("Body too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function POST(request: Request): Promise<Response> {
  try {
    const rawCredentialId = new URL(request.url).searchParams.get("credentialId");
    const credentialId = rawCredentialId ? z.string().uuid().parse(rawCredentialId) : undefined;
    const body = await readBoundedBody(request);
    const result = await wompiWebhookService().process({
      body,
      environment: getIntegrationEnvironment(),
      ...(credentialId ? { credentialId } : {}),
      headerChecksum: request.headers.get("x-event-checksum"),
    });
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    if (error instanceof RangeError || error instanceof z.ZodError) {
      return Response.json({ error: "Invalid webhook payload." }, { status: 400, headers });
    }
    if (error instanceof PaymentValidationError || error instanceof PaymentProviderError) {
      return Response.json(
        { error: "Webhook authentication or validation failed." },
        { status: 400, headers },
      );
    }
    if (error instanceof PaymentNotFoundError) {
      return Response.json({ error: "Payment reference not found." }, { status: 404, headers });
    }
    if (error instanceof PaymentConflictError) {
      return Response.json(
        { error: "Webhook conflicts with the current payment ledger." },
        { status: 409, headers },
      );
    }
    return Response.json({ error: "Webhook processing failed." }, { status: 500, headers });
  }
}

export function GET(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}
