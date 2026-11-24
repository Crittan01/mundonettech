import { afterEach, describe, expect, it, vi } from "vitest";

import { compareStrings, isSellableVariant } from "../../packages/db/dist/inventory-shared.js";

const activeVariant = {
  status: "ACTIVE",
  deletedAt: null,
  product: {
    status: "ACTIVE",
    deletedAt: null,
    brand: { deletedAt: null },
    category: { deletedAt: null },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared DB primitives", () => {
  it("sorts deterministically without localeCompare", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare must not be used for lock ordering");
    });

    expect(["á", "a", "Z", "2", "10"].sort(compareStrings)).toEqual(["10", "2", "Z", "a", "á"]);
    expect(compareStrings("same", "same")).toBe(0);
    expect(localeCompare).not.toHaveBeenCalled();
  });

  it("applies every sellability guard shared by cart and B2B", () => {
    expect(isSellableVariant(activeVariant)).toBe(true);
    const blockedVariants = [
      { ...activeVariant, status: "ARCHIVED" },
      { ...activeVariant, deletedAt: new Date(0) },
      {
        ...activeVariant,
        product: { ...activeVariant.product, status: "DRAFT" },
      },
      {
        ...activeVariant,
        product: { ...activeVariant.product, deletedAt: new Date(0) },
      },
      {
        ...activeVariant,
        product: {
          ...activeVariant.product,
          brand: { deletedAt: new Date(0) },
        },
      },
      {
        ...activeVariant,
        product: {
          ...activeVariant.product,
          category: { deletedAt: new Date(0) },
        },
      },
    ];
    expect(blockedVariants.every((variant) => !isSellableVariant(variant))).toBe(true);
  });
});
