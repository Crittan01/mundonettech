import { describe, expect, it } from "vitest";

import {
  adminNavigation,
  assertB2bExpiry,
  copilotPriorityLabels,
  hasAdminPermission,
  isReservedRedirectSource,
  normalizePriceListCode,
} from "../../packages/core/dist/index.js";
import {
  createGeminiRequest,
  GeminiB2bCopilot,
  GeminiProviderError,
  parseGeminiCredentials,
  type B2bCopilotAggregate,
} from "../../packages/integrations/dist/index.js";

const aggregate: B2bCopilotAggregate = {
  opportunityStatus: "PROPOSAL_SENT",
  proposalStatus: "SENT",
  proposalVersion: 2,
  previousProposalCount: 2,
  itemCount: 3,
  totalUnits: 20,
  subtotalCents: "1000000",
  discountCents: "100000",
  taxCents: "171000",
  shippingCents: "20000",
  totalCents: "1091000",
  stockIssueCount: 0,
  secondsToExpiry: 3600,
};

const credentials = {
  apiKey: "AIza-test-key-with-enough-length",
  model: "gemini-2.5-flash",
  apiUrl: "https://generativelanguage.googleapis.com/v1beta/models",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("B2B validation and authorization", () => {
  it("normalizes list codes and validates expiration without accepting invalid ranges", () => {
    expect(normalizePriceListCode("  empresas_andina-2026 ")).toBe("EMPRESAS_ANDINA-2026");
    expect(() => normalizePriceListCode("1-invalid")).toThrow(TypeError);
    const now = new Date("2026-11-22T12:00:00-05:00");
    expect(assertB2bExpiry(new Date(now.getTime() + 86_400_000), now)).toBeInstanceOf(Date);
    expect(() => assertB2bExpiry(new Date(now.getTime() + 30 * 60_000), now)).toThrow(RangeError);
    expect(() => assertB2bExpiry(new Date(now.getTime() + 31 * 86_400_000), now)).toThrow(
      RangeError,
    );
  });

  it("separates B2B read/write permissions and protects public routes from redirects", () => {
    expect(hasAdminPermission("STORE_MANAGER", "b2b:read")).toBe(true);
    expect(hasAdminPermission("STORE_MANAGER", "b2b:write")).toBe(true);
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "b2b:read")).toBe(true);
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "b2b:write")).toBe(false);
    expect(hasAdminPermission("CMS_EDITOR", "b2b:read")).toBe(false);
    expect(adminNavigation("STORE_MANAGER").some((item) => item.href === "/admin/b2b")).toBe(true);
    expect(isReservedRedirectSource("/empresas")).toBe(true);
    expect(isReservedRedirectSource("/propuesta/token-privado")).toBe(true);
    expect(copilotPriorityLabels).toEqual({
      LOW: "Baja",
      NORMAL: "Normal",
      HIGH: "Alta",
      URGENT: "Urgente",
    });
  });
});

describe("Gemini zero-PII provider", () => {
  it("validates encrypted credential shape and the official endpoint", () => {
    expect(parseGeminiCredentials(new TextEncoder().encode(JSON.stringify(credentials)))).toEqual(
      credentials,
    );
    expect(() =>
      parseGeminiCredentials(
        new TextEncoder().encode(
          JSON.stringify({ ...credentials, apiUrl: "https://example.com/v1beta/models" }),
        ),
      ),
    ).toThrow(GeminiProviderError);
    expect(() =>
      parseGeminiCredentials(
        new TextEncoder().encode(JSON.stringify({ ...credentials, apiKey: "short" })),
      ),
    ).toThrow(GeminiProviderError);
  });

  it("builds a closed aggregate request without identifiers, contact data or free text", () => {
    const request = createGeminiRequest(aggregate);
    expect(request.promptHash).toHaveLength(32);
    expect(request.body).not.toMatch(
      /example\.test|901\.234|Laura|Rodríguez|organizationId|contactId|opportunityId/,
    );
    const body = JSON.parse(request.body) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.contents[0]?.parts[0]?.text).toContain('"totalCents":"1091000"');
    expect(() => createGeminiRequest({ ...aggregate, totalCents: "1" })).toThrow(
      GeminiProviderError,
    );
  });

  it("parses only the structured suggestion and sends the key in a header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const provider = new GeminiB2bCopilot(credentials, {
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return response({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      priority: "HIGH",
                      nextAction: "SCHEDULE_FOLLOW_UP",
                      reasonCodes: ["EXPIRING_SOON"],
                      confidenceBps: 9200,
                    }),
                  },
                ],
              },
            },
          ],
        });
      },
    });
    await expect(provider.suggest(aggregate)).resolves.toEqual({
      priority: "HIGH",
      nextAction: "SCHEDULE_FOLLOW_UP",
      reasonCodes: ["EXPIRING_SOON"],
      confidenceBps: 9200,
    });
    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(new Headers(capturedInit?.headers).get("x-goog-api-key")).toBe(credentials.apiKey);
    expect(capturedUrl).not.toContain(credentials.apiKey);
  });

  it("fails closed on unexpected output and classifies uncertain transport separately", async () => {
    const invalid = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () =>
        response({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"priority":"HIGH","nextAction":"ESCALATE","reasonCodes":["HIGH_VALUE"],"confidenceBps":9000,"name":"Laura"}',
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(invalid.suggest(aggregate)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const unavailable = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () => response({}, 503),
    });
    await expect(unavailable.suggest(aggregate)).rejects.toMatchObject({
      code: "NETWORK_UNCERTAIN",
    });
    const rejected = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () => response({}, 400),
    });
    await expect(rejected.suggest(aggregate)).rejects.toMatchObject({ code: "HTTP_ERROR" });

    expect(() =>
      parseGeminiCredentials(
        new TextEncoder().encode(
          JSON.stringify({
            ...credentials,
            apiUrl: "https://generativelanguage.googleapis.com:8443/v1beta/models",
          }),
        ),
      ),
    ).toThrow(GeminiProviderError);

    const allowedFeedback = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () =>
        response({
          promptFeedback: { safetyRatings: [] },
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: '{"priority":"NORMAL","nextAction":"SCHEDULE_FOLLOW_UP","reasonCodes":["HIGH_VALUE"],"confidenceBps":8100}',
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(allowedFeedback.suggest(aggregate)).resolves.toMatchObject({
      priority: "NORMAL",
      confidenceBps: 8100,
    });

    const blockedPrompt = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () => response({ promptFeedback: { blockReason: "SAFETY" } }),
    });
    await expect(blockedPrompt.suggest(aggregate)).rejects.toMatchObject({ code: "BLOCKED" });

    const blockedFinish = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () =>
        response({
          candidates: [
            {
              finishReason: "SAFETY",
              content: {
                parts: [
                  {
                    text: '{"priority":"NORMAL","nextAction":"SCHEDULE_FOLLOW_UP","reasonCodes":["HIGH_VALUE"],"confidenceBps":8100}',
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(blockedFinish.suggest(aggregate)).rejects.toMatchObject({ code: "BLOCKED" });

    const badConfidence = new GeminiB2bCopilot(credentials, {
      fetchImpl: async () =>
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: '{"priority":"NORMAL","nextAction":"REVIEW_PRICING","reasonCodes":["HIGH_VALUE"],"confidenceBps":99999}',
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(badConfidence.suggest(aggregate)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
