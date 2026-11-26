import { describe, expect, it } from "vitest";

import {
  adminNavigation,
  classifyRfm,
  lifecycleEnrollmentExitReasonLabels,
  normalizeCustomerSegmentDefinition,
  normalizeLifecycleSteps,
  rfmScores,
} from "../../packages/core/dist/index.js";

const definition = {
  minFrequency: null,
  maxFrequency: null,
  minNetLtvCents: null,
  maxNetLtvCents: null,
  lastPurchaseWithinDays: null,
  lastPurchaseOlderThanDays: null,
  rfmClass: null,
};

const step = {
  position: 0,
  offsetMinutes: 0,
  subject: "Hola {{customerFirstName}}",
  htmlBody:
    '<p>Hola {{customerFirstName}} de {{storeName}}.</p><p><a href="{{accountUrl}}">Cuenta</a></p><p><a href="{{unsubscribeUrl}}">Baja</a></p>',
  textBody: "{{customerFirstName}} · {{storeName}} · {{accountUrl}} · {{unsubscribeUrl}}",
  variables: ["accountUrl", "customerFirstName", "storeName", "unsubscribeUrl"],
};

describe("F5.2 segment definitions and lifecycle templates", () => {
  it("normalizes a complete segment definition and BIGINT money without floats", () => {
    expect(
      normalizeCustomerSegmentDefinition({
        ...definition,
        minFrequency: 2,
        maxFrequency: 8,
        minNetLtvCents: "100000000",
        maxNetLtvCents: "900000000",
        lastPurchaseWithinDays: 180,
        lastPurchaseOlderThanDays: 30,
        rfmClass: "LOYAL",
      }),
    ).toEqual({
      minFrequency: 2,
      maxFrequency: 8,
      minNetLtvCents: "100000000",
      maxNetLtvCents: "900000000",
      lastPurchaseWithinDays: 180,
      lastPurchaseOlderThanDays: 30,
      rfmClass: "LOYAL",
    });
  });

  it("rejects unknown fields, inverted windows, unsafe money and invalid RFM classes", () => {
    expect(() => normalizeCustomerSegmentDefinition({ ...definition, email: "x@y.test" })).toThrow(
      TypeError,
    );
    expect(() =>
      normalizeCustomerSegmentDefinition({ ...definition, minFrequency: 4, maxFrequency: 2 }),
    ).toThrow(RangeError);
    expect(() =>
      normalizeCustomerSegmentDefinition({
        ...definition,
        minNetLtvCents: "100.5",
      }),
    ).toThrow(TypeError);
    expect(() =>
      normalizeCustomerSegmentDefinition({
        ...definition,
        lastPurchaseWithinDays: 30,
        lastPurchaseOlderThanDays: 30,
      }),
    ).toThrow(RangeError);
    expect(() => normalizeCustomerSegmentDefinition({ ...definition, rfmClass: "VIP" })).toThrow(
      TypeError,
    );
  });

  it("requires contiguous steps, increasing delays, exact tokens and a safe unsubscribe link", () => {
    expect(normalizeLifecycleSteps([step])).toEqual([step]);
    expect(
      normalizeLifecycleSteps([
        step,
        { ...step, position: 1, offsetMinutes: 60, subject: "Segundo {{storeName}}" },
      ]),
    ).toHaveLength(2);
    expect(() => normalizeLifecycleSteps([{ ...step, variables: ["unsubscribeUrl"] }])).toThrow(
      TypeError,
    );
    expect(() =>
      normalizeLifecycleSteps([
        {
          ...step,
          htmlBody: "<p>Sin baja</p>",
          textBody: "{{customerFirstName}} {{storeName}} {{accountUrl}}",
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      normalizeLifecycleSteps([step, { ...step, position: 1, offsetMinutes: 0 }]),
    ).toThrow(RangeError);
    expect(() =>
      normalizeLifecycleSteps([
        { ...step, htmlBody: '<img src="x" onerror="alert(1)">{{unsubscribeUrl}}' },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      normalizeLifecycleSteps([{ ...step, htmlBody: "<svg/onload=alert(1)>{{unsubscribeUrl}}" }]),
    ).toThrow(TypeError);
    expect(() =>
      normalizeLifecycleSteps([
        {
          ...step,
          htmlBody: '<a href="&#106;avascript:alert(1)">Click</a>{{unsubscribeUrl}}',
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      normalizeLifecycleSteps([
        {
          ...step,
          htmlBody: '<a href="data:image/svg+xml;base64,PHN2Zz4=">Click</a>{{unsubscribeUrl}}',
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      normalizeLifecycleSteps([{ ...step, subject: "Hola\n{{customerFirstName}}" }]),
    ).toThrow(TypeError);
    expect(() =>
      normalizeLifecycleSteps([{ ...step, subject: "Hola\t{{customerFirstName}}" }]),
    ).toThrow(TypeError);
    expect(() => normalizeLifecycleSteps([{ ...step, subject: "{{unknown}}" }])).toThrow(TypeError);
    expect(lifecycleEnrollmentExitReasonLabels.CONSENT_REVOKED).toBe(
      "Consentimiento comercial revocado",
    );
  });
});

describe("F5.2 deterministic RFM scoring and navigation", () => {
  it("scores exact recency, frequency and monetary boundaries", () => {
    expect(rfmScores({ recencyDays: 30, frequency: 10, ltvCents: 100_000_000n })).toEqual({
      recency: 5,
      frequency: 5,
      monetary: 5,
    });
    expect(rfmScores({ recencyDays: 31, frequency: 9, ltvCents: 99_999_999n })).toEqual({
      recency: 4,
      frequency: 4,
      monetary: 4,
    });
    expect(rfmScores({ recencyDays: 181, frequency: 1, ltvCents: 4_999_999n })).toEqual({
      recency: 1,
      frequency: 1,
      monetary: 1,
    });
    expect(rfmScores({ recencyDays: null, frequency: 0, ltvCents: 0n })).toEqual({
      recency: 0,
      frequency: 0,
      monetary: 0,
    });
  });

  it("classifies every lifecycle audience and rejects inconsistent metrics", () => {
    expect(classifyRfm({ recencyDays: null, frequency: 0, ltvCents: 0n })).toBe("PROSPECT");
    expect(classifyRfm({ recencyDays: 10, frequency: 12, ltvCents: 200_000_000n })).toBe(
      "CHAMPIONS",
    );
    expect(classifyRfm({ recencyDays: 60, frequency: 3, ltvCents: 30_000_000n })).toBe("LOYAL");
    expect(classifyRfm({ recencyDays: 200, frequency: 4, ltvCents: 30_000_000n })).toBe("AT_RISK");
    expect(classifyRfm({ recencyDays: 10, frequency: 1, ltvCents: 100n })).toBe("NEW");
    expect(classifyRfm({ recencyDays: 60, frequency: 2, ltvCents: 100n })).toBe("POTENTIAL");
    expect(classifyRfm({ recencyDays: 200, frequency: 1, ltvCents: 100n })).toBe("HIBERNATING");
    expect(classifyRfm({ recencyDays: 90, frequency: 1, ltvCents: 100n })).toBe("NEEDS_ATTENTION");
    expect(() => classifyRfm({ recencyDays: null, frequency: 1, ltvCents: 100n })).toThrow(
      RangeError,
    );
  });

  it("exposes lifecycle routes only to their authorized backoffice roles", () => {
    expect(adminNavigation("SUPERADMIN").map((item) => item.href)).toEqual(
      expect.arrayContaining(["/admin/segmentos", "/admin/lifecycle", "/admin/analitica-rfm"]),
    );
    expect(adminNavigation("CUSTOMER_SUPPORT").map((item) => item.href)).toEqual(
      expect.arrayContaining(["/admin/segmentos", "/admin/lifecycle"]),
    );
    expect(adminNavigation("CUSTOMER_SUPPORT").map((item) => item.href)).not.toContain(
      "/admin/analitica-rfm",
    );
    expect(adminNavigation("CMS_EDITOR").map((item) => item.href)).not.toContain(
      "/admin/lifecycle",
    );
  });
});
