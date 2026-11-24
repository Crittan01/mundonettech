import { describe, expect, it } from "vitest";

import { bogotaInputValue } from "../../apps/web/lib/admin-pricing-presenters.js";
import { single } from "../../apps/web/lib/admin-search-params.js";

describe("Admin search params", () => {
  it("uses the first repeated value without changing scalar or empty contracts", () => {
    expect(single("ACTIVE")).toBe("ACTIVE");
    expect(single("")).toBe("");
    expect(single(["FIRST", "SECOND"])).toBe("FIRST");
    expect(single([])).toBeUndefined();
    expect(single(undefined)).toBeUndefined();
  });
});

describe("Admin presenters", () => {
  it("formats datetime-local values in Bogotá across date and midnight boundaries", () => {
    expect(bogotaInputValue(null)).toBe("");
    expect(bogotaInputValue(new Date("2026-06-15T04:59:00.000Z"))).toBe("2026-06-14T23:59");
    expect(bogotaInputValue(new Date("2026-06-15T05:00:00.000Z"))).toBe("2026-06-15T00:00");
  });
});
