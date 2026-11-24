import { describe, expect, it } from "vitest";

import { matchesSecretTimingSafe, parseCoordinateE6 } from "../../packages/core/dist/index.js";
import { optionalTrimmedText, phoneInputPattern } from "../../apps/web/lib/form-validation";

describe("shared server primitives", () => {
  it("compares secrets through fixed-size SHA-256 digests", () => {
    expect(matchesSecretTimingSafe("same-secret", "same-secret")).toBe(true);
    expect(matchesSecretTimingSafe("provided", "expected")).toBe(false);
    expect(matchesSecretTimingSafe("", "non-empty")).toBe(false);
    expect(matchesSecretTimingSafe("", "")).toBe(false);
    expect(matchesSecretTimingSafe("a".repeat(4096), "a".repeat(4096))).toBe(true);
  });

  it("parses bounded E6 coordinates without binary floating-point arithmetic", () => {
    expect(parseCoordinateE6("4.711", "latitudeE6", -90_000_000, 90_000_000)).toBe(4_711_000);
    expect(parseCoordinateE6("-74.123456", "longitudeE6", -180_000_000, 180_000_000)).toBe(
      -74_123_456,
    );
    expect(parseCoordinateE6("0", "latitudeE6", -90_000_000, 90_000_000)).toBe(0);
    expect(Object.is(parseCoordinateE6("-0", "latitudeE6", -90_000_000, 90_000_000), 0)).toBe(true);
    expect(
      Object.is(parseCoordinateE6("-0.000000", "latitudeE6", -90_000_000, 90_000_000), 0),
    ).toBe(true);
    expect(() => parseCoordinateE6("4.0000001", "latitudeE6", -90_000_000, 90_000_000)).toThrow(
      TypeError,
    );
    expect(() => parseCoordinateE6("91", "latitudeE6", -90_000_000, 90_000_000)).toThrow(
      RangeError,
    );
    expect(() => parseCoordinateE6("1e2", "latitudeE6", -90_000_000, 90_000_000)).toThrow(
      TypeError,
    );
  });

  it("shares optional text trimming and the Colombian/international phone boundary", () => {
    expect(optionalTrimmedText(20).parse("  texto  ")).toBe("texto");
    expect(optionalTrimmedText(20).parse("   ")).toBeNull();
    expect(() => optionalTrimmedText(3).parse("abcd")).toThrow();
    expect(phoneInputPattern.test("+57 300 123 4567")).toBe(true);
    expect(phoneInputPattern.test("3001234567")).toBe(true);
    expect(phoneInputPattern.test("+13001234567")).toBe(true);
    expect(phoneInputPattern.test("12345")).toBe(false);
  });
});
