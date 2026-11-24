import "server-only";

import { sanitizeAuditValue } from "@mundonettech/core";
import type { Prisma, PrismaClient } from "@mundonettech/db";
import { ipAddress } from "@vercel/functions";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";

import { getSecurityEventPepper } from "@/lib/env";

export interface RequestSecurityContext {
  ipHash: Uint8Array<ArrayBuffer>;
  userAgentHash: Uint8Array<ArrayBuffer> | null;
}

function digest(value: string): Uint8Array<ArrayBuffer> {
  return createHmac("sha256", getSecurityEventPepper()).update(value, "utf8").digest();
}

function isLoopbackSiteUrl(): boolean {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function normalizeIpAddress(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (isIP(trimmed) === 6) {
    try {
      return new URL(`http://[${trimmed}]`).hostname.slice(1, -1);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function resolveVerifiedClientIp(requestHeaders: Headers): string {
  if (process.env.VERCEL === "1") {
    const vercelIp = ipAddress(requestHeaders)?.trim();
    if (vercelIp && isIP(vercelIp)) return normalizeIpAddress(vercelIp);
    throw new Error("A verified Vercel client IP is unavailable.");
  }

  if (process.env.TRUSTED_PROXY === "cloudflare") {
    const cfRay = requestHeaders.get("cf-ray");
    const cfIp = requestHeaders.get("cf-connecting-ip")?.trim();
    if (cfRay && cfIp && isIP(cfIp)) return normalizeIpAddress(cfIp);
    throw new Error("A verified Cloudflare client IP is unavailable.");
  }

  const integrationEnv = process.env.INTEGRATION_ENVIRONMENT?.trim().toUpperCase();
  if (
    process.env.NODE_ENV !== "production" ||
    (integrationEnv === "LOCAL" && isLoopbackSiteUrl())
  ) {
    return "127.0.0.1";
  }

  throw new Error(
    "Verified client IP requires VERCEL=1 or TRUSTED_PROXY=cloudflare in production.",
  );
}

export async function getRequestSecurityContext(): Promise<RequestSecurityContext> {
  const requestHeaders = await headers();
  const clientIp = resolveVerifiedClientIp(requestHeaders);
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
    const metadata = sanitizeAuditValue(options.metadata ?? {}) as Prisma.InputJsonValue;
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
