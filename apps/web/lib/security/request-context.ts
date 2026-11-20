import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import type { Prisma, PrismaClient } from "@mundonettech/db";
import { ipAddress } from "@vercel/functions";
import { headers } from "next/headers";

import { getSecurityEventPepper } from "@/lib/env";

export interface RequestSecurityContext {
  ipHash: Uint8Array<ArrayBuffer>;
  userAgentHash: Uint8Array<ArrayBuffer> | null;
}

function digest(value: string): Uint8Array<ArrayBuffer> {
  return createHmac("sha256", getSecurityEventPepper()).update(value, "utf8").digest();
}

export async function getRequestSecurityContext(): Promise<RequestSecurityContext> {
  const requestHeaders = await headers();
  if (process.env.NODE_ENV === "production" && process.env.VERCEL !== "1") {
    throw new Error("Verified client IP requires the trusted production platform.");
  }
  let clientIp = ipAddress(requestHeaders);
  if (!clientIp && process.env.NODE_ENV !== "production") clientIp = "127.0.0.1";
  if (!clientIp || !isIP(clientIp)) throw new Error("A verified client IP is unavailable.");
  const userAgent = requestHeaders.get("user-agent");
  return {
    ipHash: digest(clientIp),
    userAgentHash: userAgent ? digest(userAgent.slice(0, 512)) : null,
  };
}

export async function recordSecurityEvent(
  db: PrismaClient,
  options: {
    context: RequestSecurityContext;
    eventType: string;
    adminUserId?: string;
    customerId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const metadata = JSON.parse(JSON.stringify(options.metadata ?? {})) as Prisma.InputJsonValue;
    await db.securityEvent.create({
      data: {
        eventType: options.eventType,
        ipHash: options.context.ipHash,
        userAgentHash: options.context.userAgentHash,
        ...(options.adminUserId ? { adminUserId: options.adminUserId } : {}),
        ...(options.customerId ? { customerId: options.customerId } : {}),
        metadata,
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
      return;
    throw error;
  }
}
