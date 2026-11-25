import { readFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductMediaGallery } from "../../apps/web/components/catalog/product-media-gallery";
import type { CatalogMedia } from "../../packages/db/dist/catalog-types.js";

import {
  buildPictureSources,
  buildSpinFrames,
  isSafeMediaUrl,
  isSafeSrcSet,
} from "../../packages/media/dist/responsive-sources.js";

describe("F1.2 — client viewer subpath isolation and responsive URL contracts", () => {
  it("keeps @mundonettech/media/viewers free of server-only sharp, S3, yauzl, and Node core imports", () => {
    const viewersEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/viewers.js"),
      "utf8",
    );
    const spinEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/spin-360.js"),
      "utf8",
    );
    const modelEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/model-3d.js"),
      "utf8",
    );
    const responsiveEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/responsive-sources.js"),
      "utf8",
    );

    for (const source of [viewersEntry, spinEntry, modelEntry, responsiveEntry]) {
      expect(source).not.toMatch(/\b(?:sharp|yauzl|@aws-sdk|node:)\b/);
    }
  });

  it("enforces strict HTTPS/loopback/root-relative URLs and descriptor srcSet rules", () => {
    expect(isSafeMediaUrl("https://cdn.mundonettech.co/products/1/640.avif")).toBe(true);
    expect(isSafeMediaUrl("http://127.0.0.1:4110/local.webp")).toBe(true);
    expect(isSafeMediaUrl("/media/local.avif")).toBe(true);

    for (const unsafe of [
      "",
      "   ",
      "//evil.example/protocol-relative.avif",
      "/\\backslash.avif",
      "https://user:secret@cdn.example.test/private.avif",
      "http://remote-http.example/file.avif",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ]) {
      expect(isSafeMediaUrl(unsafe)).toBe(false);
    }

    expect(
      isSafeSrcSet(
        "https://cdn.example.test/320.avif 320w, https://cdn.example.test/640.avif 640w",
      ),
    ).toBe(true);
    expect(isSafeSrcSet("javascript:alert(1) 1x")).toBe(false);
    expect(isSafeSrcSet("https://cdn.example.test/320.avif invalid-descriptor")).toBe(false);
  });

  it("builds ordered AVIF/WebP picture sources and rejects empty or unsafe inputs", () => {
    const picture = buildPictureSources(
      [
        { format: "webp", width: 1280, height: 960, key: "items/a/1280.webp" },
        { format: "avif", width: 480, height: 360, key: "items/a/480.avif" },
        { format: "avif", width: 1280, height: 960, key: "items/a/1280.avif" },
        { format: "webp", width: 480, height: 360, key: "items/a/480.webp" },
      ],
      { baseUrl: "https://media.mundonettech.co/", sizes: "(max-width: 768px) 100vw, 50vw" },
    );

    expect(picture.src).toBe("https://media.mundonettech.co/items/a/1280.webp");
    expect(picture.width).toBe(1280);
    expect(picture.height).toBe(960);
    expect(picture.sources).toEqual([
      {
        type: "image/avif",
        srcSet:
          "https://media.mundonettech.co/items/a/480.avif 480w, https://media.mundonettech.co/items/a/1280.avif 1280w",
        sizes: "(max-width: 768px) 100vw, 50vw",
      },
      {
        type: "image/webp",
        srcSet:
          "https://media.mundonettech.co/items/a/480.webp 480w, https://media.mundonettech.co/items/a/1280.webp 1280w",
        sizes: "(max-width: 768px) 100vw, 50vw",
      },
    ]);

    expect(() => buildPictureSources([])).toThrow(RangeError);
    expect(() =>
      buildPictureSources([
        { format: "avif", width: 480, height: 360, publicUrl: "http://evil.example/480.avif" },
      ]),
    ).toThrow(TypeError);
    expect(() => buildSpinFrames([{ frame: 0, derivatives: [] }])).toThrow(RangeError);
    expect(() =>
      buildPictureSources([{ format: "webp", width: 480, height: 360, key: "../escape.webp" }]),
    ).toThrow(TypeError);
    const derivative = { format: "webp" as const, width: 480, height: 360, key: "p/480.webp" };
    expect(() =>
      buildSpinFrames([
        { frame: 0, derivatives: [derivative] },
        { frame: 0, derivatives: [derivative] },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      buildSpinFrames([
        { frame: 0, derivatives: [derivative] },
        { frame: 2, derivatives: [derivative] },
      ]),
    ).toThrow(RangeError);
  });

  it("renders persisted image keys as a responsive AVIF/WebP public gallery", () => {
    const image: CatalogMedia = {
      id: "image-1",
      variantId: null,
      mediaType: "IMAGE",
      storageKey: "catalog/product/image/hash/1280.webp",
      altText: "Vista frontal",
      width: 1280,
      height: 960,
      focalX: null,
      focalY: null,
      frames: [],
      posterKey: null,
      usdzKey: null,
    };
    const html = renderToStaticMarkup(
      React.createElement(ProductMediaGallery, {
        media: [image],
        origin: "https://media.example.test",
        productName: "Producto real",
      }),
    );
    expect((html.match(/<source/g) ?? []).length).toBe(2);
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('type="image/webp"');
    expect(html).toContain("480.avif 480w");
    expect(html).toContain("768.avif 768w");
    expect(html).toContain("1280.avif 1280w");
    expect(html).not.toContain("1920.avif");
    expect(html).toContain('loading="eager"');
    expect(html).toContain('alt="Vista frontal"');
  });
});
