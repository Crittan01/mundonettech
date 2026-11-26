import { describe, expect, it, vi } from "vitest";

import { hasCanonicalSameOrigin } from "../../../apps/web/lib/security/origin.js";
import { expectSecurityHeaders, loadRoute, requestWithJson, responseBody } from "./route-loader.js";

const endpoint = "https://shop.example.test/api/metrics/funnel";
const validBody = JSON.stringify({
  pageViews: 2,
  productViews: 1,
  cartAdditions: 1,
  checkoutStarts: 1,
});

function createFunnelRoute() {
  const recordPublicBatch = vi.fn(async (counters?: Record<string, bigint>) => {
    void counters;
  });
  class FunnelService {
    recordPublicBatch = recordPublicBatch;
  }
  const getDatabase = vi.fn(() => ({}));
  const getRequestSecurityContext = vi.fn(async () => ({
    ipHash: new Uint8Array(32).fill(7),
    userAgentHash: null,
  }));
  const route = loadRoute("metrics/funnel", {
    "@mundonettech/db": { FunnelService },
    "@/lib/db": { getDatabase },
    "@/lib/security/origin": { hasCanonicalSameOrigin },
    "@/lib/security/request-context": { getRequestSecurityContext },
  });
  return { route, recordPublicBatch, getDatabase, getRequestSecurityContext };
}

function metricRequest(
  body: string | Uint8Array = validBody,
  headerOverrides: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    origin: "https://shop.example.test",
    host: "shop.example.test",
    "content-length": String(Buffer.byteLength(body)),
    ...headerOverrides,
  };
  return requestWithJson(endpoint, body, headers);
}

describe("A2 public funnel metrics", () => {
  it("rejects GET and every missing, cross-site, malformed or non-canonical Origin/Host", async () => {
    const current = createFunnelRoute();
    const get = await current.route.GET();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expectSecurityHeaders(get);
    const invalidHeaders = [
      { origin: "", host: "shop.example.test" },
      { origin: "https://shop.example.test", host: "" },
      { origin: "https://evil.example", host: "shop.example.test" },
      { origin: "https://shop.example.test", host: "evil.example" },
      { origin: "http://shop.example.test", host: "shop.example.test" },
      { origin: "https://shop.example.test/path", host: "shop.example.test" },
      { origin: "https://shop.example.test/", host: "shop.example.test" },
      { origin: "https://shop.example.test", host: "shop.example.test/path" },
      { origin: "https://shop.example.test", host: "user@shop.example.test" },
      { origin: "null", host: "shop.example.test" },
    ];
    for (const overrides of invalidHeaders) {
      const response = await current.route.POST(metricRequest(validBody, overrides));
      expect(response.status).toBe(403);
      expect(await responseBody(response)).toEqual({ error: "Invalid origin." });
    }
    expect(current.getRequestSecurityContext).not.toHaveBeenCalled();
    expect(current.recordPublicBatch).not.toHaveBeenCalled();
  });

  it("accepts canonical HTTPS and loopback HTTP origins with normalized JSON media types", async () => {
    const https = createFunnelRoute();
    const response = await https.route.POST(
      metricRequest(validBody, { "content-type": "Application/JSON; charset=utf-8" }),
    );
    expect(response.status).toBe(202);
    const loopback = createFunnelRoute();
    const body = JSON.stringify({ pageViews: 1 });
    const loopbackResponse = await loopback.route.POST(
      requestWithJson("http://127.0.0.1:4010/api/metrics/funnel", body, {
        origin: "http://127.0.0.1:4010",
        host: "127.0.0.1:4010",
        "content-length": String(Buffer.byteLength(body)),
      }),
    );
    expect(loopbackResponse.status).toBe(202);
  });

  it("rejects wrong media types and invalid declared sizes before IP hashing, rate limiting or body reads", async () => {
    const wrongType = createFunnelRoute();
    const response = await wrongType.route.POST(
      metricRequest(validBody, { "content-type": "text/plain" }),
    );
    expect(response.status).toBe(415);
    expect(wrongType.getRequestSecurityContext).not.toHaveBeenCalled();

    for (const contentLength of ["", "0", "1", "16385", "1e3", "-1", "9007199254740992"]) {
      const current = createFunnelRoute();
      const invalid = await current.route.POST(
        metricRequest(validBody, { "content-length": contentLength }),
      );
      expect(invalid.status).toBe(413);
      expect(current.getRequestSecurityContext).not.toHaveBeenCalled();
      expect(current.recordPublicBatch).not.toHaveBeenCalled();
    }
  });

  it("enforces the real streamed size even when Content-Length lies or is omitted", async () => {
    const current = createFunnelRoute();
    const response = await current.route.POST(
      metricRequest("x".repeat(16_385), { "content-length": "2" }),
    );
    expect(response.status).toBe(413);
    expect(current.getRequestSecurityContext).toHaveBeenCalledOnce();
    expect(current.recordPublicBatch).not.toHaveBeenCalled();

    const chunked = createFunnelRoute();
    const noLengthRequest = requestWithJson(endpoint, validBody, {
      origin: "https://shop.example.test",
      host: "shop.example.test",
    });
    expect((await chunked.route.POST(noLengthRequest)).status).toBe(202);
    expect(chunked.recordPublicBatch).toHaveBeenCalledOnce();

    const oversizedChunked = createFunnelRoute();
    const oversizedNoLength = requestWithJson(endpoint, "x".repeat(16_385), {
      origin: "https://shop.example.test",
      host: "shop.example.test",
    });
    expect((await oversizedChunked.route.POST(oversizedNoLength)).status).toBe(413);
    expect(oversizedChunked.recordPublicBatch).not.toHaveBeenCalled();
  });

  it("fails closed when a verified IP hash is unavailable instead of sharing an unverified anonymous bucket", async () => {
    const current = createFunnelRoute();
    current.getRequestSecurityContext.mockRejectedValue(new Error("untrusted forwarding headers"));
    const response = await current.route.POST(metricRequest());
    expect(response.status).toBe(503);
    expect(await responseBody(response)).toEqual({ error: "Metrics are unavailable." });
    expect(current.recordPublicBatch).not.toHaveBeenCalled();
  });

  it("strictly rejects malformed UTF-8, malformed JSON, unknown fields and every invalid counter shape", async () => {
    const invalidBodies: (string | Uint8Array)[] = [
      new Uint8Array([0x7b, 0xff, 0x7d]),
      "{not-json",
      "[]",
      "null",
      "{}",
      '{"pageViews":0,"productViews":0,"cartAdditions":0,"checkoutStarts":0}',
      '{"pageViews":1,"extra":1}',
      '{"pageViews":-1}',
      '{"pageViews":1001}',
      '{"pageViews":1.5}',
      '{"pageViews":"1"}',
      '{"pageViews":1000,"productViews":1000,"cartAdditions":1}',
    ];
    for (const body of invalidBodies) {
      const current = createFunnelRoute();
      const response = await current.route.POST(metricRequest(body));
      expect(response.status).toBe(400);
      expect(await responseBody(response)).toEqual({ error: "Invalid aggregate batch." });
      expect(current.recordPublicBatch).not.toHaveBeenCalled();
    }
  });

  it("records only aggregate BigInt counters and returns no IP, user agent or request details", async () => {
    const current = createFunnelRoute();
    const response = await current.route.POST(metricRequest());
    expect(response.status).toBe(202);
    expectSecurityHeaders(response);
    expect(current.recordPublicBatch).toHaveBeenCalledWith({
      pageViews: 2n,
      productViews: 1n,
      cartAdditions: 1n,
      checkoutStarts: 1n,
    });
    expect(await responseBody(response)).toEqual({ accepted: true });
    const text = await response.text();
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("userAgent");
    expect(text).not.toContain("requestId");
  });

  it("applies the per-client limit before reading the 61st body and does not count earlier origin or size rejections", async () => {
    const current = createFunnelRoute();
    for (let index = 0; index < 5; index += 1) {
      expect(
        (await current.route.POST(metricRequest(validBody, { origin: "https://evil.example" })))
          .status,
      ).toBe(403);
      expect(
        (await current.route.POST(metricRequest(validBody, { "content-length": "16385" }))).status,
      ).toBe(413);
    }
    for (let index = 0; index < 60; index += 1) {
      expect((await current.route.POST(metricRequest())).status).toBe(202);
    }
    expect(current.recordPublicBatch).toHaveBeenCalledTimes(60);
    const limited = await current.route.POST(metricRequest("{not-json"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(current.recordPublicBatch).toHaveBeenCalledTimes(60);
  });

  it("returns a generic persistence error without leaking database or counter details", async () => {
    const current = createFunnelRoute();
    current.recordPublicBatch.mockRejectedValue(new TypeError("raw SQL customer@example.test"));
    const response = await current.route.POST(metricRequest());
    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({ error: "Metrics could not be recorded." });
    expect(await response.text()).not.toContain("customer@example.test");
  });
});
