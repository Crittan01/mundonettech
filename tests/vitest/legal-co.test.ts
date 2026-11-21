import { describe, expect, it } from "vitest";

import { legalConfig } from "../../config/dist/legal.config.js";
import {
  addColombianBusinessDays,
  bogotaDateOnly,
  buildLegalConfiguration,
  calculateRetractRefundDeadline,
  calculateRetractWindow,
  colombianHolidays,
  easterSunday,
  evaluateRetractWindow,
  isColombianBusinessDay,
  LegalConfigurationError,
  requiredLegalSlugs,
} from "../../packages/legal-co/dist/index.js";

describe("F2.3 — eight-versioned Colombian legal documents", () => {
  it("validates the complete brand configuration and returns all required documents", () => {
    const result = buildLegalConfiguration(legalConfig);
    expect(result.documents).toHaveLength(8);
    expect(result.documents.map((document) => document.slug)).toEqual(requiredLegalSlugs);
    expect(result.operator.countryCode).toBe("CO");
    for (const document of result.documents) {
      expect(document.sections.length).toBeGreaterThanOrEqual(6);
      expect(document.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(document.effectiveDate).toBe("2026-11-21");
      for (const section of document.sections) {
        expect(section.paragraphs.length).toBeGreaterThan(0);
      }
    }
    const retract = result.documents.find(
      (document) => document.slug === "retracto-y-devoluciones",
    )!;
    expect(JSON.stringify(retract)).toContain("quince días calendario");
    expect(JSON.stringify(retract)).toContain("cinco días hábiles");
    const privacy = result.documents.find(
      (document) => document.slug === "tratamiento-datos-personales",
    )!;
    expect(JSON.stringify(privacy)).toContain("diez días hábiles");
    expect(JSON.stringify(privacy)).toContain("quince días hábiles");
  });

  it("rejects missing documents, unknown fields, unsafe content and invalid identities", () => {
    expect(() =>
      buildLegalConfiguration({ operator: legalConfig.operator, documents: [] }),
    ).toThrow(LegalConfigurationError);
    expect(() => buildLegalConfiguration({ ...legalConfig, extra: true })).toThrow(/unknown field/);
    expect(() =>
      buildLegalConfiguration({
        ...legalConfig,
        operator: { ...legalConfig.operator, privacyEmail: "not-an-email" },
      }),
    ).toThrow(/privacyEmail/);
    expect(() =>
      buildLegalConfiguration({
        ...legalConfig,
        operator: { ...legalConfig.operator, siteUrl: "http://insecure.example.co" },
      }),
    ).toThrow(/HTTPS/);
    const unsafe = {
      ...legalConfig,
      documents: legalConfig.documents.map((document, documentIndex) =>
        documentIndex === 0
          ? {
              ...document,
              sections: document.sections.map((section, sectionIndex) =>
                sectionIndex === 0
                  ? { ...section, paragraphs: ["<script>alert(1)</script>"] }
                  : section,
              ),
            }
          : document,
      ),
    };
    expect(() => buildLegalConfiguration(unsafe)).toThrow(/safe plain text/);
    const duplicate = {
      ...legalConfig,
      documents: legalConfig.documents.map((document, documentIndex) =>
        documentIndex === 0
          ? {
              ...document,
              sections: document.sections.map((section, sectionIndex) =>
                sectionIndex === 1 ? { ...section, id: document.sections[0].id } : section,
              ),
            }
          : document,
      ),
    };
    expect(() => buildLegalConfiguration(duplicate)).toThrow(/duplicate anchors/);
    const invalidDate = {
      ...legalConfig,
      documents: legalConfig.documents.map((document, documentIndex) =>
        documentIndex === 0 ? { ...document, effectiveDate: "2026-02-30" } : document,
      ),
    };
    expect(() => buildLegalConfiguration(invalidDate)).toThrow(/real calendar date/);
  });
});

describe("F2.3 — official Colombian holidays and business-day SLA", () => {
  it("computes Gregorian Easter and all 18 legal holidays including movable dates", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    const holidays2026 = colombianHolidays(2026);
    expect(holidays2026).toHaveLength(18);
    expect(holidays2026.map((holiday) => holiday.date)).toEqual([
      "2026-01-01",
      "2026-01-12",
      "2026-03-23",
      "2026-04-02",
      "2026-04-03",
      "2026-05-01",
      "2026-05-18",
      "2026-06-08",
      "2026-06-15",
      "2026-06-29",
      "2026-07-20",
      "2026-08-07",
      "2026-08-17",
      "2026-10-12",
      "2026-11-02",
      "2026-11-16",
      "2026-12-08",
      "2026-12-25",
    ]);
    const holidays2025 = colombianHolidays(2025);
    expect(holidays2025).toHaveLength(18);
    expect(new Set(holidays2025.map((holiday) => holiday.date)).size).toBe(17);
    expect(holidays2025.filter((holiday) => holiday.date === "2025-06-30")).toHaveLength(2);
  });

  it("excludes weekends and official holidays and carries counts across year boundaries", () => {
    expect(isColombianBusinessDay("2026-12-24")).toBe(true);
    expect(isColombianBusinessDay("2026-12-25")).toBe(false);
    expect(isColombianBusinessDay("2026-12-26")).toBe(false);
    expect(isColombianBusinessDay("2026-11-16")).toBe(false);
    expect(addColombianBusinessDays("2026-12-24", 5)).toBe("2027-01-04");
    expect(addColombianBusinessDays("2026-11-20", 5)).toBe("2026-11-27");
    expect(addColombianBusinessDays("2026-11-20", 0)).toBe("2026-11-20");
    expect(() => addColombianBusinessDays("2026-02-30", 1)).toThrow(/Invalid calendar date/);
    expect(() => addColombianBusinessDays("2026-01-01", -1)).toThrow(RangeError);
    expect(() => colombianHolidays(1800)).toThrow(RangeError);
  });

  it("evaluates retract in Bogotá with open, closed, weekend and pre-delivery boundaries", () => {
    const deliveredAt = "2026-11-20T10:00:00-05:00";
    expect(calculateRetractWindow(deliveredAt)).toEqual({
      deliveryDate: "2026-11-20",
      dueDate: "2026-11-27",
      businessDays: 5,
    });
    expect(evaluateRetractWindow(deliveredAt, "2026-11-27T23:59:59-05:00")).toMatchObject({
      status: "OPEN",
      isOpen: true,
    });
    expect(evaluateRetractWindow(deliveredAt, "2026-11-28T00:00:00-05:00")).toMatchObject({
      status: "CLOSED",
      isOpen: false,
    });
    expect(evaluateRetractWindow(deliveredAt, "2026-11-20T09:59:59-05:00")).toMatchObject({
      status: "BEFORE_DELIVERY",
      isOpen: false,
    });
    expect(calculateRetractWindow("2026-11-21").dueDate).toBe("2026-11-27");
    expect(bogotaDateOnly("2026-01-01T02:00:00Z")).toBe("2025-12-31");
    expect(bogotaDateOnly("2026-01-01")).toBe("2026-01-01");
    expect(() => bogotaDateOnly("2026-01-01T12:00:00")).toThrow(/timezone/);
    expect(calculateRetractRefundDeadline("2026-01-01T12:00:00-05:00").toISOString()).toBe(
      "2026-01-16T17:00:00.000Z",
    );
  });
});
