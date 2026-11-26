import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EmailNotFoundError,
  EmailValidationError,
} from "../../packages/integrations/dist/index.js";
import { expectMethodAllowlist, expectNoStoreNoIndex } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  findReferral: vi.fn(),
  getPublicSiteUrl: vi.fn(() => "https://mundonettech.co"),
  storeReferralCode: vi.fn(),
  unsubscribe: vi.fn(),
  unsubscribeTopic: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDatabase: () => ({ referralCode: { findFirst: mocks.findReferral } }),
}));
vi.mock("@/lib/integrations", () => ({
  emailService: () => ({
    unsubscribe: mocks.unsubscribe,
    unsubscribeTopic: mocks.unsubscribeTopic,
  }),
  getPublicSiteUrl: mocks.getPublicSiteUrl,
}));
vi.mock("@/lib/security/referral", () => ({ storeReferralCode: mocks.storeReferralCode }));

import * as unsubscribeRoute from "../../apps/web/app/email/baja/[token]/route";
import * as referralRoute from "../../apps/web/app/referido/[code]/route";

const validCode = "23456789ABCD";
const validToken =
  "12345678-1234-4123-8123-123456789abc.signature_1234567890123456789012345678901234";

function referralRequest(code: string): Promise<Response> {
  return referralRoute.GET(new Request(`https://mundonettech.co/referido/${code}`), {
    params: Promise.resolve({ code }),
  });
}

function unsubscribeGet(token: string): Promise<Response> {
  return unsubscribeRoute.GET(new Request("https://mundonettech.co/email/baja/token"), {
    params: Promise.resolve({ token }),
  });
}

function unsubscribePost(
  body: BodyInit | null,
  contentType = "application/x-www-form-urlencoded",
  token = validToken,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return unsubscribeRoute.POST(
    new Request("https://mundonettech.co/email/baja/token", {
      method: "POST",
      headers: { "Content-Type": contentType, ...extraHeaders },
      body,
    }),
    { params: Promise.resolve({ token }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findReferral.mockResolvedValue({ id: "referral-id" });
  mocks.storeReferralCode.mockResolvedValue(validCode);
  mocks.unsubscribe.mockResolvedValue({ eventId: "event-id", topic: "lifecycle", replayed: false });
  mocks.unsubscribeTopic.mockResolvedValue("lifecycle");
});

describe("referral route", () => {
  it("validates an active code, stores only the normalized value and redirects canonically", async () => {
    const response = await referralRequest(validCode.toLowerCase());
    expect(response.status).toBe(307);
    expectNoStoreNoIndex(response);
    expect(mocks.findReferral).toHaveBeenCalledWith({
      where: {
        code: validCode,
        disabledAt: null,
        customer: { status: "ACTIVE", deletedAt: null },
      },
      select: { id: true },
    });
    expect(mocks.storeReferralCode).toHaveBeenCalledWith(validCode);
    expect(response.headers.get("location")).toBe(
      `https://mundonettech.co/mi-cuenta/beneficios?codigo=${validCode}`,
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not set a cookie for an inactive or unknown code", async () => {
    mocks.findReferral.mockResolvedValue(null);
    const response = await referralRequest(validCode);
    expect(response.status).toBe(404);
    expectNoStoreNoIndex(response);
    expect(mocks.storeReferralCode).not.toHaveBeenCalled();
  });

  it("rejects malformed codes before database access", async () => {
    const response = await referralRequest("OOOOOOOOOOOO");
    expect(response.status).toBe(404);
    expect(mocks.findReferral).not.toHaveBeenCalled();
    expect(mocks.storeReferralCode).not.toHaveBeenCalled();
  });

  it("fails without exposing storage or configuration details", async () => {
    mocks.findReferral.mockRejectedValue(new Error("database password=secret"));
    const response = await referralRequest(validCode);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it("rejects every non-GET method without side effects", async () => {
    await expectMethodAllowlist(referralRoute);
    expect(mocks.findReferral).not.toHaveBeenCalled();
    expect(mocks.storeReferralCode).not.toHaveBeenCalled();
  });
});

describe("email unsubscribe route", () => {
  it("uses GET as a read-only confirmation and escapes token and topic in HTML", async () => {
    const maliciousToken = 'token"><script>alert(1)</script>';
    mocks.unsubscribeTopic.mockResolvedValue('lifecycle<img src=x onerror="alert(1)">');
    const response = await unsubscribeGet(maliciousToken);
    expect(response.status).toBe(200);
    expectNoStoreNoIndex(response);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    const html = await response.text();
    expect(html).toContain("lifecycle&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain(encodeURIComponent(maliciousToken));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("Mundo <Net>");
  });

  it.each([new EmailValidationError("invalid"), new EmailNotFoundError()])(
    "maps invalid capability tokens to a non-enumerating 404",
    async (error) => {
      mocks.unsubscribeTopic.mockRejectedValue(error);
      const response = await unsubscribeGet("invalid");
      expect(response.status).toBe(404);
      expectNoStoreNoIndex(response);
    },
  );

  it("accepts the RFC 8058 form without cookies or authorization", async () => {
    const response = await unsubscribePost("List-Unsubscribe=One-Click");
    expect(response.status).toBe(200);
    expectNoStoreNoIndex(response);
    expect(mocks.unsubscribe).toHaveBeenCalledWith(validToken);
    expect(await response.text()).toContain("Baja confirmada");
  });

  it("accepts a case-insensitive media type with parameters", async () => {
    const response = await unsubscribePost(
      "List-Unsubscribe=One-Click",
      "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
    );
    expect(response.status).toBe(200);
  });

  it.each([
    "application/json",
    "text/plain; application/x-www-form-urlencoded",
    "application/x-www-form-urlencoded-evil",
    "multipart/form-datax; boundary=test",
  ])("rejects spoofed or unsupported Content-Type %s", async (contentType) => {
    const response = await unsubscribePost("List-Unsubscribe=One-Click", contentType);
    expect(response.status).toBe(415);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body before reading it", async () => {
    const response = await unsubscribePost("List-Unsubscribe=One-Click", undefined, validToken, {
      "Content-Length": "4097",
    });
    expect(response.status).toBe(413);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it("enforces the byte limit on a streamed body without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
        controller.close();
      },
    });
    const request = new Request("https://mundonettech.co/email/baja/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await unsubscribeRoute.POST(request, {
      params: Promise.resolve({ token: validToken }),
    });
    expect(response.status).toBe(413);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "List-Unsubscribe=No",
    "List-Unsubscribe=One-Click&List-Unsubscribe=One-Click",
    "List-Unsubscribe=One-Click&unexpected=value",
  ])("rejects an invalid or ambiguous form", async (body) => {
    const response = await unsubscribePost(body);
    expect(response.status).toBe(400);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it("maps malformed multipart parsing to 400 instead of 500", async () => {
    const response = await unsubscribePost(
      "not-a-multipart-body",
      "multipart/form-data; boundary=x",
    );
    expect(response.status).toBe(400);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it.each([new EmailValidationError("invalid"), new EmailNotFoundError()])(
    "does not reveal whether an invalid POST token existed",
    async (error) => {
      mocks.unsubscribe.mockRejectedValue(error);
      const response = await unsubscribePost("List-Unsubscribe=One-Click");
      expect(response.status).toBe(404);
      expectNoStoreNoIndex(response);
    },
  );

  it("keeps replayed suppression idempotent", async () => {
    mocks.unsubscribe.mockResolvedValue({
      eventId: "event-id",
      topic: "lifecycle",
      replayed: true,
    });
    const first = await unsubscribePost("List-Unsubscribe=One-Click");
    const replay = await unsubscribePost("List-Unsubscribe=One-Click");
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("Baja confirmada");
  });

  it("rejects methods outside GET and POST without reading a body or mutating state", async () => {
    await expectMethodAllowlist(unsubscribeRoute, "GET, POST");
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.unsubscribeTopic).not.toHaveBeenCalled();
  });
});
